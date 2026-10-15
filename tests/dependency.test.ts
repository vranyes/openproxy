import { describe, expect, test } from "bun:test";

describe("@opencode/ai dependency", () => {
  test("exposes the v2 provider entry points", async () => {
    const index = await import("@opencode/ai");
    const compat = await import("@opencode/ai/providers/openai-compatible");
    expect(typeof index.isContextOverflow).toBe("function");
    expect(typeof compat.model).toBe("function");
  });

  test("exposes the F5 provider subpaths", async () => {
    const anthropic = await import("@opencode/ai/providers/anthropic");
    const anthropicCompatible = await import("@opencode/ai/providers/anthropic-compatible");
    const openai = await import("@opencode/ai/providers/openai");
    const openaiResponses = await import("@opencode/ai/providers/openai/responses");
    const openaiChat = await import("@opencode/ai/providers/openai/chat");
    const compat = await import("@opencode/ai/providers/openai-compatible");
    const compatResponses = await import("@opencode/ai/providers/openai-compatible/responses");
    // Every subpath re-exports `model`.
    for (const mod of [anthropic, anthropicCompatible, openai, openaiResponses, openaiChat, compat, compatResponses]) {
      expect(typeof mod.model).toBe("function");
    }
    // The full packages (and the standalone responses package) also configure.
    for (const mod of [anthropic, anthropicCompatible, openai, compat, compatResponses]) {
      expect(typeof mod.configure).toBe("function");
    }
  });
});

