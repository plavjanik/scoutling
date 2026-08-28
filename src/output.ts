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
    ? '(no answer: the run hit a step, tool-output, or timeout budget before the model wrote one)'
    : '(no answer: the model returned no text)'
}

/**
 * DESIGN.md §9's documented JSON object, verbatim key set plus
 * `toolOutputBytes` (a Phase 4 addition the design doc's list predates —
 * Phase 6 tunes the budget presets from it, so it stays) and
 * `toolCallErrors` (the same kind of Phase 5 addition, for the same reason:
 * DESIGN.md §12's eval harness reads it off every run to tell which models
 * can reliably emit a well-formed tool call).
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
    exhaustedBy: result.exhaustedBy,
    // True only when the wall-clock timeout fired after at least one step
    // had already completed: `runScoutling` salvages what it can instead of
    // throwing in that case (DESIGN.md §15), so a `RunResult` can now
    // genuinely carry `timedOut: true`. A zero-step timeout still throws
    // `ScoutlingError('TIMEOUT')` before a `RunResult` ever exists, so this
    // key is `false` on every value that reaches here from that path.
    timedOut: result.timedOut,
    wallMs: result.wallMs,
    toolOutputBytes: result.toolOutputBytes,
    toolCallErrors: result.toolCallErrors,
  }
  return `${JSON.stringify(output, null, 2)}\n`
}
