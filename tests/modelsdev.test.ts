import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  createModelsDevStore,
  DEFAULT_MODELS_URL,
  parseSnapshot,
  resolveModelsCachePath,
  resolveModelsUrl,
  sha256Hex,
  type ModelsDevCache,
  type ModelsDevCatalog,
} from "../src/modelsdev";
import type { Logger, LogEvent } from "../src/ops/log";

const tinyText = readFileSync(new URL("./fixtures/modelsdev/tiny.json", import.meta.url), "utf8");
const tiny = JSON.parse(tinyText) as ModelsDevCatalog;
const envelopeText = readFileSync(new URL("./fixtures/modelsdev/envelope.json", import.meta.url), "utf8");
const idx = buildIndex(tiny);

function captureLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  return { logger: (e) => events.push(e), events };
}

// --- index -------------------------------------------------------------------

describe("buildIndex", () => {
  test("hasProvider / getProvider", () => {
    expect(idx.hasProvider("openai")).toBe(true);
    expect(idx.hasProvider("nope")).toBe(false);
    expect(idx.getProvider("openai")?.id).toBe("openai");
    expect(idx.getProvider("nope")).toBeNull();
  });

  test("findInProvider prefers exact keys, in caller order", () => {
    const mm = idx.findInProvider("opencode", ["deepseek-v4-pro", "glm-5.2"]);
    expect(mm).toEqual({ provider: "opencode", model: "deepseek-v4-pro", entry: expect.anything() });
    expect(mm!.entry.limit?.context).toBe(1000000);
  });

  test("findInProvider resolves a unique /-suffix", () => {
    const mm = idx.findInProvider("deepinfra", ["claude-fable-5"]);
    expect(mm?.model).toBe("anthropic/claude-fable-5");
    expect(mm?.entry.limit?.context).toBe(1000000);
  });

  test("findInProvider returns null for an ambiguous /-suffix", () => {
    expect(idx.findInProvider("nano-gpt", ["glm-5.2"])).toBeNull();
  });

  test("findInProvider returns null for an unknown provider", () => {
    expect(idx.findInProvider("nope", ["gpt-5-mini"])).toBeNull();
  });

  test("providersWithEnv is sorted", () => {
    expect(idx.providersWithEnv("ZHIPU_API_KEY")).toEqual(["zai", "zai-coding-plan", "zhipuai"]);
    expect(idx.providersWithEnv("NOPE")).toEqual([]);
  });

  test("providersByHost is sorted and exact", () => {
    expect(idx.providersByHost("opencode.ai")).toEqual(["opencode", "opencode-go"]);
    expect(idx.providersByHost("api.z.ai")).toEqual(["zai", "zai-coding-plan"]);
    expect(idx.providersByHost("opencode.ai.")).toEqual([]);
  });

  test("findProvidersWithAnyKey dedupes and sorts", () => {
    const matches = idx.findProvidersWithAnyKey(["glm-5.2", "glm-5.2"]);
    expect(matches.map((m) => `${m.provider}/${m.model}`)).toEqual([
      "opencode/glm-5.2",
      "opencode-go/glm-5.2",
      "zai/glm-5.2",
      "zai-coding-plan/glm-5.2",
      "zhipuai/glm-5.2",
    ]);
  });
});

// --- env + url resolvers -----------------------------------------------------

describe("resolveModelsUrl", () => {
  test("defaults to the full models.dev url", () => {
    expect(resolveModelsUrl({})).toBe(DEFAULT_MODELS_URL);
    expect(DEFAULT_MODELS_URL).toBe("https://models.dev/api.json");
  });

  test("OPENPROXY_MODELS_URL wins", () => {
    expect(resolveModelsUrl({ OPENPROXY_MODELS_URL: "http://cache.test/api.json" })).toBe("http://cache.test/api.json");
  });
});

describe("resolveModelsCachePath", () => {
  test("OPENPROXY_MODELS_PATH wins", () => {
    expect(resolveModelsCachePath({ OPENPROXY_MODELS_PATH: "/custom/models.json" })).toBe("/custom/models.json");
  });

  test("XDG_CACHE_HOME is honored", () => {
    expect(resolveModelsCachePath({ XDG_CACHE_HOME: "/xdg" })).toBe("/xdg/openproxy/models.json");
  });

  test("falls back to ~/.cache", () => {
    expect(resolveModelsCachePath({})).toMatch(/openproxy\/models\.json$/);
  });
});

// --- parseSnapshot -----------------------------------------------------------

describe("parseSnapshot", () => {
  test("parses a bare catalog", () => {
    const parsed = parseSnapshot(tinyText);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toContain("openai");
  });

  test("parses the secondary envelope format", () => {
    const parsed = parseSnapshot(envelopeText);
    expect(parsed).not.toBeNull();
    expect(parsed!.opencode!.models["glm-5.2"]!.limit?.context).toBe(1000000);
  });

  test("garbage and non-catalogs yield null", () => {
    expect(parseSnapshot("{not json")).toBeNull();
    expect(parseSnapshot("[]")).toBeNull();
    expect(parseSnapshot("{}")).toBeNull();
    expect(parseSnapshot(JSON.stringify({ body: "{not json" }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ body: "{}" }))).toBeNull();
  });
});

describe("sha256Hex", () => {
  test("is stable and hex", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- store -------------------------------------------------------------------

const RAW_CATALOG = JSON.stringify({
  alpha: { id: "alpha", env: ["ALPHA_KEY"], api: "https://alpha.test/v1", models: { m1: { id: "m1", limit: { context: 1000 } } } },
});

function storeFor(opts: { read?: string | null; write?: ModelsDevCache["write"] } = {}): {
  store: ReturnType<typeof createModelsDevStore>;
  events: LogEvent[];
  writes: Array<[string, string]>;
} {
  const { logger, events } = captureLogger();
  const writes: Array<[string, string]> = [];
  const cache: ModelsDevCache = {
    read: () => opts.read ?? null,
    write: opts.write ?? ((p, d) => writes.push([p, d])),
  };
  const store = createModelsDevStore({
    url: "http://models.test/api.json",
    cachePath: "/virtual/models.json",
    refreshMs: 0,
    logger,
    cache,
    fetch: async () => new Response(RAW_CATALOG, { status: 200 }),
  });
  return { store, events, writes };
}

describe("createModelsDevStore", () => {
  test("loads a bare snapshot synchronously without fetching", () => {
    let fetched = 0;
    const { logger } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: "/virtual/models.json",
      refreshMs: 0,
      logger,
      cache: { read: () => tinyText, write: () => {} },
      fetch: async () => {
        fetched++;
        return new Response(RAW_CATALOG);
      },
    });
    expect(store.catalog).not.toBeNull();
    expect(store.index).not.toBeNull();
    expect(store.index!.hasProvider("openai")).toBe(true);
    expect(fetched).toBe(0);
  });

  test("a corrupt snapshot yields null catalog + a warning", () => {
    const { logger, events } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: "/virtual/models.json",
      refreshMs: 0,
      logger,
      cache: { read: () => "{oops", write: () => {} },
    });
    expect(store.catalog).toBeNull();
    expect(store.index).toBeNull();
    expect(events.some((e) => e.level === "warn" && String(e.msg).includes("unreadable"))).toBe(true);
  });

  test("a missing snapshot yields null catalog", () => {
    const { logger } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: "/virtual/models.json",
      refreshMs: 0,
      logger,
      cache: { read: () => null, write: () => {} },
    });
    expect(store.catalog).toBeNull();
  });

  test("refresh updated writes the RAW fetched text and swaps the index", async () => {
    const { store, writes } = storeFor({ read: null });
    const result = await store.refresh();
    expect(result).toBe("updated");
    expect(store.catalog).not.toBeNull();
    expect(store.index!.hasProvider("alpha")).toBe(true);
    expect(writes).toEqual([["/virtual/models.json", RAW_CATALOG]]);
  });

  test("refresh unchanged performs no write and keeps index identity", async () => {
    const { store, writes } = storeFor({ read: RAW_CATALOG });
    const before = store.index;
    expect(await store.refresh()).toBe("unchanged");
    expect(store.index).toBe(before);
    expect(writes).toEqual([]);
  });

  test("refresh failed: network throw keeps the last good index and never throws", async () => {
    let reject = true;
    const { logger } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: "/virtual/models.json",
      refreshMs: 0,
      logger,
      cache: { read: () => tinyText, write: () => {} },
      fetch: async () => {
        if (reject) throw new Error("boom");
        return new Response(RAW_CATALOG);
      },
    });
    const before = store.index;
    await expect(store.refresh()).resolves.toBe("failed");
    expect(store.index).toBe(before);
    reject = false;
  });

  test("refresh failed: non-ok response keeps the last good index", async () => {
    const { logger } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: "/virtual/models.json",
      refreshMs: 0,
      logger,
      cache: { read: () => tinyText, write: () => {} },
      fetch: async () => new Response("nope", { status: 503 }),
    });
    const before = store.index;
    expect(await store.refresh()).toBe("failed");
    expect(store.index).toBe(before);
  });

  test("refresh failed: invalid payload keeps the last good index and warns", async () => {
    const { logger, events } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: "/virtual/models.json",
      refreshMs: 0,
      logger,
      cache: { read: () => tinyText, write: () => {} },
      fetch: async () => new Response("not a catalog"),
    });
    const before = store.index;
    expect(await store.refresh()).toBe("failed");
    expect(store.index).toBe(before);
    expect(events.some((e) => e.level === "warn" && String(e.msg).includes("not a valid catalog"))).toBe(true);
  });

  test("single-flight: concurrent refreshes share one fetch", async () => {
    let fetched = 0;
    const { logger } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: "/virtual/models.json",
      refreshMs: 0,
      logger,
      cache: { read: () => null, write: () => {} },
      fetch: async () => {
        fetched++;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(RAW_CATALOG);
      },
    });
    const [a, b] = await Promise.all([store.refresh(), store.refresh()]);
    expect(fetched).toBe(1);
    expect(a).toBe("updated");
    expect(b).toBe("updated");
  });

  test("OPENPROXY_DISABLE_MODELS_FETCH=1 makes refresh a no-op without fetching", async () => {
    let fetched = 0;
    const { logger } = captureLogger();
    const prev = process.env.OPENPROXY_DISABLE_MODELS_FETCH;
    process.env.OPENPROXY_DISABLE_MODELS_FETCH = "1";
    try {
      const store = createModelsDevStore({
        url: "http://models.test/api.json",
        cachePath: "/virtual/models.json",
        refreshMs: 0,
        logger,
        cache: { read: () => tinyText, write: () => {} },
        fetch: async () => {
          fetched++;
          return new Response(RAW_CATALOG);
        },
      });
      expect(await store.refresh()).toBe("failed");
      expect(fetched).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.OPENPROXY_DISABLE_MODELS_FETCH;
      else process.env.OPENPROXY_DISABLE_MODELS_FETCH = prev;
    }
  });

  test("refreshMs:0 installs no timer; refreshMs>0 installs one and close() clears it", () => {
    const g = globalThis as unknown as { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
    const realSetInterval = g.setInterval;
    const realClearInterval = g.clearInterval;
    let setCalls = 0;
    let clearCalls = 0;
    g.setInterval = ((fn: (...a: unknown[]) => void, ms?: number) => {
      setCalls++;
      return realSetInterval(fn, ms);
    }) as typeof setInterval;
    g.clearInterval = ((id: ReturnType<typeof setInterval>) => {
      clearCalls++;
      return realClearInterval(id);
    }) as typeof clearInterval;
    try {
      const { logger } = captureLogger();
      const zero = createModelsDevStore({
        url: "http://models.test/api.json",
        cachePath: "/virtual/models.json",
        refreshMs: 0,
        logger,
        cache: { read: () => null, write: () => {} },
      });
      expect(setCalls).toBe(0);
      zero.close();
      expect(clearCalls).toBe(0);

      const periodic = createModelsDevStore({
        url: "http://models.test/api.json",
        cachePath: "/virtual/models.json",
        refreshMs: 100_000,
        logger,
        cache: { read: () => null, write: () => {} },
      });
      expect(setCalls).toBe(1);
      periodic.close();
      expect(clearCalls).toBe(1);
    } finally {
      g.setInterval = realSetInterval;
      g.clearInterval = realClearInterval;
    }
  });
});

// --- default cache (temp dir) ------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "openproxy-modelsdev-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("default cache", () => {
  test("write creates nested dirs and persists the RAW text atomically", async () => {
    const { logger } = captureLogger();
    const cachePath = join(scratch, "nested", "deeper", "models.json");
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath,
      refreshMs: 0,
      logger,
      fetch: async () => new Response(tinyText, { status: 200 }),
    });
    expect(await store.refresh()).toBe("updated");
    expect(readFileSync(cachePath, "utf8")).toBe(tinyText);
  });

  test("read of a missing path returns null", () => {
    const { logger } = captureLogger();
    const store = createModelsDevStore({
      url: "http://models.test/api.json",
      cachePath: join(scratch, "does-not-exist.json"),
      refreshMs: 0,
      logger,
      fetch: async () => new Response(tinyText),
    });
    expect(store.catalog).toBeNull();
  });
});
