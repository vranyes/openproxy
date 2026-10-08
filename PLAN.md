# openproxy — Plan

## 0. Goal

Build a LiteLLM-like gateway **specifically for LibreChat**, backed by OpenCode's ecosystem:

- **Inbound (LibreChat → gateway):** single OpenAI Chat Completions API
  (`GET /v1/models`, `POST /v1/chat/completions` with SSE streaming).
- **Outbound (gateway → upstreams):** whatever each upstream needs
  (Responses / Messages / Chat Completions) via OpenCode provider packages.
- **No client auth** for now (gateway holds all upstream keys). Design room for auth later.
- **Context lengths:** gateway is source of truth; LibreChat is informed via generated `tokenConfig`.

## 1. Why this shape

| Decision | Rationale |
|---|---|
| Inbound = Chat Completions | LibreChat `custom` endpoint without `provider:` speaks this best (tools, vision, `titleConvo`, SSE). Avoids forking LibreChat. |
| Runtime = Bun/Node, not Go | Reusable translation layer (`@opencode-ai/ai` provider packages, AI SDK) is JS. Rewriting Responses↔Messages↔Chat mapping in Go duplicates OpenCode. |
| No hand-rolled translation | Delegate to provider packages: `model(modelID, settings)` where settings = `{ apiKey, baseURL, headers, body, limits }`. |
| Metadata = models.dev | OpenCode builds its catalog from `https://models.dev` (`GET /api.json`), then overlays `opencode.json`. Reuse `limit.context`, `limit.output`, `capabilities`, costs. Explicit per-model override wins. |
| Optional control plane = `@opencode-ai/sdk` | `createOpencodeClient({ baseUrl })` → `client.config.providers()` for introspection. Not on the completion hot path. |
| Ignore `internal/llm/provider` (Go) | Pre-v1, superseded by the TS packages above. Do not build on it. |

## 2. Reusable OpenCode sources (verified Oct 2026)

Data plane (translation — highest value):

- `@opencode-ai/ai/providers/openai-compatible`
- `@opencode-ai/ai/providers/openai/chat`, `.../openai/responses`
- `@opencode-ai/ai/providers/anthropic`, `.../anthropic-compatible`
- `@opencode-ai/ai/providers/google`, `.../azure/*`, `.../openrouter`, `.../xai`, `.../amazon-bedrock/*`
- AI SDK contract: `aisdk:@ai-sdk/openai-compatible` (requires `aisdk:` prefix)
- Local override: absolute `file://` URL package
- Pin versions: naming drifted between `@opencode/ai/...` (v1 docs) and `@opencode-ai/ai/...` (v2 docs).

> Docs: `https://opencode.ai/v2/docs/providers`, `https://v2.opencode.ai/providers`

Metadata plane (context/capabilities):

- Upstream: `https://models.dev` / `GET https://models.dev/api.json`
- OpenCode caching: `packages/core/src/models-dev.ts` (`ModelsDev.Service`, `refresh()`), snapshot at `~/.cache/opencode/models.json`
- Schema: `packages/opencode/src/provider/models.ts` (`ModelsDev.Provider`)
- Listing: `packages/opencode/src/cli/cmd/models.ts`, `ProviderV2.list()` in `packages/core/src/provider.ts`
- Env override: `OPENCODE_MODELS_URL`

Control plane (optional introspection):

- `npm i @opencode-ai/sdk` — `createOpencode()` (server+client) or `createOpencodeClient({ baseUrl })`; OpenAPI-generated types (`Session`, `Message`, `Part`).

## 3. Architecture

```text
LibreChat (custom endpoint, fetch:true, apiKey:dummy)
  │  GET /v1/models · POST /v1/chat/completions (SSE)
  ▼
openproxy (Bun/TS)
  ├─ facade/        Chat Completions request/response + SSE normalization
  ├─ registry/      gateway.yaml + models.dev snapshot merge
  ├─ adapters/      thin wrappers around provider packages (no raw HTTP per vendor)
  ├─ meta/          GET /librechat/tokenConfig + /librechat.yaml.fragment
  └─ ops/           /healthz, logging (model, upstream, latency, tokens, context_ratio)
        │
        ├─→ openai-responses upstream
        ├─→ anthropic-messages upstream
        └─→ openai-compatible upstream (Ollama/LM Studio/Mistral/…)
```

Internal IR: `ChatRequest { model, messages[], tools[], tool_choice, temperature, max_tokens, stream }`.
Response IR normalized back to Chat Completions shape (`choices[0].message`, `usage`).

Key mappings the packages already handle (do not reimplement):

- Responses: `messages[]` → `input[]`, `tools` → `type:function` tools, `output[]` → `choices[0].message`; `response.*` events → `chat.completion.chunk`
- Messages: system extraction, `tool_use`/`tool_result` blocks, `anthropic-version` header, `content_block_delta` → OpenAI chunks
- Compat: per-vendor `dropParams` (`stop`, `user`, `frequency_penalty`, `presence_penalty`) + `image_url` vision

Gateway still sanitizes params per model as defense-in-depth (LibreChat also has `dropParams`).

## 4. LibreChat context lengths — how it actually learns them

LibreChat does **not** infer context from `GET /v1/models` on `custom` endpoints. `fetch: true` only syncs IDs.

Effective window comes from (config `v1.3.13+`):

1. `endpoints.custom[].tokenConfig.<model>.context` — **authoritative**. Drives usage bar, cost, trim/summarize trigger. This is what we generate.
2. `modelSpecs[].parameters.maxContextTokens` — unreliable for generic custom endpoints (reports of fallback to ~32–37k + early summarization). Do not rely on it.

Therefore gateway exposes (generated from registry, single source of truth):

- `GET /v1/models` — standard OpenAI list (for `fetch: true`)
- `GET /librechat/tokenConfig` — JSON → YAML-ready `tokenConfig:` block
- `GET /librechat.yaml.fragment` — full custom-endpoint stanza (optional, M2)
- Server-side enforcement regardless: if `prompt_tokens + max_tokens > context`, return `400 context_length_exceeded` with `max_context` + `used` (LibreChat surfaces instead of silent truncation).

Upstream `/v1/models` metadata (`meta.llamaswap.context_length`, OpenRouter `context_length`, etc.) is hints only — formats differ. Priority: explicit `context:` override > models.dev snapshot > upstream hint.

## 5. Config (proposed `gateway.yaml`)

```yaml
upstreams:
  - id: openai
    package: "@opencode-ai/ai/providers/openai/responses"
    baseURL: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
    models:
      - id: gpt-5-mini            # name LibreChat sees
        upstream: gpt-5-mini      # modelID sent upstream
        context: 128000           # override; else models.dev
        maxOutput: 16384
        supportsVision: true
        supportsTools: true
        dropParams: [stop]

  - id: anthropic
    package: "@opencode-ai/ai/providers/anthropic"
    baseURL: https://api.anthropic.com
    apiKeyEnv: ANTHROPIC_API_KEY
    models:
      - id: claude-sonnet-4-5
        context: 200000

  - id: local
    package: "@opencode-ai/ai/providers/openai-compatible"
    baseURL: http://ollama:11434/v1
    apiKeyEnv: null               # omit env for no-auth endpoints
    models:
      - id: qwen3-coder-30b
        upstream: qwen3-coder:30b
        context: 131072
```

Notes:

- Reuse `opencode.json` `providers{}` shape where possible (keyed by provider ID, `env`, `package`, `settings`, `headers`, `body`, per-model `models{}` + `limit.context`).
- `settings` is package-specific; OpenCode does not validate package keys — pass through.
- Hot-reload config; nightly models.dev refresh (`OPENCODE_MODELS_URL` overridable).

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | liveness |
| `GET` | `/v1/models` | OpenAI list for LibreChat `fetch: true` |
| `POST` | `/v1/chat/completions` | non-stream + SSE (`stream: true`) |
| `GET` | `/librechat/tokenConfig` | generated context map (JSON) |
| `GET` | `/librechat.yaml.fragment` | paste-ready LibreChat stanza (M2+) |
| `POST` | `/v1/responses` | optional Responses in/out (M3, for OpenCode compat) |

Future auth (no-op now): accept `Authorization: Bearer …` if configured, else allow `dummy`/empty; log a warning when unauthenticated mode is on.

## 7. Milestones

- **M0 scaffold:** repo, `gateway.yaml` schema (zod), config loader + hot-reload, `/healthz`, logging skeleton, CI (typecheck/lint/test), Dockerfile.
- **M1 facade + 1 upstream:** `GET /v1/models`, `POST /v1/chat/completions` (non-stream + SSE) via `openai-compatible` package against Ollama/LM Studio; `GET /librechat/tokenConfig`; context enforcement (`400 context_length_exceeded`); e2e vs LibreChat `fetch: true`.
- **M2 adapters:** `anthropic` + `openai/responses` packages; vision + tool-call e2e (LibreChat agents); per-model `dropParams`; `/librechat.yaml.fragment`; metrics (latency/tokens/context_ratio).
- **M3 optional:** `POST /v1/responses` in/out (Open Responses spec compat); gitops deploy (`gitops/apps/openproxy` + ingress); load/refresh `models.dev` snapshot nightly.
- **M4 hardening:** auth hook (plug-in point), rate limits, per-model cost accounting from models.dev pricing, docs + examples.

## 8. Test plan (per milestone)

- Contract: Chat Completions request/response JSON-schema validation; SSE event sequence (`role` → `delta*` → `finish_reason:stop` → `[DONE]`).
- Parity: same prompt via gateway vs direct upstream → same text/tool calls (modulo IDs/timestamps).
- Streaming: LibreChat renders partial deltas; no hung connections (timeout + abort).
- Context: over-limit request → `400` with `max_context`/`used`; LibreChat `tokenConfig` fragment matches registry.
- Tools: LibreChat agent round-trip (`tool_calls` → `tool` role → final answer) on each adapter.
- Upstreams to prove first: Ollama (compat) → Anthropic (messages) → OpenAI (responses).

## 9. Open questions

1. Which 2–3 upstreams to prove first (suggest: Ollama, Anthropic, OpenAI)?
2. Reuse `opencode.json` provider schema verbatim as `gateway.yaml`, or gateway-specific schema?
3. Chat-only inbound for v0, or Chat + Responses from day one?
4. Public vs private image + which cluster/namespace for gitops deploy?
