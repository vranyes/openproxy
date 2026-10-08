import { z } from "zod";

export const ModelSchema = z.object({
  id: z.string(),
  upstream: z.string().optional(),
  context: z.number().int().positive(),
  maxOutput: z.number().int().positive().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  dropParams: z.array(z.string()).optional(),
});

export const UpstreamSchema = z.object({
  id: z.string(),
  package: z.string(),
  baseURL: z.string().url(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  models: z.array(ModelSchema).min(1),
});

export const GatewayConfigSchema = z.object({
  upstreams: z.array(UpstreamSchema).min(1),
});

export type GatewayModel = z.infer<typeof ModelSchema>;
export type GatewayUpstream = z.infer<typeof UpstreamSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function resolveApiKey(u: GatewayUpstream): string | undefined {
  if (u.apiKey) return u.apiKey;
  if (u.apiKeyEnv) return process.env[u.apiKeyEnv];
  return undefined;
}
