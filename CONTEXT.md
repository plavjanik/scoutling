# Scoutling

Scoutling is a read-only investigator that a coding agent sends ahead into a codebase with one
question, and that comes back with a cited answer without changing anything. This context covers
the vocabulary of delegating, bounding and trusting such an investigation.

## Language

### Delegation

**Parent agent**:
The coding agent (or person) that delegates a question to scoutling and consumes its answer.
_Avoid_: host, caller, orchestrator, client

**Question**:
The single investigation request a parent agent delegates. One question per run.
_Avoid_: prompt, task, query, ask

**Run**:
One complete investigation, from receiving a question to returning an answer, bounded by a budget.
_Avoid_: session, job, invocation, scout

**Integration**:
The host-specific glue (a skill, a rule file, a command definition) that teaches a particular
parent agent when and how to delegate to scoutling.
_Avoid_: adapter, plugin, wrapper, hook

### Investigation

**Scope**:
The directory tree a run is allowed to see. Nothing outside the scope exists as far as the run is
concerned.
_Avoid_: workspace, project, sandbox, root, path

**Read-only**:
The property that a run has no capability to change the scope or anything else — not a rule the
model is asked to follow, but an absence of means.
_Avoid_: safe mode, dry run, no-write mode

**Tool**:
One of the read-only capabilities the model may invoke during a run: reading a file, listing a
directory, searching for a pattern.
_Avoid_: function, action, command, skill

**Step**:
One model response within a run — either a tool call or the answer. A run is a sequence of steps.
_Avoid_: turn, iteration, round, hop

**Project context**:
Prose from the scope, written for an AI reader, that is given to the model before the question so
its answer follows the project's own conventions.
_Avoid_: instructions, rules, memory, system context

### Bounding

**Budget**:
The set of caps a run may not exceed: steps, bytes of tool results, output tokens and wall time.
Every run has exactly one budget.
_Avoid_: limit, quota, cap (for the whole set), timeout (that is one component)

**Preset**:
A named budget — `quick`, `normal` or `deep` — so a parent agent chooses effort with one word.
_Avoid_: mode, level, profile, tier

**Exhausted run**:
A run that hit a budget cap before the model was confident. It still returns an answer, marked as
such. Distinct from a timed-out run, which returns no answer.
_Avoid_: failed run, truncated run, partial

### Trust

**Answer**:
The prose a run returns to the parent agent.
_Avoid_: response, output, report, result

**Citation**:
A `path:line` reference inside the answer pointing at evidence in the scope. Every factual claim
in an answer is expected to carry one.
_Avoid_: reference, link, pointer

**Source**:
A citation after it has been checked against the scope. A source is either **verified** (the
file and line exist) or **unverifiable** (they do not). Sources are what a parent agent uses to
decide what to read next.
_Avoid_: evidence, footnote, verified citation

### Configuration

**Provider**:
The OpenAI-compatible endpoint that serves the model a run uses. Scoutling has no opinion about
what is behind it.
_Avoid_: backend, gateway, server, engine, inference server

**Config layer**:
One of the ordered places a setting can come from — flag, environment, local override, shared
config, user config, built-in — where each layer overrides the ones below it.
_Avoid_: profile, settings source, tier

**Local override**:
The per-developer, never-committed config layer that pins the provider and model that fit one
person's machine.
_Avoid_: personal config, dev config, machine config

**Shared config**:
The committed config layer holding a repository's team-wide defaults.
_Avoid_: project config, repo config, team settings

### Evaluation

**Question set**:
A fixed list of questions, with a scope each, used to compare models or versions.
_Avoid_: benchmark, test suite, golden set

**Known fact**:
A concrete, independently established fact that a question's answer must surface to be graded
correct.
_Avoid_: expected answer, golden answer, ground truth, oracle

**Cell**:
One (question, model) pair in an eval; a cell is run several times because runs vary.
_Avoid_: case, trial, sample
