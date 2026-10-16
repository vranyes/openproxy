import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server";
import type { GatewayConfig } from "../src/config";
import { buildIndex, type ModelsDevCatalog } from "../src/modelsdev";
import { json, stubUpstream, type ModelsResponse, type ModelEntry } from "./helpers";

const tiny = JSON.parse(
  readFileSync(new URL("./fixtures/modelsdev/tiny.json", import.meta.url), "utf8"),
) as ModelsDevCatalog;
const index = buildIndex(tiny);
const modelsdev = () => index;

// Mirrors OpenCode Go: the model list lives at `.../go/v1/models`, while the
// chat baseURL is `.../go/openai/v1` (whose `/models` returns 404). models.dev
// resolves `glm-5.2` for the `opencode-go` provider (host matches the baseURL).
const DISCOVER_URL = "https://opencode.ai/inference/go/v1/models";
const CHAT_BASE = "https://opencode.ai/inference/go/openai/v1";

function goConfig(overrides: Partial<GatewayConfig["upstreams"][number]> = {}): GatewayConfig {
  return {
    upstreams: [
      {
        id: "opencode-go",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: CHAT_BASE,
        apiKeyEnv: null,
        discover: true,
        models: [{ id: "placeholder" }],
        ...overrides,
      },
    ],
  };
}

describe("GET /v1/models discoverUrl", () => {
  test("fetches discoverUrl; a resolved discovery row appears, a contextless one is omitted", async () => {
    const seen: string[] = [];
    const app = createApp(goConfig({ discoverUrl: DISCOVER_URL }), {
      modelsdev,
      fetchUpstream: stubUpstream((req) => {
        seen.push(req.url);
        return Response.json({
          object: "list",
          data: [
            { id: "glm-5.2", object: "model", owned_by: "opencode" },
            { id: "mystery-plain", object: "model", owned_by: "opencode" },
          ],
        });
      }),
    });
    const body = await json<ModelsResponse>(await app.fetch(new Request("http://gateway/v1/models")));
    expect(seen).toEqual([DISCOVER_URL]);
    const byId = Object.fromEntries(body.data.map((m) => [m.id, m] as [string, ModelEntry]));
    expect(byId["placeholder"]).toBeUndefined(); // registry row with no context -> omitted
    expect(byId["glm-5.2"]!.context_length).toBe(1000000);
    expect(byId["glm-5.2"]!.pricing).toEqual({ prompt: "0", completion: "0" });
    expect(byId["mystery-plain"]).toBeUndefined(); // no context to resolve -> omitted
  });

  test("without discoverUrl the fetch still targets <baseURL>/models", async () => {
    const seen: string[] = [];
    const app = createApp(goConfig(), {
      modelsdev,
      fetchUpstream: stubUpstream((req) => {
        seen.push(req.url);
        return Response.json({ object: "list", data: [] });
      }),
    });
    await app.fetch(new Request("http://gateway/v1/models"));
    expect(seen).toEqual([`${CHAT_BASE}/models`]);
  });

  test("discover:false makes no upstream fetch even with discoverUrl set", async () => {
    const seen: string[] = [];
    const app = createApp(goConfig({ discover: false, discoverUrl: DISCOVER_URL }), {
      modelsdev,
      fetchUpstream: stubUpstream((req) => {
        seen.push(req.url);
        return new Response("nope", { status: 500 });
      }),
    });
    await app.fetch(new Request("http://gateway/v1/models"));
    expect(seen).toEqual([]);
  });
});
