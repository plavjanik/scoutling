import { generateText, isStepCount, type LanguageModel, type StepResult } from 'ai'

import { type Budget, ToolOutputBudget, resolveBudget, withToolOutputBudget } from './budget.js'
import { type CitationReport, verifyCitations } from './citations.js'
import { ScoutlingError } from './errors.js'
import { createTools } from './tools/index.js'

/** One step's summary, for `--verbose` step logging on stderr. */
export interface StepSummary {
  /** Zero-based step index within the run. */
  index: number
  toolCalls: Array<{ name: string; args: unknown }>
  /** Total bytes of tool results produced during this step. */
  bytes: number
}

export interface RunOptions {
  question: string
  /** Already resolved (`resolveScopeRoot`) — loop.ts trusts it, never re-resolves it. */
  scopeRoot: string
  /** Constructed by the caller (CLI: real provider; tests: a mock) — loop.ts never builds one. */
  model: LanguageModel
  /**
   * Shallow-merged onto `BUDGET_PRESETS.normal` via `resolveBudget` — the
   * whole DESIGN.md §7 budget (`quick`/`normal`/`deep`, each cap
   * individually overridable), replacing the old `maxSteps`-only knob.
   */
  budget?: Partial<Budget>
  temperature?: number
  systemPrompt?: string
  /** Passed through to `createTools`; config's excludeGlobs, never the model's. */
  excludeGlobs?: string[]
  onStep?: (step: StepSummary) => void
}

export interface RunResult {
  answer: string
  stepsUsed: number
  toolCalls: { read_file: number; list_dir: number; grep: number }
  /**
   * True when the run was cut off by any cap: the step count (the model
   * still wanted to call tools), the tool-output byte budget, or (Phase 6
   * follow-up) the wall-clock timeout after at least one step completed.
   * Equivalent to `exhaustedBy.length > 0` — kept as its own field because
   * it is the one most callers actually branch on.
   */
  exhausted: boolean
  /**
   * Which cap(s) cut the run short, in no particular order; empty when it
   * finished on its own terms. `exhausted` stays the boolean summary
   * (`exhaustedBy.length > 0`). Both can fire on one run -- Phase 6 measured
   * a question that exhausted on bytes twice and on steps once -- so this is
   * a list, not an enum: reporting only the first would make the §7 presets
   * untunable, which is the reason it exists.
   */
  exhaustedBy: Array<'steps' | 'bytes' | 'timeout'>
  /**
   * True only on the salvaged-timeout path: the wall-clock budget fired
   * after at least one step had already completed, so `runScoutling`
   * returns a normal `RunResult` (built from the steps that finished)
   * instead of throwing. A timeout with zero completed steps still throws
   * `ScoutlingError('TIMEOUT')` and never produces a `RunResult` at all, so
   * this field is `false` on every value that exists.
   */
  timedOut: boolean
  usage: {
    inputTokens: number | undefined
    outputTokens: number | undefined
  }
  wallMs: number
  /** Cumulative bytes charged by `ToolOutputBudget` — Phase 6 tunes the budget presets from these numbers. */
  toolOutputBytes: number
  /**
   * Tool calls the SDK rejected before dispatch — an unknown tool name, or
   * arguments that failed the schema. DESIGN.md §12 records this per run:
   * tool-call parse failure is the failure mode that separates small models.
   */
  toolCallErrors: number
  /**
   * DESIGN.md §8's cited-answer contract, checked here rather than by every
   * caller: it is a filesystem check against `options.scopeRoot` with no
   * model call, so it belongs to the run's own report, computed exactly
   * once, right after the loop that produced the text it checks.
   */
  citations: CitationReport
}

/** Tallies each tool call by name, generically rather than one hand-written filter per tool. */
function countToolCalls(
  calls: Array<{ toolName: string }>,
): RunResult['toolCalls'] {
  const counts: RunResult['toolCalls'] = { read_file: 0, list_dir: 0, grep: 0 }
  for (const call of calls) {
    if (call.toolName in counts) {
      counts[call.toolName as keyof RunResult['toolCalls']] += 1
    }
  }
  return counts
}

/**
 * Count `tool-error` content parts across every step — the shape
 * `no-write.test.ts` proves the SDK produces for an unrecognized tool name or
 * a call whose arguments fail the tool's schema, caught in `parseToolCall()`
 * before dispatch (AI SDK v7). This is *not* the same as a tool's own
 * `{error, message, hint?}` refusal object, which is a normal `tool-result`
 * the model asked for and got — a `tool-error` part means the SDK itself
 * rejected the call before any tool code ran at all.
 */
function countToolCallErrors(steps: Array<{ content: Array<{ type: string }> }>): number {
  let count = 0
  for (const step of steps) {
    for (const part of step.content) {
      if (part.type === 'tool-error') count += 1
    }
  }
  return count
}

/**
 * True only when `error` really came from `signal` firing, not merely "some
 * unrelated error happened while a signal that later aborted existed".
 *
 * Verified empirically against the installed ai@7.0.83 (no automated abort
 * handling inside `MockLanguageModelV4` — the mock's own `doGenerate` has to
 * react to `options.abortSignal` itself, exactly as a real provider's
 * `fetch` call would): when `generateText`'s `abortSignal` fires, whatever
 * rejects the in-flight call surfaces to the caller as-is, which in
 * practice is an `Error`/`DOMException` named `AbortError` or `TimeoutError`
 * depending on the runtime and how the signal was constructed
 * (`AbortSignal.timeout()`'s own `.reason` is a `TimeoutError` DOMException
 * per spec; a plain `fetch` abort is usually `AbortError`). This mirrors
 * `@ai-sdk/provider-utils`'s own `isAbortError` check, which is not
 * re-exported from the top-level `ai` package, so it is reimplemented here
 * rather than adding a new direct dependency for one predicate.
 */
function isTimeoutAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'ResponseAborted')
  )
}

/**
 * Sum a field across every completed step's usage, treating `undefined` as
 * "no data" the way the rest of the codebase does: an individual step's
 * `undefined` contributes 0 to the sum, but the overall result is
 * `undefined` only when *no* step reported a defined value — a sum of
 * "no data" entries is still "no data", not 0.
 */
function sumUsageField(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined)
  if (defined.length === 0) return undefined
  return defined.reduce((total, value) => total + value, 0)
}

/**
 * Run one investigation: a bounded `generateText` tool loop with the three
 * read-only tools (`read_file`, `list_dir`, `grep`). Takes an
 * already-constructed model so the same function serves both the CLI (a
 * real provider) and tests (`MockLanguageModelV4`) — this file never
 * constructs a provider itself.
 */
export async function runScoutling(options: RunOptions): Promise<RunResult> {
  const budget = resolveBudget('normal', options.budget)
  const toolOutputBudget = new ToolOutputBudget(budget.maxToolOutputBytes)
  const tools = withToolOutputBudget(
    createTools({ scopeRoot: options.scopeRoot, excludeGlobs: options.excludeGlobs }),
    toolOutputBudget,
  )

  const startedAt = Date.now()

  // Wraps the whole run, including JIT model load — DESIGN.md §7: LM Studio
  // cold-loading a large model can take 60s+ before the first token, so the
  // timeout has to cover that, not just steady-state generation.
  const abortSignal = AbortSignal.timeout(budget.timeoutMs)

  // Bytes already charged when the previous step ended, so each step can
  // report its own delta. Reusing the budget's own accounting rather than
  // re-measuring here is what keeps the `--verbose` log and
  // `--max-tool-bytes` speaking about the same number: both count the tool
  // output as the model receives it (TOON for list_dir/grep), where a
  // JSON.stringify of the structured result would overstate it by ~40 %.
  let bytesAtPreviousStep = 0

  // Every step's `StepResult` as it finishes — the same object
  // `onStepFinish` already receives below, just also kept around. This is
  // what lets a timeout salvage a partial answer (Change 2, DESIGN.md §15):
  // `generateText` rejects the whole promise on abort, discarding its own
  // return value, so anything worth keeping has to be captured as it goes
  // rather than read off the (never-produced) final result.
  const completedSteps: StepResult<typeof tools>[] = []

  /**
   * Build a `RunResult` from whatever steps completed before the wall-clock
   * timeout fired. Only called when `completedSteps.length > 0` — a
   * zero-step timeout still throws `ScoutlingError('TIMEOUT')` exactly as
   * before, since there is nothing here to salvage.
   */
  function buildTimeoutResult(): RunResult {
    const toolCalls = countToolCalls(completedSteps.flatMap((step) => step.toolCalls))

    // The most recent step with something to say — an earlier step's text
    // is stale once a later step ran more tool calls off of it, and a step
    // that only called tools contributes an empty `text`.
    let answer = ''
    for (let i = completedSteps.length - 1; i >= 0; i--) {
      const text = completedSteps[i]?.text ?? ''
      if (text.trim().length > 0) {
        answer = text
        break
      }
    }

    const citations = verifyCitations(options.scopeRoot, answer)

    const exhaustedBy: RunResult['exhaustedBy'] = ['timeout']
    if (toolOutputBudget.exhausted) exhaustedBy.push('bytes')

    return {
      answer,
      stepsUsed: completedSteps.length,
      toolCalls,
      exhausted: true,
      exhaustedBy,
      timedOut: true,
      usage: {
        inputTokens: sumUsageField(completedSteps.map((step) => step.usage.inputTokens)),
        outputTokens: sumUsageField(completedSteps.map((step) => step.usage.outputTokens)),
      },
      wallMs: Date.now() - startedAt,
      toolOutputBytes: toolOutputBudget.spent,
      toolCallErrors: countToolCallErrors(completedSteps),
      citations,
    }
  }

  // Declared with no annotation so TypeScript infers it from the assignment
  // below, keeping the tool-typed result rather than the SDK's placeholder.
  let result
  try {
    result = await generateText({
      model: options.model,
      tools,
      stopWhen: isStepCount(budget.maxSteps),
      ...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
      prompt: options.question,
      temperature: options.temperature,
      maxOutputTokens: budget.maxOutputTokens,
      abortSignal,
      onStepFinish: (step) => {
        completedSteps.push(step)

        const bytes = toolOutputBudget.spent - bytesAtPreviousStep
        bytesAtPreviousStep = toolOutputBudget.spent

        if (!options.onStep) return

        const toolCalls = step.content
          .filter((part) => part.type === 'tool-call')
          .map((part) => ({ name: part.toolName, args: part.input }))

        options.onStep({ index: step.stepNumber, toolCalls, bytes })
      },
    })
  } catch (error) {
    if (isTimeoutAbort(error, abortSignal)) {
      // A timeout that still has completed steps to show for itself is
      // salvageable — "here is partial evidence" and "the provider never
      // answered" are different things to tell a caller, so only the latter
      // (zero completed steps) keeps throwing.
      if (completedSteps.length > 0) return buildTimeoutResult()

      throw new ScoutlingError(
        'TIMEOUT',
        `The run did not finish within ${budget.timeoutMs}ms.`,
        'LM Studio cold-loading a large model can take 60s+ before the first token; raise --timeout-ms or warm the model first.',
      )
    }
    throw error
  }

  const wallMs = Date.now() - startedAt

  const toolCalls = countToolCalls(result.toolCalls)

  // A run is exhausted for either or both of two independent reasons — both
  // are recorded in `exhaustedBy` (Phase 6 measured a run that hit both: a
  // question exhausted on bytes twice and on steps once across different
  // paths through the same budget):
  //
  //  - the step cap cut it off mid-loop while the model still wanted to
  //    call tools (finishReason 'tool-calls'). A model that simply finished
  //    would report 'stop' and would have stopped there regardless of the
  //    cap, so that is not exhaustion.
  //  - the cumulative tool-output byte budget ran out. This one does *not*
  //    show up in finishReason at all: the model gets a BUDGET_EXHAUSTED
  //    refusal, synthesizes an answer from what it already had, and reports
  //    a perfectly normal 'stop'. It answered on partial evidence, which is
  //    exactly what the caller needs told.
  //
  // Note: at the provider-protocol level (MockLanguageModelV4.doGenerate)
  // finishReason is `{unified, raw}`, but by the time it surfaces on
  // StepResult/GenerateTextResult the SDK has already unwrapped it to the
  // plain `FinishReason` string — there is no `.unified` here.
  const exhaustedBy: RunResult['exhaustedBy'] = []
  if (result.finishReason === 'tool-calls') exhaustedBy.push('steps')
  if (toolOutputBudget.exhausted) exhaustedBy.push('bytes')

  const citations = verifyCitations(options.scopeRoot, result.text)

  return {
    answer: result.text,
    stepsUsed: result.steps.length,
    toolCalls,
    exhausted: exhaustedBy.length > 0,
    exhaustedBy,
    timedOut: false,
    usage: {
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
    },
    wallMs,
    toolOutputBytes: toolOutputBudget.spent,
    toolCallErrors: countToolCallErrors(result.steps),
    citations,
  }
}
