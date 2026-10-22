import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createCitationVerifier, extractCitations, verifyCitations } from '../src/citations.js'
import type { Attachment } from '../src/attachments.js'

// Vitest cannot `vi.spyOn` Node's ESM built-ins directly ("Module namespace is not
// configurable") — `{ spy: true }` wraps the real implementation instead of replacing it, so
// every other test in this file that reads real fixture files keeps working unchanged; only the
// call-count assertion below relies on the wrapping.
vi.mock('node:fs', { spy: true })

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

describe('extractCitations — attachment citations (ADR 0005)', () => {
  it('extracts @name:line with attachment: true', () => {
    expect(extractCitations('See the diff (@full.diff:42) for the change.')).toEqual([
      { path: '@full.diff', line: 42, attachment: true },
    ])
  })

  it('extracts @name:line-line as a range, with attachment: true', () => {
    expect(extractCitations('The hunk is @full.diff:10-25.')).toEqual([
      { path: '@full.diff', line: 10, endLine: 25, attachment: true },
    ])
  })

  it('does not also yield a scope candidate for the same token', () => {
    // Without stripping the '@name:line' span before the scope scan runs, PATH_TOKEN_RE would
    // start matching one character in (at "full.diff:42") and produce a phantom scope citation to
    // a file never claimed to be in scope.
    const candidates = extractCitations('See @full.diff:42 for the change.')
    expect(candidates).toEqual([{ path: '@full.diff', line: 42, attachment: true }])
    expect(candidates).not.toContainEqual(expect.objectContaining({ path: 'full.diff' }))
  })

  it('extracts an attachment citation and a scope citation from the same answer, in document order', () => {
    expect(extractCitations('See src/a.ts:1 and then @full.diff:5 for context.')).toEqual([
      { path: 'src/a.ts', line: 1 },
      { path: '@full.diff', line: 5, attachment: true },
    ])
  })

  it('collapses a duplicate attachment path+line citation', () => {
    expect(extractCitations('See @plan.md:3, and again @plan.md:3.')).toEqual([
      { path: '@plan.md', line: 3, attachment: true },
    ])
  })

  it('never extracts an attachment citation with no line number', () => {
    expect(extractCitations('See the @plan.md file.')).toEqual([])
  })
})

describe('verifyCitations / createCitationVerifier — attachment citations (ADR 0005)', () => {
  const attachments: Attachment[] = [
    { name: 'plan.md', path: '/tmp/plan.md', content: 'one\ntwo\nthree\n', totalLines: 3 },
  ]

  it('verifies a line within the attachment, with no filesystem access to the scope', () => {
    const report = verifyCitations(fixtureScope, 'See @plan.md:2 for the plan.', attachments)
    expect(report.sources).toEqual([{ path: '@plan.md', line: 2, attachment: true, verified: true }])
  })

  it('verifies a range fully within the attachment', () => {
    const report = verifyCitations(fixtureScope, 'See @plan.md:1-3 for the plan.', attachments)
    expect(report.sources).toEqual([
      { path: '@plan.md', line: 1, endLine: 3, attachment: true, verified: true },
    ])
  })

  it('marks a line past the end of the attachment as unverified', () => {
    const report = verifyCitations(fixtureScope, 'See @plan.md:99 for the plan.', attachments)
    expect(report.sources).toEqual([{ path: '@plan.md', line: 99, attachment: true, verified: false }])
  })

  it('marks a citation to a name with no matching attachment as unverified, no throw', () => {
    expect(() => verifyCitations(fixtureScope, 'See @missing.md:1.', attachments)).not.toThrow()
    const report = verifyCitations(fixtureScope, 'See @missing.md:1.', attachments)
    expect(report.sources).toEqual([{ path: '@missing.md', line: 1, attachment: true, verified: false }])
  })

  it('with no attachments given, every @name:line citation is unverified', () => {
    const report = verifyCitations(fixtureScope, 'See @plan.md:1.')
    expect(report.sources).toEqual([{ path: '@plan.md', line: 1, attachment: true, verified: false }])
  })

  it('verifiedScopeCount excludes verified attachment sources', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1 and @plan.md:1.', attachments)
    expect(report.verifiedCount).toBe(2)
    expect(report.verifiedScopeCount).toBe(1)
  })

  it('createCitationVerifier verifies attachment citations identically to verifyCitations', () => {
    const verify = createCitationVerifier(fixtureScope, attachments)
    const answer = 'See @plan.md:2 and a.txt:1.'
    expect(verify(answer)).toEqual(verifyCitations(fixtureScope, answer, attachments))
  })
})

describe('CitationReport summaryLine — attachments (ADR 0005)', () => {
  const attachments: Attachment[] = [
    { name: 'plan.md', path: '/tmp/plan.md', content: 'one\ntwo\nthree\n', totalLines: 3 },
  ]

  it('appends ", N in attachments" after the verified count when N > 0', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1 and @plan.md:1.', attachments)
    expect(report.summaryLine).toBe('Sources: 2 verified, 1 in attachments')
  })

  it('keeps the unverifiable clause after the attachments clause', () => {
    const report = verifyCitations(fixtureScope, 'See @plan.md:1 and does-not-exist.ts:1.', attachments)
    expect(report.summaryLine).toBe(
      'Sources: 1 verified, 1 in attachments, 1 unverifiable (does-not-exist.ts:1)',
    )
  })

  it('omits the attachments clause when nothing verified is an attachment', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1.', attachments)
    expect(report.summaryLine).toBe('Sources: 1 verified')
  })

  it('omits the attachments clause when the only attachment citation is unverified', () => {
    const report = verifyCitations(fixtureScope, 'See a.txt:1 and @missing.md:1.', attachments)
    expect(report.summaryLine).toBe('Sources: 1 verified, 1 unverifiable (@missing.md:1)')
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
    expect(report.sources).toEqual([
      { path: 'does-not-exist.ts', line: 1, verified: false, note: 'no file in scope is named does-not-exist.ts' },
    ])
  })

  it('marks a nonexistent file under a directory as unverified, with no bare-name lookup', () => {
    const report = verifyCitations(fixtureScope, 'See sub/does-not-exist.ts:1 for details.')
    expect(report.sources).toEqual([{ path: 'sub/does-not-exist.ts', line: 1, verified: false }])
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

describe('createCitationVerifier', () => {
  it('produces the same report as verifyCitations for the same scope root and answer', () => {
    const verify = createCitationVerifier(fixtureScope)
    const answer = 'See a.txt:1 and numbers.txt:1-3, plus does-not-exist.ts:1.'

    expect(verify(answer)).toEqual(verifyCitations(fixtureScope, answer))
  })

  it('shares its line-count cache across calls: two answers citing the same file read it once', () => {
    // This is the "prove the path it claims" case: without a shared cache, verifying two answers
    // that both cite numbers.txt would read the file twice — once per call, exactly like calling
    // verifyCitations(scopeRoot, answer) twice would. The factory's whole point is that it does
    // not, so the assertion is on the read count, not merely on the reports being correct.
    const verify = createCitationVerifier(fixtureScope)
    const readSpy = vi.mocked(readFileSync)
    readSpy.mockClear()

    verify('See numbers.txt:1 for the first claim.')
    verify('See numbers.txt:2 for a second, unrelated claim.')

    const numbersFileReads = readSpy.mock.calls.filter(([path]) => String(path).endsWith('numbers.txt'))
    expect(numbersFileReads).toHaveLength(1)
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

// Regression (2026-10-22 eval, docs/eval.md "Harness defect found"): every model cited
// `app/learn/[slug]/page.tsx` correctly and the extractor recorded `page.tsx`, because `[` `]` `(`
// `)` were excluded from the path token to keep wrapper punctuation out of a match.
describe('extractCitations — Next.js route segments in paths', () => {
  it('keeps a [param] segment in the path', () => {
    expect(extractCitations('The page is app/learn/[slug]/page.tsx:173 here.')).toEqual([
      { path: 'app/learn/[slug]/page.tsx', line: 173 },
    ])
  })

  it('keeps a [param] segment with a line range', () => {
    expect(extractCitations('See app/learn/[slug]/page.tsx:172-173.')).toEqual([
      { path: 'app/learn/[slug]/page.tsx', line: 172, endLine: 173 },
    ])
  })

  it('keeps it inside backticks, bold, and a table cell', () => {
    expect(extractCitations('In `app/learn/[slug]/page.tsx:173` the slug is read.')).toEqual([
      { path: 'app/learn/[slug]/page.tsx', line: 173 },
    ])
    expect(extractCitations('**app/learn/[slug]/page.tsx:173** renders it.')).toEqual([
      { path: 'app/learn/[slug]/page.tsx', line: 173 },
    ])
    expect(extractCitations('| slug | `app/learn/[slug]/page.tsx:172-173` |\n|---|---|')).toEqual([
      { path: 'app/learn/[slug]/page.tsx', line: 172, endLine: 173 },
    ])
  })

  it('keeps catch-all, optional catch-all and (group) segments', () => {
    expect(
      extractCitations(
        'See app/docs/[...slug]/page.tsx:3, app/shop/[[...slug]]/page.tsx:4 and app/(marketing)/about/page.tsx:5.',
      ),
    ).toEqual([
      { path: 'app/docs/[...slug]/page.tsx', line: 3 },
      { path: 'app/shop/[[...slug]]/page.tsx', line: 4 },
      { path: 'app/(marketing)/about/page.tsx', line: 5 },
    ])
  })

  it('keeps a bracketed filename (pages router) and a path that starts with a group', () => {
    expect(extractCitations('See pages/posts/[id].tsx:9 and (auth)/login/page.tsx:2.')).toEqual([
      { path: 'pages/posts/[id].tsx', line: 9 },
      { path: '(auth)/login/page.tsx', line: 2 },
    ])
  })

  it('unwraps a markdown link whose label is a bracketed path', () => {
    expect(
      extractCitations('See [app/learn/[slug]/page.tsx:173](https://example.com/app/learn/[slug]/page.tsx).'),
    ).toEqual([{ path: 'app/learn/[slug]/page.tsx', line: 173 }])
  })

  it('never turns a markdown link into a path', () => {
    expect(extractCitations('Read [the docs](https://example.com/docs) and [notes](docs/notes.md).')).toEqual([])
    expect(extractCitations('See [the page](app/learn/[slug]/page.tsx) and src/a.ts:1.')).toEqual([
      { path: 'src/a.ts', line: 1 },
    ])
  })

  it('does not pull a bare filename out of a URL that contains a bracket segment', () => {
    expect(extractCitations('Upstream: https://github.com/o/r/blob/main/app/[slug]/page.tsx:3 is the same.')).toEqual(
      [],
    )
  })

  it('still drops a wrapping bracket or paren around an ordinary citation', () => {
    expect(extractCitations('Here [src/cli.ts:10] and (a.txt:1) and foo(x) at src/b.ts:2.')).toEqual([
      { path: 'src/cli.ts', line: 10 },
      { path: 'a.txt', line: 1 },
      { path: 'src/b.ts', line: 2 },
    ])
  })
})

describe('verifyCitations — Next.js route segments', () => {
  it('verifies a citation into a [slug] directory', () => {
    const scope = tempDir('scoutling-cite-next-')
    mkdirSync(join(scope, 'app/learn/[slug]'), { recursive: true })
    writeFileSync(join(scope, 'app/learn/[slug]/page.tsx'), 'a\nb\nc\n')
    const report = verifyCitations(scope, 'The slug is read at `app/learn/[slug]/page.tsx:2-3`.')
    expect(report.sources).toEqual([{ path: 'app/learn/[slug]/page.tsx', line: 2, endLine: 3, verified: true }])
  })
})

// Regression (same eval): a model that cites `candidates.ts:19` with no directory was marked
// unverified even when exactly one file of that name is visible in the scope.
describe('verifyCitations — bare filenames resolved against the scope', () => {
  function bareScope(): string {
    const scope = tempDir('scoutling-cite-bare-')
    mkdirSync(join(scope, 'lib/screener'), { recursive: true })
    mkdirSync(join(scope, 'scripts'), { recursive: true })
    mkdirSync(join(scope, 'a'), { recursive: true })
    mkdirSync(join(scope, 'b'), { recursive: true })
    mkdirSync(join(scope, 'ignored'), { recursive: true })
    mkdirSync(join(scope, 'vendor'), { recursive: true })
    mkdirSync(join(scope, '.git'), { recursive: true })
    const twenty = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    writeFileSync(join(scope, 'lib/screener/candidates.ts'), twenty)
    writeFileSync(join(scope, 'scripts/run-book-backtests.ts'), twenty)
    writeFileSync(join(scope, 'a/dup.ts'), twenty)
    writeFileSync(join(scope, 'b/dup.ts'), twenty)
    writeFileSync(join(scope, 'root.ts'), 'one\n')
    writeFileSync(join(scope, 'sub-root.ts'), twenty)
    mkdirSync(join(scope, 'nested'), { recursive: true })
    writeFileSync(join(scope, 'nested/root.ts'), twenty)
    writeFileSync(join(scope, '.gitignore'), 'ignored/\n')
    writeFileSync(join(scope, 'ignored/secret.ts'), twenty)
    writeFileSync(join(scope, 'vendor/lib.ts'), twenty)
    writeFileSync(join(scope, '.git/config.ts'), twenty)
    return scope
  }

  it('resolves a unique basename to its scope-relative path and verifies it', () => {
    const report = verifyCitations(bareScope(), 'Ranked in candidates.ts:19 and run-book-backtests.ts:77-83.')
    expect(report.sources).toEqual([
      { path: 'lib/screener/candidates.ts', line: 19, verified: true, citedAs: 'candidates.ts' },
      {
        path: 'scripts/run-book-backtests.ts',
        line: 77,
        endLine: 83,
        verified: true,
        citedAs: 'run-book-backtests.ts',
      },
    ])
    expect(report.verifiedScopeCount).toBe(2)
  })

  it('still checks the line against the resolved file', () => {
    const report = verifyCitations(bareScope(), 'See candidates.ts:500.')
    expect(report.sources).toEqual([
      { path: 'lib/screener/candidates.ts', line: 500, verified: false, citedAs: 'candidates.ts' },
    ])
  })

  it('leaves an ambiguous basename unverified and says why', () => {
    const report = verifyCitations(bareScope(), 'See dup.ts:3.')
    expect(report.sources).toEqual([
      { path: 'dup.ts', line: 3, verified: false, note: 'ambiguous: 2 files in scope are named dup.ts (a/dup.ts, b/dup.ts)' },
    ])
  })

  it('leaves a basename with no match unverified and says why', () => {
    const report = verifyCitations(bareScope(), 'See nowhere.ts:3.')
    expect(report.sources).toEqual([
      { path: 'nowhere.ts', line: 3, verified: false, note: 'no file in scope is named nowhere.ts' },
    ])
  })

  it('does not loop on a dangling symlink at the scope root that the walk still lists', () => {
    const scope = bareScope()
    symlinkSync(join(scope, 'gone.ts'), join(scope, 'dangling.ts'))
    const report = verifyCitations(scope, 'See dangling.ts:1.')
    expect(report.sources).toEqual([
      { path: 'dangling.ts', line: 1, verified: false, citedAs: 'dangling.ts' },
    ])
  })

  it('prefers a file at the scope root over a same-named nested one', () => {
    const report = verifyCitations(bareScope(), 'See root.ts:1.')
    expect(report.sources).toEqual([{ path: 'root.ts', line: 1, verified: true }])
  })

  it('never resolves to a gitignored, excludeGlobs-matched, or .git/ file', () => {
    const scope = bareScope()
    const report = verifyCitations(scope, 'See secret.ts:1, lib.ts:1 and config.ts:1.', [], {
      excludeGlobs: ['vendor/**'],
    })
    expect(report.sources.map((source) => [source.path, source.verified, source.note])).toEqual([
      ['secret.ts', false, 'no file in scope is named secret.ts'],
      ['lib.ts', false, 'no file in scope is named lib.ts'],
      ['config.ts', false, 'no file in scope is named config.ts'],
    ])
    // The same file without the exclusion is resolvable — so the glob is what hid it.
    expect(verifyCitations(scope, 'See lib.ts:1.').sources[0]).toMatchObject({ path: 'vendor/lib.ts', verified: true })
  })

  it('collapses a bare citation and the full-path citation of the same line into one source', () => {
    const report = verifyCitations(bareScope(), 'See lib/screener/candidates.ts:19, i.e. candidates.ts:19.')
    expect(report.sources).toEqual([{ path: 'lib/screener/candidates.ts', line: 19, verified: true }])
  })

  it('createCitationVerifier resolves bare names identically and walks the scope once', async () => {
    const fs = await import('node:fs')
    const scope = bareScope()
    const verify = createCitationVerifier(scope)
    vi.mocked(fs.readdirSync).mockClear()
    const first = verify('See candidates.ts:19.')
    const callsAfterFirst = vi.mocked(fs.readdirSync).mock.calls.length
    const second = verify('And run-book-backtests.ts:77.')
    expect(first.sources[0]).toMatchObject({ path: 'lib/screener/candidates.ts', verified: true })
    expect(second.sources[0]).toMatchObject({ path: 'scripts/run-book-backtests.ts', verified: true })
    expect(callsAfterFirst).toBeGreaterThan(0)
    expect(vi.mocked(fs.readdirSync).mock.calls.length).toBe(callsAfterFirst)
  })

  it('does not touch attachment citations or their count', () => {
    const attachments: Attachment[] = [{ name: 'candidates.ts', path: '/tmp/candidates.ts', content: 'x\n', totalLines: 1 }]
    const report = verifyCitations(bareScope(), 'See @candidates.ts:1 and candidates.ts:19.', attachments)
    expect(report.sources).toEqual([
      { path: '@candidates.ts', line: 1, verified: true, attachment: true },
      { path: 'lib/screener/candidates.ts', line: 19, verified: true, citedAs: 'candidates.ts' },
    ])
    expect(report.verifiedScopeCount).toBe(1)
  })
})
