// Inbound adapter for the OpenAI Responses API (`POST /v1/responses`).
//
// The Responses wire format is normalized to a Chat Completions body so the
// shared `runGeneration` pipeline (dropParams -> capability gating -> IR ->
// @opencode/ai) is reused unchanged. Output is rendered back into Responses
// objects/frames. Stateful Responses features (previous_response_id,
// conversation, store:true) are rejected before any upstream work.
import type { LLMEvent, LLMResponse, Usage } from "@opencode/ai";
import type { GatewayModel } from "../config";
import type { ModelCost } from "../cost";
import { errorResponse } from "../ops/errors";
import type { AdapterDeps } from "./index";
import { asArray, asRecord } from "./content";
import { runGeneration, type InboundDialect } from "./core";
import type { StreamDialect } from "./stream";
import { metaOf } from "./translate";
import type { Adapter, AdapterInput, AdapterResult } from "./types";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

// ---------------------------------------------------------------------------
// Responses request -> Chat Completions body
// ---------------------------------------------------------------------------

/** Flatten a `function_call_output.output` (raw string or input_text parts) to one string. */
function flattenOutput(output: unknown): string {
  const s = asString(output);
  if (s !== null) return s;
  if (Array.isArray(output)) {
    let text = "";
    for (const raw of output) {
      const part = asRecord(raw);
      const t = part ? asString(part.text) : null;
      if (t !== null) text += t;
    }
    return text;
  }
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

/** The image URL carried by an `input_image` part (`image_url` string or `{url}`). */
function imageUrlOf(part: Record<string, unknown>): string | null {
  const raw = part.image_url;
  const s = asString(raw);
  if (s !== null) return s;
  const r = asRecord(raw);
  return r ? asString(r.url) : null;
}

/** Normalize a message item's `content` (string kept; parts mapped to chat parts). */
function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const parts: Array<Record<string, unknown>> = [];
  for (const raw of content) {
    const p = asRecord(raw);
    if (!p) continue;
    if (p.type === "input_text" || p.type === "output_text") {
      const text = asString(p.text);
      if (text !== null) parts.push({ type: "text", text });
    } else if (p.type === "input_image") {
      const url = imageUrlOf(p);
      if (url !== null) parts.push({ type: "image_url", image_url: { url } });
    } else if (p.type === "input_file") {
      const fileData = asString(p.file_data);
      if (fileData !== null && isDataUrl(fileData)) parts.push({ type: "image_url", image_url: { url: fileData } });
      // Non data-URL files (and other part types) are dropped.
    }
  }
  return parts;
}

function normalizeTools(tools: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of asArray(tools)) {
    const tool = asRecord(raw);
    if (!tool || tool.type !== "function") continue;
    out.push({
      type: "function",
      function: {
        name: asString(tool.name) ?? "",
        description: asString(tool.description) ?? "",
        parameters: asRecord(tool.parameters) ?? {},
      },
    });
  }
  return out;
}

function normalizeToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
  const r = asRecord(toolChoice);
  if (r && r.type === "function") {
    const name = asString(r.name);
    if (name !== null) return { type: "function", function: { name } };
  }
  return undefined; // allowed_tools and anything else unsupported here are dropped
}

/**
 * Translate a Responses request body into the Chat Completions shape the shared
 * pipeline consumes. `input` may be a string or an array of items (`message`,
 * `function_call`, `function_call_output`, `reasoning`, hosted tools).
 */
export function responsesToChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const instructions = asString(body.instructions);
  if (instructions !== null && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      const item = asRecord(raw);
      if (!item) continue;
      const type = asString(item.type);
      if (type === "function_call") {
        const callId = asString(item.call_id) ?? "";
        const name = asString(item.name) ?? "";
        const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
        messages.push({
          role: "assistant",
          tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
        });
        continue;
      }
      if (type === "function_call_output") {
        const callId = asString(item.call_id) ?? "";
        messages.push({ role: "tool", tool_call_id: callId, content: flattenOutput(item.output) });
        continue;
      }
      if (type === "reasoning") continue; // hosted/stateful reasoning is dropped
      const role = asString(item.role);
      if (role === null) continue; // hosted-tool output items carry no chat role
      messages.push({ role, content: normalizeContent(item.content) });
    }
  }

  const chat: Record<string, unknown> = { messages };
  if (typeof body.model === "string") chat.model = body.model;
  if (body.stream !== undefined) chat.stream = body.stream;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.frequency_penalty !== undefined) chat.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) chat.presence_penalty = body.presence_penalty;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  const tools = normalizeTools(body.tools);
  if (tools.length) chat.tools = tools;
  const toolChoice = normalizeToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  return chat;
}

/** Reject Responses features the gateway does not implement (stateless proxy only). */
export function unsupportedResponsesParam(body: Record<string, unknown>): Response | null {
  const reject = (param: string): Response =>
    errorResponse(`unsupported parameter: ${param}`, 400, "invalid_request_error", {
      code: "unsupported_parameter",
    });
  if (body.previous_response_id !== undefined) return reject("previous_response_id");
  if (body.conversation !== undefined) return reject("conversation");
  if (body.store === true) return reject("store");
  return null;
}

// ---------------------------------------------------------------------------
// LLM IR -> Responses objects
// ---------------------------------------------------------------------------

interface ResponseStatus {
  status: "completed" | "incomplete";
  incompleteDetails: Record<string, unknown> | null;
}

function statusOf(normalized: string): ResponseStatus {
  if (normalized === "length") {
    return { status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } };
  }
  if (normalized === "content-filter") {
    return { status: "incomplete", incompleteDetails: { reason: "content_filter" } };
  }
  return { status: "completed", incompleteDetails: null };
}

function reasoningItem(id: string, text: string): Record<string, unknown> {
  return { type: "reasoning", id, summary: [{ type: "summary_text", text }] };
}

function messageItem(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function functionCallItem(id: string, callId: string, name: string, args: string): Record<string, unknown> {
  return { type: "function_call", id, call_id: callId, name, arguments: args, status: "completed" };
}

function responsesUsage(usage: Usage | null | undefined): Record<string, unknown> {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const total = usage?.totalTokens ?? input + output;
  const out: Record<string, unknown> = { input_tokens: input, output_tokens: output, total_tokens: total };
  if (usage?.cacheReadInputTokens !== undefined) out.input_tokens_details = { cached_tokens: usage.cacheReadInputTokens };
  if (usage?.reasoningTokens !== undefined) out.output_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  return out;
}

/** Build the OpenAI `response` object for a completed (non-stream) generation. */
export function responseObjectFromIR(res: LLMResponse, modelId: string): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];
  if (res.reasoning.length > 0) output.push(reasoningItem(`rs_${crypto.randomUUID()}`, res.reasoning));
  if (res.text.length > 0 || res.toolCalls.length === 0) {
    output.push(messageItem(`msg_${crypto.randomUUID()}`, res.text));
  }
  for (const call of res.toolCalls) {
    output.push(
      functionCallItem(`fc_${crypto.randomUUID()}`, call.id, call.name, JSON.stringify(call.input ?? {})),
    );
  }
  const { status, incompleteDetails } = statusOf(res.finishReason.normalized);
  return {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: modelId,
    output,
    usage: responsesUsage(res.usage),
    error: null,
    incomplete_details: incompleteDetails,
  };
}

// ---------------------------------------------------------------------------
// Streaming dialect
// ---------------------------------------------------------------------------

export function responsesFrame(type: string, seq: number, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...payload })}\n\n`;
}

interface ToolAccum {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  index: number;
  open: boolean;
  deltaed: boolean;
  closed: boolean;
}

interface ResponsesState {
  seq: number;
  responseId: string;
  createdAt: number;
  model: string;
  outputIndex: number;
  reasoningId: string;
  reasoningText: string;
  reasoningIndex: number;
  reasoningOpen: boolean;
  reasoningClosed: boolean;
  messageId: string;
  messageText: string;
  messageIndex: number;
  messageOpen: boolean;
  messageClosed: boolean;
  tools: Map<string, ToolAccum>;
  toolOrder: string[];
  usage: Usage | null;
  finishReason: string;
}

function newResponsesState(model: string): ResponsesState {
  return {
    seq: 0,
    responseId: `resp_${crypto.randomUUID()}`,
    createdAt: Math.floor(Date.now() / 1000),
    model,
    outputIndex: 0,
    reasoningId: "",
    reasoningText: "",
    reasoningIndex: 0,
    reasoningOpen: false,
    reasoningClosed: false,
    messageId: "",
    messageText: "",
    messageIndex: 0,
    messageOpen: false,
    messageClosed: false,
    tools: new Map(),
    toolOrder: [],
    usage: null,
    finishReason: "stop",
  };
}

function responsesStreamDialect(
  model: GatewayModel,
  inboundId: string,
  cost?: ModelCost | null,
): StreamDialect<ResponsesState> {
  let current: ResponsesState | null = null;

  const emit = (state: ResponsesState, send: (frame: string) => void, type: string, payload: Record<string, unknown>): void => {
    send(responsesFrame(type, state.seq, payload));
    state.seq += 1;
  };

  const ensureTool = (
    state: ResponsesState,
    send: (frame: string) => void,
    id: string,
    name: string,
  ): ToolAccum => {
    let tool = state.tools.get(id);
    if (!tool) {
      tool = {
        itemId: `fc_${crypto.randomUUID()}`,
        callId: id,
        name,
        args: "",
        index: state.outputIndex,
        open: false,
        deltaed: false,
        closed: false,
      };
      state.tools.set(id, tool);
      state.toolOrder.push(id);
      state.outputIndex += 1;
    }
    if (name.length > 0 && tool.name.length === 0) tool.name = name;
    if (!tool.open) {
      emit(state, send, "response.output_item.added", {
        output_index: tool.index,
        item: { type: "function_call", id: tool.itemId, call_id: tool.callId, name: tool.name, arguments: "" },
      });
      tool.open = true;
    }
    return tool;
  };

  return {
    state: () => {
      current = newResponsesState(inboundId);
      return current;
    },
    open: (send, state) => {
      emit(state, send, "response.created", {
        response: {
          id: state.responseId,
          object: "response",
          created_at: state.createdAt,
          status: "in_progress",
          model: state.model,
          output: [],
        },
      });
    },
    event: (e: LLMEvent, send, state) => {
      switch (e.type) {
        case "text-delta": {
          if (!state.messageOpen) {
            state.messageId = `msg_${crypto.randomUUID()}`;
            state.messageIndex = state.outputIndex;
            state.outputIndex += 1;
            emit(state, send, "response.output_item.added", {
              output_index: state.messageIndex,
              item: { type: "message", id: state.messageId, role: "assistant", status: "in_progress", content: [] },
            });
            state.messageOpen = true;
          }
          state.messageText += e.text;
          emit(state, send, "response.output_text.delta", {
            item_id: state.messageId,
            output_index: state.messageIndex,
            content_index: 0,
            delta: e.text,
          });
          break;
        }
        case "reasoning-delta": {
          if (!state.reasoningOpen) {
            state.reasoningId = `rs_${crypto.randomUUID()}`;
            state.reasoningIndex = state.outputIndex;
            state.outputIndex += 1;
            emit(state, send, "response.output_item.added", {
              output_index: state.reasoningIndex,
              item: { type: "reasoning", id: state.reasoningId, summary: [] },
            });
            emit(state, send, "response.reasoning_summary_part.added", {
              item_id: state.reasoningId,
              output_index: state.reasoningIndex,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            });
            state.reasoningOpen = true;
          }
          state.reasoningText += e.text;
          emit(state, send, "response.reasoning_summary_text.delta", {
            item_id: state.reasoningId,
            output_index: state.reasoningIndex,
            summary_index: 0,
            delta: e.text,
          });
          break;
        }
        case "tool-input-start": {
          ensureTool(state, send, e.id, e.name);
          break;
        }
        case "tool-input-delta": {
          const tool = ensureTool(state, send, e.id, "");
          tool.deltaed = true;
          tool.args += e.text;
          emit(state, send, "response.function_call_arguments.delta", {
            item_id: tool.itemId,
            output_index: tool.index,
            delta: e.text,
          });
          break;
        }
        case "tool-call": {
          const tool = ensureTool(state, send, e.id, e.name);
          if (!tool.deltaed) {
            const args = JSON.stringify(e.input ?? {});
            tool.deltaed = true;
            tool.args += args;
            emit(state, send, "response.function_call_arguments.delta", {
              item_id: tool.itemId,
              output_index: tool.index,
              delta: args,
            });
          }
          break;
        }
        case "step-finish":
          if (e.usage) state.usage = e.usage;
          break;
        case "finish":
          if (e.usage) state.usage = e.usage;
          state.finishReason = e.reason.normalized;
          break;
        default:
          break;
      }
    },
    close: (send, state) => {
      if (state.reasoningOpen && !state.reasoningClosed) {
        emit(state, send, "response.reasoning_summary_text.done", {
          item_id: state.reasoningId,
          output_index: state.reasoningIndex,
          summary_index: 0,
          text: state.reasoningText,
        });
        emit(state, send, "response.reasoning_summary_part.done", {
          item_id: state.reasoningId,
          output_index: state.reasoningIndex,
          summary_index: 0,
          part: { type: "summary_text", text: state.reasoningText },
        });
        emit(state, send, "response.output_item.done", {
          output_index: state.reasoningIndex,
          item: reasoningItem(state.reasoningId, state.reasoningText),
        });
        state.reasoningClosed = true;
      }
      if (state.messageOpen && !state.messageClosed) {
        emit(state, send, "response.output_text.done", {
          item_id: state.messageId,
          output_index: state.messageIndex,
          content_index: 0,
          text: state.messageText,
        });
        emit(state, send, "response.output_item.done", {
          output_index: state.messageIndex,
          item: messageItem(state.messageId, state.messageText),
        });
        state.messageClosed = true;
      }
      for (const id of state.toolOrder) {
        const tool = state.tools.get(id);
        if (!tool || tool.closed) continue;
        emit(state, send, "response.function_call_arguments.done", {
          item_id: tool.itemId,
          output_index: tool.index,
          arguments: tool.args,
        });
        emit(state, send, "response.output_item.done", {
          output_index: tool.index,
          item: functionCallItem(tool.itemId, tool.callId, tool.name, tool.args),
        });
        tool.closed = true;
      }

      // Terminal event: the FULLY ASSEMBLED response, in output order.
      const ordered: Array<{ index: number; item: Record<string, unknown> }> = [];
      if (state.reasoningOpen) {
        ordered.push({ index: state.reasoningIndex, item: reasoningItem(state.reasoningId, state.reasoningText) });
      }
      if (state.messageOpen) {
        ordered.push({ index: state.messageIndex, item: messageItem(state.messageId, state.messageText) });
      }
      for (const id of state.toolOrder) {
        const tool = state.tools.get(id);
        if (!tool) continue;
        ordered.push({ index: tool.index, item: functionCallItem(tool.itemId, tool.callId, tool.name, tool.args) });
      }
      ordered.sort((a, b) => a.index - b.index);
      const { status, incompleteDetails } = statusOf(state.finishReason);
      const type = status === "incomplete" ? "response.incomplete" : "response.completed";
      emit(state, send, type, {
        response: {
          id: state.responseId,
          object: "response",
          created_at: state.createdAt,
          status,
          model: state.model,
          output: ordered.map((entry) => entry.item),
          usage: responsesUsage(state.usage),
          error: null,
          incomplete_details: incompleteDetails,
        },
      });
    },
    error: (message, send) => {
      const seq = current?.seq ?? 0;
      send(
        responsesFrame("response.failed", seq, {
          response: { status: "failed", error: { code: "server_error", message } },
        }),
      );
    },
    meta: (state) => metaOf({ usage: state.usage, finishReason: { normalized: state.finishReason } }, model, cost),
  };
}

const responsesDialect: InboundDialect = {
  render: (res, inboundId) => responseObjectFromIR(res, inboundId),
  stream: (model, inboundId, cost) => responsesStreamDialect(model, inboundId, cost),
};

export function createResponsesAdapter(deps: AdapterDeps): Adapter {
  return {
    async handle(input: AdapterInput): Promise<AdapterResult> {
      const reject = unsupportedResponsesParam(input.body);
      if (reject) return { response: reject };
      const chatBody = responsesToChat(input.body);
      const inboundId = typeof input.body.model === "string" ? input.body.model : input.model.id;
      return runGeneration(
        deps,
        { upstream: input.upstream, model: input.model, chatBody, inboundId, signal: input.signal, cost: input.cost },
        responsesDialect,
      );
    },
  };
}
