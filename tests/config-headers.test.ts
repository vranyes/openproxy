import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { GatewayConfigSchema } from "../src/config";

// F8: config surface for upstream headers + the OpenCode session header.
function baseUpstream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "u",
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: "http://upstream.test/v1",
    models: [{ id: "m" }],
    ...overrides,
  };
}

function parse(overrides: Record<string, unknown> = {}) {
  return GatewayConfigSchema.parse({ upstreams: [baseUpstream(overrides)] });
}

describe("upstream headers config", () => {
  test("parses a mixed-case header map unchanged", () => {
    const cfg = parse({
      headers: { "X-Custom-Header": "yes", Authorization: "Bearer x", "Content-Type": "application/json" },
    });
    expect(cfg.upstreams[0]!.headers).toEqual({
      "X-Custom-Header": "yes",
      Authorization: "Bearer x",
      "Content-Type": "application/json",
    });
  });

  test("absent parses to undefined", () => {
    expect(parse().upstreams[0]!.headers).toBeUndefined();
  });

  test("accepts an empty value", () => {
    expect(parse({ headers: { "x-a": "" } }).upstreams[0]!.headers).toEqual({ "x-a": "" });
  });

  test("rejects an invalid header name", () => {
    expect(() => parse({ headers: { "bad name": "v" } })).toThrow(/invalid HTTP header name/);
    expect(() => parse({ headers: { "bad\nname": "v" } })).toThrow(/invalid HTTP header name/);
    expect(() => parse({ headers: { "": "v" } })).toThrow(/invalid HTTP header name/);
  });

  test("rejects a CR/LF or control header value", () => {
    expect(() => parse({ headers: { "x-a": "a\r\nb" } })).toThrow(/invalid HTTP header value/);
    expect(() => parse({ headers: { "x-a": "a\nb" } })).toThrow(/invalid HTTP header value/);
    expect(() => parse({ headers: { "x-a": "a\0b" } })).toThrow(/invalid HTTP header value/);
  });
});

describe("sessionHeader config", () => {
  test("survives parse", () => {
    expect(parse({ sessionHeader: "x-opencode-session" }).upstreams[0]!.sessionHeader).toBe("x-opencode-session");
  });

  test("accepts x-opencode-session", () => {
    expect(parse({ sessionHeader: "x-opencode-session" }).upstreams[0]!.sessionHeader).toBe("x-opencode-session");
  });

  test("absent parses to undefined", () => {
    expect(parse().upstreams[0]!.sessionHeader).toBeUndefined();
  });

  test("rejects an invalid header name", () => {
    expect(() => parse({ sessionHeader: "bad name" })).toThrow(/valid HTTP header name/);
    expect(() => parse({ sessionHeader: "bad\nname" })).toThrow(/valid HTTP header name/);
    expect(() => parse({ sessionHeader: "" })).toThrow(/valid HTTP header name/);
  });

  test("rejects credential headers case-insensitively", () => {
    for (const name of ["Authorization", "COOKIE", "proxy-authorization", "x-api-key"]) {
      expect(() => parse({ sessionHeader: name })).toThrow(/must not be a credential header/);
    }
  });
});

describe("example configs parse with the F8 additions", () => {
  for (const file of ["../examples/gateway.yaml", "../examples/zen.yaml"]) {
    test(file, () => {
      const raw = parseYaml(readFileSync(new URL(file, import.meta.url), "utf8"));
      expect(() => GatewayConfigSchema.parse(raw)).not.toThrow();
    });
  }
});
