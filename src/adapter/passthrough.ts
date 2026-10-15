// Byte relay for `passthrough` upstreams: exactly today's behavior, including
// F3 context-overflow classification. No translation, no metrics.
import { resolveApiKey } from "../config";
import { detectContextOverflow } from "../context";
import type { AdapterDeps } from "./index";
import type { Adapter, AdapterInput, AdapterResult } from "./types";

export function createPassthroughAdapter(deps: AdapterDeps): Adapter {
  return {
    async handle({ upstream, model, body }: AdapterInput): Promise<AdapterResult> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const apiKey = resolveApiKey(upstream);
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const upstreamBody = { ...body, model: model.upstream ?? model.id };
      const upstreamRes = await deps.fetchUpstream(`${upstream.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      });
      // F3: classify context-overflow rejections into a clean 400. Only non-ok,
      // client-scoped (4xx) responses are inspected, under a byte cap and timeout;
      // successful (possibly SSE) bodies are never read.
      const overflow = await detectContextOverflow(upstreamRes, model);
      return { response: overflow ?? upstreamRes };
    },
  };
}
