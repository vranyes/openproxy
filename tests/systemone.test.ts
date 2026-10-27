import { describe, expect, test } from "bun:test";
import { GatewayConfigSchema, UpstreamSchema, type GatewayConfig } from "../src/config";
import { selectAdapter } from "../src/adapter";
import { createSystemOneAdapter } from "../src/adapter/systemone";
import { createApp } from "../src/server";
import { json, stubUpstream } from "./helpers";

const QUESTIONS = {
  is_urgent: { type: "noul", instructions: "Does this request require urgent attention?" },
};

function jevConfig(overrides: Record<string, unknown> = {}): GatewayConfig {
  return GatewayConfigSchema.parse({
    upstreams: [
      {
        id: "jev",
        adapter: "systemone",
        baseURL: "https://opencode.ai/inference/systemone/v1",
        apiKey: "s1-key",
        sessionHeader: "x-opencode-session",
        models: [{ id: "jev-1.13-free" }, { id: "jev-1.13", upstream: "jev-1.13", cost: { input: 0.042, output: 0 } }],
        ...overrides,
      },
    ],
  });
}

function jevBody(overrides: Record<string, unknown> = {}) {
  return { model: "jev-1.13-free", state: "payments failed", questions: QUESTIONS, ...overrides };
}

const ANSWERS = {
  model: "jev-1.13.0",
  answers: { is_urgent: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 100, output_tokens: 10 },
};

describe("systemone config", () => {
  test("parses without a package", () => {
    const u = UpstreamSchema.parse({
      id: "j",
      adapter: "systemone",
      baseURL: "https://opencode.ai/inference/systemone/v1",
      models: [{ id: "jev-1.13-free" }],
    });
    expect(u.adapter).toBe("systemone");
    expect(u.package).toBeUndefined();
  });

  test("requires baseURL", () => {
    expect(() =>
      UpstreamSchema.parse({ id: "j", adapter: "systemone", models: [{ id: "m" }] }),
    ).toThrow(/baseURL is required/);
  });

  test("rejects an upstream package", () => {
    expect(() =>
      UpstreamSchema.parse({
        id: "j",
        adapter: "systemone",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "https://opencode.ai/inference/systemone/v1",
        models: [{ id: "m" }],
      }),
    ).toThrow(/package must be omitted/);
  });

  test("rejects per-model package/baseURL", () => {
    expect(() =>
      UpstreamSchema.parse({
        id: "j",
        adapter: "systemone",
        baseURL: "https://opencode.ai/inference/systemone/v1",
        models: [{ id: "m", baseURL: "https://x.test/v1" }],
      }),
    ).toThrow(/ignored when adapter is/);
  });

  test("selectAdapter passes systemone through", () => {
    const u = UpstreamSchema.parse({
      id: "j",
      adapter: "systemone",
      baseURL: "https://opencode.ai/inference/systemone/v1",
      models: [{ id: "m" }],
    });
    expect(selectAdapter(u)).toBe("systemone");
  });
});

describe("POST /v1/systemone", () => {
  test("relays to <baseURL>/systemone with the upstream model id and auth", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    let seenBody: Record<string, unknown> | undefined;
    const app = createApp(jevConfig(), {
      fetchUpstream: stubUpstream((req) => {
        seenUrl = req.url;
        seenAuth = req.headers.get("authorization") ?? undefined;
        return req.json().then((b) => {
          seenBody = b as Record<string, unknown>;
          return Response.json(ANSWERS);
        });
      }),
    });
    const res = await app.fetch(
      new Request("http://gateway/v1/systemone", { method: "POST", body: JSON.stringify(jevBody()) }),
    );
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://opencode.ai/inference/systemone/v1/systemone");
    expect(seenAuth as string).toBe("Bearer s1-key");
    expect(seenBody as Record<string, unknown>).toMatchObject({ model: "jev-1.13-free", state: "payments failed" });
    expect(await json(res)).toEqual(ANSWERS);
  });

  test("rewrites an aliased model id and tolerates a trailing-slash baseURL", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> | undefined;
    const cfg = jevConfig({ baseURL: "https://opencode.ai/inference/systemone/v1/" });
    const app = createApp(cfg, {
      fetchUpstream: stubUpstream((req) => {
        seenUrl = req.url;
        return req.json().then((b) => {
          seenBody = b as Record<string, unknown>;
          return Response.json(ANSWERS);
        });
      }),
    });
    const res = await app.fetch(
      new Request(
        "http://gateway/v1/systemone",
        { method: "POST", body: JSON.stringify(jevBody({ model: "jev-1.13" })) },
      ),
    );
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://opencode.ai/inference/systemone/v1/systemone");
    expect((seenBody as Record<string, unknown>).model).toBe("jev-1.13");
  });

  test("sends the session header", async () => {
    let seenSession: string | undefined;
    const app = createApp(jevConfig(), {
      fetchUpstream: stubUpstream((req) => {
        seenSession = req.headers.get("x-opencode-session") ?? undefined;
        return Response.json(ANSWERS);
      }),
      generateSessionId: () => "sess-1",
    });
    const res = await app.fetch(
      new Request("http://gateway/v1/systemone", { method: "POST", body: JSON.stringify(jevBody()) }),
    );
    expect(res.status).toBe(200);
    expect(seenSession as string).toBe("sess-1");
  });

  test("400s on a missing state, empty questions, bad type, or missing instructions", async () => {
    const app = createApp(jevConfig(), {
      fetchUpstream: stubUpstream(() => Response.json(ANSWERS)),
    });
    for (const body of [
      jevBody({ state: undefined }),
      jevBody({ questions: {} }),
      jevBody({ questions: { q: { type: "essay", instructions: "x" } } }),
      jevBody({ questions: { q: { type: "noul" } } }),
    ]) {
      const res = await app.fetch(new Request("http://gateway/v1/systemone", { method: "POST", body: JSON.stringify(body) }));
      expect(res.status).toBe(400);
    }
  });

  test("passes upstream errors through with status and body", async () => {
    const app = createApp(jevConfig(), {
      fetchUpstream: stubUpstream(() => new Response('{"error":"bad question"}', { status: 422 })),
    });
    const res = await app.fetch(
      new Request("http://gateway/v1/systemone", { method: "POST", body: JSON.stringify(jevBody()) }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('{"error":"bad question"}');
  });

  test("404s on unknown models and isolates chat vs systemone dialects", async () => {
    const cfg: GatewayConfig = {
      upstreams: [
        {
          id: "chat",
          package: "@opencode/ai/providers/openai-compatible",
          baseURL: "http://chat.test/v1",
          models: [{ id: "chat-model", context: 1000 }],
        },
        ...jevConfig().upstreams,
      ],
    };
    const app = createApp(cfg, { fetchUpstream: stubUpstream(() => Response.json(ANSWERS)) });
    const sysOnChat = await app.fetch(
      new Request("http://gateway/v1/systemone", { method: "POST", body: JSON.stringify(jevBody({ model: "chat-model" })) }),
    );
    expect(sysOnChat.status).toBe(404);
    const chatOnJev = await app.fetch(
      new Request(
        "http://gateway/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ model: "jev-1.13-free", messages: [] }) },
      ),
    );
    expect(chatOnJev.status).toBe(404);
    const unknown = await app.fetch(
      new Request("http://gateway/v1/systemone", { method: "POST", body: JSON.stringify(jevBody({ model: "nope" })) }),
    );
    expect(unknown.status).toBe(404);
  });

  test("omits Jev ids from GET /v1/models", async () => {
    const app = createApp(jevConfig(), { fetchUpstream: stubUpstream(() => new Response("nope", { status: 500 })) });
    const res = await app.fetch(new Request("http://gateway/v1/models"));
    expect(res.status).toBe(200);
    expect(await json<{ object: string; data: unknown[] }>(res)).toEqual({ object: "list", data: [] });
  });
});

describe("systemone usage + cost", () => {
  test("completed meta carries snake_case usage and priced cost", async () => {
    const adapter = createSystemOneAdapter({
      fetchUpstream: stubUpstream(() => Response.json(ANSWERS)),
      ai: {} as never,
    });
    const upstream = UpstreamSchema.parse({
      id: "j",
      adapter: "systemone",
      baseURL: "https://opencode.ai/inference/systemone/v1",
      models: [{ id: "m" }],
    });
    const result = await adapter.handle({
      upstream,
      model: { id: "m" },
      body: jevBody({ model: "m" }),
      cost: { input: 0.042, output: 0 },
    });
    expect(result.response.status).toBe(200);
    const meta = await result.completed;
    expect(meta?.usage).toEqual({ tokensIn: 100, tokensOut: 10, tokensTotal: 110 });
    expect(meta?.costUsd).toEqual(0.000004);
  });
});
