import { describe, expect, it, afterEach } from 'vitest'
import { resolve, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { MockLanguageModelV4 } from 'ai/test'

import { runScoutling } from '../src/loop.js'
import { resolveScopeRoot } from '../src/guardrails.js'
import { ScoutlingError } from '../src/errors.js'
import { BUDGET_PRESETS, TOOL_CALL_RESERVATION_BYTES } from '../src/budget.js'
import { createReadFileTool } from '../src/tools/read-file.js'

const scopeRoot = resolveScopeRoot(resolve(import.meta.dirname, 'fixtures/scope'))

function usage(outputTokens = 10) {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  }
}

describe('runScoutling', () => {
  it('reads a file then answers: stepsUsed 2, one read_file call, not exhausted', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'read_file',
                input: JSON.stringify({ path: 'a.txt' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'The file says hello (a.txt:1).' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    const result = await runScoutling({
      question: 'What does a.txt say?',
      scopeRoot,
      model,
      budget: { maxSteps: 5 },
    })

    expect(result.answer).toContain('hello')
    expect(result.stepsUsed).toBe(2)
    expect(result.toolCalls).toEqual({ read_file: 1, list_dir: 0, grep: 0 })
    expect(result.exhausted).toBe(false)

    // DESIGN.md §8: runScoutling's own report includes the citation check,
    // no separate call needed. The mock's answer text cites `a.txt:1`, and
    // a.txt exists in fixtures/scope with at least 1 line, so it verifies.
    expect(result.citations.verifiedCount).toBe(1)
    expect(result.citations.sources).toContainEqual({ path: 'a.txt', line: 1, verified: true })

    // A normal run that never mis-calls a tool reports zero — the baseline
    // this field's "1" case (below) is measured against.
    expect(result.toolCallErrors).toBe(0)
  })

  it('counts a tool call the SDK rejected before dispatch (unknown tool name) as toolCallErrors: 1', async () => {
    // AI SDK v7 catches an unrecognized tool name in parseToolCall() before
    // dispatch and surfaces it to the model as a `tool-error` content part
    // (no-write.test.ts proves this shape empirically) — the model never
    // reaches write_file's execute(), there is none. The model here "tries"
    // write_file on step 1, gets that rejection fed back, then answers.
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'write_file',
                input: JSON.stringify({ path: 'a.txt', content: 'x' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'I have no write tool, so I cannot do that.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    const result = await runScoutling({
      question: 'Write to a.txt.',
      scopeRoot,
      model,
      budget: { maxSteps: 5 },
    })

    expect(result.toolCallErrors).toBe(1)
    expect(result.stepsUsed).toBe(2)
  })

  it('calls list_dir, then grep, then read_file, then answers: toolCalls reflects all three', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'list_dir',
                input: JSON.stringify({ path: '.' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        if (call === 2) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-2',
                toolName: 'grep',
                input: JSON.stringify({ pattern: 'hello' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        if (call === 3) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-3',
                toolName: 'read_file',
                input: JSON.stringify({ path: 'a.txt' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'The file says hello (a.txt:1).' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    const result = await runScoutling({
      question: 'Where does a.txt say hello?',
      scopeRoot,
      model,
      budget: { maxSteps: 8 },
    })

    expect(result.stepsUsed).toBe(4)
    expect(result.toolCalls).toEqual({ read_file: 1, list_dir: 1, grep: 1 })
    expect(result.exhausted).toBe(false)
  })

  it('answers directly with no tool call: stepsUsed 1', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'No file reads needed.' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })

    const result = await runScoutling({
      question: 'Say hello.',
      scopeRoot,
      model,
      budget: { maxSteps: 5 },
    })

    expect(result.stepsUsed).toBe(1)
    expect(result.exhausted).toBe(false)
    expect(result.toolCalls).toEqual({ read_file: 0, list_dir: 0, grep: 0 })
  })

  it('a model that calls the tool forever hits maxSteps and returns exhausted: true', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: `call-${Math.random()}`,
            toolName: 'read_file',
            input: JSON.stringify({ path: 'a.txt' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })

    const result = await runScoutling({
      question: 'Keep reading forever.',
      scopeRoot,
      model,
      budget: { maxSteps: 3 },
    })

    expect(result.stepsUsed).toBe(3)
    expect(result.exhausted).toBe(true)
    expect(typeof result.answer).toBe('string')
  })

  it('defaults maxSteps to the normal preset when not given', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: `call-${Math.random()}`,
            toolName: 'read_file',
            input: JSON.stringify({ path: 'a.txt' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })

    const result = await runScoutling({
      question: 'Keep reading forever.',
      scopeRoot,
      model,
    })

    // Read from the preset rather than pinned to a literal: Phase 6 re-sized
    // §7's numbers from measurement, and a test that hardcodes one of them
    // fails for the caps changing rather than for the default breaking. What
    // this test is actually about is that an absent `budget` resolves to
    // `normal` at all — `test/budget.test.ts` is where the numbers live.
    expect(result.stepsUsed).toBe(BUDGET_PRESETS.normal.maxSteps)
    expect(result.exhausted).toBe(true)
  })

  it('calls onStep once per step', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'read_file',
                input: JSON.stringify({ path: 'a.txt' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'Done.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    const steps: Array<{ index: number; toolCalls: { name: string; args: unknown }[]; bytes: number }> =
      []

    const result = await runScoutling({
      question: 'What does a.txt say?',
      scopeRoot,
      model,
      budget: { maxSteps: 5 },
      onStep: (step) => steps.push(step),
    })

    expect(steps).toHaveLength(result.stepsUsed)
    expect(steps[0]?.toolCalls).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }])
    expect(steps[0]?.bytes).toBeGreaterThan(0)
  })

  it('the per-step byte counts sum to toolOutputBytes, so --verbose and --max-tool-bytes agree', async () => {
    // The step log and the byte budget used to measure different things: the
    // log JSON.stringify'd the structured tool result while the budget
    // measured the TOON the model actually receives, so a caller tuning
    // --max-tool-bytes from a --verbose run would have used numbers ~40 %
    // too big. Both now come from the budget's own accounting. list_dir is
    // the tool that makes the two disagree, since it is TOON-rendered.
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1
        if (call <= 2) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: `call-${call}`,
                toolName: 'list_dir',
                input: JSON.stringify({ path: '.' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'Done.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    const steps: Array<{ bytes: number }> = []
    const result = await runScoutling({
      question: 'What is here?',
      scopeRoot,
      model,
      budget: { maxSteps: 5 },
      onStep: (step) => steps.push({ bytes: step.bytes }),
    })

    const summed = steps.reduce((total, step) => total + step.bytes, 0)
    expect(result.toolOutputBytes).toBeGreaterThan(0)
    expect(summed).toBe(result.toolOutputBytes)
  })

  it('a tiny tool-output byte budget exhausts after the first real call, and the next tool call is refused', async () => {
    let call = 0
    let thirdCallPrompt: unknown

    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        call += 1
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'read_file',
                input: JSON.stringify({ path: 'a.txt' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        if (call === 2) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-2',
                toolName: 'read_file',
                input: JSON.stringify({ path: 'sub/nested.txt' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        // By the third call, the model has already seen the second tool
        // call's result — this is where a BUDGET_EXHAUSTED refusal (if any)
        // would show up on the wire.
        thirdCallPrompt = opts.prompt
        return {
          content: [{ type: 'text' as const, text: 'Ran out of budget partway through.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    const result = await runScoutling({
      question: 'Read every file in the scope.',
      scopeRoot,
      model,
      budget: { maxSteps: 8, maxToolOutputBytes: 5 },
    })

    // maxToolOutputBytes: 5 is far smaller than a.txt's JSON-serialized
    // read_file result, so the very first real call already crosses it.
    expect(result.exhausted).toBe(true)
    expect(result.toolOutputBytes).toBeGreaterThan(0)
    expect(result.stepsUsed).toBe(3)

    // The second read_file call ran only after the budget was already
    // exhausted, so the model must have been fed the refusal shape, not a
    // real second read.
    expect(JSON.stringify(thirdCallPrompt)).toContain('BUDGET_EXHAUSTED')
  })

  it('a run that exceeds timeoutMs throws a ScoutlingError with code TIMEOUT', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        // Never settles on its own — only reacts to the abortSignal
        // generateText merges in from `budget.timeoutMs`, exactly like a
        // real provider's `fetch` call would. Verified empirically (see the
        // PR description) that MockLanguageModelV4 has no automatic abort
        // handling of its own.
        await new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
          })
        })
        throw new Error('unreachable: the promise above never resolves')
      },
    })

    await expect(
      runScoutling({
        question: 'Take forever to answer.',
        scopeRoot,
        model,
        budget: { timeoutMs: 5 },
      }),
    ).rejects.toMatchObject({
      name: 'ScoutlingError',
      code: 'TIMEOUT',
    })
  })

  it('the TIMEOUT error is a real ScoutlingError instance with a helpful hint', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        await new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
          })
        })
        throw new Error('unreachable')
      },
    })

    try {
      await runScoutling({ question: 'Take forever.', scopeRoot, model, budget: { timeoutMs: 5 } })
      expect.unreachable('runScoutling should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ScoutlingError)
      const scoutlingError = error as ScoutlingError
      expect(scoutlingError.code).toBe('TIMEOUT')
      expect(scoutlingError.hint).toMatch(/cold-load|timeout-ms/i)
    }
  })
})

describe('runScoutling — concurrent tool calls in one step (budget regression)', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds four parallel read_file calls in one step to well under 2x the byte cap', async () => {
    // The AI SDK executes every tool call belonging to one step concurrently
    // (Promise.all under the hood), so a budget that only checks
    // `exhausted` and charges *after* `execute()` returns lets every call in
    // the step observe `exhausted === false` before any of them has posted
    // its cost. Real repro that motivated the admit/settle fix in budget.ts:
    // four parallel `read_file` calls against `maxToolOutputBytes: 5000`
    // charged 71,084 bytes total — 14x the cap — before this fix. This test
    // reproduces the same shape (one step, four parallel read_file calls of
    // a real file) and pins that the total charged now stays bounded.
    const dir = mkdtempSync(join(tmpdir(), 'scoutling-budget-concurrency-'))
    tempDirs.push(dir)

    // A file whose default 400-line `read_file` page is realistically large
    // (comparable to the ~17-18 KB TOOL_CALL_RESERVATION_BYTES was sized
    // from), so this reproduces genuine per-call overshoot rather than a
    // toy-sized read that would pass by accident.
    const lines: string[] = []
    for (let i = 1; i <= 450; i += 1) lines.push(`synthetic fixture line ${i} for the concurrency regression test`)
    writeFileSync(join(dir, 'big.txt'), lines.join('\n') + '\n', 'utf8')

    const bigScopeRoot = resolveScopeRoot(dir)

    // Measure one real call's cost directly (same tool, same file) as the
    // reference point for "unbounded" (4x this) vs "bounded" (this test's
    // assertions below).
    const probeTool = createReadFileTool(bigScopeRoot)
    const probeResult = await probeTool.execute?.(
      { path: 'big.txt' },
      { toolCallId: 'probe', messages: [], context: {} },
    )
    const perCallBytes = Buffer.byteLength(JSON.stringify(probeResult), 'utf8')
    // Confirms the fixture is a realistic worst case, not a toy that happens
    // to fit inside one reservation.
    expect(perCallBytes).toBeGreaterThan(TOOL_CALL_RESERVATION_BYTES)

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [1, 2, 3, 4].map((n) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${n}`,
          toolName: 'read_file',
          input: JSON.stringify({ path: 'big.txt' }),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })

    const cap = 16_000
    const result = await runScoutling({
      question: 'Read big.txt.',
      scopeRoot: bigScopeRoot,
      model,
      budget: { maxSteps: 1, maxToolOutputBytes: cap },
    })

    // All four calls were issued by the model...
    expect(result.toolCalls.read_file).toBe(4)
    // ...but the reservation means at most one ~28 KB call can be admitted
    // for real against a 16 KB cap once its sibling's hold is outstanding —
    // this is the assertion that fails loudly (~4 * perCallBytes if
    // admit/settle is removed, matching the reported repro's shape: four
    // parallel calls all charged in full regardless of the cap).
    expect(result.toolOutputBytes).toBeLessThan(2 * cap)
    expect(result.toolOutputBytes).toBeLessThan(2 * perCallBytes)
    expect(result.exhausted).toBe(true)
  })
})
