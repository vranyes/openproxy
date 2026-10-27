# openproxy

OpenAI-compatible proxy that sits between **LibreChat** (client) and upstream LLM providers, reusing **OpenCode's provider packages** for protocol translation and **models.dev** for model metadata (context windows, capabilities, pricing).

LibreChat speaks one dialect — `POST /v1/chat/completions` (+ `GET /v1/models`) — regardless of whether the upstream wants OpenAI Responses, Anthropic Messages, or Chat Completions.

## Run

```sh
bun install
export ZEN_API_KEY=...              # key for https://opencode.ai/inference/go/v1
SSL_CERT_FILE=/opt/homebrew/etc/openssl@3/cert.pem \  # only if Bun reports TLS issuer errors on macOS
  bun src/index.ts examples/zen.yaml
```

On startup the gateway loads a models.dev snapshot from disk synchronously
(fail-open) and refreshes the catalog in the background. `GET /librechat.yaml.fragment`
always reflects the resolved metadata.

## Resolving context & capabilities

Model context windows, max output, and capabilities (`vision`/`tools`) come from
three sources, in strict precedence:

1. **explicit** — `context` / `maxOutput` / `supportsVision` / `supportsTools` in `gateway.yaml`.
2. **models.dev** — the cached snapshot (see env vars below). A model is matched to
   a provider deterministically; an ambiguous match stays unresolved rather than
   picking arbitrarily.
3. **discovery hint** — a positive-integer `context_length` in the upstream's
   `/v1/models` response, used only when the id resolves to no models.dev provider.

Live discovery (`discover: true`) fetches `<baseURL>/models` by default; set
`discoverUrl` when the model list lives elsewhere (e.g. OpenCode Go publishes it
at `https://opencode.ai/inference/go/v1/models` while its chat baseURLs are
`.../openai/v1` and `.../anthropic/v1`). A discovered model is only advertised
once it has a resolvable context.

Pin or disable models.dev per model or per upstream with `modelsDev:` — either a
`{ provider, model }` reference (authoritative: a miss does not fall back) or
`false`:

```yaml
upstreams:
  - id: zai
    modelsDev: { provider: zai }   # pin the whole upstream
    models:
      - id: glm-5.2
      - id: local-only
        modelsDev: false           # never consult models.dev for this model
```

When a model resolves from models.dev, the resolved **context** feeds
`GET /v1/models`, `GET /librechat/tokenConfig`, and context-overflow responses
(`max_context`). `maxOutput` is resolved from `limit.output` (dropped when it
exceeds the context) but has no runtime effect yet. The gateway never mutates the
parsed config.

## Deriving the dialect & base URL

An upstream may omit `package` and `baseURL`. The gateway then derives them **per
model** from models.dev — the dialect from the catalog's provider `npm`, the base
URL from its `api` — so a dialect-split provider collapses to a model-id list:

```yaml
upstreams:
  - id: opencode-go
    apiKeyEnv: ZEN_API_KEY
    adapter: opencode
    trustedHosts: [opencode.ai]        # required when baseURL is omitted
    modelsDev: { provider: opencode-go }
    models:
      - id: muse-spark-1.3-contributor # npm @ai-sdk/openai -> Responses
      - id: glm-5.3-flash              # npm @ai-sdk/openai-compatible -> chat
      - id: qwen3.8-max                # npm @ai-sdk/anthropic -> Messages
```

`npm` maps to a gateway package: `@ai-sdk/openai-compatible` →
`openai-compatible`, `@ai-sdk/openai` → `openai-compatible/responses`,
`@ai-sdk/anthropic` → `anthropic-compatible`. Any other npm (e.g.
`@ai-sdk/google`) has no package yet, so that model stays unresolved.

Precedence is explicit config first: a set `package`/`baseURL` is never
overridden. Both may also be set on a single model — the escape hatch for a model
the catalog does not know — and that model-level value wins over the upstream's
and over derivation. A **derived** base URL is a trust decision — it is accepted
only when its host is in `trustedHosts` (exact, case-insensitive), otherwise the
model is left unroutable and a warning is logged. This is why `trustedHosts` is
required whenever `baseURL` is omitted (and at least one model would derive it):
without it a compromised catalog could point this upstream's key at another host.
A model with no resolvable dialect or base URL is neither routable (`404`) nor
advertised in `GET /v1/models`.

Derivation needs `adapter: opencode` (the translating adapter): a `passthrough`
upstream relays Chat Completions regardless of dialect.

## Upstream headers & sessions

Every upstream request carries a distinct `user-agent: openproxy/<version>` (not
whatever the client sent), which can be overridden per upstream:

```yaml
upstreams:
  - id: zai
    headers:
      x-tenant: acme            # static headers on every request to this upstream
      User-Agent: my-client/1   # replaces the openproxy default
    sessionHeader: x-opencode-session   # opaque per-conversation id
```

`headers` names must be valid HTTP tokens and values printable ASCII (no CR/LF),
or the config is rejected. `sessionHeader` names a header the gateway populates
with an opaque conversation id: an inbound value is forwarded when it is a safe
non-empty string, otherwise the gateway generates one (stable per upstream for
the process lifetime). The name may not be a credential header —
`authorization`, `proxy-authorization`, `cookie`, or `x-api-key` are refused, so
a client's auth is never turned into a session id and never leaks upstream.

Authentication precedence: when the upstream has an `apiKey` (or `apiKeyEnv`),
that key's auth header always wins over any static `headers` value. A keyless
upstream (`apiKeyEnv: null`) instead forwards static auth headers verbatim.

## Wire up LibreChat

Generate a paste-ready stanza from the registry:

```sh
curl http://openproxy:8080/librechat.yaml.fragment
```

```yaml
# Generated by openproxy — paste under `endpoints:` in librechat.yaml.
endpoints:
  custom:
    - name: openproxy
      apiKey: dummy                 # gateway holds the real upstream keys
      baseURL: http://openproxy:8080/v1
      models:
        default: [glm-5.2, deepseek-v4-pro]
        fetch: true                 # pulls IDs from GET /v1/models (registry + live discovery)
      titleConvo: true
      titleModel: current_model
      modelDisplayLabel: openproxy
      tokenConfig:
        glm-5.2: { context: 1000000 }
```

Set `librechat.name`, `librechat.baseURL`, and `librechat.apiKey` in
`gateway.yaml` to override the defaults (`openproxy`,
`<request-origin>/v1`, `dummy`).

`GET /v1/models` returns the OpenAI list shape augmented with the resolved
`context_length` and per-token `pricing` that LibreChat's model fetch parses, so
LibreChat learns the correct context window when it pulls the model list:

```json
{
  "object": "list",
  "data": [
    {
      "id": "glm-5.2",
      "object": "model",
      "owned_by": "opencode-go",
      "context_length": 1000000,
      "pricing": { "prompt": "0", "completion": "0" }
    }
  ]
}
```

`pricing.prompt` / `pricing.completion` are USD **per token**, as strings
(models.dev cost, USD per 1e6 tokens, divided by 1e6 — e.g. `"2.5e-7"`); a model
with no known cost reports `"0"`. A model whose context cannot be resolved is
**omitted** from `data`: LibreChat's schema requires a numeric `context_length`,
and one bad row fails the whole list. The gateway still generates `tokenConfig`
from its registry (and models.dev) for clients that read it:

```sh
curl http://openproxy:8080/librechat/tokenConfig
# {"glm-5.2":{"context":1000000}, ...}
```

## Environment

| Variable | Default | Effect |
|---|---|---|
| `OPENPROXY_MODELS_URL` | `https://models.dev/api.json` | Catalog source (full URL) fetched on refresh. |
| `OPENPROXY_MODELS_PATH` | `$XDG_CACHE_HOME/openproxy/models.json` or `~/.cache/openproxy/models.json` | On-disk snapshot path (read at startup, written on update). |
| `OPENPROXY_MODELS_REFRESH_MS` | `86400000` (24h) | Background refresh interval; `0` disables the timer. |
| `OPENPROXY_DISABLE_MODELS_FETCH` | unset | `1` makes `refresh()` a no-op (snapshot only; no network). |

## Test

```sh
bun test                                    # unit + fake-upstream tests
OPENPROXY_LIVE_TEST=1 bun test              # plus a live check vs opencode.ai/inference/go
```

## Status

Working: `GET /healthz`, `GET /v1/models` (registry + opt-in `discover: true`
live merge with fail-open fallback, models.dev/discovery `context_length`
enrichment), `POST /v1/chat/completions` (non-stream + SSE), `POST /v1/responses`
(non-stream + SSE), `POST /v1/systemone` (Jev relay, see below), `GET /librechat/tokenConfig`,
`GET /librechat.yaml.fragment`. An upstream may omit `package`/`baseURL` and have
them derived per model from models.dev, host-pinned by `trustedHosts` (F11).

Adapters: `passthrough` (default), `opencode`, which translates Chat Completions
through `@opencode/ai` for `anthropic`, `anthropic-compatible`, `openai`,
`openai/chat`, `openai/responses`, `openai-compatible`, and
`openai-compatible/responses` (tools, vision, streaming), and `systemone`,
which relays Jev decision requests (`POST /v1/systemone` with
`{ model, state, questions }`) verbatim to `<baseURL>/systemone`
(e.g. `https://opencode.ai/inference/systemone/v1`, see
`examples/systemone.yaml`). No `package` (no provider speaks it), explicit
`baseURL` required; Jev ids are isolated from chat/responses routes and omitted
from `/v1/models`/`tokenConfig`. Upstream `usage` (`input_tokens`/`output_tokens`)
feeds the `generation` log and cost accounting (set `cost: { input: 0.042, output: 0 }`
for `jev-1.13`). Reactive context-overflow
handling returns `400 context_length_exceeded` with `max_context`. models.dev
snapshot sync (fetch + cache + refresh, fail-open) feeds context metadata.

Observability: `GET /metrics` serves Prometheus exposition (no auth, same port
as `/healthz`): request counts/latency, generations by `outcome`/`finish_reason`,
`midstream_errors_total` (stream failed after headers) and
`empty_generations_total` (stream closed ok with null usage — silent
truncation), plus `upstream_retries_total` (pre-headers retries by error tag),
`session_source_total` (forwarded/generated/pinned per upstream) and
`discovery_errors_total`. The `generation` log carries `outcome`, `error_tag`,
`error`, `retries` and `session_source` (mid-stream failures log at `error`
level with `finish_reason: "error"`; client aborts log `outcome:
"client_aborted"`).

Reliability knobs (per model, falling back to upstream): `http:
{ timeout, headerTimeout, chunkTimeout }` in ms or `false` (SDK defaults:
header 5min, chunk 15min, no whole-request timeout), and `retry:
{ maxAttempts: 1-5, backoffMs }` for bounded pre-headers retries on
Timeout/Transport/5xx only (never 4xx). `sessionFromHeaders: [...]` lists
inbound headers to try as the session value, sent under `sessionHeader`.
Oversize bodies (>10 MiB) are rejected with `413 body_too_large`.

Next: client auth, inbound `POST /v1/responses`, cost accounting.
