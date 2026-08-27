import { describe, expect, it, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createListDirTool } from '../src/tools/list-dir.js'
import { resolveScopeRoot } from '../src/guardrails.js'

const scopeRoot = resolveScopeRoot(resolve(import.meta.dirname, 'fixtures/scope'))

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
  tool: ReturnType<typeof createListDirTool>,
  input: { path?: string; depth?: number; glob?: string },
): Promise<unknown> {
  if (!tool.execute) throw new Error('list_dir tool has no execute()')
  return tool.execute(input, { toolCallId: 'call-1', messages: [], context: {} })
}

describe('list_dir', () => {
  it('defaults to path "." and depth 1: lists the fixture top-level entries', async () => {
    const tool = createListDirTool(scopeRoot)
    const result = (await run(tool, {})) as {
      path: string
      entries: { name: string; type: string; size: number }[]
    }

    const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]))
    expect(byName.sub?.type).toBe('dir')
    expect(byName['a.txt']?.type).toBe('file')
    expect(byName['a.txt']?.size).toBeGreaterThan(0)
    // depth 1 must not surface anything inside sub/
    expect(result.entries.some((e) => e.name.startsWith('sub/'))).toBe(false)
  })

  it('depth 2 surfaces sub/nested.txt; depth 1 does not', async () => {
    const tool = createListDirTool(scopeRoot)
    const depth1 = (await run(tool, { depth: 1 })) as { entries: { name: string }[] }
    const depth2 = (await run(tool, { depth: 2 })) as { entries: { name: string }[] }

    expect(depth1.entries.some((e) => e.name === 'sub/nested.txt')).toBe(false)
    expect(depth2.entries.some((e) => e.name === 'sub/nested.txt')).toBe(true)
  })

  it('clamps an out-of-range depth to 3 rather than refusing or honouring it', async () => {
    const dir = tempDir('scoutling-listdir-depth-')
    mkdirSync(join(dir, 'a', 'b', 'c', 'd'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'c', 'd', 'deep.txt'), 'x')

    const tool = createListDirTool(resolveScopeRoot(dir))
    const result = (await run(tool, { depth: 9 })) as { entries: { name: string }[] }

    // depth 3 reaches a/b/c but not a/b/c/d/deep.txt
    expect(result.entries.some((e) => e.name === 'a/b/c')).toBe(true)
    expect(result.entries.some((e) => e.name === 'a/b/c/d/deep.txt')).toBe(false)
  })

  it('a glob filters output but still traverses beneath it', async () => {
    const tool = createListDirTool(scopeRoot)
    const result = (await run(tool, { depth: 2, glob: '*.txt' })) as {
      entries: { name: string }[]
    }

    expect(result.entries.every((e) => e.name.endsWith('.txt'))).toBe(true)
    expect(result.entries.some((e) => e.name === 'sub/nested.txt')).toBe(true)
    expect(result.entries.some((e) => e.name === 'sub')).toBe(false)
  })

  it('a glob matching nothing yields an empty list and a note naming the glob', async () => {
    const tool = createListDirTool(scopeRoot)
    const result = (await run(tool, { glob: '*.nope' })) as {
      entries: unknown[]
      note?: string
    }

    expect(result.entries).toEqual([])
    expect(result.note).toBeDefined()
    expect(result.note).toContain('*.nope')
  })

  it('an empty directory gets a note saying it is empty', async () => {
    const dir = tempDir('scoutling-listdir-empty-')
    mkdirSync(join(dir, 'empty'))

    const tool = createListDirTool(resolveScopeRoot(dir))
    const result = (await run(tool, { path: 'empty' })) as { entries: unknown[]; note?: string }

    expect(result.entries).toEqual([])
    expect(result.note).toMatch(/empty/i)
  })

  it('excludeGlobs from the factory prunes a directory', async () => {
    const dir = tempDir('scoutling-listdir-exclude-')
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x')
    writeFileSync(join(dir, 'keep.txt'), 'x')

    const tool = createListDirTool(resolveScopeRoot(dir), { excludeGlobs: ['node_modules/**'] })
    const result = (await run(tool, {})) as { entries: { name: string }[] }

    expect(result.entries.some((e) => e.name === 'node_modules')).toBe(false)
    expect(result.entries.some((e) => e.name === 'keep.txt')).toBe(true)
  })

  it('a .gitignore in a temp tree is honoured', async () => {
    const dir = tempDir('scoutling-listdir-gitignore-')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(dir, 'ignored.txt'), 'x')
    writeFileSync(join(dir, 'kept.txt'), 'x')

    const tool = createListDirTool(resolveScopeRoot(dir))
    const result = (await run(tool, {})) as { entries: { name: string }[] }

    expect(result.entries.some((e) => e.name === 'ignored.txt')).toBe(false)
    expect(result.entries.some((e) => e.name === 'kept.txt')).toBe(true)
  })

  it('truncates a tree of 600 files to exactly 500 entries with a note mentioning 500', async () => {
    const dir = tempDir('scoutling-listdir-truncate-')
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x')
    }

    const tool = createListDirTool(resolveScopeRoot(dir))
    const result = (await run(tool, {})) as { entries: unknown[]; note?: string }

    expect(result.entries).toHaveLength(500)
    expect(result.note).toContain('500')
  })

  it('a tree of exactly 500 files returns 500 entries and no truncation note', async () => {
    const dir = tempDir('scoutling-listdir-exact-')
    for (let i = 0; i < 500; i++) {
      writeFileSync(join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x')
    }

    const tool = createListDirTool(resolveScopeRoot(dir))
    const result = (await run(tool, {})) as { entries: unknown[]; note?: string }

    expect(result.entries).toHaveLength(500)
    expect(result.note).toBeUndefined()
  })

  it('refuses a path outside the scope root, without throwing', async () => {
    const tool = createListDirTool(scopeRoot)
    const result = (await run(tool, { path: '../outside' })) as { error: string; message: string }

    expect(result.error).toBeDefined()
    expect(result.message).toBeDefined()
  })

  it('refuses a nonexistent path with PATH_NOT_FOUND', async () => {
    const tool = createListDirTool(scopeRoot)
    const result = (await run(tool, { path: 'nope' })) as { error: string; message: string }

    expect(result.error).toBe('PATH_NOT_FOUND')
  })

  it('refuses a file path with NOT_A_DIRECTORY', async () => {
    const tool = createListDirTool(scopeRoot)
    const result = (await run(tool, { path: 'a.txt' })) as { error: string; message: string }

    expect(result.error).toBe('NOT_A_DIRECTORY')
  })

  it('never throws for any refusal input', async () => {
    const tool = createListDirTool(scopeRoot)
    if (!tool.execute) throw new Error('list_dir tool has no execute()')

    await expect(
      tool.execute({ path: '../outside' }, { toolCallId: 'c1', messages: [], context: {} }),
    ).resolves.toBeDefined()
    await expect(
      tool.execute({ path: 'nope' }, { toolCallId: 'c2', messages: [], context: {} }),
    ).resolves.toBeDefined()
    await expect(
      tool.execute({ path: 'a.txt' }, { toolCallId: 'c3', messages: [], context: {} }),
    ).resolves.toBeDefined()
  })
})
