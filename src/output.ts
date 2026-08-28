import type { RunResult } from './loop.js'

/** The two shapes a run's answer can be printed in — DESIGN.md §9. */
export type OutputFormat = 'text' | 'json'

export function isOutputFormat(value: unknown): value is OutputFormat {
  return value === 'text' || value === 'json'
}

/**
 * DESIGN.md §8: text mode is the answer's prose, then the one-line citation
 * summary on its own line — `result.citations.summaryLine` already reads
 * "Sources: N verified, ...", so this just stacks it under the answer rather
 * than re-deriving it from `result.citations.sources`.
 */
export function formatAnswerText(result: RunResult): string {
  return `${answerOrEmptyState(result)}\n${result.citations.summaryLine}`
}

/**
 * A run can finish with no text at all: the model spends every step calling
 * tools and the step cap cuts it off before it ever writes a word. Printing
 * `result.answer` verbatim then emits a blank line, which reads as "it
 * worked and had nothing to say" rather than "it ran out of room" — the
 * definitive-empty-state rule (AXI principle 5) exists for exactly this.
 *
 * Only text mode needs it. `--format json` keeps `answer: ""`, which a
 * parent agent can test for directly and which `exhausted` already explains.
 */
function answerOrEmptyState(result: RunResult): string {
  if (result.answer.trim().length > 0) return result.answer

  return result.exhausted
    ? '(no answer: the run hit a step or tool-output budget before the model wrote one)'
    : '(no answer: the model returned no text)'
}

/**
 * DESIGN.md §9's documented JSON object, verbatim key set plus
 * `toolOutputBytes` (a Phase 4 addition the design doc's list predates —
 * Phase 6 tunes the budget presets from it, so it stays).
 *
 * Pretty-printed with a trailing newline: a parent agent's `jq` handles
 * either, but a human staring at raw CLI output during debugging does not.
 */
export function formatAnswerJson(result: RunResult, model: string): string {
  const output = {
    answer: result.answer,
    sources: result.citations.sources,
    model,
    usage: result.usage,
    stepsUsed: result.stepsUsed,
    toolCalls: result.toolCalls,
    exhausted: result.exhausted,
    // Always false today: a timeout is an error path (ScoutlingError, exit 4)
    // that throws out of runScoutling before a RunResult ever exists, so this
    // branch can never observe `true`. The key stays in the shape anyway —
    // DESIGN.md §9 documents it, and a parent agent's JSON parsing should not
    // have to special-case its absence pending whatever later slice (if any)
    // makes a timeout produce a partial answer instead of an error.
    timedOut: false,
    wallMs: result.wallMs,
    toolOutputBytes: result.toolOutputBytes,
  }
  return `${JSON.stringify(output, null, 2)}\n`
}
