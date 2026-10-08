import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server";

// True integration: talks to the live upstream, no fakes.
// Run with: OPENPROXY_LIVE_TEST=1 bun test
const live = test.skipIf(!process.env.OPENPROXY_LIVE_TEST);

describe("live zen upstream", () => {
  live("GET /v1/models surfaces models available at opencode.ai/zen", async () => {
    const app = createApp({
      upstreams: [
        {
          id: "zen",
          package: "@opencode-ai/ai/providers/openai-compatible",
          baseURL: "https://opencode.ai/zen/go/v1",
          discover: true,
          models: [{ id: "glm-5.2", context: 1000000 }],
        },
      ],
    });
    const res = await app.fetch(new Request("http://gateway/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain("glm-5.2");
    expect(ids.length).toBeGreaterThan(10);
    expect(body.data.find((m: { id: string }) => m.id === "glm-5.2")).toMatchObject({ context_length: 1000000 });
  }, 30000);
});
