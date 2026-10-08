# openproxy

OpenAI-compatible proxy that sits between **LibreChat** (client) and upstream LLM providers, reusing **OpenCode's provider packages** for protocol translation and **models.dev** for model metadata (context windows, capabilities, pricing).

LibreChat speaks one dialect — `POST /v1/chat/completions` (+ `GET /v1/models`) — regardless of whether the upstream wants OpenAI Responses, Anthropic Messages, or Chat Completions.

## Run

```sh
bun install
export ZEN_API_KEY=...              # key for https://opencode.ai/zen/go/v1
SSL_CERT_FILE=/opt/homebrew/etc/openssl@3/cert.pem \  # only if Bun reports TLS issuer errors on macOS
  bun src/index.ts examples/zen.yaml
```

## Wire up LibreChat

```yaml
endpoints:
  custom:
    - name: openproxy-zen
      apiKey: dummy                 # gateway holds the real upstream keys
      baseURL: http://openproxy:8080/v1
      models:
        default: [glm-5.2]
        fetch: true                 # pulls IDs from GET /v1/models (registry + live discovery)
      titleConvo: true
      titleModel: current_model
```

`fetch: true` only syncs model IDs — LibreChat learns context windows from
`tokenConfig`, which the gateway generates from its registry:

```sh
curl http://openproxy:8080/librechat/tokenConfig
# {"glm-5.2":{"context":1000000}, ...}
```

Copy that into `tokenConfig:` under your custom endpoint (see
`examples/zen.librechat.yaml.fragment`). Models discovered live from the
upstream but missing from the registry are served with `context_length: null`
and left out of `tokenConfig` until you add their context to `gateway.yaml`.

## Test

```sh
bun test                                    # unit + fake-upstream tests
OPENPROXY_LIVE_TEST=1 bun test              # plus live check vs opencode.ai/zen
```

## Status

M1 working: `GET /healthz`, `GET /v1/models` (registry + opt-in `discover: true`
live merge with fail-open fallback, `context_length` enrichment),
`POST /v1/chat/completions` (non-stream + SSE passthrough),
`GET /librechat/tokenConfig`. Next: context-limit `400` enforcement,
models.dev snapshot sync, provider-package adapters.
