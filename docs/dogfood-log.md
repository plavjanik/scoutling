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

## Open observations

- **This repo is a weak dogfood scope.** At ~2,400 lines it fits in a parent agent's context
  whole, so scoutling will often score *unnecessary* here through no fault of its own. The
  scopes that actually exercise it are `local-ai` (also where the nine eval questions live) and
  large dependencies such as `node_modules/ai`.
- **Verify before acting.** Using scoutling to build scoutling means a wrong answer can be acted
  on. Every citation gets checked against the file before it changes code — a *wrong* row in the
  table above is worth more than a silently-corrected one.
