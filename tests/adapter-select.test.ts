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

  test("an explicit adapter wins", () => {
    expect(selectAdapter(upstream({ adapter: "openai-compatible" }))).toBe("openai-compatible");
    expect(selectAdapter(upstream({ adapter: "passthrough" }))).toBe("passthrough");
  });
});

describe("adapter config refinement", () => {
  test("rejects openai-compatible on a non-compatible package", () => {
    expect(() => upstream({ package: "@opencode/ai/providers/openai/responses", adapter: "openai-compatible" })).toThrow(
      /openai-compatible/,
    );
  });

  test("allows openai-compatible on the openai-compatible package", () => {
    expect(upstream({ adapter: "openai-compatible" }).adapter).toBe("openai-compatible");
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
