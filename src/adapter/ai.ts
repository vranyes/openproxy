// The one place the gateway touches the concrete @opencode/ai runtime.
//
// The runtime is injected (`AdapterDeps.ai`) so tests can drive translation
// without a network round-trip, and so the rest of the adapter layer depends on
// our small `AiRuntime` surface rather than the package's Effect types.
//
// F5: `modelFor` dispatches by `upstream.package` to the matching provider
// package, so any of the 7 known dialects translates through the same IR.
import { ai } from "@opencode/ai/promise";
import * as Auth from "@opencode/ai/route/auth";
import * as Anthropic from "@opencode/ai/providers/anthropic";
import * as AnthropicCompatible from "@opencode/ai/providers/anthropic-compatible";
import * as OpenAI from "@opencode/ai/providers/openai";
import * as OpenAICompatible from "@opencode/ai/providers/openai-compatible";
import * as OpenAICompatibleResponses from "@opencode/ai/providers/openai-compatible/responses";
import type { LanguageModel, LLM, LLMEvent, LLMResponse } from "@opencode/ai";
import { resolveApiKey, type GatewayModel, type GatewayUpstream } from "../config";

type Model = LanguageModel;
type ProviderSettings = { baseURL: string; apiKey: string } | { baseURL: string; auth: Auth.Definition };

/** Auth-aware settings shared by every provider package's `configure`. */
function settingsOf(u: GatewayUpstream): ProviderSettings {
  const apiKey = resolveApiKey(u);
  return apiKey ? { baseURL: u.baseURL, apiKey } : { baseURL: u.baseURL, auth: Auth.none };
}

/** Build the provider-native language model for an upstream, dispatching by `package`. */
export function modelFor(upstream: GatewayUpstream, id: string): Model {
  const settings = settingsOf(upstream);
  switch (upstream.package) {
    case "@opencode/ai/providers/anthropic":
      return Anthropic.configure(settings).model(id);
    case "@opencode/ai/providers/anthropic-compatible":
      return AnthropicCompatible.configure(settings).model(id);
    case "@opencode/ai/providers/openai":
    case "@opencode/ai/providers/openai/responses":
      return OpenAI.configure(settings).model(id);
    case "@opencode/ai/providers/openai/chat":
      return OpenAI.configure(settings).chat(id);
    case "@opencode/ai/providers/openai-compatible":
      return OpenAICompatible.configure(settings).model(id);
    case "@opencode/ai/providers/openai-compatible/responses":
      return OpenAICompatibleResponses.configure(settings).model(id);
    default: {
      const n: never = upstream.package;
      throw new Error(`unsupported provider package: ${String(n)}`);
    }
  }
}

export interface AiRuntime {
  model(upstream: GatewayUpstream, model: GatewayModel): Model;
  generate(model: Model, input: LLM.RequestInput<Model>, opts?: { signal?: AbortSignal }): Promise<LLMResponse>;
  stream(model: Model, input: LLM.RequestInput<Model>, opts?: { signal?: AbortSignal }): AsyncIterable<LLMEvent>;
}

export const defaultAiRuntime: AiRuntime = {
  model: (upstream, model) => modelFor(upstream, model.upstream ?? model.id),
  generate: (m, input, opts) => ai.llm.generate({ ...input, model: m }, opts),
  stream: (m, input, opts) => ai.llm.stream({ ...input, model: m }, opts),
};
