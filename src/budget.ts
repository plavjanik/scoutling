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

/**
 * Held while one call is in flight, before its real size is known.
 *
 * The AI SDK runs every tool call belonging to one step concurrently, so
 * `wrapTool` cannot wait for a call's real output before deciding whether the
 * *next* concurrent call may proceed — by the time any call has measured and
 * posted its size, every other call in the same step has already read
 * `spentBytes` and found it unchanged. `admit`/`settle` close that window by
 * reserving this many bytes synchronously, before a call runs, so a
 * concurrent sibling sees the hold instead of a still-zero settled spend.
 *
 * Sized from a real measurement, not a guess: `read_file`'s default 400-line
 * page of a real source file (`src/tools/grep.ts`) measures ~17-18 KB, so a
 * single default read is roughly the realistic worst case a reservation has
 * to anticipate. This constant is deliberately a little under that: it is a
 * concurrency throttle, not a per-call cap, and CLAUDE.md's own "never
 * degrade silently" rule already commits this file to stating the residual
 * honestly rather than pretending a fixed reservation makes every call fit.
 */
export const TOOL_CALL_RESERVATION_BYTES = 16_000

/**
 * Tracks tool-output bytes for one run against a fixed cap, admitting calls
 * before they run and reconciling the estimate against reality afterwards.
 *
 * This bounds concurrent overshoot; it does not eliminate it. Reserving a
 * fixed amount up front stops an unbounded number of parallel calls from all
 * slipping through the same "not exhausted yet" window (a real repro: four
 * parallel `read_file` calls against a 5 KB cap once charged 71,084 bytes —
 * 14x the cap — under the old check-then-charge-after design), but it cannot
 * make the cap inviolable. A single call's real output can still exceed its
 * reservation (see `TOOL_CALL_RESERVATION_BYTES`'s own residual), and one
 * call whose real output is larger than the whole cap will always exceed it
 * — no pre-flight estimate can shrink a call's real result after the fact.
 */
export class ToolOutputBudget {
  private readonly limitBytes: number
  private spentBytes = 0
  private reservedBytes = 0
  private refusalCount = 0

  constructor(limitBytes: number) {
    this.limitBytes = limitBytes
  }

  /** Settled bytes only — in-flight reservations are not "spent" until `settle`. */
  get spent(): number {
    return this.spentBytes
  }

  get exhausted(): boolean {
    // Settled spend reaching the cap is the obvious case. The refusal count
    // is the trap: with reservations, a call can be refused while
    // `spentBytes` alone is still comfortably under the cap — e.g. 35 KB
    // settled plus a 16 KB hold against a 40 KB limit. Reporting
    // `exhausted: false` there would tell the caller its answer drew on the
    // full evidence budget when a call was in fact turned away.
    return this.spentBytes >= this.limitBytes || this.refusalCount > 0
  }

  /**
   * Admit a call and hold `reservationBytes` while it runs, or refuse.
   *
   * Refuses whenever what is already committed — settled spend plus any
   * other call's outstanding hold — has reached the cap. Checked and
   * incremented synchronously (no `await` before the reservation is added),
   * so two calls invoked back-to-back before either has run see each other's
   * hold rather than both reading the same stale "not exhausted" state.
   */
  admit(reservationBytes: number): boolean {
    if (this.spentBytes + this.reservedBytes >= this.limitBytes) {
      this.refusalCount += 1
      return false
    }
    this.reservedBytes += reservationBytes
    return true
  }

  /** Release the hold and record what the call actually cost (0 for a call that never produced a measurable result). */
  settle(reservationBytes: number, actualBytes: number): void {
    this.reservedBytes -= reservationBytes
    this.spentBytes += actualBytes
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
 * Wrap one tool's `execute` so every real call reserves its worst-case bytes
 * before running and reconciles that reservation against its real size
 * afterwards, refusing outright rather than executing once the budget is
 * already committed.
 *
 * The call that happens to tip the budget over still ran and still returns
 * its real result in full — only the *next* call is refused. Punishing the
 * call that crossed the line would waste a real tool round trip whose result
 * the model has already been told (via the refusal on the call after it) not
 * to expect any more of.
 *
 * `settle` runs in `finally` with `actualBytes` defaulting to 0: a call
 * whose `execute` or byte measurement throws still releases its reservation
 * instead of leaking it, which would otherwise wedge the budget — every
 * later call in the run would see a phantom hold that can never be spent —
 * for the rest of the run.
 */
function wrapTool(toolDef: Tool, budget: ToolOutputBudget): Tool {
  const originalExecute = toolDef.execute
  if (!originalExecute) return toolDef

  return {
    ...toolDef,
    execute: async (input, options) => {
      if (!budget.admit(TOOL_CALL_RESERVATION_BYTES)) return BUDGET_EXHAUSTED_REFUSAL

      let actualBytes = 0
      try {
        const output = await originalExecute(input, options)
        actualBytes = await measureModelBytes(toolDef, options.toolCallId, input, output)
        return output
      } finally {
        budget.settle(TOOL_CALL_RESERVATION_BYTES, actualBytes)
      }
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
