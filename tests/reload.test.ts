import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { createApp } from "../src/server";
import { createConfigStore, loadConfigFile } from "../src/ops/config";
import { noopLogger, type LogEvent } from "../src/ops/log";
import type { GatewayConfig } from "../src/config";
import { stubUpstream } from "./helpers";

const configA: GatewayConfig = {
  upstreams: [
    {
      id: "local",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://upstream.test/v1",
      models: [{ id: "model-a", context: 1000 }],
    },
  ],
};

const configB: GatewayConfig = {
  upstreams: [
    {
      id: "local",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "http://upstream.test/v1",
      models: [{ id: "model-b", context: 2000 }],
    },
  ],
};

const okUpstream = stubUpstream(() => Response.json({ object: "chat.completion", choices: [] }));

function chatRequest(model: string): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [] }),
  });
}

describe("config store reload", () => {
  test("store.current is a live getter and the app re-reads it after reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openproxy-"));
    const path = join(dir, "gateway.yaml");
    try {
      writeFileSync(path, stringify(configA));
      const store = createConfigStore(path, { logger: noopLogger, watch: false });
      try {
        expect(store.current).toEqual(configA);

        writeFileSync(path, stringify(configB));
        store.reload();
        expect(store.current).toEqual(configB);

        const app = createApp(() => store.current, { logger: noopLogger, fetchUpstream: okUpstream });
        expect((await app.fetch(chatRequest("model-b"))).status).toBe(200);
        expect((await app.fetch(chatRequest("model-a"))).status).toBe(404);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider seam: swapping the closure value is visible on the next request", async () => {
    let current = configA;
    const app = createApp(() => current, { logger: noopLogger, fetchUpstream: okUpstream });
    expect((await app.fetch(chatRequest("model-a"))).status).toBe(200);

    current = configB;
    expect((await app.fetch(chatRequest("model-b"))).status).toBe(200);
    expect((await app.fetch(chatRequest("model-a"))).status).toBe(404);
  });
});

describe("config store reload outcomes", () => {
  test("a successful reload swaps the config and logs it", () => {
    const events: LogEvent[] = [];
    const queue = [configA, configB];
    const store = createConfigStore("ignored.yaml", {
      logger: (e) => events.push(e),
      watch: false,
      load: () => queue.shift()!,
    });
    expect(store.current).toEqual(configA);

    store.reload();
    expect(store.current).toEqual(configB);
    expect(events.at(-1)).toMatchObject({ level: "info", msg: "config reloaded", path: "ignored.yaml" });
    store.close();
  });

  test("a failed reload keeps the last good config and logs the error", () => {
    const events: LogEvent[] = [];
    let calls = 0;
    const store = createConfigStore("ignored.yaml", {
      logger: (e) => events.push(e),
      watch: false,
      load: () => {
        calls += 1;
        if (calls === 1) return configA;
        throw new Error("bad yaml");
      },
    });
    expect(store.current).toEqual(configA);

    store.reload();
    expect(store.current).toEqual(configA);
    expect(events.at(-1)).toMatchObject({
      level: "error",
      msg: "config reload failed; keeping last good config",
      path: "ignored.yaml",
      error: "bad yaml",
    });
    store.close();
  });
});

describe("loadConfigFile", () => {
  test("parses the example config and throws on malformed or invalid content", () => {
    expect(loadConfigFile("examples/gateway.yaml").upstreams.length).toBeGreaterThan(0);

    const dir = mkdtempSync(join(tmpdir(), "openproxy-"));
    try {
      const malformed = join(dir, "malformed.yaml");
      writeFileSync(malformed, "not: [valid");
      expect(() => loadConfigFile(malformed)).toThrow();

      const invalid = join(dir, "invalid.yaml");
      writeFileSync(invalid, "upstreams: []\n");
      expect(() => loadConfigFile(invalid)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
