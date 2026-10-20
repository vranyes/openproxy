// Bounded pre-headers retry for upstream generations.
//
// Retries only failures that happen BEFORE SSE headers are committed (the
// non-stream `generate` call and the stream first-event prefetch in
// `core.ts`). Post-headers failures are unretryable by construction and are
// handled by `stream.ts` instead. Only Timeout/Transport/5xx are retried;
// 4xx (including rate limits — the client sees `retry-after`) never are.

export interface RetrySettings {
  maxAttempts?: number;
  backoffMs?: number;
}

export interface ResolvedRetry {
  maxAttempts: number;
  backoffMs: number;
}

export function resolveRetry(model?: RetrySettings, upstream?: RetrySettings): ResolvedRetry {
  return {
    maxAttempts: model?.maxAttempts ?? upstream?.maxAttempts ?? 1,
    backoffMs: model?.backoffMs ?? upstream?.backoffMs ?? 200,
  };
}

interface ReasonLike {
  _tag?: unknown;
  http?: { status?: unknown };
}

const RETRYABLE_TAGS = new Set(["Timeout", "Transport"]);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** True when `err` is safe to retry before headers (never 4xx). */
export function isRetryableError(err: unknown): boolean {
  const reason = (err as { reason?: ReasonLike } | null | undefined)?.reason;
  if (typeof reason?._tag === "string" && RETRYABLE_TAGS.has(reason._tag)) return true;
  const status = reason?.http?.status;
  if (typeof status === "number" && RETRYABLE_STATUS.has(status)) return true;
  return false;
}

export function retryTagOf(err: unknown): string {
  const reason = (err as { reason?: ReasonLike & { _tag?: unknown } } | null | undefined)?.reason;
  if (typeof reason?._tag === "string" && reason._tag.length > 0) return reason._tag;
  const status = (reason?.http as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") return `http-${status}`;
  return "unknown";
}

/** Sleep that rejects early when `signal` aborts. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
