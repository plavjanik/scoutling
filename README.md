# 🐦 scoutling

> **Your little birds for the codebase.**

A read-only, bounded investigator that any coding agent can send ahead, on any local model.

Claude Code, Codex CLI, OpenCode or Cursor shells out to `scoutling "how does X work?"`; a cheap
local model (LM Studio, Ollama, vLLM — any OpenAI-compatible endpoint) reads, lists and greps the
repo within a hard step and byte budget and reports back with `path:line` citations. It cannot write.
The expensive model only ever reads the conclusion.

**Status: working, not yet published.** Phases 1-6 of the roadmap are done — the tools, the
budget, the cited-answer contract, the full CLI, the eval harness and a graded reference run across
three local models. What is left before `0.1.0` is the integration docs and the publish itself. Read
[DESIGN.md](./DESIGN.md) for the full design, [docs/eval.md](./docs/eval.md) for the numbers, and
[docs/subagent-census.md](./docs/subagent-census.md) for what real investigation briefs look like.

```sh
# after 0.1.0 is published
npx scoutling "Where is the retry logic for image generation, and what does it back off on?" \
  --model qwen/qwen3.6-35b-a3b --path .

# what this actually returns
scoutling "Where is the scope-root containment check?" --model qwen/qwen3-coder-next --format json
```

## Which model

There is no default model (ADR 0003): pass `--model`, and `scoutling models` lists what your
endpoint serves. Measured on one GPU against the `local-ai` repository, nine questions, two runs
each, every survey answer checked claim by claim ([docs/eval.md](./docs/eval.md)):

| model | audits auto-passed | surveys solid | citations verified | budget exhausted |
|---|---|---|---|---|
| `qwen/qwen3.6-35b-a3b` | 6 of 8 | **7 of 10** | **364** | **0** |
| `qwen/qwen3-coder-next` | 6 of 8 | 5 of 10 | 253 | 1 |
| `qwen/qwen3-next-80b` | 3 of 8 | 2 of 10 | 167 | 2 |

**Start with `qwen/qwen3.6-35b-a3b`.** `qwen/qwen3-coder-next` is the cheaper choice for a narrow,
single-file question. The two fail differently, and that matters more than the scores: `35b-a3b`
invents list items at the edge of a long enumeration (a file or line that does not exist, which
`sources[].verified` catches), while `coder-next` states a wrong relationship between real
symbols, compactly and confidently, which only opening the cited line catches. Give the model a
context of at least 32 k tokens, 64 k for `--budget deep`.

## Briefs

A real investigation brief is rarely one question. Give scoutling a numbered list and it answers
each item under its own heading; `--format json` returns a `sections` array with each item's own
verified `sources`. Pair three or more items with `--budget deep`.

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
