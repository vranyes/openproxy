import { describe, expect, test } from "bun:test";

describe("@opencode/ai dependency", () => {
  test("exposes the v2 provider entry points", async () => {
    const index = await import("@opencode/ai");
    const compat = await import("@opencode/ai/providers/openai-compatible");
    expect(typeof index.isContextOverflow).toBe("function");
    expect(typeof compat.model).toBe("function");
  });
});
