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

export type ProviderPackage = (typeof KNOWN_PROVIDER_PACKAGES)[number];

export const ProviderPackageSchema = z.enum(KNOWN_PROVIDER_PACKAGES, {
  errorMap: () => ({
    message: `package must be a known @opencode/ai provider subpath (one of: ${KNOWN_PROVIDER_PACKAGES.join(", ")})`,
  }),
});

// F5: translation strategy for the chat path. `passthrough` (default) relays
// bytes; `opencode` translates through @opencode/ai, dispatching by
// `package`. `openai-compatible` is a deprecated alias for `opencode`.
// `systemone` relays Jev decision requests (`POST /v1/systemone`) to the
// SystemOne endpoint; it needs an explicit `baseURL` and no `package`
// (no @opencode/ai provider speaks that dialect).
export const AdapterKindSchema = z.enum(["passthrough", "opencode", "openai-compatible", "systemone"], {
  errorMap: () => ({
    message: 'adapter must be "passthrough", "opencode" or "systemone" ("openai-compatible" is a deprecated alias)',
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

// Optional per-request HTTP bounds, mirroring @opencode/ai HttpOptions
// (all defaults live in the SDK: header 5min, chunk 15min, no whole-request
// timeout). Each field is milliseconds or `false` to disable; model wins over
// upstream and both flow into the provider `configure()` settings.
const HttpTimeoutSchema = z.union([z.number().int().positive(), z.literal(false)]);
export const HttpSettingsSchema = z.object({
  timeout: HttpTimeoutSchema.optional(),
  headerTimeout: HttpTimeoutSchema.optional(),
  chunkTimeout: HttpTimeoutSchema.optional(),
});
export type HttpSettings = z.infer<typeof HttpSettingsSchema>;

// Bounded pre-headers retry (never after SSE headers are committed). Retries
// only Timeout/Transport/5xx (never 4xx); model wins over upstream.
export const RetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).optional(),
  backoffMs: z.number().int().min(0).max(30000).optional(),
});
export type RetryConfig = z.infer<typeof RetrySchema>;

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
    // Per-model dialect / base URL override (F11). Wins over the upstream's own
    // `package`/`baseURL` and over any models.dev-derived value — the escape
    // hatch for a model the catalog does not know. An explicit base URL here is
    // trusted as-is (no `trustedHosts` check, since it is operator-supplied).
    package: ProviderPackageSchema.optional(),
    baseURL: z.string().url().optional(),
    // F7b: explicit pricing override. When set, wins over models.dev pricing.
    cost: ModelCostSchema.optional(),
    // Optional HTTP bounds + pre-headers retry. Model wins over upstream.
    http: HttpSettingsSchema.optional(),
    retry: RetrySchema.optional(),
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

// A trusted-host entry: an exact DNS hostname (case-insensitive). Kept strict so
// a `.`, `*`, or scheme can never sneak into the allowlist and widen it.
const TRUSTED_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

export const UpstreamSchema = z
  .object({
    id: z.string(),
    // Dialect + base URL. Both may be omitted: when a model's upstream leaves
    // them unset the gateway derives them per model from models.dev (F11) — the
    // dialect from the catalog's provider `npm`, the base URL from its `api`.
    // `trustedHosts` is then the anchor that keeps a catalog-supplied host from
    // receiving this upstream's key. Explicit values always win.
    package: ProviderPackageSchema.optional(),
    baseURL: z.string().url().optional(),
    // Hosts a models.dev-derived baseURL may use. Required when `baseURL` is
    // omitted so a compromised catalog cannot redirect the key.
    trustedHosts: z
      .array(z.string().regex(TRUSTED_HOST_RE, "trustedHosts entries must be bare hostnames"))
      .min(1)
      .optional(),
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
    // Optional HTTP bounds + pre-headers retry (a per-model value wins).
    http: HttpSettingsSchema.optional(),
    retry: RetrySchema.optional(),
    // F8: static headers sent on every upstream request (validated name/value).
    headers: HeadersSchema.optional(),
    // F8: header carrying an opaque per-conversation id; forwarded when inbound,
    // else generated (memoized per upstream) or left to a static `headers` value.
    sessionHeader: z
      .string()
      .regex(HEADER_NAME_RE, "sessionHeader must be a valid HTTP header name")
      .refine((n) => !FORBIDDEN_SESSION_HEADERS.has(n.toLowerCase()), "sessionHeader must not be a credential header")
      .optional(),
    // Ordered inbound header names to try as the session value (first safe
    // non-empty wins, sent under `sessionHeader`). Defaults to `[sessionHeader]`.
    // Lets the operator pick up a client conversation id when one is known.
    sessionFromHeaders: z
      .array(z.string().regex(HEADER_NAME_RE, "sessionFromHeaders entries must be valid HTTP header names"))
      .min(1)
      .optional(),
    models: z.array(ModelSchema).min(1),
  })
  .superRefine((u, ctx) => {
    // A `systemone` upstream relays Jev decision requests: it speaks no
    // @opencode/ai dialect, so `package` must stay unset and the endpoint
    // prefix must be explicit (there is nothing models.dev could derive).
    if (u.adapter === "systemone") {
      if (u.baseURL === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["baseURL"],
          message: 'baseURL is required when adapter is "systemone"',
        });
      }
      if (u.package !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["package"],
          message: 'package must be omitted when adapter is "systemone"',
        });
      }
      for (let i = 0; i < u.models.length; i += 1) {
        const m = u.models[i]!;
        if (m.package !== undefined || m.baseURL !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["models", i],
            message: 'per-model package/baseURL are ignored when adapter is "systemone"',
          });
        }
      }
    }
    // A derived baseURL is a trust decision: without an allowlist the gateway
    // would send this upstream's apiKey to whatever host models.dev names. Only
    // models that actually fall through to a derived base URL need the anchor.
    const needsDerivedBase = u.baseURL === undefined && u.models.some((m) => m.baseURL === undefined);
    if (needsDerivedBase && (u.trustedHosts === undefined || u.trustedHosts.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["trustedHosts"],
        message: "trustedHosts is required when baseURL is omitted (it pins the host models.dev may supply)",
      });
    }
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
