import { z } from "zod";

// Provider subpaths published by @opencode/ai v2. Extend as adapters land.
// Deliberately excludes the legacy hyphen alias `openai-compatible-responses`,
// internal `openai-options`, and unverified google/azure/openrouter/xai —
// add them when an adapter actually uses them.
export const KNOWN_PROVIDER_PACKAGES = [
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses",
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/chat",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/anthropic",
  "@opencode/ai/providers/anthropic-compatible",
] as const;

export const ProviderPackageSchema = z.enum(KNOWN_PROVIDER_PACKAGES, {
  errorMap: () => ({
    message: `package must be a known @opencode/ai provider subpath (one of: ${KNOWN_PROVIDER_PACKAGES.join(", ")})`,
  }),
});

// F5: translation strategy for the chat path. `passthrough` (default) relays
// bytes; `opencode` translates through @opencode/ai, dispatching by
// `package`. `openai-compatible` is a deprecated alias for `opencode`.
export const AdapterKindSchema = z.enum(["passthrough", "opencode", "openai-compatible"], {
  errorMap: () => ({
    message: 'adapter must be "passthrough" or "opencode" ("openai-compatible" is a deprecated alias)',
  }),
});

// F6: models.dev resolution override. A ref pins the provider (and optionally
// the catalog model key); `false` disables models.dev metadata for the model or
// the whole upstream. Both are optional so existing configs parse unchanged.
export const ModelsDevRefSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export const ModelsDevOverrideSchema = z.union([ModelsDevRefSchema, z.literal(false)]);

export const ModelSchema = z
  .object({
    id: z.string(),
    // modelID sent upstream; defaults to `id` when omitted.
    upstream: z.string().optional(),
    // Context window in tokens. Optional: filled from the models.dev snapshot (F6) when absent.
    // Until F6, a model with no context is served with context_length: null and omitted from tokenConfig.
    context: z.number().int().positive().optional(),
    // Max output tokens the upstream accepts. Must be <= context when both are set.
    maxOutput: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum output tokens the upstream accepts; must be <= context when both are set."),
    // Declared capability override. When set, wins over models.dev metadata (F6). Not enforced today.
    supportsVision: z
      .boolean()
      .optional()
      .describe("Model accepts image input; overrides models.dev modalities when set."),
    // Declared capability override. When set, wins over models.dev metadata (F6). Not enforced today.
    supportsTools: z
      .boolean()
      .optional()
      .describe("Model supports tool/function calling; overrides models.dev metadata when set."),
    // Request-body parameter names stripped before forwarding upstream (e.g. stop, frequency_penalty). Enforced in F4.
    dropParams: z
      .array(z.string().min(1))
      .optional()
      .describe("Request-body parameter names removed before forwarding upstream (e.g. stop, user)."),
    // models.dev pin / opt-out for this model.
    modelsDev: ModelsDevOverrideSchema.optional(),
  })
  .superRefine((m, ctx) => {
    if (m.context !== undefined && m.maxOutput !== undefined && m.maxOutput > m.context) {
      ctx.addIssue({ code: "custom", message: "maxOutput must be <= context" });
    }
  });

export const UpstreamSchema = z.object({
  id: z.string(),
  package: ProviderPackageSchema,
  baseURL: z.string().url(),
  apiKey: z.string().optional(),
  // Env var holding the upstream key; explicit null means "no auth" (unset, not an error).
  apiKeyEnv: z.string().nullable().optional(),
  discover: z.boolean().optional(),
  // Translation strategy; defaults to `passthrough` when omitted. The `opencode`
  // adapter dispatches by `package`, so any known package is accepted.
  adapter: AdapterKindSchema.optional(),
  // models.dev pin / opt-out for every model on this upstream.
  modelsDev: ModelsDevOverrideSchema.optional(),
  models: z.array(ModelSchema).min(1),
});

// F6: options for the generated LibreChat fragment (GET /librechat.yaml.fragment).
export const LibreChatSchema = z.object({
  name: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const GatewayConfigSchema = z.object({
  upstreams: z.array(UpstreamSchema).min(1),
  librechat: LibreChatSchema.optional(),
});

export type GatewayModel = z.infer<typeof ModelSchema>;
export type GatewayUpstream = z.infer<typeof UpstreamSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type ModelsDevOverride = z.infer<typeof ModelsDevOverrideSchema>;
export type LibreChatConfig = z.infer<typeof LibreChatSchema>;
export type ConfigProvider = () => GatewayConfig;
/** Config-level adapter value; the runtime canonicalizes it to `adapter/types.ts`'s `AdapterKind`. */
export type AdapterKindConfig = z.infer<typeof AdapterKindSchema>;

export function resolveApiKey(u: GatewayUpstream): string | undefined {
  if (u.apiKey) return u.apiKey;
  if (u.apiKeyEnv) return process.env[u.apiKeyEnv];
  return undefined;
}
