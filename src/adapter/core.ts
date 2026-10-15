// The single pre-stream pipeline every inbound adapter shares.
//
// Both the OpenAI Chat Completions (`/v1/chat/completions`) and OpenAI
// Responses (`/v1/responses`) inbound routes normalize their request into a
// Chat-Completions-shaped body, then hand it here. This module owns, in order:
// per-model `dropParams` stripping, capability gating, OpenAI -> IR translation,
// provider-model construction, then either a non-stream `generate` (rendered by
// the inbound dialect) or a stream that prefetches its first event so a
// pre-stream failure stays an HTTP error (F3).
import type { LLMEvent, LLMResponse } from "@opencode/ai";
import type { GatewayModel, GatewayUpstream } from "../config";
import type { ModelCost } from "../cost";
import { errorResponse } from "../ops/errors";
import { aiErrorResponse } from "./ai-error";
import { containsImage, containsTools } from "./content";
import type { AdapterDeps } from "./index";
import { drainStream, type StreamDialect } from "./stream";
import { metaOf, openaiToIR } from "./translate";
import type { AdapterMeta, AdapterResult } from "./types";

/** How an inbound wire format renders a completed generation and its stream. */
export interface InboundDialect {
  /** Non-stream body for an assembled `LLMResponse`. */
  render(res: LLMResponse, inboundId: string): Record<string, unknown>;
  /** Per-request streaming dialect (state is created lazily by `drainStream`). */
  stream(model: GatewayModel, inboundId: string, cost?: ModelCost | null): StreamDialect<unknown>;
}

export interface GenerationRequest {
  upstream: GatewayUpstream;
  model: GatewayModel;
  /** Already normalized to the Chat Completions shape. */
  chatBody: Record<string, unknown>;
  /** Model id echoed to the client (the requested id, not the upstream id). */
  inboundId: string;
  signal?: AbortSignal;
  cost?: ModelCost | null;
}

export async function runGeneration(
  deps: AdapterDeps,
  req: GenerationRequest,
  dialect: InboundDialect,
): Promise<AdapterResult> {
  // 1. Strip per-model unsupported params from a shallow copy.
  const stripped: Record<string, unknown> = { ...req.chatBody };
  for (const key of req.model.dropParams ?? []) delete stripped[key];

  // 2. Capability gating (only an explicit `false` is enforced).
  if (req.model.supportsVision === false && containsImage(stripped)) {
    return { response: errorResponse("model does not support image input", 400) };
  }
  if (req.model.supportsTools === false && containsTools(stripped)) {
    return { response: errorResponse("model does not support tools", 400) };
  }

  const ir = openaiToIR(stripped, req.model);
  const m = deps.ai.model(req.upstream, req.model);
  const input = { ...ir, model: m };

  // 3. Non-stream: reassemble the upstream stream into one completion.
  if (req.chatBody.stream !== true) {
    try {
      const result = await deps.ai.generate(m, input, { signal: req.signal });
      return {
        response: Response.json(dialect.render(result, req.inboundId)),
        completed: Promise.resolve(metaOf(result, req.model, req.cost)),
      };
    } catch (err) {
      return { response: aiErrorResponse(err, req.model) };
    }
  }

  // 4. Stream: pull the first event so pre-stream failures become an HTTP error.
  const iterator = deps.ai.stream(m, input, { signal: req.signal })[Symbol.asyncIterator]();
  let first: IteratorResult<LLMEvent>;
  try {
    first = await iterator.next();
  } catch (err) {
    return { response: aiErrorResponse(err, req.model) };
  }

  let resolveCompleted!: (meta: AdapterMeta | null) => void;
  const completed = new Promise<AdapterMeta | null>((resolve) => {
    resolveCompleted = resolve;
  });
  const stream = drainStream(
    first,
    iterator,
    dialect.stream(req.model, req.inboundId, req.cost),
    req.model,
    resolveCompleted,
  );
  return {
    response: new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    }),
    completed,
  };
}
