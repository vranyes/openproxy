import { describe, expect, test } from "bun:test";
import { createApp, type UpstreamFetcher } from "../src/server";
import type { GatewayConfig } from "../src/config";
import { errorResponse } from "../src/ops/errors";
import { jsonLogger, type LogEvent } from "../src/ops/log";
import { stubUpstream } from "./helpers";

const config: GatewayConfig = {
  upstreams: [
    {
      id: "local",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://upstream.test/v1",
      apiKey: "test-key",
      models: [{ id: "qwen3-coder-30b", upstream: "qwen3-coder:30b", context: 131072, maxOutput: 32768 }],
    },
  ],
};

const okUpstream = stubUpstream(() => Response.json({ object: "chat.completion", choices: [] }));

function chatRequest(model: string): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [] }),
  });
}

describe("jsonLogger", () => {
  test("writes exactly one JSON line with ts and the event fields, without a newline", () => {
    const lines: string[] = [];
    const logger = jsonLogger((line) => lines.push(line));
    logger({ level: "info", msg: "hello", count: 1 });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.count).toBe(1);
  });
});

describe("default logger", () => {
  test("createApp without a logger writes nothing to stderr", async () => {
    const original = process.stderr.write;
    let calls = 0;
    const spy = ((..._args: unknown[]) => {
      calls += 1;
      return true;
    }) as unknown as typeof process.stderr.write;
    process.stderr.write = spy;
    try {
      const app = createApp(config, { fetchUpstream: okUpstream });
      const res = await app.fetch(new Request("http://gateway/healthz"));
      expect(res.status).toBe(200);
      expect(calls).toBe(0);
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("request logging", () => {
  test("logs one structured request event for a known chat model", async () => {
    const events: LogEvent[] = [];
    const app = createApp(config, { fetchUpstream: okUpstream, logger: (e) => events.push(e) });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      level: "info",
      msg: "request",
      method: "POST",
      path: "/v1/chat/completions",
      model: "qwen3-coder-30b",
      upstream: "local",
      status: 200,
    });
    expect(typeof e.request_id).toBe("string");
    expect(typeof e.latency_ms).toBe("number");
    expect(e.usage).toBeNull();
    expect(e.context_ratio).toBeNull();
  });

  test("/healthz logs one event with a null model and upstream", async () => {
    const events: LogEvent[] = [];
    const app = createApp(config, { fetchUpstream: okUpstream, logger: (e) => events.push(e) });
    const res = await app.fetch(new Request("http://gateway/healthz"));
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "info", msg: "request", model: null, upstream: null, status: 200 });
  });

  test("N requests produce exactly N request events", async () => {
    const events: LogEvent[] = [];
    const app = createApp(config, { fetchUpstream: okUpstream, logger: (e) => events.push(e) });
    for (let i = 0; i < 3; i += 1) await app.fetch(new Request("http://gateway/healthz"));
    expect(events.filter((e) => e.msg === "request")).toHaveLength(3);
  });
});

describe("error envelopes", () => {
  test("returns the standard envelope body for each error case", async () => {
    const app = createApp(config, { fetchUpstream: okUpstream });

    const invalidJson = await app.fetch(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({
      error: { message: "invalid JSON body", type: "invalid_request_error" },
    });

    const unknownModel = await app.fetch(chatRequest("nope"));
    expect(unknownModel.status).toBe(404);
    expect(await unknownModel.json()).toEqual({
      error: { message: "model not found: nope", type: "invalid_request_error" },
    });

    const unknownPath = await app.fetch(new Request("http://gateway/nope"));
    expect(unknownPath.status).toBe(404);
    expect(await unknownPath.json()).toEqual({
      error: { message: "not found", type: "invalid_request_error" },
    });
  });
});

describe("500 handling", () => {
  test("an upstream throw returns a server_error envelope and logs an error event", async () => {
    const events: LogEvent[] = [];
    const throwing: UpstreamFetcher = async () => {
      throw new Error("boom");
    };
    const app = createApp(config, { fetchUpstream: throwing, logger: (e) => events.push(e) });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: "internal error", type: "server_error" } });
    const errEvent = events.find((e) => e.level === "error");
    expect(errEvent).toBeDefined();
    expect(errEvent).toMatchObject({ status: 500, model: "qwen3-coder-30b", upstream: "local" });
    expect(typeof errEvent!.error).toBe("string");
  });
});

describe("errorResponse", () => {
  test("builds the envelope with the given status and default invalid_request_error type", async () => {
    const res = errorResponse("oops", 418);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: { message: "oops", type: "invalid_request_error" } });

    const server = errorResponse("boom", 500, "server_error");
    expect(server.status).toBe(500);
    expect(await server.json()).toEqual({ error: { message: "boom", type: "server_error" } });
  });
});
