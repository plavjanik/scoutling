import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createReadFileTool } from '../src/tools/read-file.js'
import { resolveScopeRoot } from '../src/guardrails.js'

const scopeRoot = resolveScopeRoot(resolve(import.meta.dirname, 'fixtures/scope'))

/** Executes the tool the way the AI SDK does: input first, options second. */
async function run(
  tool: ReturnType<typeof createReadFileTool>,
  input: { path: string; offset?: number; limit?: number },
): Promise<unknown> {
  if (!tool.execute) throw new Error('read_file tool has no execute()')
  return tool.execute(input, { toolCallId: 'call-1', messages: [], context: {} })
}

describe('read_file', () => {
  it('returns line-numbered content and the total line count', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: 'numbers.txt' })) as {
      content: string
      totalLines: number
    }

    expect(result.totalLines).toBe(10)
    expect(result.content).toContain('   1→line 1')
    expect(result.content).toContain('  10→line 10')
  })

  it('paginates with offset and limit', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: 'numbers.txt', offset: 3, limit: 2 })) as {
      content: string
      totalLines: number
    }

    expect(result.totalLines).toBe(10)
    expect(result.content).toContain('   3→line 3')
    expect(result.content).toContain('   4→line 4')
    expect(result.content).not.toContain('line 2')
    expect(result.content).not.toContain('line 5')
  })

  it('defaults to offset 1 and limit 400', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: 'numbers.txt' })) as { content: string }

    expect(result.content).toContain('   1→line 1')
  })

  it('clamps limit to 2000 even if a larger value is requested', async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), 'scoutling-readfile-'))
    try {
      const bigFile = join(scopeDir, 'big.txt')
      const lineCount = 2500
      writeFileSync(bigFile, Array.from({ length: lineCount }, (_, i) => `l${i + 1}`).join('\n'))

      const tool = createReadFileTool(resolveScopeRoot(scopeDir))
      const result = (await run(tool, { path: 'big.txt', limit: 100_000 })) as {
        content: string
        totalLines: number
      }

      expect(result.totalLines).toBe(lineCount)
      expect(result.content).toContain('   1→l1')
      expect(result.content).toContain('2000→l2000')
      expect(result.content).not.toContain('→l2001')
    } finally {
      rmSync(scopeDir, { recursive: true, force: true })
    }
  })

  it('is a definitive empty state for a request past the end of the file, not a crash', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: 'numbers.txt', offset: 999 })) as {
      content: string
      totalLines: number
      note?: string
    }

    expect(result.totalLines).toBe(10)
    expect(result.content).toBe('')
    expect(result.note).toMatch(/past the end/i)
  })

  it('is a definitive empty state for an empty file', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: 'empty.txt' })) as {
      content: string
      totalLines: number
      note?: string
    }

    expect(result.totalLines).toBe(0)
    expect(result.content).toBe('')
    expect(result.note).toMatch(/empty/i)
  })

  it('refuses a binary file with an actionable message', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: 'binary.bin' })) as {
      error: string
      message: string
      hint?: string
    }

    expect(result.error).toBeDefined()
    expect(result.message).toMatch(/binary/i)
  })

  it('refuses a file larger than 2 MB with an actionable message', async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), 'scoutling-readfile-big-'))
    try {
      writeFileSync(join(scopeDir, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024 + 1))
      const tool = createReadFileTool(resolveScopeRoot(scopeDir))
      const result = (await run(tool, { path: 'huge.txt' })) as { error: string; message: string }

      expect(result.error).toBeDefined()
      expect(result.message).toMatch(/2 ?MB|large|size/i)
    } finally {
      rmSync(scopeDir, { recursive: true, force: true })
    }
  })

  it('refuses a path outside the scope root', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: '../../etc/passwd' })) as {
      error: string
      message: string
    }

    expect(result.error).toBe('PATH_NOT_FOUND')
  })

  it('refuses a path that does not exist', async () => {
    const tool = createReadFileTool(scopeRoot)
    const result = (await run(tool, { path: 'nope.txt' })) as { error: string; message: string }

    expect(result.error).toBeDefined()
    expect(result.message).toMatch(/not found|does not exist/i)
  })
})

/**
 * DESIGN.md §15 "bug B": before this fix, read_file was the one of the
 * three tools that ignored `excludeGlobs`, `.gitignore` and `.git/`
 * entirely — it would happily read `.git/HEAD` or a gitignored secret file
 * that `list_dir` would never surface. `PATH_EXCLUDED` closes that gap and
 * is checked before `PATH_NOT_FOUND` (visibility is a property of the path,
 * not of whether it currently exists).
 */
describe('read_file honours excludeGlobs, .gitignore and .git/ (DESIGN.md §15, bug B)', () => {
  it('refuses a path under .git/ even with no excludeGlobs passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoutling-readfile-git-'))
    try {
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

      const tool = createReadFileTool(resolveScopeRoot(dir))
      const result = (await run(tool, { path: '.git/HEAD' })) as { error: string; message: string; hint?: string }

      expect(result.error).toBe('PATH_EXCLUDED')
      expect(result.message).toMatch(/\.git\//)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a path matched by excludeGlobs, naming the matching glob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoutling-readfile-excludeglobs-'))
    try {
      mkdirSync(join(dir, 'excluded'), { recursive: true })
      writeFileSync(join(dir, 'excluded', 'f.md'), 'x')

      const tool = createReadFileTool(resolveScopeRoot(dir), { excludeGlobs: ['excluded/**'] })
      const result = (await run(tool, { path: 'excluded/f.md' })) as {
        error: string
        message: string
        hint?: string
      }

      expect(result.error).toBe('PATH_EXCLUDED')
      expect(result.message).toContain('excluded/**')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a gitignored path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoutling-readfile-gitignore-'))
    try {
      writeFileSync(join(dir, '.gitignore'), 'secret.env\n')
      writeFileSync(join(dir, 'secret.env'), 'sh')

      const tool = createReadFileTool(resolveScopeRoot(dir))
      const result = (await run(tool, { path: 'secret.env' })) as { error: string; message: string }

      expect(result.error).toBe('PATH_EXCLUDED')
      expect(result.message).toMatch(/gitignor/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still reads a visible file when excludeGlobs is set but does not match it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoutling-readfile-visible-'))
    try {
      writeFileSync(join(dir, 'plain.txt'), 'hello\n')

      const tool = createReadFileTool(resolveScopeRoot(dir), { excludeGlobs: ['excluded/**'] })
      const result = (await run(tool, { path: 'plain.txt' })) as { content: string; error?: string }

      expect(result.error).toBeUndefined()
      expect(result.content).toContain('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
