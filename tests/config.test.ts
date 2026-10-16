import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  GatewayConfigSchema,
  KNOWN_PROVIDER_PACKAGES,
  UpstreamSchema,
  resolveApiKey,
  type GatewayUpstream,
} from "../src/config";

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

describe("provider package identity", () => {
  for (const pkg of KNOWN_PROVIDER_PACKAGES) {
    test(`accepts ${pkg}`, () => {
      const cfg = parse({ package: pkg });
      expect(cfg.upstreams[0]!.package).toBe(pkg);
    });
  }

  test("rejects the legacy @opencode-ai/ai prefix", () => {
    expect(() => parse({ package: "@opencode-ai/ai/providers/openai-compatible" })).toThrow(
      /known @opencode\/ai provider subpath/,
    );
  });
});

describe("model context is optional", () => {
  test("a model with no context parses with context undefined", () => {
    const cfg = parse({ models: [{ id: "mystery" }] });
    expect(cfg.upstreams[0]!.models[0]!.context).toBeUndefined();
  });
});

describe("maxOutput vs context", () => {
  test("rejects maxOutput greater than context", () => {
    expect(() => parse({ models: [{ id: "m", context: 100, maxOutput: 200 }] })).toThrow(
      /maxOutput must be <= context/,
    );
  });

  test("accepts maxOutput equal to context", () => {
    const cfg = parse({ models: [{ id: "m", context: 100, maxOutput: 100 }] });
    expect(cfg.upstreams[0]!.models[0]!.maxOutput).toBe(100);
  });

  test("accepts maxOutput below context", () => {
    const cfg = parse({ models: [{ id: "m", context: 100, maxOutput: 50 }] });
    expect(cfg.upstreams[0]!.models[0]!.maxOutput).toBe(50);
  });

  test("accepts maxOutput with no context", () => {
    const cfg = parse({ models: [{ id: "m", maxOutput: 50 }] });
    expect(cfg.upstreams[0]!.models[0]!.maxOutput).toBe(50);
  });
});

describe("apiKeyEnv", () => {
  test("explicit null parses and stays null", () => {
    const cfg = parse({ apiKeyEnv: null });
    expect(cfg.upstreams[0]!.apiKeyEnv).toBeNull();
  });

  test("absent parses to undefined", () => {
    const cfg = parse();
    expect(cfg.upstreams[0]!.apiKeyEnv).toBeUndefined();
  });
});

describe("dropParams", () => {
  test("rejects empty parameter names", () => {
    expect(() => parse({ models: [{ id: "m", dropParams: [""] }] })).toThrow();
  });

  test("accepts real parameter names", () => {
    const cfg = parse({ models: [{ id: "m", dropParams: ["stop", "user"] }] });
    expect(cfg.upstreams[0]!.models[0]!.dropParams).toEqual(["stop", "user"]);
  });
});

describe("model cost", () => {
  test("parses a full cost block", () => {
    const cfg = parse({ models: [{ id: "m", cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.05 } }] });
    expect(cfg.upstreams[0]!.models[0]!.cost).toEqual({ input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.05 });
  });

  test("is optional and absent parses to undefined", () => {
    expect(parse().upstreams[0]!.models[0]!.cost).toBeUndefined();
  });

  test("rejects a negative price", () => {
    expect(() => parse({ models: [{ id: "m", cost: { input: -1 } }] })).toThrow();
    expect(() => parse({ models: [{ id: "m", cost: { output: -0.5 } }] })).toThrow();
  });
});

describe("discoverUrl config", () => {
  test("parses an absolute URL", () => {
    const cfg = parse({ discoverUrl: "https://opencode.ai/inference/go/v1/models" });
    expect(cfg.upstreams[0]!.discoverUrl).toBe("https://opencode.ai/inference/go/v1/models");
  });

  test("absent parses to undefined", () => {
    expect(parse().upstreams[0]!.discoverUrl).toBeUndefined();
  });

  test("rejects a value that is not a valid URL", () => {
    expect(() => parse({ discoverUrl: "not a url" })).toThrow();
    expect(() => parse({ discoverUrl: "/models" })).toThrow();
  });
});

describe("adapter", () => {
  test("accepts every adapter kind", () => {
    expect(parse({ adapter: "passthrough" }).upstreams[0]!.adapter).toBe("passthrough");
    expect(parse({ adapter: "opencode" }).upstreams[0]!.adapter).toBe("opencode");
    expect(parse({ adapter: "openai-compatible" }).upstreams[0]!.adapter).toBe("openai-compatible");
  });

  test("absent parses to undefined", () => {
    expect(parse().upstreams[0]!.adapter).toBeUndefined();
  });

  test("rejects an unknown adapter value", () => {
    expect(() => parse({ adapter: "other" })).toThrow(/adapter must be/);
  });

  test("opencode and its deprecated alias both parse on any package", () => {
    for (const pkg of KNOWN_PROVIDER_PACKAGES) {
      expect(parse({ package: pkg, adapter: "opencode" }).upstreams[0]!.adapter).toBe("opencode");
      expect(parse({ package: pkg, adapter: "openai-compatible" }).upstreams[0]!.adapter).toBe("openai-compatible");
    }
  });
});

describe("example configs parse", () => {
  for (const file of ["../examples/gateway.yaml", "../examples/zen.yaml"]) {
    test(file, () => {
      const raw = parseYaml(readFileSync(new URL(file, import.meta.url), "utf8"));
      expect(() => GatewayConfigSchema.parse(raw)).not.toThrow();
    });
  }
});

describe("resolveApiKey", () => {
  function up(input: Record<string, unknown> = {}): GatewayUpstream {
    return UpstreamSchema.parse(baseUpstream(input));
  }

  test("apiKey wins over apiKeyEnv", () => {
    process.env.OPENPROXY_TEST_KEY = "from-env";
    try {
      expect(resolveApiKey(up({ apiKey: "direct", apiKeyEnv: "OPENPROXY_TEST_KEY" }))).toBe("direct");
    } finally {
      delete process.env.OPENPROXY_TEST_KEY;
    }
  });

  test("reads the env var named by apiKeyEnv", () => {
    process.env.OPENPROXY_TEST_KEY = "from-env";
    try {
      expect(resolveApiKey(up({ apiKeyEnv: "OPENPROXY_TEST_KEY" }))).toBe("from-env");
    } finally {
      delete process.env.OPENPROXY_TEST_KEY;
    }
  });

  test("apiKeyEnv null means no auth", () => {
    expect(resolveApiKey(up({ apiKeyEnv: null }))).toBeUndefined();
  });

  test("no key configured yields undefined", () => {
    expect(resolveApiKey(up())).toBeUndefined();
  });
});

describe("modelsDev override", () => {
  test("a model-level ref parses", () => {
    const cfg = parse({ models: [{ id: "m", modelsDev: { provider: "zai", model: "glm-5.2" } }] });
    expect(cfg.upstreams[0]!.models[0]!.modelsDev).toEqual({ provider: "zai", model: "glm-5.2" });
  });

  test("a partial ref (provider only) parses", () => {
    const cfg = parse({ models: [{ id: "m", modelsDev: { provider: "openai" } }] });
    expect(cfg.upstreams[0]!.models[0]!.modelsDev).toEqual({ provider: "openai" });
  });

  test("false disables models.dev and stays false", () => {
    expect(parse({ models: [{ id: "m", modelsDev: false }] }).upstreams[0]!.models[0]!.modelsDev).toBe(false);
    expect(parse({ modelsDev: false }).upstreams[0]!.modelsDev).toBe(false);
  });

  test("absent parses to undefined", () => {
    expect(parse().upstreams[0]!.modelsDev).toBeUndefined();
    expect(parse().upstreams[0]!.models[0]!.modelsDev).toBeUndefined();
  });

  test("rejects an invalid value", () => {
    expect(() => parse({ models: [{ id: "m", modelsDev: "yes" }] })).toThrow();
    expect(() => parse({ models: [{ id: "m", modelsDev: { provider: "" } }] })).toThrow();
  });
});

describe("librechat config", () => {
  test("parses name/baseURL/apiKey", () => {
    const cfg = GatewayConfigSchema.parse({
      upstreams: [baseUpstream()],
      librechat: { name: "gw", baseURL: "https://gw.example/v1", apiKey: "k" },
    });
    expect(cfg.librechat).toEqual({ name: "gw", baseURL: "https://gw.example/v1", apiKey: "k" });
  });

  test("is optional", () => {
    expect(parse().librechat).toBeUndefined();
  });

  test("rejects an invalid baseURL", () => {
    expect(() =>
      GatewayConfigSchema.parse({ upstreams: [baseUpstream()], librechat: { baseURL: "not a url" } }),
    ).toThrow();
  });
});

describe("auth config", () => {
  test("rejects an empty auth block (requires token or tokenEnv)", () => {
    expect(() => GatewayConfigSchema.parse({ upstreams: [baseUpstream()], auth: {} })).toThrow(
      /auth requires either token or tokenEnv/,
    );
  });

  test("tokenEnv parses", () => {
    const cfg = GatewayConfigSchema.parse({ upstreams: [baseUpstream()], auth: { tokenEnv: "X" } });
    expect(cfg.auth).toEqual({ tokenEnv: "X" });
  });

  test("token with header and raw scheme parses", () => {
    const cfg = GatewayConfigSchema.parse({
      upstreams: [baseUpstream()],
      auth: { token: "t", header: "x-api-key", scheme: "raw" },
    });
    expect(cfg.auth).toEqual({ token: "t", header: "x-api-key", scheme: "raw" });
  });

  test("is optional", () => {
    expect(parse().auth).toBeUndefined();
  });
});

describe("rateLimit config", () => {
  test("requires rpm", () => {
    expect(() => parse({ rateLimit: {} })).toThrow();
  });

  test("rejects rpm that is zero, negative, or fractional", () => {
    expect(() => parse({ rateLimit: { rpm: 0 } })).toThrow();
    expect(() => parse({ rateLimit: { rpm: -1 } })).toThrow();
    expect(() => parse({ rateLimit: { rpm: 1.5 } })).toThrow();
  });

  test("burst is optional", () => {
    expect(parse({ rateLimit: { rpm: 10 } }).upstreams[0]!.rateLimit).toEqual({ rpm: 10 });
  });

  test("rejects an invalid burst", () => {
    expect(() => parse({ rateLimit: { rpm: 10, burst: 0 } })).toThrow();
    expect(() => parse({ rateLimit: { rpm: 10, burst: 2.5 } })).toThrow();
  });

  test("parses top-level and per-upstream", () => {
    const cfg = GatewayConfigSchema.parse({
      upstreams: [baseUpstream({ rateLimit: { rpm: 3, burst: 5 } })],
      rateLimit: { rpm: 100 },
    });
    expect(cfg.rateLimit).toEqual({ rpm: 100 });
    expect(cfg.upstreams[0]!.rateLimit).toEqual({ rpm: 3, burst: 5 });
  });

  test("is optional at both levels", () => {
    const cfg = parse();
    expect(cfg.rateLimit).toBeUndefined();
    expect(cfg.upstreams[0]!.rateLimit).toBeUndefined();
  });
});
