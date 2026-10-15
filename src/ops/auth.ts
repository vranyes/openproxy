// F7a: config-driven client auth for the data routes. Open by default (with a
// single startup warning); a token or tokenEnv turns it on for every route
// except GET /healthz. Comparison is constant-time and dependency-free.
import { createHash, timingSafeEqual } from "node:crypto";
import type { GatewayAuthConfig } from "../config";
import { errorResponse } from "./errors";
import type { LogEvent } from "./log";

export interface ResolvedAuthConfig {
  header: string;
  scheme: "bearer" | "raw";
  token: string;
}

export type ResolvedAuth =
  | { mode: "open" }
  | { mode: "enforced"; config: ResolvedAuthConfig }
  | { mode: "misconfigured"; reason: string };

/** undefined -> open. A block whose token/tokenEnv resolves to nothing -> misconfigured (fail closed). */
export function resolveAuth(
  auth: GatewayAuthConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedAuth {
  if (auth == null) return { mode: "open" };
  const token = auth.token ?? (auth.tokenEnv ? env[auth.tokenEnv] : undefined);
  if (!token) return { mode: "misconfigured", reason: "token or tokenEnv did not resolve to a value" };
  return {
    mode: "enforced",
    config: {
      // Lowercased for a case-insensitive lookup (Headers.get normalizes too).
      header: (auth.header ?? "authorization").toLowerCase(),
      scheme: auth.scheme ?? "bearer",
      token,
    },
  };
}

/** Constant-time equality over equal-length sha256 digests (never leaks length). */
function constantTimeEqual(candidate: string, token: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** Bearer: match /^Bearer\s+/i, then compare ONLY the token constant-time. Missing keyword or blank -> false (no compare). Raw: compare whole header value. */
export function isAuthorized(req: Request, config: ResolvedAuthConfig): boolean {
  const value = req.headers.get(config.header);
  if (value === null || value.trim() === "") return false;
  if (config.scheme === "raw") return constantTimeEqual(value, config.token);
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) return false;
  return constantTimeEqual(match[1]!, config.token);
}

export function unauthorizedResponse(): Response {
  return errorResponse("Invalid authentication", 401, "invalid_request_error", {
    code: "invalid_api_key",
    headers: { "www-authenticate": 'Bearer realm="openproxy"' },
  });
}

/** The single startup log line for the auth posture: warn when open, error when misconfigured, null when enforced. */
export function authStartupWarning(
  auth: GatewayAuthConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): LogEvent | null {
  const resolved = resolveAuth(auth, env);
  if (resolved.mode === "open") {
    return { level: "warn", msg: "client auth is disabled; gateway is open" };
  }
  if (resolved.mode === "misconfigured") {
    return {
      level: "error",
      msg: "client auth misconfigured; all data routes will return 401",
      reason: resolved.reason,
    };
  }
  return null;
}

/** The enforced token, else null (used for the LibreChat fragment default; never leaked in open mode). */
export function authToken(
  auth: GatewayAuthConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const resolved = resolveAuth(auth, env);
  return resolved.mode === "enforced" ? resolved.config.token : null;
}
