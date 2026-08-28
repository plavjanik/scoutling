import type { Tool } from 'ai'

import type { ToolSet } from './tools/index.js'
import type { BudgetPreset } from './types.js'

/** The whole budget a run may not exceed — DESIGN.md §7's one dial, several caps. */
export interface Budget {
  maxSteps: number
  maxToolOutputBytes: number
  timeoutMs: number
  maxOutputTokens: number
}

/** DESIGN.md §7's table, verbatim. `normal` is the default until a run says otherwise. */
export const BUDGET_PRESETS: Record<BudgetPreset, Budget> = {
  quick: { maxSteps: 4, maxToolOutputBytes: 16_000, timeoutMs: 90_000, maxOutputTokens: 4_000 },
  normal: { maxSteps: 8, maxToolOutputBytes: 40_000, timeoutMs: 180_000, maxOutputTokens: 10_000 },
  deep: { maxSteps: 15, maxToolOutputBytes: 120_000, timeoutMs: 420_000, maxOutputTokens: 16_000 },
}

export function isBudgetPreset(value: unknown): value is BudgetPreset {
  return value === 'quick' || value === 'normal' || value === 'deep'
}

/**
 * Shallow-merge overrides onto a preset. An override key that is present but
 * `undefined` is not a real override (mirrors `config.ts`'s "an absent key
 * is not an override" rule) — only a defined value replaces the preset's.
 */
export function resolveBudget(preset: BudgetPreset, overrides?: Partial<Budget>): Budget {
  const resolved = { ...BUDGET_PRESETS[preset] }
  if (overrides === undefined) return resolved

  for (const key of Object.keys(resolved) as Array<keyof Budget>) {
    const value = overrides[key]
    if (value !== undefined) resolved[key] = value
  }
  return resolved
}

/**
 * One refusal shape, matching the `{error, message, hint?}` convention every
 * tool already uses (read-file.ts, list-dir.ts, grep.ts) — a small model
 * learns one shape for "I can't give you that" regardless of the reason.
 * DESIGN.md §7 writes this outcome as a bare replacement string; the object
 * form is the deliberate deviation (see CLAUDE.md's note on `execute()`
 * throwing being lossy).
 */
const BUDGET_EXHAUSTED_REFUSAL = {
  error: 'BUDGET_EXHAUSTED',
  message: 'Tool-output budget exhausted — synthesize an answer from what you have already seen.',
  hint: 'Do not call more tools; state explicitly what you could not verify.',
} as const

/** Tracks cumulative tool-output bytes charged during one run against a fixed cap. */
export class ToolOutputBudget {
  private readonly limitBytes: number
  private spentBytes = 0

  constructor(limitBytes: number) {
    this.limitBytes = limitBytes
  }

  get spent(): number {
    return this.spentBytes
  }

  get exhausted(): boolean {
    return this.spentBytes >= this.limitBytes
  }

  charge(bytes: number): void {
    this.spentBytes += bytes
  }
}

/**
 * Bytes as the model actually receives them: run the tool's own
 * `toModelOutput` when it has one (list_dir/grep TOON-encode; text output is
 * measured directly, anything else by its JSON size) and fall back to the
 * raw JSON size of `output` for a tool with no `toModelOutput` (read_file).
 */
async function measureModelBytes(toolDef: Tool, toolCallId: string, input: unknown, output: unknown): Promise<number> {
  if (toolDef.toModelOutput) {
    const modelOutput = await toolDef.toModelOutput({ toolCallId, input, output })
    if (modelOutput.type === 'text') return Buffer.byteLength(modelOutput.value, 'utf8')
    // Every other ToolResultOutput variant ('json', 'error-text', 'content',
    // 'execution-denied', ...) either carries a `value` or is small and
    // rare enough that stringifying the whole object is a fine measure —
    // list_dir/grep only ever return 'text' (TOON) today.
    const measured = 'value' in modelOutput ? modelOutput.value : modelOutput
    return Buffer.byteLength(JSON.stringify(measured), 'utf8')
  }
  return Buffer.byteLength(typeof output === 'string' ? output : JSON.stringify(output), 'utf8')
}

/**
 * Wrap one tool's `execute` so every real call is charged to `budget`
 * afterwards, and no call runs at all once the budget is already exhausted.
 *
 * Deliberately charges *after* execution, using the call's own output size,
 * rather than refusing pre-emptively based on an estimate: the call that
 * happens to tip the budget over still ran and still returns its real
 * result in full — only the *next* call is refused. Punishing the call that
 * crossed the line would waste a real tool round trip whose result the
 * model has already been told (via the refusal on the call after it) not to
 * expect any more of.
 */
function wrapTool(toolDef: Tool, budget: ToolOutputBudget): Tool {
  const originalExecute = toolDef.execute
  if (!originalExecute) return toolDef

  return {
    ...toolDef,
    execute: async (input, options) => {
      if (budget.exhausted) return BUDGET_EXHAUSTED_REFUSAL

      const output = await originalExecute(input, options)
      const bytes = await measureModelBytes(toolDef, options.toolCallId, input, output)
      budget.charge(bytes)
      return output
    },
  }
}

/**
 * Wrap every tool in a `ToolSet` with the byte-budget check above.
 *
 * The loop over `Object.entries` operates on the SDK's widened `Tool` type,
 * not each member's own INPUT/OUTPUT generics — the budget-exhausted
 * refusal is a value that only exists at this wrapper's level, not in any
 * one tool's declared OUTPUT union, so TypeScript cannot verify per-key that
 * the wrapped object still satisfies `T` without this one cast. It is safe
 * because every tool in `ToolSet` already returns a `{error, message,
 * hint?}`-shaped refusal for other reasons (see read-file.ts, list-dir.ts,
 * grep.ts), and `BUDGET_EXHAUSTED_REFUSAL` is exactly that shape — a caller
 * that already handles `output.error` for `PATH_NOT_FOUND` etc. handles
 * this one the same way, with nothing new to widen its exposure.
 */
export function withToolOutputBudget<T extends ToolSet>(tools: T, budget: ToolOutputBudget): T {
  const wrapped: Record<string, Tool> = {}
  for (const [name, toolDef] of Object.entries(tools) as Array<[string, Tool]>) {
    wrapped[name] = wrapTool(toolDef, budget)
  }
  return wrapped as T
}
