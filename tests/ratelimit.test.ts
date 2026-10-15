import { describe, expect, test } from "bun:test";
import type { GatewayConfig, RateLimitConfig } from "../src/config";
import { createApp } from "../src/server";
import { createBucket, createRateLimiter } from "../src/ops/ratelimit";
import type { LogEvent } from "../src/ops/log";
import { json, stubUpstream } from "./helpers";

const okUpstream = stubUpstream(() => Response.json({ object: "chat.completion", choices: [] }));

type ErrorBody = { error: { message: string; type: string; code?: string } };

function upstream(
  id: string,
  modelId: string,
  rateLimit?: RateLimitConfig,
): GatewayConfig["upstreams"][number] {
  return {
    id,
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: `http://${id}.test/v1`,
    models: [{ id: modelId }],
    ...(rateLimit !== undefined ? { rateLimit } : {}),
  };
}

function chatRequest(model: string): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [] }),
  });
}

describe("disabled by default", () => {
  test("five chat requests all return 200 when no rateLimit is configured", async () => {
    const app = createApp({ upstreams: [upstream("a", "m")] }, { fetchUpstream: okUpstream });
    for (let i = 0; i < 5; i++) {
      expect((await app.fetch(chatRequest("m"))).status).toBe(200);
    }
  });
});

describe("createBucket", () => {
  test("capacity defaults to rpm", () => {
    const b = createBucket({ rpm: 2, now: () => 0 });
    expect(b.preview(0).ok).toBe(true);
    b.take(0);
    expect(b.preview(0).ok).toBe(true);
    b.take(0);
    expect(b.preview(0).ok).toBe(false);
  });

  test("burst drains then denies", () => {
    const b = createBucket({ rpm: 2, burst: 2, now: () => 0 });
    expect(b.preview(0).ok).toBe(true);
    b.take(0);
    expect(b.preview(0).ok).toBe(true);
    b.take(0);
    expect(b.preview(0).ok).toBe(false);
  });

  test("refills after time passes", () => {
    const b = createBucket({ rpm: 60, burst: 1, now: () => 0 });
    b.take(0);
    expect(b.preview(0).ok).toBe(false);
    // 60 rpm => one token per second.
    expect(b.preview(1000).ok).toBe(true);
  });

  test("retryAfterMs is (1 - tokens) / refill", () => {
    const b = createBucket({ rpm: 60, burst: 1, now: () => 0 });
    b.take(0);
    const empty = b.preview(0);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.retryAfterMs).toBeCloseTo(1000, 5);
    // Half a token accrued => ~500ms until the next token.
    const half = b.preview(500);
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.retryAfterMs).toBeCloseTo(500, 5);
  });
});

describe("createRateLimiter", () => {
  test("returns ok without allocating buckets when nothing is configured", () => {
    const limiter = createRateLimiter({ now: () => 0, config: () => ({ upstreams: [{ id: "a" }] }) });
    expect(limiter.check("a")).toEqual({ ok: true });
    expect(limiter.check(null)).toEqual({ ok: true });
  });

  test("a denial consumes nothing from the other bucket (atomic)", () => {
    const limiter = createRateLimiter({
      now: () => 0,
      config: () => ({
        rateLimit: { rpm: 5, burst: 5 },
        upstreams: [{ id: "a", rateLimit: { rpm: 1, burst: 1 } }],
      }),
    });
    expect(limiter.check("a").ok).toBe(true); // charges global (->4) and upstream (->0)
    for (let i = 0; i < 10; i++) expect(limiter.check("a").ok).toBe(false);
    // The global bucket keeps its remaining 4 tokens: denied requests charged nothing.
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      if (limiter.check(null).ok) allowed++;
    }
    expect(allowed).toBe(4);
  });

  test("a hot-reload that changes rpm starts a fresh bucket", () => {
    let cfg: {
      rateLimit?: RateLimitConfig;
      upstreams: Array<{ id: string; rateLimit?: RateLimitConfig }>;
    } = { rateLimit: { rpm: 1, burst: 1 }, upstreams: [{ id: "a" }] };
    const limiter = createRateLimiter({ now: () => 0, config: () => cfg });
    expect(limiter.check(null).ok).toBe(true);
    expect(limiter.check(null).ok).toBe(false);
    cfg = { rateLimit: { rpm: 2, burst: 1 }, upstreams: [{ id: "a" }] };
    expect(limiter.check(null).ok).toBe(true);
  });
});

describe("server global rate limit", () => {
  test("two requests pass and the third is 429 with a retry-after and one request event", async () => {
    const events: LogEvent[] = [];
    const config: GatewayConfig = { upstreams: [upstream("a", "m")], rateLimit: { rpm: 2, burst: 2 } };
    const app = createApp(config, {
      fetchUpstream: okUpstream,
      logger: (e) => events.push(e),
      now: () => 0,
    });

    expect((await app.fetch(chatRequest("m"))).status).toBe(200);
    expect((await app.fetch(chatRequest("m"))).status).toBe(200);

    const res = await app.fetch(chatRequest("m"));
    expect(res.status).toBe(429);
    expect(await json<ErrorBody>(res)).toEqual({
      error: { message: "Rate limit exceeded", type: "invalid_request_error", code: "rate_limit_exceeded" },
    });
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

    const requests = events.filter((e) => e.msg === "request");
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)).toMatchObject({ status: 429 });
  });
});

describe("server per-upstream rate limit", () => {
  test("limits one upstream while another stays unlimited", async () => {
    const config: GatewayConfig = {
      upstreams: [upstream("a", "a-model", { rpm: 1, burst: 1 }), upstream("b", "b-model")],
    };
    const app = createApp(config, { fetchUpstream: okUpstream, now: () => 0 });

    expect((await app.fetch(chatRequest("a-model"))).status).toBe(200);
    expect((await app.fetch(chatRequest("a-model"))).status).toBe(429);
    expect((await app.fetch(chatRequest("b-model"))).status).toBe(200);
    expect((await app.fetch(chatRequest("b-model"))).status).toBe(200);
  });
});

describe("server atomicity across global and upstream buckets", () => {
  test("a denied upstream request does not drain the global bucket; upstream resumes after refill", async () => {
    let t = 0;
    const config: GatewayConfig = {
      upstreams: [upstream("a", "m", { rpm: 1, burst: 1 })],
      rateLimit: { rpm: 5, burst: 5 },
    };
    const app = createApp(config, { fetchUpstream: okUpstream, now: () => t });

    expect((await app.fetch(chatRequest("m"))).status).toBe(200); // allowed #1
    expect((await app.fetch(chatRequest("m"))).status).toBe(429); // upstream exhausted
    t += 60_000; // 1 rpm: one upstream token refills
    expect((await app.fetch(chatRequest("m"))).status).toBe(200); // allowed #2, global still has capacity
    expect((await app.fetch(chatRequest("m"))).status).toBe(429);
  });
});

describe("server recovery after time advances", () => {
  test("a previously-429 request succeeds once the clock advances", async () => {
    let t = 0;
    const config: GatewayConfig = { upstreams: [upstream("a", "m")], rateLimit: { rpm: 1, burst: 1 } };
    const app = createApp(config, { fetchUpstream: okUpstream, now: () => t });

    expect((await app.fetch(chatRequest("m"))).status).toBe(200);
    expect((await app.fetch(chatRequest("m"))).status).toBe(429);
    t += 60_000;
    expect((await app.fetch(chatRequest("m"))).status).toBe(200);
  });
});
