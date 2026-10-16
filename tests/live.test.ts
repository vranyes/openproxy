import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "../src/server";
import { json } from "./helpers";

// True integration: talks to the live upstream, no fakes.
// Run with: OPENPROXY_LIVE_TEST=1 bun test
const live = test.skipIf(!process.env.OPENPROXY_LIVE_TEST);

// The subset of LibreChat's model-fetch schema that /v1/models must satisfy
// (packages/api/src/utils/tokens.ts): a null context_length fails the parse,
// and one bad row fails the whole array.
const rowSchema = z.object({
  id: z.string(),
  pricing: z.object({ prompt: z.string(), completion: z.string() }),
  context_length: z.number(),
});

describe("live zen upstream", () => {
  live("GET /v1/models returns LibreChat-consumable rows for resolvable models", async () => {
    const app = createApp({
      upstreams: [
        {
          id: "zen",
          package: "@opencode/ai/providers/openai-compatible",
          baseURL: "https://opencode.ai/zen/go/v1",
          discover: true,
          models: [{ id: "glm-5.2", context: 1000000 }],
        },
      ],
    });
    const res = await app.fetch(new Request("http://gateway/v1/models"));
    expect(res.status).toBe(200);
    const body = await json<{
      data: Array<{ id: string; context_length: number; pricing: { prompt: string; completion: string } }>;
    }>(res);
    // The zen /v1/models list carries no context metadata, so discovered models
    // resolve to no context and are omitted; only the configured model remains.
    // Every row that IS returned must satisfy LibreChat's required fields.
    for (const row of body.data) {
      expect(rowSchema.safeParse(row).success).toBe(true);
    }
    expect(body.data.find((m) => m.id === "glm-5.2")).toMatchObject({ context_length: 1000000 });
  }, 30000);
});
