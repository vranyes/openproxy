// Opt-in adapter: translate OpenAI Chat Completions <-> @opencode/ai LLM IR.
//
// `createOpenCodeAdapter` is provider-agnostic: the concrete dialect is chosen
// by `deps.ai.model` from the upstream's `package` (F5). The runtime always
// requests an upstream SSE stream (that is the package's protocol), so a client
// non-stream request is reassembled from the stream, and a client stream request
// is re-emitted frame by frame. Everything that can fail BEFORE the first
// upstream byte is turned into an HTTP error, preserving F3's clean 400 for
// pre-stream context overflow.
import type { LLMEvent, Usage } from "@opencode/ai";
import type { GatewayModel } from "../config";
import { errorResponse } from "../ops/errors";
import { aiErrorResponse } from "./ai-error";
import type { AdapterDeps } from "./index";
import {
  chunkMeta,
  DONE_FRAME,
  finishFrame,
  metaOf,
  openaiToIR,
  reasoningDeltaFrame,
  responseFromIR,
  roleFrame,
  textDeltaFrame,
  toOpenAiFinishReason,
  toolCallFrame,
  toolInputDeltaFrame,
  toolInputStartFrame,
  usageFrame,
  type ChunkMeta,
} from "./translate";
import type { Adapter, AdapterInput, AdapterMeta, AdapterResult } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Does any message carry an image part? */
function containsImage(body: Record<string, unknown>): boolean {
  for (const raw of asArray(body.messages)) {
    const m = asRecord(raw);
    if (!m || !Array.isArray(m.content)) continue;
    for (const rawPart of m.content) {
      const part = asRecord(rawPart);
      if (part && (part.type === "image_url" || part.type === "image")) return true;
    }
  }
  return false;
}

/** Does the request ask for tools, or continue a tool conversation? */
function containsTools(body: Record<string, unknown>): boolean {
  if (asArray(body.tools).length > 0) return true;
  for (const raw of asArray(body.messages)) {
    const m = asRecord(raw);
    if (!m) continue;
    if (m.role === "tool") return true;
    if (m.role === "assistant" && asArray(m.tool_calls).length > 0) return true;
  }
  return false;
}

interface StreamState {
  usage: Usage | null;
  finishReason: string;
  toolIndex: Map<string, number>;
  nextIndex: number;
  started: Set<string>;
  deltaed: Set<string>;
}

function newStreamState(): StreamState {
  return {
    usage: null,
    finishReason: "stop",
    toolIndex: new Map(),
    nextIndex: 0,
    started: new Set(),
    deltaed: new Set(),
  };
}

function toolIndexFor(state: StreamState, id: string): number {
  let index = state.toolIndex.get(id);
  if (index === undefined) {
    index = state.nextIndex;
    state.nextIndex += 1;
    state.toolIndex.set(id, index);
  }
  return index;
}

function emit(
  event: LLMEvent,
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
  send: (controller: ReadableStreamDefaultController<Uint8Array>, frame: string) => void,
  meta: ChunkMeta,
): void {
  switch (event.type) {
    case "text-delta":
      send(controller, textDeltaFrame(meta, event.text));
      break;
    case "reasoning-delta":
      send(controller, reasoningDeltaFrame(meta, event.text));
      break;
    case "tool-input-start": {
      const index = toolIndexFor(state, event.id);
      state.started.add(event.id);
      send(controller, toolInputStartFrame(meta, index, event.id, event.name));
      break;
    }
    case "tool-input-delta": {
      const index = toolIndexFor(state, event.id);
      state.started.add(event.id);
      state.deltaed.add(event.id);
      send(controller, toolInputDeltaFrame(meta, index, event.text));
      break;
    }
    case "tool-call": {
      // The openai-compatible protocol streams input via tool-input-*; only
      // synthesize a frame when a provider reported the call without deltas.
      const index = toolIndexFor(state, event.id);
      if (!state.deltaed.has(event.id)) {
        const args = JSON.stringify(event.input ?? {});
        if (state.started.has(event.id)) send(controller, toolInputDeltaFrame(meta, index, args));
        else send(controller, toolCallFrame(meta, index, event.id, event.name, args));
      }
      break;
    }
    case "step-finish":
      if (event.usage) state.usage = event.usage;
      break;
    case "finish":
      if (event.usage) state.usage = event.usage;
      state.finishReason = toOpenAiFinishReason(event.reason.normalized);
      break;
    default:
      break;
  }
}

interface StreamCtx {
  meta: ChunkMeta;
  model: GatewayModel;
  resolveCompleted: (meta: AdapterMeta | null) => void;
}

function sseStream(
  first: IteratorResult<LLMEvent>,
  iterator: AsyncIterator<LLMEvent>,
  ctx: StreamCtx,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, frame: string): void => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(frame));
    } catch {
      closed = true;
    }
  };
  const safeClose = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // already closed
    }
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const state = newStreamState();
      try {
        send(controller, roleFrame(ctx.meta));
        if (!first.done) emit(first.value, controller, state, send, ctx.meta);
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          emit(next.value, controller, state, send, ctx.meta);
        }
        send(controller, finishFrame(ctx.meta, state.finishReason));
        if (state.usage) send(controller, usageFrame(ctx.meta, state.usage));
        send(controller, DONE_FRAME);
      } catch (err) {
        const reason = (err as { reason?: { message?: unknown } } | null | undefined)?.reason;
        const message = reason?.message !== undefined ? String(reason.message) : String(err);
        send(controller, `data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
        send(controller, DONE_FRAME);
      } finally {
        safeClose(controller);
        await iterator.return?.().catch(() => {});
        ctx.resolveCompleted(
          metaOf({ usage: state.usage, finishReason: { normalized: state.finishReason } }, ctx.model),
        );
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      void iterator.return?.().catch(() => {});
    },
  });
}

export function createOpenCodeAdapter(deps: AdapterDeps): Adapter {
  return {
    async handle({ upstream, model, body, signal }: AdapterInput): Promise<AdapterResult> {
      // 1. Strip per-model unsupported params from a shallow copy.
      const stripped: Record<string, unknown> = { ...body };
      for (const key of model.dropParams ?? []) delete stripped[key];

      // 2. Capability gating (only an explicit `false` is enforced).
      if (model.supportsVision === false && containsImage(stripped)) {
        return { response: errorResponse("model does not support image input", 400) };
      }
      if (model.supportsTools === false && containsTools(stripped)) {
        return { response: errorResponse("model does not support tools", 400) };
      }

      const ir = openaiToIR(stripped, model);
      const m = deps.ai.model(upstream, model);
      const input = { ...ir, model: m };
      const inboundId = typeof body.model === "string" ? body.model : model.id;

      // 5. Non-stream: reassemble the upstream stream into one completion.
      if (body.stream !== true) {
        try {
          const result = await deps.ai.generate(m, input, { signal });
          return {
            response: Response.json(responseFromIR(result, inboundId)),
            completed: Promise.resolve(metaOf(result, model)),
          };
        } catch (err) {
          return { response: aiErrorResponse(err, model) };
        }
      }

      // 6. Stream: pull the first event so pre-stream failures become an HTTP error.
      const iterator = deps.ai.stream(m, input, { signal })[Symbol.asyncIterator]();
      let first: IteratorResult<LLMEvent>;
      try {
        first = await iterator.next();
      } catch (err) {
        return { response: aiErrorResponse(err, model) };
      }

      let resolveCompleted!: (meta: AdapterMeta | null) => void;
      const completed = new Promise<AdapterMeta | null>((resolve) => {
        resolveCompleted = resolve;
      });
      const stream = sseStream(first, iterator, { meta: chunkMeta(inboundId), model, resolveCompleted });
      return {
        response: new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }),
        completed,
      };
    },
  };
}
