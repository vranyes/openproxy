// Vendor-agnostic adapter seam for the chat-completions hot path.
//
// `passthrough` relays bytes to the upstream unchanged (today's behavior + F3
// context-overflow classification); `opencode` translates the OpenAI Chat
// Completions wire format into the @opencode/ai LLM IR and back, dispatching the
// provider-native protocol by the upstream's `package`. `systemone` relays Jev
// decision requests (`POST /v1/systemone`) to the SystemOne endpoint verbatim —
// no @opencode/ai provider speaks that dialect. The adapter is OPT-IN
// per upstream. `openai-compatible` is accepted as a deprecated config alias for
// `opencode` and canonicalized in `selectAdapter`.
import type { GatewayModel, GatewayUpstream } from "../config";
import type { ModelCost } from "../cost";

export type AdapterKind = "passthrough" | "opencode" | "systemone";

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
export type GenerationOutcome = "ok" | "midstream_error" | "client_aborted";
export interface AdapterMeta {
  usage: TokenUsage | null;
  contextRatio: number | null;
  finishReason: string | null;
  /** USD for the request, or null when usage or pricing is unknown. */
  costUsd: number | null;
  /** "ok" for a clean close; "midstream_error" when the stream failed after headers. */
  outcome: GenerationOutcome;
  /** Provider-neutral error tag (e.g. Transport, Timeout) for mid-stream failures. */
  errorTag?: string | null;
  /** Truncated provider error message for mid-stream failures. */
  errorMessage?: string | null;
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
  /** Pre-headers upstream attempts (1 + retries). Present on translated results. */
  attempts?: number;
  /** Error tags of retried attempts, in order. */
  retryTags?: string[];
}

export interface Adapter {
  handle(input: AdapterInput): Promise<AdapterResult>;
}
