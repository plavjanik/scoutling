---
name: scoutling
description: Delegate a bounded, read-only codebase investigation to a local model and get back a cited answer. Use when the question is "go look and tell me" rather than "change this" — surveying or mapping an unfamiliar area, finding where something is defined, or fact-checking documentation against the code. Triggers on "survey", "map this codebase", "how does X work", "where is Y defined", "fact-check the docs against the code".
---

# scoutling

Send a scoutling ahead instead of reading a pile of files yourself. It runs on a local model,
costs nothing, and comes back with `path:line` citations you can verify — so you spend your own
context on the conclusion rather than the search.

## When to use it

- **Surveying** an area you have not read: "what are the moving parts under `src/signals/`?"
- **Locating** something: "which file defines the retry policy?"
- **Fact-checking** prose against code: "does the README's list of supported formats match
  what the parser actually accepts?"

## When *not* to use it

- You already know the file — just read it, that is cheaper than a subprocess.
- The task involves changing anything. scoutling cannot write; it has no edit, shell or write
  tool, by construction.
- The answer needs reasoning the local model will not have. Treat its answer as a lead with
  citations, not as authority — verify the cited lines before you rely on them.

## Usage

```bash
scoutling "<question>" --model <id> [--path <dir>] [--base-url <url>]
          [--budget quick|normal|deep] [--max-steps <n>] [--max-tool-bytes <n>] [--timeout-ms <n>]
          [--format text|json] [--require-citations] [--verbose]
scoutling -            # read the question from stdin, for a long prompt
scoutling models       # what can I pass to --model on this machine?
scoutling doctor       # resolved config, which layer set each key, and what is broken
```

In text mode the answer goes to stdout, followed by one `Sources: N verified, ...` line.
`--format json` gives `{answer, sources, model, usage, stepsUsed, toolCalls, exhausted,
timedOut, wallMs, toolOutputBytes}` instead, where `sources` is
`[{path, line, endLine?, verified}]` — that array is the fastest way to decide what to read next.

Two shapes appear on stderr, and they mean different things:

- `{"error": CODE, ...}` — the run **failed**. `BAD_ARGS` (2), `PROVIDER_UNREACHABLE` (3),
  `TIMEOUT` (4), `PATH_NOT_FOUND` (5), `INTERNAL` (10).
- `{"warning": ..., "hint": ...}` — it **answered anyway**, exit 1, treat the answer as partial.
  `BUDGET_EXHAUSTED` means it ran out of steps or tool-output bytes; `NO_VERIFIED_CITATIONS`
  means `--require-citations` was set and nothing it cited checks out.

Omitting `--model` is safe: the error lists the models the endpoint actually serves. `scoutling
doctor` exits nonzero when it finds a problem, so it is worth one run when anything looks off.

### Examples

```bash
# Locate something, then read the cited lines yourself.
scoutling "Where is the scope-root containment check implemented?" --model qwen/qwen3-coder-next

# Give a wide-ranging question more room than the `normal` budget's 8 steps / 40 KB.
scoutling "Map the tools and how they are assembled" --model qwen/qwen3-coder-next --budget deep

# Machine-readable, and fail rather than return an answer that cites nothing checkable.
scoutling "Where is the retry policy?" --model qwen/qwen3-coder-next --format json --require-citations

# A long or generated question, without fighting shell quoting.
printf '%s' "$LONG_QUESTION" | scoutling - --model qwen/qwen3-coder-next

# Investigate a different repository.
scoutling "What does this package export?" --path ../other-repo --model qwen/qwen3-coder-next

# Watch the step log while tuning a question.
scoutling "How is config precedence resolved?" --model qwen/qwen3-coder-next --verbose
```

## Getting a good answer out of it

- **An open "where is X?" is fair game.** The tool set is `list_dir`, `grep` and `read_file`, so
  the run can find its own way to a file. Naming the file when you already know it is still
  cheaper — it saves a discovery step out of the eight.
- **`grep` can return surrounding lines** (`contextLines`, 0-10), which is usually how a run
  should answer "what does this code do" instead of reading a whole file: on this repo a
  three-line context window costs ~540 bytes against ~17.7 KB for the equivalent `read_file`.
  The run decides that for itself, but a question phrased as "show me the lines around X" nudges
  it there.
- **Ask one question per run.** One question, one answer, one budget.
- **Ask for citations explicitly** if the answer will drive a change; the built-in prompt
  requires them, and saying so again makes small models comply more reliably. Add
  `--require-citations` to turn "cited nothing verifiable" into a nonzero exit instead of an
  answer you have to eyeball.
- **A citation needs a line number to count.** Only `path:line` and `path:line-line` are
  extracted and verified — a bare filename in the prose is not reported as a source at all.

## Reading the result

Citations are `path:line` relative to the scope root, and each one is checked: the file must
exist inside the scope and the line must be within it, which is what `verified` reports.
**Verify before acting on them anyway** — verified means the line exists, not that it says what
the answer claims, and a small local model can cite confidently and still be wrong. The citation's job
is to tell you exactly which lines to read next, which is usually two or three instead of ten
files.
