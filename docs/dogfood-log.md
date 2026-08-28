# 🐦 Dogfood log

One row per real scoutling run made during scoutling's own development. This is not the eval
(§12) — it is unstructured, opportunistic use, recorded so that Phase 6's *"tune preset numbers
from observed `stepsUsed`/bytes"* has real data instead of guesses, and so that questions
scoutling **fails** become seeds for the Phase 5 question set.

**scoutling never writes this file.** It has no capability to, and the file is inside its own
scope. The parent agent that ran it records the row — which is also the honest arrangement,
since the verdict column is a judgement the run cannot make about itself.

## How to record a run

From Phase 4 on, `--format json` emits `stepsUsed`, `toolCalls`, `exhausted`, `wallMs` and
`sources` directly. Until then, read them off the `--verbose` step log.

Verdict is one of:

- **useful** — answered the question, citations checked out, saved the caller work
- **wrong** — answered confidently and was incorrect *(the expensive failure; always note what)*
- **gave up** — exhausted or refused; note what capability was missing
- **unnecessary** — correct, but the caller would have been faster reading the file directly

## Runs

| Date | Scope | Question (abbrev.) | Model | Steps | Exhausted | Verdict | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-28 | scoutling | "What does resolvePath do outside the scope root, and where is that handled?" | qwen/qwen3-coder-next | 3/3 | yes | gave up | Invented `search_function` and `run_shell_command`, burned 2 of 3 steps on tool-not-found. No discovery tool exists in Phase 2, so "where is X" is unanswerable by construction. Fixed the invention half by naming `read_file` as the only tool in the prompt; the rest needs `grep`/`list_dir` (Phase 3). |
| 2026-08-28 | scoutling | "Read src/guardrails.ts and explain resolvePath's out-of-scope behaviour. Cite path:line." | qwen/qwen3-coder-next | 2/3 | no | useful | One read (4,946 bytes), then answered. All four citations (63–64, 66, 67–72) verified correct by hand. |
| 2026-08-28 | scoutling | "Where is the guard that stops a grep pattern being parsed as a ripgrep flag, and what does it do?" | qwen/qwen3-coder-next | 5/8 | no | useful | **First run of a question Phase 2 could not answer at all** — no file named, so it had to find one. grep → two parallel reads → paged read → read DESIGN.md → answered. All six citations (`grep.ts:206`, `grep.ts:177-188`, and three test line ranges) verified exact by hand. ~33 KB of tool output, 3m20s. |
| 2026-08-28 | scoutling | "How does walkScope decide a listing was truncated, and why is it done that way?" | qwen/qwen3-coder-next | 4/8 | no | useful | grep → full read of `scope-walk.ts` → paged read of its test → answered. Explained the limit+1 ceiling correctly, including *why*, and found the mirrored comment in `grep.ts` unprompted. All five citations verified exact. ~22 KB of tool output. |
| 2026-08-28 | scoutling | "What does resolvePath do when a path points outside the scope root?" | qwen/qwen3-coder-next | 4/8 | no | useful | First run on Phase 4: `--format json --require-citations`, exit 0. grep -> read `guardrails.ts` -> read its test -> answered. 16.1 KB of tool output, 1m54s. Both verified citations hand-checked exact (`guardrails.ts:46` is the signature; `:69-70` are the message and hint it quotes). 6 of 8 extracted sources came back unverifiable, and only 4 of those are model errors -- see the citation-noise observation below. |
| 2026-08-28 | scoutling | "Where is the guard that stops a grep pattern being parsed as a ripgrep flag?" (smoke) | qwen/qwen3-coder-next | 8/8 | **yes** | gave up | First run under `--require-citations`, `normal` budget. Spent all 8 steps exploring (2 extra greps and a `list_dir` into `docs/adr`) and wrote no answer at all. 34.9 KB of 40 KB, so *steps* bound here, not bytes. Exit 1 with both warning lines. |
| 2026-08-28 | scoutling | same question, `--budget deep` | qwen/qwen3-coder-next | 6/15 | no | useful | 32.8 KB, 125 s, 3 of 6 sources verified. `grep.ts:207` is exactly the `['-e', pattern, '--', searchTarget]` guard; hand-checked. This is what the question actually costs: inside `normal`'s caps, but with almost no headroom. |
| 2026-08-28 | scoutling | same question, **on the re-sized `normal` default** (smoke) | qwen/qwen3-coder-next | 6/12 | no | useful | First run after the Phase 6 re-sizing, and the direct evidence for it: no `--budget`, no `--timeout-ms`, exit 0, **5 of 5 sources verified** and all five hand-checked exact (`grep.ts:236` is the `[...flags, '-e', pattern, '--', searchTarget]` line, `grep.ts:206-212` its comment, `DESIGN.md:210-213`, `grep-injection.test.ts:119` and `:47-60`). 45.4 KB of tool output over 5 tool calls (2.8 + 19.0 + 15.5 + 7.0 + 1.0 KB) = 57 % of the new 80 KB cap. **Under the old 40 KB cap this exact run would have been refused at its fourth call** (44.4 KB by then), which is the failure the two rows above recorded twice. Note step 1's 19.0 KB read — above `TOOL_CALL_RESERVATION_BYTES`, exactly the p90 tail the reservation is sized to absorb. |
| 2026-08-28 | **local-ai** | "Does scheduler.ts's book-tournament comment match the code it points at?" (via `pnpm eval`) | qwen/qwen3-coder-next | 3/12 | no | useful | **First run against a scope larger than this repo**, and the first through the Phase 5 eval harness. 17.7 KB, 16 s, 2 of 2 sources verified — both hand-checked (`scheduler.ts:114` is the stale "7-strategy" comment, `sweep.ts:50` the `BOOK_STRATEGIES` array). It enumerated all 22 entries by name and got 22, matching my own count. Cheap: 3 steps and 22 % of the `normal` byte cap on a repo ~30x this one, because `grep` landed it on the right two files immediately. Auto-grade `pass` here was a true positive, confirmed by reading the answer. |

## Tool-call cost measurement (2026-08-28) — the basis of the §7 re-sizing

Phase 6's preset re-sizing needed a distribution, not the one file Phase 4 happened to measure.
Every number below is what `ToolOutputBudget` charges — the rendered `toModelOutput`, TOON for
`list_dir`/`grep` — collected by driving the real tools through `withToolOutputBudget` and
reading `budget.spent`, so it is the same number `--max-tool-bytes` enforces and `--verbose`
prints. Two scopes: this repo (42 code, 11 markdown) and `local-ai` (224 code, 176 markdown).

| call | scope | median | p75 | p90 | max | share > 16 KB |
|---|---|---|---|---|---|---|
| `read_file` default (400 lines), code | scoutling | 6.6 KB | 13.8 KB | 16.8 KB | 20.6 KB | 19 % |
| `read_file` default (400 lines), code | local-ai | 3.1 KB | 6.7 KB | 15.1 KB | 31.9 KB | 9 % |
| `read_file` default, markdown | local-ai | 2.9 KB | 3.6 KB | 6.4 KB | 11.4 KB | 0 % |
| `read_file` `limit: 120`, code | both | 3.5-5.1 KB | 5.0-5.4 KB | 6.0-6.1 KB | 7.3 KB | 0 % |
| `list_dir` | both | 0.1-0.4 KB | 0.4 KB | 0.6 KB | 0.7 KB | 0 % |
| `grep` `contextLines: 0` | both | 7.7-10.1 KB | 9.5-10.6 KB | 10.3-12.3 KB | 14.0 KB | 0 % |
| `grep` `contextLines: 3` | both | 23.1-32.9 KB | 40.9-59.6 KB | 43.0-59.9 KB | 59.9 KB | 50-75 % |

What it settled:

- **The premise behind the re-sizing was wrong in an interesting way.** "A default read is
  17.3 KB, larger than the whole `quick` budget" was `src/tools/grep.ts`, this repo's largest
  source file. Across 266 real code files that is the p90; the median is 3-7 KB. `quick` could
  afford several default reads all along.
- **`quick`'s real defect was concurrency, not size.** Its 16 000 cap equalled
  `TOOL_CALL_RESERVATION_BYTES`, so `admit` let exactly one call through and a parallel pair
  marked the run exhausted immediately. Invisible to every existing test, because a *sequential*
  run of small calls behaves identically. `test/budget.test.ts` now gates on it.
- **The reservation stayed at 16 000.** Worst-case overshoot is (calls admitted) x (a call's
  real size), so lowering it admits more oversized calls through the same window: measured
  against the 32 KB largest observed read, 16 000 holds the worst case to 2.0-2.4x a cap where
  12 000 gives 2.7-3.2x and 10 000 gives 3.2x, for one extra concurrent call under `quick`.
  Caught by the existing Phase 4 regression test when a 12 000 value was tried — the test did
  exactly the job it was written for.

## Open observations

- **`grep` with `contextLines` can cost more than the whole-file read it replaces — not yet
  acted on.** The Phase 4 follow-up added `contextLines` on the measured case of a narrow
  pattern: `grep` 1.9 KB then a 17.7 KB `read_file`, replaced by ~540 bytes. That holds for a
  specific pattern. For a *broad* one it inverts: `contextLines: 3` measures 23-33 KB at the
  median and up to 60 KB, against 8-10 KB for the same pattern at `contextLines: 0` — more than
  a p90 whole-file read, and 50-75 % of such calls exceed a single reservation. The saving is
  real but conditional on pattern selectivity, which the tool description does not currently
  say. Candidate for the system prompt or the tool description; measured, not fixed.
- **Phase 4 changed what a byte number means — do not compare these rows to the Phase 3 ones.**
  Through Phase 3 the `--verbose` log measured `JSON.stringify` of the structured tool result.
  It now measures what the model actually receives, which for `list_dir`/`grep` is TOON: a real
  fixture listing is 239 bytes as JSON and 125 as TOON. The 16.1 KB in the Phase 4 row above is
  therefore not directly comparable to the 22 KB and 33 KB above it — part of the drop is TOON,
  part is the measurement changing under it. Phase 6 should tune the preset caps from Phase 4
  numbers only, and re-measure on a scope larger than this repo.
- **Citation extraction picked up example paths from prose — fixed 2026-08-28.** In the first
  Phase 4 run the model listed the paths a *rejected* traversal would use (`../../etc/passwd`)
  as illustrations, and the extractor reported them as unverifiable sources. Later runs added
  `[...flags, path/operand]` from a quoted code snippet and `0002/0004` from "ADR 0002/0004".
  A correct smoke answer read `Sources: 2 verified, 4 unverifiable`. Citations now require a
  line number (DESIGN.md §8, updated to match): the same smoke answer reads `Sources: 4
  verified`, and no true citation was lost in any observed run. Extraction still admits a
  non-citation that happens to be shaped `word:digits`, so keep watching the ratio.
- **This repo is a weak dogfood scope.** At ~2,400 lines it fits in a parent agent's context
  whole, so scoutling will often score *unnecessary* here through no fault of its own. The
  scopes that actually exercise it are `local-ai` (also where the nine eval questions live) and
  large dependencies such as `node_modules/ai`.
- **Verify before acting.** Using scoutling to build scoutling means a wrong answer can be acted
  on. Every citation gets checked against the file before it changes code — a *wrong* row in the
  table above is worth more than a silently-corrected one.
- **Bytes bind before steps do (Phase 3 observation, 2 runs).** Both post-Phase-3 runs finished
  well inside the 8-step cap (5 and 4) but pulled ~33 KB and ~22 KB of tool output — the first
  is already 83 % of the `normal` preset's 40 KB. Steps are not the scarce resource; bytes are.
  A single `read_file` of a 340-line source file cost 16 KB, and one step issuing two parallel
  reads cost 24.7 KB on its own. Two consequences for Phase 4: `budget.ts` byte accounting has
  to charge a *step*, not a call, since the model does issue parallel reads; and the preset byte
  caps should be tuned against these numbers rather than the step counts, which have headroom to
  spare. Worth re-measuring on a scope larger than this one before treating it as settled.
