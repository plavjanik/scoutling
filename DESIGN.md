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
| `list_dir` | `{path=".", depth? (1–3), glob?}` | `{name,type,size}[]`, **TOON-encoded**. Cap 500 entries with a truncation note. |
| `grep` | `{pattern, path=".", glob?, caseSensitive?, maxMatches? (default 100, max 500), contextLines? (0-10, default 0)}` | `{file,line,text}[]`, **TOON-encoded**; truncated with a "narrow your pattern" hint. Definitive empty state: `{matches:[], note:"no matches for <p> under <path>"}`. With `contextLines > 0` every entry also carries `kind: match\|context` and the surrounding lines come back as their own entries, so the model can read the code around a hit without a follow-up `read_file` — measured at 542 bytes against the 17.7 KB whole-file read it replaces. `maxMatches` counts matches only, never context. |

**Visibility (`scope-walk.ts`'s `isPathVisible` / `explainPathExclusion`, shared by all three tools):** a path is
visible iff it is inside the scope root (`resolvePath`) **and** is not matched by `excludeGlobs` **and** is not
gitignored by the hierarchical `.gitignore` stack from the scope root down to it (applied whether or not the scope
root is a real git checkout) **and** is not under `.git/` (`ALWAYS_EXCLUDED_GLOBS`, structural — see §15). Hidden
entries (dot-files, dot-directories such as `.github/`, `.claude/`, `.vscode/`) **are** visible; `.git/` is the one
dot-directory that never is, regardless of what `excludeGlobs` says. `read_file`, `grep` and `list_dir` all refuse
an invisible path with `PATH_EXCLUDED`, naming which rule fired (`describeExclusionReason` in `scope-walk.ts`), and
this applies **both** to the results a traversal turns up **and** to a `path` the model names explicitly — the two
are checked separately, not the same code path once for both. That second half is the non-obvious one: `grep`'s and
`list_dir`'s `path` argument is model-supplied, and neither backend can be trusted to enforce visibility on its own
when a model names an excluded path directly — ripgrep searches an explicitly-named file or directory regardless of
any `--glob` flag (the `--glob '!...'` list only prunes *traversal*), so an unguarded `grep(pattern, path:
'secret.env')` was a genuine content leak, not just an inconsistency with `list_dir`, and no ripgrep flag could ever
have closed it; it has to be caught before either engine (ripgrep or the JS fallback) even runs. An unguarded
`list_dir(path: '.git')` was a different failure mode but the same root cause: it returned `{entries: []}`, a false
*definitive empty state* (§9's AXI principle 5) indistinguishable from "this directory has nothing in it," instead
of the refusal that "you may not look here" actually is. `walkScope` and `explainPathExclusion` share the same
underlying glob/gitignore predicates rather than each carrying its own copy of the rule — see the "Found while
building the Phase 5 question set" note in §15 for the divergence this closed, and its 2026-08-28 addendum for the
explicit-`path` follow-up above.

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
| `quick` | 6 | 40 000 | 300 000 | 8 000 |
| `normal` (default) | 12 | 80 000 | 600 000 | 12 000 |
| `deep` | 24 | 200 000 | 1 200 000 | 16 000 |

Any individual cap is overridable (`--max-steps`, `--max-tool-bytes`, `--timeout-ms`).

**These numbers were re-sized from measurement in Phase 6** (2026-08-28), replacing this
document's original guesses. The distributions behind them — 266 real code files and 187
markdown files across two repositories, charged the way `ToolOutputBudget` charges them — are in
`docs/dogfood-log.md`; the derivation is commented in `src/budget.ts`. Three things the
measurement changed:

- **A default `read_file` page is 3-7 KB at the median, not 17 KB.** The 17.3 KB figure this
  re-sizing was queued under was one file (`src/tools/grep.ts`, this repo's largest); across
  real files it is the *p90*, and 81-91 % of reads come in under 16 KB. So "`quick` cannot
  afford a single read" was wrong — `quick`'s real defect was that its 16 000 cap **equalled**
  `TOOL_CALL_RESERVATION_BYTES`, which meant `admit` let exactly one call through and marked the
  run exhausted the moment a model issued a parallel pair. Concurrency was off for that preset
  by arithmetic accident.
- **Caps are sized against observed runs, not single calls.** The largest observed useful run
  cost 33 KB over 6 steps; at the old `normal` cap of 40 KB that same question exhausted at
  34.9 KB and wrote *no answer at all*. `normal` is now 2.4x that run, `quick` is one grep plus
  two p90 reads, `deep` is 2.5x `normal`.
- **Timeouts are `maxSteps × 40 s + 90 s`** — per-step and cold-load figures both observed on
  the reference machine. The old `normal` 180 s was *less* than an observed healthy 3.5-minute
  run, which is why `script/smoke.ts` had to pass `--timeout-ms` at all. A timeout is a backstop
  against a hang, not a cost control: steps and bytes are the cost control, and a timeout that
  fires discards every step the run completed (§15).

`TOOL_CALL_RESERVATION_BYTES` was re-tuned in the same pass and **deliberately left at 16 000**.
Lowering it does not simply buy parallelism: worst-case overshoot is (calls admitted) × (a
call's real size), so a smaller reservation admits more oversized calls through the same window.
Against the largest observed read (32 KB), 16 000 holds the worst case to 2.0-2.4x a cap where
12 000 gives 2.7-3.2x — for one extra concurrent call under `quick`. With the re-sized caps the
same constant admits 3 / 5 / 13 concurrent calls under `quick` / `normal` / `deep`, against
1 / 3 / 8 before.

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
  **The byte cap is really a context budget**, because every tool result stays in the
  conversation for the rest of the run. At roughly 3.6 bytes per token for line-numbered code,
  the re-sized caps imply ≈ 11 k tokens of tool output for `quick`, ≈ 22 k for `normal` and
  ≈ 55 k for `deep`, before the system prompt, the question and the model's own text. So `quick`
  and `normal` both fit the README's 32 k floor, and **`deep` needs ≥ 64 k** — worth saying
  where `--budget deep` is documented, since a model that runs out of context mid-loop fails in
  a much less legible way than one that hits a cap.
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
  usage, stepsUsed, toolCalls:{read_file,list_dir,grep}, exhausted, timedOut, wallMs,
  toolOutputBytes, toolCallErrors}`. The last two postdate this list (Phase 4 and Phase 5
  additions respectively — see `output.ts`'s `formatAnswerJson`) but ship in every run's JSON.
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
  (hermetic, runs in any checkout). **Not wired into CI**: no GitHub-hosted runner can reach the
  reference machine's LM Studio, so a job gated on a `SCOUTLING_EVAL_BASE_URL` secret would be
  permanently skipped — dead weight rather than a check. `docs/eval.md` records the reasoning.
- The 9 real questions (5 surveys, 4 doc-vs-code audits) live in the `local-ai` repo as
  `docs/scoutling-eval.json` — they reference that private repo's paths. Run with
  `pnpm eval --questions ../local-ai/docs/scoutling-eval.json --repo ../local-ai --models <ids>`.

  **The four audits are not the ones this section originally named** (written 2026-08-28, after
  checking every one). Three of them — "13 signal categories" vs 22 types, `EDGAR_PHRASES` 13 vs
  18, "every strategy excludes financials" vs 3/23 — were fixed in `local-ai` on 2026-08-24 by
  commit `91f4d2f`, so doc and code now agree and there is no stale fact to surface. The fourth,
  "139 tickers" vs 145, survives only in `.claude/skills/signals-research/SKILL.md`, which
  scoutling's `grep` **cannot reach**: ripgrep skips hidden directories unless `--hidden` is
  passed, so a claim under `.claude/` is undiscoverable even though `list_dir` lists it and
  `read_file` reads it (see §15). The replacements — a scheduler comment claiming 7 strategies
  against `BOOK_STRATEGIES`'s 22, a backtest runner header wrong on both strategy count (23) and
  as-of dates (14), "the 23 layers" against a `LAYERS` that de-duplicates to 25, and a Form 4
  comment claiming 118 tickers against a derived 139 — were each counted by hand, and sit in four
  different files across three directories so one future edit cannot invalidate the set.

  The lesson generalises: **an audit question is only as durable as the staleness it targets**.
  Re-verify the facts before trusting a grade, and treat a question set as perishable.

**Grading, scoped honestly:** the 4 questions with known facts carry an `expect.mustMatch` list
of regexes, and the harness reports a mechanical `auto` verdict from them. That verdict is a
**proxy, never the grade**: the summary's `correct?` column is left empty on *every* row,
auto-graded ones included, and is the human's. A regex can match a copy-pasted code fragment as
easily as an understood claim. Each matcher is checked when written against both a plausible
correct answer and a plausible *wrong* one, so it discriminates rather than merely matching — a
bare `-e` or a bare `139` passes almost anything. The other 5 are graded manually against what
Petr recalls from the original Sonnet runs — softer, and stated as such. This eval answers *"which local model should the README
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
6. **Run the reference eval** across the 4 models, grade, pick the recommended model, record
   results in `docs/eval.md` + README.
   ~~**Do the preset re-sizing first, before grading anything.**~~ — **DONE 2026-08-28**, ahead
   of the eval rather than after it, so no cell is graded against a preset that was a guess.
   §7 carries the new table and the derivation; `docs/dogfood-log.md` carries the raw
   distributions. Two of the premises this item was written under turned out to be wrong, and
   the corrections are the useful part:
   - The **17.3 KB** default read was one file, this repo's largest. Measured across 266 real
     code files it is the p90; the median is 3-7 KB, and 81-91 % of reads fit inside the old
     16 KB `quick` cap. "`quick` cannot afford a single default read" was false.
   - What `quick` actually could not do was run **two tool calls in one step**: its cap equalled
     `TOOL_CALL_RESERVATION_BYTES` exactly, so the second concurrent call was refused and the
     run was marked exhausted. Re-sizing the caps fixed that; the reservation itself was
     **left at 16 000**, because lowering it admits more oversized calls through the same window
     and makes worst-case overshoot worse (2.7-3.2x a cap at 12 000, against 2.0-2.4x at
     16 000). Parallelism is now 3 / 5 / 13 calls under `quick` / `normal` / `deep`.
   `test/budget.test.ts` pins both ends of that trade, so the next tuner has to state a new
   parallelism out loud rather than drift into one. **What remains in this item is the eval run
   and the grading**, plus a second re-tune once the eval produces `stepsUsed`/bytes across four
   models and a scope larger than this repo.
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

> **Deferred from Phase 4** (found by running the tool; triaged 2026-08-28 as "later"):
>
> - **A timeout throws away every step the run completed.** `generateText` rejects on abort, so a
>   run that dies at the wall-clock cap loses all of its tool calls and returns nothing — the
>   worst possible outcome for the slowest possible run. It is also why `timedOut` in the
>   `--format json` object (§9) is a permanently-`false` dead field. Accumulating steps through
>   `onStepFinish` and synthesising "here is what I found before I ran out of time" would make
>   the field real and turn a total loss into a partial answer. Wants a decision about whether
>   that exits 4 (an error, as today) or 1 (answered-but-degraded, like budget exhaustion).
> - **The citation extractor still admits a `word:digits` token** — "Figure 2:5", "Step 3:1".
>   Requiring a line number (§8) removed every false positive observed so far, but not this
>   class. Low frequency and low harm (it lands as one unverifiable source), so it is worth
>   revisiting against Phase 5's question set rather than guessing at a fix now.

> **Deferred from Phase 6's preset re-sizing** (found by measuring; triaged 2026-08-28 as
> "after Phase 5"):
>
> - **`grep`'s `contextLines` can cost more than the whole-file read it replaces.** The Phase 4
>   follow-up justified it on a *selective* pattern: 1.9 KB of `grep` plus a 17.7 KB `read_file`,
>   replaced by ~540 bytes. Measured across broad patterns it inverts — `contextLines: 3` runs
>   23-33 KB at the median and up to 60 KB, against 8-10 KB for the same pattern at
>   `contextLines: 0`, i.e. more than a p90 whole-file read, and 50-75 % of such calls exceed a
>   whole `TOOL_CALL_RESERVATION_BYTES` on their own (`docs/dogfood-log.md`). The saving is real
>   but conditional on pattern selectivity, and neither the tool description nor the system
>   prompt says so. Two candidate fixes — a line of advice in the tool description, or a
>   structural cap that refuses/downgrades `contextLines` when the match count would make the
>   context blocks dominate. Deliberately **not** fixed before the eval: whether models actually
>   reach for `contextLines` with broad patterns is a behavioural question Phase 6 measures
>   directly, and changing the prompt first would mean tuning against a guess and moving the
>   baseline the eval is supposed to establish.

> **Found while building the Phase 5 question set** (2026-08-28, verified against the installed
> ripgrep 15.0.0), **fixed 2026-08-28** (same day — the decision below is what shipped):
>
> - **`grep` and `list_dir` disagreed about hidden files, which is the exact divergence
>   `--no-require-git` exists to prevent.** ripgrep skipped dot-directories unless `--hidden` was
>   passed, and `grep.ts` didn't pass it; `scope-walk.ts` (behind `list_dir`) applied
>   `.gitignore` but had no hidden-file rule of its own. So in a scope containing a
>   non-gitignored `.claude/`, `list_dir` listed `.claude/skills/…/SKILL.md`, `read_file` read it
>   in full, and `grep` couldn't find a single string inside it. Reproduced against `local-ai`: the
>   phrase `139 tickers` exists only in that file, and `rg --no-require-git` returned nothing while
>   `rg --no-require-git --hidden` returned the line. It cost a real eval question, which is how it
>   was found — a doc under `.claude/` is undiscoverable to a run that has not been told its path.
>   Separately, `read_file` ignored `excludeGlobs`, `.gitignore` and `.git/` entirely — it would
>   read `.git/HEAD` or a gitignored secret file that `list_dir` would never surface. One defect,
>   two symptoms: the three tools each carried their own idea of "what's visible."
>
>   **The decision taken: widen `grep`, not narrow `list_dir`/`read_file`.** `.github/`,
>   `.claude/`, `.circleci/`, `.vscode/` are legitimate investigation targets — "how does CI work
>   here?" is a first-rank question for this tool — and narrowing the walk instead would have made
>   `read_file` start refusing `.github/workflows/ci.yml`, a real regression. `grep.ts` now passes
>   `--hidden` unconditionally. That widens what `--hidden` reaches to include `.git/`, so
>   `scope-walk.ts` exports `ALWAYS_EXCLUDED_GLOBS = ['.git/**']` — applied on **both** grep
>   backends (the `--glob '!...'` list and the JS fallback's `walkScope` call) regardless of what
>   `excludeGlobs` the caller passed, since config layers *replace* `excludeGlobs` rather than
>   merging it, and a user narrowing that list must not silently re-expose the object store.
>   Verified both glob forms actually stop ripgrep descending into `.git`: `rg --hidden --glob
>   '!.git/**' -e ... .` and `rg --hidden --glob '!.git/' -e ... .` both exclude `.git/HEAD` and
>   `.git/objects/*` from a scratch fixture — `/**` was kept, to match the one spelling of
>   "exclude .git" `list_dir`/`read_file` already used. `read_file` gained an `excludeGlobs` option
>   (wired through `tools/index.ts`, matching `list_dir`/`grep`) and now refuses an invisible path
>   with `PATH_EXCLUDED` before even checking existence, naming which rule fired (`.git/`,
>   `excludeGlobs`, or `.gitignore`) so a small model stops retrying instead of guessing.
>
>   The invariant — all three tools agree on one visibility rule — now lives once, in
>   `scope-walk.ts`'s `isPathVisible`/`explainPathExclusion` (§6), which `walkScope` itself is
>   refactored to call through (`isExcludedByGlobs`) rather than keeping a second copy of the
>   glob/gitignore logic. `test/tool-visibility.test.ts` builds the fixture above twice — a real
>   `git init` checkout and a plain directory that merely contains a `.git`-named subdirectory —
>   and asserts the three tools' verdicts agree with each other on every target, not just each
>   individually against the expected answer; `test/grep.test.ts` separately pins that the ripgrep
>   and JS-fallback engines return the same file set for the same hidden-file fixture, asserting
>   `engine` on each side so the test can't pass by accident if one path silently didn't run.
>
> **Addendum, 2026-08-28 (same day — a follow-up correction to the fix above):** the fix above
> only guarded what a *traversal* under an excluded path would surface. It never checked the
> `path` argument itself — model-supplied for both `grep` and `list_dir` — before using it, so a
> model that named an excluded path directly bypassed exclusion entirely:
>
> ```
> grep(pattern, path='secret.env')        -> match returned, LEAKING gitignored content
> grep(pattern, path='.git/FAKE_SECRET')  -> match returned, LEAKING .git content
> list_dir(path='.git')                   -> {entries: []}  -- looks empty, but it's "you may not look here"
> ```
>
> For `grep` this is worse than an inconsistency: it's a genuine content leak, because ripgrep
> searches an explicitly-named file or directory regardless of `--glob` flags (already noted
> above — `--glob '!...'` only prunes traversal) — so no ripgrep flag can ever enforce this; it
> has to be caught in this codebase before either engine (ripgrep or the JS fallback) runs. For
> `list_dir`, returning `{entries: []}` for an excluded directory is a false definitive empty
> state (§9's AXI principle 5): "you may not look here" rendered indistinguishably from "this
> directory genuinely has nothing in it."
>
> **Fixed same day:** `grep.ts` and `list-dir.ts` now call `explainPathExclusion` on the resolved
> `path` immediately after `resolvePath` and before `existsSync` — mirroring `read_file`'s
> existing order, since visibility is a property of the path, not of whether it currently exists
> — and refuse `PATH_EXCLUDED` before either tool does anything else. The refusal-message wording
> (`describeExclusionReason`) was lifted out of `read-file.ts` into `scope-walk.ts` itself and is
> now shared by all three tools, rather than `grep`/`list_dir` growing their own copies of the
> same switch statement. `path='.'` (the default, "search/list everything from the scope root")
> is unaffected — `explainPathExclusion` already short-circuits on the scope root itself. Verified
> against the exact leak fixture above (now closed) and pinned by a second table in
> `test/tool-visibility.test.ts` — same fixture and `git`/non-`git` variants as the fix above, but
> asking each tool about an excluded path directly instead of only checking what its own traversal
> found — plus a focused regression in `test/grep.test.ts` that pins the refusal *shape* (`error:
> 'PATH_EXCLUDED'` and `matches` absent, not merely "no error") across both the ripgrep and
> fallback engines.

> **Found while configuring the Phase 6 eval** (2026-08-28, untriaged):
>
> - **`excludeGlobs` config layers *replace* the built-in list rather than merging with it**, so
>   setting it at all silently drops `node_modules/**`, `dist/**` and `out/**`. Concretely: adding
>   one vendored-docs glob to a repo's `scoutling.config.json` requires re-listing all four
>   built-in entries or the run starts walking `node_modules`. Both configs written for the Phase 6
>   eval had to do exactly that, which is the smell. `.git/**` is no longer affected — it is
>   enforced structurally by `ALWAYS_EXCLUDED_GLOBS` regardless of config — but the other three are
>   ordinary defaults with nothing protecting them.
>   Per-key replacement is the deliberate rule for every other config key (§5) and is right for
>   scalars, so the question is whether `excludeGlobs` should be the one list-valued key that
>   appends instead, or whether the fix is `doctor` warning when a config's `excludeGlobs` omits a
>   built-in entry. The second keeps one layering rule and makes the surprise visible exactly where
>   the user is already asking "why is it behaving like this?", which is what `doctor` is for. Not
>   urgent — the failure mode is a slow, noisy run rather than a wrong answer — but it will bite
>   whoever writes the first real per-repo config without reading this.

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
