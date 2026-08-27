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
scoutling "<question>" --model <id> [--path <dir>] [--base-url <url>] [--verbose]
```

The answer goes to stdout as plain text. Errors are one-line JSON on stderr with a code:
`BAD_ARGS` (2), `PROVIDER_UNREACHABLE` (3), `PATH_NOT_FOUND` (5), `INTERNAL` (10). Exit 1 means
it answered but ran out of budget — treat that answer as partial.

Omitting `--model` is safe: the error lists the models the endpoint actually serves.

### Examples

```bash
# Locate something, then read the cited lines yourself.
scoutling "Where is the scope-root containment check implemented?" --model qwen/qwen3-coder-next

# Investigate a different repository.
scoutling "What does this package export?" --path ../other-repo --model qwen/qwen3-coder-next

# Watch the step log while tuning a question.
scoutling "How is config precedence resolved?" --model qwen/qwen3-coder-next --verbose
```

## Getting a good answer out of it

- **Name the file when you know it.** The current tool set is `read_file` only — there is no
  search or directory listing yet, so an open "where is X?" makes the model guess paths.
- **Ask one question per run.** One question, one answer, one budget.
- **Ask for citations explicitly** if the answer will drive a change; the built-in prompt
  requires them, and saying so again makes small models comply more reliably.

## Reading the result

Citations are `path:line` relative to the scope root. **Verify before acting on them** — a small
local model can cite confidently and still be wrong about what the line says. The citation's job
is to tell you exactly which lines to read next, which is usually two or three instead of ten
files.
