import { describe, expect, test } from "bun:test";
import { hostOf, hostTrusted, packageForNpm } from "../src/dialect";

describe("packageForNpm", () => {
  test("maps the three supported dialects", () => {
    expect(packageForNpm("@ai-sdk/openai-compatible")).toBe("@opencode/ai/providers/openai-compatible");
    expect(packageForNpm("@ai-sdk/openai")).toBe("@opencode/ai/providers/openai-compatible/responses");
    expect(packageForNpm("@ai-sdk/anthropic")).toBe("@opencode/ai/providers/anthropic-compatible");
  });

  test("is case-insensitive and trims", () => {
    expect(packageForNpm(" @AI-SDK/OpenAI ")).toBe("@opencode/ai/providers/openai-compatible/responses");
  });

  test("an unsupported npm (e.g. google) resolves to nothing", () => {
    expect(packageForNpm("@ai-sdk/google")).toBeUndefined();
    expect(packageForNpm("@aihubmix/ai-sdk-provider")).toBeUndefined();
    expect(packageForNpm(undefined)).toBeUndefined();
  });
});

describe("hostOf", () => {
  test("returns the lowercased hostname", () => {
    expect(hostOf("https://opencode.ai/inference/go/openai/v1")).toBe("opencode.ai");
  });

  test("null/undefined/garbage -> null", () => {
    expect(hostOf(undefined)).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("hostTrusted", () => {
  test("exact match, case-insensitive", () => {
    expect(hostTrusted("opencode.ai", ["OpenCode.ai"])).toBe(true);
  });

  test("a subdomain or suffix is NOT trusted by a bare entry", () => {
    expect(hostTrusted("evil.opencode.ai", ["opencode.ai"])).toBe(false);
    expect(hostTrusted("opencode.ai.evil.test", ["opencode.ai"])).toBe(false);
  });

  test("an absent/empty allowlist trusts nothing", () => {
    expect(hostTrusted("opencode.ai", undefined)).toBe(false);
    expect(hostTrusted("opencode.ai", [])).toBe(false);
    expect(hostTrusted(null, ["opencode.ai"])).toBe(false);
  });
});
