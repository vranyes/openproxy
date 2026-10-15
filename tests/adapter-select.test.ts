import { describe, expect, test } from "bun:test";
import { UpstreamSchema } from "../src/config";
import { selectAdapter } from "../src/adapter";

function upstream(overrides: Record<string, unknown> = {}) {
  return UpstreamSchema.parse({
    id: "u",
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: "http://upstream.test/v1",
    models: [{ id: "m" }],
    ...overrides,
  });
}

describe("selectAdapter", () => {
  test("defaults to passthrough when no adapter is configured", () => {
    expect(selectAdapter(upstream())).toBe("passthrough");
  });

  test("an explicit passthrough wins", () => {
    expect(selectAdapter(upstream({ adapter: "passthrough" }))).toBe("passthrough");
  });

  test("adapter opencode selects the opencode adapter", () => {
    expect(selectAdapter(upstream({ adapter: "opencode" }))).toBe("opencode");
  });

  test("the deprecated openai-compatible alias canonicalizes to opencode", () => {
    expect(selectAdapter(upstream({ adapter: "openai-compatible" }))).toBe("opencode");
  });
});

describe("adapter config", () => {
  test("the openai-compatible alias is accepted on any translated package", () => {
    const u = upstream({ package: "@opencode/ai/providers/openai/responses", adapter: "openai-compatible" });
    expect(u.adapter).toBe("openai-compatible");
    expect(selectAdapter(u)).toBe("opencode");
  });

  test("adapter opencode is accepted on openai/responses", () => {
    const u = upstream({ package: "@opencode/ai/providers/openai/responses", adapter: "opencode" });
    expect(u.adapter).toBe("opencode");
    expect(selectAdapter(u)).toBe("opencode");
  });

  test("other packages parse without an adapter (and default to passthrough)", () => {
    const u = upstream({ package: "@opencode/ai/providers/anthropic" });
    expect(u.adapter).toBeUndefined();
    expect(selectAdapter(u)).toBe("passthrough");
  });

  test("rejects an unknown adapter value", () => {
    expect(() => upstream({ adapter: "nope" })).toThrow(/adapter must be/);
  });
});
