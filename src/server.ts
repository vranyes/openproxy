import { resolveApiKey, type GatewayConfig, type GatewayModel, type GatewayUpstream } from "./config";

export type UpstreamFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface AppOptions {
  fetchUpstream?: UpstreamFetcher;
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

export function createApp(config: GatewayConfig, opts: AppOptions = {}) {
  const fetchUpstream: UpstreamFetcher = opts.fetchUpstream ?? ((url, init) => fetch(url, init));

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = config.upstreams.flatMap((u) =>
        u.models.map((m) => ({ id: m.id, object: "model", owned_by: u.id })),
      );
      return Response.json({ object: "list", data });
    }

    if (req.method === "GET" && url.pathname === "/librechat/tokenConfig") {
      const tokenConfig: Record<string, { context: number }> = {};
      for (const u of config.upstreams) {
        for (const m of u.models) tokenConfig[m.id] = { context: m.context };
      }
      return Response.json(tokenConfig);
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
      }
      const route = typeof body.model === "string" ? findModel(config, body.model) : null;
      if (!route) {
        return Response.json(
          { error: { message: `model not found: ${String(body.model)}`, type: "invalid_request_error" } },
          { status: 404 },
        );
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      const apiKey = resolveApiKey(route.upstream);
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const upstreamBody = { ...body, model: route.model.upstream ?? route.model.id };
      return fetchUpstream(`${route.upstream.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      });
    }

    return Response.json({ error: { message: "not found", type: "invalid_request_error" } }, { status: 404 });
  }

  return { fetch };
}
