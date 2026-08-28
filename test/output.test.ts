import { describe, expect, it } from 'vitest'

import { formatAnswerJson, formatAnswerText, isOutputFormat } from '../src/output.js'
import type { RunResult } from '../src/loop.js'

/** A representative RunResult, built by hand rather than via a real run — output.ts only formats. */
function buildResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    answer: 'The value is set (a.txt:1) at startup.',
    stepsUsed: 2,
    toolCalls: { read_file: 1, list_dir: 0, grep: 0 },
    exhausted: false,
    usage: { inputTokens: 42, outputTokens: 17 },
    wallMs: 1234,
    toolOutputBytes: 99,
    toolCallErrors: 0,
    citations: {
      sources: [{ path: 'a.txt', line: 1, verified: true }],
      verifiedCount: 1,
      unverifiedCount: 0,
      summaryLine: 'Sources: 1 verified',
    },
    ...overrides,
  }
}

describe('isOutputFormat', () => {
  it('accepts "text" and "json"', () => {
    expect(isOutputFormat('text')).toBe(true)
    expect(isOutputFormat('json')).toBe(true)
  })

  it('rejects anything else, including undefined and non-strings', () => {
    expect(isOutputFormat('nonsense')).toBe(false)
    expect(isOutputFormat(undefined)).toBe(false)
    expect(isOutputFormat(42)).toBe(false)
  })
})

describe('formatAnswerText', () => {
  it('puts the answer, then the citations summary line, on its own line after it', () => {
    const result = buildResult()
    const text = formatAnswerText(result)

    const lines = text.split('\n')
    expect(lines[0]).toBe(result.answer)
    expect(lines[lines.length - 1]).toBe('Sources: 1 verified')
  })

  it('still prints the summary line when nothing was cited', () => {
    const result = buildResult({
      answer: 'No relevant files.',
      citations: { sources: [], verifiedCount: 0, unverifiedCount: 0, summaryLine: 'Sources: none cited' },
    })

    expect(formatAnswerText(result)).toBe('No relevant files.\nSources: none cited')
  })
  it('says why there is no answer when an exhausted run produced no text', () => {
    // A blank line reads as "it worked and had nothing to say". Observed for
    // real on a --budget quick run that spent all four steps calling tools.
    const text = formatAnswerText(
      buildResult({ answer: '', exhausted: true, citations: emptyCitations() }),
    )
    expect(text.split('\n')[0]).toContain('budget')
    expect(text).not.toMatch(/^\n/)
    expect(text).toContain('Sources: none cited')
  })

  it('distinguishes an empty answer that was not caused by a budget', () => {
    const text = formatAnswerText(
      buildResult({ answer: '   ', exhausted: false, citations: emptyCitations() }),
    )
    expect(text.split('\n')[0]).toBe('(no answer: the model returned no text)')
  })
})

/** The citation report of an answer that cited nothing, since there was no answer to cite from. */
function emptyCitations(): RunResult['citations'] {
  return { sources: [], verifiedCount: 0, unverifiedCount: 0, summaryLine: 'Sources: none cited' }
}

describe('formatAnswerJson', () => {
  it('emits exactly the documented key set, pretty-printed with a trailing newline', () => {
    const result = buildResult()
    const json = formatAnswerJson(result, 'qwen/qwen3-coder-next')

    expect(json.endsWith('\n')).toBe(true)
    expect(json).toContain('\n  ') // 2-space indent

    const parsed = JSON.parse(json)
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'answer',
        'sources',
        'model',
        'usage',
        'stepsUsed',
        'toolCalls',
        'exhausted',
        'timedOut',
        'wallMs',
        'toolOutputBytes',
        'toolCallErrors',
      ].sort(),
    )
  })

  it('carries the model id through and the citations sources array verbatim', () => {
    const result = buildResult()
    const parsed = JSON.parse(formatAnswerJson(result, 'my-model'))

    expect(parsed.model).toBe('my-model')
    expect(parsed.sources).toEqual(result.citations.sources)
    expect(parsed.answer).toBe(result.answer)
    expect(parsed.stepsUsed).toBe(result.stepsUsed)
    expect(parsed.toolCalls).toEqual(result.toolCalls)
    expect(parsed.exhausted).toBe(result.exhausted)
    expect(parsed.wallMs).toBe(result.wallMs)
    expect(parsed.toolOutputBytes).toBe(result.toolOutputBytes)
    expect(parsed.toolCallErrors).toBe(result.toolCallErrors)
    expect(parsed.usage).toEqual(result.usage)
  })

  it('timedOut is always false — a timeout is an error path that never produces a RunResult', () => {
    const result = buildResult({ exhausted: true })
    const parsed = JSON.parse(formatAnswerJson(result, 'my-model'))

    expect(parsed.timedOut).toBe(false)
  })

  it('does not include a separate "Sources:" text line — sources live only in the sources key', () => {
    const result = buildResult()
    const json = formatAnswerJson(result, 'my-model')

    expect(json).not.toContain('Sources:')
  })
})
