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

**Phases 1-6 of DESIGN.md §13 are done and green; Phase 6 closed 2026-09-04.** The reference eval
has run and been graded across three models, the results are in `docs/eval.md` and the README, the
presets were re-tuned three times from measurement, and brief mode shipped. What remains before
`0.1.0`: the Phase 6b ADRs (`--attach`, a fixed-argv git tool) and eval expansion in `plan.md` §5,
then Phases 7-8 (integrations, publish). An audit auto-passes only with a verified citation
(decided 2026-09-04).

Shipping today: `config.ts` (six layers + provenance), `provider.ts` (+ `listModels`),
`guardrails.ts`, `scope-walk.ts` (+ the shared `isPathVisible`/`explainPathExclusion`), all three
tools (`tools/read-file.ts`, `tools/list-dir.ts`, `tools/grep.ts`, assembled by `tools/index.ts`),
`prompt.ts`, `loop.ts` (`runScoutling`), `budget.ts`, `citations.ts`, `sections.ts`, `toon.ts`, `output.ts`,
`commands.ts`, `run-setup.ts`, `classify-run-error.ts`, `cli.ts` (`runCli`, injectable I/O),
`script/smoke.ts`, and `eval/run-eval.ts` (`pnpm eval`). **421 hermetic tests, 22 files.**
`pnpm smoke` passes live on `qwen/qwen3-coder-next` **on the shipped defaults** — it no longer
needs `--budget deep` or `--timeout-ms`.

### Phase 6 — the reference eval is run and graded

**Presets re-tuned three times** (§7 carries the table and every derivation; `normal` is now 16 steps / 128 KB). Exhaustion fell from 15 of
26 cells (57 %) at DESIGN's original guesses to 3 of 54 (5 %).

**Three models ranked**, each 9 questions x 2 runs. Audits are machine-graded; all 30 survey
answers were hand-checked claim-by-claim against `local-ai`'s source.

| model | audits (2 runs) | surveys solid | verified cites | exhausted | s/step |
|---|---|---|---|---|---|
| `qwen3.6-35b-a3b` | 6/8, 6/8 | **7 of 10** | **364 / 382** | **0, 0** | 16 |
| `qwen3-coder-next` | 6/8, 7/8 | 5 of 10 | 253 / 225 | 1, 2 | 17 |
| `qwen3-next-80b` | 3/8, 2/8 | 2 of 10 (thin) | 167 / 179 | 2, 2 | 8 |

**Draft recommendation: `qwen/qwen3.6-35b-a3b`**, with `qwen3-coder-next` as the cheaper choice for
narrow single-file questions. DESIGN §12 called `qwen3-next-80b` "the leading hypothesis"; that is
disproved — it is fastest and clearly last on quality.

Four things worth carrying, all of which cost real time to learn:

- **The two contenders fail differently, and that matters more than the scores.**
  `coder-next` states wrong *relationships* compactly and confidently — it called Dorsey Momentum
  "pure price-based" when `dorsey-moat.ts:5` says PRICE-BLIND, fundamentals-only. `35b-a3b`
  fabricates *list items* at the margin of long enumerations (a nonexistent `score-score.ts`, a
  line 333 in a 234-line file). The first is expensive to catch; the second is cheap. Tell a
  caller which failure to watch for rather than only which model scored higher.
- **`auto: pass` is not a verdict, and it was caught being wrong.** Two runs passed with *zero*
  verified citations. The audit matchers now require a `path:line` token. The residual gap: the
  token proves the answer *contains* a citation, not that it *resolves* — closing that means
  grading on `verifiedSources` in the harness.
- **Run-to-run variance is +/-1 on 8 audit cells**, so `coder-next` and `35b-a3b` are
  indistinguishable there; the surveys and the citation counts are what separate them.
- **Timing numbers are noisy for reasons other than contention.** Re-measuring on a genuinely
  quiet GPU produced numbers *slower* than the supposedly contended run (17.1 vs 11.4 s/step for
  `coder-next`) — most likely JIT cold-load amortised over fewer cells. Do not treat any single
  s/step figure as precise.

**Two model families were excluded, for cause** (`docs/eval.md` has the detail): `qwen3.8-27b` and
`qwen3.6-27b`, both `qwen3_5`-arch VLMs, are ~10x slower per step and time out on most cells, and
`qwen3.8-27b` reproducibly takes LM Studio down at the identical cell on three attempts. Memory,
quantization and co-tenant contention were each tested and eliminated as causes.

**Brief mode shipped 2026-09-04** (Phase 6b item 1, from `docs/subagent-census.md`): the built-in prompt
asks for one numbered heading per item of a multi-question brief; `sections.ts` splits the answer at
those headings (ATX or bold, numbers kept as written, nothing dropped); `RunResult.sections` carries
each section's own `sources`, verified through one shared `createCitationVerifier` so a brief that
cites the same file five times reads it once; `--format json` emits `sections` after `sources`.

**The five eval-item defects the grading exposed were fixed in wording on 2026-09-04** in
`local-ai/docs/scoutling-eval.json`; the graded numbers above were produced against the old
wording, so a re-run is Phase 6b work, not a correction of these results. `plan.md` is the working
status document.

The whole CLI contract of DESIGN.md §9 exists: `--budget quick|normal|deep` with `--max-steps` /
`--max-tool-bytes` / `--timeout-ms` overriding individual caps, `--format text|json`,
`--require-citations`, `scoutling models`, `scoutling doctor`, and `scoutling -` for a question on
stdin.

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
- **`toModelOutput` exists and is what TOON rides on.** It is declared on `Tool` in
  `@ai-sdk/provider-utils` (not re-exported into `ai`'s own `index.d.ts`, so searching there
  finds nothing) and is invoked by `createToolModelOutput` in `ai/dist/index.js`. `list_dir` and
  `grep` use it to render TOON while their `execute` keeps returning the typed structured
  result — which is why the tool tests never had to learn TOON. Returning `{type:'text', …}`
  from it also means a tool result reaches the model as text; the default (no `toModelOutput`)
  is `{type:'json'}`. A test that asserts the result part is `type: 'text'` therefore proves the
  rendering ran.
- **`AbortSignal.timeout()`'s timer is unref'd** (verified on the installed Node): a 180 s run
  budget does not keep the CLI alive after it has answered. `generateText` surfaces the abort as
  an `Error`/`DOMException` named `AbortError` or `TimeoutError` depending on how the signal was
  made, so `loop.ts` checks `signal.aborted` *and* the name rather than assuming either.
  `MockLanguageModelV4` does no abort handling of its own — its `doGenerate` must react to
  `options.abortSignal` itself, exactly as a real provider's `fetch` would.
- **`@toon-format/toon`'s `encode` renders an `undefined`-valued key as `key: null`** rather than
  dropping it the way `JSON.stringify` does, so `toon.ts` strips those first — otherwise an
  optional `note`/`hint` set to `undefined` would tell the model the field exists and is null.
  `encode` also throws on a string containing an unpaired UTF-16 surrogate, which is the one
  input that defeats it while `JSON.stringify` still succeeds.

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
- **`-C <n>` adds `{"type":"context"}` records** alongside `{"type":"match"}` in `--json` output,
  and ripgrep merges overlapping context windows itself — a line that both matches and falls in
  another match's window is always reported as `match`, never twice. So the ripgrep path needs
  no dedup logic; the JS fallback does, and has it. Verified by running the binary.
- `data.path` in `--json` output can be `{bytes}` rather than `{text}` for a non-UTF-8 path;
  skip such a record instead of crashing. One `match` record with several `submatches` is still
  one matching *line* — do not emit it twice.
- **ripgrep skips hidden files and directories unless `--hidden` is passed.** `grep.ts` now
  passes it unconditionally — verified by running the binary both ways against `local-ai`
  (`139 tickers` lives only in a `.claude/`-nested doc; `rg --no-require-git` found nothing,
  `rg --no-require-git --hidden` found it). This is fixed (2026-08-28, DESIGN.md §15): all three
  tools now agree that hidden files/dirs are visible, decided in favour of widening `grep` rather
  than narrowing `list_dir`/`read_file`, since `.github/`, `.claude/`, `.circleci/`, `.vscode/`
  are legitimate investigation targets.
- **`--hidden` also reaches `.git/`, so it must be excluded explicitly — both `--glob '!.git/**'`
  and `--glob '!.git/'` genuinely stop ripgrep descending into it**, verified against the
  installed binary with a scratch fixture (`hello` written into both `.git/HEAD` and a tracked
  file): `rg --hidden --glob '!.git/**' -e hello .` and the `!.git/` form both match only the
  tracked file. `grep.ts` uses `/**` — the same string `scope-walk.ts` exports as
  `ALWAYS_EXCLUDED_GLOBS`, applied on both the ripgrep flags and the JS fallback's `walkScope`
  call, unconditionally rather than trusting the caller's `excludeGlobs` to still contain it
  (config layers *replace* that key, never merge it).
- **All three tools now share one visibility predicate — applied to both a traversal's results
  and a tool's own `path` argument.** `scope-walk.ts`'s `isPathVisible`/`explainPathExclusion` is
  the single source of truth for "is this path in scope" (inside the scope root, not
  `excludeGlobs`-matched, not gitignored, not under `.git/`); `walkScope` (behind `list_dir` and
  the grep JS fallback) calls through the same `isExcludedByGlobs` helper rather than keeping its
  own copy. All three tools *also* call `explainPathExclusion` directly on their own
  model-supplied `path` argument, immediately after `resolvePath` and before `existsSync`, so
  naming an excluded path explicitly refuses the same way a traversal that stumbled onto it
  would. The refusal wording (`describeExclusionReason`) lives once in `scope-walk.ts`, not
  copied per tool. Before the first fix, `read_file` ignored `excludeGlobs`/`.gitignore`/`.git/`
  entirely and would happily read `.git/HEAD`; before the follow-up (2026-08-28), `grep` and
  `list_dir` checked traversal results but not an explicitly-named excluded `path` — so
  `grep(pattern, path: 'secret.env')` leaked a real match (ripgrep searches an explicitly-named
  path regardless of `--glob`) and `list_dir(path: '.git')` returned a false `{entries: []}`
  instead of refusing.

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
- **Check-then-act around a tool is a bug, not a guard.** The AI SDK runs all of a step's tool
  calls concurrently, so anything that reads state, `await`s the tool, then writes state is
  bypassed by every sibling call in the same step — the byte budget did exactly this and went
  reproducibly 14x over its cap on four parallel `read_file`s. `ToolOutputBudget` now reserves
  synchronously (`admit`) before running and reconciles after (`settle`, in a `finally`, so a
  throwing tool releases its hold instead of wedging the run). The reservation size and the
  preset caps together decide how many calls a step may run in parallel, so they have to be
  tuned together — see DESIGN.md §13 item 6.
- **A cap flag means "there was more", not "we reached the limit".** `walkScope` and `grep` both
  collect one item past the cap so they can tell those apart. The flag becomes a "narrow your
  search" hint, and a false one sends a small model chasing a listing that was already complete.
- **Never degrade silently.** The JS search fallback runs only when the ripgrep binary is
  genuinely missing; every other ripgrep failure is a refusal, and the result always carries
  `engine`. Answering with a weaker engine without saying so is how a wrong answer looks right.
- **Tool result rows stay uniform within one response.** TOON's tabular form only collapses when
  every element of an array has the same keys, so an optional per-entry field must be present on
  all rows or none. `grep` follows this: `kind` appears on every entry when `contextLines > 0`
  and on none at `contextLines: 0`, which is also what keeps the default response byte-identical
  to before that option existed. A field added to *some* rows silently drops the whole array back
  to the verbose one-key-per-line form — no error, just a much larger bill against the byte
  budget: a three-row result measures 87 bytes uniform and 162 with a single key missing.
- **Bytes mean what the model receives.** The byte budget and the `--verbose` step log both read
  `ToolOutputBudget`'s own accounting, which measures the rendered `toModelOutput` (TOON for
  `list_dir`/`grep`) rather than `JSON.stringify` of the structured result — 239 bytes of JSON
  is 125 of TOON for one fixture listing. If those two ever measure different things again, a
  caller tuning `--max-tool-bytes` from a `--verbose` run is reading numbers that do not apply,
  and the §7 presets become untunable.
- **`{"error"}` is fatal, `{"warning"}` is not.** A one-line JSON `error` on stderr maps to an
  exit code and means the run failed. A `warning` (`BUDGET_EXHAUSTED`, `NO_VERIFIED_CITATIONS`)
  means it answered but the caller should know something. Never merge the two shapes — telling
  "degraded answer" from "no answer" is the whole point.
- **Definitive empty states, including the answer itself.** A run can spend every step on tool
  calls and produce no text; text mode says which budget stopped it rather than printing a blank
  line. `doctor` counts an unrunnable config (no model) as a finding, not as "no problems found".
- Emoji (🐦) on human-facing surfaces only: README, DESIGN, npm description, `--help`. Never on
  stdout answers, the one-line JSON errors or warnings, the `--format json` object, or the
  `--verbose` step log — parent agents parse those.
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

**They are excluded from scoutling's own investigation scope** (`scoutling.config.json`'s
`excludeGlobs`), and that is not a judgement about their value — they are for *writing* code and
Claude Code loads them through the Skill tool, which `excludeGlobs` does not touch. They are just
noise when scoutling is asked about *this* codebase: 332 KB of third-party prose competing for
`grep`'s 100-match cap, which since hidden directories became searchable was returning vendored
docs among the top hits for ordinary queries. `.claude/skills/scoutling/` is deliberately **not**
excluded — it is ours, checked in, and part of the product surface, so "does the skill still
describe flags that exist?" stays an answerable question.

## Local dev

- Reference machine runs LM Studio on `http://localhost:1234/v1`; verified model ids for smoke
  tests: `qwen/qwen3-coder-next` (fast), `qwen/qwen3-next-80b`, `qwen/qwen3.8-27b`,
  `qwen/qwen3.6-35b-a3b`. Put your own in `scoutling.config.local.json` (gitignored).
- A real run on `qwen/qwen3-coder-next` against this repo takes **~3.5 minutes** and 4-5 of its 8
  steps; `pnpm smoke` allows 300s for that reason. Budget wall-clock accordingly before assuming
  a live run has hung.
- `pnpm` is the package manager.
