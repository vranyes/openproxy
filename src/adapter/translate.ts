// Pure OpenAI Chat Completions <-> @opencode/ai LLM IR translation.
//
// No I/O lives here: every function is a deterministic transform so the mapping
// can be unit-tested without a provider. The streaming frame builders take an
// explicit `ChunkMeta` (id/created/model) rather than reading the clock, so a
// test can pin them.
import { Media } from "@opencode/ai";
import type {
  ContentPart,
  GenerationOptions,
  LLMResponse,
  Message,
  SystemPart,
  ToolChoice,
  ToolEntryInput,
  Usage,
} from "@opencode/ai";
import type { GatewayModel } from "../config";
import { costUsd, type ModelCost } from "../cost";
import type { AdapterMeta, TokenUsage } from "./types";

// ---------------------------------------------------------------------------
// OpenAI body -> LLM IR
// ---------------------------------------------------------------------------

export interface IRInput {
  system: SystemPart[];
  messages: Message.Input[];
  tools: ToolEntryInput[];
  toolChoice?: ToolChoice.Input;
  generation?: GenerationOptions.Input;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Flatten a text-ish content value (string or text parts) into one string. */
function contentText(content: unknown): string {
  const s = asString(content);
  if (s !== null) return s;
  const parts: string[] = [];
  for (const raw of asArray(content)) {
    const p = asRecord(raw);
    if (p && p.type === "text") {
      const t = asString(p.text);
      if (t !== null) parts.push(t);
    }
  }
  return parts.join("");
}

function parseToolArguments(value: unknown): unknown {
  const s = asString(value);
  if (s === null || s.length === 0) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function inferImageMediaType(url: string): string {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
  switch (match?.[1]?.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function mediaPart(url: string): ContentPart {
  // OpenAI's `image_url` carries no media type. A data URL is self-describing;
  // for a remote URL, infer one from the path so the asset's kind is `image`
  // (the runtime rejects an `other` media asset with a 400).
  const asset = Media.parseDataUrl(url) ?? Media.url(url, { mediaType: inferImageMediaType(url) });
  return { type: "media", media: asset };
}

function userContent(content: unknown): ContentPart[] {
  const s = asString(content);
  if (s !== null) return [{ type: "text", text: s }];
  const parts: ContentPart[] = [];
  for (const raw of asArray(content)) {
    const p = asRecord(raw);
    if (!p) continue;
    if (p.type === "text") {
      const t = asString(p.text);
      if (t !== null) parts.push({ type: "text", text: t });
    } else if (p.type === "image_url") {
      const imageUrl = asRecord(p.image_url);
      const url = imageUrl && asString(imageUrl.url);
      if (url !== null) parts.push(mediaPart(url));
    }
  }
  return parts;
}

function lowerToolChoice(value: unknown): ToolChoice.Input | undefined {
  if (value === "auto" || value === "none" || value === "required") return { type: value };
  const r = asRecord(value);
  if (r && r.type === "function") {
    const fn = asRecord(r.function);
    const name = fn ? asString(fn.name) : null;
    if (name !== null) return { type: "tool", name };
  }
  return undefined;
}

function lowerGeneration(body: Record<string, unknown>): GenerationOptions.Input | undefined {
  const generation: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
    stop?: string[];
  } = {};
  const maxTokens = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens);
  if (maxTokens !== undefined) generation.maxTokens = maxTokens;
  const temperature = asNumber(body.temperature);
  if (temperature !== undefined) generation.temperature = temperature;
  const topP = asNumber(body.top_p);
  if (topP !== undefined) generation.topP = topP;
  const frequencyPenalty = asNumber(body.frequency_penalty);
  if (frequencyPenalty !== undefined) generation.frequencyPenalty = frequencyPenalty;
  const presencePenalty = asNumber(body.presence_penalty);
  if (presencePenalty !== undefined) generation.presencePenalty = presencePenalty;
  const seed = asNumber(body.seed);
  if (seed !== undefined) generation.seed = seed;
  const stop = body.stop;
  if (typeof stop === "string") generation.stop = [stop];
  else if (Array.isArray(stop)) {
    const stops = stop.filter((s): s is string => typeof s === "string");
    if (stops.length) generation.stop = stops;
  }
  return Object.keys(generation).length ? generation : undefined;
}

/**
 * Translate an OpenAI Chat Completions request body into the provider-neutral
 * IR. System (and developer) messages are hoisted into the top-level `system`
 * prompt because a `role:"system"` message would be re-wrapped by the runtime.
 */
export function openaiToIR(body: Record<string, unknown>, _model?: GatewayModel): IRInput {
  const systemTexts: string[] = [];
  const messages: Message.Input[] = [];

  for (const raw of asArray(body.messages)) {
    const m = asRecord(raw);
    if (!m) continue;
    const role = asString(m.role) ?? "";
    if (role === "system" || role === "developer") {
      const text = contentText(m.content);
      if (text.length) systemTexts.push(text);
      continue;
    }
    if (role === "user") {
      messages.push({ role: "user", content: userContent(m.content) });
      continue;
    }
    if (role === "assistant") {
      const content: ContentPart[] = [];
      const text = contentText(m.content);
      if (text.length) content.push({ type: "text", text });
      for (const rawCall of asArray(m.tool_calls)) {
        const call = asRecord(rawCall);
        const fn = call ? asRecord(call.function) : null;
        if (!call || !fn) continue;
        content.push({
          type: "tool-call",
          id: asString(call.id) ?? "",
          name: asString(fn.name) ?? "",
          input: parseToolArguments(fn.arguments),
        });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    if (role === "tool") {
      const value = asString(m.content) ?? contentText(m.content);
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: asString(m.tool_call_id) ?? "",
            name: asString(m.name) ?? "",
            result: { type: "text", value },
          },
        ],
      });
      continue;
    }
  }

  const system: SystemPart[] = systemTexts.length ? [{ type: "text", text: systemTexts.join("\n\n") }] : [];

  const tools: ToolEntryInput[] = [];
  for (const rawTool of asArray(body.tools)) {
    const tool = asRecord(rawTool);
    if (!tool || tool.type !== "function") continue;
    const fn = asRecord(tool.function);
    if (!fn) continue;
    tools.push({
      name: asString(fn.name) ?? "",
      description: asString(fn.description) ?? "",
      inputSchema: asRecord(fn.parameters) ?? {},
    });
  }

  return {
    system,
    messages,
    tools,
    toolChoice: lowerToolChoice(body.tool_choice),
    generation: lowerGeneration(body),
  };
}

// ---------------------------------------------------------------------------
// LLM IR -> OpenAI response
// ---------------------------------------------------------------------------

export function toOpenAiFinishReason(normalized: string): string {
  switch (normalized) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    case "error":
      return "stop";
    default:
      return "stop";
  }
}

function usageFields(usage: Usage | undefined): Record<string, unknown> {
  const prompt = usage?.inputTokens ?? 0;
  const completion = usage?.outputTokens ?? 0;
  const total = usage?.totalTokens ?? prompt + completion;
  const out: Record<string, unknown> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
  if (usage?.reasoningTokens !== undefined) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return out;
}

/** Build the OpenAI `chat.completion` object for a completed (non-stream) generation. */
export function responseFromIR(res: LLMResponse, modelId: string): Record<string, unknown> {
  const toolCalls = res.toolCalls;
  const content = res.text.length > 0 ? res.text : toolCalls.length > 0 ? null : "";
  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
    }));
  }
  if (res.reasoning.length) message.reasoning_content = res.reasoning;
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toOpenAiFinishReason(res.finishReason.normalized),
      },
    ],
    usage: usageFields(res.usage),
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** A response or a bare usage, whichever the caller has. */
export type MetaSource = LLMResponse | Usage | { usage?: Usage | null; finishReason?: { normalized?: string } | null };

/**
 * Derive the `generation` log metrics. `contextTokens` (the effective input size
 * of the final iteration) is preferred over billed `inputTokens` when present;
 * every field is read defensively and defaults to null rather than 0.
 *
 * `cost` is the resolved pricing (USD per 1e6 tokens). When supplied and the
 * usage is sufficient, `costUsd` carries the estimate for the request; an
 * unknown price for any billed category yields null (never a guess).
 */
export function metaOf(
  source: MetaSource | null | undefined,
  model: GatewayModel,
  cost?: ModelCost | null,
): AdapterMeta {
  const withUsage = source as { usage?: Usage | null } | null | undefined;
  const usage = (withUsage?.usage ?? (source as Usage | null | undefined)) ?? undefined;
  const finishReason =
    ((source as { finishReason?: { normalized?: string } | null } | null | undefined)?.finishReason?.normalized) ?? null;
  const tokensIn = usage?.contextTokens ?? usage?.inputTokens ?? null;
  const tokensOut = usage?.outputTokens ?? null;
  const tokensTotal = usage?.totalTokens ?? null;
  const contextRatio = tokensIn !== null && model.context !== undefined ? tokensIn / model.context : null;

  // Cache counts are surfaced only when the provider reported them, so a source
  // without cache metrics keeps the exact three-field `usage` shape.
  const cacheReadTokens = usage?.cacheReadInputTokens ?? null;
  const cacheWriteTokens = usage?.cacheWriteInputTokens ?? null;

  let usageOut: TokenUsage | null = null;
  if (tokensIn !== null || tokensOut !== null || tokensTotal !== null) {
    usageOut = { tokensIn, tokensOut, tokensTotal };
    if (cacheReadTokens !== null) usageOut.cacheReadTokens = cacheReadTokens;
    if (cacheWriteTokens !== null) usageOut.cacheWriteTokens = cacheWriteTokens;
  }

  // Billed (non-cached) input: prefer the provider's breakdown; otherwise
  // subtract cached portions from the inclusive input total, clamped at zero.
  const nonCachedInputTokens =
    usage?.nonCachedInputTokens ??
    (usage?.inputTokens != null
      ? Math.max(0, usage.inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0))
      : null);

  const costUsdValue = costUsd(
    { nonCachedInputTokens, outputTokens: tokensOut, cacheReadTokens, cacheWriteTokens },
    cost,
  );

  return {
    usage: usageOut,
    contextRatio,
    finishReason,
    costUsd: costUsdValue,
  };
}

// ---------------------------------------------------------------------------
// Streaming frames
// ---------------------------------------------------------------------------

export interface ChunkMeta {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
}

/** Identity for one SSE response. Impure (clock + UUID); callers pin it in tests. */
export function chunkMeta(modelId: string): ChunkMeta {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
  };
}

function frame(meta: ChunkMeta, delta: Record<string, unknown>, finishReason: string | null): string {
  const chunk = {
    ...meta,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const DONE_FRAME = "data: [DONE]\n\n";

export function roleFrame(meta: ChunkMeta): string {
  return frame(meta, { role: "assistant", content: "" }, null);
}

export function textDeltaFrame(meta: ChunkMeta, text: string): string {
  return frame(meta, { content: text }, null);
}

export function reasoningDeltaFrame(meta: ChunkMeta, text: string): string {
  return frame(meta, { reasoning_content: text }, null);
}

export function toolInputStartFrame(meta: ChunkMeta, index: number, id: string, name: string): string {
  return frame(meta, { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] }, null);
}

export function toolInputDeltaFrame(meta: ChunkMeta, index: number, args: string): string {
  return frame(meta, { tool_calls: [{ index, function: { arguments: args } }] }, null);
}

export function toolCallFrame(meta: ChunkMeta, index: number, id: string, name: string, args: string): string {
  return frame(meta, { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] }, null);
}

export function finishFrame(meta: ChunkMeta, finishReason: string): string {
  return frame(meta, {}, finishReason);
}

export function usageFrame(meta: ChunkMeta, usage: Usage | null): string {
  const chunk = { ...meta, choices: [], usage: usageFields(usage ?? undefined) };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
