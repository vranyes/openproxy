// The one place the gateway touches the concrete @opencode/ai runtime.
//
// The runtime is injected (`AdapterDeps.ai`) so tests can drive translation
// without a network round-trip, and so the rest of the adapter layer depends on
// our small `AiRuntime` surface rather than the package's Effect types.
import { ai } from "@opencode/ai/promise";
import type { LLM, LLMEvent, LLMResponse } from "@opencode/ai";
import * as Auth from "@opencode/ai/route/auth";
import { OpenAICompatible } from "@opencode/ai/providers/openai-compatible";
import { resolveApiKey, type GatewayModel, type GatewayUpstream } from "../config";

type Model = ReturnType<ReturnType<typeof OpenAICompatible.configure>["model"]>;

export interface AiRuntime {
  model(upstream: GatewayUpstream, model: GatewayModel): Model;
  generate(model: Model, input: LLM.RequestInput<Model>, opts?: { signal?: AbortSignal }): Promise<LLMResponse>;
  stream(model: Model, input: LLM.RequestInput<Model>, opts?: { signal?: AbortSignal }): AsyncIterable<LLMEvent>;
}

export const defaultAiRuntime: AiRuntime = {
  model(upstream, model) {
    const apiKey = resolveApiKey(upstream);
    const provider = OpenAICompatible.configure(
      apiKey ? { baseURL: upstream.baseURL, apiKey } : { baseURL: upstream.baseURL, auth: Auth.none },
    );
    return provider.model(model.upstream ?? model.id);
  },
  generate: (m, input, opts) => ai.llm.generate({ ...input, model: m }, opts),
  stream: (m, input, opts) => ai.llm.stream({ ...input, model: m }, opts),
};
