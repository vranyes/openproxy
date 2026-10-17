import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { UpstreamSchema, type GatewayConfig, type GatewayModel } from "../src/config";
import { buildIndex, type ModelsDevCatalog } from "../src/modelsdev";
import { createModelResolver } from "../src/registry";
import { createApp } from "../src/server";
import type { Logger, LogEvent } from "../src/ops/log";
import { json, type ModelsResponse } from "./helpers";
import { gatewayChatRequest, responsesTextStream, sseResponse, withUpstream } from "./fake-providers";

const COMPAT = "@opencode/ai/providers/openai-compatible";
const RESPONSES = "@opencode/ai/providers/openai-compatible/responses";

const tiny = JSON.parse(readFileSync(new URL("./fixtures/modelsdev/tiny.json", import.meta.url), "utf8")) as ModelsDevCatalog;
const idx = buildIndex(tiny);

function captureLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { logger: (e) => events.push(e), events };
}

// An upstream that omits package + baseURL entirely (F11): both come from models.dev.
function derivedUpstream(overrides: Record<string, unknown> = {}): ReturnType<typeof UpstreamSchema.parse> {
  return UpstreamSchema.parse({
    id: "opencode-go",
    trustedHosts: ["opencode.ai"],
    models: [{ id: "glm-5.2" }],
    ...overrides,
  });
}

describe("registry derives dialect + baseURL from models.dev (F11)", () => {
  test("provider defaults fill the omitted package and baseURL", () => {
    const { logger } = captureLogger();
    const resolve = createModelResolver(() => idx, { logger }).resolve;
    const r = resolve(derivedUpstream(), { id: "glm-5.2" } as GatewayModel);
    expect(r.package).toBe(COMPAT);
    expect(r.packageSource).toBe("modelsdev");
    expect(r.baseURL).toBe("https://opencode.ai/inference/go/v1");
    expect(r.baseURLSource).toBe("modelsdev");
    expect(r.model.context).toBe(1000000);
  });

  test("a per-model provider override flips the dialect to Responses", () => {
    const { logger } = captureLogger();
    const resolve = createModelResolver(() => idx, { logger }).resolve;
    const r = resolve(derivedUpstream(), { id: "muse-spark-1.3-contributor" } as GatewayModel);
    expect(r.package).toBe(RESPONSES);
    expect(r.baseURL).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(r.model.context).toBe(1048576);
  });

  test("an unsupported npm (google) resolves the baseURL but no package", () => {
    const { logger } = captureLogger();
    const resolve = createModelResolver(() => idx, { logger }).resolve;
    const r = resolve(derivedUpstream(), { id: "gemini-4-argon-contributor" } as GatewayModel);
    expect(r.package).toBeUndefined();
    expect(r.packageSource).toBe("none");
    expect(r.baseURL).toBe("https://opencode.ai/inference/go/google/v1beta");
    expect(r.baseURLSource).toBe("modelsdev");
  });

  test("a derived baseURL whose host is not trusted is rejected and warns", () => {
    const { logger, events } = captureLogger();
    const resolve = createModelResolver(() => idx, { logger }).resolve;
    const r = resolve(derivedUpstream({ trustedHosts: ["example.com"] }), { id: "glm-5.2" } as GatewayModel);
    expect(r.baseURL).toBeUndefined();
    expect(r.baseURLSource).toBe("none");
    expect(r.package).toBe(COMPAT); // dialect needs no host, so it still derives
    expect(events.some((e) => String(e.msg).includes("trustedHosts"))).toBe(true);
  });

  test("explicit package + baseURL always win", () => {
    const { logger } = captureLogger();
    const resolve = createModelResolver(() => idx, { logger }).resolve;
    const r = resolve(
      derivedUpstream({ package: "@opencode/ai/providers/anthropic", baseURL: "https://explicit.test/v1" }),
      { id: "glm-5.2" } as GatewayModel,
    );
    expect(r.package).toBe("@opencode/ai/providers/anthropic");
    expect(r.packageSource).toBe("explicit");
    expect(r.baseURL).toBe("https://explicit.test/v1");
    expect(r.baseURLSource).toBe("explicit");
  });

  test("modelsDev:false leaves the omitted dialect unresolved", () => {
    const { logger } = captureLogger();
    const resolve = createModelResolver(() => idx, { logger }).resolve;
    const r = resolve(derivedUpstream({ modelsDev: false }), { id: "glm-5.2" } as GatewayModel);
    expect(r.package).toBeUndefined();
    expect(r.baseURL).toBeUndefined();
  });

  test("a model-level override wins over the upstream and models.dev", () => {
    const { logger } = captureLogger();
    const resolve = createModelResolver(() => idx, { logger }).resolve;
    const r = resolve(derivedUpstream(), {
      id: "glm-5.2",
      package: "@opencode/ai/providers/anthropic",
      baseURL: "https://pinned.test/v1",
    } as GatewayModel);
    expect(r.package).toBe("@opencode/ai/providers/anthropic");
    expect(r.baseURL).toBe("https://pinned.test/v1");
    expect(r.packageSource).toBe("explicit");
    expect(r.baseURLSource).toBe("explicit");
  });
});

// --- end-to-end routing -------------------------------------------------------

// Build a models.dev catalog whose provider + per-model transport point at the
// fake upstream, so an upstream that omits package/baseURL is routed there.
function catalogFor(baseURL: string): ModelsDevCatalog {
  return {
    "opencode-go": {
      id: "opencode-go",
      npm: "@ai-sdk/openai-compatible",
      api: baseURL,
      models: {
        "muse-spark-1.3-contributor": {
          id: "muse-spark-1.3-contributor",
          limit: { context: 1000000, output: 131072 },
          provider: { npm: "@ai-sdk/openai", api: baseURL },
        },
      },
    },
  };
}

describe("derived routing end to end", () => {
  test("a model on a package/baseURL-less upstream routes on the derived Responses dialect", async () => {
    const seen: { path: string | null } = { path: null };
    await withUpstream(
      (req) => {
        seen.path = new URL(req.url).pathname;
        return sseResponse(responsesTextStream("Hello"));
      },
      async (baseURL) => {
        const app = createApp(
          {
            upstreams: [
              {
                id: "opencode-go",
                apiKeyEnv: null,
                adapter: "opencode",
                trustedHosts: ["127.0.0.1"],
                models: [{ id: "muse-spark-1.3-contributor" }],
              },
            ],
          } as GatewayConfig,
          { modelsdev: () => buildIndex(catalogFor(baseURL)) },
        );
        const res = await app.fetch(gatewayChatRequest("muse-spark-1.3-contributor"));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { object: string; choices: Array<{ message: unknown }> };
        expect(body.object).toBe("chat.completion");
        expect(body.choices[0]!.message).toEqual({ role: "assistant", content: "Hello" });
      },
    );
    expect(seen.path).toBe("/v1/responses");
  });

  test("an untrusted derived host leaves the model unroutable (404) and unlisted", async () => {
    await withUpstream(
      () => sseResponse(responsesTextStream("nope")),
      async (baseURL) => {
        const app = createApp(
          {
            upstreams: [
              {
                id: "opencode-go",
                apiKeyEnv: null,
                adapter: "opencode",
                trustedHosts: ["example.com"], // baseURL host (127.0.0.1) not trusted
                models: [{ id: "muse-spark-1.3-contributor" }],
              },
            ],
          } as GatewayConfig,
          { modelsdev: () => buildIndex(catalogFor(baseURL)) },
        );
        const chat = await app.fetch(gatewayChatRequest("muse-spark-1.3-contributor"));
        expect(chat.status).toBe(404);
        const models = await json<ModelsResponse>(await app.fetch(new Request("http://gateway/v1/models")));
        expect(models.data).toEqual([]);
      },
    );
  });
});
