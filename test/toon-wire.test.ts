import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'

import { runScoutling } from '../src/loop.js'
import { resolveScopeRoot } from '../src/guardrails.js'

/**
 * CLAUDE.md's "a test must prove the path it claims": calling
 * `toonModelOutput` directly (see `test/toon.test.ts`) only proves the
 * function encodes TOON — it doesn't prove the AI SDK actually uses it when
 * rendering a tool result back into the prompt for the next step. This
 * drives a real `runScoutling` tool loop with a mock model and inspects the
 * *second* `doGenerate` call's `prompt` argument, which is what the model
 * would actually see on the wire.
 */

const scopeRoot = resolveScopeRoot(resolve(import.meta.dirname, 'fixtures/scope'))

function usage(outputTokens = 10) {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  }
}

/** Digs the text of every tool-result part out of a mock call's `prompt` messages. */
function toolResultTexts(prompt: unknown): string[] {
  const messages = prompt as Array<{ role: string; content: unknown }>
  const texts: string[] = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const parts = message.content as Array<{ type: string; output?: { type: string; value: string } }>
    for (const part of parts) {
      if (part.type === 'tool-result' && part.output?.type === 'text') {
        texts.push(part.output.value)
      }
    }
  }
  return texts
}

describe('list_dir and grep results reach the model as TOON, not JSON', () => {
  it('list_dir', async () => {
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
        return {
          content: [{ type: 'text' as const, text: 'Listed the scope root.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    await runScoutling({ question: 'List the top-level files.', scopeRoot, model, budget: { maxSteps: 5 } })

    expect(model.doGenerateCalls).toHaveLength(2)
    const secondCallPrompt = model.doGenerateCalls[1]?.prompt
    const texts = toolResultTexts(secondCallPrompt)

    expect(texts).toHaveLength(1)
    const text = texts[0] ?? ''
    // TOON's tabular array header for a uniform array of objects.
    expect(text).toContain('entries[')
    expect(text).toContain('{name,type,size}')
    // Not JSON: no quoted-key colon pair for the same field.
    expect(text).not.toContain('"entries":')
    expect(text).not.toContain('"name":')
  })

  it('grep', async () => {
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
                toolName: 'grep',
                input: JSON.stringify({ pattern: 'line' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text' as const, text: 'Found matches.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    await runScoutling({ question: 'Where does "line" occur?', scopeRoot, model, budget: { maxSteps: 5 } })

    expect(model.doGenerateCalls).toHaveLength(2)
    const secondCallPrompt = model.doGenerateCalls[1]?.prompt
    const texts = toolResultTexts(secondCallPrompt)

    expect(texts).toHaveLength(1)
    const text = texts[0] ?? ''
    expect(text).toContain('matches[')
    expect(text).toContain('{file,line,text}')
    expect(text).not.toContain('"matches":')
    expect(text).not.toContain('"file":')
  })
})
