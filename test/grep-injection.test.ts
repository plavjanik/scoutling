import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { resolveScopeRoot } from '../src/guardrails.js'

/**
 * The ADR 0002 guard, and the most important test in this slice: a
 * model-chosen `pattern` starting with `-` (e.g. `--pre=sh`, which makes
 * ripgrep run a command per file) must never be parsed as a flag. This
 * asserts the actual argv passed to `execFile`, not just the tool's return
 * value, so a refactor that reorders arguments is still caught even if it
 * happens to produce the right-looking result on today's fixtures.
 */

const execFileMock = vi.fn(
  (
    _file: string,
    _args: string[],
    _options: Record<string, unknown>,
    callback: (error: unknown, result: { stdout: string; stderr: string }) => void,
  ) => {
    callback(null, { stdout: '', stderr: '' })
  },
)

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) =>
    (execFileMock as unknown as (...a: unknown[]) => unknown)(...args),
}))

const { createGrepTool } = await import('../src/tools/grep.js')

const scopeRoot = resolveScopeRoot(resolve(import.meta.dirname, 'fixtures/scope'))

/** Executes the tool the way the AI SDK does: input first, options second. */
async function run(
  tool: ReturnType<typeof createGrepTool>,
  input: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; maxMatches?: number },
): Promise<unknown> {
  if (!tool.execute) throw new Error('grep tool has no execute()')
  return tool.execute(input, { toolCallId: 'call-1', messages: [], context: {} })
}

describe('grep argument injection guard (ADR 0002/0004, mocked execFile)', () => {
  it('passes a "-"-prefixed pattern as the element immediately after -e', async () => {
    execFileMock.mockClear()
    const tool = createGrepTool(scopeRoot)
    await run(tool, { pattern: '--pre=sh' })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const call = execFileMock.mock.calls[0]
    if (!call) throw new Error('execFile was not called')
    const args = call[1] as string[]

    const eIndex = args.indexOf('-e')
    expect(eIndex).toBeGreaterThanOrEqual(0)
    expect(args[eIndex + 1]).toBe('--pre=sh')
  })

  it('places "--" after -e and its pattern, and before any path', async () => {
    execFileMock.mockClear()
    const tool = createGrepTool(scopeRoot)
    await run(tool, { pattern: '--pre=sh', path: '.' })

    const call = execFileMock.mock.calls[0]
    if (!call) throw new Error('execFile was not called')
    const args = call[1] as string[]

    const eIndex = args.indexOf('-e')
    const dashDashIndex = args.indexOf('--')
    expect(dashDashIndex).toBeGreaterThan(eIndex + 1)
    // Every path argument (everything after "--") comes after the separator.
    for (let i = dashDashIndex + 1; i < args.length; i++) {
      expect(args[i]).not.toMatch(/^-/)
    }
  })

  it('never places the raw pattern in flag position (i.e. before -e)', async () => {
    execFileMock.mockClear()
    const tool = createGrepTool(scopeRoot)
    await run(tool, { pattern: '--pre=sh' })

    const call = execFileMock.mock.calls[0]
    if (!call) throw new Error('execFile was not called')
    const args = call[1] as string[]

    const eIndex = args.indexOf('-e')
    const patternIndexes = args.reduce<number[]>((acc, arg, i) => {
      if (arg === '--pre=sh') acc.push(i)
      return acc
    }, [])
    // The pattern appears exactly once, and only right after -e.
    expect(patternIndexes).toEqual([eIndex + 1])
  })

  it('never sets shell in the execFile options', async () => {
    execFileMock.mockClear()
    const tool = createGrepTool(scopeRoot)
    await run(tool, { pattern: 'anything' })

    const call = execFileMock.mock.calls[0]
    if (!call) throw new Error('execFile was not called')
    const options = call[2] as Record<string, unknown>
    expect(options.shell).toBeUndefined()
  })
})

describe('grep argument injection guard, end-to-end against the real ripgrep binary', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats "--pre=sh" as a literal search string, not a ripgrep flag', async () => {
    // `vi.unmock` is hoisted to the top of the file like `vi.mock`, which
    // would undo the mock above before the top-level `await import` even
    // runs. `vi.doUnmock` is the non-hoisted counterpart, meant for exactly
    // this: re-importing a module without the mock from inside a test body.
    vi.doUnmock('node:child_process')
    vi.resetModules()
    const { createGrepTool: createRealGrepTool } = await import('../src/tools/grep.js')

    const dir = mkdtempSync(join(tmpdir(), 'scoutling-grep-injection-'))
    tempDirs.push(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'file.txt'), 'hello --pre=sh world\n')

    const scope = resolveScopeRoot(dir)
    const tool = createRealGrepTool(scope)
    const result = (await run(tool, { pattern: '--pre=sh' })) as {
      matches: { file: string; line: number; text: string }[]
      engine: string
    }

    // Assert the engine first: the JS fallback would ALSO match the literal
    // "--pre=sh", so without this the test passes green even if the mock
    // leaked or the binary is missing — i.e. without ever proving anything
    // about how the real ripgrep parsed its argv.
    expect(result.engine).toBe('ripgrep')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ file: 'file.txt', line: 1, text: 'hello --pre=sh world' })
  })
})
