// F11: derive an upstream's dialect + base URL from models.dev.
//
// A model's transport is described twice in the catalog: once at the provider
// level (`ModelsDevProvider.npm` / `.api`) and, for models that deviate from
// their provider, per model (`ModelsDevModel.provider`). `@ai-sdk/*` package
// names map onto the @opencode/ai provider subpaths the gateway already speaks,
// so an upstream can leave `package`/`baseURL` unset and let these two helpers
// fill them in per model.
import type { ProviderPackage } from "./config";

/**
 * models.dev `npm` -> the @opencode/ai provider subpath that speaks that dialect.
 *
 * `@ai-sdk/openai` is the OpenAI *Responses* protocol (the AI SDK's
 * `openai.responses()`); the gateway reaches it through the generic
 * `openai-compatible/responses` package so it works against any
 * OpenAI-Responses-compatible host (e.g. OpenCode Go), not just api.openai.com.
 * `@ai-sdk/google` (and every other npm) has no gateway package yet, so it
 * stays unresolved: the model is advertised only if it also has an explicit
 * package, and is never routable by derivation alone.
 */
const NPM_PACKAGES: Record<string, ProviderPackage> = {
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
  "@ai-sdk/openai": "@opencode/ai/providers/openai-compatible/responses",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic-compatible",
};

/** The gateway package for a models.dev `npm`, or undefined when unsupported. */
export function packageForNpm(npm: string | undefined): ProviderPackage | undefined {
  if (npm === undefined) return undefined;
  return NPM_PACKAGES[npm.trim().toLowerCase()];
}

/** Lowercased hostname of a URL, or null when absent / unparseable. */
export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is `host` allowed by the allowlist? Exact hostname match, case-insensitive.
 * An absent/empty allowlist trusts nothing — a derived base URL is never
 * accepted without one, so a catalog cannot redirect the upstream key.
 */
export function hostTrusted(host: string | null, trustedHosts: readonly string[] | undefined): boolean {
  if (host === null || trustedHosts === undefined || trustedHosts.length === 0) return false;
  const wanted = host.toLowerCase();
  return trustedHosts.some((t) => t.toLowerCase() === wanted);
}
