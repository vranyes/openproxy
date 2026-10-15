// Opt-in adapter: translate OpenAI Chat Completions <-> @opencode/ai LLM IR.
//
// `createOpenCodeAdapter` is provider-agnostic: the concrete dialect is chosen
// by `deps.ai.model` from the upstream's `package` (F5). The shared pipeline
// lives in `core.ts`; this file only supplies the CHAT dialect: the inbound
// body is already Chat Completions, and the emitted frames are today's
// `chat.completion.chunk` stream (`role` -> deltas -> `finish` -> `usage` ->
// `[DONE]`). Output is byte-identical to the pre-refactor adapter.
import type { LLMEvent, Usage } from "@opencode/ai";
import type { GatewayModel } from "../config";
import type { ModelCost } from "../cost";
import type { AdapterDeps } from "./index";
import { runGeneration, type InboundDialect } from "./core";
import type { StreamDialect } from "./stream";
import {
  chunkMeta,
  DONE_FRAME,
  finishFrame,
  metaOf,
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

function emit(event: LLMEvent, state: StreamState, meta: ChunkMeta, send: (frame: string) => void): void {
  switch (event.type) {
    case "text-delta":
      send(textDeltaFrame(meta, event.text));
      break;
    case "reasoning-delta":
      send(reasoningDeltaFrame(meta, event.text));
      break;
    case "tool-input-start": {
      const index = toolIndexFor(state, event.id);
      state.started.add(event.id);
      send(toolInputStartFrame(meta, index, event.id, event.name));
      break;
    }
    case "tool-input-delta": {
      const index = toolIndexFor(state, event.id);
      state.started.add(event.id);
      state.deltaed.add(event.id);
      send(toolInputDeltaFrame(meta, index, event.text));
      break;
    }
    case "tool-call": {
      // The openai-compatible protocol streams input via tool-input-*; only
      // synthesize a frame when a provider reported the call without deltas.
      const index = toolIndexFor(state, event.id);
      if (!state.deltaed.has(event.id)) {
        const args = JSON.stringify(event.input ?? {});
        if (state.started.has(event.id)) send(toolInputDeltaFrame(meta, index, args));
        else send(toolCallFrame(meta, index, event.id, event.name, args));
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

function chatStreamDialect(
  model: GatewayModel,
  inboundId: string,
  cost?: ModelCost | null,
): StreamDialect<StreamState> {
  const meta = chunkMeta(inboundId);
  return {
    state: () => newStreamState(),
    open: (send) => send(roleFrame(meta)),
    event: (e, send, state) => emit(e, state, meta, send),
    close: (send, state) => {
      send(finishFrame(meta, state.finishReason));
      if (state.usage) send(usageFrame(meta, state.usage));
      send(DONE_FRAME);
    },
    error: (message, send) => {
      send(`data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
      send(DONE_FRAME);
    },
    meta: (state): AdapterMeta =>
      metaOf({ usage: state.usage, finishReason: { normalized: state.finishReason } }, model, cost),
  };
}

const chatDialect: InboundDialect = {
  render: (res, inboundId) => responseFromIR(res, inboundId),
  stream: (model, inboundId, cost) => chatStreamDialect(model, inboundId, cost),
};

export function createOpenCodeAdapter(deps: AdapterDeps): Adapter {
  return {
    async handle({ upstream, model, body, signal, cost }: AdapterInput): Promise<AdapterResult> {
      const inboundId = typeof body.model === "string" ? body.model : model.id;
      return runGeneration(
        deps,
        { upstream, model, chatBody: body, inboundId, signal, cost },
        chatDialect,
      );
    },
  };
}
