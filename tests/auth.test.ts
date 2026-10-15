import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import type { GatewayAuthConfig, GatewayConfig } from "../src/config";
import { authToken, authStartupWarning, resolveAuth, unauthorizedResponse } from "../src/ops/auth";
import type { LogEvent } from "../src/ops/log";
import { createApp } from "../src/server";
import { json, stubUpstream } from "./helpers";

const okUpstream = stubUpstream(() => Response.json({ object: "chat.completion", choices: [] }));

function baseConfig(auth?: GatewayAuthConfig): GatewayConfig {
  return {
    upstreams: [
      {
        id: "local",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "http://upstream.test/v1",
        apiKey: "test-key",
        models: [{ id: "m", context: 8 }],
      },
    ],
    ...(auth === undefined ? {} : { auth }),
  };
}

function capturingApp(config: GatewayConfig): { app: ReturnType<typeof createApp>; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const app = createApp(config, { fetchUpstream: okUpstream, logger: (e) => events.push(e) });
  return { app, events };
}

const CHAT_URL = "http://gateway/v1/chat/completions";

function chatRequest(headers: Record<string, string> = {}): Request {
  return new Request(CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
}

type ErrorBody = { error: { message: string; type: string; code?: string } };

describe("open by default", () => {
  test("a chat request with no auth config returns 200", async () => {
    const { app } = capturingApp(baseConfig());
    const res = await app.fetch(chatRequest());
    expect(res.status).toBe(200);
  });

  test("/healthz emits exactly one request event and nothing else", async () => {
    const { app, events } = capturingApp(baseConfig());
    const res = await app.fetch(new Request("http://gateway/healthz"));
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]!.msg).toBe("request");
  });
});

describe("auth enforced", () => {
  test("a missing Authorization header returns 401 with the standard envelope and www-authenticate", async () => {
    const { app, events } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest());
    expect(res.status).toBe(401);
    expect(await json<ErrorBody>(res)).toEqual({
      error: { message: "Invalid authentication", type: "invalid_request_error", code: "invalid_api_key" },
    });
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="openproxy"');
    const requests = events.filter((e) => e.msg === "request");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ status: 401 });
  });

  test("a wrong token of the same length returns 401", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest({ authorization: "Bearer abcdef" }));
    expect(res.status).toBe(401);
  });

  test("a wrong token of a different length returns 401", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest({ authorization: "Bearer s3cret-longer" }));
    expect(res.status).toBe(401);
  });

  test("the correct bearer token returns 200", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
  });
});

describe("bearer parsing", () => {
  test("accepts a lowercase bearer keyword", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest({ authorization: "bearer s3cret" }));
    expect(res.status).toBe(200);
  });

  test("accepts an uppercase bearer keyword", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest({ authorization: "BEARER s3cret" }));
    expect(res.status).toBe(200);
  });

  test("rejects a bare token with no keyword", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest({ authorization: "s3cret" }));
    expect(res.status).toBe(401);
  });

  test("rejects an empty bearer value", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret" }));
    const res = await app.fetch(chatRequest({ authorization: "Bearer " }));
    expect(res.status).toBe(401);
  });
});

describe("tokenEnv", () => {
  test("resolves the token from the named env var", async () => {
    process.env.OPENPROXY_TEST_TOKEN = "envtok";
    try {
      const { app } = capturingApp(baseConfig({ tokenEnv: "OPENPROXY_TEST_TOKEN" }));
      const res = await app.fetch(chatRequest({ authorization: "Bearer envtok" }));
      expect(res.status).toBe(200);
    } finally {
      delete process.env.OPENPROXY_TEST_TOKEN;
    }
  });

  test("an unset tokenEnv is misconfigured and returns 401 with one request event", async () => {
    delete process.env.OPENPROXY_TEST_TOKEN;
    const { app, events } = capturingApp(baseConfig({ tokenEnv: "OPENPROXY_TEST_TOKEN" }));
    const res = await app.fetch(chatRequest());
    expect(res.status).toBe(401);
    expect(events.filter((e) => e.msg === "request")).toHaveLength(1);
  });
});

describe("custom header and raw scheme", () => {
  test("matches the raw x-api-key header", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret", header: "x-api-key", scheme: "raw" }));
    const res = await app.fetch(chatRequest({ "x-api-key": "s3cret" }));
    expect(res.status).toBe(200);
  });

  test("ignores Authorization when the header is x-api-key", async () => {
    const { app } = capturingApp(baseConfig({ token: "s3cret", header: "x-api-key", scheme: "raw" }));
    const res = await app.fetch(chatRequest({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(401);
  });
});

describe("public path", () => {
  const { app } = capturingApp(baseConfig({ token: "s3cret" }));

  test("/healthz stays public", async () => {
    const res = await app.fetch(new Request("http://gateway/healthz"));
    expect(res.status).toBe(200);
  });

  test("data routes require a credential", async () => {
    expect((await app.fetch(new Request("http://gateway/v1/models"))).status).toBe(401);
    expect((await app.fetch(chatRequest())).status).toBe(401);
    expect((await app.fetch(new Request("http://gateway/librechat/tokenConfig"))).status).toBe(401);
    expect((await app.fetch(new Request("http://gateway/librechat.yaml.fragment"))).status).toBe(401);
  });
});

describe("librechat fragment apiKey", () => {
  function fragment(
    auth?: GatewayAuthConfig,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const { app } = capturingApp(baseConfig(auth));
    return app
      .fetch(new Request("http://gateway/librechat.yaml.fragment", { headers }))
      .then(async (res) => {
        const doc = parseYaml(await res.text()) as { endpoints: { custom: Array<Record<string, unknown>> } };
        return doc.endpoints.custom[0]!;
      });
  }

  test("defaults apiKey to the enforced token", async () => {
    const entry = await fragment({ token: "s3cret" }, { authorization: "Bearer s3cret" });
    expect(entry.apiKey).toBe("s3cret");
  });

  test("defaults apiKey to dummy in open mode", async () => {
    const entry = await fragment();
    expect(entry.apiKey).toBe("dummy");
  });
});

describe("authStartupWarning", () => {
  test("warns when auth is undefined (open)", () => {
    expect(authStartupWarning(undefined, {})).toEqual({
      level: "warn",
      msg: "client auth is disabled; gateway is open",
    });
  });

  test("is null when enforced", () => {
    expect(authStartupWarning({ token: "t" }, {})).toBeNull();
  });

  test("errors when misconfigured", () => {
    const event = authStartupWarning({ tokenEnv: "OPENPROXY_MISSING_TOKEN" }, {});
    expect(event).toMatchObject({
      level: "error",
      msg: "client auth misconfigured; all data routes will return 401",
    });
    expect((event as LogEvent).reason).toBe("token or tokenEnv did not resolve to a value");
  });
});

describe("resolveAuth and authToken", () => {
  test("undefined resolves to open", () => {
    expect(resolveAuth(undefined, {})).toEqual({ mode: "open" });
    expect(authToken(undefined, {})).toBeNull();
  });

  test("a token resolves to enforced with defaults applied", () => {
    const resolved = resolveAuth({ token: "t" }, {});
    expect(resolved).toEqual({
      mode: "enforced",
      config: { header: "authorization", scheme: "bearer", token: "t" },
    });
    expect(authToken({ token: "t" }, {})).toBe("t");
  });

  test("an unresolved tokenEnv is misconfigured and yields no token", () => {
    expect(resolveAuth({ tokenEnv: "MISSING" }, {})).toMatchObject({ mode: "misconfigured" });
    expect(authToken({ tokenEnv: "MISSING" }, {})).toBeNull();
  });

  test("unauthorizedResponse carries the 401 envelope and header", async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="openproxy"');
    expect(await res.json()).toEqual({
      error: { message: "Invalid authentication", type: "invalid_request_error", code: "invalid_api_key" },
    });
  });
});
