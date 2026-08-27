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
  input: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; maxMatches?: number },
): Promise<unknown> {
  if (!tool.execute) throw new Error('grep tool has no execute()')
  return tool.execute(input, { toolCallId: 'call-1', messages: [], context: {} })
}

interface OkShape {
  pattern: string
  path: string
  matches: { file: string; line: number; text: string }[]
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
})

describe('grep defaults', () => {
  it('exports the documented default and ceiling for maxMatches', () => {
    expect(DEFAULT_MAX_MATCHES).toBe(100)
    expect(MAX_MAX_MATCHES).toBe(500)
  })
})
