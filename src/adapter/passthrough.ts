// Byte relay for `passthrough` upstreams: exactly today's behavior, including
// F3 context-overflow classification. No translation, no metrics.
import { resolveApiKey } from "../config";
import { detectContextOverflow } from "../context";
import { setHeader } from "../headers";
import type { AdapterDeps } from "./index";
import type { Adapter, AdapterInput, AdapterResult } from "./types";

export function createPassthroughAdapter(deps: AdapterDeps): Adapter {
  return {
    async handle({ upstream, model, body }: AdapterInput): Promise<AdapterResult> {
      // F8: start from the resolved static/session headers, then force the JSON
      // content type and let apiKey auth win (both collapse case-variant keys).
      const headers: Record<string, string> = { ...(upstream.headers ?? {}) };
      setHeader(headers, "content-type", "application/json"); // forced; JSON body
      const apiKey = resolveApiKey(upstream);
      if (apiKey) setHeader(headers, "authorization", `Bearer ${apiKey}`); // auth wins; case-collapsed
      const upstreamBody = { ...body, model: model.upstream ?? model.id };
      const baseURL = upstream.baseURL;
      if (baseURL === undefined) throw new Error(`upstream ${upstream.id} has no baseURL (unroutable)`);
      const upstreamRes = await deps.fetchUpstream(`${baseURL}/chat/completions`, {
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
