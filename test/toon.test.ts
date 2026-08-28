import { describe, expect, it } from 'vitest'
import { decode } from '@toon-format/toon'

import { encodeToon, toonModelOutput } from '../src/toon.js'

describe('encodeToon', () => {
  it('round-trips a realistic list_dir result', () => {
    const value = {
      path: 'src',
      entries: [
        { name: 'a.ts', type: 'file' as const, size: 120 },
        { name: 'sub', type: 'dir' as const, size: 0 },
      ],
    }

    expect(decode(encodeToon(value))).toEqual(value)
  })

  it('round-trips a realistic grep result', () => {
    const value = {
      pattern: 'foo',
      path: '.',
      matches: [
        { file: 'a.ts', line: 1, text: 'const foo = 1' },
        { file: 'b.ts', line: 2, text: 'foo()' },
      ],
      engine: 'ripgrep' as const,
    }

    expect(decode(encodeToon(value))).toEqual(value)
  })

  it('round-trips a result carrying a note (truncation / empty-state)', () => {
    const value = {
      pattern: 'foo',
      path: '.',
      matches: [],
      note: 'no matches for foo under .',
      engine: 'ripgrep' as const,
    }

    expect(decode(encodeToon(value))).toEqual(value)
  })

  it('drops an undefined-valued optional property rather than encoding it as null', () => {
    // Verified empirically: @toon-format/toon's `encode` does NOT drop a key
    // whose value is `undefined` — it renders `note: null` and round-trips
    // to `note: null`, which would tell the model a `note` field exists and
    // is null, not that it's absent. A key that is never set on the object
    // at all (the pattern list-dir.ts/grep.ts already use) is fine and
    // produces no output for that key. `encodeToon` strips undefined-valued
    // keys recursively so a caller can't accidentally leak the difference.
    const value: { path: string; entries: unknown[]; note?: string } = {
      path: '.',
      entries: [],
      note: undefined,
    }

    const decoded = decode(encodeToon(value)) as Record<string, unknown>
    expect('note' in decoded).toBe(false)
    expect(decoded).toEqual({ path: '.', entries: [] })
  })

  it('produces a meaningfully smaller wire size than JSON for a realistic-sized list_dir result', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      name: `file-${i}.ts`,
      type: 'file' as const,
      size: 1000 + i,
    }))
    const value = { path: 'src', entries }

    const toonLength = encodeToon(value).length
    const jsonLength = JSON.stringify(value).length

    // Assert a real reduction, not just <=.
    expect(toonLength).toBeLessThan(jsonLength * 0.6)
  })
})

describe('toonModelOutput', () => {
  it('wraps encodeToon output in the AI SDK text ToolResultOutput shape', () => {
    const value = { path: '.', entries: [{ name: 'a.ts', type: 'file' as const, size: 1 }] }

    const output = toonModelOutput(value)

    expect(output.type).toBe('text')
    expect(output.value).toBe(encodeToon(value))
  })

  it('falls back to JSON.stringify when encoding throws (a lone surrogate in a string)', () => {
    // Verified empirically against the installed @toon-format/toon 4.1.1:
    // - a BigInt does NOT throw (encode renders it as a bare number/string);
    // - a circular object throws in `encode` (stack overflow walking
    //   references) but *also* throws in `JSON.stringify` (circular
    //   structure), so it can't be used to prove the fallback actually
    //   produces output;
    // - a string containing an unpaired UTF-16 surrogate (e.g. "\ud800")
    //   throws a TypeError from `encode`'s `assertNoLoneSurrogate`, while
    //   `JSON.stringify` happily serializes it. This is the case that
    //   proves the fallback: encode fails, JSON does not.
    const value = { text: 'bad \ud800 surrogate' }

    const output = toonModelOutput(value)

    expect(output.type).toBe('text')
    expect(output.value).toBe(JSON.stringify(value))
  })
})
