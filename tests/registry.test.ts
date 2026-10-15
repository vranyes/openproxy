import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ModelSchema,
  UpstreamSchema,
  type GatewayModel,
  type GatewayUpstream,
} from "../src/config";
import { buildIndex, type ModelsDevCatalog } from "../src/modelsdev";
import { createModelResolver, tokenConfigOf } from "../src/registry";
import type { Logger, LogEvent } from "../src/ops/log";

const COMPAT = "@opencode/ai/providers/openai-compatible";

const tiny = JSON.parse(readFileSync(new URL("./fixtures/modelsdev/tiny.json", import.meta.url), "utf8")) as ModelsDevCatalog;
const idx = buildIndex(tiny);

function captureLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { logger: (e) => events.push(e), events };
}

function upstream(overrides: Record<string, unknown> = {}, models: unknown[] = [{ id: "m" }]): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "u",
    package: COMPAT,
    baseURL: "http://up.test/v1",
    models,
    ...overrides,
  });
}

function model(id: string, overrides: Record<string, unknown> = {}): GatewayModel {
  return ModelSchema.parse({ id, ...overrides });
}

function resolverWith(): { resolve: ReturnType<typeof createModelResolver>["resolve"]; resolveDiscovered: ReturnType<typeof createModelResolver>["resolveDiscovered"]; events: LogEvent[]; candidates: ReturnType<typeof createModelResolver>["candidates"] } {
  const { logger, events } = captureLogger();
  const resolver = createModelResolver(() => idx, { logger });
  return { resolve: resolver.resolve, resolveDiscovered: resolver.resolveDiscovered, candidates: resolver.candidates, events };
}

// --- precedence --------------------------------------------------------------

describe("precedence explicit > models.dev > hint", () => {
  test("explicit context wins and is recorded as explicit", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" }), model("gpt-5-mini", { context: 111 }), 999);
    expect(r.model.context).toBe(111);
    expect(r.contextSource).toBe("explicit");
  });

  test("models.dev context wins over the hint", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" }), model("gpt-5-mini"), 999);
    expect(r.model.context).toBe(400000);
    expect(r.contextSource).toBe("modelsdev");
  });

  test("the hint is used only when models.dev has no context", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" }), model("gpt-5-nano"), 777);
    expect(r.model.context).toBe(777);
    expect(r.contextSource).toBe("discover");
    expect(r.modelsDev).toEqual({ provider: "openai", model: "gpt-5-nano" });
  });

  test("no explicit, no models.dev, no hint -> undefined/none", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "none", baseURL: "http://local.test/v1" }), model("unknown-xyz"));
    expect(r.model.context).toBeUndefined();
    expect(r.contextSource).toBe("none");
    expect(r.modelsDev).toBeNull();
  });
});

// --- no mutation -------------------------------------------------------------

describe("resolve never mutates the config model", () => {
  test("returns a fresh object and leaves context/maxOutput/upstream alone", () => {
    const { resolve } = resolverWith();
    const m = model("gpt-5-mini");
    const r = resolve(upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" }), m);
    expect(r.model).not.toBe(m);
    expect(m.context).toBeUndefined();
    expect(r.model.context).toBe(400000);
    // maxOutput and capabilities live on ResolvedModel only.
    expect("maxOutput" in r.model).toBe(false);
    expect("capabilities" in r.model).toBe(false);
  });
});

// --- sources -----------------------------------------------------------------

describe("idSource", () => {
  const base = { id: "opencode", apiKeyEnv: null };

  test("id+host agree resolves via the id provider", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ ...base, baseURL: "https://opencode.ai/inference/v1" }), model("qwen3-coder"));
    expect(r.modelsDev).toEqual({ provider: "opencode", model: "qwen3-coder" });
  });

  test("id host disagree falls through (warns) and resolves via host", () => {
    const { resolve, events } = resolverWith();
    const r = resolve(upstream({ ...base, baseURL: "https://api.z.ai/api/paas/v4" }), model("glm-4.6"));
    expect(r.modelsDev).toEqual({ provider: "zai", model: "glm-4.6" });
    expect(events.some((e) => String(e.msg).includes("id host does not match"))).toBe(true);
  });

  test("a provider with no api is dropped (does not resolve via the id)", () => {
    const { resolve } = resolverWith();
    const r = resolve(
      upstream({ id: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKeyEnv: null, package: COMPAT }),
      model("claude-sonnet-4-5"),
    );
    // anthropic + aihubmix both carry the exact key -> ambiguous -> unresolved.
    expect(r.modelsDev).toBeNull();
  });
});

describe("envSource", () => {
  test("an ambiguous env set (3 providers) falls through to unresolved", () => {
    const { resolve, events } = resolverWith();
    const r = resolve(upstream({ id: "myzai", baseURL: "http://local.test/v1", apiKeyEnv: "ZHIPU_API_KEY" }), model("glm-5.2"));
    expect(r.modelsDev).toBeNull();
    expect(events.some((e) => String(e.msg).includes("ambiguous"))).toBe(true);
  });

  test("a singleton env resolves", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "h", baseURL: "http://local.test/v1", apiKeyEnv: "AIHUBMIX_API_KEY" }), model("claude-sonnet-4-5"));
    expect(r.modelsDev).toEqual({ provider: "aihubmix", model: "claude-sonnet-4-5" });
    expect(r.model.context).toBe(1000000);
  });
});

describe("hostSource", () => {
  test("two providers share the host -> ambiguous -> unresolved", () => {
    const { resolve, events } = resolverWith();
    const r = resolve(upstream({ id: "myzen", baseURL: "https://opencode.ai/inference/v1", apiKeyEnv: null }), model("glm-5.2"));
    expect(r.modelsDev).toBeNull();
    expect(events.some((e) => String(e.msg).includes("ambiguous"))).toBe(true);
  });

  test("host intersection of one resolves", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "myzen", baseURL: "https://opencode.ai/inference/v1", apiKeyEnv: null }), model("qwen3-coder"));
    expect(r.modelsDev).toEqual({ provider: "opencode", model: "qwen3-coder" });
  });
});

describe("packageSource", () => {
  const local = { id: "notaprovider", baseURL: "http://local.test/v1", apiKeyEnv: null };

  test("openai/responses maps to openai (even when the key is globally ambiguous)", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ ...local, package: "@opencode/ai/providers/openai/responses" }), model("gpt-5-mini"));
    expect(r.modelsDev).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  test("anthropic maps to anthropic", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ ...local, package: "@opencode/ai/providers/anthropic" }), model("claude-sonnet-4-5"));
    expect(r.modelsDev).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  test("openai-compatible maps to nothing (no arbitrary pick)", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ ...local, package: COMPAT }), model("gpt-5-mini"));
    expect(r.modelsDev).toBeNull();
  });
});

describe("global unique exact key", () => {
  test("resolves a key present in exactly one provider", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "x", baseURL: "http://local.test/v1", apiKeyEnv: null }), model("anthropic/claude-fable-5"));
    expect(r.modelsDev).toEqual({ provider: "deepinfra", model: "anthropic/claude-fable-5" });
    expect(r.model.context).toBe(1000000);
  });
});

describe("ambiguity", () => {
  test("globally ambiguous key stays unresolved and warns once", () => {
    const { resolve, events } = resolverWith();
    const u = upstream({ id: "x", baseURL: "http://local.test/v1", apiKeyEnv: null });
    expect(resolve(u, model("glm-5.2")).modelsDev).toBeNull();
    expect(resolve(u, model("glm-5.2")).modelsDev).toBeNull();
    const warns = events.filter((e) => String(e.msg).includes("ambiguous"));
    expect(warns).toHaveLength(1);
  });

  test("warn-once is bounded (cap 256): the oldest key may warn again", () => {
    const { resolve, events } = resolverWith();
    const upstreams = Array.from({ length: 300 }, (_, i) =>
      upstream({ id: `u${i}`, baseURL: "http://local.test/v1", apiKeyEnv: null }),
    );
    const m = model("glm-5.2");
    for (const u of upstreams) resolve(u, m);
    const after = events.length;
    expect(after).toBe(300);
    resolve(upstreams[0]!, m); // key u0 was evicted by the cap -> warns again
    expect(events.length).toBe(301);
  });
});

// --- explicit provider -------------------------------------------------------

describe("explicit provider is authoritative", () => {
  test("a match resolves to that provider", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "x", baseURL: "http://local.test/v1" }), model("glm-5.2", { modelsDev: { provider: "zai" } }));
    expect(r.modelsDev).toEqual({ provider: "zai", model: "glm-5.2" });
  });

  test("a miss leaves it unresolved with no fallback inference", () => {
    const { resolve, events } = resolverWith();
    // zai has no claude-sonnet-4-5; do NOT fall back to anthropic/aihubmix.
    const r = resolve(upstream({ id: "x", baseURL: "http://local.test/v1" }), model("claude-sonnet-4-5", { modelsDev: { provider: "zai" } }));
    expect(r.modelsDev).toBeNull();
    expect(r.model.context).toBeUndefined();
    expect(events.some((e) => String(e.msg).includes("explicit modelsDev provider did not match"))).toBe(true);
  });

  test("an unknown explicit provider is a miss", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "x", baseURL: "http://local.test/v1" }), model("gpt-5-mini", { modelsDev: { provider: "nope" } }));
    expect(r.modelsDev).toBeNull();
  });

  test("an explicit model key is honored", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "x", baseURL: "http://local.test/v1" }), model("whatever", { modelsDev: { provider: "openai", model: "gpt-5-mini" } }));
    expect(r.modelsDev).toEqual({ provider: "openai", model: "gpt-5-mini" });
    expect(r.model.context).toBe(400000);
  });
});

// --- maxOutput ---------------------------------------------------------------

describe("maxOutput", () => {
  const anthropic = () => upstream({ id: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKeyEnv: null, package: "@opencode/ai/providers/anthropic" });

  test("resolved from models.dev when absent explicitly", () => {
    const { resolve } = resolverWith();
    const r = resolve(anthropic(), model("claude-sonnet-4-5"));
    expect(r.maxOutput).toBe(64000);
    expect(r.maxOutputSource).toBe("modelsdev");
  });

  test("an explicit maxOutput wins", () => {
    const { resolve } = resolverWith();
    const r = resolve(anthropic(), model("claude-sonnet-4-5", { maxOutput: 1000 }));
    expect(r.maxOutput).toBe(1000);
    expect(r.maxOutputSource).toBe("explicit");
  });

  test("dropped when it exceeds the resolved context", () => {
    const { resolve } = resolverWith();
    const r = resolve(anthropic(), model("claude-sonnet-4-5", { context: 50000 }));
    expect(r.model.context).toBe(50000);
    expect(r.maxOutput).toBeUndefined();
    expect(r.maxOutputSource).toBe("none");
  });
});

// --- capabilities ------------------------------------------------------------

describe("capabilities", () => {
  test("vision/tools come from models.dev", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" }), model("gpt-5-mini"));
    expect(r.capabilities).toEqual({ vision: true, tools: true });
  });

  test("explicit overrides win", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" }), model("gpt-5-mini", { supportsVision: false }));
    expect(r.capabilities.vision).toBe(false);
    expect(r.capabilities.tools).toBe(true);
  });
});

// --- cost --------------------------------------------------------------------

describe("cost", () => {
  const openai = () => upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" });

  test("resolved from models.dev when absent explicitly", () => {
    const { resolve } = resolverWith();
    const r = resolve(openai(), model("gpt-5-mini"));
    expect(r.cost).toEqual({ input: 0.25, output: 2, cacheRead: 0.025 });
    expect(r.costSource).toBe("modelsdev");
  });

  test("an explicit cost wins", () => {
    const { resolve } = resolverWith();
    const r = resolve(openai(), model("gpt-5-mini", { cost: { input: 1, output: 3 } }));
    expect(r.cost).toEqual({ input: 1, output: 3 });
    expect(r.costSource).toBe("explicit");
  });

  test("absent everywhere is null/none", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "none", baseURL: "http://local.test/v1" }), model("unknown-xyz"));
    expect(r.cost).toBeNull();
    expect(r.costSource).toBe("none");
  });

  test("an explicit cost survives even when models.dev is disabled", () => {
    const { resolve } = resolverWith();
    const r = resolve(openai(), model("gpt-5-mini", { modelsDev: false, cost: { input: 1 } }));
    expect(r.cost).toEqual({ input: 1 });
    expect(r.costSource).toBe("explicit");
  });
});

// --- disable -----------------------------------------------------------------

describe("modelsDev:false disables resolution", () => {
  test("per-model false", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" }), model("gpt-5-mini", { modelsDev: false }));
    expect(r.modelsDev).toBeNull();
    expect(r.model.context).toBeUndefined();
  });

  test("per-upstream false", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", baseURL: "https://api.openai.com/v1", package: "@opencode/ai/providers/openai/responses", modelsDev: false }), model("gpt-5-mini"));
    expect(r.modelsDev).toBeNull();
  });

  test("an explicit context still survives when disabled", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "openai", baseURL: "https://api.openai.com/v1" }), model("gpt-5-mini", { context: 42, modelsDev: false }));
    expect(r.model.context).toBe(42);
    expect(r.contextSource).toBe("explicit");
  });
});

// --- suffix ------------------------------------------------------------------

describe("suffix matching", () => {
  test("unique suffix resolves", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "x", baseURL: "http://local.test/v1" }), model("claude-fable-5", { modelsDev: { provider: "deepinfra" } }));
    expect(r.modelsDev).toEqual({ provider: "deepinfra", model: "anthropic/claude-fable-5" });
  });

  test("ambiguous suffix (nano-gpt glm-5.2) resolves to null", () => {
    const { resolve } = resolverWith();
    const r = resolve(upstream({ id: "x", baseURL: "http://local.test/v1" }), model("glm-5.2", { modelsDev: { provider: "nano-gpt" } }));
    expect(r.modelsDev).toBeNull();
  });
});

// --- resolveDiscovered + candidates + tokenConfigOf --------------------------

describe("resolveDiscovered", () => {
  test("models.dev wins over the discovery hint", () => {
    const { resolveDiscovered } = resolverWith();
    const out = resolveDiscovered(upstream({ id: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKeyEnv: null, package: "@opencode/ai/providers/anthropic" }), "claude-sonnet-4-5", 12345);
    expect(out.context).toBe(200000);
    expect(out.contextSource).toBe("modelsdev");
    expect(out.modelsDev).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  test("the hint is used when models.dev cannot resolve", () => {
    const { resolveDiscovered } = resolverWith();
    const out = resolveDiscovered(upstream({ id: "x", baseURL: "http://local.test/v1", apiKeyEnv: null }), "totally-unknown", 4096);
    expect(out.context).toBe(4096);
    expect(out.contextSource).toBe("discover");
    expect(out.modelsDev).toBeNull();
  });

  test("unresolved with no hint is null", () => {
    const { resolveDiscovered } = resolverWith();
    const out = resolveDiscovered(upstream({ id: "x", baseURL: "http://local.test/v1", apiKeyEnv: null }), "totally-unknown");
    expect(out.context).toBeNull();
    expect(out.contextSource).toBe("none");
  });
});

describe("candidates", () => {
  test("returns the non-empty key set (ref model, upstream, id)", () => {
    const { candidates } = resolverWith();
    const keys = candidates(upstream({ id: "u" }), model("id", { upstream: "up", modelsDev: { provider: "zai", model: "ref" } }));
    expect(keys).toEqual(["ref", "up", "id"]);
  });
});

describe("tokenConfigOf", () => {
  test("keeps only defined contexts and is last-write-wins", () => {
    const { resolve } = resolverWith();
    const u = upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" });
    const a = resolve(u, model("gpt-5-mini"));
    const b = resolve(u, model("gpt-5-mini", { context: 10 })); // same id, later
    const c = resolve(u, model("gpt-5-nano", { modelsDev: false })); // no context -> omitted
    expect(tokenConfigOf([a, b, c])).toEqual({ "gpt-5-mini": { context: 10 } });
  });
});
