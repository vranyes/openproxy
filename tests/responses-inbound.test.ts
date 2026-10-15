import { describe, expect, test } from "bun:test";
import { UpstreamSchema, type GatewayConfig, type GatewayUpstream } from "../src/config";
import { createApp } from "../src/server";
import {
  CHAT_DONE,
  chatChunk,
  chatTextStream,
  chatToolStream,
  chatUsageChunk,
  gatewayResponsesRequest,
  overflowError,
  rateLimitError,
  sseResponse,
  withUpstream,
} from "./fake-providers";
import { parseSseEvents } from "./helpers";
import { responseObjectFromIR, responsesToChat, responsesFrame, unsupportedResponsesParam } from "../src/adapter/responses";
import type { LogEvent } from "../src/ops/log";

const COMPAT = "@opencode/ai/providers/openai-compatible";

function upstreamOf(
  baseURL: string,
  modelOverrides: Record<string, unknown> = {},
  upstreamOverrides: Record<string, unknown> = {},
): GatewayUpstream {
  return UpstreamSchema.parse({
    id: "local",
    package: COMPAT,
    baseURL,
    apiKeyEnv: null,
    adapter: "opencode",
    models: [{ id: "gw-model", upstream: "up-model", context: 1000, ...modelOverrides }],
    ...upstreamOverrides,
  });
}

function appFor(baseURL: string, modelOverrides: Record<string, unknown> = {}): ReturnType<typeof createApp> {
  const config: GatewayConfig = { upstreams: [upstreamOf(baseURL, modelOverrides)] };
  return createApp(config);
}

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

async function capture(req: Request): Promise<Seen> {
  return { path: new URL(req.url).pathname, body: (await req.json()) as Record<string, unknown> };
}

interface ResponsesBody {
  id: string;
  object: string;
  status: string;
  model: string;
  output: Array<Record<string, unknown>>;
  usage: Record<string, unknown>;
  error: unknown;
  incomplete_details: unknown;
}

/** A reasoning-then-text chat stream (openai-compatible dialect). */
function reasoningStream(reasoning: string, text: string): string {
  return (
    chatChunk({ role: "assistant", content: "" }) +
    chatChunk({ reasoning_content: reasoning }) +
    chatChunk({ content: text }) +
    chatChunk({}, "stop") +
    chatUsageChunk(1, 2, 3) +
    CHAT_DONE
  );
}

describe("POST /v1/responses: non-stream", () => {
  test("text: returns a Responses object and forwards the user text upstream", async () => {
    let seen: Seen | null = null;
    await withUpstream(
      async (req) => {
        seen = await capture(req);
        return sseResponse(chatTextStream("Hello"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model", { input: "hello" }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as ResponsesBody;
        expect(body.object).toBe("response");
        expect(body.status).toBe("completed");
        expect(body.model).toBe("gw-model");
        expect(body.id.startsWith("resp_")).toBe(true);
        expect(body.output[0]).toMatchObject({
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        });
        expect(body.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
      },
    );
    expect(seen!.path).toBe("/v1/chat/completions");
    const messages = seen!.body.messages as Array<Record<string, unknown>>;
    expect(messages).toContainEqual({ role: "user", content: "hello" });
  });

  test("instructions are forwarded as a system message", async () => {
    let seen: Seen | null = null;
    await withUpstream(
      async (req) => {
        seen = await capture(req);
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(
          gatewayResponsesRequest("gw-model", { instructions: "be terse", input: "hello" }),
        );
        expect(res.status).toBe(200);
      },
    );
    const messages = seen!.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "be terse" });
  });

  test("normalization: input_text + input_image + array tool output reach the upstream", async () => {
    let seen: Seen | null = null;
    await withUpstream(
      async (req) => {
        seen = await capture(req);
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL, { supportsVision: true }).fetch(
          gatewayResponsesRequest("gw-model", {
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "look" },
                  { type: "input_image", image_url: "data:image/png;base64,AAAA" },
                ],
              },
              { type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"Paris"}' },
              { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "42" }] },
            ],
          }),
        );
        expect(res.status).toBe(200);
      },
    );
    const messages = seen!.body.messages as Array<Record<string, unknown>>;
    const user = messages[0]!;
    expect(JSON.stringify(user.content)).toContain("look");
    expect(JSON.stringify(user.content)).toContain("image_url");
    expect(JSON.stringify(user.content)).toContain("AAAA");
    const tool = messages.find((m) => m.role === "tool")!;
    expect(typeof tool.content).toBe("string");
    expect(tool.content).toBe("42");
  });

  test("tool call: output is a function_call with stringified arguments", async () => {
    await withUpstream(
      () => sseResponse(chatToolStream()),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(
          gatewayResponsesRequest("gw-model", {
            input: [{ role: "user", content: "weather?" }],
            tools: [{ type: "function", name: "get_weather", description: "d", parameters: { type: "object" } }],
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as ResponsesBody;
        expect(body.output[0]).toMatchObject({
          type: "function_call",
          call_id: "call_up",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
          status: "completed",
        });
      },
    );
  });
});

describe("POST /v1/responses: stream", () => {
  test("SSE response.created first, response.completed last, no [DONE]", async () => {
    await withUpstream(
      () => sseResponse(chatTextStream("Hello")),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model", { input: "hello", stream: true }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const text = await res.text();
        expect(text).not.toContain("[DONE]");

        const events = parseSseEvents(text);
        expect(events[0]!.event).toBe("response.created");
        expect(events.at(-1)!.event).toBe("response.completed");

        // Monotonic 0-based sequence numbers across every frame.
        const seqs = events.map(
          (e) => (JSON.parse(e.data) as { sequence_number: number }).sequence_number,
        );
        expect(seqs[0]).toBe(0);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);

        // Deltas accumulate into the full text.
        const deltas = events
          .filter((e) => e.event === "response.output_text.delta")
          .map((e) => (JSON.parse(e.data) as { delta: string }).delta)
          .join("");
        expect(deltas).toBe("Hello");

        const completed = JSON.parse(events.at(-1)!.data) as { response: ResponsesBody };
        expect(completed.response.status).toBe("completed");
        expect(completed.response.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
        expect(completed.response.output[0]).toMatchObject({
          type: "message",
          content: [{ type: "output_text", text: "Hello", annotations: [] }],
        });
      },
    );
  });

  test("reasoning emits item/summary-part/reasoning-summary-text frames", async () => {
    await withUpstream(
      () => sseResponse(reasoningStream("let me think", "Hi")),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model", { input: "think", stream: true }));
        const text = await res.text();
        const events = parseSseEvents(text);
        const names = events.map((e) => e.event);
        expect(names).toContain("response.output_item.added");
        expect(names).toContain("response.reasoning_summary_part.added");
        expect(names).toContain("response.reasoning_summary_text.delta");
        expect(names).toContain("response.reasoning_summary_text.done");

        const added = events.find((e) => {
          if (e.event !== "response.output_item.added") return false;
          const item = (JSON.parse(e.data) as { item: { type: string } }).item;
          return item.type === "reasoning";
        })!;
        const rsId = (JSON.parse(added.data) as { item: { id: string } }).item.id;
        expect(rsId.startsWith("rs_")).toBe(true);
        const reasoningDelta = events.find((e) => e.event === "response.reasoning_summary_text.delta")!;
        expect((JSON.parse(reasoningDelta.data) as { item_id: string; delta: string }).item_id).toBe(rsId);
        expect((JSON.parse(reasoningDelta.data) as { delta: string }).delta).toBe("let me think");
      },
    );
  });

  test("tool stream: function_call item id drives the arguments delta (not call_id)", async () => {
    await withUpstream(
      () => sseResponse(chatToolStream()),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(
          gatewayResponsesRequest("gw-model", {
            input: [{ role: "user", content: "weather?" }],
            stream: true,
            tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
          }),
        );
        const events = parseSseEvents(await res.text());

        const added = events.find((e) => {
          if (e.event !== "response.output_item.added") return false;
          return (JSON.parse(e.data) as { item: { type: string } }).item.type === "function_call";
        })!;
        const item = (JSON.parse(added.data) as { item: { id: string; call_id: string } }).item;
        expect(item.id.startsWith("fc_")).toBe(true);
        expect(item.call_id).toBe("call_up");

        const delta = events.find((e) => e.event === "response.function_call_arguments.delta")!;
        const parsedDelta = JSON.parse(delta.data) as { item_id: string; delta: string };
        expect(parsedDelta.item_id).toBe(item.id);
        expect(parsedDelta.item_id).not.toBe(item.call_id);
        expect(parsedDelta.delta).toBe('{"city":"Paris"}');

        const completed = JSON.parse(events.at(-1)!.data) as { response: ResponsesBody };
        expect(completed.response.output[0]).toMatchObject({
          type: "function_call",
          call_id: "call_up",
          arguments: '{"city":"Paris"}',
        });
      },
    );
  });
});

describe("POST /v1/responses: rejected stateful params", () => {
  for (const [param, value] of [
    ["previous_response_id", "resp_x"],
    ["conversation", "conv_x"],
    ["store", true],
  ] as const) {
    test(`${param} -> 400 unsupported_parameter`, async () => {
      const app = appFor("http://upstream.test/v1");
      const res = await app.fetch(gatewayResponsesRequest("gw-model", { [param]: value }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unsupported_parameter");
    });
  }

  test("store:false is accepted", async () => {
    await withUpstream(
      () => sseResponse(chatTextStream("ok")),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model", { store: false }));
        expect(res.status).toBe(200);
      },
    );
  });
});

describe("POST /v1/responses: errors", () => {
  test("upstream 429 relays status and retry-after", async () => {
    await withUpstream(
      () => rateLimitError("9"),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model"));
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("9");
      },
    );
  });

  test("overflow -> 400 context_length_exceeded (non-stream)", async () => {
    await withUpstream(
      () => overflowError(),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model"));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code?: string }; max_context?: number };
        expect(body.error.code).toBe("context_length_exceeded");
        expect(body.max_context).toBe(1000);
      },
    );
  });

  test("overflow -> 400 context_length_exceeded (stream)", async () => {
    await withUpstream(
      () => overflowError(),
      async (baseURL) => {
        const res = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model", { stream: true }));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code?: string } };
        expect(body.error.code).toBe("context_length_exceeded");
      },
    );
  });

  test("unknown model -> 404", async () => {
    const app = appFor("http://upstream.test/v1");
    const res = await app.fetch(gatewayResponsesRequest("nope"));
    expect(res.status).toBe(404);
  });

  test("invalid JSON -> 400", async () => {
    const app = appFor("http://upstream.test/v1");
    const res = await app.fetch(
      new Request("http://gateway/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { message: string } }).toMatchObject({
      error: { message: "invalid JSON body" },
    });
  });
});

describe("POST /v1/responses: capability + params", () => {
  test("supportsVision:false rejects input_image without calling upstream", async () => {
    let calls = 0;
    await withUpstream(
      () => {
        calls += 1;
        return sseResponse(chatTextStream("nope"));
      },
      async (baseURL) => {
        const res = await appFor(baseURL, { supportsVision: false }).fetch(
          gatewayResponsesRequest("gw-model", {
            input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] }],
          }),
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: { message: "model does not support image input", type: "invalid_request_error" },
        });
      },
    );
    expect(calls).toBe(0);
  });

  test("dropParams (temperature) is stripped from the upstream body", async () => {
    const bodies: Record<string, unknown>[] = [];
    await withUpstream(
      async (req) => {
        bodies.push((await req.json()) as Record<string, unknown>);
        return sseResponse(chatTextStream("ok"));
      },
      async (baseURL) => {
        const dropped = await appFor(baseURL, { dropParams: ["temperature"] }).fetch(
          gatewayResponsesRequest("gw-model", { temperature: 0.7 }),
        );
        expect(dropped.status).toBe(200);
        const kept = await appFor(baseURL).fetch(gatewayResponsesRequest("gw-model", { temperature: 0.7 }));
        expect(kept.status).toBe(200);
      },
    );
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[1]).toMatchObject({ temperature: 0.7 });
  });
});

describe("POST /v1/responses: generation log", () => {
  test("emits a generation event with usage (non-stream)", async () => {
    const events: LogEvent[] = [];
    await withUpstream(
      () => sseResponse(chatTextStream("Hi", [5, 2, 7])),
      async (baseURL) => {
        const config: GatewayConfig = { upstreams: [upstreamOf(baseURL)] };
        const app = createApp(config, { logger: (e) => events.push(e) });
        const res = await app.fetch(gatewayResponsesRequest("gw-model"));
        expect(res.status).toBe(200);
        await Bun.sleep(0);
      },
    );
    const generation = events.find((e) => e.msg === "generation");
    expect(generation).toBeDefined();
    expect(generation!.tokens_in).toBe(5);
    expect(generation!.tokens_total).toBe(7);
    expect(generation!.finish_reason).toBe("stop");
  });

  test("emits a generation event after a stream drains", async () => {
    const events: LogEvent[] = [];
    await withUpstream(
      () => sseResponse(chatTextStream("Hi", [5, 2, 7])),
      async (baseURL) => {
        const config: GatewayConfig = { upstreams: [upstreamOf(baseURL)] };
        const app = createApp(config, { logger: (e) => events.push(e) });
        const res = await app.fetch(gatewayResponsesRequest("gw-model", { stream: true }));
        await res.text();
        await Bun.sleep(0);
      },
    );
    expect(events.filter((e) => e.msg === "generation")).toHaveLength(1);
  });
});

// --- pure translation units --------------------------------------------------

describe("responsesToChat", () => {
  test("prepends instructions as a system message and maps max_output_tokens", () => {
    const chat = responsesToChat({ model: "m", instructions: "be terse", input: "hi", max_output_tokens: 64 });
    expect(chat.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(chat.max_tokens).toBe(64);
  });

  test("maps input_text/input_image/input_file and flattens tool output", () => {
    const chat = responsesToChat({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: { url: "https://example.test/a.png" } },
            { type: "input_file", file_data: "data:image/png;base64,BBBB" },
            { type: "input_file", file_data: "https://example.test/b.pdf" },
          ],
        },
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"x":1}' },
        { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "one" }, { type: "input_text", text: "two" }] },
        { type: "reasoning", id: "rs_x", summary: [] },
      ],
    });
    const messages = chat.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "https://example.test/a.png" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
    ]);
    expect(messages[1]).toEqual({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
    });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "onetwo" });
    expect(messages).toHaveLength(3); // reasoning dropped
  });

  test("maps function tools and function tool_choice; drops allowed_tools", () => {
    const chat = responsesToChat({
      model: "m",
      input: "hi",
      tools: [
        { type: "function", name: "f", description: "d", parameters: { type: "object" } },
        { type: "web_search" },
      ],
      tool_choice: { type: "function", name: "f" },
    });
    expect(chat.tools).toEqual([
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ]);
    expect(chat.tool_choice).toEqual({ type: "function", function: { name: "f" } });

    const auto = responsesToChat({ model: "m", input: "hi", tool_choice: "auto" });
    expect(auto.tool_choice).toBe("auto");
    const allowed = responsesToChat({ model: "m", input: "hi", tool_choice: { type: "allowed_tools", tools: [] } });
    expect(allowed.tool_choice).toBeUndefined();
  });
});

describe("responseObjectFromIR", () => {
  type IR = Parameters<typeof responseObjectFromIR>[0];
  const base = {
    text: "hi",
    reasoning: "",
    toolCalls: [],
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    finishReason: { normalized: "stop" },
  } as unknown as IR;

  test("completed text maps to a message output with usage", () => {
    const body = responseObjectFromIR(base, "gw-model");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.error).toBeNull();
    expect(body.incomplete_details).toBeNull();
    expect(body.output).toEqual([
      { type: "message", id: expect.stringMatching(/^msg_/), role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] },
    ]);
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  });

  test("length and content-filter map to incomplete with a reason", () => {
    const length = responseObjectFromIR({ ...base, finishReason: { normalized: "length" } } as IR, "m");
    expect(length.status).toBe("incomplete");
    expect(length.incomplete_details).toEqual({ reason: "max_output_tokens" });
    const filtered = responseObjectFromIR({ ...base, finishReason: { normalized: "content-filter" } } as IR, "m");
    expect(filtered.status).toBe("incomplete");
    expect(filtered.incomplete_details).toEqual({ reason: "content_filter" });
  });

  test("reasoning, tool calls and usage details are surfaced", () => {
    const body = responseObjectFromIR(
      {
        text: "",
        reasoning: "think",
        toolCalls: [{ id: "call_1", name: "f", input: { a: 1 } }],
        usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4, cacheReadInputTokens: 1, reasoningTokens: 2 },
        finishReason: { normalized: "tool-calls" },
      } as unknown as IR,
      "m",
    );
    expect(body.status).toBe("completed");
    const output = body.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "think" }] });
    expect(output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "f",
      arguments: '{"a":1}',
      status: "completed",
    });
    expect(body.usage).toEqual({
      input_tokens: 1,
      output_tokens: 3,
      total_tokens: 4,
      input_tokens_details: { cached_tokens: 1 },
      output_tokens_details: { reasoning_tokens: 2 },
    });
  });
});

describe("responsesFrame + unsupportedResponsesParam", () => {
  test("responsesFrame emits an event line and a typed JSON data line", () => {
    const frame = responsesFrame("response.created", 0, { response: { id: "resp_x" } });
    expect(frame).toBe(
      `event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_x"}}\n\n`,
    );
  });

  test("unsupportedResponsesParam flags stateful params only", () => {
    expect(unsupportedResponsesParam({ store: false })).toBeNull();
    expect(unsupportedResponsesParam({ input: "hi" })).toBeNull();
    expect(unsupportedResponsesParam({ previous_response_id: "x" })?.status).toBe(400);
    expect(unsupportedResponsesParam({ conversation: "c" })?.status).toBe(400);
    expect(unsupportedResponsesParam({ store: true })?.status).toBe(400);
  });
});
