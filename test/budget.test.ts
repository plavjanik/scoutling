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
      quick: { maxSteps: 4, maxToolOutputBytes: 16_000, timeoutMs: 90_000, maxOutputTokens: 4_000 },
      normal: { maxSteps: 8, maxToolOutputBytes: 40_000, timeoutMs: 180_000, maxOutputTokens: 10_000 },
      deep: { maxSteps: 15, maxToolOutputBytes: 120_000, timeoutMs: 420_000, maxOutputTokens: 16_000 },
    })
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
