import { generateText, isStepCount, type LanguageModel } from 'ai'

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
   * Default is 8, matching DESIGN.md §7's `normal` budget preset. Phase 4
   * makes the whole budget (`quick`/`normal`/`deep`) selectable via
   * `--budget`; until then this is the one knob (`--max-steps`).
   */
  maxSteps?: number
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
  /** True when the run hit maxSteps while the model still wanted to call tools. */
  exhausted: boolean
  usage: {
    inputTokens: number | undefined
    outputTokens: number | undefined
  }
  wallMs: number
}

/** Matches DESIGN.md §7's `normal` budget preset — the default until `--budget` exists (Phase 4). */
const DEFAULT_MAX_STEPS = 8

/** JSON-serialized byte size of a tool's output, for the per-step byte count. */
function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
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
 * Run one investigation: a bounded `generateText` tool loop with the three
 * read-only tools (`read_file`, `list_dir`, `grep`). Takes an
 * already-constructed model so the same function serves both the CLI (a
 * real provider) and tests (`MockLanguageModelV4`) — this file never
 * constructs a provider itself.
 */
export async function runScoutling(options: RunOptions): Promise<RunResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const tools = createTools({ scopeRoot: options.scopeRoot, excludeGlobs: options.excludeGlobs })

  const startedAt = Date.now()

  const result = await generateText({
    model: options.model,
    tools,
    stopWhen: isStepCount(maxSteps),
    ...(options.systemPrompt !== undefined ? { system: options.systemPrompt } : {}),
    prompt: options.question,
    temperature: options.temperature,
    onStepFinish: (step) => {
      if (!options.onStep) return

      const toolCalls = step.content
        .filter((part) => part.type === 'tool-call')
        .map((part) => ({ name: part.toolName, args: part.input }))

      const bytes = step.content
        .filter((part) => part.type === 'tool-result')
        .reduce((sum, part) => sum + byteSize(part.output), 0)

      options.onStep({ index: step.stepNumber, toolCalls, bytes })
    },
  })

  const wallMs = Date.now() - startedAt

  const toolCalls = countToolCalls(result.toolCalls)

  // The loop stops for one of two reasons: the model naturally finished
  // (finishReason 'stop'), or isStepCount(maxSteps) cut it off mid-loop
  // while it still wanted to call tools (finishReason 'tool-calls'). Only
  // the latter is an exhausted run — the former would have stopped there
  // regardless of the cap.
  //
  // Note: at the provider-protocol level (MockLanguageModelV4.doGenerate)
  // finishReason is `{unified, raw}`, but by the time it surfaces on
  // StepResult/GenerateTextResult the SDK has already unwrapped it to the
  // plain `FinishReason` string — there is no `.unified` here.
  const exhausted = result.finishReason === 'tool-calls'

  return {
    answer: result.text,
    stepsUsed: result.steps.length,
    toolCalls,
    exhausted,
    usage: {
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
    },
    wallMs,
  }
}
