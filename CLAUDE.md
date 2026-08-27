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

**Phases 1-3 of DESIGN.md §13 are done and green. Phase 4 is next.**

Shipping today: `config.ts` (six layers + provenance), `provider.ts` (+ `listModels`),
`guardrails.ts`, `scope-walk.ts`, all three tools (`tools/read-file.ts`, `tools/list-dir.ts`,
`tools/grep.ts`, assembled by `tools/index.ts`), `prompt.ts`, `loop.ts` (`runScoutling`),
`cli.ts` (`runCli`, injectable I/O), `script/smoke.ts`. **161 hermetic tests, 12 files.** CI is
green on ubuntu/macos/windows × node 22/24.

A run finally has a **discovery tool**, so "where is X?" no longer has to name its file — that
was Phase 2's single biggest limitation and the reason dogfooding starts now, not earlier. The
default step cap is 8 (DESIGN.md §7's `normal` preset), overridable with `--max-steps`.

**Phase 4 adds** `budget.ts` (presets + cumulative tool-output byte accounting), `citations.ts`
+ `--require-citations`, TOON encoding of the `list_dir`/`grep` results (both return plain JSON
today, with a comment at each return site saying Phase 4 owns it), `--format json`,
`scoutling models`, `scoutling doctor`, and reading the question from stdin.

## Rules

- **Tests first.** New behaviour → failing test → implementation → green. Bug → regression test
  that fails on the bug. All tests are hermetic: mock the model via `ai/test`; never require a
  live provider in `pnpm test`. Live checks are a separate `pnpm smoke` script.
- **Read-only is structural.** No file in `src/` imports a filesystem write API. `no-write` test
  is a permanent gate.
- **A test must prove the path it claims.** Where a fallback or second code path can produce the
  same observable result, assert *which one ran*. The Phase 3 end-to-end injection test matched
  the literal `--pre=sh` — but so would the JS fallback, so it passed without exercising ripgrep
  at all until it asserted `engine === 'ripgrep'`. The same rot hits fixed premises: the smoke
  question named its file because Phase 2 had no discovery tool, and kept "passing" after that
  stopped being true. When a phase changes what is possible, re-read what the checks assume.
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
  `{error, message, hint?}` — one shape for every refusal — instead of throwing. All three tools
  do this; keep any new one consistent, so a small model learns one error shape, not one per
  failure mode.
- An unknown tool call is caught in `parseToolCall()` as `AI_NoSuchToolError` and surfaced to
  the model as a `tool-error` part. Confirmed empirically: the model gets "tool not found",
  never a write.
- Vitest cannot `vi.spyOn` Node ESM built-ins ("Module namespace is not configurable"). Use
  `vi.mock('node:fs', { spy: true })`, which spies while the real implementation still runs.
- **`vi.unmock` is hoisted exactly like `vi.mock`**, so calling it in a `describe` body to
  un-mock one module for one test silently disables the mock for the *whole file* before any
  test runs. When most of a file is mocked but one test needs the real thing (as in
  `grep-injection.test.ts`), use the non-hoisted `vi.doUnmock(...)` inside the `it()` body,
  then `vi.resetModules()` and re-import the module dynamically.

## ripgrep — verified against the installed 15.0.0 (`@vscode/ripgrep` 1.18), do not re-derive

- **`.gitignore` is not honoured outside a git checkout.** ripgrep's real default is "apply
  `.gitignore` only when a `.git` is found above the search root" — a bare `.gitignore` with no
  repository around it is silently ignored. A scope root need not be a checkout, so `grep.ts`
  passes **`--no-require-git`** unconditionally. Without it, `list_dir` and `grep` would disagree
  about what is visible in exactly the scopes where it matters least obviously.
- **Exit code 1 means "no matches", not failure** (2 is a real error). `execFile` rejects on any
  nonzero exit, so exit 1 must be unwrapped and treated as a legitimate empty result, or every
  no-match search becomes a crash.
- `--no-messages` suppresses per-file read errors but **not** regex parse errors, so the
  `INVALID_PATTERN` refusal can still rely on reading stderr.
- Exceeding `maxBuffer` arrives as `code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` with `killed`
  *undefined*, so it does not collide with the timeout branch (which keys off `killed`).
- `data.path` in `--json` output can be `{bytes}` rather than `{text}` for a non-UTF-8 path;
  skip such a record instead of crashing. One `match` record with several `submatches` is still
  one matching *line* — do not emit it twice.

## Conventions already established in code — match them

- Every model-supplied path goes through `resolvePath(scopeRoot, candidate)`. **So does every
  config-supplied path** (a hostile repo's committed `scoutling.config.json` is untrusted input).
- `runCli` takes argv, env, cwd, `fetch` and the stdout/stderr writers as parameters and returns
  an exit code; it never calls `process.exit`. Keep it that way — it is why the CLI is testable.
- Every tool is a **factory that binds the scope root at construction** — never a model-supplied
  argument, so a model cannot widen its own scope. Config-supplied options (`excludeGlobs`, the
  injectable `rgPath`) bind the same way.
- `tools/index.ts` is the **single assembly point** for the capability set: one file to read to
  verify the ADR 0002 guarantee. Its `ToolSet` is deliberately a `type`, not an `interface` —
  a type alias with only known properties is assignable to the SDK's `Record<string, Tool>`,
  whereas an interface needs an explicit `[toolName: string]: Tool` index signature, which would
  state that any key may map to a tool and would silence the excess-property check that makes
  adding a write member an error.
- **A cap flag means "there was more", not "we reached the limit".** `walkScope` and `grep` both
  collect one item past the cap so they can tell those apart. The flag becomes a "narrow your
  search" hint, and a false one sends a small model chasing a listing that was already complete.
- **Never degrade silently.** The JS search fallback runs only when the ripgrep binary is
  genuinely missing; every other ripgrep failure is a refusal, and the result always carries
  `engine`. Answering with a weaker engine without saying so is how a wrong answer looks right.
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
- A real run on `qwen/qwen3-coder-next` against this repo takes **~3.5 minutes** and 4-5 of its 8
  steps; `pnpm smoke` allows 300s for that reason. Budget wall-clock accordingly before assuming
  a live run has hung.
- `pnpm` is the package manager.
