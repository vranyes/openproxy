import { describe, expect, test } from "bun:test";
import type { LLMEvent, LLMResponse } from "@opencode/ai";
import { createApp } from "../src/server";
import { createMetrics } from "../src/ops/metrics";
import type { AiRuntime } from "../src/adapter/ai";
import type { GatewayConfig } from "../src/config";
import type { LogEvent } from "../src/ops/log";

const config: GatewayConfig = {
  upstreams: [
    {
      id: "go",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://upstream.test/v1",
      apiKey: "test-key",
      adapter: "opencode",
      models: [{ id: "muse-spark-1.3-contributor", context: 1000000 }],
    },
  ],
};

function chatRequest(model: string, stream = false): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream }),
  });
}

const okResponse = {
  text: "hi",
  reasoning: "",
  toolCalls: [],
  usage: { contextTokens: 10, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  finishReason: { normalized: "stop" },
} as unknown as LLMResponse;

function okRuntime(): AiRuntime {
  return {
    model: () => ({}) as never,
    generate: async () => okResponse,
    stream: () => {
      throw new Error("not used");
    },
  };
}

function midstreamRuntime(): AiRuntime {
  return {
    model: () => ({}) as never,
    generate: async () => {
      throw new Error("not used");
    },
    stream: () =>
      ({
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<LLMEvent> {
          yield { type: "text-delta", text: "partial" } as LLMEvent;
          throw { reason: { _tag: "Transport", message: "upstream boom" } };
        },
      }) as AsyncIterable<LLMEvent>,
  };
}

describe("GET /metrics", () => {
  test("is public and renders Prometheus exposition text", async () => {
    const app = createApp(config, { ai: okRuntime() });
    const res = await app.fetch(new Request("http://gateway/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("openproxy_requests_total");
    expect(text).toContain("openproxy_generations_total");
    expect(text).toContain("openproxy_midstream_errors_total");
    expect(text).toContain("openproxy_empty_generations_total");
  });

  test("counts requests and ok generations with token sums", async () => {
    const metrics = createMetrics();
    const events: LogEvent[] = [];
    const app = createApp(config, { ai: okRuntime(), metrics, logger: (e) => events.push(e) });
    const res = await app.fetch(chatRequest("muse-spark-1.3-contributor"));
    expect(res.status).toBe(200);
    await Bun.sleep(0);
    const text = metrics.render();
    expect(text).toContain('openproxy_requests_total{method="POST",path="/v1/chat/completions",status="200"');
    expect(text).toContain('openproxy_generations_total{model="muse-spark-1.3-contributor",upstream="go",finish_reason="stop",outcome="ok"} 1');
    expect(text).toContain('openproxy_generation_tokens_in_total{model="muse-spark-1.3-contributor",upstream="go"} 10');
    expect(text).toContain('openproxy_generation_tokens_out_total{model="muse-spark-1.3-contributor",upstream="go"} 5');
    const generation = events.find((e) => e.msg === "generation");
    expect(generation).toMatchObject({ outcome: "ok", finish_reason: "stop" });
  });

  test("mid-stream failure logs error outcome and increments error series", async () => {
    const metrics = createMetrics();
    const events: LogEvent[] = [];
    const app = createApp(config, { ai: midstreamRuntime(), metrics, logger: (e) => events.push(e) });
    const res = await app.fetch(chatRequest("muse-spark-1.3-contributor", true));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("[DONE]");
    await Bun.sleep(0);
    const generation = events.find((e) => e.msg === "generation");
    expect(generation).toBeDefined();
    expect(generation).toMatchObject({ outcome: "midstream_error", finish_reason: "error", error_tag: "Transport" });
    expect(generation!.level).toBe("error");
    const text = metrics.render();
    expect(text).toContain('outcome="midstream_error"} 1');
    expect(text).toContain('openproxy_midstream_errors_total{model="muse-spark-1.3-contributor",upstream="go",error_tag="Transport"} 1');
  });

  test("empty ok stream increments the silent-truncation counter", async () => {
    const metrics = createMetrics();
    const emptyRuntime: AiRuntime = {
      model: () => ({}) as never,
      generate: async () => {
        throw new Error("not used");
      },
      stream: () =>
        ({
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<LLMEvent> {
            yield { type: "text-delta", text: "hi" } as LLMEvent;
            yield { type: "finish", reason: { normalized: "stop" } } as unknown as LLMEvent;
          },
        }) as AsyncIterable<LLMEvent>,
    };
    const app = createApp(config, { ai: emptyRuntime, metrics, logger: () => {} });
    const res = await app.fetch(chatRequest("muse-spark-1.3-contributor", true));
    expect(res.status).toBe(200);
    await res.text();
    await Bun.sleep(0);
    expect(metrics.render()).toContain(
      'openproxy_empty_generations_total{model="muse-spark-1.3-contributor",upstream="go"} 1',
    );
  });
});
