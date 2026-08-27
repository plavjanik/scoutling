# 🐦 scoutling

> **Your little birds for the codebase.**

A read-only, bounded investigator that any coding agent can send ahead, on any local model.

Claude Code, Codex CLI, OpenCode or Cursor shells out to `scoutling "how does X work?"`; a cheap
local model (LM Studio, Ollama, vLLM — any OpenAI-compatible endpoint) reads, lists and greps the
repo within a hard step and byte budget and reports back with `path:line` citations. It cannot write.
The expensive model only ever reads the conclusion.

**Status: design complete, implementation in progress.** This npm name is reserved; the first
usable release will be `0.1.0`. Read [DESIGN.md](./DESIGN.md) for the full design, competitive
landscape and roadmap.

```sh
# soon
npx scoutling "Where is the retry logic for image generation, and what does it back off on?" \
  --model qwen/qwen3-next-80b --path .
```

## Why

- **Read-only by construction** — no write/edit/shell tool exists in the process; proven by tests.
- **Bounded** — `--budget quick|normal|deep` caps steps, tool-output bytes, output tokens and
  wall time in one dial.
- **Cited** — every claim carries `path:line`; citations are verified to exist and returned as
  structured `sources[]` so the parent agent knows what to read next.
- **Provider-agnostic** — plain OpenAI-compatible HTTP against any base URL. No gateway, no
  vendor SDK.
- **Token-frugal** — tabular tool results are encoded as [TOON](https://github.com/toon-format/toon).

## License

MIT © Petr Plavjanik
