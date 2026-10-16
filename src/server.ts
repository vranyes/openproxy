import {
  resolveApiKey,
  type ConfigProvider,
  type GatewayConfig,
  type GatewayModel,
  type GatewayUpstream,
} from "./config";
import { createAdapter, selectAdapter } from "./adapter";
import { defaultAiRuntime, type AiRuntime } from "./adapter/ai";
import { createResponsesAdapter } from "./adapter/responses";
import type { AdapterMeta } from "./adapter/types";
import { resolveUpstreamHeaders, setHeader } from "./headers";
import { buildLibreChatFragment, fragmentResponse, type FragmentModel } from "./librechat";
import { createModelResolver, tokenConfigOf, type ResolvedModel } from "./registry";
import type { ModelCost } from "./cost";
import type { ModelsDevIndex } from "./modelsdev";
import { errorResponse } from "./ops/errors";
import { authToken, isAuthorized, resolveAuth, unauthorizedResponse } from "./ops/auth";
import { createRateLimiter } from "./ops/ratelimit";
import { noopLogger, safeLog, type Logger } from "./ops/log";

export type UpstreamFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface AppOptions {
  fetchUpstream?: UpstreamFetcher;
  logger?: Logger;
  ai?: AiRuntime;
  /** models.dev index getter (F6). Omit to disable models.dev resolution. */
  modelsdev?: () => ModelsDevIndex | null;
  /** Clock seam (F7c) for deterministic rate-limit tests. Defaults to Date.now. */
  now?: () => number;
  /** F8: session-id generator; default memoizes one id per upstream id. */
  generateSessionId?: (upstreamId: string) => string;
}

interface Route {
  upstream: GatewayUpstream;
  model: GatewayModel;
}

// Packages that do NOT natively speak the OpenAI chat-completions dialect. A
// `passthrough` route to one of these is probably misconfigured (use
// `adapter: opencode` to translate). `openai-compatible` and `openai/chat` are
// chat-native and deliberately absent.
const NON_CHAT_NATIVE_PACKAGES = new Set<string>([
  "@opencode/ai/providers/anthropic",
  "@opencode/ai/providers/anthropic-compatible",
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/openai-compatible/responses",
]);

function findModel(config: GatewayConfig, id: string): Route | null {
  for (const upstream of config.upstreams) {
    const model = upstream.models.find((m) => m.id === id);
    if (model) return { upstream, model };
  }
  return null;
}

/** A positive-integer `context_length` from an upstream `/models` payload, else undefined. */
function contextHint(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A `/v1/models` row: the OpenAI shape plus LibreChat's `context_length` and `pricing`. */
interface ModelRow {
  id: string;
  object: string;
  owned_by: string;
  /** Resolved context window (never null: rows without one are omitted). */
  context_length: number;
  /** USD per token, as strings, so LibreChat's `parseFloat` can read them. */
  pricing: { prompt: string; completion: string };
}

/** `ResolvedModel.cost` (USD per 1e6 tokens) -> LibreChat's USD-per-token strings. */
function pricingOf(cost: ModelCost | null): { prompt: string; completion: string } {
  return {
    prompt: String((cost?.input ?? 0) / 1e6),
    completion: String((cost?.output ?? 0) / 1e6),
  };
}

export function createApp(config: GatewayConfig | ConfigProvider, opts: AppOptions = {}) {
  const fetchUpstream: UpstreamFetcher = opts.fetchUpstream ?? ((url, init) => globalThis.fetch(url, init));
  const getConfig: ConfigProvider = typeof config === "function" ? config : () => config;
  const logger = opts.logger ?? noopLogger;
  // F7c: single limiter for the process; reads the live config so a reload is
  // picked up, memoizing buckets per scope:id:rpm:burst.
  const limiter = createRateLimiter({ now: opts.now ?? (() => Date.now()), config: () => getConfig() });
  // F6: pure resolver over an injected index. A store is never constructed here.
  const resolver = createModelResolver(opts.modelsdev ?? (() => null), { logger });
  // F8: default session ids are stable per upstream for the process lifetime so
  // a client that omits the session header still gets one cache-friendly id.
  const sessionIds = new Map<string, string>();
  const stableSessionId = (upstreamId: string): string => {
    let id = sessionIds.get(upstreamId);
    if (id === undefined) {
      id = crypto.randomUUID();
      sessionIds.set(upstreamId, id);
    }
    return id;
  };
  const generateSessionId = opts.generateSessionId ?? stableSessionId;

  interface LogContext {
    model: string | null;
    upstream: string | null;
    completed?: Promise<AdapterMeta | null> | null;
  }

  /** null when the request may proceed; a 429 envelope when a bucket denies it. */
  function rateLimitResponse(upstreamId: string | null): Response | null {
    const v = limiter.check(upstreamId);
    if (v.ok) return null;
    return errorResponse("Rate limit exceeded", 429, "invalid_request_error", {
      code: "rate_limit_exceeded",
      headers: { "retry-after": String(Math.max(1, Math.ceil(v.retryAfterMs / 1000))) },
    });
  }

  /**
   * Shared prep for the POST generation routes: parse JSON -> 400, resolve the
   * route -> 404, then apply the global/per-upstream bucket -> 429. Sets the log
   * context as soon as the route is known. Returns a `Response` to short-circuit.
   */
  async function prepareGeneration(
    req: Request,
    config: GatewayConfig,
    ctx: LogContext,
  ): Promise<{ route: Route; upstream: GatewayUpstream; body: Record<string, unknown> } | Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("invalid JSON body", 400);
    }
    const requested = typeof body.model === "string" ? body.model : null;
    const route = requested !== null ? findModel(config, requested) : null;
    if (!route) {
      return errorResponse(`model not found: ${String(body.model)}`, 404);
    }
    ctx.model = requested;
    ctx.upstream = route.upstream.id;
    // F7c: apply the global and/or per-upstream bucket right after the route
    // resolves (and after the auth gate), inside the logged path so a 429
    // emits exactly one `request` event.
    const limited = rateLimitResponse(route.upstream.id);
    if (limited) return limited;
    // F8: enrich the route's upstream with the resolved headers so both the
    // passthrough and opencode adapters send them (auth unchanged).
    const upstream: GatewayUpstream = {
      ...route.upstream,
      headers: resolveUpstreamHeaders({ upstream: route.upstream, inbound: req.headers, generateSessionId }),
    };
    return { route, upstream, body };
  }

  async function handle(req: Request, ctx: LogContext): Promise<Response> {
    const config = getConfig();
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    // F7a: gate every data route. Runs inside `handle` (logged `fetch` wrapper)
    // so a 401/misconfigured response still emits exactly one `request` event.
    const auth = resolveAuth(config.auth);
    if (auth.mode === "misconfigured" || (auth.mode === "enforced" && !isAuthorized(req, auth.config))) {
      return unauthorizedResponse();
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      // LibreChat's `fetchModels()` parses this body against a schema that
      // requires `context_length: number` and string `pricing` on EVERY row, so
      // a single null/number-less row fails the whole response. Emit only rows
      // with a resolved context, and always include pricing (USD per token).
      const data: ModelRow[] = [];
      // Registry-first precedence: every configured id shadows a discovered one,
      // even when the configured row itself is omitted for lacking a context.
      const known = new Set<string>();
      for (const u of config.upstreams) {
        for (const m of u.models) {
          known.add(m.id);
          const resolved = resolver.resolve(u, m);
          const context = resolved.model.context;
          if (context === undefined) continue;
          data.push({
            id: m.id,
            object: "model",
            owned_by: u.id,
            context_length: context,
            pricing: pricingOf(resolved.cost),
          });
        }
      }
      for (const u of config.upstreams) {
        if (!u.discover) continue;
        try {
          // F8: static headers + default UA; no session (discovery is not a
          // conversation) and apiKey auth applied last (case-collapsed).
          const headers = resolveUpstreamHeaders({ upstream: u });
          const apiKey = resolveApiKey(u);
          if (apiKey) setHeader(headers, "authorization", `Bearer ${apiKey}`);
          const res = await fetchUpstream(`${u.baseURL}/models`, { headers });
          if (!res.ok) continue;
          const listed = (await res.json()) as {
            data?: Array<{ id?: string; context_length?: unknown }>;
          };
          for (const m of listed.data ?? []) {
            if (typeof m.id === "string" && !known.has(m.id)) {
              known.add(m.id);
              const hint = contextHint(m.context_length);
              const context = resolver.resolveDiscovered(u, m.id, hint).context;
              if (context === null || context === undefined) continue;
              // No ResolvedModel for a discovered id, so no resolved cost to
              // read: advertise "0" rather than re-deriving pricing here.
              data.push({
                id: m.id,
                object: "model",
                owned_by: u.id,
                context_length: context,
                pricing: { prompt: "0", completion: "0" },
              });
            }
          }
        } catch (e) {
          safeLog(logger, { level: "error", msg: "discovery failed", upstream: u.id, error: String(e).slice(0, 300) });
          continue;
        }
      }
      return Response.json({ object: "list", data });
    }

    if (req.method === "GET" && url.pathname === "/librechat/tokenConfig") {
      const resolved: ResolvedModel[] = [];
      for (const u of config.upstreams) {
        for (const m of u.models) resolved.push(resolver.resolve(u, m));
      }
      return Response.json(tokenConfigOf(resolved));
    }

    if (req.method === "GET" && url.pathname === "/librechat.yaml.fragment") {
      const seen = new Set<string>();
      const models: FragmentModel[] = [];
      for (const u of config.upstreams) {
        for (const m of u.models) {
          if (seen.has(m.id)) continue; // registry order, first wins
          seen.add(m.id);
          models.push({ id: m.id, context: resolver.resolve(u, m).model.context ?? null });
        }
      }
      const lc = config.librechat;
      return fragmentResponse(
        buildLibreChatFragment({
          name: lc?.name ?? "openproxy",
          baseURL: lc?.baseURL ?? `${url.origin}/v1`,
          apiKey: lc?.apiKey ?? authToken(config.auth) ?? "dummy",
          models,
        }),
      );
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const prep = await prepareGeneration(req, config, ctx);
      if (prep instanceof Response) return prep;
      const { route, upstream, body } = prep;
      const kind = selectAdapter(route.upstream);
      if (kind === "passthrough" && NON_CHAT_NATIVE_PACKAGES.has(route.upstream.package)) {
        safeLog(logger, {
          level: "warn",
          msg: "passthrough to a non-OpenAI-compatible package may be incorrect",
          upstream: route.upstream.id,
          package: route.upstream.package,
        });
      }
      const adapter = createAdapter(kind, { fetchUpstream, ai: opts.ai ?? defaultAiRuntime });
      const resolved = resolver.resolve(route.upstream, route.model);
      const result = await adapter.handle({
        upstream,
        model: resolved.model,
        body,
        signal: req.signal,
        cost: resolved.cost,
      });
      ctx.completed = result.completed ?? null;
      return result.response;
    }

    // F7d: the OpenAI Responses API is always served by the translating adapter
    // (a `passthrough` upstream still normalizes Responses -> Chat -> IR).
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const prep = await prepareGeneration(req, config, ctx);
      if (prep instanceof Response) return prep;
      const { route, upstream, body } = prep;
      const adapter = createResponsesAdapter({ fetchUpstream, ai: opts.ai ?? defaultAiRuntime });
      const resolved = resolver.resolve(route.upstream, route.model);
      const result = await adapter.handle({
        upstream,
        model: resolved.model,
        body,
        signal: req.signal,
        cost: resolved.cost,
      });
      ctx.completed = result.completed ?? null;
      return result.response;
    }

    return errorResponse("not found", 404);
  }

  async function fetch(req: Request): Promise<Response> {
    const started = performance.now();
    const path = new URL(req.url).pathname;
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const ctx: LogContext = { model: null, upstream: null };
    let res: Response;
    try {
      res = await handle(req, ctx);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Post-headers stream errors are NOT catchable here; accepted.
      safeLog(logger, { level: "error", msg: "request failed", request_id: requestId, method: req.method,
        path, model: ctx.model, upstream: ctx.upstream, status: 500,
        latency_ms: Math.round(performance.now() - started), error: err.message, stack: err.stack });
      return errorResponse("internal error", 500, "server_error");
    }
    safeLog(logger, { level: "info", msg: "request", request_id: requestId, method: req.method, path,
      model: ctx.model, upstream: ctx.upstream, status: res.status,
      latency_ms: Math.round(performance.now() - started),
      // Passthrough today: bodies not parsed; usage unknown and ALWAYS null for streams. F4 fills these.
      usage: null, context_ratio: null });
    // Translated adapter path: emit a follow-up `generation` event once the
    // generation finishes (for SSE, after the stream drains). Never awaited.
    if (ctx.completed) {
      void ctx.completed.then((meta) => {
        if (!meta) return;
        safeLog(logger, { level: "info", msg: "generation", request_id: requestId, model: ctx.model, upstream: ctx.upstream,
          tokens_in: meta.usage?.tokensIn ?? null, tokens_out: meta.usage?.tokensOut ?? null,
          tokens_total: meta.usage?.tokensTotal ?? null, context_ratio: meta.contextRatio,
          finish_reason: meta.finishReason, cost_usd: meta.costUsd ?? null });
      }).catch(() => {});
    }
    return res;
  }

  return { fetch };
}
