import { describe, expect, test } from "bun:test";
import { UpstreamSchema, type GatewayConfig, type GatewayUpstream } from "../src/config";
import { createApp } from "../src/server";
import { chatTextStream, chatToolStream, gatewayChatRequest, sseResponse, withUpstream } from "./fake-providers";

const CHAT = "@opencode/ai/providers/openai/chat";

interface Completion {
  object: string;
  model: string;
  choices: Array<{ index: number; message: Record<string, unknown>; finish_reason: string }>;
  usage: Record<string, unknown>;
}

function upstreamOf(baseURL: string, modelOverrides: Record<string, unknown> = {}): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "openai",
    package: CHAT,
    baseURL,
    apiKey: "test-key",
    adapter: "opencode",
    models: [{ id: "gw-model", upstream: "up-model", context: 1000, ...modelOverrides }],
  });
}

function appFor(baseURL: string, modelOverrides: Record<string, unknown> = {}): ReturnType<typeof createApp> {
  const config: GatewayConfig = { upstreams: [upstreamOf(baseURL, modelOverrides)] };
  return createApp(config);
}

interface SeenRequest {
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}

async function capture(req: Request): Promise<SeenRequest> {
  return {
    path: new URL(req.url).pathname,
    headers: req.headers,
    body: (await req.json()) as Record<string, unknown>,
  };
}

describe("opencode adapter -> openai chat (openai/chat)", () => {
  test("non-stream text: dispatches to /chat/completions with max_completion_tokens", async () => {
    let seen: SeenRequest | null = null;
    await withUpstream(
      async (req) => {
        seen = await capture(req);
        return sseResponse(chatTextStream("Hello"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayChatRequest("gw-model", { max_tokens: 42 }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as Completion;
        expect(body.object).toBe("chat.completion");
        expect(body.model).toBe("gw-model");
        expect(body.choices[0]!.message).toEqual({ role: "assistant", content: "Hello" });
        expect(body.choices[0]!.finish_reason).toBe("stop");
        expect(body.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
      },
    );
    expect(seen!.path).toBe("/v1/chat/completions");
    expect(seen!.headers.get("authorization")).toBe("Bearer test-key");
    expect(seen!.body).toMatchObject({ model: "up-model", stream: true, max_completion_tokens: 42 });
  });

  test("stream: role -> deltas -> finish_reason -> usage -> [DONE]", async () => {
    await withUpstream(
      () => sseResponse(chatTextStream("Hi", [1, 2, 3])),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayChatRequest("gw-model", { stream: true }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const text = await res.text();
        const rawFrames = text.split("\n\n").map((f) => f.trim()).filter((f) => f.length > 0);
        expect(rawFrames.at(-1)).toBe("data: [DONE]");
        const parsed = rawFrames.slice(0, -1).map((f) => JSON.parse(f.replace(/^data: /, "")) as Record<string, unknown>);
        expect((parsed[0]!.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta.role).toBe("assistant");
        const contents = parsed
          .flatMap((p) => (p.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
          .map((c) => c.delta.content)
          .filter((c): c is string => typeof c === "string");
        expect(contents.join("")).toBe("Hi");
        const usageIndex = parsed.findIndex((p) => Array.isArray(p.choices) && p.choices.length === 0 && p.usage !== undefined);
        expect(usageIndex).toBeGreaterThan(-1);
        expect(parsed[usageIndex]!.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
      },
    );
  });

  test("tool call: gateway returns tool_calls with stringified arguments", async () => {
    await withUpstream(
      () => sseResponse(chatToolStream()),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(
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
          { id: "call_up", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        ]);
        expect(parsed.choices[0]!.finish_reason).toBe("tool_calls");
      },
    );
  });
});
