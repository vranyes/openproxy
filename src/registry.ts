// F6: resolve context / maxOutput / capabilities for a gateway model from
// models.dev, with a strict, deterministic precedence:
//
//   explicit config  >  models.dev snapshot  >  upstream discovery hint
//
// Resolution NEVER picks a provider arbitrarily. When several providers match
// equally, the model stays unresolved and a warn-once entry is logged. The
// config model is never mutated: `resolve()` returns a fresh copy.
import type { GatewayModel, GatewayUpstream, ModelsDevOverride } from "./config";
import type { ModelMatch, ModelsDevIndex, ModelsDevModel } from "./modelsdev";
import { noopLogger, safeLog, type Logger } from "./ops/log";

export type MetadataSource = "explicit" | "modelsdev" | "discover" | "none";

export interface ResolvedCapabilities {
  vision?: boolean;
  tools?: boolean;
}

export interface ResolvedModel {
  upstream: GatewayUpstream;
  model: GatewayModel;
  contextSource: MetadataSource;
  maxOutput?: number;
  maxOutputSource: MetadataSource;
  capabilities: ResolvedCapabilities;
  modelsDev: { provider: string; model: string } | null;
}

export interface DiscoveredResolution {
  context: number | null;
  contextSource: MetadataSource;
  modelsDev: { provider: string; model: string } | null;
}

export interface ModelResolver {
  resolve(upstream: GatewayUpstream, model: GatewayModel, hint?: number): ResolvedModel;
  resolveDiscovered(upstream: GatewayUpstream, id: string, hint?: number): DiscoveredResolution;
  candidates(upstream: GatewayUpstream, model: GatewayModel): string[];
}

export interface ModelResolverOptions {
  logger?: Logger;
}

interface ModelsDevRef {
  provider?: string;
  model?: string;
}

/** An object override (not `false`), else null. */
function refOf(value: ModelsDevOverride | undefined): ModelsDevRef | null {
  return typeof value === "object" && value !== null ? value : null;
}

function nonEmpty(values: ReadonlyArray<string | undefined>): string[] {
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function uniq(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

/** Lowercased hostname, or null when the URL is absent / unparseable. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function contextCapabilities(m: GatewayModel, entry: ModelsDevModel): ResolvedCapabilities {
  const capabilities: ResolvedCapabilities = {};
  const vision = visionOf(m, entry);
  if (vision !== undefined) capabilities.vision = vision;
  if (m.supportsTools !== undefined) capabilities.tools = m.supportsTools;
  else if (entry.tool_call !== undefined) capabilities.tools = entry.tool_call;
  return capabilities;
}

function visionOf(m: GatewayModel, entry: ModelsDevModel): boolean | undefined {
  if (m.supportsVision !== undefined) return m.supportsVision;
  if (entry.attachment === true) return true;
  if (entry.modalities?.input?.includes("image") === true) return true;
  return false;
}

export function createModelResolver(
  getIndex: () => ModelsDevIndex | null,
  opts: ModelResolverOptions = {},
): ModelResolver {
  const logger = opts.logger ?? noopLogger;

  // Bounded warn-once FIFO (cap 256): one log per key; evicting the oldest lets
  // a recurring problem warn again instead of going permanently silent.
  const WARN_CAP = 256;
  const warned = new Set<string>();
  const warnOrder: string[] = [];
  function warnOnce(key: string, event: Parameters<typeof safeLog>[1]): void {
    if (warned.has(key)) return;
    warned.add(key);
    warnOrder.push(key);
    if (warnOrder.length > WARN_CAP) {
      const oldest = warnOrder.shift();
      if (oldest !== undefined) warned.delete(oldest);
    }
    safeLog(logger, event);
  }

  function disabled(u: GatewayUpstream, m: GatewayModel): boolean {
    return m.modelsDev === false || u.modelsDev === false;
  }

  function candidateKeys(u: GatewayUpstream, m: GatewayModel): string[] {
    const mRef = refOf(m.modelsDev);
    const uRef = refOf(u.modelsDev);
    const refModel = mRef?.model ?? uRef?.model;
    return uniq(nonEmpty([refModel, m.upstream, m.id]));
  }

  function refProvider(u: GatewayUpstream, m: GatewayModel): string | undefined {
    return refOf(m.modelsDev)?.provider ?? refOf(u.modelsDev)?.provider;
  }

  // --- match sources ---------------------------------------------------------

  /** Upstream id as a provider, only when the provider has an api host equal to the upstream's. */
  function idSource(u: GatewayUpstream, idx: ModelsDevIndex): string[] {
    if (!idx.hasProvider(u.id)) return [];
    const p = idx.getProvider(u.id);
    if (!p || p.api == null) return [];
    const providerHost = hostOf(p.api);
    const upstreamHost = hostOf(u.baseURL);
    if (providerHost !== null && providerHost === upstreamHost) return [u.id];
    if (providerHost !== null && upstreamHost !== null) {
      warnOnce(`id-host-mismatch:${u.id}`, {
        level: "warn",
        msg: "models.dev id host does not match upstream baseURL; ignoring id",
        upstream: u.id,
        provider_host: providerHost,
        upstream_host: upstreamHost,
      });
    }
    return [];
  }

  /** Providers declaring the upstream's apiKeyEnv. */
  function envSource(u: GatewayUpstream, idx: ModelsDevIndex): string[] {
    if (u.apiKeyEnv == null) return [];
    return idx.providersWithEnv(u.apiKeyEnv);
  }

  /** The provider implied by the @opencode/ai package. */
  function packageSource(u: GatewayUpstream, idx: ModelsDevIndex): string[] {
    switch (u.package) {
      case "@opencode/ai/providers/openai":
      case "@opencode/ai/providers/openai/chat":
      case "@opencode/ai/providers/openai/responses":
        return idx.hasProvider("openai") ? ["openai"] : [];
      case "@opencode/ai/providers/anthropic":
      case "@opencode/ai/providers/anthropic-compatible":
        return idx.hasProvider("anthropic") ? ["anthropic"] : [];
      case "@opencode/ai/providers/openai-compatible":
      case "@opencode/ai/providers/openai-compatible/responses":
        return [];
    }
  }

  /** Providers whose api host equals the upstream baseURL host. */
  function hostSource(u: GatewayUpstream, idx: ModelsDevIndex): string[] {
    const host = hostOf(u.baseURL);
    if (host === null) return [];
    return idx.providersByHost(host);
  }

  function match(u: GatewayUpstream, m: GatewayModel, idx: ModelsDevIndex): ModelMatch | null {
    const keys = candidateKeys(u, m);
    const provider = refProvider(u, m);

    // 1. An explicit provider reference is authoritative: it resolves or it
    //    does not, with no fallback to inference.
    if (provider != null) {
      if (idx.hasProvider(provider)) {
        const mm = idx.findInProvider(provider, keys);
        if (mm) return mm;
      }
      warnOnce(`explicit-miss:${provider}:${u.id}:${m.id}`, {
        level: "warn",
        msg: "explicit modelsDev provider did not match; leaving unresolved",
        upstream: u.id,
        model: m.id,
        provider,
        keys,
      });
      return null;
    }

    // 2. Inference sources, in a fixed order. A source that hits exactly one
    //    provider wins; more than one is ambiguous (warn) and falls through.
    const sources: Array<{ name: string; list: string[] }> = [
      { name: "id", list: idSource(u, idx) },
      { name: "env", list: envSource(u, idx) },
      { name: "package", list: packageSource(u, idx) },
      { name: "host", list: hostSource(u, idx) },
    ];
    for (const source of sources) {
      const providers = uniq(source.list);
      if (providers.length === 0) continue;
      const hitting = providers.filter((p) => idx.findInProvider(p, keys) !== null);
      if (hitting.length === 1) return idx.findInProvider(hitting[0]!, keys);
      if (hitting.length > 1) {
        warnOnce(`ambiguous-${source.name}:${u.id}:${m.id}`, {
          level: "warn",
          msg: "models.dev resolution ambiguous across providers; falling through",
          upstream: u.id,
          model: m.id,
          source: source.name,
          providers: hitting,
        });
      }
    }

    // 3. A globally unique exact key. Never a suffix match (that needs a
    //    provider context to stay deterministic).
    const matches = idx.findProvidersWithAnyKey(keys);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      warnOnce(`ambiguous-global:${u.id}:${m.id}`, {
        level: "warn",
        msg: "models.dev resolution ambiguous across the whole catalog; leaving unresolved",
        upstream: u.id,
        model: m.id,
        keys,
        providers: matches.map((x) => x.provider),
      });
    }
    return null;
  }

  // --- result builders -------------------------------------------------------

  /** Fresh copy carrying only explicit config (+ optional hint). Never mutates `m`. */
  function base(u: GatewayUpstream, m: GatewayModel, hint?: number): ResolvedModel {
    const model: GatewayModel = { ...m };
    const context = m.context ?? hint;
    if (context !== undefined) model.context = context;
    const capabilities: ResolvedCapabilities = {};
    if (m.supportsVision !== undefined) capabilities.vision = m.supportsVision;
    if (m.supportsTools !== undefined) capabilities.tools = m.supportsTools;
    return {
      upstream: u,
      model,
      contextSource: m.context !== undefined ? "explicit" : hint !== undefined ? "discover" : "none",
      maxOutput: m.maxOutput,
      maxOutputSource: m.maxOutput !== undefined ? "explicit" : "none",
      capabilities,
      modelsDev: null,
    };
  }

  function matched(u: GatewayUpstream, m: GatewayModel, hint: number | undefined, mm: ModelMatch): ResolvedModel {
    const entry = mm.entry;
    const mdContext = entry.limit?.context;

    let context: number | undefined;
    let contextSource: MetadataSource;
    if (m.context !== undefined) {
      context = m.context;
      contextSource = "explicit";
    } else if (mdContext !== undefined) {
      context = mdContext;
      contextSource = "modelsdev";
    } else if (hint !== undefined) {
      context = hint;
      contextSource = "discover";
    } else {
      context = undefined;
      contextSource = "none";
    }

    const model: GatewayModel = { ...m };
    if (context !== undefined) model.context = context;

    let maxOutput: number | undefined;
    let maxOutputSource: MetadataSource = "none";
    if (m.maxOutput !== undefined) {
      maxOutput = m.maxOutput;
      maxOutputSource = "explicit";
    } else if (entry.limit?.output !== undefined) {
      maxOutput = entry.limit.output;
      maxOutputSource = "modelsdev";
    }
    // A cap that cannot fit the window is meaningless: drop it.
    if (maxOutput !== undefined && context !== undefined && maxOutput > context) {
      maxOutput = undefined;
      maxOutputSource = "none";
    }

    return {
      upstream: u,
      model,
      contextSource,
      maxOutput,
      maxOutputSource,
      capabilities: contextCapabilities(m, entry),
      modelsDev: { provider: mm.provider, model: mm.model },
    };
  }

  return {
    resolve(u, m, hint) {
      const idx = getIndex();
      if (idx === null || disabled(u, m)) return base(u, m, hint);
      const mm = match(u, m, idx);
      return mm === null ? base(u, m, hint) : matched(u, m, hint, mm);
    },

    resolveDiscovered(u, id, hint) {
      const synthetic = { id } as GatewayModel;
      const idx = getIndex();
      const mm = idx === null || disabled(u, synthetic) ? null : match(u, synthetic, idx);
      if (mm === null) {
        return {
          context: hint ?? null,
          contextSource: hint !== undefined ? "discover" : "none",
          modelsDev: null,
        };
      }
      const resolved = matched(u, synthetic, hint, mm);
      return {
        context: resolved.model.context ?? null,
        contextSource: resolved.contextSource,
        modelsDev: resolved.modelsDev,
      };
    },

    candidates(u, m) {
      return candidateKeys(u, m);
    },
  };
}

/** Last-write-wins `tokenConfig` map: only models with a known context. */
export function tokenConfigOf(models: ResolvedModel[]): Record<string, { context: number }> {
  const out: Record<string, { context: number }> = {};
  for (const resolved of models) {
    const context = resolved.model.context;
    if (context !== undefined) out[resolved.model.id] = { context };
  }
  return out;
}
