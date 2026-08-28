# 🐦 scoutling — design

> **Your little birds for the codebase.** A scoutling is a small scout you send ahead. It looks,
> it reports back with `path:line` citations, it never touches anything. It runs on whatever
> cheap local model you already have.

Tagline (README/npm description): *"Your little birds for the codebase — a read-only, bounded
investigator that any coding agent can send ahead, on any local model."* (Varys' little birds
report what they saw; unlike his, these cite their sources and never act.)

**One-liner:** a bounded, read-only, multi-step investigator CLI that any coding agent (Claude
Code, Codex CLI, OpenCode, Cursor, a human in a terminal) can shell out to, to delegate "go find
out X about this repo" to a local (or any OpenAI-compatible) model — and get a cited answer back.

- npm: `scoutling` (verified free 2026-08-27; zero exact-name repos on GitHub)
- License: MIT
- Runtime: Node ≥ 22, `npx scoutling "<question>"` zero-install
- Repo: `~/workspace/scoutling` (standalone; **not** inside `local-ai`)
- Status: design final, implementation not started

---

## 1. Why this exists

Mining 46 Claude Code sessions (~3 months) of the `local-ai` project showed ~14 % of all
subagent delegations were already shaped like *bounded, read-only investigation*: `Explore`
codebase surveys and a recurring "read-only reviewer" doc-vs-code audit that caught 5+ real bugs
(stale ticker/signal counts, false strategy claims). That work ran on Sonnet/Opus. It should run
on a local model that costs nothing, with the expensive model reading only the conclusion.

The shape is general — every coding-agent user has the same recurring "just go look and tell me"
sub-task — and (see §3) nobody ships a standalone tool for it.

## 2. Non-goals

- **Not a coding agent.** It cannot write. There is no `edit`/`write`/`bash` tool and never will
  be in the default tool set; read-only is a structural property, not a prompt request.
- **Not a router/proxy.** It does not swap the parent agent's model; it answers one delegated
  question per invocation.
- **Not tied to any gateway.** It speaks plain OpenAI-compatible HTTP to whatever base URL you
  give it. Pointing it at LiteLLM/Ollama/LM Studio/vLLM/a cloud API are all equal configurations.
- **Not an MCP server (v1).** See §11 for the evidence gate that would change this.

## 3. Competitive landscape (researched 2026-08-27)

| Tool | Shape | Read-only? | Bounded? | Any OpenAI-compat URL? | How a parent agent calls it | Activity |
|---|---|---|---|---|---|---|
| [alisorcorp/ask-local](https://github.com/alisorcorp/ask-local) | Python script + Claude Code slash cmd | Yes (no write tool) | Yes: turns 15, read budget, char caps | **No — LM Studio only** | subprocess → stdout | ~47★, 9 commits, MIT, **unpublished** |
| [buger/probe](https://github.com/buger/probe) | Rust CLI + MCP + Node SDK, tree-sitter search | **Default only** (`--allow-edit`) | Yes: `--max-iterations` 30, tokens | Partial (Anthropic/OpenAI/Google/Bedrock; no Ollama/LM Studio docs) | CLI, MCP, SDK | ~693★, active, Apache-2.0 |
| OpenCode `explore` agent | Built-in subagent | Yes | Optional `steps` cap | Yes in principle (subagent model override) | **Internal to OpenCode only** | active |
| zen-mcp-server (forks) | MCP multi-model server | No (debug/review/consensus) | No | Yes (incl. Ollama) | MCP | fragmented forks |
| nanocoder | Full local-first coding agent | No | No | Yes | standalone, not a delegate target | active, npm |
| aider `/ask` | Mode on a coding agent | While in mode | No | Yes (`ollama_chat/`) | not delegatable | mature |
| cursor-agent-mcp | MCP over `cursor-agent` | No | File globs only | No (Cursor's model) | MCP | small |
| gptme explorer profile | Personal agent profile | Yes (that profile) | No | Yes | not a delegate target | active |
| [kunchenguid/axi](https://github.com/kunchenguid/axi) | Design principles for agent-facing CLIs | — | — | — | — | active |

**Gaps nobody fills — what scoutling owns:**

1. Standalone + provider-agnostic + read-only-by-construction + hard-capped, in one tool.
2. A **cited-answer contract** (`path:line` citations extracted, existence-verified, returned as
   structured `sources[]`) as the API guarantee, not a hope.
3. **TOON** as the tool-result wire format — AXI names it as principle #1; no investigator CLI
   uses it yet.
4. **Budget as one dial** (`--budget quick|normal|deep`) with graceful degradation, instead of
   five independent caps a caller must tune.
5. An **ecosystem-neutral integration surface**: documented drop-ins for Claude Code, Codex CLI,
   OpenCode and Cursor that all invoke the same CLI the same way.

Names to avoid (in use in this niche): ask-local, probe, axi, zen-mcp, nanocoder, little-coder,
gptme, mods, llm, codescout (84★), recce (476★ dbt tool), legwork, gander, dekko, sidequest.

## 4. Architecture

```
scoutling/
  package.json  tsconfig.json  tsup.config.ts  LICENSE (MIT)  README.md  DESIGN.md  CHANGELOG.md
  .github/workflows/ci.yml        # node 22 + 24 × ubuntu/macos/windows; hermetic tests (mock model)
  .github/workflows/release.yml   # on tag: build, test, npm publish --provenance
  src/
    cli.ts            # entry (`#!/usr/bin/env node`); hand-rolled arg parsing, subcommands
    config.ts         # layered: flag > env > config.local.json > config.json > ~/.config > built-in (§5)
    provider.ts       # createOpenAICompatible({ baseURL, apiKey, supportsStructuredOutputs })
    loop.ts           # runScoutling(): generateText + stopWhen: isStepCount(N) + byte budget + timeout
    prompt.ts         # default system prompt; contextFiles injection (realpath-deduped, capped)
    tools/
      index.ts        # the 3 read-only tools (ai `tool()` + zod)
      read-file.ts    # line-numbered text, binary sniff, pagination, totalLines hint
      list-dir.ts     # depth 1-3, .gitignore-aware, TOON-encoded
      grep.ts         # @vscode/ripgrep via execFile(["-e", pattern, "--", ...]); JS fallback
    guardrails.ts     # scope root realpath, resolvePath() traversal+symlink check, size caps
    budget.ts         # presets + cumulative tool-output byte accounting
    citations.ts      # extract `path:line` from the answer, verify existence in scope → sources[]
    toon.ts           # @toon-format/toon encode wrapper
    output.ts         # text / json formats, step logger (stderr), structured errors + exit codes
    types.ts
  test/
    guardrails.test.ts  tools.test.ts  grep-injection.test.ts  toon.test.ts
    citations.test.ts   budget.test.ts  no-write.test.ts  loop.test.ts   # all hermetic: ai/test MockLanguageModelV4
    fixtures/           # small tree used by tools tests
  eval/
    run-eval.ts         # `scoutling-eval --questions <file> --repo <dir> --models a,b --runs 3`
    questions.example.json   # 2 self-referential questions about scoutling itself (runs anywhere)
    results/            # gitignored
  docs/
    integrations/claude-code.md  codex.md  opencode.md  cursor.md
    budget.md  citations.md  eval.md
```

**Dependencies (runtime):** `ai` **^7** (7.0.83 as of 2026-08-27 — the `local-ai` examples are
on v5; follow the installed `ai-sdk` skill for the v7 API, not those examples verbatim),
`@ai-sdk/openai-compatible` ^3, `zod`, `@toon-format/toon` ^4.1, `@vscode/ripgrep` ^1.18,
`ignore` (gitignore matching). **Dev:** `typescript` ^5.7, `tsdown` (the `ts-library` skill's
call; note it requires Node ^22.18 || >=24.11 to *build*), `tsx`, `vitest` **^4** (^2 in the
original draft was two majors stale). Bundle to one ESM file so `npx` startup is fast;
`@vscode/ripgrep` stays external. **Verified in Phase 1:** as of 1.18.0 it no longer downloads a
binary in a postinstall hook — it declares per-platform optional dependencies
(`@vscode/ripgrep-darwin-arm64` and friends), which install cleanly under pnpm's default
blocked-build-scripts policy. The hermetic test mock is **`MockLanguageModelV4`**, and the stop
helper is **`isStepCount(n)`** (v7 renamed `stepCountIs`; the old name survives as a deprecated
alias).

**Skills installed for agents working on this repo** (project-scoped via `npx skills`, pinned in
`skills-lock.json`, restored with `npx skills experimental_install`): `axi` (agent-facing CLI
ergonomics — the spec §9 follows), `ai-sdk` (official Vercel, v7 API), `vitest`, `ts-library`
(packaging/publishing), and mattpocock's `domain-modeling` (owns `CONTEXT.md` + `docs/adr/`),
`tdd`, `codebase-design`.

**Why `@vscode/ripgrep` and not system `rg`:** on the reference machine `rg` is *not* a system
binary — `which rg` resolves to a Claude Code shell function proxying to Claude's bundled
ripgrep, so a plain `execFile("rg")` from Node gets `ENOENT`. The earlier draft's "confirmed
installed" was wrong. Bundling the binary via npm is also the portable answer (Windows included).
A pure-JS regex fallback remains only for the case the postinstall download fails, with a
200-char pattern cap and a per-file match timeout (no linear-time guarantee without `rg`).

**Agentic loop:** Vercel AI SDK `generateText({ model, tools, stopWhen: stepCountIs(N),
onStepFinish })` — the pattern proven in `local-ai/examples/batch-research.ts`. No hand-rolled
while-loop.

## 5. Configuration

Precedence, highest first — each layer overrides individual keys of the ones below it (shallow
merge; arrays replace, not concatenate):

1. **CLI flag**
2. **`SCOUTLING_*` env var** (`SCOUTLING_MODEL`, `SCOUTLING_BASE_URL`, `SCOUTLING_API_KEY`,
   `SCOUTLING_BUDGET`, …)
3. **`scoutling.config.local.json`** — per-repo, **gitignored**, per-developer. This is where
   each person pins the model/base URL that fits *their* machine (a 16 GB laptop runs
   `qwen/qwen3.6-35b-a3b`, the Mac Studio runs `qwen/qwen3-next-80b`) without fighting over
   the checked-in file.
4. **`scoutling.config.json`** — per-repo, checked in, the team's shared non-secret defaults
   (`contextFiles`, `excludeGlobs`, `budget`, a *suggested* model).
5. **`~/.config/scoutling/config.json`** (`$XDG_CONFIG_HOME` respected) — per-user, machine-wide
   defaults that follow the developer across every repo: typically just `baseUrl` + `model`.
6. **Built-in defaults** — `baseUrl: http://localhost:1234/v1`, `budget: normal`,
   `contextFiles: []`, no model.

Both repo files are looked up in `--path` (default cwd) only — no upward directory walk in v1.
`scoutling doctor` prints the resolved config **and which layer each key came from**, so "why
is it using that model?" is a one-command answer. `scoutling init` (v1.1) appends
`scoutling.config.local.json` to `.gitignore`; until then the README says to.

```jsonc
// scoutling.config.json — checked into the repo scoutling runs *in*, non-secret, shared
{
  "baseUrl": "http://localhost:1234/v1",     // built-in default = LM Studio
  "model": "qwen/qwen3-next-80b",            // no built-in default; required via flag/env/config
  "budget": "normal",                        // quick | normal | deep  (see §7)
  "contextFiles": ["CLAUDE.md", "AGENTS.md"], // default [] ; deduped by realpath
  "contextFilesMaxChars": 4000,
  "excludeGlobs": ["node_modules/**", ".git/**", "dist/**", "out/**"],
  "systemPromptFile": null,                  // optional full replacement of the built-in prompt
  "temperature": 0
}
```

```jsonc
// scoutling.config.local.json — gitignored, this developer's machine
{ "model": "qwen/qwen3.6-35b-a3b", "baseUrl": "http://localhost:11434/v1" }
```

- `SCOUTLING_API_KEY` is the only secret; goes in `.env` (gitignored), the environment, or
  `scoutling.config.local.json` / the user-level file (both are outside version control). Never
  in the checked-in file — the loader warns if it finds `apiKey` there. LM Studio/Ollama don't
  need one (`not-needed` default).
- **`--model` is the only hard requirement** when no config file is present. Which models exist
  varies per machine, so a baked-in default would itself be a portability leak.
- `AGENTS.md` → `CLAUDE.md` is a symlink in `local-ai`; the loader dedupes context files by
  `realpath`, so listing both everywhere is harmless.

## 6. The three tools (all read-only)

| Tool | Input | Output / behaviour |
|---|---|---|
| `read_file` | `{path, offset?, limit? (default 400, max 2000)}` | Line-numbered plain text (prose/code isn't tabular → not TOON). Returns `totalLines` so the model paginates instead of re-reading. Binary-sniffs and refuses. Files > 2 MB refused with a hint. |
| `list_dir` | `{path=".", depth? (1–3), glob?}` | `{name,type,size}[]`, **TOON-encoded**. Honors `.gitignore` + `excludeGlobs`. Cap 500 entries with a truncation note. |
| `grep` | `{pattern, path=".", glob?, caseSensitive?, maxMatches? (default 100, max 500)}` | `{file,line,text}[]`, **TOON-encoded**; truncated with a "narrow your pattern" hint. Definitive empty state: `{matches:[], note:"no matches for <p> under <path>"}`. |

**Guardrails (`guardrails.ts`):**
- Scope root fixed at startup (`--path`, default cwd), canonicalized with `realpathSync`.
- `resolvePath()` normalizes → realpaths → asserts the result is inside root. Defeats `../`
  traversal and symlink escapes. (A TOCTOU window between check and read exists; acceptable for a
  single-user tool — documented, not hardened against a concurrent attacker.)
- **No write capability exists** in the process: no tool imports `writeFile`/`unlink`/`rename`/
  `appendFile`/`chmod`/`mkdir`. `no-write.test.ts` spies every `fs`/`fs/promises` write entry
  point and runs an adversarial "please fix this file" prompt through a mock model that *tries*
  to call nonexistent write tools — asserting zero writes and that the model gets a
  "tool not found" result, not a write.
- **`grep` argument injection:** a model-controlled `pattern` starting with `-` would otherwise
  be parsed by `rg` as a flag — `--pre <cmd>` executes a command per file. Always invoke
  `execFile(rgPath, ["-e", pattern, "--", ...paths])`. `grep-injection.test.ts` asserts
  `pattern: "--pre=sh"` is passed as a literal after `-e`. This closes the one hole the Node
  fs-spy cannot see (a child process).

## 7. Budget — one dial, several caps underneath

| preset | maxSteps | maxToolOutputBytes | timeoutMs | maxOutputTokens |
|---|---|---|---|---|
| `quick` | 4 | 16 000 | 90 000 | 4 000 |
| `normal` (default) | 8 | 40 000 | 180 000 | 10 000 |
| `deep` | 15 | 120 000 | 420 000 | 16 000 |

Any individual cap is overridable (`--max-steps`, `--max-tool-bytes`, `--timeout-ms`).

- **Steps alone don't bound cost.** 8 steps × 400-line reads can blow a small local context
  mid-loop. `budget.ts` tracks cumulative tool-result bytes; past the cap, further results are
  replaced with `"[budget exhausted — synthesize from what you have]"`.
- **`maxOutputTokens` is set explicitly** — reasoning-capable local models need ≥10 k in tool
  loops or they truncate mid-think before emitting a tool call.
- **Timeout wraps the whole run, including JIT model load.** LM Studio cold-loading an 80 B
  model can take 60 s+ before the first token. The timeout error says so and suggests
  `--timeout-ms` or a warm-up call.
- **Context-window reality check:** LM Studio's default per-model context is often 4–8 k.
  System prompt + 4 k of `CLAUDE.md` + one 400-line read exceeds that. `scoutling doctor` (§9)
  warns when it can read the loaded context length; README says "set ≥ 32 k for the model you
  point scoutling at".
- On budget exhaustion (any cap, steps included) the answer is still returned, flagged `exhausted: true`, with a
  next-step hint ("narrow `--path` or ask a more specific question"); exit code 1, not 0.

## 8. The cited-answer contract

The system prompt requires every factual claim to cite `path:line` (or `path:line-line`). This
is what made the historical read-only-reviewer runs catch *verifiable* bugs rather than
plausible-sounding ones.

`citations.ts` then, with **no extra model call**:
1. Extracts every `path:line` / `path:line-line` token from the answer (paths relative to scope
   root). **The line number is required.** The original draft of this section also extracted a
   bare `path`, and Phase 4 measured what that does to real answers: a model that quotes a code
   snippet (`[...flags, path/operand]`), names two ADRs at once ("ADR 0002/0004") or illustrates
   a *rejected* input (`../../etc/passwd`) scatters slash-bearing tokens through its prose that
   were never claims about the code. Every one became an unverifiable source, and one correct
   smoke answer reported `Sources: 2 verified, 4 unverifiable`. Since the prompt above requires
   a `path:line` for every factual claim, a bare path is not a citation by this tool's own
   contract — requiring the line number cost no true positive in any observed run and removed
   every false one.
2. Verifies the file exists in scope and the line range is within `totalLines`.
3. Returns `sources: [{path, line, endLine?, verified: boolean}]` in JSON output, and in text
   mode appends a one-line `Sources: 7 verified, 1 unverifiable (lib/foo.ts:999)`.

`--require-citations` makes an answer with zero verified sources exit non-zero. This is the
differentiator nobody else has; it is also exactly what a parent agent needs to decide what to
`Read` next.

## 9. CLI contract

```
scoutling "<question>" [--model <id>] [--base-url <url>] [--api-key <k>]
          [--path <dir>] [--budget quick|normal|deep] [--max-steps N] [--timeout-ms N]
          [--format text|json] [--require-citations] [--verbose] [--no-context]
scoutling -                   # read the question from stdin (long prompts from a parent agent)
scoutling models              # GET <base-url>/models — what can I pass to --model?
scoutling doctor              # resolved config + which layer set each key; base-url reachable?
                              # model present? rg binary ok? context length?
scoutling init <claude-code|codex|opencode|cursor>   # v1.1 — writes the integration file
```

- **`text`** (default): the answer, prose, stdout only. **`json`**: `{answer, sources, model,
  usage, stepsUsed, toolCalls:{read_file,list_dir,grep}, exhausted, timedOut, wallMs}`.
- `--verbose`: per-step log to stderr (tool name, args summary, bytes returned).
- **Errors** are one-line JSON on stderr with a code, and map to exit codes:
  `0` ok · `1` answered but budget exhausted / no verified citations under `--require-citations`
  · `2` `BAD_ARGS` · `3` `PROVIDER_UNREACHABLE` · `4` `TIMEOUT` · `5` `PATH_NOT_FOUND` ·
  `10` `INTERNAL`.
- Missing `--model` → `BAD_ARGS` whose message includes the live `GET /models` list, so the fix
  is one retry away.
- No interactive prompts, ever (AXI principle 6); `NO_COLOR` respected.

**AXI principles applied:** TOON for tabular tool results (1), 3-field list items (2), truncate
with size hint (3), pre-computed `toolCalls` counts (4), definitive empty states (5), structured
errors + exit codes, no prompts (6), next-step hint on exhaustion (9), per-subcommand `--help`
(10).

## 10. Project context & system prompt

- **`contextFiles`** (default `[]`): named files under the scope root, read (capped at
  `contextFilesMaxChars`, truncated with a note), realpath-deduped, prepended as a "Project
  context" block. `CLAUDE.md`/`AGENTS.md` are plain markdown written for an AI reader — exactly
  the grounding a local investigator needs. `--no-context` disables per run.
- **Claude Code Skills are not loaded.** There is no runtime for them outside Claude Code; a
  loader would be Anthropic-specific maintenance against the portability goal. A skill's
  markdown body can be listed in `contextFiles` like any other file.
- **`systemPromptFile`** fully replaces the built-in prompt for special uses (e.g. a doc-vs-code
  audit template). The injection point exists from day one; shipping templates is v1.1.
- Built-in prompt, in brief: you are read-only; scope root is `<root>`; prefer `list_dir` before
  blind sweeps; cite `path:line` for every claim; if the budget runs out say so explicitly rather
  than guess; answer in the question's language.

## 11. Integration with coding agents

The tool is only useful if the parent agent reaches for it. Shipping docs/snippets for four
hosts, all invoking the identical CLI:

- **Claude Code** — a Skill (`.claude/skills/scoutling/SKILL.md`) with trigger phrases ("survey",
  "map", "how does X work", "fact-check docs against code", "find where Y is defined") and a
  one-line usage example; plus one sentence in `CLAUDE.md`. In `local-ai` this is the mechanism
  that already routes to `hlasm-navigate`/`signals-research`, so it is proven to fire. A
  CLAUDE.md paragraph alone is passive and gets skipped.
- **Codex CLI** — `AGENTS.md` snippet + a shell alias.
- **OpenCode** — a custom agent/command definition calling `scoutling`.
- **Cursor** — a `.cursor/rules` entry.

**MCP mode is deferred, evidence-gated.** A stdio MCP wrapper around `loop.ts` is ~100 lines.
Build it only if real usage shows tight bursts of repeated calls within one session (where
process startup + JIT load per call actually hurts). One-shot "investigate and report" does
not need a daemon.

## 12. Eval

`eval/run-eval.ts` runs `questions × models × runs` in-process against any base URL, sequential
per model (one GPU), and writes `eval/results/<ts>-<model>.json` + a markdown table
(question × model × run → tokens / wallMs / stepsUsed / toolCalls / verified sources / empty
"correct?" column).

**Models for the reference eval (LM Studio, direct, verified IDs 2026-08-27):**

| LM Studio id | `local-ai` alias | why |
|---|---|---|
| `qwen/qwen3-next-80b` | `chat-agent` | "fast agentic loops" — leading hypothesis |
| `qwen/qwen3-coder-next` | `coder` | code-oriented alternative |
| `qwen/qwen3.8-27b` | `chat-strict` | today's structured-task winner on this machine |
| `qwen/qwen3.6-35b-a3b` | — | the cheap floor: how small can we go? |

(Re-checked 2026-08-28: `qwen/qwen3-coder-30b` *is* present in LM Studio on the reference
machine, so the earlier draft's note that it does not exist was wrong. All four models above are
confirmed present.)

**Runs:** 3 per cell — 2 at `temperature 0` + 1 at `0.5`. At temp 0 most local backends repeat
themselves; the variance that matters is tool-call parse failures, budget exhaustion and JIT
timing, which the harness records per run (`stepsUsed`, `toolCallErrors`, `exhausted`).

**Question sets:**
- `eval/questions.example.json` — 2 self-referential questions about scoutling's own source
  (hermetic, runs in any checkout; used in CI as a smoke test when a `SCOUTLING_EVAL_BASE_URL`
  secret is present, skipped otherwise).
- The 9 real questions mined from `local-ai` history (5 `Explore` surveys, 4 doc-vs-code audits
  with known stale facts: "13 signal categories" vs 22 types, "139 tickers" vs 145,
  `EDGAR_PHRASES` 13 vs 18, "every strategy excludes financials" vs 3/23) live in the `local-ai`
  repo as `docs/scoutling-eval.json` — they reference that private repo's paths. Run with
  `scoutling-eval --questions ../local-ai/docs/scoutling-eval.json --repo ../local-ai`.

**Grading, scoped honestly:** the 4 questions with known facts are graded yes/no on surfacing
that fact. The other 5 are graded manually against what Petr recalls from the original Sonnet
runs — softer, and stated as such. This eval answers *"which local model should the README
recommend as a starting point"* — not *"is local delegation as good as Sonnet"*. The winner
(equal-or-better on known-facts questions at lower time/tokens) is documented in README and
`local-ai`'s `scoutling.config.json`, never baked into the tool.

## 13. Phasing

1. ~~**Repo bootstrap**~~ — **DONE 2026-08-28.** `package.json`, tsconfig (ES2022/NodeNext/strict),
   **tsdown** (not tsup), vitest 4, MIT, CI matrix, this doc. `provider.ts`, `config.ts`.
2. ~~**Minimal loop**~~ — **DONE 2026-08-28.** `read_file` only, `isStepCount(3)`, `cli.ts` with
   `<question> --model --path`. Smoke against LM Studio passed on `qwen/qwen3-coder-next`: 2
   steps, one read, four citations verified correct by hand. 85 hermetic tests.
   *Learned:* with no discovery tool a "where is X?" question is unanswerable — the first smoke
   run had the model inventing `search_function`/`run_shell_command` and exhausting its budget.
   The built-in prompt now names `read_file` as the only tool. Dogfooding starts after Phase 3.
3. ~~**Full tools + guardrails**~~ — **DONE 2026-08-28.** `list_dir` and `grep`, both built on a
   shared `scope-walk.ts` (hierarchical `.gitignore`, `excludeGlobs`, glob filter, symlinks
   reported but never followed) so the two tools cannot drift apart on what is visible.
   `tools/index.ts` is now the single place the whole capability set is assembled — the ADR 0002
   guarantee is checkable by reading one file. Step cap raised 3 → 8 (§7 `normal`), `--max-steps`
   added, and `config.excludeGlobs` is finally threaded into a run (it existed but nothing read
   it). 161 hermetic tests, 12 files.
   *Learned:* ripgrep ignores `.gitignore` entirely outside a git checkout unless
   `--no-require-git` is passed, and its exit code 1 means "no matches", not failure — both
   found by running the binary, neither visible to the type checker. Also: `truncated` must mean
   *"there was more"*, not *"we reached the cap"*; the walk takes one entry past the limit to
   tell those apart, because the flag becomes a "narrow your search" hint and a false one sends
   a small model chasing a listing that was already complete.
4. ~~**Budget + citations + TOON + JSON**~~ — **DONE 2026-08-28.** `budget.ts` presets and
   cumulative byte accounting, `citations.ts` + `--require-citations`, TOON encoding of
   `list_dir`/`grep` via the SDK's `toModelOutput`, `--format json`, `scoutling models`,
   `scoutling doctor`, stdin question. 283 hermetic tests, 18 files.
   *Learned:* the byte budget has to measure what the model actually **receives**, not the
   structured result — a fixture listing is 239 bytes as JSON and 125 as TOON, so charging the
   JSON would have spent the budget almost twice as fast as the model spends context, and
   `--verbose` reporting a different number than `--max-tool-bytes` enforces would have made the
   preset untunable. Both now read the budget's own accounting. Also: a bare `path` is not a
   citation (§8) — measured, not assumed. And two bugs that only running the commands found: a
   run that spends its whole step budget on tool calls printed a **blank** answer, and `doctor`
   reported "no problems found" for a config with no model, which cannot run anything at all.
5. **Eval harness** — `run-eval.ts`, example questions, `docs/eval.md`; write
   `local-ai/docs/scoutling-eval.json` with the 9 seeds.
6. **Run the reference eval** across the 4 models, grade, pick the recommended model, tune
   preset numbers from observed `stepsUsed`/bytes, record results in `docs/eval.md` + README.
7. **Integrations + adoption** — `docs/integrations/*.md`; in `local-ai`: `scoutling.config.json`,
   `.claude/skills/scoutling/SKILL.md`, one line in `CLAUDE.md`.
8. **Publish** — README with the eval numbers, `npm publish --provenance` from CI on `v0.1.0`
   tag, GitHub repo `plavjanik/scoutling`.

Coding phases (2–5, 7) are delegated to a lower-tier model in subagents per the global
delegation rule; review, eval grading and the README claims stay in the main loop.

## 14. Verification

- `pnpm test` hermetic, no model required: guardrails (traversal, symlink, binary, size caps),
  tools on the fixture tree, `rg`-missing fallback (mocked binary path), **grep injection**
  (`--pre=sh` literal), TOON round-trip + size-vs-JSON, citations extraction/verification,
  budget accounting, **no-write** (fs spy + adversarial mock model), loop (mock model drives
  read→grep→answer; asserts `stepsUsed`, `exhausted`, `sources`).
- Live smoke: `npx tsx src/cli.ts "What does resolvePath do for a path outside the scope root?"
  --model qwen/qwen3-coder-next --path . --verbose` — self-referential, independently checkable,
  shows real tool calls.
- Failure paths: `--base-url http://localhost:1/v1` → fast `PROVIDER_UNREACHABLE` (exit 3), no
  hang; `--timeout-ms 1000` → `TIMEOUT` (exit 4) with the cold-load hint.
- Cross-platform CI: ubuntu/macos/windows × node 22/24. The original cross-platform worry was
  the `@vscode/ripgrep` postinstall; that mechanism no longer exists (see §4), so the real
  residual risk is Windows path handling in `guardrails.ts` and the CLI entry point.

## 15. Future ideas (post-v0.1, roughly by value ÷ effort)

1. **Read-only git tools** — `git_log`, `git_blame`, `git_diff` (execFile, `--` guarded). "When
   did X change and why" is the most common question the three fs tools can't answer. v0.2.
2. **`scoutling init <agent>`** — write the Skill / AGENTS.md / OpenCode agent / Cursor rule for
   the host in one command, instead of copy-paste docs.
3. **Prompt templates** — `--template audit` (doc-vs-code fact-check, the origin workflow),
   `--template map` (architecture survey), `--template find` (where is X). Same loop, tuned
   prompt + citation strictness.
4. **Auto-escalation** — `--escalate`: run `quick`; if `exhausted` or zero verified citations,
   re-run `deep` (optionally on `--fallback-model`, e.g. a bigger local or a cloud model). One
   dial that adapts to question difficulty.
5. **`symbols` / `outline` tool, tree-sitter AST parsing** — a real AST, not line matching:
   functions/classes/exports per file, "where is this defined", "what calls this", and the
   ability to return *one function* instead of a 400-line page. This is what `probe` does well
   and it attacks the loop's dominant cost — a small model burning its context on whole files it
   only needed six lines of. `web-tree-sitter` (WASM) keeps it portable and avoids native
   rebuilds per Node version; grammars are per-language, so ship a few (ts/js, python, go, rust)
   and degrade to `grep` for the rest. Read-only by the same standard as the existing tools.
6. **Structured answers** — `--schema <json-schema>`: `generateObject` against the *same*
   configured model (never a hardcoded second model — that was the mistake in the earlier
   `--format toon` design). Lets a parent agent get `{answer, confidence, files_to_read[]}`.
7. **Batch mode** — `scoutling batch questions.json` → one JSON per question; makes the doc-audit
   workflow and evals the same code path.
8. **Read cache across runs** — mtime-keyed cache of `read_file` results in
   `~/.cache/scoutling/`; repeat questions on an unchanged repo get cheaper and faster.
9. **Session follow-ups** — `--session <id>` persists the transcript so a parent agent can ask
   "and what calls that?" without re-investigating. Precursor to MCP mode.
10. **MCP stdio mode** — evidence-gated (§11); trivial once `loop.ts` is stable.
11. **Opt-in web tool** — a SearxNG/any-search-URL `web_search` for "check the docs" questions;
     off by default, read-only by nature.
12. **Telemetry** — `--otel` / `SCOUTLING_OTEL_URL` via AI SDK `experimental_telemetry` →
     Langfuse/any OTLP; per-run cost visibility for people running it against paid endpoints.
13. **Published benchmarks** — the eval numbers as README claims: tokens/time/accuracy across
     local models, and a side-by-side vs. single-shot "paste the files" Q&A (the ~30× token
     savings claim in the prior art, reproduced or refuted).
14. **Plugin tools** — `tools: ["./my-tool.js"]` in config, each exporting an ai-sdk `tool()`
     plus a mandatory `readOnly: true` attestation. Lets people add domain tools (DB read
     replicas, ticket lookups) without forking.
15. **Answer-language flag** — `--lang cs` for non-English teams; the built-in prompt already
     answers in the question's language, this pins it.
16. **AI-friendly semantic code search** — a `search_semantic` tool: embed the scope's chunks
     once, embed the question, retrieve by cosine similarity, so "where do we handle retries?"
     finds `backoff.ts` without the model guessing the right literal. Costs nothing in provider
     coupling: the configured base URL is OpenAI-compatible, so `/v1/embeddings` is already
     reachable (LM Studio on the reference machine serves `text-embedding-qwen3-embedding-8b`
     and `text-embedding-nomic-embed-code` today), and it degrades to lexical `grep` when the
     endpoint has no embedding model. Best paired with #5: chunk on AST boundaries rather than
     fixed line windows, so a retrieved chunk is a whole function.

     **On read-only:** an index or cache is compatible with ADR 0002. That ADR is about the
     *model* having no means to change the scope — the codebase under investigation — so that a
     parent agent can trust the run changed nothing in its repo. A cache under
     `~/.cache/scoutling` is outside the scope, is never model-controlled, and does not touch the
     code. The same reasoning covers idea #8. What must hold: nothing is ever written inside the
     scope root, and neither the path nor the content of a cache entry is chosen by the model —
     cache keys derive from realpath + mtime, never from a model-supplied string. Note that
     `CLAUDE.md`'s blanket phrasing ("no file in `src/` imports a filesystem write API") is a
     mechanism, not the guarantee, and would need narrowing to something like "no write is
     reachable from a tool, and no write targets the scope" before this work starts — otherwise
     the `no-write` gate blocks a cache it was never meant to prohibit.

## 16. Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-08-27 | CLI, not MCP, for v1 | AXI benchmarks (100 % success at lower cost/turns vs MCP); one-shot invocation shape; no daemon to supervise. |
| 2026-08-27 | Generic OpenAI-compatible provider, no gateway/alias coupling | Portability is the product; the `local-ai` gateway is one config among many. |
| 2026-08-27 | `@vscode/ripgrep` instead of system `rg` | `rg` isn't a system binary on the reference machine (Claude Code shell shim only); npm-bundled binary is portable incl. Windows. |
| 2026-08-27 | TOON for tool results only, not for the caller-facing answer | Prose isn't tabular; a second extraction pass re-coupled to a gateway alias was the earlier design's mistake. |
| 2026-08-27 | Name `scoutling`, MIT, Node ≥ 22 via npx, standalone repo | Zero name collisions on npm + GitHub; maximum adoption; matches the "portable" goal. |
| 2026-08-27 | Reserve npm name with a 0.0.1 placeholder before code exists | Name was free 2026-08-27; cheap insurance. |
| 2026-08-27 | GitHub `plavjanik/scoutling`, public from the first commit | Build in the open; simplest provenance story. |
| 2026-08-27 | README tells the origin story + eval numbers, but no `local-ai` repo specifics | The 9 eval questions and Signals-app facts stay in `local-ai/docs/scoutling-eval.json`. |
| 2026-08-27 | Git tools deferred to v0.2 | Keep v1 to the 3 tools the eval exercises; add `git_log`/`git_blame`/`git_diff` once the loop is proven. |
| 2026-08-27 | Config layers: flag > env > `scoutling.config.local.json` (gitignored) > `scoutling.config.json` (checked in) > `~/.config/scoutling/config.json` > built-in | Every developer needs a model that fits their own machine without editing the shared file; `doctor` shows provenance per key. |
| 2026-08-27 | GoT "little birds" as tagline, not package name | `littlebird` taken on npm; `little-birds` free but 11 repos incl. an adjacent local-AI monitor; plural is awkward as a command. Flavour lives in the README. |
| 2026-08-27 | Citations verified structurally, `--require-citations` opt-in | The one contract competitors lack; zero extra model cost. |
| 2026-08-27 | Eval models: next-80b, coder-next, qwen3.8-27b, qwen3.6-35b-a3b | Verified LM Studio IDs; the earlier `qwen3-coder-30b` doesn't exist. |
| 2026-08-28 | Node floor raised 20 → 22 (runtime and toolchain) | Node 20 reached end-of-life 2026-04-30, so shipping `engines: >=20` advertised an unpatched runtime. It also blocked CI: tsdown declares `node ^22.18.0 \|\| >=24.11.0` and its config loader is unavailable below that, so every node-20 build job failed while every node-22 one passed. CI matrix is now 22 + 24, the two lines still receiving security patches. |
