// Vendor-agnostic adapter seam for the chat-completions hot path.
//
// `passthrough` relays bytes to the upstream unchanged (today's behavior + F3
// context-overflow classification); `opencode` translates the OpenAI Chat
// Completions wire format into the @opencode/ai LLM IR and back, dispatching the
// provider-native protocol by the upstream's `package`. The adapter is OPT-IN
// per upstream. `openai-compatible` is accepted as a deprecated config alias for
// `opencode` and canonicalized in `selectAdapter`.
import type { GatewayModel, GatewayUpstream } from "../config";
import type { ModelCost } from "../cost";

export type AdapterKind = "passthrough" | "opencode";

/**
 * Billed token counts for the `generation` log event. The three base fields are
 * always present; `cacheReadTokens`/`cacheWriteTokens` are attached ONLY when
 * the provider actually reported them (so a source without cache metrics keeps
 * a byte-identical `{ tokensIn, tokensOut, tokensTotal }` shape).
 */
export interface TokenUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

/** Metrics derived from one generation, for the `generation` log event. Null fields mean "unknown". */
export interface AdapterMeta {
  usage: TokenUsage | null;
  contextRatio: number | null;
  finishReason: string | null;
  /** USD for the request, or null when usage or pricing is unknown. */
  costUsd: number | null;
}

export interface AdapterInput {
  upstream: GatewayUpstream;
  model: GatewayModel;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  /** Resolved pricing (ResolvedModel.cost) for cost accounting; omitted disables it. */
  cost?: ModelCost | null;
}

export interface AdapterResult {
  response: Response;
  /** Resolves when a translated generation has produced its metrics; absent for passthrough. */
  completed?: Promise<AdapterMeta | null>;
}

export interface Adapter {
  handle(input: AdapterInput): Promise<AdapterResult>;
}
