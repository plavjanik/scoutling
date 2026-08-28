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

## Open observations

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
