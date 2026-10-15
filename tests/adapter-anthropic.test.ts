import { describe, expect, test } from "bun:test";
import { UpstreamSchema, type GatewayConfig, type GatewayUpstream } from "../src/config";
import { createApp } from "../src/server";
import {
  anthropicTextStream,
  anthropicToolStream,
  gatewayChatRequest,
  overflowError,
  rateLimitError,
  sseResponse,
  withUpstream,
} from "./fake-providers";

const PACKAGES = ["@opencode/ai/providers/anthropic", "@opencode/ai/providers/anthropic-compatible"] as const;

interface Completion {
  id: string;
  object: string;
  model: string;
  choices: Array<{ index: number; message: Record<string, unknown>; finish_reason: string }>;
  usage: Record<string, unknown>;
}

function upstreamOf(
  pkg: string,
  baseURL: string,
  modelOverrides: Record<string, unknown> = {},
  upstreamOverrides: Record<string, unknown> = {},
): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "anthropic",
    package: pkg,
    baseURL,
    apiKey: "test-key",
    adapter: "opencode",
    models: [{ id: "gw-model", upstream: "up-model", context: 1000, ...modelOverrides }],
    ...upstreamOverrides,
  });
}

function appFor(
  pkg: string,
  baseURL: string,
  modelOverrides: Record<string, unknown> = {},
  upstreamOverrides: Record<string, unknown> = {},
): ReturnType<typeof createApp> {
  const config: GatewayConfig = { upstreams: [upstreamOf(pkg, baseURL, modelOverrides, upstreamOverrides)] };
  return createApp(config);
}

interface SeenRequest {
  url: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}

async function capture(req: Request): Promise<SeenRequest> {
  const url = new URL(req.url);
  return {
    url: req.url,
    path: url.pathname,
    headers: req.headers,
    body: (await req.json()) as Record<string, unknown>,
  };
}

function deltasText(parsed: Record<string, unknown>[]): string {
  return parsed
    .flatMap((p) => (p.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
    .map((c) => c.delta.content)
    .filter((c): c is string => typeof c === "string")
    .join("");
}

for (const pkg of PACKAGES) {
  const short = pkg.replace("@opencode/ai/providers/", "");
  describe(`opencode adapter -> anthropic messages (${short})`, () => {
    test("non-stream text: upstream sees stream:true + max_tokens; gateway returns chat.completion", async () => {
      let seen: SeenRequest | null = null;
      await withUpstream(
        async (req) => {
          seen = await capture(req);
          return sseResponse(anthropicTextStream("Hello"));
        },
        async (baseURL) => {
          const res = await appFor(pkg, baseURL).fetch(gatewayChatRequest("gw-model"));
          expect(res.status).toBe(200);
          const body = (await res.json()) as Completion;
          expect(body.object).toBe("chat.completion");
          expect(body.model).toBe("gw-model");
          expect(body.id.startsWith("chatcmpl-")).toBe(true);
          expect(body.choices[0]!.message).toEqual({ role: "assistant", content: "Hello" });
          expect(body.choices[0]!.finish_reason).toBe("stop");
          expect(body.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
        },
      );
      expect(seen!.body).toMatchObject({ model: "up-model", stream: true });
      expect(seen!.body).toHaveProperty("max_tokens");
      expect(seen!.path).toBe("/v1/messages");
      // Anthropic authenticates with `x-api-key`, never `authorization`.
      expect(seen!.headers.get("x-api-key")).toBe("test-key");
      expect(seen!.headers.get("authorization")).toBeNull();
    });

    test("stream: role -> deltas -> finish_reason -> usage -> [DONE]", async () => {
      await withUpstream(
        () => sseResponse(anthropicTextStream("Hi", [1, 2])),
        async (baseURL) => {
          const res = await appFor(pkg, baseURL).fetch(gatewayChatRequest("gw-model", { stream: true }));
          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toContain("text/event-stream");
          const text = await res.text();
          const rawFrames = text.split("\n\n").map((f) => f.trim()).filter((f) => f.length > 0);
          expect(rawFrames.at(-1)).toBe("data: [DONE]");
          const parsed = rawFrames.slice(0, -1).map((f) => JSON.parse(f.replace(/^data: /, "")) as Record<string, unknown>);
          expect((parsed[0]!.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta.role).toBe("assistant");
          expect(deltasText(parsed)).toBe("Hi");
          const finishIndex = parsed.findIndex(
            (p) => (p.choices as Array<{ finish_reason: string | null }> | undefined)?.[0]?.finish_reason === "stop",
          );
          const usageIndex = parsed.findIndex((p) => Array.isArray(p.choices) && p.choices.length === 0 && p.usage !== undefined);
          expect(finishIndex).toBeGreaterThan(-1);
          expect(usageIndex).toBeGreaterThan(finishIndex);
          expect(parsed[usageIndex]!.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
        },
      );
    });

    test("tool call: gateway returns tool_calls with stringified arguments", async () => {
      await withUpstream(
        () => sseResponse(anthropicToolStream()),
        async (baseURL) => {
          const res = await appFor(pkg, baseURL).fetch(
            gatewayChatRequest("gw-model", {
              messages: [{ role: "user", content: "weather?" }],
              tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } }],
            }),
          );
          expect(res.status).toBe(200);
          const parsed = (await res.json()) as Completion;
          const message = parsed.choices[0]!.message;
          expect(message.content).toBeNull();
          expect(message.tool_calls).toEqual([
            { id: "toolu_up", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
          ]);
          expect(parsed.choices[0]!.finish_reason).toBe("tool_calls");
        },
      );
    });

    test("vision allowed: image reaches the upstream as an Anthropic image block", async () => {
      let seen: SeenRequest | null = null;
      await withUpstream(
        async (req) => {
          seen = await capture(req);
          return sseResponse(anthropicTextStream("ok"));
        },
        async (baseURL) => {
          const res = await appFor(pkg, baseURL, { supportsVision: true }).fetch(
            gatewayChatRequest("gw-model", {
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "look" },
                    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                  ],
                },
              ],
            }),
          );
          expect(res.status).toBe(200);
        },
      );
      const messages = seen!.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
      const image = messages[0]!.content.find((part) => part.type === "image");
      expect(image).toBeDefined();
      expect(image).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    });

    test("supportsVision:false rejects images with 400 and never calls upstream", async () => {
      let calls = 0;
      await withUpstream(
        () => {
          calls += 1;
          return sseResponse(anthropicTextStream("nope"));
        },
        async (baseURL) => {
          const res = await appFor(pkg, baseURL, { supportsVision: false }).fetch(
            gatewayChatRequest("gw-model", {
              messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] }],
            }),
          );
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({
            error: { message: "model does not support image input", type: "invalid_request_error" },
          });
        },
      );
      expect(calls).toBe(0);
    });

    test("supportsTools:false rejects tools with 400 and never calls upstream", async () => {
      let calls = 0;
      await withUpstream(
        () => {
          calls += 1;
          return sseResponse(anthropicTextStream("nope"));
        },
        async (baseURL) => {
          const res = await appFor(pkg, baseURL, { supportsTools: false }).fetch(
            gatewayChatRequest("gw-model", {
              tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
            }),
          );
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({
            error: { message: "model does not support tools", type: "invalid_request_error" },
          });
        },
      );
      expect(calls).toBe(0);
    });

    test("dropParams keys (temperature, stop) never reach the translated body", async () => {
      const bodies: Record<string, unknown>[] = [];
      await withUpstream(
        async (req) => {
          bodies.push((await req.json()) as Record<string, unknown>);
          return sseResponse(anthropicTextStream("ok"));
        },
        async (baseURL) => {
          const dropped = await appFor(pkg, baseURL, { dropParams: ["temperature", "stop"] }).fetch(
            gatewayChatRequest("gw-model", { temperature: 0.7, stop: "END" }),
          );
          expect(dropped.status).toBe(200);
          const kept = await appFor(pkg, baseURL).fetch(
            gatewayChatRequest("gw-model", { temperature: 0.7, stop: "END" }),
          );
          expect(kept.status).toBe(200);
        },
      );
      expect(bodies[0]).not.toHaveProperty("temperature");
      expect(bodies[0]).not.toHaveProperty("stop_sequences");
      expect(bodies[1]).toMatchObject({ temperature: 0.7, stop_sequences: ["END"] });
    });

    test("pre-stream overflow 400 becomes the gateway context_length_exceeded", async () => {
      await withUpstream(
        () => overflowError(),
        async (baseURL) => {
          const res = await appFor(pkg, baseURL).fetch(gatewayChatRequest("gw-model"));
          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: { code?: string }; max_context?: number };
          expect(body.error.code).toBe("context_length_exceeded");
          expect(body.max_context).toBe(1000);
        },
      );
    });

    test("an explicit 429 relays status and retry-after", async () => {
      await withUpstream(
        () => rateLimitError("9"),
        async (baseURL) => {
          const res = await appFor(pkg, baseURL).fetch(gatewayChatRequest("gw-model"));
          expect(res.status).toBe(429);
          expect(res.headers.get("retry-after")).toBe("9");
          expect((await res.json()) as { error: { type: string } }).toMatchObject({ error: { type: "invalid_request_error" } });
        },
      );
    });

    test("keyless (apiKeyEnv:null) sends neither x-api-key nor authorization", async () => {
      let seen: SeenRequest | null = null;
      await withUpstream(
        async (req) => {
          seen = await capture(req);
          return sseResponse(anthropicTextStream("ok"));
        },
        async (baseURL) => {
          const res = await appFor(pkg, baseURL, {}, { apiKey: undefined, apiKeyEnv: null }).fetch(
            gatewayChatRequest("gw-model"),
          );
          expect(res.status).toBe(200);
        },
      );
      expect(seen!.headers.get("x-api-key")).toBeNull();
      expect(seen!.headers.get("authorization")).toBeNull();
    });
  });
}
