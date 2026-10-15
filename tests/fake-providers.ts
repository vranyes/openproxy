// Wire emitters for each provider dialect the F5 `opencode` adapter dispatches
// to. Each builder returns an SSE body (or a ready `Response`) to pair with the
// real `fakeUpstreamServer` from ./helpers. The frames were verified against the
// installed @opencode/ai runtime, so they are behavior-faithful, not guesses.
import { fakeUpstreamServer } from "./helpers";

/** Run `fn` against a real HTTP fake upstream, always stopping it afterwards. */
export async function withUpstream<T>(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (baseURL: string) => Promise<T>,
): Promise<T> {
  const up = fakeUpstreamServer(handler);
  try {
    return await fn(up.url);
  } finally {
    up.stop();
  }
}

export function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export function jsonError(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A provider-shaped context-overflow rejection; @opencode/ai classifies the phrase. */
export const OVERFLOW_MESSAGE = "This model's maximum context length is 5 tokens.";
export function overflowError(status = 400): Response {
  return jsonError(status, { error: { message: OVERFLOW_MESSAGE } });
}

export function rateLimitError(retryAfter = "9"): Response {
  return jsonError(429, { error: { message: "rate limited" } }, { "retry-after": retryAfter });
}

/** An OpenAI Chat Completions gateway request body. */
export function gatewayChatRequest(model: string, body: Record<string, unknown> = {}): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...body }),
  });
}

// ---------------------------------------------------------------------------
// Anthropic Messages (named `event:` SSE lines)
// ---------------------------------------------------------------------------

export function anthropicEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function anthropicMessageStart(inputTokens: number): string {
  return anthropicEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_up",
      type: "message",
      role: "assistant",
      model: "up-model",
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

function anthropicMessageDelta(stopReason: string, outputTokens: number): string {
  return (
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }) + anthropicEvent("message_stop", { type: "message_stop" })
  );
}

export function anthropicTextStream(text: string, usage: [number, number] = [5, 2]): string {
  return (
    anthropicMessageStart(usage[0]) +
    anthropicEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    anthropicEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    anthropicMessageDelta("end_turn", usage[1])
  );
}

export function anthropicToolStream(
  { id = "toolu_up", name = "get_weather", args = '{"city":"Paris"}', usage = [3, 4] as [number, number] } = {},
): string {
  return (
    anthropicMessageStart(usage[0]) +
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    }) +
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: args },
    }) +
    anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    anthropicMessageDelta("tool_use", usage[1])
  );
}

// ---------------------------------------------------------------------------
// OpenAI Responses (plain `data:` JSON frames, no `event:` line)
// ---------------------------------------------------------------------------

export function responsesEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function responsesUsage([input, output, total]: [number, number, number]): Record<string, number> {
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

export function responsesTextStream(text: string, usage: [number, number, number] = [5, 2, 7]): string {
  return (
    responsesEvent({ type: "response.created", response: { id: "resp_up" } }) +
    responsesEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_up", role: "assistant", content: [], status: "in_progress" },
    }) +
    responsesEvent({ type: "response.output_text.delta", item_id: "msg_up", output_index: 0, content_index: 0, delta: text }) +
    responsesEvent({ type: "response.output_text.done", item_id: "msg_up", output_index: 0, content_index: 0, text }) +
    responsesEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_up",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }) +
    responsesEvent({ type: "response.completed", response: { id: "resp_up", output: [], usage: responsesUsage(usage) } })
  );
}

export function responsesToolStream(
  { callId = "call_up", name = "get_weather", args = '{"city":"Paris"}', usage = [3, 4, 7] as [number, number, number] } = {},
): string {
  return (
    responsesEvent({ type: "response.created", response: { id: "resp_up" } }) +
    responsesEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_up", call_id: callId, name, arguments: "" },
    }) +
    responsesEvent({ type: "response.function_call_arguments.delta", item_id: "fc_up", output_index: 0, delta: args }) +
    responsesEvent({ type: "response.function_call_arguments.done", item_id: "fc_up", output_index: 0, arguments: args }) +
    responsesEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "fc_up", call_id: callId, name, arguments: args },
    }) +
    responsesEvent({ type: "response.completed", response: { id: "resp_up", output: [], usage: responsesUsage(usage) } })
  );
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (`data:` chunks + `data: [DONE]`)
// ---------------------------------------------------------------------------

export const CHAT_DONE = "data: [DONE]\n\n";

export function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    created: 1,
    model: "up-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chatUsageChunk(prompt: number, completion: number, total: number): string {
  const payload = {
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    created: 1,
    model: "up-model",
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chatTextStream(text: string, usage: [number, number, number] = [5, 2, 7]): string {
  let out = chatChunk({ role: "assistant", content: "" });
  for (const c of text) out += chatChunk({ content: c });
  out += chatChunk({}, "stop");
  out += chatUsageChunk(usage[0], usage[1], usage[2]);
  out += CHAT_DONE;
  return out;
}

export function chatToolStream(
  { id = "call_up", name = "get_weather", args = '{"city":"Paris"}', usage = [3, 4, 7] as [number, number, number] } = {},
): string {
  let out = chatChunk({
    role: "assistant",
    tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
  });
  out += chatChunk({ tool_calls: [{ index: 0, function: { arguments: args } }] });
  out += chatChunk({}, "tool_calls");
  out += chatUsageChunk(usage[0], usage[1], usage[2]);
  out += CHAT_DONE;
  return out;
}
