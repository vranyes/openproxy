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

// F7b: models.dev-convention cost accounting, USD per 1,000,000 tokens. Purely
// optional; when set it overrides models.dev pricing for the model (mirrors the
// context/maxOutput precedence).
export const ModelCostSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
}); // USD per 1,000,000 tokens (models.dev convention)
export type ModelCostConfig = z.infer<typeof ModelCostSchema>;

export const ModelSchema = z
  .object({
    id: z.string(),
    // modelID sent upstream; defaults to `id` when omitted.
    upstream: z.string().optional(),
    // Context window in tokens. Optional: filled from the models.dev snapshot (F6) when absent.
    // A model with no resolvable context is omitted from `GET /v1/models` and from tokenConfig.
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
    // F7b: explicit pricing override. When set, wins over models.dev pricing.
    cost: ModelCostSchema.optional(),
  })
  .superRefine((m, ctx) => {
    if (m.context !== undefined && m.maxOutput !== undefined && m.maxOutput > m.context) {
      ctx.addIssue({ code: "custom", message: "maxOutput must be <= context" });
    }
  });

// F7c: optional token-bucket rate limiting, global and/or per-upstream. `rpm`
// is the sustained refill rate; `burst` (default = rpm) is the bucket capacity.
// Both are positive integers. Off unless configured.
export const RateLimitSchema = z.object({
  rpm: z.number().int().positive(),
  burst: z.number().int().positive().optional(), // default = rpm
});
export type RateLimitConfig = z.infer<typeof RateLimitSchema>;

// F8: RFC 7230 header token (name) and a value charset of visible ASCII +
// obs-text only — CR/LF/NUL and other controls are rejected, so a configured
// header can never inject into the request line.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_RE = /^[\x20-\x7e\x80-\xff]*$/;
// F8: a session id is an opaque correlation token, never a credential; these
// names are refused so `sessionHeader` cannot be pointed at auth material.
const FORBIDDEN_SESSION_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key"]);

export const HeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) ctx.addIssue({ code: "custom", message: `invalid HTTP header name: ${name}` });
    if (!HEADER_VALUE_RE.test(value)) ctx.addIssue({ code: "custom", message: `invalid HTTP header value for ${name}` });
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
  // Full URL to fetch the model list from; defaults to `<baseURL>/models`.
  discoverUrl: z.string().url().optional(),
  // Translation strategy; defaults to `passthrough` when omitted. The `opencode`
  // adapter dispatches by `package`, so any known package is accepted.
  adapter: AdapterKindSchema.optional(),
  // models.dev pin / opt-out for every model on this upstream.
  modelsDev: ModelsDevOverrideSchema.optional(),
  // F7c: per-upstream token bucket. Off when omitted.
  rateLimit: RateLimitSchema.optional(),
  // F8: static headers sent on every upstream request (validated name/value).
  headers: HeadersSchema.optional(),
  // F8: header carrying an opaque per-conversation id; forwarded when inbound,
  // else generated (memoized per upstream) or left to a static `headers` value.
  sessionHeader: z
    .string()
    .regex(HEADER_NAME_RE, "sessionHeader must be a valid HTTP header name")
    .refine((n) => !FORBIDDEN_SESSION_HEADERS.has(n.toLowerCase()), "sessionHeader must not be a credential header")
    .optional(),
  models: z.array(ModelSchema).min(1),
});

// F6: options for the generated LibreChat fragment (GET /librechat.yaml.fragment).
export const LibreChatSchema = z.object({
  name: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
});

// F7a: config-driven client auth for the data routes. Open by default; a token
// or tokenEnv enables enforcement on every route except GET /healthz.
export const AuthSchema = z
  .object({
    token: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
    header: z.string().min(1).optional(), // default "authorization"
    scheme: z.enum(["bearer", "raw"]).optional(), // default "bearer"
  })
  .refine((a) => a.token !== undefined || a.tokenEnv !== undefined, {
    message: "auth requires either token or tokenEnv",
  });

export const GatewayConfigSchema = z.object({
  upstreams: z.array(UpstreamSchema).min(1),
  librechat: LibreChatSchema.optional(),
  auth: AuthSchema.optional(),
  // F7c: global token bucket applied to every request, in addition to any
  // per-upstream bucket. Off when omitted.
  rateLimit: RateLimitSchema.optional(),
});

export type GatewayModel = z.infer<typeof ModelSchema>;
export type GatewayUpstream = z.infer<typeof UpstreamSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type ModelsDevOverride = z.infer<typeof ModelsDevOverrideSchema>;
export type LibreChatConfig = z.infer<typeof LibreChatSchema>;
export type GatewayAuthConfig = z.infer<typeof AuthSchema>;
export type ConfigProvider = () => GatewayConfig;
/** Config-level adapter value; the runtime canonicalizes it to `adapter/types.ts`'s `AdapterKind`. */
export type AdapterKindConfig = z.infer<typeof AdapterKindSchema>;

export function resolveApiKey(u: GatewayUpstream): string | undefined {
  if (u.apiKey) return u.apiKey;
  if (u.apiKeyEnv) return process.env[u.apiKeyEnv];
  return undefined;
}
