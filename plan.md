# 🐦 scoutling — plan

Written 2026-08-29. Snapshot of what has been done, where Phase 6 stands, and what to do next.
`DESIGN.md` §13 remains the authoritative phase list; `CLAUDE.md` remains the working contract.
This file is a status document, not a second source of truth — if it disagrees with those, they win.

---

## 1. Status in one line

**Phases 1–5 are done, green and pushed. Phase 6 is nearly done:** the presets have been re-tuned
twice from measurement, the reference eval has run across three models, and all 4 audit questions
plus all 30 survey answers have been graded. What remains is writing the results into
`docs/eval.md` and the README, and fixing the eval-item defects the grading exposed.

397 hermetic tests, 21 files. CI green on ubuntu/macos/windows × node 22/24. `pnpm smoke` passes
live on the shipped defaults.

---

## 2. What was done

### Phase 5 — the eval harness (complete)

- `eval/run-eval.ts` (`pnpm eval`) — questions × models × runs, sequential per model, one result
  JSON per model plus a markdown summary. `runEval(io)` returns an exit code and never calls
  `process.exit`; `runQuestion`, `writeResultFile`, `now` and `fetch` are injectable, which is how
  it has hermetic tests.
- `eval/questions.example.json`, `docs/eval.md`, and the nine seed questions in
  `local-ai/docs/scoutling-eval.json` (4 doc-vs-code audits with machine-checkable `expect`
  blocks, 5 architecture surveys graded by hand).
- `src/run-setup.ts` (`buildRunInputs`) so the eval cannot measure a different system prompt than
  the CLI ships, and `src/classify-run-error.ts` so it recognises an unreachable provider the same
  way the CLI does.
- Deliberately **not** wired into CI: no hosted runner can reach the reference machine's LM Studio,
  so the job would be permanently skipped.

### Phase 6 — tuning and the reference eval

**Presets re-tuned twice.** First from a distribution of file costs (266 code + 187 markdown files
across two repos), then from the eval itself. Current §7 table:

| preset | steps | bytes | timeout | parallel calls |
|---|---|---|---|---|
| `quick` | 8 | 48 KB | 420 s | 3 |
| `normal` | 14 | 112 KB | 660 s | 7 |
| `deep` | 28 | 256 KB | 1260 s | 16 |

`TOOL_CALL_RESERVATION_BYTES` stayed at 16 000 through both re-tunes; under these caps it lands at
exactly 2.0× worst-case overshoot across all three presets.

**Result: exhaustion fell from 15 of 26 cells (57 %) to 3 of 54 (5 %).**

**Six bugs found and fixed** (all by running the tool, none by the test suite, which was green
throughout):

1. `quick`'s cap *equalled* the reservation, so a parallel pair of tool calls marked a run
   exhausted immediately — concurrency was off for that preset by arithmetic accident.
2. `grep` was blind to hidden files (`.github/`, `.claude/`), and its two engines therefore
   disagreed with each other on the same query.
3. `read_file` honoured neither `.gitignore` nor `excludeGlobs` — it would read `.git/HEAD`
   despite `.git/**` shipping in the defaults.
4. `grep` with an explicitly-named `path` returned the **contents** of gitignored and
   `.git/`-nested files — a content leak, not merely an inconsistency, which no ripgrep flag
   could close because ripgrep always searches a file you name.
5. The eval question file sat inside the scope it asked about, with every answer in its
   `expect.fact` fields; and the fix for that missed the case of pointing the harness at a *copy*.
6. `runCli`'s injected `cwd` was ignored when resolving a relative `--path`.

**Two harness improvements** driven by the measurements: `exhaustedBy` (which cap fired — steps,
bytes or timeout; you cannot tune a cap you cannot tell fired), and timeout salvage (a run that
hits the wall clock with ≥1 completed step now returns its evidence instead of throwing it all
away; a zero-step timeout still errors with the cold-load hint).

---

## 3. Eval results

### Models

Three models, not the four DESIGN §12 named. `qwen/qwen3.8-27b` was **dropped after the run**: it
reproducibly took LM Studio down at the same cell (`scoring-model` run 0) on two separate
attempts, and it is the only 4-bit model of the four, so ranking it would measure quantization as
much as architecture.

All models are MLX, loaded at a 262 144-token context. `coder-next`, `next-80b` and `35b-a3b` are
8-bit.

### Audits (machine-graded, 4 questions × 2 runs)

| model | auto | verified citations | exhausted | wall | s/step |
|---|---|---|---|---|---|
| `qwen3-coder-next` | 6/8 | 253 | 1 | 37 min | 11 s |
| `qwen3.6-35b-a3b` | 6/8 | 364 | **0** | 32 min | 14 s |
| `qwen3-next-80b` | 3/8 | 167 | 2 | **18 min** | **6 s** |

Requiring a `path:line` token to auto-pass flipped two results from pass to fail; both were
answers carrying the right numbers while citing nothing checkable.

### Surveys (hand-graded, 5 questions × 2 runs, every claim checked against source)

| model | solid | mostly right | significant errors | false claims |
|---|---|---|---|---|
| `qwen3.6-35b-a3b` | **7** | 3 | 0 | 12 |
| `qwen3-coder-next` | 5 | 5 | 0 | 9 |
| `qwen3-next-80b` | 2 (thin) | 7 | 1 | 8 |

**The false-claim counts invert the ranking, and that is the interesting part.** The two models
fail in different ways:

- **`coder-next` states wrong *relationships*, compactly and confidently** — "Dorsey Momentum:
  pure price-based" when `dorsey-moat.ts:5` says it is PRICE-BLIND and fundamentals-only; a
  "frontier model" writing the memo when `config.ts:129` shows extract and memo share
  `chat-strict`. A real symbol in a false relation, and expensive to catch — you must open the file.
- **`35b-a3b` fabricates *list items* at the margin of long enumerations** — two nonexistent
  ingestion sources, a nonexistent `score-score.ts`, a line 333 in a 234-line file. Its long
  tables are ~95 % exact and ~5 % confabulated. Cheap to catch: the path or line doesn't exist.

On the three questions that require *finding* things across directories, `35b-a3b` wins on
accuracy, not just volume — it was the only model to name all three `/learn` consumers (the third
is an MCP resource registration in a fourth directory), and the only one to get the verifier's
model right. On the two questions that are a single-file read, the two are equivalent and
`coder-next` is cheaper.

`qwen3-next-80b` is behind both on every axis except speed: thinnest coverage, missed the `/learn`
trap in both runs, produced the only "significant errors" answer, and one run emitted zero
parseable citations. **DESIGN §12 named it "the leading hypothesis" — that is now disproved.**

### Recommendation (draft, for the README)

**`qwen/qwen3.6-35b-a3b` as the default recommendation**, with `qwen/qwen3-coder-next` as the
cheaper option for narrow, single-file questions. State the failure modes explicitly — a caller
should verify enumerated lists from the first and claimed relationships from the second. This
matches the citation-verification discipline `--require-citations` already encourages.

---

## 4. Defects the grading exposed

**In the eval items themselves** (fix before re-running):

1. `pipeline-stages` — the trap is not what the question asks. It asks "where the LLM boundary
   sits"; grading on the mechanical-vs-LLM-extracted split penalises answers that answered the
   question. "The stages" also has no canonical count (answers gave 6–10, all defensible).
2. `scoring-model` — whether three default-disabled multipliers belong in "the full formula" is
   interpretation, not fact. The question should ask which factors are *currently active*.
3. `strategy-tournament` — five of six answers never mention `run-book-backtests.ts` and are still
   correct; the question is answerable without it. The "shared universe" premise is also
   misleading: the survivorship-honest universe is opt-in (`--universe=historical`).
4. `mcp-server-boundary` — all six passed; near-zero discrimination. Half its trap is an artifact
   of the narrow scope root forcing the cross-directory import.
5. `learn-glossary-system` — the best item, but it rewards *contradicting* the repo's own
   `CONVENTIONS.md:4-8`, which states three consumers and omits MCP. Grade it as "did it go past
   the doc to the code", and make the pass bar the three `loadLearnDocs()` call-site groups.

**In the harness:** auto-grade requires a `path:line` *token*, not a citation that *resolves*. One
run still passes on a citation that does not verify. Closing it means grading on `verifiedSources`.

---

## 5. Next steps, in order

1. **Fix the five eval items** above. They are wording changes, not new questions.
2. **Decide auto-grade on `verifiedSources`** — one-line harness change; it alters eval semantics,
   so it is a decision, not a cleanup.
3. **Third preset nudge:** `normal` hit 14/14 steps twice and 122 KB against a 112 KB cap, so
   ~16 steps / 128 KB. `deep` used 23/28 steps and 51 % of its bytes — leave it generous.
4. **Write the results** into `docs/eval.md` and the README (DESIGN §13 item 6). This closes Phase 6.
5. **Phase 7 — integrations:** `docs/integrations/*.md`; in `local-ai`, a `scoutling.config.json`
   (done), the skill, and one line in its `CLAUDE.md`.
6. **Phase 8 — publish:** README with the eval numbers, `npm publish --provenance` from CI on a
   `v0.1.0` tag.

### Open, deliberately deferred (DESIGN §15)

- `grep`'s `contextLines` can cost more than the read it replaces (23–33 KB median for a broad
  pattern vs 8–10 KB without).
- Extra steps buy **re-reads, not evidence** — a within-run duplicate-read guard is the candidate
  fix; not done because it would move the eval baseline.
- `excludeGlobs` config layers *replace* rather than merge, so setting it silently drops
  `node_modules/**`, `dist/**`, `out/**`. `.git/**` is protected structurally; those three are not.
- The citation extractor still admits a `word:digits` token ("Figure 2:5").
- Timeouts were sized as `maxSteps × 40 s + 90 s` from the *fastest* model. The dropped 27B showed
  the timeout binding at 84 s/step — if a slower model is ever added, that rule needs revisiting.
