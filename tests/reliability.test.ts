import { describe, expect, test } from "bun:test";
import { AIError as AIErrorCtor, InvalidRequestError, TimeoutError, TransportError } from "@opencode/ai";
import type { LLMEvent, LLMResponse } from "@opencode/ai";
import { createApp } from "../src/server";
import { createMetrics } from "../src/ops/metrics";
import { modelFor, type AiRuntime } from "../src/adapter/ai";
import { UpstreamSchema, type GatewayConfig } from "../src/config";
import type { LogEvent } from "../src/ops/log";

const okResponse = {
  text: "hi",
  reasoning: "",
  toolCalls: [],
  usage: { contextTokens: 10, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  finishReason: { normalized: "stop" },
} as unknown as LLMResponse;

function configWithRetry(maxAttempts: number): GatewayConfig {
  return {
    upstreams: [
      {
        id: "go",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "http://upstream.test/v1",
        apiKey: "test-key",
        adapter: "opencode",
        models: [{ id: "m", context: 1000, retry: { maxAttempts, backoffMs: 0 } }],
      },
    ],
  };
}

function chatRequest(model: string, stream = false): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream }),
  });
}

const timeoutError = () => new AIErrorCtor({ reason: new TimeoutError({ message: "slow upstream" }) });
const transportError = () =>
  new AIErrorCtor({ reason: new TransportError({ message: "reset", transport: "http", operation: "read" }) });
const invalidError = () => new AIErrorCtor({ reason: new InvalidRequestError({ message: "bad param" }) });

describe("bounded pre-headers retry", () => {
  test("non-stream retries Timeout then succeeds", async () => {
    let calls = 0;
    const metrics = createMetrics();
    const events: LogEvent[] = [];
    const ai: AiRuntime = {
      model: () => ({}) as never,
      generate: async () => {
        calls += 1;
        if (calls < 3) throw timeoutError();
        return okResponse;
      },
      stream: () => {
        throw new Error("not used");
      },
    };
    const app = createApp(configWithRetry(3), { ai, metrics, logger: (e) => events.push(e) });
    const res = await app.fetch(chatRequest("m"));
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    await Bun.sleep(0);
    expect(metrics.render()).toContain('openproxy_upstream_retries_total{model="m",upstream="go",error_tag="Timeout"} 2');
    expect(events.find((e) => e.msg === "upstream retries")).toMatchObject({ retries: 2 });
    expect(events.find((e) => e.msg === "generation")).toMatchObject({ outcome: "ok", retries: 2 });
  });

  test("gives up after maxAttempts and maps the last error", async () => {
    let calls = 0;
    const ai: AiRuntime = {
      model: () => ({}) as never,
      generate: async () => {
        calls += 1;
        throw timeoutError();
      },
      stream: () => {
        throw new Error("not used");
      },
    };
    const app = createApp(configWithRetry(2), { ai, metrics: createMetrics(), logger: () => {} });
    const res = await app.fetch(chatRequest("m"));
    expect(res.status).toBe(504);
    expect(calls).toBe(2);
  });

  test("never retries a 4xx", async () => {
    let calls = 0;
    const metrics = createMetrics();
    const ai: AiRuntime = {
      model: () => ({}) as never,
      generate: async () => {
        calls += 1;
        throw invalidError();
      },
      stream: () => {
        throw new Error("not used");
      },
    };
    const app = createApp(configWithRetry(3), { ai, metrics, logger: () => {} });
    const res = await app.fetch(chatRequest("m"));
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
    expect(metrics.render()).not.toContain("openproxy_upstream_retries_total{");
  });

  test("stream prefetch retries Transport then streams", async () => {
    let streams = 0;
    const ai: AiRuntime = {
      model: () => ({}) as never,
      generate: async () => {
        throw new Error("not used");
      },
      stream: () => {
        streams += 1;
        if (streams === 1) {
          return {
            [Symbol.asyncIterator]: async function* (): AsyncGenerator<LLMEvent> {
              throw transportError();
            },
          } as AsyncIterable<LLMEvent>;
        }
        return {
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<LLMEvent> {
            yield { type: "text-delta", text: "hi" } as LLMEvent;
            yield {
              type: "finish",
              reason: { normalized: "stop" },
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            } as unknown as LLMEvent;
          },
        } as AsyncIterable<LLMEvent>;
      },
    };
    const metrics = createMetrics();
    const app = createApp(configWithRetry(3), { ai, metrics, logger: () => {} });
    const res = await app.fetch(chatRequest("m", true));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hi");
    expect(body).toContain("[DONE]");
    expect(streams).toBe(2);
    await Bun.sleep(0);
    expect(metrics.render()).toContain('openproxy_upstream_retries_total{model="m",upstream="go",error_tag="Transport"} 1');
  });
});

describe("http settings passthrough", () => {
  test("per-model http wins over upstream, rest flows to route defaults", () => {
    const u = UpstreamSchema.parse({
      id: "u",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://up.test/v1",
      apiKey: "test-key",
      http: { headerTimeout: 1000, chunkTimeout: 2000 },
      models: [{ id: "m", http: { headerTimeout: 500 } }],
    });
    const model = modelFor(u, u.models[0]!);
    const http = model.route.defaults.http as unknown as Record<string, unknown>;
    expect(http.headerTimeout).toBe(500);
    expect(http.chunkTimeout).toBe(2000);
    expect(http.timeout).toBeUndefined();
  });

  test("upstream http applies when the model sets none, absent when neither sets", () => {
    const withUpstream = UpstreamSchema.parse({
      id: "u",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://up.test/v1",
      apiKey: "test-key",
      http: { timeout: 9000 },
      models: [{ id: "m" }],
    });
    const http = withUpstream.models[0]!.http;
    expect(http).toBeUndefined();
    const model = modelFor(withUpstream, withUpstream.models[0]!);
    expect((model.route.defaults.http as unknown as Record<string, unknown>).timeout).toBe(9000);

    const bare = UpstreamSchema.parse({
      id: "u",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://up.test/v1",
      apiKey: "test-key",
      models: [{ id: "m" }],
    });
    expect(modelFor(bare, "m").route.defaults.http).toBeUndefined();
  });
});

describe("client abort", () => {
  test("a cancelled stream records client_aborted", async () => {
    const metrics = createMetrics();
    const events: LogEvent[] = [];
    const ai: AiRuntime = {
      model: () => ({}) as never,
      generate: async () => {
        throw new Error("not used");
      },
      stream: () =>
        ({
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<LLMEvent> {
            yield { type: "text-delta", text: "partial" } as LLMEvent;
            await new Promise(() => {});
            yield { type: "text-delta", text: "never" } as LLMEvent;
          },
        }) as AsyncIterable<LLMEvent>,
    };
    const app = createApp(
      {
        upstreams: [
          {
            id: "go",
            package: "@opencode/ai/providers/openai-compatible",
            baseURL: "http://upstream.test/v1",
            apiKey: "test-key",
            adapter: "opencode",
            models: [{ id: "m", context: 1000 }],
          },
        ],
      },
      { ai, metrics, logger: (e) => events.push(e) },
    );
    const res = await app.fetch(chatRequest("m", true));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(10);
    const generation = events.find((e) => e.msg === "generation");
    expect(generation).toBeDefined();
    expect(generation).toMatchObject({ outcome: "client_aborted", finish_reason: "aborted" });
    expect(metrics.render()).toContain('outcome="client_aborted"} 1');
  });
});

describe("request guards", () => {
  test("oversize bodies are rejected with 413 before parsing", async () => {
    const app = createApp(configWithRetry(1), { logger: () => {} });
    const big = "x".repeat(11 * 1024 * 1024);
    const res = await app.fetch(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: big }] }),
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "body_too_large" } });
  });
});

describe("session source", () => {
  const sessionConfig: GatewayConfig = {
    upstreams: [
      {
        id: "go",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "http://upstream.test/v1",
        apiKey: "test-key",
        adapter: "opencode",
        sessionHeader: "x-opencode-session",
        models: [{ id: "m", context: 1000 }],
      },
    ],
  };

  test("forwarded vs generated sources are counted", async () => {
    const metrics = createMetrics();
    const ok: AiRuntime = {
      model: () => ({}) as never,
      generate: async () => okResponse,
      stream: () => {
        throw new Error("not used");
      },
    };
    const app = createApp(sessionConfig, { ai: ok, metrics, logger: () => {} });
    const withSession = new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": "s1" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect((await app.fetch(withSession)).status).toBe(200);
    expect((await app.fetch(chatRequest("m"))).status).toBe(200);
    await Bun.sleep(0);
    const text = metrics.render();
    expect(text).toContain('openproxy_session_source_total{upstream="go",source="forwarded"} 1');
    expect(text).toContain('openproxy_session_source_total{upstream="go",source="generated"} 1');
  });
});
