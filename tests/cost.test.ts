import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Usage } from "@opencode/ai";
import { ModelSchema, UpstreamSchema, type GatewayConfig, type GatewayModel, type GatewayUpstream } from "../src/config";
import { costUsd, type ModelCost, type UsageBilling } from "../src/cost";
import { buildIndex, type ModelsDevCatalog } from "../src/modelsdev";
import { createModelResolver } from "../src/registry";
import { metaOf } from "../src/adapter/translate";
import type { LogEvent } from "../src/ops/log";
import { createApp } from "../src/server";
import { chatTextStream, gatewayChatRequest, sseResponse } from "./fake-providers";
import { fakeUpstreamServer, stubUpstream } from "./helpers";

const COMPAT = "@opencode/ai/providers/openai-compatible";

const tiny = JSON.parse(readFileSync(new URL("./fixtures/modelsdev/tiny.json", import.meta.url), "utf8")) as ModelsDevCatalog;
const idx = buildIndex(tiny);

// ---------------------------------------------------------------------------
// costUsd unit
// ---------------------------------------------------------------------------

function billing(over: Partial<UsageBilling> = {}): UsageBilling {
  return {
    nonCachedInputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    ...over,
  };
}

const PRICING: ModelCost = { input: 0.25, output: 2, cacheRead: 0.025 };

describe("costUsd", () => {
  test("sums non-cached input and output at their prices", () => {
    expect(costUsd(billing({ nonCachedInputTokens: 1_000_000, outputTokens: 1_000_000 }), PRICING)).toBe(2.25);
  });

  test("a cache-read-only request uses the cache price", () => {
    expect(costUsd(billing({ nonCachedInputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 }), PRICING)).toBe(0.025);
  });

  test("cacheRead falls back to the input price when absent", () => {
    const cost = { input: 0.25, output: 2 };
    expect(costUsd(billing({ nonCachedInputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 }), cost)).toBe(0.25);
  });

  test("a billed category with no resolvable price is null", () => {
    // output tokens but no `output` price.
    expect(costUsd(billing({ nonCachedInputTokens: 1_000_000, outputTokens: 5 }), { input: 0.25 })).toBeNull();
  });

  test("null when both input and output prices are absent", () => {
    expect(costUsd(billing({ cacheReadTokens: 1_000_000 }), { cacheRead: 0.025 })).toBeNull();
    expect(costUsd(billing({ nonCachedInputTokens: 1_000_000 }), null)).toBeNull();
    expect(costUsd(billing({ nonCachedInputTokens: 1_000_000 }), undefined)).toBeNull();
  });

  test("no price for a zero-token category is not an error", () => {
    expect(costUsd(billing({ nonCachedInputTokens: 1_000_000, outputTokens: 0 }), { input: 0.25 })).toBe(0.25);
  });

  test("null token counts contribute nothing", () => {
    expect(costUsd(billing({ nonCachedInputTokens: 1_000_000, outputTokens: null }), PRICING)).toBe(0.25);
  });

  test("rounds to 6 decimal places", () => {
    // 3_000_000 * 0.1 / 1e6 has float noise (0.30000000000000004) before rounding.
    expect(costUsd(billing({ nonCachedInputTokens: 3_000_000 }), { input: 0.1 })).toBe(0.3);
  });

  test("null (unknown) when no token category was reported at all", () => {
    // Pricing is known, but usage is entirely absent: cost is unknown, not zero.
    expect(costUsd(billing(), PRICING)).toBeNull();
    // A reported usage of zero tokens is still free (0), not unknown.
    expect(
      costUsd(billing({ nonCachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), PRICING),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolver: cost from models.dev / explicit / none
// ---------------------------------------------------------------------------

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

describe("resolver cost", () => {
  const openai = () =>
    upstream({ id: "openai", package: "@opencode/ai/providers/openai/responses", baseURL: "https://api.openai.com/v1" });

  test("models.dev pricing is surfaced with costSource modelsdev", () => {
    const r = createModelResolver(() => idx).resolve(openai(), model("gpt-5-mini"));
    expect(r.cost).toEqual({ input: 0.25, output: 2, cacheRead: 0.025 });
    expect(r.costSource).toBe("modelsdev");
  });

  test("an explicit cost wins over models.dev", () => {
    const r = createModelResolver(() => idx).resolve(openai(), model("gpt-5-mini", { cost: { input: 1, output: 3 } }));
    expect(r.cost).toEqual({ input: 1, output: 3 });
    expect(r.costSource).toBe("explicit");
  });

  test("unresolved is cost:null and costSource none", () => {
    const r = createModelResolver(() => idx).resolve(upstream({ id: "none", baseURL: "http://local.test/v1" }), model("unknown-xyz"));
    expect(r.cost).toBeNull();
    expect(r.costSource).toBe("none");
  });

  test("modelsDev:false disables models.dev pricing", () => {
    const r = createModelResolver(() => idx).resolve(openai(), model("gpt-5-mini", { modelsDev: false }));
    expect(r.cost).toBeNull();
    expect(r.costSource).toBe("none");
  });

  test("cost is not injected into the effective GatewayModel", () => {
    const r = createModelResolver(() => idx).resolve(openai(), model("gpt-5-mini"));
    expect("cost" in r.model).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// metaOf: usage shape + cost_usd
// ---------------------------------------------------------------------------

const costModel: GatewayModel = { id: "m" };

describe("metaOf cost", () => {
  test("computes cost_usd from input/output/cache usage", () => {
    const meta = metaOf(
      {
        usage: {
          contextTokens: 1_000_000,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000,
          nonCachedInputTokens: 1_000_000,
        } as Usage,
      },
      costModel,
      PRICING,
    );
    expect(meta.costUsd).toBe(2.25);
    expect(meta.usage).toEqual({ tokensIn: 1_000_000, tokensOut: 1_000_000, tokensTotal: 2_000_000 });
  });

  test("cache tokens are attached to usage and billed at the cache price", () => {
    const meta = metaOf(
      {
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          nonCachedInputTokens: 0,
          cacheReadInputTokens: 1_000_000,
        } as Usage,
      },
      costModel,
      PRICING,
    );
    expect(meta.usage).toEqual({
      tokensIn: 1_000_000,
      tokensOut: 0,
      tokensTotal: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(meta.costUsd).toBe(0.025);
  });

  test("billed input is derived by subtracting cache from the inclusive input", () => {
    const meta = metaOf(
      {
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 250_000,
          cacheWriteInputTokens: 250_000,
        } as Usage,
      },
      costModel,
      { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.05 },
    );
    // 500k*0.25 + 250k*0.025 + 250k*0.05 = 143750 -> /1e6
    expect(meta.costUsd).toBe(0.14375);
  });

  test("no cost passed yields cost_usd null", () => {
    const meta = metaOf({ usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 } as Usage }, costModel);
    expect(meta.costUsd).toBeNull();
  });

  test("unknown pricing (missing output price) yields cost_usd null", () => {
    const meta = metaOf({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as Usage }, costModel, { input: 0.25 });
    expect(meta.costUsd).toBeNull();
  });

  test("a source lacking cache tokens keeps the exact three-field usage shape", () => {
    const meta = metaOf({ usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 } as Usage }, costModel, PRICING);
    expect(meta.usage).toEqual({ tokensIn: 25, tokensOut: 5, tokensTotal: 30 });
  });
});

// ---------------------------------------------------------------------------
// integration: generation event cost_usd
// ---------------------------------------------------------------------------

function adapterConfig(baseURL: string, withModelsDev = true): GatewayConfig {
  const model: Record<string, unknown> = { id: "gw-model", upstream: "up-model", context: 1000 };
  if (withModelsDev) model.modelsDev = { provider: "openai", model: "gpt-5-mini" };
  return {
    upstreams: [
      UpstreamSchema.parse({
        id: "local",
        package: COMPAT,
        baseURL,
        apiKeyEnv: null,
        adapter: "openai-compatible",
        models: [model],
      }),
    ],
  };
}

describe("generation event cost_usd", () => {
  test("is populated from models.dev pricing when the index resolves", async () => {
    const events: LogEvent[] = [];
    const up = fakeUpstreamServer(() => sseResponse(chatTextStream("Hi", [1_000_000, 1_000_000, 2_000_000])));
    try {
      const app = createApp(adapterConfig(up.url), { logger: (e) => events.push(e), modelsdev: () => idx });
      const res = await app.fetch(gatewayChatRequest("gw-model"));
      expect(res.status).toBe(200);
      await Bun.sleep(0);
      const generation = events.find((e) => e.msg === "generation");
      expect(generation).toBeDefined();
      // non-cached input 1e6 * 0.25 + output 1e6 * 2 = 2.25 USD
      expect(generation!.cost_usd).toBe(2.25);
    } finally {
      up.stop();
    }
  });

  test("is null when no pricing is known", async () => {
    const events: LogEvent[] = [];
    const up = fakeUpstreamServer(() => sseResponse(chatTextStream("Hi", [5, 2, 7])));
    try {
      const app = createApp(adapterConfig(up.url, false), { logger: (e) => events.push(e) });
      const res = await app.fetch(gatewayChatRequest("gw-model"));
      expect(res.status).toBe(200);
      await Bun.sleep(0);
      const generation = events.find((e) => e.msg === "generation");
      expect(generation).toBeDefined();
      expect(generation!.cost_usd).toBeNull();
    } finally {
      up.stop();
    }
  });

  test("the passthrough path still emits no generation event", async () => {
    const events: LogEvent[] = [];
    const config: GatewayConfig = {
      upstreams: [
        UpstreamSchema.parse({
          id: "local",
          package: COMPAT,
          baseURL: "http://upstream.test/v1",
          models: [{ id: "gw-model", context: 1000 }],
        }),
      ],
    };
    const app = createApp(config, {
      fetchUpstream: stubUpstream(() => Response.json({ object: "chat.completion", choices: [] })),
      logger: (e) => events.push(e),
    });
    const res = await app.fetch(gatewayChatRequest("gw-model"));
    expect(res.status).toBe(200);
    await Bun.sleep(0);
    expect(events.filter((e) => e.msg === "request")).toHaveLength(1);
    expect(events.filter((e) => e.msg === "generation")).toHaveLength(0);
  });
});
