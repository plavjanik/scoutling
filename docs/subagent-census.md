# Subagent census — what the read-only investigations actually look like

Written 2026-09-03, during Phase 6. A side study that reads every Claude Code subagent
transcript on the reference machine to find out what real read-only investigations look like,
where scoutling already fits, where it does not, and which real briefs should become eval items.
Re-derive the numbers with `python3 script/mine-subagents.py --out <dir>` (stdlib only; it reads
`~/.claude/projects/*/*/subagents/agent-*.jsonl` and writes one JSON row per agent). The
hand-assigned kinds below came from reading 148 briefs one by one and are not reproduced by the
script. Transcript excerpts are deliberately not quoted in this file.

## The corpus

| | count | est. spend |
|---|---|---|
| Subagent transcripts, 2 Jun – 3 Sep 2026, 10 project dirs (28 duplicates removed) | 1,135 | $3,353 |
| Implementers (edited files or ran mutating shell commands) | 820 | $3,020 |
| Delegating implementers (given a coding brief, spawned another agent instead) | 107 | $55 |
| Read-only, repo-facing investigations | 148 | $150 |
| Of those, scoutling-shaped (a cited answer about a repo, nothing else needed) | 96 | $97, 4.4 h |

Cost is list price (Sonnet 5 $2/$10, Opus 5 $5/$25, Fable 5 $10/$50, Haiku 4.5 $1/$5 per MTok)
with cache writes at 1.25x and cache reads at 0.1x input, which a Max plan never bills — treat
dollars as relative weights. Tokens, context, tool calls and wall-clock are exact from the
transcripts. Category comes from what the transcript *did* (Edit/Write, mutating shell, web,
browser), not from what the prompt said.

Models: 1,078 on Sonnet 5 (717 requested as `model: "sonnet"`), 42 Opus 5, 22 Fable 5, 14 Haiku
4.5. Volume: 3 in June, 177 in July, 859 in August. Projects: screenwright 676, local-ai 266,
sseek 71, cobol-docs 54, zowe-mcp 55, scoutling 38.

**A quarter of implementation spend is investigation.** In the 585 implementers whose first edit
could be located, a median of 20 tool calls (p90 46) and 113 k tokens of context (p75 168 k)
were spent before the first Edit or Write — about $647 of those runs' $2,626. It is the reading
scoutling does, done on Sonnet, then carried as context through the edits.

**Delegation spirals.** 107 transcripts did nothing but spawn another agent; 61 were already at
spawn depth 2 and chains reached depth 5. The global "delegate coding to a lower-power model"
instruction was being read by the subagent too. Fixed the same day in `~/.claude/CLAUDE.md`.

## The 148 read-only transcripts, by kind

Medians per run. "ctx" is the largest single-request context in tokens; "tool KB" the bytes of
tool output the run received.

| kind | n | wall s | p90 s | API calls | tools | ctx k | tool KB | p90 KB | answer chars | $ med | $ total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| map a subsystem for a planned feature | 31 | 182 | 364 | 16 | 28 | 100 | 135 | 257 | 14,006 | 0.9 | 40.3 |
| find / confirm specific facts | 19 | 74 | 124 | 7 | 11 | 69 | 58 | 179 | 4,213 | 0.3 | 4.9 |
| exhaustive inventory | 15 | 195 | 384 | 17 | 25 | 98 | 144 | 247 | 15,547 | 0.6 | 14.6 |
| single-question QA (local-ai HLASM eval) | 14 | 42 | 62 | 5 | 4 | 60 | 6 | 15 | 549 | 0.2 | 2.4 |
| docs-vs-code fact-check | 8 | 310 | 778 | 36 | 39 | 153 | 154 | 609 | 10,537 | 2.7 | 26.1 |
| trace a flow / event order | 5 | 193 | 270 | 23 | 26 | 114 | 101 | 169 | 8,651 | 1.2 | 5.2 |
| bug diagnosis ("why does X happen") | 4 | 126 | 227 | 15 | 26 | 74 | 68 | 128 | 7,043 | 0.6 | 3.3 |
| *— the seven rows above are the 96 scoutling-shaped runs —* | | | | | | | | | | | |
| diff / code review angles | 20 | 192 | 401 | 14 | 16 | 106 | 133 | 246 | 4,819 | 0.6 | 24.8 |
| design / plan agents, plan critique | 8 | 248 | 670 | 13 | 21 | 92 | 108 | 297 | 17,338 | 0.6 | 8.7 |
| external / prior-art research | 2 | 102 | 117 | 8 | 9 | 39 | 20 | 34 | 4,645 | 0.1 | 0.2 |
| forensics on a minified VS Code bundle | 1 | 1,822 | — | 110 | 124 | 182 | 235 | — | 33,265 | 7.9 | 7.9 |
| control-flow noise (forks, pollers, placeholders) | 21 | — | — | 7 | 6 | 93 | 9 | — | — | 0.3 | 10.9 |

The cheap kind (find/confirm: 74 s, 7 calls, $0.30) is what the skill describes today. The kinds
that dominate spend and time — feature maps and inventories — run 4–6 minutes, 25 tool calls,
135–145 KB of tool output, and answer in 14–16 k characters. That is what gets delegated before
designing something, and it sits at or beyond `deep`.

## Anatomy of a real brief (the 96)

Prompt median 1,700 chars (p90 2,900); answer median 8,700 chars (p90 23,400) with a median of 8
distinct `path:line` citations (p90 72).

| feature of the brief | share |
|---|---|
| asks for `file:line` references | 89 % |
| names starting files or directories | 73 % |
| asks whether something exists | 72 % |
| three to eight numbered sub-questions, answer expected in the same sections | 70 % |
| spans a monorepo | 60 % |
| explicit read-only clause | 47 % |
| asks for verbatim snippets | 43 % |
| length or density limit ("under 250 words", "only conclusions") | 43 % |
| a thoroughness dial ("breadth: medium / thorough / very thorough") | 35 % |
| asks for a recommendation | 31 % |

## How they searched

The parent sessions steer agents to Bash for reading and searching, so Grep/Glob tools were
never used. Shell families across the 148: `grep` 1,145 (mostly `-rn`, `-l`, `-c`, `-A/-B`,
`-v`, `--include`), `sed -n A,Bp` 403 (461 ranges, median 51 lines, p90 120), `find`/`ls` 232,
`cat` 107, `wc` 52, `git diff/show/log` 61, loops/`awk`/`python3 -c` 93. The Read tool: 649
calls, 263 with a `limit` (median 80 lines). Pipes or chains in 1,955 of 2,376 Bash calls.

| capability a run needed | share of 148 |
|---|---|
| listing directories or finding files by name | 73 % |
| ranged reads of a large file | 58 % |
| counting (lines, matches, files) | 50 % |
| grep with surrounding context | 31 % |
| ad-hoc scripting | 23 % |
| network, docker, gh, a local HTTP service | 20 % |
| running tests or repo scripts | 18 % |
| files outside the repo (a saved diff in /tmp, a plan under ~/.claude/plans) | 15 % |
| git history or a diff against a branch | 14 % |
| peak context above 200 k tokens | 6 % |

## Fit against the §7 presets

| metric (the 96) | median | p75 | p90 | quick | normal | deep |
|---|---|---|---|---|---|---|
| model steps (API calls) | 13 | 19 | 35 | 8 | 14 | 28 |
| tool output received, KB | 91 | 173 | 244 | 48 | 112 | 256 |
| wall-clock s (Sonnet/Opus) | 135 | 288 | 633 | 420 | 660 | 1,260 |
| distinct files opened with Read | 3 | — | 13 | | | |

52 of 96 fit `normal` on both steps and bytes; 89 fit a stretched `deep` (40 steps, 400 KB). The
other seven are the fact-checks and largest inventories (35–81 calls, 250–610 KB), which were
already split by hand into parallel slices. Sonnet sat at 100–200 k tokens of context; a local
model at 64 k must reach the same answer from a quarter of the evidence, which is what the byte
cap enforces. 55 of the 96 were launched in batches of 2–9 siblings within 90 s; on one GPU
that fan-out serializes.

## Did the answers hold up?

The parent's next message was located for 103 runs; 9 carry a correction. The patterns: an
Explore run caught a fourth call site the parent had missed; two delegated agents returned
without doing the work; parents spot-checked "load-bearing" claims before reporting; one session
collapsed a three-level delegation chain by hand. No parent flagged a fabricated citation — the
failure the reference eval found in local models (a nonexistent file, a line past EOF) has no
counterpart in the Sonnet/Opus corpus. That is the gap a local model has to close.

## What this says scoutling is missing (decided 2026-09-03, see plan.md)

1. **Multi-question briefs** — 70 % of briefs; the skill said one question per run. Decision:
   accept the brief in one run, answer each numbered item under its own heading, per-section
   citations in `--format json`.
2. **A feature-map / inventory budget** — the most common expensive kind needs ~40 steps /
   400 KB at p90. A fourth preset or a documented recipe tied to the brief's thoroughness word.
3. **Grep modes that return a list or a number** — `filesOnly`, `countOnly` (ripgrep switches;
   they shrink output and answer "does anything use X").
4. **Negative globs** on `grep` and `list_dir` (`grep -v test`, `--exclude-dir` were the second
   most common filter).
5. **Git history** — 21 runs; all 20 diff reviews. Decision: a fixed-argv `git show/log/diff`
   tool, recorded as an ADR beside 0002 (read-only by absence still holds: no argv from the model).
6. **Evidence outside the scope root** — 15 %. Decision: a read-only `--attach <file>`, also an ADR.
7. **Counts** in truncated tool results, so "65 call sites across 17 files" needs no 65 rows.
8. **Skill text drifted from the presets** (fixed the same day).
9. **Fan-out guidance** in the skill: parallel runs queue on one GPU.
10. **Docs-vs-code at scale** needs slicing per doc group; one run will exhaust.

## Eval items to add (Phase 6b, after Phase 6 closes)

The current set is four audits and five surveys on local-ai. The corpus lacks find/confirm,
trace-with-order, why-diagnosis, exhaustive inventory and the multi-question brief; and 55 % of
real investigation happened in screenwright, a five-package monorepo that would be the second
scope. Candidate items, each lifted from a real brief whose Sonnet/Opus answer exists in the
transcripts (re-verify every line number against the current tree before it becomes `expect`):

| kind | scope | question (draft) | grading idea |
|---|---|---|---|
| trace, ordering | screenwright | When an inbound WSF record carries 0xD0 structured fields, does `Tn3270Session` emit `record` before or after the per-field `structuredField` events? | must cite `packages/protocol/src/session.ts` and answer "after" the SF events |
| why, root cause | screenwright | Why does `config get profiles.<p>.oversize` report provenance `(default)` when set in the project file, while `.model` names the file? | must cite `config/resolve.ts` `mergeLayer` and the object-vs-leaf rule |
| inventory, countable | screenwright | How many call sites write to the "Panelwright" Output channel in `packages/vscode/src`, by file, and is it a LogOutputChannel? | file recall, count within tolerance, a definitive "no LogOutputChannel" |
| enumerate triggers | screenwright | What causes `listProfiles()` to run again in the VS Code extension, and is there a dedup guard on its warnings? | three triggers incl. the 5 s visibility poll; explicit "no guard" |
| find/confirm, negative | screenwright | Are `--no-frame`, `--compact`, `--plain` toggleable at runtime, or startup-only? | a model must say "none exists" rather than invent a palette entry |
| find/confirm, quote | local-ai | Quote the "new only" checkbox idiom in `apps/signals/app/page.tsx` with line numbers, under 150 words | file, line range, length limit honoured |
| trace, cross-package | screenwright | Every production call site of `EbcdicCodec.encodeString`, and the two places `Session.type()` silently maps an unmappable character to 0x40 | both encode points (`session.ts` and `outbound/readModified.ts`) |
| multi-question brief | screenwright | The five-item Zowe-warnings brief (two print sites, refresh triggers, dedup guard, warning strings, other paths) | five headings; both call sites; poll interval; "no guard" — tests decomposition |
| docs status inventory | screenwright | For every `.md` in `docs/` and `docs/apps/`: purpose, type, declared status; headers only | file recall and bytes under cap — tests paging discipline |
| self-referential drift | scoutling | Do the preset numbers in `.claude/skills/scoutling/SKILL.md` match `src/budget.ts`? | pair with a date; it fixes itself once the skill is corrected |

Two methods worth borrowing: the local-ai HLASM eval ran each question once with an index and
once "grep only" and demanded `{"answer", "evidence": ["path:line"]}` — a ladder that would let
this eval compare scoutling's tools against bare grep; and the fact-checks used a fixed
"claim / code says / verdict" report per doc group, which is a reusable rubric for surveys.

## Other read-only subagents in the corpus

Diff-review finder angles (20: correctness, cross-file callers, removed behaviour, reuse,
simplification, efficiency, altitude, conventions — each reading a saved diff plus the enclosing
functions on disk); docs-vs-code fact-checkers (8); whole-layer reviewers on Fable (4); plan and
plan-critique agents (8); the HLASM single-question baselines (14); external and web research
(37); one minified-bundle forensics run; run-and-report and poller agents. Only the first two are
plausible scoutling targets, and both need one input beyond a scope root: a diff, or a doc list.
