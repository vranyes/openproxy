// Map a thrown @opencode/ai failure onto the gateway's OpenAI error envelope.
//
// Order matters: an explicit HTTP status from the provider round-trip wins (it
// is the most faithful), then the provider-neutral error tag, and only then the
// generic fallback. Context overflow is checked first so the translated path
// produces the same clean 400 as `passthrough` (F3).
import { contextOverflowResponse, isContextOverflowFailureError } from "../context";
import type { GatewayModel } from "../config";
import { errorResponse } from "../ops/errors";

interface ReasonLike {
  _tag?: unknown;
  message?: unknown;
  http?: { status?: unknown; headers?: unknown };
  retryAfterMs?: unknown;
}

const TAG_STATUS: Record<string, number> = {
  InvalidRequest: 400,
  Authentication: 401,
  QuotaExceeded: 402,
  RateLimit: 429,
  ContentPolicy: 400,
  ProviderInternal: 502,
  Transport: 502,
  Timeout: 504,
  NoRoute: 502,
  UnsupportedOperation: 400,
  InvalidProviderOutput: 502,
  UnknownProvider: 502,
};

function retryAfterFromMs(reason: ReasonLike | undefined): string | undefined {
  const ms = reason?.retryAfterMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return String(Math.ceil(ms / 1000));
  return undefined;
}

function retryAfter(reason: ReasonLike | undefined): string | undefined {
  const headers = reason?.http?.headers;
  if (typeof headers === "object" && headers !== null) {
    const value = (headers as Record<string, unknown>)["retry-after"];
    if (typeof value === "string" && value.length) return value;
  }
  return retryAfterFromMs(reason);
}

export function aiErrorResponse(err: unknown, model: GatewayModel): Response {
  // 1. Context overflow -> the F3 400 with `max_context` and a machine-readable code.
  if (isContextOverflowFailureError(err)) return contextOverflowResponse(model);

  const reason = (err as { reason?: ReasonLike } | null | undefined)?.reason;
  const message = typeof reason?.message === "string" ? reason.message : String(err);

  // 2. A real HTTP status from the provider error is authoritative.
  const status = reason?.http?.status;
  const httpStatus = typeof status === "number" && status >= 400 && status <= 599 ? status : undefined;
  if (httpStatus !== undefined) {
    let headers: Record<string, string> | undefined;
    if (httpStatus === 429) {
      const value = retryAfter(reason);
      if (value !== undefined) headers = { "retry-after": value };
    }
    return errorResponse(message, httpStatus, httpStatus >= 500 ? "server_error" : "invalid_request_error", {
      headers,
    });
  }

  // 3. No HTTP context: map the provider-neutral tag.
  const tag = typeof reason?._tag === "string" ? reason._tag : undefined;
  if (tag !== undefined) {
    const mapped = TAG_STATUS[tag] ?? 502;
    let headers: Record<string, string> | undefined;
    if (mapped === 429) {
      const value = retryAfterFromMs(reason);
      if (value !== undefined) headers = { "retry-after": value };
    }
    return errorResponse(message, mapped, mapped >= 500 ? "server_error" : "invalid_request_error", { headers });
  }

  // 4. Anything else (including a synchronous ProviderConfigurationError).
  return errorResponse("upstream error", 500, "server_error");
}
