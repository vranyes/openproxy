import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { parse } from "yaml";
import { GatewayConfigSchema, type GatewayConfig } from "../config";
import type { Logger } from "./log";

export function loadConfigFile(path: string): GatewayConfig {
  return GatewayConfigSchema.parse(parse(readFileSync(path, "utf8")));
}

export interface ConfigStoreOptions {
  logger: Logger;
  load?: (path: string) => GatewayConfig; // injectable for tests; default loadConfigFile
  watch?: boolean;                         // default true; false in tests
  debounceMs?: number;
}

export interface ConfigStore {
  // GETTER, not a stored value and not a method. Reading store.current returns the
  // latest good config at call time. Implemented via `get current()` over the closure
  // variable that reload reassigns. Do NOT use `current: config` (snapshot) or
  // `current: () => config` (method).
  readonly current: GatewayConfig;
  reload: () => void;
  close: () => void;
}

export function createConfigStore(path: string, opts: ConfigStoreOptions): ConfigStore {
  const load = opts.load ?? loadConfigFile;
  let config = load(path); // throws on invalid initial config -> fail fast
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  const reload = (): void => {
    try {
      config = load(path);
      opts.logger({ level: "info", msg: "config reloaded", path });
    } catch (e) {
      opts.logger({ level: "error", msg: "config reload failed; keeping last good config", path,
        error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (opts.watch ?? true) {
    const dir = dirname(path);
    const base = basename(path);
    watcher = watch(dir, (_event, filename) => {
      if (filename && String(filename) !== base) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reload(); }, opts.debounceMs ?? 50);
    });
  }

  return {
    get current(): GatewayConfig { return config; },
    reload,
    close: () => { if (timer) clearTimeout(timer); watcher?.close(); },
  };
}
