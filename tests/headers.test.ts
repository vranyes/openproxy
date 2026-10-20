import { describe, expect, test } from "bun:test";
import { UpstreamSchema, type GatewayUpstream } from "../src/config";
import { DEFAULT_USER_AGENT, hasHeader, resolveUpstreamHeaders, setHeader } from "../src/headers";

function upstream(overrides: Record<string, unknown> = {}): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "u1",
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: "http://up.test/v1",
    models: [{ id: "m" }],
    ...overrides,
  });
}

describe("setHeader", () => {
  test("collapses duplicate-cased keys to a single one", () => {
    const target: Record<string, string> = { authorization: "old", Authorization: "older", "x-keep": "y" };
    setHeader(target, "AUTHORIZATION", "new");
    expect(target).toEqual({ "x-keep": "y", AUTHORIZATION: "new" });
    expect(hasHeader(target, "authorization")).toBe(true);
  });

  test("adds the header when absent", () => {
    const target: Record<string, string> = {};
    setHeader(target, "x-a", "1");
    expect(target).toEqual({ "x-a": "1" });
    expect(hasHeader(target, "X-A")).toBe(true);
    expect(hasHeader(target, "x-b")).toBe(false);
  });
});

describe("resolveUpstreamHeaders", () => {
  test("sends the distinct openproxy user-agent by default", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({ upstream: upstream() });
    expect(h["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(DEFAULT_USER_AGENT).toMatch(/^openproxy\//);
    expect(sessionSource).toBe("none");
  });

  test("a static user-agent override replaces the default in one key", () => {
    const { headers: h } = resolveUpstreamHeaders({ upstream: upstream({ headers: { "User-Agent": "custom/9", "x-custom": "v" } }) });
    expect(h["User-Agent"]).toBe("custom/9");
    expect(h["x-custom"]).toBe("v");
    expect(Object.keys(h).filter((k) => k.toLowerCase() === "user-agent")).toHaveLength(1);
  });

  test("forwards a session id from the inbound request", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({
      upstream: upstream({ sessionHeader: "x-opencode-session" }),
      inbound: new Headers({ "x-opencode-session": "s1" }),
    });
    expect(h["x-opencode-session"]).toBe("s1");
    expect(sessionSource).toBe("forwarded");
  });

  test("generates a session id via the injected generator", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({
      upstream: upstream({ sessionHeader: "x-opencode-session" }),
      inbound: new Headers(),
      generateSessionId: () => "gen-1",
    });
    expect(h["x-opencode-session"]).toBe("gen-1");
    expect(sessionSource).toBe("generated");
  });

  test("preserves a pinned static session header when inbound is omitted", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({
      upstream: upstream({ sessionHeader: "x-opencode-session", headers: { "x-opencode-session": "pinned" } }),
    });
    expect(h["x-opencode-session"]).toBe("pinned");
    expect(sessionSource).toBe("none");
  });

  test("preserves a pinned static session header when inbound omits it", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({
      upstream: upstream({ sessionHeader: "x-opencode-session", headers: { "x-opencode-session": "pinned" } }),
      inbound: new Headers(),
      generateSessionId: () => "gen-x",
    });
    expect(h["x-opencode-session"]).toBe("pinned");
    expect(sessionSource).toBe("pinned");
  });

  test("falls back to a generated id when the inbound value is unsafe", () => {
    const tab = resolveUpstreamHeaders({
      upstream: upstream({ sessionHeader: "x-opencode-session" }),
      inbound: new Headers({ "x-opencode-session": "a\tb" }),
      generateSessionId: () => "gen-2",
    });
    expect(tab.headers["x-opencode-session"]).toBe("gen-2");
    expect(tab.sessionSource).toBe("generated");

    const empty = resolveUpstreamHeaders({
      upstream: upstream({ sessionHeader: "x-opencode-session" }),
      inbound: new Headers({ "x-opencode-session": "" }),
      generateSessionId: () => "gen-3",
    });
    expect(empty.headers["x-opencode-session"]).toBe("gen-3");
    expect(empty.sessionSource).toBe("generated");
  });

  test("never handles a session when sessionHeader is unset", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({
      upstream: upstream(),
      inbound: new Headers({ "x-opencode-session": "s1" }),
    });
    expect(hasHeader(h, "x-opencode-session")).toBe(false);
    expect(sessionSource).toBe("none");
  });

  test("never handles a session when inbound is omitted", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({ upstream: upstream({ sessionHeader: "x-opencode-session" }) });
    expect(hasHeader(h, "x-opencode-session")).toBe(false);
    expect(sessionSource).toBe("none");
  });

  test("does not mutate upstream.headers", () => {
    const u = upstream({ headers: { "x-custom": "v" }, sessionHeader: "x-opencode-session" });
    const before = { ...u.headers };
    const { headers: h } = resolveUpstreamHeaders({ upstream: u, inbound: new Headers(), generateSessionId: () => "gen-4" });
    expect(u.headers).toEqual(before);
    expect(h["x-custom"]).toBe("v");
    expect(h["x-opencode-session"]).toBe("gen-4");
  });

  test("sessionFromHeaders tries candidates in order under sessionHeader", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({
      upstream: upstream({
        sessionHeader: "x-opencode-session",
        sessionFromHeaders: ["x-conversation-id", "x-opencode-session"],
      }),
      inbound: new Headers({ "x-conversation-id": "conv-1", "x-opencode-session": "sess-9" }),
      generateSessionId: () => "gen-x",
    });
    expect(h["x-opencode-session"]).toBe("conv-1");
    expect(sessionSource).toBe("forwarded");
  });

  test("sessionFromHeaders skips unsafe values for the next candidate", () => {
    const { headers: h, sessionSource } = resolveUpstreamHeaders({
      upstream: upstream({
        sessionHeader: "x-opencode-session",
        sessionFromHeaders: ["x-conversation-id", "x-opencode-session"],
      }),
      inbound: new Headers({ "x-conversation-id": "a\tb", "x-opencode-session": "sess-2" }),
      generateSessionId: () => "gen-x",
    });
    expect(h["x-opencode-session"]).toBe("sess-2");
    expect(sessionSource).toBe("forwarded");
  });
});
