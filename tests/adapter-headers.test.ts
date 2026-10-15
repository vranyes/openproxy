import { describe, expect, test } from "bun:test";
import { UpstreamSchema, type GatewayUpstream } from "../src/config";
import { createApp } from "../src/server";
import { stubUpstream } from "./helpers";
import { anthropicTextStream, chatTextStream, sseResponse, withUpstream } from "./fake-providers";

const OPENAI_COMPAT = "@opencode/ai/providers/openai-compatible";
const ANTHROPIC_COMPAT = "@opencode/ai/providers/anthropic-compatible";

function upstreamOf(baseURL: string, overrides: Record<string, unknown> = {}): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "local",
    package: OPENAI_COMPAT,
    baseURL,
    adapter: "opencode",
    apiKeyEnv: null,
    models: [{ id: "gw-model", upstream: "up-model", context: 1000 }],
    ...overrides,
  });
}

function appFor(upstream: GatewayUpstream): ReturnType<typeof createApp> {
  return createApp({ upstreams: [upstream] });
}

/** Chat Completions request with optional inbound headers (e.g. a session). */
function chatRequest(
  model: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream: true, ...body }),
  });
}

describe("opencode path upstream headers", () => {
  test("static header + UA override + forwarded session + apiKey authorization wins", async () => {
    let seen: Headers | null = null;
    await withUpstream(
      (req) => {
        seen = req.headers;
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const up = upstreamOf(baseURL, {
          apiKey: "sekret",
          headers: { "x-custom": "static-value", "User-Agent": "custom-ua/2" },
          sessionHeader: "x-opencode-session",
        });
        const res = await appFor(up).fetch(chatRequest("gw-model", {}, { "x-opencode-session": "sess-123" }));
        expect(res.status).toBe(200);
        await res.text();
      },
    );
    expect(seen!.get("x-custom")).toBe("static-value");
    expect(seen!.get("user-agent")).toBe("custom-ua/2");
    expect(seen!.get("x-opencode-session")).toBe("sess-123");
    expect(seen!.get("authorization")).toBe("Bearer sekret");
  });

  test("mixed-case static authorization/content-type never duplicate and apiKey wins", async () => {
    let seen: Headers | null = null;
    await withUpstream(
      (req) => {
        seen = req.headers;
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const up = upstreamOf(baseURL, {
          apiKey: "sekret",
          headers: { Authorization: "Bearer static", "Content-Type": "text/plain" },
        });
        const res = await appFor(up).fetch(chatRequest("gw-model"));
        expect(res.status).toBe(200);
        await res.text();
      },
    );
    // Exact equality proves a single value (Bun comma-joins duplicates).
    expect(seen!.get("authorization")).toBe("Bearer sekret");
    expect(seen!.get("content-type")).toBe("application/json");
  });

  test("generated session id is stable across requests to the same upstream", async () => {
    const sessions: string[] = [];
    await withUpstream(
      (req) => {
        sessions.push(req.headers.get("x-opencode-session") ?? "");
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const app = appFor(upstreamOf(baseURL, { sessionHeader: "x-opencode-session" }));
        await (await app.fetch(chatRequest("gw-model"))).text();
        await (await app.fetch(chatRequest("gw-model"))).text();
      },
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBeTruthy();
    expect(sessions[1]).toBe(sessions[0]);
  });

  test("sends the openproxy default user-agent", async () => {
    let ua = "";
    await withUpstream(
      (req) => {
        ua = req.headers.get("user-agent") ?? "";
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        await (await appFor(upstreamOf(baseURL)).fetch(chatRequest("gw-model"))).text();
      },
    );
    expect(ua).toMatch(/^openproxy\//);
  });

  test("keyless upstream forwards a static authorization header", async () => {
    let auth = "";
    await withUpstream(
      (req) => {
        auth = req.headers.get("authorization") ?? "";
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const up = upstreamOf(baseURL, { apiKeyEnv: null, headers: { Authorization: "Bearer static" } });
        await (await appFor(up).fetch(chatRequest("gw-model"))).text();
      },
    );
    expect(auth).toBe("Bearer static");
  });

  test("inbound authorization and cookie never reach the upstream", async () => {
    let seen: Headers | null = null;
    await withUpstream(
      (req) => {
        seen = req.headers;
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const up = upstreamOf(baseURL, { apiKeyEnv: null, sessionHeader: "x-opencode-session" });
        const res = await appFor(up).fetch(
          chatRequest("gw-model", {}, { authorization: "Bearer client-token", cookie: "a=b" }),
        );
        expect(res.status).toBe(200);
        await res.text();
      },
    );
    expect(seen!.get("authorization")).toBeNull();
    expect(seen!.get("cookie")).toBeNull();
  });

  test("anthropic-compatible: the session reaches /v1/messages", async () => {
    let path = "";
    let session = "";
    await withUpstream(
      (req) => {
        path = new URL(req.url).pathname;
        session = req.headers.get("x-opencode-session") ?? "";
        return sseResponse(anthropicTextStream("ok"));
      },
      async (baseURL) => {
        const up = upstreamOf(baseURL, {
          package: ANTHROPIC_COMPAT,
          apiKey: "sekret",
          sessionHeader: "x-opencode-session",
        });
        const res = await appFor(up).fetch(chatRequest("gw-model", {}, { "x-opencode-session": "sess-anth" }));
        expect(res.status).toBe(200);
        await res.text();
      },
    );
    expect(path).toBe("/v1/messages");
    expect(session).toBe("sess-anth");
  });
});

describe("passthrough path upstream headers", () => {
  test("sends UA + static + session, forces JSON content-type, apiKey wins", async () => {
    let seen: Request | null = null;
    const up = UpstreamSchema.parse({
      id: "local",
      package: OPENAI_COMPAT,
      baseURL: "http://upstream.test/v1",
      apiKey: "sekret",
      headers: { "x-custom": "static-value", "Content-Type": "text/plain", Authorization: "Bearer static" },
      sessionHeader: "x-opencode-session",
      models: [{ id: "gw-model", upstream: "up-model", context: 1000 }],
    });
    const app = createApp(
      { upstreams: [up] },
      {
        fetchUpstream: stubUpstream((req) => {
          seen = req;
          return new Response(
            JSON.stringify({
              id: "chatcmpl-1",
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }),
      },
    );
    const res = await app.fetch(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-session": "sess-pass",
          authorization: "Bearer inbound",
        },
        body: JSON.stringify({ model: "gw-model", messages: [{ role: "user", content: "hello" }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seen!.headers.get("x-custom")).toBe("static-value");
    expect(seen!.headers.get("content-type")).toBe("application/json");
    expect(seen!.headers.get("authorization")).toBe("Bearer sekret");
    expect(seen!.headers.get("x-opencode-session")).toBe("sess-pass");
    expect(seen!.headers.get("user-agent")).toMatch(/^openproxy\//);
  });
});
