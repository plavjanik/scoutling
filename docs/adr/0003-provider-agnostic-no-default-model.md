---
status: accepted
---

# Provider-agnostic: plain OpenAI-compatible HTTP, no gateway coupling, no default model

Scoutling speaks only the OpenAI-compatible chat API against a configurable base URL. It knows
nothing about LiteLLM aliases, LM Studio's API beyond `/v1`, Ollama's native API, or any vendor
SDK. It also ships **no default model** — `--model` (or a config layer) is required — because
which models exist is a property of the machine, not the tool, and a baked-in default would be a
portability leak dressed as convenience. The first draft of the design hardwired a private
gateway's aliases (`chat-agent`, `chat-strict`) into the tool and into a second-pass output
format; that made the tool unusable anywhere else and was reversed before any code was written.

## Consequences

- Recommended models live in READMEs and config files, chosen by the eval harness, never in code.
- A missing model is a `BAD_ARGS` error that lists what the endpoint actually serves.
- Anything provider-specific (structured output quirks, context-length probing in `doctor`) must
  degrade gracefully when the endpoint does not support it.
