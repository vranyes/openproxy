import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { LanguageModel, LLMEvent, LLMResponse } from "@opencode/ai";
import { AIError as AIErrorCtor, InvalidRequestError } from "@opencode/ai";
import { createApp } from "../src/server";
import type { GatewayConfig } from "../src/config";
import { buildIndex, type ModelsDevCatalog } from "../src/modelsdev";
import { FRAGMENT_CONTENT_TYPE } from "../src/librechat";
import type { AiRuntime } from "../src/adapter/ai";
import { json, stubUpstream, type ModelsResponse, type ModelEntry } from "./helpers";

const tiny = JSON.parse(readFileSync(new URL("./fixtures/modelsdev/tiny.json", import.meta.url), "utf8")) as ModelsDevCatalog;
const index = buildIndex(tiny);
const modelsdev = () => index;
const noFetch = stubUpstream(() => new Response("nope", { status: 500 }));

const openaiConfig: GatewayConfig = {
  upstreams: [
    {
      id: "openai",
      package: "@opencode/ai/providers/openai/responses",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: null,
      models: [{ id: "gpt-5-mini" }],
    },
  ],
};

describe("GET /v1/models with models.dev", () => {
  test("resolves a context for a model with no YAML context", async () => {
    const app = createApp(openaiConfig, { fetchUpstream: noFetch, modelsdev });
    const body = await json<ModelsResponse>(await app.fetch(new Request("http://gateway/v1/models")));
    expect(body.data).toEqual([
      { id: "gpt-5-mini", object: "model", owned_by: "openai", context_length: 400000 },
    ]);
  });

  test("without models.dev the same model stays null (baseline unchanged)", async () => {
    const app = createApp(openaiConfig, { fetchUpstream: noFetch });
    const body = await json<ModelsResponse>(await app.fetch(new Request("http://gateway/v1/models")));
    expect(body.data[0]!.context_length).toBeNull();
  });
});

describe("GET /v1/models discovery + models.dev precedence", () => {
  const discoverConfig: GatewayConfig = {
    upstreams: [
      {
        id: "local",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "http://upstream.test/v1",
        apiKeyEnv: null,
        discover: true,
        models: [{ id: "placeholder" }],
      },
    ],
  };

  test("models.dev beats a discovery hint; a hint fills an unresolved id; no hint -> null", async () => {
    const app = createApp(discoverConfig, {
      modelsdev,
      fetchUpstream: stubUpstream((req) => {
        if (req.url === "http://upstream.test/v1/models") {
          return Response.json({
            object: "list",
            data: [
              { id: "anthropic/claude-fable-5", context_length: 5 },
              { id: "mystery-hinted", context_length: 2048 },
              { id: "mystery-plain" },
            ],
          });
        }
        return new Response("nope", { status: 500 });
      }),
    });
    const body = await json<ModelsResponse>(await app.fetch(new Request("http://gateway/v1/models")));
    const byId = Object.fromEntries(body.data.map((m) => [m.id, m] as [string, ModelEntry]));
    expect(byId["placeholder"]!.context_length).toBeNull();
    expect(byId["anthropic/claude-fable-5"]!.context_length).toBe(1000000);
    expect(byId["mystery-hinted"]!.context_length).toBe(2048);
    expect(byId["mystery-plain"]!.context_length).toBeNull();
  });

  test("an invalid non-integer hint is ignored", async () => {
    const app = createApp(discoverConfig, {
      modelsdev,
      fetchUpstream: stubUpstream(() =>
        Response.json({ object: "list", data: [{ id: "mystery-x", context_length: 1.5 }] }),
      ),
    });
    const body = await json<ModelsResponse>(await app.fetch(new Request("http://gateway/v1/models")));
    expect(body.data.find((m) => m.id === "mystery-x")!.context_length).toBeNull();
  });
});

describe("GET /librechat/tokenConfig with models.dev", () => {
  test("includes models.dev-resolved contexts", async () => {
    const app = createApp(openaiConfig, { fetchUpstream: noFetch, modelsdev });
    const res = await app.fetch(new Request("http://gateway/librechat/tokenConfig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "gpt-5-mini": { context: 400000 } });
  });
});

describe("GET /librechat.yaml.fragment", () => {
  const fragmentConfig: GatewayConfig = {
    upstreams: [
      ...openaiConfig.upstreams,
      {
        id: "local",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "http://local.test/v1",
        apiKeyEnv: null,
        models: [{ id: "mystery", modelsDev: false }],
      },
    ],
  };

  test("returns a parseable LibreChat stanza with resolved contexts", async () => {
    const app = createApp(fragmentConfig, { fetchUpstream: noFetch, modelsdev });
    const res = await app.fetch(new Request("http://gateway/librechat.yaml.fragment"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(FRAGMENT_CONTENT_TYPE);
    const doc = parseYaml(await res.text()) as {
      endpoints: { custom: Array<Record<string, unknown>> };
    };
    const entry = doc.endpoints.custom[0]!;
    expect(entry.name).toBe("openproxy");
    expect(entry.baseURL).toBe("http://gateway/v1");
    expect(entry.apiKey).toBe("dummy");
    expect(entry.titleConvo).toBe(true);
    expect(entry.titleModel).toBe("current_model");
    expect(entry.modelDisplayLabel).toBe("openproxy");
    expect(entry.models).toEqual({ default: ["gpt-5-mini", "mystery"], fetch: true });
    expect(entry.tokenConfig).toEqual({ "gpt-5-mini": { context: 400000 } });
  });

  test("librechat config overrides name/baseURL/apiKey", async () => {
    const cfg: GatewayConfig = {
      ...openaiConfig,
      librechat: { name: "zen-gw", baseURL: "https://zen.example/v1", apiKey: "s3cret" },
    };
    const app = createApp(cfg, { fetchUpstream: noFetch, modelsdev });
    const doc = parseYaml(await (await app.fetch(new Request("http://gateway/librechat.yaml.fragment"))).text()) as {
      endpoints: { custom: Array<Record<string, unknown>> };
    };
    const entry = doc.endpoints.custom[0]!;
    expect(entry.name).toBe("zen-gw");
    expect(entry.baseURL).toBe("https://zen.example/v1");
    expect(entry.apiKey).toBe("s3cret");
  });
});

describe("chat path uses the resolved context", () => {
  const chatConfig: GatewayConfig = {
    upstreams: [
      {
        id: "openai",
        package: "@opencode/ai/providers/openai/responses",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: null,
        adapter: "opencode",
        models: [{ id: "gpt-5-mini" }],
      },
    ],
  };

  function overflowRuntime(): AiRuntime {
    const overflow = () =>
      new AIErrorCtor({ reason: new InvalidRequestError({ message: "too long", classification: "context-overflow" }) });
    return {
      model: () => ({}) as unknown as LanguageModel,
      generate: async (): Promise<LLMResponse> => {
        throw overflow();
      },
      stream: (): AsyncIterable<LLMEvent> => {
        throw overflow();
      },
    };
  }

  test("a models.dev-only context surfaces as max_context in the F3 overflow 400", async () => {
    const app = createApp(chatConfig, { ai: overflowRuntime(), modelsdev, fetchUpstream: noFetch });
    const res = await app.fetch(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code?: string }; max_context?: number };
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.max_context).toBe(400000);
  });

  test("handling a request never mutates the config model", async () => {
    const app = createApp(chatConfig, { ai: overflowRuntime(), modelsdev, fetchUpstream: noFetch });
    await app.fetch(new Request("http://gateway/v1/models"));
    await app.fetch(new Request("http://gateway/librechat/tokenConfig"));
    const m = chatConfig.upstreams[0]!.models[0]!;
    expect(m).toEqual({ id: "gpt-5-mini" });
    expect(m.context).toBeUndefined();
  });
});
