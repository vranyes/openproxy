// Dialect-driven SSE drain loop, shared by every inbound adapter.
//
// The runtime always produces an `@opencode/ai` event stream; an inbound
// dialect decides how each event becomes SSE frames. This driver owns the
// mechanics that must not vary: the header-time prefetch (done by the caller),
// the closed guard so a send after close is swallowed, `iterator.return()` in
// both `finally` and `cancel()`, and the fire-and-forget `resolveCompleted`.
import type { LLMEvent } from "@opencode/ai";
import type { GatewayModel } from "../config";
import type { AdapterMeta } from "./types";

/** One inbound wire format's rendering of the provider-neutral event stream. */
export interface StreamDialect<State> {
  /** Fresh per-request state. */
  state(): State;
  /** Frames emitted before any event (e.g. an opening role chunk). */
  open(send: (frame: string) => void, state: State): void;
  /** Render one provider event. */
  event(e: LLMEvent, send: (frame: string) => void, state: State): void;
  /** Frames emitted after the final event (finish, usage, sentinel). */
  close(send: (frame: string) => void, state: State): void;
  /** A mid-stream failure that arrived after headers were committed. */
  error(message: string, send: (frame: string) => void): void;
  /** Metrics for the `generation` log, derived from the drained state. */
  meta(state: State): AdapterMeta;
}

/**
 * Drain `iterator` into an SSE `ReadableStream` by delegating frame rendering to
 * `dialect`. `first` was prefetched by the caller so a pre-stream failure could
 * become an HTTP error before headers; this function never reads ahead itself.
 */
export function drainStream<State>(
  first: IteratorResult<LLMEvent>,
  iterator: AsyncIterator<LLMEvent>,
  dialect: StreamDialect<State>,
  model: GatewayModel,
  resolveCompleted: (m: AdapterMeta | null) => void,
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
      const state = dialect.state();
      const sendFrame = (frame: string): void => send(controller, frame);
      let streamError: { tag: string; message: string } | null = null;
      try {
        dialect.open(sendFrame, state);
        if (!first.done) dialect.event(first.value, sendFrame, state);
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          dialect.event(next.value, sendFrame, state);
        }
        dialect.close(sendFrame, state);
      } catch (err) {
        const reason = (err as { reason?: { _tag?: unknown; message?: unknown } } | null | undefined)?.reason;
        const tag = typeof reason?._tag === "string" && reason._tag.length > 0 ? reason._tag : "unknown";
        const rawMessage =
          reason?.message !== undefined ? String(reason.message) : err instanceof Error ? err.message : String(err);
        const message = rawMessage.slice(0, 500);
        streamError = { tag, message };
        dialect.error(message, sendFrame);
      } finally {
        safeClose(controller);
        await iterator.return?.().catch(() => {});
        const base = dialect.meta(state);
        if (streamError !== null) {
          resolveCompleted({
            ...base,
            outcome: "midstream_error",
            finishReason: "error",
            errorTag: streamError.tag,
            errorMessage: streamError.message,
          });
        } else {
          resolveCompleted({ ...base, outcome: "ok" });
        }
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      void iterator.return?.().catch(() => {});
      // Client went away mid-stream: resolve so the `generation` event and
      // metrics record the abort instead of vanishing.
      try {
        const state = dialect.state();
        const base = dialect.meta(state);
        const message = reason instanceof Error ? reason.message : String(reason ?? "client aborted");
        resolveCompleted({
          ...base,
          usage: null,
          outcome: "client_aborted",
          finishReason: "aborted",
          errorMessage: message.slice(0, 500),
        });
      } catch {
        resolveCompleted({ usage: null, contextRatio: null, finishReason: "aborted", costUsd: null, outcome: "client_aborted" });
      }
    },
  });
}
