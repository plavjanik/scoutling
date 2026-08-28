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
| `--temperatures <list>` | `0,0,0.5` | Comma-separated temperature schedule, one entry per run of a cell. |
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

## Not in CI

`DESIGN.md` §12 originally imagined running `questions.example.json` in CI as a smoke test,
behind a `SCOUTLING_EVAL_BASE_URL` secret when one is configured. That is deliberately not wired
up: no GitHub-hosted runner can reach the reference machine's LM Studio instance (it is not
exposed to the internet, and should not be), so a CI job gated on that secret would be permanently
skipped — dead weight in the workflow file rather than a real check. `.github/workflows/ci.yml` is
unchanged by this phase.
