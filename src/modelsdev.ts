// models.dev metadata: fetch + cache + refresh, fail-open.
//
// The catalog is the second metadata source in the resolution chain
// (explicit config > models.dev > upstream discovery hint). It is loaded
// synchronously from an on-disk snapshot at construction, and refreshed in the
// background. Nothing here ever throws into a request path: a missing snapshot,
// a corrupt file, a failed fetch, or a malformed payload all degrade to "no
// metadata" and the caller falls back to explicit config / hints.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { safeLog, type Logger } from "./ops/log";

export interface ModelsDevModel {
  id: string;
  name?: string;
  limit?: { context?: number; input?: number; output?: number };
  attachment?: boolean;
  tool_call?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    [key: string]: unknown;
  };
  canonical_model_id?: string;
  family?: string;
  /**
   * Per-model transport override (F11). When present it wins over the
   * provider-level `npm`/`api`: `npm` names the dialect, `api` the base URL.
   * e.g. muse-spark-1.3-contributor carries `{ npm: "@ai-sdk/openai",
   * api: ".../inference/go/openai/v1" }` inside the opencode-go provider.
   */
  provider?: { npm?: string; api?: string };
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface ModelMatch {
  provider: string;
  model: string;
  entry: ModelsDevModel;
}

export interface ModelsDevIndex {
  hasProvider(id: string): boolean;
  getProvider(id: string): ModelsDevProvider | null;
  /** Exact model key first (in `keys` order), else a unique `/`-suffix match; ambiguity -> null. */
  findInProvider(provider: string, keys: readonly string[]): ModelMatch | null;
  /** Exact model keys across every provider, deduped by (provider, model), sorted. */
  findProvidersWithAnyKey(keys: readonly string[]): ModelMatch[];
  providersWithEnv(env: string): string[];
  providersByHost(host: string): string[];
}

/** Lowercased hostname of a URL, or null when absent / unparseable. */
function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The last `/`-separated segment (the whole string when there is no slash). */
function lastSegment(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export function buildIndex(catalog: ModelsDevCatalog): ModelsDevIndex {
  return {
    hasProvider(id) {
      return Object.hasOwn(catalog, id);
    },
    getProvider(id) {
      return Object.hasOwn(catalog, id) ? (catalog[id] ?? null) : null;
    },
    findInProvider(provider, keys) {
      const p = Object.hasOwn(catalog, provider) ? catalog[provider] : undefined;
      if (!p || typeof p.models !== "object" || p.models === null) return null;
      const models = p.models;
      // 1. Exact key, in the caller's key order.
      for (const key of keys) {
        if (Object.hasOwn(models, key)) return { provider, model: key, entry: models[key]! };
      }
      // 2. Keys whose LAST `/`-segment equals a key. Only a single distinct
      //    model may match; two candidates are ambiguous and resolve to null.
      const suffix = new Map<string, ModelsDevModel>();
      for (const key of keys) {
        for (const [model, entry] of Object.entries(models)) {
          if (lastSegment(model) === key) suffix.set(model, entry);
        }
      }
      if (suffix.size === 1) {
        const [model, entry] = suffix.entries().next().value as [string, ModelsDevModel];
        return { provider, model, entry };
      }
      return null;
    },
    findProvidersWithAnyKey(keys) {
      const out: ModelMatch[] = [];
      const seen = new Set<string>();
      for (const [provider, p] of Object.entries(catalog)) {
        if (!p || typeof p.models !== "object" || p.models === null) continue;
        for (const key of keys) {
          if (!Object.hasOwn(p.models, key)) continue;
          const dedupe = `${provider}\u0000${key}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          out.push({ provider, model: key, entry: p.models[key]! });
        }
      }
      out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
      return out;
    },
    providersWithEnv(env) {
      return Object.entries(catalog)
        .filter(([, p]) => p?.env?.includes(env) === true)
        .map(([id]) => id)
        .sort();
    },
    providersByHost(host) {
      if (!host) return [];
      const wanted = host.toLowerCase();
      return Object.entries(catalog)
        .filter(([, p]) => hostOf(p?.api) === wanted)
        .map(([id]) => id)
        .sort();
    },
  };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Is `value` a plausible catalog (non-null object, non-empty, every entry has a `models` object)? */
function asCatalog(value: unknown): ModelsDevCatalog | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  for (const [, provider] of entries) {
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) return null;
    const models = (provider as Record<string, unknown>).models;
    if (typeof models !== "object" || models === null || Array.isArray(models)) return null;
  }
  return value as ModelsDevCatalog;
}

/**
 * Parse a models.dev payload. The primary format is the bare catalog
 * (`{ "<provider>": { models: { ... } } }`); the secondary format wraps it in a
 * JSON string field `body`. Anything else (bad JSON, garbage) -> null.
 */
export function parseSnapshot(text: string): ModelsDevCatalog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const direct = asCatalog(parsed);
  if (direct) return direct;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const body = (parsed as Record<string, unknown>).body;
    if (typeof body === "string") {
      try {
        return asCatalog(JSON.parse(body));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const DEFAULT_MODELS_URL = "https://models.dev/api.json";

export function resolveModelsUrl(env: Record<string, string | undefined> = process.env): string {
  return env.OPENPROXY_MODELS_URL || DEFAULT_MODELS_URL;
}

export function resolveModelsCachePath(env: Record<string, string | undefined> = process.env): string {
  if (env.OPENPROXY_MODELS_PATH) return env.OPENPROXY_MODELS_PATH;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "openproxy", "models.json");
  return join(homedir(), ".cache", "openproxy", "models.json");
}

export interface ModelsDevCache {
  read(path: string): string | null;
  write(path: string, data: string): void;
}

export interface ModelsDevStoreOptions {
  url?: string;
  cachePath?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  cache?: ModelsDevCache;
  now?: () => number;
  refreshMs?: number;
  logger: Logger;
}

export type ModelsDevRefreshResult = "updated" | "unchanged" | "failed";

export interface ModelsDevStore {
  readonly catalog: ModelsDevCatalog | null;
  readonly index: ModelsDevIndex | null;
  refresh(): Promise<ModelsDevRefreshResult>;
  close(): void;
}

const DEFAULT_REFRESH_MS = 86_400_000;

function defaultRefreshMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OPENPROXY_MODELS_REFRESH_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_REFRESH_MS;
}

/** The default cache: sync read (missing/error -> null), atomic tmp+rename write. */
function defaultCache(logger: Logger, now: () => number): ModelsDevCache {
  return {
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    write(path, data) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp-${process.pid}-${now()}`;
        writeFileSync(tmp, data);
        renameSync(tmp, path);
      } catch (e) {
        safeLog(logger, {
          level: "warn",
          msg: "models.dev cache write failed",
          path,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}

export function createModelsDevStore(opts: ModelsDevStoreOptions): ModelsDevStore {
  const logger = opts.logger;
  const url = opts.url ?? resolveModelsUrl();
  const cachePath = opts.cachePath ?? resolveModelsCachePath();
  const fetchImpl = opts.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const now = opts.now ?? (() => Date.now());
  const cache = opts.cache ?? defaultCache(logger, now);
  const refreshMs = opts.refreshMs ?? defaultRefreshMs();

  let catalog: ModelsDevCatalog | null = null;
  let index: ModelsDevIndex | null = null;
  let digest: string | null = null;
  let closed = false;

  // Synchronous snapshot load. No fetch here: construction must never block or
  // touch the network.
  let snapshot: string | null = null;
  try {
    snapshot = cache.read(cachePath);
  } catch (e) {
    safeLog(logger, { level: "warn", msg: "models.dev snapshot read failed", path: cachePath,
      error: e instanceof Error ? e.message : String(e) });
  }
  if (snapshot === null) {
    safeLog(logger, { level: "warn", msg: "models.dev snapshot missing; starting without metadata", path: cachePath });
  } else {
    const parsed = parseSnapshot(snapshot);
    if (parsed === null) {
      safeLog(logger, { level: "warn", msg: "models.dev snapshot unreadable; starting without metadata", path: cachePath });
    } else {
      catalog = parsed;
      index = buildIndex(parsed);
      digest = sha256Hex(snapshot);
    }
  }

  async function doRefresh(): Promise<ModelsDevRefreshResult> {
    if (process.env.OPENPROXY_DISABLE_MODELS_FETCH === "1") {
      safeLog(logger, { level: "info", msg: "models.dev fetch disabled by OPENPROXY_DISABLE_MODELS_FETCH" });
      return "failed";
    }
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      safeLog(logger, { level: "warn", msg: "models.dev fetch failed", url,
        error: e instanceof Error ? e.message : String(e) });
      return "failed";
    }
    if (!res.ok) {
      safeLog(logger, { level: "warn", msg: "models.dev fetch returned non-ok", url, status: res.status });
      return "failed";
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      safeLog(logger, { level: "warn", msg: "models.dev body read failed", url,
        error: e instanceof Error ? e.message : String(e) });
      return "failed";
    }
    const nextDigest = sha256Hex(text);
    if (digest !== null && nextDigest === digest) return "unchanged";
    const parsed = parseSnapshot(text);
    if (parsed === null) {
      safeLog(logger, { level: "warn", msg: "models.dev response is not a valid catalog; keeping last good", url });
      return "failed";
    }
    // Atomic swap: the live getters never observe a half-built index.
    catalog = parsed;
    index = buildIndex(parsed);
    digest = nextDigest;
    cache.write(cachePath, text); // best-effort; default swallows, injections may throw
    safeLog(logger, { level: "info", msg: "models.dev catalog updated", url, providers: Object.keys(parsed).length });
    return "updated";
  }

  let inflight: Promise<ModelsDevRefreshResult> | null = null;
  function refresh(): Promise<ModelsDevRefreshResult> {
    if (closed) return Promise.resolve("failed");
    if (inflight) return inflight; // single-flight: concurrent callers share one fetch
    inflight = doRefresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (refreshMs > 0) {
    timer = setInterval(() => {
      void refresh();
    }, refreshMs);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    get catalog() {
      return catalog;
    },
    get index() {
      return index;
    },
    refresh,
    close() {
      closed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
