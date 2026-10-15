import { describe, expect, test } from "bun:test";
import { AIError, InvalidRequestError } from "@opencode/ai";
import type { Usage } from "@opencode/ai";
import type { GatewayModel } from "../src/config";
import { aiErrorResponse } from "../src/adapter/ai-error";
import {
  chunkMeta,
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
} from "../src/adapter/translate";

// Loose structural views of the IR unions for assertions.
type Part = {
  type: string;
  text?: string;
  media?: { mediaType?: string; source?: { type?: string; url?: string } };
  id?: string;
  name?: string;
  input?: unknown;
  result?: { type?: string; value?: unknown };
};
type IRMessage = { role: string; content: string | Part[] };

const model: GatewayModel = { id: "m", context: 100, maxOutput: 50 };

function parts(message: IRMessage): Part[] {
  return Array.isArray(message.content) ? message.content : [];
}

describe("openaiToIR: system hoist", () => {
  test("joins system messages into one top-level SystemPart and drops them from messages", () => {
    const ir = openaiToIR({
      messages: [
        { role: "system", content: "first" },
        { role: "system", content: "second" },
        { role: "user", content: "hi" },
      ],
    });
    expect(ir.system).toEqual([{ type: "text", text: "first\n\nsecond" }]);
    expect(ir.messages).toHaveLength(1);
    expect(ir.messages[0]!.role).toBe("user");
    // SystemPart objects, never plain strings (plain strings throw in the runtime).
    expect(typeof ir.system[0]).toBe("object");
  });

  test("developer messages are hoisted too", () => {
    const ir = openaiToIR({ messages: [{ role: "developer", content: "policy" }, { role: "user", content: "x" }] });
    expect(ir.system).toEqual([{ type: "text", text: "policy" }]);
  });

  test("no system messages yields an empty array", () => {
    expect(openaiToIR({ messages: [{ role: "user", content: "x" }] }).system).toEqual([]);
  });
});

describe("openaiToIR: content forms", () => {
  test("user string content becomes a single text part", () => {
    const ir = openaiToIR({ messages: [{ role: "user", content: "hello" }] });
    expect(parts(ir.messages[0] as IRMessage)).toEqual([{ type: "text", text: "hello" }]);
  });

  test("user array content maps text and image parts", () => {
    const ir = openaiToIR({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://example.test/a.png" } },
          ],
        },
      ],
    });
    const content = parts(ir.messages[0] as IRMessage);
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]!.type).toBe("media");
    expect(content[1]!.media?.source?.type).toBe("base64");
    expect(content[2]!.type).toBe("media");
    expect(content[2]!.media?.source).toMatchObject({ type: "url", url: "https://example.test/a.png" });
  });
});

describe("openaiToIR: tools", () => {
  test("function tools become {name, description, inputSchema}", () => {
    const ir = openaiToIR({
      messages: [],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    });
    expect(ir.tools).toEqual([{ name: "f", description: "d", inputSchema: { type: "object" } }]);
  });

  test("returns an empty tools array when none are given", () => {
    expect(openaiToIR({ messages: [] }).tools).toEqual([]);
  });

  test("tool_choice auto/none/required pass through", () => {
    expect(openaiToIR({ messages: [], tool_choice: "auto" }).toolChoice).toEqual({ type: "auto" });
    expect(openaiToIR({ messages: [], tool_choice: "none" }).toolChoice).toEqual({ type: "none" });
    expect(openaiToIR({ messages: [], tool_choice: "required" }).toolChoice).toEqual({ type: "required" });
  });

  test("tool_choice function becomes a named tool choice", () => {
    expect(openaiToIR({ messages: [], tool_choice: { type: "function", function: { name: "f" } } }).toolChoice).toEqual({
      type: "tool",
      name: "f",
    });
  });
});

describe("openaiToIR: tool round trip", () => {
  test("assistant tool_calls become tool-call parts with parsed input", () => {
    const ir = openaiToIR({
      messages: [
        {
          role: "assistant",
          content: "thinking",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
        },
      ],
    });
    const content = parts(ir.messages[0] as IRMessage);
    expect(content[0]).toEqual({ type: "text", text: "thinking" });
    expect(content[1]).toMatchObject({ type: "tool-call", id: "call_1", name: "f", input: { a: 1 } });
  });

  test("an empty tool_calls arguments string parses to {}", () => {
    const ir = openaiToIR({
      messages: [{ role: "assistant", tool_calls: [{ id: "c", function: { name: "f", arguments: "" } }] }],
    });
    expect(parts(ir.messages[0] as IRMessage)[0]).toMatchObject({ type: "tool-call", input: {} });
  });

  test("a tool message becomes a tool-result part", () => {
    const ir = openaiToIR({
      messages: [{ role: "tool", tool_call_id: "call_1", name: "f", content: "42" }],
    });
    expect(parts(ir.messages[0] as IRMessage)[0]).toEqual({
      type: "tool-result",
      id: "call_1",
      name: "f",
      result: { type: "text", value: "42" },
    });
  });
});

describe("openaiToIR: generation normalization", () => {
  test("max_tokens and max_completion_tokens map to maxTokens", () => {
    expect(openaiToIR({ messages: [], max_tokens: 10 }).generation).toEqual({ maxTokens: 10 });
    expect(openaiToIR({ messages: [], max_completion_tokens: 20 }).generation).toEqual({ maxTokens: 20 });
    expect(openaiToIR({ messages: [], max_tokens: 10, max_completion_tokens: 20 }).generation).toEqual({ maxTokens: 10 });
  });

  test("snake_case params map to camelCase and stop string wraps in an array", () => {
    expect(
      openaiToIR({ messages: [], temperature: 0.5, top_p: 0.9, frequency_penalty: 1, presence_penalty: 2, seed: 7, stop: "END" }).generation,
    ).toEqual({ temperature: 0.5, topP: 0.9, frequencyPenalty: 1, presencePenalty: 2, seed: 7, stop: ["END"] });
  });

  test("no generation fields yields undefined", () => {
    expect(openaiToIR({ messages: [] }).generation).toBeUndefined();
  });
});

describe("toOpenAiFinishReason", () => {
  test("maps each normalized reason", () => {
    expect(toOpenAiFinishReason("stop")).toBe("stop");
    expect(toOpenAiFinishReason("length")).toBe("length");
    expect(toOpenAiFinishReason("tool-calls")).toBe("tool_calls");
    expect(toOpenAiFinishReason("content-filter")).toBe("content_filter");
    expect(toOpenAiFinishReason("error")).toBe("stop");
    expect(toOpenAiFinishReason("unknown")).toBe("stop");
  });
});

describe("responseFromIR", () => {
  const base = {
    text: "hi",
    reasoning: "",
    toolCalls: [],
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    finishReason: { normalized: "stop" },
  } as unknown as Parameters<typeof responseFromIR>[0];

  test("builds a chat.completion with content, usage and finish_reason", () => {
    const body = responseFromIR(base, "gw-model");
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gw-model");
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("chatcmpl-")).toBe(true);
    const choice = (body.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0]!;
    expect(choice.message).toEqual({ role: "assistant", content: "hi" });
    expect(choice.finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  test("null content with tool calls", () => {
    const res = {
      ...base,
      text: "",
      toolCalls: [{ id: "call_1", name: "f", input: { a: 1 } }],
      finishReason: { normalized: "tool-calls" },
    } as unknown as Parameters<typeof responseFromIR>[0];
    const body = responseFromIR(res, "m");
    const choice = (body.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0]!;
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
    expect(choice.finish_reason).toBe("tool_calls");
  });

  test("reasoning is surfaced as reasoning_content and reasoning tokens as details", () => {
    const res = {
      ...base,
      reasoning: "hmm",
      usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4, reasoningTokens: 2 },
    } as unknown as Parameters<typeof responseFromIR>[0];
    const body = responseFromIR(res, "m");
    const choice = (body.choices as Array<{ message: Record<string, unknown> }>)[0]!;
    expect(choice.message.reasoning_content).toBe("hmm");
    expect(body.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 3,
      total_tokens: 4,
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  });
});

describe("metaOf", () => {
  test("prefers contextTokens over inputTokens", () => {
    const meta = metaOf({ usage: { contextTokens: 40, inputTokens: 10 } as Usage }, model);
    expect(meta.usage).toEqual({ tokensIn: 40, tokensOut: null, tokensTotal: null });
    expect(meta.contextRatio).toBe(0.4);
  });

  test("falls back to inputTokens and reads a response's finishReason", () => {
    const meta = metaOf({
      usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 } as Usage,
      finishReason: { normalized: "length" },
    }, model);
    expect(meta.usage).toEqual({ tokensIn: 25, tokensOut: 5, tokensTotal: 30 });
    expect(meta.contextRatio).toBe(0.25);
    expect(meta.finishReason).toBe("length");
  });

  test("no usage yields null metrics", () => {
    const meta = metaOf({}, model);
    expect(meta.usage).toBeNull();
    expect(meta.contextRatio).toBeNull();
    expect(meta.finishReason).toBeNull();
  });

  test("unknown context yields a null ratio", () => {
    const meta = metaOf({ usage: { inputTokens: 5 } as Usage }, { id: "m" });
    expect(meta.usage).toEqual({ tokensIn: 5, tokensOut: null, tokensTotal: null });
    expect(meta.contextRatio).toBeNull();
  });
});

describe("streaming frame builders", () => {
  const generated = chunkMeta("gw");
  const meta: ChunkMeta = {
    id: generated.id,
    object: "chat.completion.chunk",
    created: generated.created,
    model: "gw",
  };
  const parse = (frame: string) => JSON.parse(frame.replace(/^data: /, "").trimEnd()) as Record<string, unknown>;

  test("the chunk meta uses the chat.completion.chunk object", () => {
    expect(generated.object).toBe("chat.completion.chunk");
    expect(generated.id.startsWith("chatcmpl-")).toBe(true);
  });

  test("role, text and reasoning frames", () => {
    expect(parse(roleFrame(meta))).toMatchObject({
      id: meta.id,
      object: "chat.completion.chunk",
      model: "gw",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    expect(parse(textDeltaFrame(meta, "hi"))).toMatchObject({ choices: [{ delta: { content: "hi" }, finish_reason: null }] });
    expect(parse(reasoningDeltaFrame(meta, "th"))).toMatchObject({ choices: [{ delta: { reasoning_content: "th" } }] });
  });

  test("tool frames carry the index, id, name and argument fragments", () => {
    expect(parse(toolInputStartFrame(meta, 0, "call_1", "f"))).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "" } }] } }],
    });
    expect(parse(toolInputDeltaFrame(meta, 0, '{"a"'))).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }],
    });
    expect(parse(toolCallFrame(meta, 1, "call_2", "g", "{}"))).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "g", arguments: "{}" } }] } }],
    });
  });

  test("finish frame carries the finish_reason, usage frame carries no choices", () => {
    expect(parse(finishFrame(meta, "tool_calls"))).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
    const usage = parse(usageFrame(meta, { inputTokens: 3, outputTokens: 4, totalTokens: 7 } as Usage));
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });
});

describe("aiErrorResponse", () => {
  const readBody = async (res: Response) => (await res.json()) as { error: { message: string; type: string; code?: string }; max_context?: number };

  test("context overflow maps to the F3 400 with a code", async () => {
    const err = new AIError({ reason: new InvalidRequestError({ message: "too long", classification: "context-overflow" }) });
    const res = aiErrorResponse(err, model);
    expect(res.status).toBe(400);
    const body = await readBody(res);
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.max_context).toBe(100);
  });

  test("an explicit HTTP status wins and relays retry-after on 429", async () => {
    const bad = aiErrorResponse({ reason: { _tag: "InvalidRequest", message: "bad", http: { status: 400, headers: {} } } }, model);
    expect(bad.status).toBe(400);
    expect((await readBody(bad)).error.message).toBe("bad");

    const limited = aiErrorResponse(
      { reason: { _tag: "RateLimit", message: "slow", http: { status: 429, headers: { "retry-after": "12" } }, retryAfterMs: 3000 } },
      model,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("12");
    expect((await readBody(limited)).error.type).toBe("invalid_request_error");
  });

  test("a 5xx status becomes server_error", async () => {
    const res = aiErrorResponse({ reason: { _tag: "ProviderInternal", message: "boom", http: { status: 503, headers: {} } } }, model);
    expect(res.status).toBe(503);
    expect((await readBody(res)).error.type).toBe("server_error");
  });

  test("tag-only errors map to their status; RateLimit derives retry-after from ms", async () => {
    expect(aiErrorResponse({ reason: { _tag: "Authentication", message: "no" } }, model).status).toBe(401);
    expect(aiErrorResponse({ reason: { _tag: "QuotaExceeded", message: "no" } }, model).status).toBe(402);
    expect(aiErrorResponse({ reason: { _tag: "ContentPolicy", message: "no" } }, model).status).toBe(400);
    expect(aiErrorResponse({ reason: { _tag: "Transport", message: "no" } }, model).status).toBe(502);
    expect(aiErrorResponse({ reason: { _tag: "Timeout", message: "no" } }, model).status).toBe(504);
    expect(aiErrorResponse({ reason: { _tag: "NoRoute", message: "no" } }, model).status).toBe(502);
    expect(aiErrorResponse({ reason: { _tag: "UnsupportedOperation", message: "no" } }, model).status).toBe(400);

    const limited = aiErrorResponse({ reason: { _tag: "RateLimit", message: "slow", retryAfterMs: 2500 } }, model);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3");
  });

  test("a provider output failure with HTTP 200 maps to 502", async () => {
    const res = aiErrorResponse({ reason: { _tag: "InvalidProviderOutput", message: "bad", http: { status: 200 } } }, model);
    expect(res.status).toBe(502);
    expect((await readBody(res)).error.type).toBe("server_error");
  });

  test("non-AIError values fall back to a 500 server_error", async () => {
    const res = aiErrorResponse(new Error("boom"), model);
    expect(res.status).toBe(500);
    expect(await readBody(res)).toEqual({ error: { message: "upstream error", type: "server_error" } });

    const config = aiErrorResponse({ _tag: "ProviderConfiguration", message: "nope" }, model);
    expect(config.status).toBe(500);
  });
});
