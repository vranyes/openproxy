import { describe, expect, test } from "bun:test";
import type { GatewayConfig, GatewayModel } from "../src/config";
import { createApp } from "../src/server";
import {
  CONTEXT_OVERFLOW_CODE,
  contextOverflowResponse,
  detectContextOverflow,
  isOverflowMessage,
} from "../src/context";
import { json, stubUpstream } from "./helpers";

const config: GatewayConfig = {
  upstreams: [
    {
      id: "local",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://upstream.test/v1",
      apiKey: "test-key",
      models: [
        { id: "qwen3-coder-30b", upstream: "qwen3-coder:30b", context: 131072 },
        { id: "no-context-model" },
      ],
    },
  ],
};

const model: GatewayModel = { id: "qwen3-coder-30b", context: 131072 };

interface OverflowBody {
  error: { message: string; type: string; code?: string };
  max_context?: number;
}

function chatRequest(modelId: string): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hello" }] }),
  });
}

function neverEndingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

describe("isOverflowMessage", () => {
  test("true for context-overflow phrasings", () => {
    expect(isOverflowMessage("prompt is too long")).toBe(true);
    expect(isOverflowMessage("This model's maximum context length is 131072 tokens. However, your messages resulted in 140000 tokens.")).toBe(true);
    expect(isOverflowMessage("context_length_exceeded")).toBe(true);
  });

  test("false for unrelated provider errors", () => {
    expect(isOverflowMessage("rate limit exceeded")).toBe(false);
    expect(isOverflowMessage("Too many requests")).toBe(false);
    expect(isOverflowMessage("invalid request: unknown parameter 'foo'")).toBe(false);
    expect(isOverflowMessage("Incorrect API key provided")).toBe(false);
  });
});

describe("contextOverflowResponse", () => {
  test("400 with the standard envelope plus code and max_context", async () => {
    const res = contextOverflowResponse(model);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message: "This model's maximum context length is 131072 tokens. Reduce the length of the input and try again.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
      max_context: 131072,
    });
  });

  test("omits max_context when the model has no declared context", async () => {
    const res = contextOverflowResponse({ id: "m" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as OverflowBody;
    expect(body.error.code).toBe("context_length_exceeded");
    expect("max_context" in body).toBe(false);
    expect(body.error.message).toContain("maximum context length");
  });
});

describe("detectContextOverflow", () => {
  test("returns null for an ok response without reading it", async () => {
    expect(await detectContextOverflow(new Response("x"), model)).toBeNull();
  });

  test("returns null for a non-overflow 429 and leaves the original body readable", async () => {
    const res = new Response("rate limit exceeded", { status: 429 });
    expect(await detectContextOverflow(res, model)).toBeNull();
    expect(await res.text()).toBe("rate limit exceeded");
  });
});

describe("POST /v1/chat/completions context overflow", () => {
  test("classifies an upstream overflow rejection into a clean 400", async () => {
    const raw = JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 131072 tokens. However, your messages resulted in 140000 tokens.",
        type: "invalid_request_error",
      },
    });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => new Response(raw, { status: 400 })),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(400);
    const body = await json<OverflowBody>(res);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe(CONTEXT_OVERFLOW_CODE);
    expect(body.error.message).toContain("131072");
    expect(body.max_context).toBe(131072);
  });

  test("classifies an overflow phrase nested in error.message", async () => {
    const raw = JSON.stringify({
      error: { message: "prompt is too long: 200000 tokens > 128000 maximum" },
    });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => new Response(raw, { status: 400 })),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(400);
    const body = await json<OverflowBody>(res);
    expect(body.error.code).toBe(CONTEXT_OVERFLOW_CODE);
    expect(body.max_context).toBe(131072);
  });

  test("overflows for a model without a declared context omit max_context", async () => {
    const raw = JSON.stringify({
      error: { message: "prompt is too long: 200000 tokens > 128000 maximum" },
    });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => new Response(raw, { status: 400 })),
    });
    const res = await app.fetch(chatRequest("no-context-model"));
    expect(res.status).toBe(400);
    const body = await json<OverflowBody>(res);
    expect(body.error.code).toBe(CONTEXT_OVERFLOW_CODE);
    expect("max_context" in body).toBe(false);
    expect(body.error.message).toContain("maximum context length");
  });
});

describe("POST /v1/chat/completions passthrough of non-overflow errors", () => {
  test("429 is relayed byte-for-byte with headers", async () => {
    const raw = JSON.stringify({ error: { message: "rate limit exceeded" } });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(
        () =>
          new Response(raw, {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "7" },
          }),
      ),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.text()).toBe(raw);
  });

  test("401 is relayed byte-for-byte", async () => {
    const raw = JSON.stringify({ error: { message: "Incorrect API key provided" } });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => new Response(raw, { status: 401 })),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(raw);
  });

  test("a generic 400 is relayed byte-for-byte with no code or max_context", async () => {
    const raw = JSON.stringify({ error: { message: "invalid request: unknown parameter 'foo'" } });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => new Response(raw, { status: 400 })),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe(raw);
    const body = JSON.parse(text) as OverflowBody;
    expect(body.error.code).toBeUndefined();
    expect("max_context" in body).toBe(false);
  });

  test("a 200 body containing an overflow phrase is not classified", async () => {
    const raw = JSON.stringify({ error: { message: "prompt is too long" } });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => new Response(raw, { status: 200 })),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(raw);
  });

  test("a 5xx body containing an overflow phrase is relayed unchanged", async () => {
    const raw = JSON.stringify({
      error: { message: "prompt is too long: 200000 tokens > 128000 maximum" },
    });
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => new Response(raw, { status: 500 })),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(raw);
  });

  test(
    "a never-closing non-ok body does not hang the relay",
    async () => {
      const app = createApp(config, {
        fetchUpstream: stubUpstream(
          () => new Response(neverEndingBody(), { status: 429, headers: { "retry-after": "9" } }),
        ),
      });
      const res = await app.fetch(chatRequest("qwen3-coder-30b"));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("9");
      // Deliberately do NOT read the body: it never closes.
    },
    5000,
  );

  test("relays a successful SSE stream untouched", async () => {
    const raw =
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n` +
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;
    const app = createApp(config, {
      fetchUpstream: stubUpstream(
        () => new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ),
    });
    const res = await app.fetch(chatRequest("qwen3-coder-30b"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(raw);
  });
});
