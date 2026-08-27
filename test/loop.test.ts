import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'

import { runScoutling } from '../src/loop.js'
import { resolveScopeRoot } from '../src/guardrails.js'

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
      maxSteps: 5,
    })

    expect(result.answer).toContain('hello')
    expect(result.stepsUsed).toBe(2)
    expect(result.toolCalls).toEqual({ read_file: 1, list_dir: 0, grep: 0 })
    expect(result.exhausted).toBe(false)
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
      maxSteps: 8,
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
      maxSteps: 5,
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
      maxSteps: 3,
    })

    expect(result.stepsUsed).toBe(3)
    expect(result.exhausted).toBe(true)
    expect(typeof result.answer).toBe('string')
  })

  it('defaults maxSteps to 8 (the normal preset) when not given', async () => {
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

    expect(result.stepsUsed).toBe(8)
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
      maxSteps: 5,
      onStep: (step) => steps.push(step),
    })

    expect(steps).toHaveLength(result.stepsUsed)
    expect(steps[0]?.toolCalls).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }])
    expect(steps[0]?.bytes).toBeGreaterThan(0)
  })
})
