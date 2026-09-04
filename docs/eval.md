# 🐦 scoutling eval

`eval/run-eval.ts` (`pnpm eval`) runs a question set against one or more local models and writes
back what happened: steps, tool calls, bytes, wall-clock time, citation verification, and (for
questions that name one) a regex-based auto-grade. It is Phase 5 of `DESIGN.md` §13; the harness
itself is described in §12.

## What this answers, and what it does not

**It answers:** *"which local model should the README recommend as a starting point?"* — given a
fixed question set and a fixed base URL, which of the candidate models answers reliably, cites
correctly, and does so in reasonable time/steps/bytes.

**It does not answer:** *"is delegating to a local model as good as just using Sonnet/Opus for
this?"* That comparison needs a human (or a stronger model) grading scoutling's answers against
what an expensive model would have said, which this harness does not do — see "How to grade"
below. Do not read a clean `pnpm eval` run as proof that local delegation is a good idea in
general; it only tells you which *local* option is the least bad one.

## The one-GPU constraint

Every run in the matrix executes strictly sequentially — model-major, then question-major, then
run-order — never concurrently. This is not a performance shortcut: the reference machine has one
GPU, and two "concurrent" runs against the same LM Studio instance would not actually run in
parallel, they would queue behind each other while confusing the wall-clock numbers this harness
exists to produce. If you're pointing the eval at a real multi-GPU inference cluster where
concurrency would be meaningful, that is a possible future enhancement, not something this version
does.

## Running it

```sh
pnpm eval --models qwen/qwen3-coder-next,qwen/qwen3-next-80b
```

`--models` is the only required flag — there is no default model (ADR 0003: nothing in this repo
may assume a particular machine or model). Everything else has a default suited to running the
harness against scoutling's own source from the repo root.

See the plan before spending any wall-clock time on it:

```sh
pnpm eval --models qwen/qwen3-coder-next --dry-run
```

This prints every (model, question, run, temperature, budget) cell the real run would execute,
and the total run count, without calling a model at all.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--questions <file>` | `eval/questions.example.json` (relative to cwd) | Question-set JSON — see schema below. |
| `--repo <dir>` | cwd | The repository the questions are about; the default scope root, and where `scoutling.config.json`/`.local.json` are read from (see "Config, once per model" below). |
| `--models <a,b,c>` | — (required) | Comma-separated model ids. |
| `--base-url <url>` | from resolved config | OpenAI-compatible endpoint. |
| `--api-key <key>` | from resolved config | Sent as a Bearer token. |
| `--budget <preset>` | `normal` | Default budget for questions that do not name their own (`quick`\|`normal`\|`deep`). |
| `--temperatures <list>` | `0,0.5` | Comma-separated temperature schedule, one entry per run of a cell. |
| `--runs <n>` | the length of `--temperatures` | Runs per cell. If larger than the temperature list, the schedule cycles (`--runs 5` with `--temperatures 0,0.5` gives `0, 0.5, 0, 0.5, 0`). |
| `--out-dir <dir>` | `eval/results` (relative to cwd, gitignored) | Where result files land. |
| `--dry-run` | off | Print the plan and exit 0 without calling a model. |
| `--help` | — | Print usage and exit 0. |

### Exit codes

Same shape as `scoutling`'s own CLI (`src/cli.ts`'s `emitError`: one-line JSON with a `code` on
stderr for a fatal error):

- `0` — every run in the matrix completed without error.
- `1` — the eval finished, but at least one run errored (its result is still recorded with
  `ok: false`, and every other run still executed).
- `2` — `BAD_ARGS`: a bad flag, or a question-set file that failed validation.
- `3` — `PROVIDER_UNREACHABLE`: the eval aborted immediately, because nothing else in the matrix
  can succeed either once the endpoint is unreachable. Whatever had already been collected —
  including a partial file for the model that was running when it happened — is still written.
- `10` — `INTERNAL`.

### Config, once per model

Config is loaded once per model, from `--repo` — **not** from a question's `path` subdirectory,
even when a question scopes its run to one. This is deliberate and differs from the CLI (where
`--path` is both the scope root and the config lookup directory): every cell in one eval run has
to be comparable, and a subdirectory carrying its own `scoutling.config.json` would otherwise
silently change `baseUrl`/`budget`/etc. mid-run for only some questions.

## Question-file schema

```jsonc
{
  // Free text: where these questions came from. Optional.
  "description": "...",
  "questions": [
    {
      // Required, unique within the file, kebab-case. This is the row label
      // in the summary table, so keep it short and recognizable.
      "id": "grep-flag-guard",

      // Required.
      "question": "Where is the guard that stops a model-chosen grep pattern from being parsed as a ripgrep flag, and what exactly does it do? Cite path:line.",

      // Optional. Scope root for this one question, relative to --repo. Default '.'.
      "path": "src/tools",

      // Optional. Overrides --budget for this one question. One of quick/normal/deep.
      "budget": "deep",

      // Optional. Present only on an auto-gradable question — DESIGN.md §12's
      // "known stale fact" audits are the model for this: a fact you can
      // check mechanically by regex against the answer text.
      "expect": {
        // Plain English, shown to the human grader — NOT matched against the answer.
        "fact": "the guard passes the pattern as `-e <pattern>` and terminates flags with `--` before the search target, in src/tools/grep.ts",
        // Case-insensitive regexes. auto verdict is "pass" only if EVERY one matches.
        "mustMatch": ["src/tools/grep\\.ts", "-e"]
      },

      // Optional. Free-text guidance for the human grader — most useful on a
      // manually graded question (no `expect`), to say what a correct answer
      // actually needs to say.
      "note": "..."
    }
  ]
}
```

Unknown keys anywhere in the file (top level, on a question, or inside `expect`) are a validation
error naming the offending question id and key — nothing is silently ignored. So are a duplicate
`id`, a missing `question`, an invalid `budget`, and a `mustMatch` entry that does not compile as
a regex.

`eval/questions.example.json` ships two questions that double as a worked example of this schema:
one auto-graded (`grep-flag-guard`, with `expect`), one manual (`walk-scope-truncation`, with only
a `note`). Both are self-referential — about scoutling's own source — so the file runs hermetically
against any checkout of this repo (`pnpm eval --models <id>` with no `--questions`/`--repo` uses
it against the repo you're standing in).

To run a private, path-specific question set (e.g. the `local-ai` question set mined from real
delegation history — not part of this repo):

```sh
pnpm eval --questions ../local-ai/docs/scoutling-eval.json --repo ../local-ai --models qwen/qwen3-coder-next
```

### A question file inside the repo it asks about is excluded automatically

An auto-gradable question's `expect.fact` states, in plain English, the fact the answer must
surface — that is the answer. If the question-set file itself sits inside `--repo`, it is fair
game for `grep`/`read_file` just like any other file in scope, so a model could "answer" a
question by finding and quoting the question file instead of investigating the actual source. The
result would auto-grade `pass` while proving nothing, and silently inflate every score — exactly
the failure this harness exists to catch, undetectably: a contaminated eval looks identical to a
clean one in its output.

So `runEval` appends the question file's own repo-relative path to `excludeGlobs` for every run in
the invocation, whenever the resolved `--questions` file is inside the resolved `--repo`. This
happens after config is loaded, so a repo's own `scoutling.config.json`/`.local.json` cannot drop
it (mirroring `src/scope-walk.ts`'s `ALWAYS_EXCLUDED_GLOBS`, kept local to the eval harness). It is
automatic, not a step to remember — a warning of the form `{"warning":"QUESTIONS_FILE_EXCLUDED", ...}`
is printed to stderr once per invocation whenever this actually happens, naming the excluded path.

`runEval` also walks `--repo` (via `walkScope`, unbounded depth) for any file elsewhere in the tree
sharing the question file's basename, and excludes every match too. This covers the case that
actually happened: pointing `--questions` at a scratchpad copy or an edited subset while the
original — still carrying its `expect.fact` answers — sits untouched inside `--repo`. The exact-path
rule alone misses this, because it only ever looks at the one path `--questions` was given, never at
what else in the repo shares its name. The warning names every excluded path, not just one, when
more than one match is found.

`eval/questions.example.json`, used against scoutling's own repo, and `local-ai/docs/scoutling-eval.json`,
used against `local-ai`, are both real instances of this — see `local-ai`'s `docs/scoutling-eval.json`
question file's own `expect.fact` entries for what would otherwise leak. A question set kept
**outside** the repo it asks about (a separate directory, as most of DESIGN.md §12's examples show)
needs no special handling: `excludeGlobs` is left untouched and no warning is printed.

## Where results land

Every invocation shares one timestamp, `<out-dir>/<YYYY-MM-DDTHH-mm-ssZ>-...` (colons are stripped
so the filename is valid on Windows too):

- `<out-dir>/<stamp>-<model-slug>.json` — one file per model, written as soon as that model's
  cells finish (so an aborted eval still leaves every model that *did* finish). Contains every
  `EvalRunRecord`: the full answer, sources, and every number `RunResult` reports, read off
  directly — never re-derived.
- `<out-dir>/<stamp>-summary.md` — one file covering every model in the run, also printed
  verbatim to stdout. Two tables: per-run (every cell, every run) and per-model (aggregated —
  mean steps/bytes/wallMs, error count, auto-pass rate, exhausted count). This second table is
  what actually answers "which model" — the per-run table is for digging into a specific failure.

  Both tables also break the `exhausted` count down by **which cap fired** (Phase 6 follow-up,
  2026-08-28) — `RunResult.exhaustedBy` says `"steps"`, `"bytes"`, `"timeout"`, any subset, per
  run. The per-run table renders it as one cell right after `exhausted` (`steps+bytes`, `timeout`,
  or empty when nothing fired); the per-model table adds three count columns, `exhausted: steps` /
  `exhausted: bytes` / `exhausted: timeout` — how many of that model's runs hit each cap, with a
  run counted in more than one column when more than one cap fired on it. This exists because a
  single `exhausted: true` is not tunable: Phase 6's first eval run had a question that exhausted
  on bytes twice and on steps once across different runs, and until this landed the only way to
  tell which cap actually bound was opening every run's JSON by hand and comparing. The per-model
  breakdown is the number the §7 preset re-tune reads — "raise `maxSteps` or `maxToolOutputBytes`"
  is a different fix depending on which column is nonzero for a given model.

`eval/results/` is gitignored; nothing there is meant to be committed.

## How to grade

The summary's per-run table has an `auto` column and a `correct?` column, and they are **not the
same thing**:

- **`auto`** is mechanical: `pass` when every one of a question's `expect.mustMatch` regexes
  matched the answer text, case-insensitively; `fail` when at least one did not; blank when the
  question has no `expect` at all (there is nothing to check automatically). A regex match is
  weak evidence — a model can accidentally include a matching substring, or match on a copy-pasted
  code fragment rather than an actual, understood claim. **A `pass` here is evidence worth
  checking, never a substitute for actually reading the answer.**
- **`correct?`** is the human grader's column, and the harness always leaves it empty — including
  on every auto-graded row. Fill it in yourself after reading the answer (and, for a question with
  `expect`, its stated `fact`) against the actual source. The summary lists every auto-graded
  question's `fact` and every manual question's `note` below the tables specifically so you have
  what you're checking against right there, without cross-referencing the question file.

For a manually graded question (no `expect`), there is no `auto` signal at all — grade `correct?`
entirely from reading the answer, using the question's `note` (if any) as the guide to what a
correct answer needs to say.

## Results — the reference run, graded (2026-08-28 to 08-30)

Nine questions (`local-ai/docs/scoutling-eval.json`: four doc-vs-code audits with `expect`, five
surveys graded by hand), two runs each (temperatures 0 and 0.5), three models, one GPU. Every one
of the 30 survey answers was checked claim by claim against `local-ai`'s source. `plan.md` §3 has
the working notes; this is the record.

### Models

Three, not the four DESIGN §12 named. `qwen/qwen3.8-27b` was dropped after the run: it
reproducibly took LM Studio down at the same cell (`scoring-model`, run 0) on separate attempts,
and it is the only 4-bit model of the four, so ranking it would have measured quantization as
much as architecture (details in the incompatibility section below). All three remaining models
are MLX 8-bit, loaded at a 262 144-token context.

### Audits (machine-graded, 4 questions × 2 runs)

| model | auto | verified citations | exhausted | wall | s/step |
|---|---|---|---|---|---|
| `qwen/qwen3-coder-next` | 6/8 | 253 | 1 | 37 min | 11 s |
| `qwen/qwen3.6-35b-a3b` | 6/8 | 364 | **0** | 32 min | 14 s |
| `qwen/qwen3-next-80b` | 3/8 | 167 | 2 | **18 min** | **6 s** |

Requiring a `path:line` token to auto-pass flipped two results from pass to fail; both were
answers carrying the right numbers while citing nothing checkable. The residual gap is that the
token proves the answer *contains* a citation, not that it *resolves*; closing it means grading
on `verifiedSources` in the harness, which changes eval semantics and is recorded as an open
decision in `plan.md`.

### Surveys (hand-graded, 5 questions × 2 runs)

| model | solid | mostly right | significant errors | false claims |
|---|---|---|---|---|
| `qwen/qwen3.6-35b-a3b` | **7** | 3 | 0 | 12 |
| `qwen/qwen3-coder-next` | 5 | 5 | 0 | 9 |
| `qwen/qwen3-next-80b` | 2 (thin) | 7 | 1 | 8 |

The false-claim counts invert the ranking, and that is the useful finding: the two contenders
fail differently.

- **`coder-next` states wrong *relationships*, compactly and confidently** — "Dorsey Momentum:
  pure price-based" when `dorsey-moat.ts:5` says it is PRICE-BLIND and fundamentals-only; a
  "frontier model" writing the memo when `config.ts:129` shows extract and memo share
  `chat-strict`. A real symbol in a false relation, and expensive to catch: you must open the file.
- **`35b-a3b` fabricates *list items* at the margin of long enumerations** — two nonexistent
  ingestion sources, a nonexistent `score-score.ts`, a line 333 in a 234-line file. Its long
  tables are about 95 % exact and 5 % confabulated. Cheap to catch: the path or line does not
  exist, and `sources[].verified` says so.

On the three questions that require *finding* things across directories, `35b-a3b` wins on
accuracy, not only volume: it was the only model to name all three `/learn` consumers and the
only one to get the verifier's model right. On the two single-file questions the two are
equivalent and `coder-next` is cheaper. `qwen3-next-80b` is behind on every axis except speed:
thinnest coverage, missed the `/learn` trap in both runs, the only "significant errors" answer,
and one run with zero parseable citations. DESIGN §12 called it "the leading hypothesis"; that is
disproved.

### What the numbers do not settle

- **Run-to-run variance is ±1 on the 8 audit cells**, so `coder-next` and `35b-a3b` are
  indistinguishable there; the surveys and the citation counts separate them.
- **Timing is noisy for reasons other than contention.** Re-measuring on a quiet GPU produced
  *slower* per-step numbers than the supposedly contended run (17.1 vs 11.4 s/step for
  `coder-next`), most likely JIT cold-load amortised over fewer cells. No single s/step figure
  is precise.
- **The item set has known defects**, fixed in wording on 2026-09-04 (see the question file's
  description): `pipeline-stages` graded a split the question did not ask for and has no
  canonical stage count; `scoring-model` turned on an interpretation of "full formula";
  `strategy-tournament` was answerable without its registry and had the universe premise
  backwards; `mcp-server-boundary` discriminated nothing (6 of 6 passed); `learn-glossary-system`
  rewarded contradicting the repo's own `CONVENTIONS.md`. Results above were graded against the
  old wording; a re-run against the new wording is Phase 6b, together with a second scope
  (`docs/subagent-census.md`).

### Recommendation

**`qwen/qwen3.6-35b-a3b`** as the default recommendation, with **`qwen/qwen3-coder-next`** as the
cheaper option for narrow, single-file questions. Say which failure to watch for, not only which
scored higher: verify enumerated lists from the first and claimed relationships from the second.
`--require-citations` and the per-source `verified` flag catch the first kind mechanically; the
second needs the caller to open the cited line, which is the discipline the skill asks for anyway.

## Timeout policy: timing out is a result

Every model runs against the **same** wall-clock cap (DESIGN.md §7's `timeoutMs`), sized from the
fastest model measured. That is deliberate, and it is a policy rather than an accident of how the
number was picked.

A slower model therefore completes fewer steps inside the same budget, and the eval does not
distinguish "could not answer" from "could not answer in eleven minutes". For a tool whose whole
purpose is to be sent ahead and report back, that distinction does not matter much: a model
needing ~115 s per step fails at the job regardless of what it would eventually have produced.

What this costs, stated plainly: **a model that times out has had its speed measured, not its
reasoning.** Its answers were cut off mid-investigation. Do not read a timeout-dominated row as
evidence the model reasons poorly — it is evidence the model is too slow to be used this way on
this hardware. If you ever need capability isolated from speed, raise `--timeout-ms` and report
the two runs separately; do not silently give one model a longer clock than another.

## Known incompatibility: `qwen3_5`-arch 27B models

**`qwen/qwen3.8-27b` (both quantizations) and `qwen/qwen3.6-27b` cannot complete this question
set.** Recorded 2026-08-29/30 so the next person does not spend the GPU hours rediscovering it.

`qwen/qwen3.8-27b` took LM Studio down — the provider stopped responding entirely, surfacing as
`PROVIDER_UNREACHABLE` — on **three separate attempts, at the identical cell** (`scoring-model`
run 0), after exactly ten completed cells each time. The failure is deterministic, and three
plausible explanations were each tested and eliminated:

- **Memory pressure** — the machine has 512 GB with ~413 GB free at the time of the crash.
- **Quantization** — the 4-bit and the 8-bit variant fail identically.
- **Contention with another LM Studio consumer** — the third run crashed while the only other
  loaded model was idle and subsequently TTL'd out.

Whatever the cause, it is on LM Studio's or the model's side, not scoutling's: the harness aborts
cleanly on `PROVIDER_UNREACHABLE` and flushes the partial results, which is why the ten cells
survive each time. It has not been chased further because it is not on the path to a
recommendation.

Separately, **both models in this architecture family are ~10x slower per step** than the three
ranked models (~115 s/step against 6-14 s), and hit the wall clock on most cells — six of ten for
`qwen3.8-27b@8bit`, six of nine for `qwen3.6-27b`. Under the timeout policy above that is
disqualifying on its own. Note carefully what was and was not measured: **their timeouts were
measured, their answer quality was not**, because most of their answers were cut off before they
finished.

**Selecting a quantization.** LM Studio groups variants under one model key, and the OpenAI-
compatible API exposes only the selected one — `lms ls` shows `qwen/qwen3.8-27b (2 variants)` and
hides the rest. Use **`lms ls --variants`** to see the real keys (`qwen/qwen3.8-27b@4bit`,
`@8bit`) and pass the suffixed id straight to `--model`; LM Studio JIT-loads that variant.
`lms load` rejects the `@`-suffixed key, so do not try to pre-load it that way.

## Not in CI

`DESIGN.md` §12 originally imagined running `questions.example.json` in CI as a smoke test,
behind a `SCOUTLING_EVAL_BASE_URL` secret when one is configured. That is deliberately not wired
up: no GitHub-hosted runner can reach the reference machine's LM Studio instance (it is not
exposed to the internet, and should not be), so a CI job gated on that secret would be permanently
skipped — dead weight in the workflow file rather than a real check. `.github/workflows/ci.yml` is
unchanged by this phase.
