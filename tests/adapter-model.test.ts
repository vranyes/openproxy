import { describe, expect, test } from "bun:test";
import { UpstreamSchema, type GatewayUpstream } from "../src/config";
import { modelFor } from "../src/adapter/ai";

function upstreamOf(pkg: string, overrides: Record<string, unknown> = {}): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "u",
    package: pkg,
    baseURL: "http://up.test/v1",
    apiKey: "test-key",
    models: [{ id: "m" }],
    ...overrides,
  });
}

// `path` is null where the route computes it from the model (Anthropic builds
// `POST /messages[?beta=true]`), so only its shape is observable.
const CASES: Array<{ pkg: string; provider: string; path: string | null }> = [
  { pkg: "@opencode/ai/providers/openai", provider: "openai", path: "/responses" },
  { pkg: "@opencode/ai/providers/openai/responses", provider: "openai", path: "/responses" },
  { pkg: "@opencode/ai/providers/openai/chat", provider: "openai", path: "/chat/completions" },
  { pkg: "@opencode/ai/providers/openai-compatible", provider: "openai-compatible", path: "/chat/completions" },
  { pkg: "@opencode/ai/providers/openai-compatible/responses", provider: "openai-compatible", path: "/responses" },
  { pkg: "@opencode/ai/providers/anthropic", provider: "anthropic", path: null },
  { pkg: "@opencode/ai/providers/anthropic-compatible", provider: "anthropic-compatible", path: null },
];

describe("modelFor dispatch", () => {
  for (const c of CASES) {
    test(`${c.pkg} -> ${c.provider}`, () => {
      const model = modelFor(upstreamOf(c.pkg), "up-model");
      expect(String(model.provider)).toBe(c.provider);
      expect(String(model.id)).toBe("up-model");
      const endpoint = model.route.endpoint;
      expect(endpoint.baseURL).toBe("http://up.test/v1");
      if (c.path === null) {
        expect(typeof endpoint.path).toBe("function");
      } else {
        expect(typeof endpoint.path).toBe("string");
        expect(endpoint.path as string).toBe(c.path);
      }
    });
  }

  test("keyless (Auth.none) construction does not throw for any package", () => {
    for (const c of CASES) {
      const upstream = upstreamOf(c.pkg, { apiKey: undefined, apiKeyEnv: null });
      expect(() => modelFor(upstream, "up-model")).not.toThrow();
    }
  });
});
