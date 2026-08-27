# 🐦 scoutling — instructions for agents working on this repo

Read, in this order, before changing anything:

1. `DESIGN.md` — the full design: architecture, config layers, tools, budget, citation contract,
   CLI contract, eval, phasing (§13 is the work plan), future ideas, decisions log.
2. `CONTEXT.md` — the glossary. Use its terms exactly (Step not turn, Scope not workspace,
   Source vs Citation, Provider not backend). When you need a new term, add it there via the
   `domain-modeling` skill.
3. `docs/adr/*.md` — four decisions that must not be "fixed": CLI not MCP; read-only by
   absence of capability (never add a write tool or `--allow-edit`); provider-agnostic with no
   default model; `@vscode/ripgrep`, never system `rg`.

## Status — read this first

**Phases 1 and 2 of DESIGN.md §13 are done, green and pushed. Phase 3 is next.**

Shipping today: `config.ts` (six layers + provenance), `provider.ts` (+ `listModels`),
`guardrails.ts`, `tools/read-file.ts`, `prompt.ts`, `loop.ts` (`runScoutling`), `cli.ts`
(`runCli`, injectable I/O), `script/smoke.ts`. **85 hermetic tests, 8 files.** CI is green on
ubuntu/macos/windows × node 22/24.

**Phase 3 adds** `list_dir`, `grep` (via `@vscode/ripgrep`, `execFile(rg, ["-e", pattern, "--",
…])`), gitignore handling, the grep-injection test, and raises the step cap. Until `grep` and
`list_dir` exist there is **no discovery tool**, so a question like "where is X?" is
unanswerable by construction — a question must name its file. This is the single biggest
limitation right now and the reason dogfooding starts at Phase 3, not before.

## Rules

- **Tests first.** New behaviour → failing test → implementation → green. Bug → regression test
  that fails on the bug. All tests are hermetic: mock the model via `ai/test`; never require a
  live provider in `pnpm test`. Live checks are a separate `pnpm smoke` script.
- **Read-only is structural.** No file in `src/` imports a filesystem write API. `no-write` test
  is a permanent gate.
- **Agent-facing CLI ergonomics** follow the `axi` skill: structured one-line JSON errors with
  codes on stderr, definitive empty states, next-step hints, no interactive prompts, exit codes
  per DESIGN.md §9.
- **AI SDK is v7** (`ai@^7`, `@ai-sdk/openai-compatible@^3`). Use the `ai-sdk` skill for the
  API; do not copy v5 patterns from elsewhere.
- **Portability is the product.** Nothing in this repo may assume a particular machine, gateway,
  model alias or installed binary. If a default would only be right on one machine, it is not a
  default — it is a config-file example.
- **Packaging** follows the `ts-library` skill: ESM, single bundled entry, `bin` → `scoutling`,
  Node ≥ 22, `npm publish --provenance` from CI on tags.
- Commit small and often on `main` with conventional-ish messages; push after each green phase.

## AI SDK v7 — verified against the installed 7.0.83, do not re-derive

These cost real time to discover; the type checker does not catch the first two.

- Stop helper is **`isStepCount(n)`**, not `stepCountIs` (v7 rename; old name is a deprecated
  alias). Test mock is **`MockLanguageModelV4`** from `ai/test`, not `…V2`.
- `finishReason` is `{unified, raw}` **only** at the `doGenerate` provider protocol level. On
  `StepResult`/`GenerateTextResult` the SDK has already unwrapped it to a plain string, so
  `result.finishReason === 'tool-calls'` is right and `.finishReason.unified` silently compares
  against `undefined` forever. Same split for `usage`: nested in the mock, plain numbers on the
  aggregated result.
- A tool `execute()` that **throws** reaches the model as `JSON.stringify(error)`, which drops
  an `Error`'s non-enumerable `message`. So tools **return** a refusal object
  `{error, message, hint?}` — one shape for every refusal — instead of throwing. Follow that in
  `list_dir`/`grep`.
- An unknown tool call is caught in `parseToolCall()` as `AI_NoSuchToolError` and surfaced to
  the model as a `tool-error` part. Confirmed empirically: the model gets "tool not found",
  never a write.
- Vitest cannot `vi.spyOn` Node ESM built-ins ("Module namespace is not configurable"). Use
  `vi.mock('node:fs', { spy: true })`, which spies while the real implementation still runs.

## Conventions already established in code — match them

- Every model-supplied path goes through `resolvePath(scopeRoot, candidate)`. **So does every
  config-supplied path** (a hostile repo's committed `scoutling.config.json` is untrusted input).
- `runCli` takes argv, env, cwd, `fetch` and the stdout/stderr writers as parameters and returns
  an exit code; it never calls `process.exit`. Keep it that way — it is why the CLI is testable.
- Emoji (🐦) on human-facing surfaces only: README, DESIGN, npm description, `--help`. Never on
  stdout answers, the one-line JSON errors or the `--verbose` step log — parent agents parse those.
- Toolchain reality: **vitest 4** (not ^2), **tsdown needs Node ^22.18 || >=24.11 to build**, and
  `@vscode/ripgrep` 1.18 ships per-platform optional deps rather than a postinstall download.

## Dogfooding

`docs/dogfood-log.md` records real runs made while building scoutling. From Phase 3 on, prefer
delegating "where/how/what" questions about large scopes to scoutling, then record a row.
**Verify every citation against the file before acting on it**, and log a `wrong` verdict rather
than quietly correcting it — Phase 6 tunes the budget presets from these numbers, and failed
questions become Phase 5 question-set seeds. scoutling never writes this log; the caller does.

## Skills installed here (`skills-lock.json`, restore: `npx skills experimental_install`)

`axi` · `ai-sdk` · `vitest` · `ts-library` · `domain-modeling` · `tdd` · `codebase-design`

Plus `.claude/skills/scoutling/` — the DESIGN.md §11 Claude Code integration, checked in, not
from the lockfile. Keep it truthful about which flags actually exist.

## Local dev

- Reference machine runs LM Studio on `http://localhost:1234/v1`; verified model ids for smoke
  tests: `qwen/qwen3-coder-next` (fast), `qwen/qwen3-next-80b`, `qwen/qwen3.8-27b`,
  `qwen/qwen3.6-35b-a3b`. Put your own in `scoutling.config.local.json` (gitignored).
- `pnpm` is the package manager.
