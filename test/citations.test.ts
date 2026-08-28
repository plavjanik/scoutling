import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { extractCitations, verifyCitations } from '../src/citations.js'

const fixtureScope = resolve(import.meta.dirname, 'fixtures/scope')

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('extractCitations', () => {
  it('extracts a backtick-wrapped path:line', () => {
    expect(extractCitations('See `src/loop.ts:42` for the loop.')).toEqual([
      { path: 'src/loop.ts', line: 42 },
    ])
  })

  it('extracts a parenthesized path:line', () => {
    expect(extractCitations('The value is set (a.txt:1) at startup.')).toEqual([
      { path: 'a.txt', line: 1 },
    ])
  })

  it('extracts the label of a markdown link, not the URL', () => {
    expect(
      extractCitations('See [src/x.ts:12](https://example.com/blob/src/x.ts) for details.'),
    ).toEqual([{ path: 'src/x.ts', line: 12 }])
  })

  it('does not capture a trailing sentence period', () => {
    expect(extractCitations('The fix is in see src/cli.ts:10.')).toEqual([
      { path: 'src/cli.ts', line: 10 },
    ])
  })

  it('does not capture a trailing comma', () => {
    expect(extractCitations('It happens in src/cli.ts:10, and also elsewhere.')).toEqual([
      { path: 'src/cli.ts', line: 10 },
    ])
  })

  it('does not capture a trailing closing bracket', () => {
    expect(extractCitations('The bug is here [src/cli.ts:10] according to the trace.')).toEqual([
      { path: 'src/cli.ts', line: 10 },
    ])
  })

  it('extracts a line range as line/endLine', () => {
    expect(extractCitations('The loop body is src/loop.ts:10-25.')).toEqual([
      { path: 'src/loop.ts', line: 10, endLine: 25 },
    ])
  })

  it('never treats a bare https URL as a citation', () => {
    expect(extractCitations('Docs are at https://example.com/foo.md for reference.')).toEqual([])
  })

  it('never treats a bare http URL with a port as a citation', () => {
    expect(extractCitations('The provider is http://localhost:1234/v1 by default.')).toEqual([])
  })

  it('accepts an extensionless path followed by :line when it starts with a letter (Makefile)', () => {
    expect(extractCitations('The target is defined in Makefile:12.')).toEqual([
      { path: 'Makefile', line: 12 },
    ])
  })

  it('accepts an extensionless path followed by :line when it starts with a letter (LICENSE)', () => {
    expect(extractCitations('The terms are in LICENSE:5.')).toEqual([{ path: 'LICENSE', line: 5 }])
  })

  it('does not capture a time-of-day-shaped token (digit start, no slash, no extension)', () => {
    expect(extractCitations('The job ran at 10:30 this morning.')).toEqual([])
  })

  it('does not treat a version number in prose as a citation', () => {
    expect(extractCitations('Verified against the installed ripgrep 1.18 binary.')).toEqual([])
  })

  it('does not treat a decimal number as a citation', () => {
    expect(extractCitations('The ratio settled around 3.14 in every run.')).toEqual([])
  })

  it('does not treat a prose abbreviation as a citation', () => {
    // "e.g" and "i.e" are a word plus a one-letter "extension"; admitting them
    // would put a bogus unverifiable entry in the Sources line of every answer
    // that happens to use one.
    expect(extractCitations('Some tools, e.g. ripgrep, are bundled; i.e. not installed.')).toEqual([])
  })

  it('accepts a one-letter extension, with and without a directory', () => {
    expect(extractCitations('See src/main.c:3 and main.c:12.')).toEqual([
      { path: 'src/main.c', line: 3 },
      { path: 'main.c', line: 12 },
    ])
  })

  it('ignores a path-shaped token that carries no line number', () => {
    // A citation is `path:line` by the system prompt's own contract, so a bare
    // path is not evidence of anything. Extracting it anyway is what produced
    // "Sources: 2 verified, 4 unverifiable" on a correct smoke answer.
    expect(extractCitations('The guard lives in src/tools/grep.ts somewhere.')).toEqual([])
  })

  it('ignores code and prose fragments that merely contain a slash', () => {
    // All three observed in real Phase 4 runs: a spread in a quoted code
    // snippet, a prose pair, and a reference to two ADRs by number.
    expect(
      extractCitations('The argv is [...flags, path/operand] and this follows ADR 0002/0004.'),
    ).toEqual([])
  })

  it('ignores an example path quoted in prose, such as a traversal attempt', () => {
    expect(extractCitations('A candidate like ../../etc/passwd is rejected.')).toEqual([])
  })

  it('still extracts the same path once it carries a line number', () => {
    expect(extractCitations('The guard is at src/tools/grep.ts:207.')).toEqual([
      { path: 'src/tools/grep.ts', line: 207 },
    ])
  })

  it('collapses duplicate path+line citations, keeping first-appearance order', () => {
    expect(
      extractCitations('First src/a.ts:1, then again src/a.ts:1, and once more src/a.ts:1.'),
    ).toEqual([{ path: 'src/a.ts', line: 1 }])
  })

  it('treats two different lines of the same file as distinct sources', () => {
    expect(extractCitations('See foo.ts:1 and also foo.ts:3.')).toEqual([
      { path: 'foo.ts', line: 1 },
      { path: 'foo.ts', line: 3 },
    ])
  })

  it('returns an empty array when nothing is cited', () => {
    expect(extractCitations('This answer cites nothing at all.')).toEqual([])
  })

  it('extracts multiple distinct citations in order of appearance', () => {
    expect(
      extractCitations('First src/a.ts:1, then src/b.ts:2-4, then c.ts:9, and bare d.ts.'),
    ).toEqual([
      { path: 'src/a.ts', line: 1 },
      { path: 'src/b.ts', line: 2, endLine: 4 },
      { path: 'c.ts', line: 9 },
    ])
  })
})

describe('verifyCitations', () => {
  it('reports no source at all for a bare path, even one that exists', () => {
    // Existing is not the same as cited: without a line number there is no
    // claim to check, so the file's existence proves nothing about the answer.
    const report = verifyCitations(fixtureScope, 'See a.txt for details.')
    expect(report.sources).toEqual([])
    expect(report.summaryLine).toBe('Sources: none cited')
  })

  it('verifies a path:line within the file', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1 for details.')
    expect(report.sources).toEqual([{ path: 'a.txt', line: 1, verified: true }])
  })

  it('marks a path:line past the end of the file as unverified', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:5 for details.')
    expect(report.sources).toEqual([{ path: 'a.txt', line: 5, verified: false }])
  })

  it('verifies a range fully within the file', () => {
    const report = verifyCitations(fixtureScope, 'See numbers.txt:1-10 for details.')
    expect(report.sources).toEqual([{ path: 'numbers.txt', line: 1, endLine: 10, verified: true }])
  })

  it('marks a range whose endLine exceeds the file length as unverified', () => {
    const report = verifyCitations(fixtureScope, 'See numbers.txt:9-11 for details.')
    expect(report.sources).toEqual([
      { path: 'numbers.txt', line: 9, endLine: 11, verified: false },
    ])
  })

  it('marks a range whose endLine is before line as unverified', () => {
    const report = verifyCitations(fixtureScope, 'See numbers.txt:5-3 for details.')
    expect(report.sources).toEqual([{ path: 'numbers.txt', line: 5, endLine: 3, verified: false }])
  })

  it('marks a citation to a nonexistent file as unverified, no throw', () => {
    const report = verifyCitations(fixtureScope, 'See does-not-exist.ts:1 for details.')
    expect(report.sources).toEqual([{ path: 'does-not-exist.ts', line: 1, verified: false }])
  })

  it('marks a citation to a directory as unverified', () => {
    const report = verifyCitations(fixtureScope, 'See sub:1 for details.')
    expect(report.sources).toEqual([{ path: 'sub', line: 1, verified: false }])
  })

  it('marks a scope-escaping citation as unverified rather than throwing', () => {
    expect(() =>
      verifyCitations(fixtureScope, 'See ../../../etc/passwd:1 for details.'),
    ).not.toThrow()
    const report = verifyCitations(fixtureScope, 'See ../../../etc/passwd:1 for details.')
    expect(report.sources).toEqual([{ path: '../../../etc/passwd', line: 1, verified: false }])
  })

  it('reports no source for a bare mention of a binary file', () => {
    const report = verifyCitations(fixtureScope, 'See binary.bin for details.')
    expect(report.sources).toEqual([])
  })

  it('marks a line-numbered citation to a binary file as unverified (cannot count lines)', () => {
    const report = verifyCitations(fixtureScope, 'See binary.bin:1 for details.')
    expect(report.sources).toEqual([{ path: 'binary.bin', line: 1, verified: false }])
  })

  it('cannot verify a line-numbered citation to an oversized file', () => {
    // Past the 2 MB cap there is no line count to check the citation against
    // without reading the whole file, so the claim stays unverified.
    const scope = tempDir('scoutling-citations-big-')
    writeFileSync(join(scope, 'big.txt'), 'x'.repeat(3 * 1024 * 1024))

    const lineReport = verifyCitations(scope, 'See big.txt:1 for details.')
    expect(lineReport.sources).toEqual([{ path: 'big.txt', line: 1, verified: false }])
  })

  it('verifies a nested path', () => {
    const report = verifyCitations(fixtureScope, 'See sub/nested.txt:1 for details.')
    expect(report.sources).toEqual([{ path: 'sub/nested.txt', line: 1, verified: true }])
  })

  it('resolves a citation relative to the given scope root, unaffected by other scopes', () => {
    const scope = tempDir('scoutling-citations-scope-')
    mkdirSync(join(scope, 'nested'))
    writeFileSync(join(scope, 'nested', 'file.ts'), 'one\ntwo\nthree\n')

    const report = verifyCitations(scope, 'See nested/file.ts:2 for details.')
    expect(report.sources).toEqual([{ path: 'nested/file.ts', line: 2, verified: true }])
  })
})

describe('CitationReport summaryLine', () => {
  it('is definitive when nothing is cited', () => {
    const report = verifyCitations(fixtureScope, 'This answer cites nothing.')
    expect(report.summaryLine).toBe('Sources: none cited')
    expect(report.sources).toEqual([])
    expect(report.verifiedCount).toBe(0)
    expect(report.unverifiedCount).toBe(0)
  })

  it('reports counts with no unverifiable clause when everything verifies', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1 and numbers.txt:1.')
    expect(report.verifiedCount).toBe(2)
    expect(report.unverifiedCount).toBe(0)
    expect(report.summaryLine).toBe('Sources: 2 verified')
  })

  it('lists the unverifiable citation inline for a single failure', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1 and a.txt:999.')
    expect(report.summaryLine).toBe('Sources: 1 verified, 1 unverifiable (a.txt:999)')
  })

  it('handles exactly one verified and one unverified without a pluralization bug', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1 and does-not-exist.ts:1.')
    expect(report.verifiedCount).toBe(1)
    expect(report.unverifiedCount).toBe(1)
    expect(report.summaryLine).toBe('Sources: 1 verified, 1 unverifiable (does-not-exist.ts:1)')
  })

  it('caps the unverifiable list at 3 with a +N more suffix', () => {
    const answer = 'See f1.ts:1, f2.ts:1, f3.ts:1, f4.ts:1 and f5.ts:1, none of which exist.'
    const report = verifyCitations(fixtureScope, answer)
    expect(report.verifiedCount).toBe(0)
    expect(report.unverifiedCount).toBe(5)
    expect(report.summaryLine).toBe(
      'Sources: 0 verified, 5 unverifiable (f1.ts:1, f2.ts:1, f3.ts:1, +2 more)',
    )
  })
})
