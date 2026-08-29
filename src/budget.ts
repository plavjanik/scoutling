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

/**
 * DESIGN.md §7's table, verbatim. `normal` is the default until a run says otherwise.
 *
 * **Re-sized in Phase 6 from measurement, replacing DESIGN's original
 * guesses** (see `docs/dogfood-log.md` for the raw distributions). Every
 * number below is charged the way `ToolOutputBudget` charges it — what the
 * model receives, TOON for `list_dir`/`grep` — measured over 266 real code
 * files and 187 markdown files across two repositories:
 *
 * | call                        | median | p75     | p90     | max     |
 * |-----------------------------|--------|---------|---------|---------|
 * | `read_file` default (400ln) | 3-7 KB | 7-14 KB | 15-18 KB| 32 KB   |
 * | `read_file` `limit: 120`    | 3-5 KB | 5 KB    | 6 KB    | 7 KB    |
 * | `list_dir`                  | 0.1 KB | 0.4 KB  | 0.6 KB  | 0.7 KB  |
 * | `grep` `contextLines: 0`    | 8-10 KB| 10 KB   | 12 KB   | 14 KB   |
 * | `grep` `contextLines: 3`    | 23-33KB| 41-60KB | 43-60KB | 60 KB   |
 *
 * Two things that changes. First, the premise this re-sizing was queued
 * under — "a default `read_file` page measures 17.3 KB, larger than the
 * whole `quick` budget" — was one file (this repo's largest source file),
 * not the typical one: 17 KB is the **p90**, and 81-91 % of real reads come
 * in under 16 KB. `quick` could afford several median reads all along.
 * Second, and actually worse, the old `quick` cap equalled
 * `TOOL_CALL_RESERVATION_BYTES` exactly, so `admit` let exactly **one**
 * concurrent call through and marked the run exhausted the moment a model
 * issued a parallel pair — concurrency was switched off for that preset by
 * accident rather than by choice. Re-sizing the caps fixes that without
 * touching the reservation (see `TOOL_CALL_RESERVATION_BYTES`), and
 * `test/budget.test.ts` is the gate that keeps it from coming back.
 *
 * The caps are therefore sized against observed *runs*, not single calls:
 *
 * - **`quick`** — one lookup: a `grep` (~10 KB) plus two p90 reads (~15 KB
 *   each) ≈ 40 KB. Below that, "find it and read it" does not fit.
 * - **`normal`** — 2.4x the largest observed useful run (33 KB of tool
 *   output, 6 steps). At the old 40 KB that same question exhausted at
 *   34.9 KB and wrote **no answer at all** (`docs/dogfood-log.md`), which is
 *   what a cap sized against a single call rather than a run buys you.
 * - **`deep`** — 2.5x `normal`, for a survey that has to cross many files.
 *
 * Steps rise with them: the observed useful runs took 4-6 steps and the one
 * observed failure spent all 8 without answering, so `quick` gets grep +
 * two reads + an answer with slack, and `normal` gets 2x the observed run.
 *
 * Timeouts are sized as `maxSteps × 40 s + 90 s` — 40 s per step and 90 s of
 * JIT cold load, both observed on the reference machine (a 6-step run of the
 * smoke question takes ~3.5 minutes on `qwen/qwen3-coder-next`). They are a
 * backstop against a hang, not a cost control; steps and bytes are the cost
 * control. A timeout that fires throws away every step the run completed
 * (DESIGN.md §15), so sizing one tight trades a bounded cost for a total
 * loss. The old `normal` 180 s was *less* than that observed 3.5-minute run,
 * which is why `script/smoke.ts` had to pass `--timeout-ms` to keep a
 * healthy endpoint from looking broken.
 *
 * `maxOutputTokens` rises for `quick` because 4 000 truncates a
 * reasoning-capable local model mid-think, and a step that truncates before
 * emitting its tool call is a step spent on nothing (DESIGN.md §7).
 *
 * **Second re-tune, 2026-08-29, from the eval rather than from file sizes.**
 * The numbers above are the first re-sizing's; these are what running real
 * questions said. A preset sweep of the four auto-gradable audit questions at
 * all three presets (`qwen/qwen3-coder-next` against `local-ai`) produced:
 *
 * | preset  | passed | exhausted | what bound |
 * |---------|--------|-----------|------------|
 * | `quick`  | 2 of 4 | 3 of 4 | steps at 6, then bytes |
 * | `normal` | 3 of 4 | 2 of 4 | bytes, both times |
 * | `deep`   | 4 of 4 | 1 of 4 | bytes, at 210 KB |
 *
 * The number doing the work is `candidate-hunter-layers`: 56 KB and a fail at
 * `quick`, 88.9 KB and a fail at `normal`, and a **clean pass at 92.1 KB**
 * under `deep`. It needs ~92 KB, which fell in the gap between the old
 * `normal` (80 KB) and `deep` (200 KB) — so `normal` was failing a question it
 * was only ~15 % short of. `normal`'s 112 KB also covers the survey questions,
 * separately measured at 107-114 KB. `quick` goes to 8 steps because
 * `backtest-runner-header` wants 7 and got 6; its bytes are set from the two
 * cheap audits, which cost 17.7 and 25.3 KB.
 *
 * **These are provisional and the tail is wide.** `form4-ticker-count` used
 * 10.3 KB on one run and 210 KB on another — same question, same model,
 * different path through it — which is why `deep` is 256 KB rather than
 * something tighter, and why this table should be re-derived once the eval has
 * run across four models rather than one.
 */
export const BUDGET_PRESETS: Record<BudgetPreset, Budget> = {
  quick: { maxSteps: 8, maxToolOutputBytes: 48_000, timeoutMs: 420_000, maxOutputTokens: 8_000 },
  normal: { maxSteps: 14, maxToolOutputBytes: 112_000, timeoutMs: 660_000, maxOutputTokens: 12_000 },
  deep: { maxSteps: 28, maxToolOutputBytes: 256_000, timeoutMs: 1_260_000, maxOutputTokens: 16_000 },
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
 * page measures ~15-18 KB at the p90 across 266 real code files (the full
 * distribution is in `BUDGET_PRESETS`), so a single default read of a large
 * file is roughly the realistic worst case a reservation has to anticipate.
 * A typical read is far smaller — median 3-7 KB — so most calls over-reserve
 * and `settle` hands the difference back. The tail that does not is the
 * point: this is a concurrency throttle, not a per-call cap, and CLAUDE.md's
 * "never degrade silently" rule commits this file to stating the residual
 * honestly rather than pretending a fixed reservation makes every call fit.
 *
 * **The reservation and the caps together decide how many tool calls a step
 * may run in parallel** (DESIGN.md §13 item 6), because `admit` refuses once
 * settled spend plus outstanding holds reach the cap. Phase 6 re-tuned the
 * two together and **left this constant where Phase 4 put it** — the value
 * was never the problem; the *pairing* was. The old `quick` cap was 16 000,
 * exactly equal to this reservation, so `quick` admitted a single call and
 * then declared the run exhausted the moment a model issued a parallel pair.
 * Concurrency was switched off for that preset by arithmetic accident. With
 * §7's re-sized caps the same constant admits 3 calls under `quick`, 5 under
 * `normal` and 13 under `deep`.
 *
 * Lowering it does not simply buy more parallelism, which is why it stayed.
 * Worst-case overshoot is (calls admitted) x (a call's real size), so a
 * smaller reservation lets *more* oversized calls through the same window:
 * measured against a 32 KB read (the largest observed), 16 000 holds the
 * worst case to 2.0-2.4x a cap, where 12 000 gives 2.7-3.2x and 10 000 gives
 * 3.2x across the board — for one extra concurrent call under `quick`. Going
 * the other way, 20 000 would drop `quick` back to 2 concurrent calls.
 * `test/budget.test.ts` pins both ends of that trade so the next tuner has
 * to state a new parallelism out loud rather than drift into one.
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
