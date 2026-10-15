// Adapter selection + composition. `UpstreamFetcher` is imported TYPE-ONLY: a
// value import here would create a runtime cycle (server.ts imports this module).
import type { GatewayUpstream } from "../config";
import type { UpstreamFetcher } from "../server";
import type { AiRuntime } from "./ai";
import { createOpenAiCompatibleAdapter } from "./openai-compatible";
import { createPassthroughAdapter } from "./passthrough";
import type { Adapter, AdapterKind } from "./types";

export interface AdapterDeps {
  fetchUpstream: UpstreamFetcher;
  ai: AiRuntime;
}

/** The upstream's translation strategy; `passthrough` unless opted in. */
export function selectAdapter(u: GatewayUpstream): AdapterKind {
  return u.adapter ?? "passthrough";
}

export function createAdapter(kind: AdapterKind, deps: AdapterDeps): Adapter {
  switch (kind) {
    case "passthrough":
      return createPassthroughAdapter(deps);
    case "openai-compatible":
      return createOpenAiCompatibleAdapter(deps);
  }
}
