import {
  resolveApiKey,
  type ConfigProvider,
  type GatewayConfig,
  type GatewayModel,
  type GatewayUpstream,
} from "./config";
import { createAdapter, selectAdapter } from "./adapter";
import { defaultAiRuntime, type AiRuntime } from "./adapter/ai";
import type { AdapterMeta } from "./adapter/types";
import { buildLibreChatFragment, fragmentResponse, type FragmentModel } from "./librechat";
import { createModelResolver, tokenConfigOf, type ResolvedModel } from "./registry";
import type { ModelsDevIndex } from "./modelsdev";
import { errorResponse } from "./ops/errors";
import { authToken, isAuthorized, resolveAuth, unauthorizedResponse } from "./ops/auth";
import { noopLogger, safeLog, type Logger } from "./ops/log";

export type UpstreamFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface AppOptions {
  fetchUpstream?: UpstreamFetcher;
  logger?: Logger;
  ai?: AiRuntime;
  /** models.dev index getter (F6). Omit to disable models.dev resolution. */
  modelsdev?: () => ModelsDevIndex | null;
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

export function createApp(config: GatewayConfig | ConfigProvider, opts: AppOptions = {}) {
  const fetchUpstream: UpstreamFetcher = opts.fetchUpstream ?? ((url, init) => globalThis.fetch(url, init));
  const getConfig: ConfigProvider = typeof config === "function" ? config : () => config;
  const logger = opts.logger ?? noopLogger;
  // F6: pure resolver over an injected index. A store is never constructed here.
  const resolver = createModelResolver(opts.modelsdev ?? (() => null), { logger });

  interface LogContext {
    model: string | null;
    upstream: string | null;
    completed?: Promise<AdapterMeta | null> | null;
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
      const data: Array<{ id: string; object: string; owned_by: string; context_length: number | null }> =
        config.upstreams.flatMap((u) =>
          u.models.map((m) => ({
            id: m.id,
            object: "model",
            owned_by: u.id,
            context_length: resolver.resolve(u, m).model.context ?? null,
          })),
        );
      const known = new Set(data.map((m) => m.id));
      for (const u of config.upstreams) {
        if (!u.discover) continue;
        try {
          const headers: Record<string, string> = {};
          const apiKey = resolveApiKey(u);
          if (apiKey) headers.authorization = `Bearer ${apiKey}`;
          const res = await fetchUpstream(`${u.baseURL}/models`, { headers });
          if (!res.ok) continue;
          const listed = (await res.json()) as {
            data?: Array<{ id?: string; context_length?: unknown }>;
          };
          for (const m of listed.data ?? []) {
            if (typeof m.id === "string" && !known.has(m.id)) {
              known.add(m.id);
              const hint = contextHint(m.context_length);
              data.push({
                id: m.id,
                object: "model",
                owned_by: u.id,
                context_length: resolver.resolveDiscovered(u, m.id, hint).context,
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
        upstream: route.upstream,
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
