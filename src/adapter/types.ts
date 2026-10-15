// Vendor-agnostic adapter seam for the chat-completions hot path.
//
// `passthrough` relays bytes to the upstream unchanged (today's behavior + F3
// context-overflow classification); `opencode` translates the OpenAI Chat
// Completions wire format into the @opencode/ai LLM IR and back, dispatching the
// provider-native protocol by the upstream's `package`. The adapter is OPT-IN
// per upstream. `openai-compatible` is accepted as a deprecated config alias for
// `opencode` and canonicalized in `selectAdapter`.
import type { GatewayModel, GatewayUpstream } from "../config";

export type AdapterKind = "passthrough" | "opencode";

/** Metrics derived from one generation, for the `generation` log event. Null fields mean "unknown". */
export interface AdapterMeta {
  usage: { tokensIn: number | null; tokensOut: number | null; tokensTotal: number | null } | null;
  contextRatio: number | null;
  finishReason: string | null;
}

export interface AdapterInput {
  upstream: GatewayUpstream;
  model: GatewayModel;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AdapterResult {
  response: Response;
  /** Resolves when a translated generation has produced its metrics; absent for passthrough. */
  completed?: Promise<AdapterMeta | null>;
}

export interface Adapter {
  handle(input: AdapterInput): Promise<AdapterResult>;
}
