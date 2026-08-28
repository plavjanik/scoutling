import { describe, expect, it, afterEach } from 'vitest'
import { resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  createGrepTool,
  DEFAULT_MAX_MATCHES,
  MAX_MAX_MATCHES,
  MAX_MATCH_TEXT_CHARS,
  MAX_FALLBACK_PATTERN_CHARS,
  MAX_CONTEXT_LINES,
} from '../src/tools/grep.js'
import { resolveScopeRoot } from '../src/guardrails.js'

const scopeRoot = resolveScopeRoot(resolve(import.meta.dirname, 'fixtures/scope'))

/** A ripgrep path guaranteed not to exist, forcing the JS fallback (ENOENT). */
const NONEXISTENT_RG_PATH = resolve(import.meta.dirname, 'fixtures/no-such-binary')

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

/** Executes the tool the way the AI SDK does: input first, options second. */
async function run(
  tool: ReturnType<typeof createGrepTool>,
  input: {
    pattern: string
    path?: string
    glob?: string
    caseSensitive?: boolean
    maxMatches?: number
    contextLines?: number
  },
): Promise<unknown> {
  if (!tool.execute) throw new Error('grep tool has no execute()')
  return tool.execute(input, { toolCallId: 'call-1', messages: [], context: {} })
}

interface OkShape {
  pattern: string
  path: string
  matches: { file: string; line: number; text: string; kind?: 'match' | 'context' }[]
  note?: string
  engine: 'ripgrep' | 'fallback'
}

interface RefusalShape {
  error: string
  message: string
  hint?: string
}

describe('grep (ripgrep backend)', () => {
  it('returns a plain match with scope-relative file, 1-based line, and text', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'line1' })) as OkShape

    expect(result.engine).toBe('ripgrep')
    expect(result.matches).toContainEqual({ file: 'a.txt', line: 1, text: 'line1' })
  })

  it('is case-insensitive by default', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'LINE1' })) as OkShape

    expect(result.matches).toContainEqual({ file: 'a.txt', line: 1, text: 'line1' })
  })

  it('narrows to case-sensitive matches with caseSensitive: true', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'LINE1', caseSensitive: true })) as OkShape

    expect(result.matches).toEqual([])
    expect(result.note).toMatch(/no matches/i)
  })

  it('filters by glob', async () => {
    const dir = tempDir('scoutling-grep-glob-')
    writeFileSync(join(dir, 'a.ts'), 'needle here\n')
    writeFileSync(join(dir, 'b.md'), 'needle here too\n')

    const tool = createGrepTool(resolveScopeRoot(dir))
    const result = (await run(tool, { pattern: 'needle', glob: '*.ts' })) as OkShape

    expect(result.matches.map((m) => m.file)).toEqual(['a.ts'])
  })

  it('searches a single file when path points at a file', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'line', path: 'numbers.txt' })) as OkShape

    expect(result.matches.every((m) => m.file === 'numbers.txt')).toBe(true)
    expect(result.matches.length).toBe(10)
  })

  it('does not search a .gitignore-d file', async () => {
    const dir = tempDir('scoutling-grep-gitignore-')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(dir, 'ignored.txt'), 'MATCHME but ignored\n')
    writeFileSync(join(dir, 'plain.txt'), 'MATCHME and visible\n')

    const tool = createGrepTool(resolveScopeRoot(dir))
    const result = (await run(tool, { pattern: 'MATCHME' })) as OkShape

    expect(result.matches.map((m) => m.file)).toEqual(['plain.txt'])
  })

  it(
    'refuses PATH_EXCLUDED — not a leaked match — when path names an excluded file directly, ' +
      'on both the ripgrep and fallback engines',
    async () => {
      // Pins the bug this file's task fixed (DESIGN.md §6/§15, 2026-08-28
      // follow-up): grep only ever filtered its OWN traversal (via
      // `walkScope`/ripgrep's `--glob '!...'`), never the model-supplied
      // `path` argument itself. Naming an excluded path directly bypassed
      // exclusion entirely — a real content leak, not just an
      // inconsistency, because ripgrep searches an explicitly-named file
      // regardless of any `--glob` flag. Before the fix this returned
      // `{matches: [{file: 'ignored.txt', ...}], engine: 'ripgrep'}`.
      //
      // Asserts the refusal SHAPE, not just "no error". A shallow check like
      // `result.matches?.length === 0` would pass by accident on a buggy
      // return of `{matches: [], error: 'PATH_EXCLUDED'}` that still somehow
      // carried an (empty) `matches` array, or would miss a regression that
      // returned real matches alongside a spurious `error` field. `error`
      // must be exactly `PATH_EXCLUDED` and `matches` must be absent
      // entirely, matching the `GrepRefusal` shape as actually declared.
      const dir = tempDir('scoutling-grep-explicit-path-leak-')
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(dir, 'ignored.txt'), 'MATCHME but gitignored\n')
      writeFileSync(join(dir, '.git', 'HEAD'), 'MATCHME under .git\n')
      writeFileSync(join(dir, 'plain.txt'), 'MATCHME and visible\n')

      const scope = resolveScopeRoot(dir)
      const ripgrepTool = createGrepTool(scope)
      const fallbackTool = createGrepTool(scope, { rgPath: NONEXISTENT_RG_PATH })

      for (const tool of [ripgrepTool, fallbackTool]) {
        const gitignoredResult = (await run(tool, { pattern: 'MATCHME', path: 'ignored.txt' })) as {
          error?: string
          matches?: unknown[]
        }
        expect(gitignoredResult.error).toBe('PATH_EXCLUDED')
        expect(gitignoredResult.matches).toBeUndefined()

        const gitResult = (await run(tool, { pattern: 'MATCHME', path: '.git/HEAD' })) as {
          error?: string
          matches?: unknown[]
        }
        expect(gitResult.error).toBe('PATH_EXCLUDED')
        expect(gitResult.matches).toBeUndefined()
      }

      // Control: the same pattern against the visible file, and against "."
      // (which must still search everything visible, unrefused), still
      // finds the real match — proves the guard didn't just start refusing
      // everything.
      const controlResult = (await run(ripgrepTool, { pattern: 'MATCHME' })) as OkShape
      expect(controlResult.matches.map((m) => m.file)).toEqual(['plain.txt'])
    },
  )

  it('is a definitive empty state when nothing matches', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'zzz-does-not-exist-zzz' })) as OkShape

    expect(result.matches).toEqual([])
    expect(result.note).toBe('no matches for zzz-does-not-exist-zzz under .')
  })

  it('truncates at maxMatches and says so, but not when the count lands exactly on maxMatches', async () => {
    const dir = tempDir('scoutling-grep-truncate-')
    writeFileSync(join(dir, 'exact.txt'), Array.from({ length: 3 }, () => 'needle').join('\n') + '\n')
    writeFileSync(join(dir, 'over.txt'), Array.from({ length: 4 }, () => 'needle').join('\n') + '\n')

    const toolExact = createGrepTool(resolveScopeRoot(dir))
    const exactResult = (await run(toolExact, {
      pattern: 'needle',
      path: 'exact.txt',
      maxMatches: 3,
    })) as OkShape
    expect(exactResult.matches).toHaveLength(3)
    expect(exactResult.note).toBeUndefined()

    const toolOver = createGrepTool(resolveScopeRoot(dir))
    const overResult = (await run(toolOver, {
      pattern: 'needle',
      path: 'over.txt',
      maxMatches: 3,
    })) as OkShape
    expect(overResult.matches).toHaveLength(3)
    expect(overResult.note).toMatch(/narrow/i)
  })

  it('clamps an out-of-range maxMatches to the 500 ceiling', async () => {
    const dir = tempDir('scoutling-grep-clamp-')
    writeFileSync(join(dir, 'many.txt'), Array.from({ length: 501 }, () => 'needle').join('\n') + '\n')

    const tool = createGrepTool(resolveScopeRoot(dir))
    const result = (await run(tool, { pattern: 'needle', maxMatches: 9999 })) as OkShape

    expect(result.matches).toHaveLength(MAX_MAX_MATCHES)
    expect(result.note).toMatch(/narrow/i)
  })

  it('truncates a long matching line to 300 characters with a marker', async () => {
    const dir = tempDir('scoutling-grep-longline-')
    const longLine = `needle-${'x'.repeat(400)}`
    writeFileSync(join(dir, 'long.txt'), `${longLine}\n`)

    const tool = createGrepTool(resolveScopeRoot(dir))
    const result = (await run(tool, { pattern: 'needle' })) as OkShape

    expect(result.matches).toHaveLength(1)
    const text = result.matches[0]?.text ?? ''
    expect(text.length).toBe(MAX_MATCH_TEXT_CHARS + 1) // +1 for the trailing "…" marker
    expect(text.endsWith('…')).toBe(true)
    expect(text.startsWith(longLine.slice(0, MAX_MATCH_TEXT_CHARS))).toBe(true)
  })

  it('refuses a path that escapes the scope root', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'anything', path: '../../etc/passwd' })) as RefusalShape

    expect(result.error).toBe('PATH_NOT_FOUND')
  })

  it('refuses a path that does not exist', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'anything', path: 'no-such-dir' })) as RefusalShape

    expect(result.error).toBe('PATH_NOT_FOUND')
  })

  it('refuses an invalid regex, surfacing ripgrep’s message', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: '(' })) as RefusalShape

    expect(result.error).toBe('INVALID_PATTERN')
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('omits the kind field entirely when contextLines is absent (default), unchanged from before', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'line1' })) as OkShape

    expect(result.matches).toEqual([{ file: 'a.txt', line: 1, text: 'line1' }])
    expect(Object.prototype.hasOwnProperty.call(result.matches[0], 'kind')).toBe(false)
  })

  it('omits the kind field entirely when contextLines is explicitly 0', async () => {
    const tool = createGrepTool(scopeRoot)
    const result = (await run(tool, { pattern: 'line1', contextLines: 0 })) as OkShape

    expect(result.matches).toEqual([{ file: 'a.txt', line: 1, text: 'line1' }])
    expect(Object.prototype.hasOwnProperty.call(result.matches[0], 'kind')).toBe(false)
  })
})

describe('grep (JS fallback, forced via a nonexistent rgPath)', () => {
  it('produces the same matches as ripgrep, tagged engine: fallback', async () => {
    const dir = tempDir('scoutling-grep-fallback-')
    writeFileSync(join(dir, 'a.txt'), 'line1\nline2\n')
    const fallbackScopeRoot = resolveScopeRoot(dir)

    const fallbackTool = createGrepTool(fallbackScopeRoot, { rgPath: NONEXISTENT_RG_PATH })
    const fallbackResult = (await run(fallbackTool, { pattern: 'line1' })) as OkShape

    expect(fallbackResult.engine).toBe('fallback')
    expect(fallbackResult.matches).toContainEqual({ file: 'a.txt', line: 1, text: 'line1' })

    const rgTool = createGrepTool(fallbackScopeRoot)
    const rgResult = (await run(rgTool, { pattern: 'line1' })) as OkShape
    expect(rgResult.matches).toEqual(fallbackResult.matches)
  })

  it('is case-insensitive by default and honours caseSensitive: true, same as ripgrep', async () => {
    const dir = tempDir('scoutling-grep-fallback-case-')
    writeFileSync(join(dir, 'a.txt'), 'Needle\n')
    const tool = createGrepTool(resolveScopeRoot(dir), { rgPath: NONEXISTENT_RG_PATH })

    const insensitive = (await run(tool, { pattern: 'needle' })) as OkShape
    expect(insensitive.matches).toHaveLength(1)

    const sensitive = (await run(tool, { pattern: 'needle', caseSensitive: true })) as OkShape
    expect(sensitive.matches).toEqual([])
  })

  it('refuses a pattern longer than 200 characters, naming the bundled binary as unavailable', async () => {
    const dir = tempDir('scoutling-grep-fallback-long-pattern-')
    writeFileSync(join(dir, 'a.txt'), 'anything\n')
    const tool = createGrepTool(resolveScopeRoot(dir), { rgPath: NONEXISTENT_RG_PATH })

    const longPattern = 'a'.repeat(MAX_FALLBACK_PATTERN_CHARS + 1)
    const result = (await run(tool, { pattern: longPattern })) as RefusalShape

    expect(result.error).toBeDefined()
    expect(result.message).toMatch(/200/)
    expect(result.hint).toMatch(/ripgrep|bundled|unavailable/i)
  })

  it('returns context lines around a match, tagged engine: fallback', async () => {
    const dir = tempDir('scoutling-grep-fallback-context-')
    writeFileSync(join(dir, 'a.txt'), 'line1\nline2\nneedle3\nline4\nline5\nneedle6\nline7\nline8\n')
    const tool = createGrepTool(resolveScopeRoot(dir), { rgPath: NONEXISTENT_RG_PATH })

    const result = (await run(tool, { pattern: 'needle', contextLines: 2 })) as OkShape

    expect(result.engine).toBe('fallback')
    expect(result.matches).toEqual([
      { file: 'a.txt', line: 1, text: 'line1', kind: 'context' },
      { file: 'a.txt', line: 2, text: 'line2', kind: 'context' },
      { file: 'a.txt', line: 3, text: 'needle3', kind: 'match' },
      { file: 'a.txt', line: 4, text: 'line4', kind: 'context' },
      { file: 'a.txt', line: 5, text: 'line5', kind: 'context' },
      { file: 'a.txt', line: 6, text: 'needle6', kind: 'match' },
      { file: 'a.txt', line: 7, text: 'line7', kind: 'context' },
      { file: 'a.txt', line: 8, text: 'line8', kind: 'context' },
    ])
  })
})

describe('grep contextLines', () => {
  /**
   * Fixture where two matches (line 3, line 6) are 3 lines apart with
   * contextLines: 2 — their windows [1,5] and [4,8] overlap at lines 4-5,
   * exercising merge-without-duplication.
   */
  const OVERLAP_FIXTURE = 'line1\nline2\nneedle3\nline4\nline5\nneedle6\nline7\nline8\n'
  const OVERLAP_EXPECTED = [
    { file: 'a.txt', line: 1, text: 'line1', kind: 'context' },
    { file: 'a.txt', line: 2, text: 'line2', kind: 'context' },
    { file: 'a.txt', line: 3, text: 'needle3', kind: 'match' },
    { file: 'a.txt', line: 4, text: 'line4', kind: 'context' },
    { file: 'a.txt', line: 5, text: 'line5', kind: 'context' },
    { file: 'a.txt', line: 6, text: 'needle6', kind: 'match' },
    { file: 'a.txt', line: 7, text: 'line7', kind: 'context' },
    { file: 'a.txt', line: 8, text: 'line8', kind: 'context' },
  ]

  /**
   * Fixture with a match on line 1 (no room for leading context), two matches
   * only 1 line apart (line 3, line 4 — closer than 2*contextLines, so their
   * windows overlap heavily) and a match on the last line (no room for
   * trailing context). Verified against the real ripgrep binary's --json -C
   * output before writing this fixture (see report).
   */
  const BOUNDARY_FIXTURE = 'needleA\nline2\nneedleB\nneedleC\nline5\nline6\nneedleD\n'
  const BOUNDARY_EXPECTED = [
    { file: 'boundary.txt', line: 1, text: 'needleA', kind: 'match' },
    { file: 'boundary.txt', line: 2, text: 'line2', kind: 'context' },
    { file: 'boundary.txt', line: 3, text: 'needleB', kind: 'match' },
    { file: 'boundary.txt', line: 4, text: 'needleC', kind: 'match' },
    { file: 'boundary.txt', line: 5, text: 'line5', kind: 'context' },
    { file: 'boundary.txt', line: 6, text: 'line6', kind: 'context' },
    { file: 'boundary.txt', line: 7, text: 'needleD', kind: 'match' },
  ]

  it('ripgrep: returns match plus up to contextLines lines either side, in line order, correctly tagged', async () => {
    const dir = tempDir('scoutling-grep-ctx-rg-')
    writeFileSync(join(dir, 'a.txt'), OVERLAP_FIXTURE)
    const tool = createGrepTool(resolveScopeRoot(dir))

    const result = (await run(tool, { pattern: 'needle', contextLines: 2 })) as OkShape

    expect(result.engine).toBe('ripgrep')
    expect(result.matches).toEqual(OVERLAP_EXPECTED)
  })

  it('fallback: produces the identical entries as ripgrep for the same overlap fixture', async () => {
    const dir = tempDir('scoutling-grep-ctx-fallback-')
    writeFileSync(join(dir, 'a.txt'), OVERLAP_FIXTURE)
    const tool = createGrepTool(resolveScopeRoot(dir), { rgPath: NONEXISTENT_RG_PATH })

    const result = (await run(tool, { pattern: 'needle', contextLines: 2 })) as OkShape

    expect(result.engine).toBe('fallback')
    expect(result.matches).toEqual(OVERLAP_EXPECTED)
  })

  it('does not invent lines or go out of range at a file boundary, and a match within another match\'s context stays "match" (both engines)', async () => {
    const dirRg = tempDir('scoutling-grep-ctx-boundary-rg-')
    writeFileSync(join(dirRg, 'boundary.txt'), BOUNDARY_FIXTURE)
    const rgTool = createGrepTool(resolveScopeRoot(dirRg))
    const rgResult = (await run(rgTool, { pattern: 'needle', contextLines: 2 })) as OkShape
    expect(rgResult.engine).toBe('ripgrep')
    expect(rgResult.matches).toEqual(BOUNDARY_EXPECTED)

    const dirFallback = tempDir('scoutling-grep-ctx-boundary-fallback-')
    writeFileSync(join(dirFallback, 'boundary.txt'), BOUNDARY_FIXTURE)
    const fallbackTool = createGrepTool(resolveScopeRoot(dirFallback), { rgPath: NONEXISTENT_RG_PATH })
    const fallbackResult = (await run(fallbackTool, { pattern: 'needle', contextLines: 2 })) as OkShape
    expect(fallbackResult.engine).toBe('fallback')
    expect(fallbackResult.matches).toEqual(BOUNDARY_EXPECTED)
  })

  it('maxMatches: 1 with context returns one match plus its context, truncation reported based on matches only (both engines)', async () => {
    const dirRg = tempDir('scoutling-grep-ctx-trunc-rg-')
    writeFileSync(join(dirRg, 'boundary.txt'), BOUNDARY_FIXTURE)
    const rgTool = createGrepTool(resolveScopeRoot(dirRg))
    const rgResult = (await run(rgTool, { pattern: 'needle', contextLines: 2, maxMatches: 1 })) as OkShape
    expect(rgResult.engine).toBe('ripgrep')
    expect(rgResult.matches).toEqual([
      { file: 'boundary.txt', line: 1, text: 'needleA', kind: 'match' },
      { file: 'boundary.txt', line: 2, text: 'line2', kind: 'context' },
    ])
    expect(rgResult.matches.filter((m) => m.kind === 'match')).toHaveLength(1)
    expect(rgResult.note).toMatch(/narrow/i)

    const dirFallback = tempDir('scoutling-grep-ctx-trunc-fallback-')
    writeFileSync(join(dirFallback, 'boundary.txt'), BOUNDARY_FIXTURE)
    const fallbackTool = createGrepTool(resolveScopeRoot(dirFallback), { rgPath: NONEXISTENT_RG_PATH })
    const fallbackResult = (await run(fallbackTool, {
      pattern: 'needle',
      contextLines: 2,
      maxMatches: 1,
    })) as OkShape
    expect(fallbackResult.engine).toBe('fallback')
    expect(fallbackResult.matches).toEqual(rgResult.matches)
    expect(fallbackResult.note).toMatch(/narrow/i)
  })

  it('clamps an out-of-range contextLines instead of erroring', async () => {
    const dir = tempDir('scoutling-grep-ctx-clamp-high-')
    // 13 lines, needle in the middle: with the true cap (10) the window
    // covers the whole file; a much larger requested value must not extend
    // beyond the clamp (there'd be nothing further to show here anyway, but
    // the request itself — 99 — must not be rejected as invalid input).
    const lines = Array.from({ length: 21 }, (_, i) => (i === 10 ? 'needle' : `line${i + 1}`))
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n')
    const tool = createGrepTool(resolveScopeRoot(dir))

    const result = (await run(tool, { pattern: 'needle', contextLines: 99 })) as OkShape
    expect(result.engine).toBe('ripgrep')
    // Clamped to MAX_CONTEXT_LINES (10): match at line 11, window lines 1-21 (10 either side).
    expect(result.matches).toHaveLength(1 + 2 * MAX_CONTEXT_LINES)
    expect(result.matches.find((m) => m.line === 11)).toMatchObject({ kind: 'match' })
    expect(result.matches[0]).toMatchObject({ line: 1, kind: 'context' })
    expect(result.matches[result.matches.length - 1]).toMatchObject({ line: 21, kind: 'context' })

    const negativeResult = (await run(tool, { pattern: 'needle', contextLines: -3 })) as OkShape
    // A negative value clamps to 0 — same observable shape as the default: no `kind` key at all.
    expect(negativeResult.matches).toEqual([{ file: 'a.txt', line: 11, text: 'needle' }])
    expect(Object.prototype.hasOwnProperty.call(negativeResult.matches[0], 'kind')).toBe(false)
  })
})

describe('grep defaults', () => {
  it('exports the documented default and ceiling for maxMatches', () => {
    expect(DEFAULT_MAX_MATCHES).toBe(100)
    expect(MAX_MAX_MATCHES).toBe(500)
  })
})

describe('grep sees hidden files, same as list_dir and read_file (DESIGN.md §15, bug A)', () => {
  it('ripgrep engine finds a match inside a dot-directory', async () => {
    const dir = tempDir('scoutling-grep-hidden-')
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'NEEDLE inside hidden dir\n')
    writeFileSync(join(dir, 'plain.txt'), 'NEEDLE in a plain file\n')

    const tool = createGrepTool(resolveScopeRoot(dir))
    const result = (await run(tool, { pattern: 'NEEDLE' })) as OkShape

    expect(result.engine).toBe('ripgrep')
    expect(result.matches.map((m) => m.file).sort()).toEqual(['.github/workflows/ci.yml', 'plain.txt'])
  })

  it('ripgrep engine still excludes .git/ even though --hidden widens what it searches', async () => {
    const dir = tempDir('scoutling-grep-hidden-git-')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'NEEDLE\n')
    writeFileSync(join(dir, 'plain.txt'), 'NEEDLE\n')

    const tool = createGrepTool(resolveScopeRoot(dir))
    const result = (await run(tool, { pattern: 'NEEDLE' })) as OkShape

    expect(result.engine).toBe('ripgrep')
    expect(result.matches.map((m) => m.file)).toEqual(['plain.txt'])
  })

  it('.git/ stays excluded even when a caller-supplied excludeGlobs omits it (ALWAYS_EXCLUDED_GLOBS backstop)', async () => {
    const dir = tempDir('scoutling-grep-hidden-git-backstop-')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'NEEDLE\n')
    writeFileSync(join(dir, 'plain.txt'), 'NEEDLE\n')

    // A config layer that narrows excludeGlobs to something with no mention
    // of .git/** at all — exactly the case ALWAYS_EXCLUDED_GLOBS exists to
    // guard, since config layers replace this key rather than merging it.
    const tool = createGrepTool(resolveScopeRoot(dir), { excludeGlobs: ['some-other-dir/**'] })
    const result = (await run(tool, { pattern: 'NEEDLE' })) as OkShape

    expect(result.engine).toBe('ripgrep')
    expect(result.matches.map((m) => m.file)).toEqual(['plain.txt'])
  })

  it('ripgrep and the JS fallback agree on the same set of files for a hidden-file fixture', async () => {
    const dir = tempDir('scoutling-grep-hidden-parity-')
    mkdirSync(join(dir, '.dotdir'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.dotfile.md'), 'NEEDLE dotfile\n')
    writeFileSync(join(dir, '.dotdir', 'inside.md'), 'NEEDLE dotdir\n')
    writeFileSync(join(dir, '.git', 'HEAD'), 'NEEDLE gitobj\n')
    writeFileSync(join(dir, 'plain.md'), 'NEEDLE plain\n')

    const scope = resolveScopeRoot(dir)
    const ripgrepTool = createGrepTool(scope)
    const fallbackTool = createGrepTool(scope, { rgPath: NONEXISTENT_RG_PATH })

    const ripgrepResult = (await run(ripgrepTool, { pattern: 'NEEDLE' })) as OkShape
    const fallbackResult = (await run(fallbackTool, { pattern: 'NEEDLE' })) as OkShape

    // Assert which engine actually ran on each side — the whole point of
    // this test is proving two DIFFERENT code paths agree, not just that
    // one of them found the right files ("a test must prove the path it
    // claims", CLAUDE.md).
    expect(ripgrepResult.engine).toBe('ripgrep')
    expect(fallbackResult.engine).toBe('fallback')

    const ripgrepFiles = ripgrepResult.matches.map((m) => m.file).sort()
    const fallbackFiles = fallbackResult.matches.map((m) => m.file).sort()
    expect(ripgrepFiles).toEqual(['.dotdir/inside.md', '.dotfile.md', 'plain.md'])
    expect(fallbackFiles).toEqual(ripgrepFiles)
  })
})
