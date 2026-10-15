// Adapter selection + composition. `UpstreamFetcher` is imported TYPE-ONLY: a
// value import here would create a runtime cycle (server.ts imports this module).
import type { GatewayUpstream } from "../config";
import type { UpstreamFetcher } from "../server";
import type { AiRuntime } from "./ai";
import { createOpenCodeAdapter } from "./opencode";
import { createPassthroughAdapter } from "./passthrough";
import type { Adapter, AdapterKind } from "./types";

export interface AdapterDeps {
  fetchUpstream: UpstreamFetcher;
  ai: AiRuntime;
}

/**
 * The upstream's translation strategy; `passthrough` unless opted in. The
 * deprecated `openai-compatible` config alias canonicalizes to `opencode`.
 */
export function selectAdapter(u: GatewayUpstream): AdapterKind {
  const configured = u.adapter ?? "passthrough";
  return configured === "openai-compatible" ? "opencode" : configured;
}

export function createAdapter(kind: AdapterKind, deps: AdapterDeps): Adapter {
  switch (kind) {
    case "passthrough":
      return createPassthroughAdapter(deps);
    case "opencode":
      return createOpenCodeAdapter(deps);
  }
}
