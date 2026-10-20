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
type ProviderSettings = ({ baseURL: string; apiKey: string } | { baseURL: string; auth: Auth.Definition }) & {
  headers?: Record<string, string>;
  http?: { timeout?: number | false; headerTimeout?: number | false; chunkTimeout?: number | false };
};

/** Auth-aware settings shared by every provider package's `configure`. */
function settingsOf(u: GatewayUpstream, model?: GatewayModel): ProviderSettings {
  const baseURL = u.baseURL;
  if (baseURL === undefined) {
    throw new Error(`upstream ${u.id} has no baseURL (unroutable)`);
  }
  const apiKey = resolveApiKey(u);
  const base = apiKey ? { baseURL, apiKey } : { baseURL, auth: Auth.none };
  const out: ProviderSettings = { ...base };
  // F8: pass static/session headers only when present. (Callers enrich the
  // upstream with a default user-agent first, so in the server path this is
  // effectively always true; the guard matters for direct modelFor calls.)
  if (u.headers && Object.keys(u.headers).length > 0) out.headers = u.headers;
  // Optional HTTP bounds: per-model wins over upstream; absent stays unset so
  // the SDK defaults (header 5min, chunk 15min, no whole-request timeout) apply.
  // Merged per field so a model can override one bound without losing the rest.
  const http = { ...u.http, ...model?.http };
  if (http.timeout !== undefined || http.headerTimeout !== undefined || http.chunkTimeout !== undefined) {
    out.http = http;
  }
  return out;
}

/** Build the provider-native language model for an upstream, dispatching by `package`. */
export function modelFor(upstream: GatewayUpstream, id: string, model?: GatewayModel): Model;
export function modelFor(upstream: GatewayUpstream, model: GatewayModel): Model;
export function modelFor(upstream: GatewayUpstream, idOrModel: string | GatewayModel, model?: GatewayModel): Model {
  const pkg = upstream.package;
  if (pkg === undefined) {
    throw new Error(`upstream ${upstream.id} has no package (unroutable)`);
  }
  const resolved: GatewayModel | undefined =
    typeof idOrModel === "string" ? model : (idOrModel as GatewayModel);
  const id = typeof idOrModel === "string" ? idOrModel : (idOrModel as GatewayModel).upstream ?? (idOrModel as GatewayModel).id;
  const settings = settingsOf(upstream, resolved);
  switch (pkg) {
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
      const n: never = pkg;
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
  model: (upstream, model) => modelFor(upstream, model),
  generate: (m, input, opts) => ai.llm.generate({ ...input, model: m }, opts),
  stream: (m, input, opts) => ai.llm.stream({ ...input, model: m }, opts),
};
