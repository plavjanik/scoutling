import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'

import {
  BUDGET_PRESETS,
  TOOL_CALL_RESERVATION_BYTES,
  ToolOutputBudget,
  isBudgetPreset,
  resolveBudget,
  withToolOutputBudget,
} from '../src/budget.js'
import type { ToolSet } from '../src/tools/index.js'

describe('BUDGET_PRESETS', () => {
  it('matches DESIGN.md §7 exactly', () => {
    expect(BUDGET_PRESETS).toEqual({
      quick: { maxSteps: 6, maxToolOutputBytes: 40_000, timeoutMs: 300_000, maxOutputTokens: 8_000 },
      normal: { maxSteps: 12, maxToolOutputBytes: 80_000, timeoutMs: 600_000, maxOutputTokens: 12_000 },
      deep: { maxSteps: 24, maxToolOutputBytes: 200_000, timeoutMs: 1_200_000, maxOutputTokens: 16_000 },
    })
  })

  it('orders every cap quick < normal < deep, so the one dial really is one dial', () => {
    // DESIGN.md §7 sells `--budget` as a single dial. That is only true if
    // every cap moves the same way: a preset that raised bytes but lowered
    // steps would make "deeper" mean something different per question, and
    // the §7 table is hand-maintained, so nothing but this check enforces it.
    for (const cap of ['maxSteps', 'maxToolOutputBytes', 'timeoutMs', 'maxOutputTokens'] as const) {
      expect(BUDGET_PRESETS.quick[cap], cap).toBeLessThanOrEqual(BUDGET_PRESETS.normal[cap])
      expect(BUDGET_PRESETS.normal[cap], cap).toBeLessThanOrEqual(BUDGET_PRESETS.deep[cap])
    }
  })
})

describe('TOOL_CALL_RESERVATION_BYTES against the presets (the parallelism knob)', () => {
  /**
   * How many tool calls of one step `admit` lets run concurrently under
   * `cap` — measured by actually reserving, not by dividing, so it stays
   * true if `admit`'s rule changes.
   */
  function parallelCallsAdmitted(cap: number): number {
    const budget = new ToolOutputBudget(cap)
    let admitted = 0
    // Nothing settles: this is one step's calls all in flight at once,
    // which is exactly how the AI SDK runs them.
    while (budget.admit(TOOL_CALL_RESERVATION_BYTES)) admitted += 1
    return admitted
  }

  it('lets every preset run at least three tool calls of one step in parallel', () => {
    // The gate. A reservation at or above a preset's cap admits exactly one
    // call and then marks the run exhausted — concurrency switched off for
    // that preset. That is what the Phase 4 pairing did to `quick` (a
    // 16_000 cap against a 16_000 reservation), silently and by accident
    // rather than by choice, and it is invisible to every other test here
    // because a *sequential* run of small calls behaves identically.
    // DESIGN.md §13 item 6: the reservation and the caps have to be tuned
    // together, so they are asserted together.
    for (const preset of ['quick', 'normal', 'deep'] as const) {
      expect(parallelCallsAdmitted(BUDGET_PRESETS[preset].maxToolOutputBytes), preset).toBeGreaterThanOrEqual(3)
    }
  })

  it('admits 3 / 5 / 13 parallel calls under quick / normal / deep', () => {
    // Pinned, not just bounded: this is the parallelism Phase 6's tuning
    // chose, and a later change to either the reservation or a cap should
    // have to state its new number out loud rather than drift into one.
    expect(parallelCallsAdmitted(BUDGET_PRESETS.quick.maxToolOutputBytes)).toBe(3)
    expect(parallelCallsAdmitted(BUDGET_PRESETS.normal.maxToolOutputBytes)).toBe(5)
    expect(parallelCallsAdmitted(BUDGET_PRESETS.deep.maxToolOutputBytes)).toBe(13)
  })

  it('holds worst-case concurrent overshoot under 2.5x every preset cap', () => {
    // The other end of the trade, and the reason the reservation did not
    // simply get smaller when the caps grew. Overshoot is bounded by (calls
    // admitted) x (a call's real size), so a smaller reservation admits more
    // oversized calls through the same window and makes the worst case
    // *worse*, not better: against this 32 KB reference read, 16 000 gives
    // 2.0-2.4x, 12 000 gives 2.7-3.2x and 10 000 gives 3.2x. Without this
    // assertion the "at least three parallel calls" gate above pushes the
    // reservation down with nothing pushing back.
    const largestObservedRead = 32_000
    for (const preset of ['quick', 'normal', 'deep'] as const) {
      const cap = BUDGET_PRESETS[preset].maxToolOutputBytes
      const worstCase = parallelCallsAdmitted(cap) * largestObservedRead
      expect(worstCase / cap, preset).toBeLessThan(2.5)
    }
  })

  it('is near the p90 of a default read_file page, not the median and not the max', () => {
    // Measured across 266 real code files (see budget.ts): median 3-7 KB,
    // p90 15-18 KB, max 32 KB. At the median almost every call would
    // under-reserve; at the max `quick` drops to 2 concurrent calls.
    expect(TOOL_CALL_RESERVATION_BYTES).toBeGreaterThan(10_000)
    expect(TOOL_CALL_RESERVATION_BYTES).toBeLessThan(20_000)
  })
})

describe('isBudgetPreset', () => {
  it('accepts exactly quick, normal, deep', () => {
    expect(isBudgetPreset('quick')).toBe(true)
    expect(isBudgetPreset('normal')).toBe(true)
    expect(isBudgetPreset('deep')).toBe(true)
  })

  it('rejects other strings and non-strings', () => {
    expect(isBudgetPreset('fast')).toBe(false)
    expect(isBudgetPreset('')).toBe(false)
    expect(isBudgetPreset(undefined)).toBe(false)
    expect(isBudgetPreset(null)).toBe(false)
    expect(isBudgetPreset(8)).toBe(false)
    expect(isBudgetPreset({})).toBe(false)
  })
})

describe('resolveBudget', () => {
  it('returns the preset unchanged with no overrides', () => {
    expect(resolveBudget('quick')).toEqual(BUDGET_PRESETS.quick)
  })

  it('applies defined override keys', () => {
    const resolved = resolveBudget('normal', { maxSteps: 3, timeoutMs: 1000 })
    expect(resolved).toEqual({
      maxSteps: 3,
      maxToolOutputBytes: BUDGET_PRESETS.normal.maxToolOutputBytes,
      timeoutMs: 1000,
      maxOutputTokens: BUDGET_PRESETS.normal.maxOutputTokens,
    })
  })

  it('treats an explicitly undefined override entry as absent, not a real override', () => {
    const resolved = resolveBudget('deep', {
      maxSteps: undefined,
      maxToolOutputBytes: 999,
      timeoutMs: undefined,
      maxOutputTokens: undefined,
    })
    expect(resolved).toEqual({
      maxSteps: BUDGET_PRESETS.deep.maxSteps,
      maxToolOutputBytes: 999,
      timeoutMs: BUDGET_PRESETS.deep.timeoutMs,
      maxOutputTokens: BUDGET_PRESETS.deep.maxOutputTokens,
    })
  })
})

describe('ToolOutputBudget', () => {
  it('starts unspent and not exhausted', () => {
    const budget = new ToolOutputBudget(100)
    expect(budget.spent).toBe(0)
    expect(budget.exhausted).toBe(false)
  })

  it('becomes exhausted once settled spend reaches the limit', () => {
    const budget = new ToolOutputBudget(10)
    expect(budget.admit(9)).toBe(true)
    budget.settle(9, 9)
    expect(budget.exhausted).toBe(false)
    expect(budget.admit(1)).toBe(true)
    budget.settle(1, 1)
    expect(budget.spent).toBe(10)
    expect(budget.exhausted).toBe(true)
  })

  it('refuses admission once a reservation alone would reach the limit, before anything settles', () => {
    // The bug this class exists to close: a check against settled spend
    // alone lets every concurrent call see spentBytes === 0 before any of
    // them has posted a real size. admit() must refuse based on outstanding
    // reservations too, synchronously, with no settle() in between.
    const budget = new ToolOutputBudget(10)
    expect(budget.admit(10)).toBe(true)
    expect(budget.spent).toBe(0) // nothing settled yet — this is the trap
    expect(budget.admit(1)).toBe(false) // but the reservation already fills the cap
  })

  it('is exhausted once a call is refused, even though settled spend alone is still under the limit', () => {
    // The trap named in budget.ts: 35 KB settled + a 16 KB hold still
    // outstanding from a second, not-yet-settled call can refuse a third
    // call against a 40 KB cap while `spent` (settled only) still reads
    // under the cap. Reporting exhausted: false there would tell the caller
    // its answer used the full evidence budget when a call was in fact
    // turned away.
    const budget = new ToolOutputBudget(40_000)

    // Call A: admitted, then settles for 35 KB.
    expect(budget.admit(16_000)).toBe(true)
    budget.settle(16_000, 35_000)
    expect(budget.spent).toBe(35_000)
    expect(budget.exhausted).toBe(false)

    // Call B: admitted (35_000 + 0 < 40_000) — its 16 KB hold is now
    // outstanding, deliberately left unsettled to simulate "still in flight".
    expect(budget.admit(16_000)).toBe(true)

    // Call C: refused — 35_000 settled + B's 16_000 hold already committed
    // is >= the 40_000 cap, even though nothing more has actually settled.
    expect(budget.admit(16_000)).toBe(false)
    expect(budget.spent).toBe(35_000) // settled spend never moved
    expect(budget.spent).toBeLessThan(40_000)
    expect(budget.exhausted).toBe(true) // but the refusal alone makes the run exhausted
  })

  it('releases a reservation on settle, so it does not behave like a permanent charge', () => {
    // N sequential small calls must not exhaust a budget that comfortably
    // fits them — each call's reservation has to come back off the books
    // once it settles, not stay held for the rest of the run.
    const budget = new ToolOutputBudget(1_000)
    for (let i = 0; i < 20; i += 1) {
      expect(budget.admit(TOOL_CALL_RESERVATION_BYTES)).toBe(true)
      budget.settle(TOOL_CALL_RESERVATION_BYTES, 10)
    }
    expect(budget.spent).toBe(200)
    expect(budget.exhausted).toBe(false)
  })
})

/** Minimal fake tool set, built with the real `tool()` helper, cast to `ToolSet`'s shape for the wrapper under test. */
function makeFakeToolSet(options: { withToModelOutput?: boolean } = {}): {
  toolSet: ToolSet
  getExecuteCallCount: () => number
} {
  let executeCallCount = 0

  const fakeTool = tool({
    description: 'fake tool for budget wrapper tests',
    inputSchema: z.object({}),
    execute: async () => {
      executeCallCount += 1
      // A JSON body much larger than the fake toModelOutput's text, so a
      // test asserting the charge matches toModelOutput (not
      // JSON.stringify(output)) actually distinguishes the two.
      return { data: 'x'.repeat(500) }
    },
    ...(options.withToModelOutput
      ? {
          toModelOutput: () => ({ type: 'text' as const, value: 'y'.repeat(20) }),
        }
      : {}),
  })

  // Cast: this fake stands in for the real three-member ToolSet purely to
  // exercise withToolOutputBudget's per-tool wrapping without depending on
  // the parallel TOON work in tools/list-dir.ts and tools/grep.ts.
  const toolSet = { read_file: fakeTool, list_dir: fakeTool, grep: fakeTool } as unknown as ToolSet

  return { toolSet, getExecuteCallCount: () => executeCallCount }
}

function callOptions(toolCallId: string) {
  return { toolCallId, messages: [], context: {} }
}

describe('withToolOutputBudget', () => {
  it('charges the measured bytes for a real call', async () => {
    const budget = new ToolOutputBudget(10_000)
    const { toolSet } = makeFakeToolSet()
    const wrapped = withToolOutputBudget(toolSet, budget)

    expect(wrapped.read_file.execute).toBeDefined()
    await wrapped.read_file.execute?.({ path: 'fake.txt' }, callOptions('call-1'))

    expect(budget.spent).toBeGreaterThan(0)
    // No toModelOutput on this fake, so bytes come from JSON.stringify(output).
    expect(budget.spent).toBe(Buffer.byteLength(JSON.stringify({ data: 'x'.repeat(500) }), 'utf8'))
  })

  it('measures via toModelOutput when the tool defines one, not JSON.stringify(output)', async () => {
    const budget = new ToolOutputBudget(10_000)
    const { toolSet } = makeFakeToolSet({ withToModelOutput: true })
    const wrapped = withToolOutputBudget(toolSet, budget)

    await wrapped.read_file.execute?.({ path: 'fake.txt' }, callOptions('call-1'))

    // The fake's toModelOutput returns exactly 20 'y' characters as text —
    // much smaller than the 500-char JSON body execute() actually returned.
    expect(budget.spent).toBe(20)
  })

  it('the call that crosses the cap still returns its real output in full', async () => {
    const budget = new ToolOutputBudget(5)
    const { toolSet } = makeFakeToolSet()
    const wrapped = withToolOutputBudget(toolSet, budget)

    const result = await wrapped.read_file.execute?.({ path: 'fake.txt' }, callOptions('call-1'))

    expect(result).toEqual({ data: 'x'.repeat(500) })
    expect(budget.exhausted).toBe(true)
  })

  it('refuses the next call without executing it once the budget is exhausted', async () => {
    const budget = new ToolOutputBudget(5)
    const { toolSet, getExecuteCallCount } = makeFakeToolSet()
    const wrapped = withToolOutputBudget(toolSet, budget)

    await wrapped.read_file.execute?.({ path: 'fake.txt' }, callOptions('call-1'))
    expect(getExecuteCallCount()).toBe(1)
    expect(budget.exhausted).toBe(true)

    const secondResult = await wrapped.read_file.execute?.({ path: 'fake.txt' }, callOptions('call-2'))

    // The counter proves execute() itself never ran for the second call —
    // a return value that merely *looks* like a refusal would not move it.
    expect(getExecuteCallCount()).toBe(1)
    expect(secondResult).toEqual({
      error: 'BUDGET_EXHAUSTED',
      message: 'Tool-output budget exhausted — synthesize an answer from what you have already seen.',
      hint: 'Do not call more tools; state explicitly what you could not verify.',
    })
  })

  it('releases the reservation when execute() throws, so a later call is still admitted', async () => {
    // Without try/finally around settle(), a thrown call would leak its
    // TOOL_CALL_RESERVATION_BYTES hold forever, wedging the budget for every
    // subsequent call in the run even though nothing was ever really spent.
    const budget = new ToolOutputBudget(10_000)
    const throwingTool = tool({
      description: 'fake tool that always throws',
      inputSchema: z.object({}),
      execute: async (): Promise<{ data: string }> => {
        throw new Error('boom')
      },
    })
    const toolSet = {
      read_file: throwingTool,
      list_dir: throwingTool,
      grep: throwingTool,
    } as unknown as ToolSet
    const wrapped = withToolOutputBudget(toolSet, budget)

    await expect(wrapped.read_file.execute?.({ path: 'fake.txt' }, callOptions('call-1'))).rejects.toThrow('boom')

    // The reservation is released: no bytes were ever settled, and the
    // budget is not exhausted, so a later call is admitted normally.
    expect(budget.spent).toBe(0)
    expect(budget.exhausted).toBe(false)

    const { toolSet: workingToolSet } = makeFakeToolSet()
    const wrappedWorking = withToolOutputBudget(workingToolSet, budget)
    const secondResult = await wrappedWorking.read_file.execute?.({ path: 'fake.txt' }, callOptions('call-2'))

    expect(secondResult).toEqual({ data: 'x'.repeat(500) })
    expect(budget.spent).toBeGreaterThan(0)
  })
})
