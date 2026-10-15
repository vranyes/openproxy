// F8: resolve the header set for an upstream request.
//
// Every upstream request gets a distinct `user-agent: openproxy/<version>`
// (never the client's), then the operator's static `headers`, then the session
// id when a `sessionHeader` is configured. Header names are matched
// case-insensitively and collapsed to a single key: Bun's fetch comma-joins
// duplicate-cased keys on a plain-object header bag, which would corrupt both
// static and generated values.
import pkg from "../package.json" with { type: "json" };
import type { GatewayUpstream } from "./config";

export const DEFAULT_USER_AGENT = `openproxy/${pkg.version}`;
// NON-empty: a blank forwarded session id is not a session, so it falls through
// to a generated one (mirrors the no-inbound path).
const SAFE_HEADER_VALUE = /^[\x20-\x7e\x80-\xff]+$/;

/** Replace a header, deleting any existing key differing only in case (Bun fetch comma-joins duplicate-cased plain-object keys). */
export function setHeader(target: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(target)) if (key.toLowerCase() === lower) delete target[key];
  target[name] = value;
}

export function hasHeader(target: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(target).some((k) => k.toLowerCase() === lower);
}

export interface ResolveUpstreamHeadersInput {
  upstream: GatewayUpstream;
  /** Omit => no session handling (discovery passes none). */
  inbound?: Headers;
  /** Override session-id generation (defaults to a random UUID). */
  generateSessionId?: (upstreamId: string) => string;
}

/**
 * Build the upstream request headers for one call. `inbound` is the client
 * request's headers: a safe `sessionHeader` value is forwarded verbatim, an
 * unsafe/absent one falls back to a generated id (unless a static header pinned
 * it), and when `inbound` is omitted the session is never touched.
 */
export function resolveUpstreamHeaders(input: ResolveUpstreamHeadersInput): Record<string, string> {
  const out: Record<string, string> = {};
  setHeader(out, "user-agent", DEFAULT_USER_AGENT);
  for (const [n, v] of Object.entries(input.upstream.headers ?? {})) setHeader(out, n, v);
  const name = input.upstream.sessionHeader;
  // N1: only handle the session when there is an inbound request (discovery passes none).
  if (name !== undefined && input.inbound !== undefined) {
    const raw = input.inbound.get(name) ?? null;
    const forwarded = raw !== null && SAFE_HEADER_VALUE.test(raw) ? raw : undefined;
    if (forwarded !== undefined) setHeader(out, name, forwarded);
    else if (!hasHeader(out, name)) setHeader(out, name, (input.generateSessionId ?? (() => crypto.randomUUID()))(input.upstream.id));
    // else: operator-pinned static session header is preserved
  }
  return out;
}
