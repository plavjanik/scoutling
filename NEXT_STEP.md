# Next step

Working note for whoever picks this up next, human or agent. `CLAUDE.md` is still the contract;
this file only says *where we stopped and what to do first*. Delete it once Phase 5 is underway.

## Where things stand

**Phases 1-4 of DESIGN.md §13 are done, green and pushed.** CI passes on ubuntu/macos/windows ×
node 22/24 with zero annotations, and `pnpm smoke` passes live against `qwen/qwen3-coder-next`.

After the phase closed, two Phase-4 follow-ups were done on top of it:

1. **Fixed: parallel tool calls bypassed the byte budget.** The AI SDK runs a step's tool calls
   concurrently, so every call read `budget.exhausted === false` before any had charged.
   Reproduced at **14x the cap** (5,000 byte cap, 71,084 charged, four parallel `read_file`s in
   one step). `ToolOutputBudget` now reserves before executing and reconciles after.
2. **Added: `grep` context lines.** The dominant cost in a real run was the model reading a whole
   file to see six lines — measured on the smoke run as `grep` 1.9 KB followed by `read_file`
   17.7 KB, 44 % of the whole `normal` budget.

## Do this first, in Phase 6 — before grading anything

**Re-size the §7 budget presets against `read_file`'s real page cost.** A default 400-line
`read_file` page of a real source file measures **17.3 KB**, which is larger than the entire
`quick` preset's 16 KB tool-output budget: `quick` cannot afford a single default read, so any
`quick` number graded before the re-sizing measures the preset, not the model. `normal` is
marginal for the same reason — the smoke question needs 6 steps and 33 KB against caps of 8 and
40 KB, and one observed run spent all 8 steps without writing an answer.

Re-tune `TOOL_CALL_RESERVATION_BYTES` in the same pass. The byte budget admits a call by
reserving that many bytes up front, so the reservation and the cap together decide how many tool
calls a step may run in parallel: at today's 16 KB reservation that is **1** for `quick`, **3**
for `normal`, **8** for `deep`. A reservation at or above a preset's cap turns concurrency off
for that preset entirely — a behavioural knob, not just accounting.

This is written into DESIGN.md §13 item 6 as well, so it is not lost if this file goes away.
The measurements behind it are in `docs/dogfood-log.md`.

## Then: Phase 5, the eval harness

Per DESIGN.md §13 item 5 — `eval/run-eval.ts`, `eval/questions.example.json`, `docs/eval.md`,
and the nine seed questions written to `local-ai/docs/scoutling-eval.json`. Note that
`eval/results/` is already gitignored.

Two things Phase 4 produced that Phase 5 should use:

- `--format json` gives `stepsUsed`, `toolOutputBytes`, `wallMs`, `exhausted` and the verified
  `sources[]` per run. The eval should not re-derive any of that.
- `docs/dogfood-log.md` records failed questions as Phase 5 question-set seeds, which is what
  that log exists for.

## Deferred, deliberately

Both are written up in DESIGN.md §15 under "Deferred from Phase 4", with the reasoning:

- A timeout throws away every step the run completed, and is why `timedOut` in the JSON output is
  a permanently-`false` field.
- The citation extractor still admits a `word:digits` token ("Figure 2:5").

## Conventions that are easy to break

Read `CLAUDE.md` properly, but these three caused real bugs in Phase 4:

- **Bytes mean what the model receives**, not the structured result — the byte budget and the
  `--verbose` log must never measure different things, or the presets become untunable.
- **`{"error"}` on stderr is fatal; `{"warning"}` means it answered anyway.** Never merge them.
- **Run the thing.** Every user-facing defect in Phase 4 was found by running the CLI and reading
  the output, not by the test suite, which was green throughout.
