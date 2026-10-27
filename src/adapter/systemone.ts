// Relay for Jev decision requests (`POST /v1/systemone`).
//
// Jev is a System One model: the inbound body is `{ model, state, questions }`
// and the upstream answers `{ model, answers, usage }`. No @opencode/ai
// provider speaks this dialect (the catalog lists its AI SDK package as `-`),
// so the gateway relays the body verbatim — rewriting only the `model` id —
// and returns the upstream response byte-identical, including non-ok statuses
// (the TypeSafe error shape is not an OpenAI envelope).
//
// Validation is deliberately top-level only (`state`/`questions` presence plus
// each question's `type`/`instructions`): question details (criteria shapes)
// stay upstream's to validate so the gateway does not couple to spec changes.
import { resolveApiKey } from "../config";
import { costUsd } from "../cost";
import { errorResponse } from "../ops/errors";
import { setHeader } from "../headers";
import type { AdapterDeps } from "./index";
import type { Adapter, AdapterInput, AdapterMeta, AdapterResult } from "./types";

const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 400 when the SystemOne body is malformed, else null. */
export function validateSystemOneBody(body: Record<string, unknown>): Response | null {
  const state = body.state;
  const stateOk =
    typeof state === "string" || (typeof state === "object" && state !== null);
  if (!stateOk) {
    return errorResponse("state must be a string or an object", 400);
  }
  const questions = body.questions;
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    return errorResponse("questions must be a non-empty object", 400);
  }
  for (const [id, raw] of Object.entries(questions)) {
    if (!isRecord(raw)) {
      return errorResponse(`question "${id}" must be an object`, 400);
    }
    if (!QUESTION_TYPES.has(String(raw.type))) {
      return errorResponse(`question "${id}" has an unsupported type`, 400);
    }
    if (typeof raw.instructions !== "string" || raw.instructions.length === 0) {
      return errorResponse(`question "${id}" needs instructions`, 400);
    }
  }
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Usage is snake_case on this wire format (`input_tokens`/`output_tokens`). */
function usageOf(payload: unknown): { tokensIn: number | null; tokensOut: number | null } {
  const root = isRecord(payload) ? payload : null;
  const usage = root && isRecord(root.usage) ? root.usage : null;
  return {
    tokensIn: usage ? asFiniteNumber(usage.input_tokens) : null,
    tokensOut: usage ? asFiniteNumber(usage.output_tokens) : null,
  };
}

/** Strip one trailing `/` so joining never yields `//systemone`. */
export function joinSystemOneUrl(baseURL: string): string {
  return `${baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL}/systemone`;
}

export function createSystemOneAdapter(deps: AdapterDeps): Adapter {
  return {
    async handle({ upstream, model, body, signal, cost }: AdapterInput): Promise<AdapterResult> {
      const invalid = validateSystemOneBody(body);
      if (invalid) return { response: invalid };
      const headers: Record<string, string> = { ...(upstream.headers ?? {}) };
      setHeader(headers, "content-type", "application/json");
      const apiKey = resolveApiKey(upstream);
      if (apiKey) setHeader(headers, "authorization", `Bearer ${apiKey}`);
      const baseURL = upstream.baseURL;
      if (baseURL === undefined) throw new Error(`upstream ${upstream.id} has no baseURL (unroutable)`);
      const upstreamBody = { ...body, model: model.upstream ?? model.id };
      const upstreamRes = await deps.fetchUpstream(joinSystemOneUrl(baseURL), {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
        signal,
      });
      if (!upstreamRes.ok) return { response: upstreamRes };
      // Clone before reading: the client still gets the byte-identical body.
      let meta: AdapterMeta;
      try {
        const payload = await upstreamRes.clone().json();
        const { tokensIn, tokensOut } = usageOf(payload);
        const usage =
          tokensIn !== null || tokensOut !== null
            ? { tokensIn, tokensOut, tokensTotal: tokensIn !== null && tokensOut !== null ? tokensIn + tokensOut : null }
            : null;
        meta = {
          usage,
          contextRatio: null,
          finishReason: null,
          costUsd:
            usage !== null
              ? costUsd(
                  {
                    nonCachedInputTokens: tokensIn,
                    outputTokens: tokensOut,
                    cacheReadTokens: null,
                    cacheWriteTokens: null,
                  },
                  cost,
                )
              : null,
          outcome: "ok",
        };
      } catch {
        meta = { usage: null, contextRatio: null, finishReason: null, costUsd: null, outcome: "ok" };
      }
      return { response: upstreamRes, completed: Promise.resolve(meta) };
    },
  };
}
