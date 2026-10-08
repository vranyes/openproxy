import { describe, expect, test } from "bun:test";
import { createApp, type UpstreamFetcher } from "../src/server";
import type { GatewayConfig } from "../src/config";

const config: GatewayConfig = {
  upstreams: [
    {
      id: "local",
      package: "@opencode-ai/ai/providers/openai-compatible",
      baseURL: "http://upstream.test/v1",
      apiKey: "test-key",
      models: [
        {
          id: "qwen3-coder-30b",
          upstream: "qwen3-coder:30b",
          context: 131072,
          maxOutput: 32768,
        },
      ],
    },
  ],
};

function stubUpstream(handler: (req: Request) => Response | Promise<Response>): UpstreamFetcher {
  return (url, init) => handler(new Request(url, init));
}

describe("GET /healthz", () => {
  test("returns ok", async () => {
    const app = createApp(config, { fetchUpstream: stubUpstream(() => new Response("nope", { status: 500 })) });
    const res = await app.fetch(new Request("http://gateway/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /v1/models", () => {
  test("lists every registry model as OpenAI entries", async () => {
    const app = createApp(config, { fetchUpstream: stubUpstream(() => new Response("nope", { status: 500 })) });
    const res = await app.fetch(new Request("http://gateway/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      { id: "qwen3-coder-30b", object: "model", owned_by: "local" },
    ]);
  });
});

describe("POST /v1/chat/completions (non-stream)", () => {
  test("forwards to the model's upstream and returns its body", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const app = createApp(
      config,
      {
        fetchUpstream: stubUpstream(async (req) => {
          seen = { url: req.url, body: (await req.json()) as Record<string, unknown> };
          return Response.json({
            id: "chatcmpl-1",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          });
        }),
      },
    );

    const res = await app.fetch(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen3-coder-30b", messages: [{ role: "user", content: "hello" }] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "hi" });
    expect(seen!.url).toBe("http://upstream.test/v1/chat/completions");
    expect(seen!.body).toMatchObject({ model: "qwen3-coder:30b" });
  });

  test("unknown model returns 404", async () => {
    const app = createApp(config, { fetchUpstream: stubUpstream(() => new Response("nope", { status: 500 })) });
    const res = await app.fetch(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "nope", messages: [] }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /librechat/tokenConfig", () => {
  test("returns context map derived from the registry", async () => {
    const app = createApp(config, { fetchUpstream: stubUpstream(() => new Response("nope", { status: 500 })) });
    const res = await app.fetch(new Request("http://gateway/librechat/tokenConfig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "qwen3-coder-30b": { context: 131072 } });
  });
});
