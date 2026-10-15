import { describe, expect, test } from "bun:test";
import { UpstreamSchema, type GatewayConfig, type GatewayModel, type GatewayUpstream } from "../src/config";
import { createApp } from "../src/server";
import { defaultAiRuntime } from "../src/adapter/ai";
import { createOpenAiCompatibleAdapter } from "../src/adapter/openai-compatible";
import { fakeUpstreamServer } from "./helpers";

const COMPAT = "@opencode/ai/providers/openai-compatible";

function upstreamOf(baseURL: string, modelOverrides: Record<string, unknown> = {}, upstreamOverrides: Record<string, unknown> = {}): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "local",
    package: COMPAT,
    baseURL,
    apiKeyEnv: null,
    adapter: "openai-compatible",
    models: [{ id: "gw-model", upstream: "up-model", context: 1000, ...modelOverrides }],
    ...upstreamOverrides,
  });
}

function appFor(baseURL: string, modelOverrides: Record<string, unknown> = {}): ReturnType<typeof createApp> {
  const config: GatewayConfig = { upstreams: [upstreamOf(baseURL, modelOverrides)] };
  return createApp(config);
}

function chatRequest(model: string, body: Record<string, unknown> = {}): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...body }),
  });
}

// --- OpenAI-compatible upstream wire helpers ---------------------------------

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    created: 1,
    model: "up-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function usageChunk(prompt: number, completion: number, total: number): string {
  const payload = {
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    created: 1,
    model: "up-model",
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function textStream(text: string, usage: [number, number, number] = [5, 2, 7]): string {
  let out = chunk({ role: "assistant", content: "" });
  for (const c of text) out += chunk({ content: c });
  out += chunk({}, "stop");
  out += usageChunk(usage[0], usage[1], usage[2]);
  out += DONE;
  return out;
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function withUpstream<T>(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (baseURL: string) => Promise<T>,
): Promise<T> {
  const up = fakeUpstreamServer(handler);
  try {
    return await fn(up.url);
  } finally {
    up.stop();
  }
}

interface Completion {
  id: string;
  object: string;
  model: string;
  choices: Array<{ index: number; message: Record<string, unknown>; finish_reason: string }>;
  usage: Record<string, unknown>;
}

// --- non-stream ---------------------------------------------------------------

describe("openai-compatible adapter: non-stream", () => {
  test("text: upstream sees stream:true + usage + store:false, gateway returns chat.completion", async () => {
    let seen: Record<string, unknown> | null = null;
    await withUpstream(
      async (req) => {
        seen = (await req.json()) as Record<string, unknown>;
        return sseResponse(textStream("Hello"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(chatRequest("gw-model"));
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
    expect(seen).toMatchObject({
      model: "up-model",
      stream: true,
      stream_options: { include_usage: true },
      store: false,
    });
  });

  test("tool call: gateway returns tool_calls with stringified arguments", async () => {
    const body =
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }) +
      chunk({}, "tool_calls") +
      usageChunk(3, 4, 7) +
      DONE;
    await withUpstream(
      () => sseResponse(body),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(
          chatRequest("gw-model", {
            messages: [{ role: "user", content: "weather?" }],
            tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } }],
          }),
        );
        expect(res.status).toBe(200);
        const parsed = (await res.json()) as Completion;
        const message = parsed.choices[0]!.message;
        expect(message.content).toBeNull();
        expect(message.tool_calls).toEqual([
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        ]);
        expect(parsed.choices[0]!.finish_reason).toBe("tool_calls");
      },
    );
  });
});

// --- stream -------------------------------------------------------------------

describe("openai-compatible adapter: stream", () => {
  test("emits role -> deltas -> finish_reason -> usage -> [DONE]", async () => {
    await withUpstream(
      () => sseResponse(textStream("Hi", [1, 2, 3])),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(chatRequest("gw-model", { stream: true }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const text = await res.text();
        const rawFrames = text.split("\n\n").map((f) => f.trim()).filter((f) => f.length > 0);
        expect(rawFrames.at(-1)).toBe("data: [DONE]");
        const parsed = rawFrames
          .slice(0, -1)
          .map((f) => JSON.parse(f.replace(/^data: /, "")) as Record<string, unknown>);
        // role first
        expect((parsed[0]!.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta.role).toBe("assistant");
        const contents = parsed
          .flatMap((p) => (p.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
          .map((c) => c.delta.content)
          .filter((c): c is string => typeof c === "string");
        expect(contents.join("")).toBe("Hi");
        const finishIndex = parsed.findIndex((p) => (p.choices as Array<{ finish_reason: string | null }> | undefined)?.[0]?.finish_reason === "stop");
        const usageIndex = parsed.findIndex((p) => Array.isArray(p.choices) && p.choices.length === 0 && p.usage !== undefined);
        expect(finishIndex).toBeGreaterThan(-1);
        expect(usageIndex).toBeGreaterThan(finishIndex);
        expect(parsed[usageIndex]!.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
      },
    );
  });

  test("mid-stream error emits one error frame then [DONE]", async () => {
    const body =
      chunk({ role: "assistant", content: "part" }) +
      `data: ${JSON.stringify({ error: { message: "upstream blew up", code: 500 } })}\n\n`;
    await withUpstream(
      () => sseResponse(body),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(chatRequest("gw-model", { stream: true }));
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
        const errorFrames = text.split("\n\n").filter((f) => f.includes('"error"'));
        expect(errorFrames).toHaveLength(1);
        expect(errorFrames[0]).toContain("upstream blew up");
      },
    );
  });
});

// --- capability gating --------------------------------------------------------

describe("openai-compatible adapter: capabilities", () => {
  test("vision allowed: data-url and remote images reach the upstream", async () => {
    let seen: Record<string, unknown> | null = null;
    await withUpstream(
      async (req) => {
        seen = (await req.json()) as Record<string, unknown>;
        return sseResponse(textStream("ok"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL, { supportsVision: true }).fetch(
          chatRequest("gw-model", {
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "look" },
                  { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                  { type: "image_url", image_url: { url: "https://example.test/a.png" } },
                ],
              },
            ],
          }),
        );
        expect(res.status).toBe(200);
      },
    );
    const messages = (seen!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!;
    expect(JSON.stringify(messages.content)).toContain("image_url");
    expect(JSON.stringify(messages.content)).toContain("https://example.test/a.png");
    expect(JSON.stringify(messages.content)).toContain("data:image/png;base64,AAAA");
  });

  test("supportsVision:false rejects images with 400 and never calls upstream", async () => {
    let calls = 0;
    await withUpstream(
      () => {
        calls += 1;
        return sseResponse(textStream("nope"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL, { supportsVision: false }).fetch(
          chatRequest("gw-model", {
            messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] }],
          }),
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: { message: "model does not support image input", type: "invalid_request_error" } });
      },
    );
    expect(calls).toBe(0);
  });

  test("supportsTools:false rejects tools with 400 and never calls upstream", async () => {
    let calls = 0;
    await withUpstream(
      () => {
        calls += 1;
        return sseResponse(textStream("nope"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL, { supportsTools: false }).fetch(
          chatRequest("gw-model", {
            tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
          }),
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: { message: "model does not support tools", type: "invalid_request_error" } });
      },
    );
    expect(calls).toBe(0);
  });
});

// --- parameter handling -------------------------------------------------------

describe("openai-compatible adapter: parameters", () => {
  test("dropParams keys are stripped before the request is translated", async () => {
    let seen: Record<string, unknown> | null = null;
    await withUpstream(
      async (req) => {
        seen = (await req.json()) as Record<string, unknown>;
        return sseResponse(textStream("ok"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL, { dropParams: ["stop", "user"] }).fetch(
          chatRequest("gw-model", { stop: "END", user: "u1" }),
        );
        expect(res.status).toBe(200);
      },
    );
    expect("stop" in seen!).toBe(false);
    expect("user" in seen!).toBe(false);
  });

  test("tool_choice function is translated to the upstream function shape", async () => {
    let seen: Record<string, unknown> | null = null;
    await withUpstream(
      async (req) => {
        seen = (await req.json()) as Record<string, unknown>;
        return sseResponse(textStream("ok"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(
          chatRequest("gw-model", {
            tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
            tool_choice: { type: "function", function: { name: "f" } },
          }),
        );
        expect(res.status).toBe(200);
      },
    );
    expect(seen!.tool_choice).toEqual({ type: "function", function: { name: "f" } });
  });
});

// --- errors -------------------------------------------------------------------

describe("openai-compatible adapter: errors", () => {
  test("pre-stream overflow 400 becomes the gateway context_length_exceeded (non-stream)", async () => {
    await withUpstream(
      () =>
        new Response(JSON.stringify({ error: { message: "This model's maximum context length is 5 tokens." } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(chatRequest("gw-model"));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code?: string }; max_context?: number };
        expect(body.error.code).toBe("context_length_exceeded");
        expect(body.max_context).toBe(1000);
      },
    );
  });

  test("pre-stream overflow 400 becomes the gateway context_length_exceeded (stream)", async () => {
    await withUpstream(
      () =>
        new Response(JSON.stringify({ error: { message: "This model's maximum context length is 5 tokens." } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(chatRequest("gw-model", { stream: true }));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code?: string } };
        expect(body.error.code).toBe("context_length_exceeded");
      },
    );
  });

  test("an explicit 429 relays status and retry-after", async () => {
    await withUpstream(
      () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "9" },
        }),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(chatRequest("gw-model"));
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("9");
        expect((await res.json()) as { error: { type: string } }).toMatchObject({ error: { type: "invalid_request_error" } });
      },
    );
  });
});

// --- abort --------------------------------------------------------------------

describe("openai-compatible adapter: abort", () => {
  test("aborting cancels a pending generation instead of hanging", async () => {
    const upstream = upstreamOf("http://placeholder.test/v1");
    const adapter = createOpenAiCompatibleAdapter({
      fetchUpstream: (url, init) => globalThis.fetch(url, init),
      ai: defaultAiRuntime,
    });
    let upstreamAborted = false;
    await withUpstream(
      (req) => {
        req.signal.addEventListener("abort", () => {
          upstreamAborted = true;
        });
        const stream = new ReadableStream<Uint8Array>({ start() {} });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      async (baseURL) => {
        const withUrl: GatewayUpstream = { ...upstream, baseURL };
        const model: GatewayModel = withUrl.models[0]!;
        const controller = new AbortController();
        const started = Date.now();
        const pending = adapter.handle({
          upstream: withUrl,
          model,
          body: { model: "gw-model", messages: [{ role: "user", content: "hi" }], stream: true },
          signal: controller.signal,
        });
        await Bun.sleep(80);
        controller.abort();
        const result = await pending;
        expect(result.response.status).toBe(500);
        expect(Date.now() - started).toBeLessThan(3000);
      },
    );
    // Best-effort: the runtime's fetch is aborted, which the server observes.
    await Bun.sleep(50);
    expect(upstreamAborted).toBe(true);
  });
});
