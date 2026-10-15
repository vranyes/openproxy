// F3: reactive context-window handling. We do NOT count tokens up front (mirrors
// OpenCode). When an upstream rejects a request because the input exceeds the
// model's context window, we reshape that provider error into a clean 400 that
// LibreChat can surface. Classification is delegated to @opencode/ai; no regexes
// are reimplemented here.
import { isContextOverflow } from "@opencode/ai";
import type { GatewayModel } from "./config";
import { errorResponse } from "./ops/errors";

export const CONTEXT_OVERFLOW_CODE = "context_length_exceeded";

// Classification only needs the head of the error text, and must never let a
// stalled / never-closing upstream body hang the request.
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const CLASSIFY_TIMEOUT_MS = 500;

// `res.clone()` is typed by @types/bun as an undici-types Response, not Bun's
// augmented global, so the clone must not be passed to a global-`Response`-typed
// parameter. Derive the exact clone type from the global instead of casting.
type ClonedResponse = ReturnType<Response["clone"]>;

/** Thin wrapper over @opencode/ai: does this provider error text mean "input too long"? */
export function isOverflowMessage(text: string): boolean {
  return isContextOverflow(text);
}

/** Human-readable message; LibreChat surfaces error.message. No token count is invented. */
export function contextOverflowMessage(maxContext?: number): string {
  if (maxContext === undefined) {
    return "The request exceeds this model's maximum context length. Reduce the length of the input and try again.";
  }
  return `This model's maximum context length is ${maxContext} tokens. Reduce the length of the input and try again.`;
}

/** 400 body for a context overflow: the standard error envelope plus code and max_context. */
export function contextOverflowResponse(model: GatewayModel): Response {
  return errorResponse(contextOverflowMessage(model.context), 400, "invalid_request_error", {
    code: CONTEXT_OVERFLOW_CODE,
    maxContext: model.context,
  });
}

/**
 * Read at most `maxBytes` from a response body (UTF-8), giving up after `timeoutMs`.
 * Returns null if the read errors or times out. Release is fire-and-forget so a
 * never-closing body can never block the relay.
 */
async function readBoundedText(res: ClonedResponse, maxBytes: number, timeoutMs: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return ""; // no body: nothing to classify against
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const readPromise = (async (): Promise<string> => {
      let text = "";
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) break;
      }
      return text + decoder.decode();
    })();
    readPromise.catch(() => {}); // never unhandled if the timeout wins the race
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("context classification timed out")), timeoutMs);
    });
    return await Promise.race([readPromise, timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Do NOT await: cancelling a tee branch can await the other branch, which
    // would reintroduce a hang. The clone is discarded, so fire-and-forget.
    reader.cancel().catch(() => {});
  }
}

/**
 * Inspect a non-ok upstream Response for a context-overflow rejection.
 * Returns the gateway 400 on a match, otherwise null.
 *
 * Only client-scoped failures (HTTP 4xx) are eligible, mirroring @opencode/ai's
 * `clientScoped` guard: a 5xx whose body merely contains an overflow-ish phrase
 * is a provider failure and must be relayed unchanged. A 3xx is not eligible
 * either. Success is never read.
 */
export async function detectContextOverflow(res: Response, model: GatewayModel): Promise<Response | null> {
  if (res.ok) return null; // success (possibly SSE): never read the body
  if (res.status < 400 || res.status >= 500) return null; // client-scoped rejections only

  let clone: ClonedResponse;
  try {
    clone = res.clone(); // tee: reading the clone leaves the original readable
  } catch {
    return null; // cannot clone without consuming the original: relay it
  }

  const text = await readBoundedText(clone, MAX_ERROR_BODY_BYTES, CLASSIFY_TIMEOUT_MS);
  if (text === null) return null; // timed out or unreadable: relay the original
  return isOverflowMessage(text) ? contextOverflowResponse(model) : null;
}
