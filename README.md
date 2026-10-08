# openproxy

OpenAI-compatible proxy that sits between **LibreChat** (client) and upstream LLM providers, reusing **OpenCode's provider packages** for protocol translation and **models.dev** for model metadata (context windows, capabilities, pricing).

LibreChat speaks one dialect — `POST /v1/chat/completions` (+ `GET /v1/models`) — regardless of whether the upstream wants OpenAI Responses, Anthropic Messages, or Chat Completions.

## Quick links

- `PLAN.md` — full design + milestones (start here)
- `examples/gateway.yaml` — model registry example
- `examples/librechat.yaml.fragment` — generated `tokenConfig` example

## Status

Scaffold + plan only. No gateway code yet (see PLAN.md milestones M0–M4).
