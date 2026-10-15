import {
  resolveApiKey,
  type ConfigProvider,
  type GatewayConfig,
  type GatewayModel,
  type GatewayUpstream,
} from "./config";
import { detectContextOverflow } from "./context";
import { errorResponse } from "./ops/errors";
import { noopLogger, safeLog, type Logger } from "./ops/log";

export type UpstreamFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface AppOptions {
  fetchUpstream?: UpstreamFetcher;
  logger?: Logger;
}

interface Route {
  upstream: GatewayUpstream;
  model: GatewayModel;
}

function findModel(config: GatewayConfig, id: string): Route | null {
  for (const upstream of config.upstreams) {
    const model = upstream.models.find((m) => m.id === id);
    if (model) return { upstream, model };
  }
  return null;
}

export function createApp(config: GatewayConfig | ConfigProvider, opts: AppOptions = {}) {
  const fetchUpstream: UpstreamFetcher = opts.fetchUpstream ?? ((url, init) => globalThis.fetch(url, init));
  const getConfig: ConfigProvider = typeof config === "function" ? config : () => config;
  const logger = opts.logger ?? noopLogger;

  interface LogContext {
    model: string | null;
    upstream: string | null;
  }

  async function handle(req: Request, ctx: LogContext): Promise<Response> {
    const config = getConfig();
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data: Array<{ id: string; object: string; owned_by: string; context_length: number | null }> =
        config.upstreams.flatMap((u) =>
          u.models.map((m) => ({ id: m.id, object: "model", owned_by: u.id, context_length: m.context ?? null })),
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
          const listed = (await res.json()) as { data?: Array<{ id?: string }> };
          for (const m of listed.data ?? []) {
            if (typeof m.id === "string" && !known.has(m.id)) {
              known.add(m.id);
              data.push({ id: m.id, object: "model", owned_by: u.id, context_length: null });
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
      const tokenConfig: Record<string, { context: number }> = {};
      for (const u of config.upstreams) {
        // Models without a known context are omitted until models.dev resolution (F6).
        for (const m of u.models) if (m.context !== undefined) tokenConfig[m.id] = { context: m.context };
      }
      return Response.json(tokenConfig);
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
      const headers: Record<string, string> = { "content-type": "application/json" };
      const apiKey = resolveApiKey(route.upstream);
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const upstreamBody = { ...body, model: route.model.upstream ?? route.model.id };
      const upstreamRes = await fetchUpstream(`${route.upstream.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      });
      // F3: classify context-overflow rejections into a clean 400. Only non-ok,
      // client-scoped (4xx) responses are inspected, under a byte cap and timeout;
      // successful (possibly SSE) bodies are never read.
      const overflow = await detectContextOverflow(upstreamRes, route.model);
      if (overflow) return overflow;
      return upstreamRes;
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
    return res;
  }

  return { fetch };
}
