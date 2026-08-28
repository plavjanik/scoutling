import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { BUILT_IN_DEFAULTS } from '../src/config.js'
import { resolveScopeRoot } from '../src/guardrails.js'
import { createGrepTool, type GrepResult } from '../src/tools/grep.js'
import { createListDirTool } from '../src/tools/list-dir.js'
import { createReadFileTool } from '../src/tools/read-file.js'

/**
 * The invariant this file exists to prove (DESIGN.md §6, §15; CLAUDE.md's
 * "Conventions already established in code"): `read_file`, `list_dir` and
 * `grep` must all agree on what's visible in the scope. Before this fix they
 * did not — see the "Measured evidence" table this fixture reproduces:
 * `grep` was blind to hidden files (bug A) and `read_file` ignored
 * `excludeGlobs`/`.gitignore`/`.git/` entirely (bug B).
 *
 * Each target carries a unique marker string as its entire file content, so
 * "is this file visible" can be asked the same way of all three tools:
 * `read_file` either returns the marker or refuses; `list_dir` either lists
 * the path or doesn't; `grep` either matches the marker at that path or
 * doesn't. `.git/HEAD` is included as a real path in both fixture variants
 * (a genuine `git init` checkout, and a plain directory that merely
 * *contains* a `.git`-named directory) — the marker is written into it
 * either way so grep's exclusion of it is actually exercised, not just
 * assumed true because the file happened to contain no matchable text.
 */
const TARGETS = [
  { path: 'plain.md', marker: 'MARKER_PLAIN', visible: true },
  { path: '.dotfile.md', marker: 'MARKER_DOTFILE', visible: true },
  { path: '.dotdir/inside.md', marker: 'MARKER_DOTDIR', visible: true },
  { path: '.github/workflows/ci.yml', marker: 'MARKER_GITHUB', visible: true },
  { path: 'secret.env', marker: 'MARKER_SECRET', visible: false },
  { path: 'ignored-dir/f.md', marker: 'MARKER_IGNOREDDIR', visible: false },
  { path: 'excluded/f.md', marker: 'MARKER_EXCLUDED', visible: false },
  { path: '.git/HEAD', marker: 'MARKER_GITHEAD', visible: false },
] as const

/** `excludeGlobs` for every fixture: the operator's built-in defaults plus one config-narrowed entry, per the task's frozen fixture spec. */
const EXCLUDE_GLOBS = [...BUILT_IN_DEFAULTS.excludeGlobs, 'excluded/**']

/**
 * Builds the fixture tree at `root`. `git: true` makes `root` a real `git
 * init` checkout (so `.git/HEAD` is git's own file, then overwritten with
 * the marker); `git: false` leaves `root` a plain directory that merely has
 * a `.git`-named subdirectory with no real git plumbing underneath it — the
 * point being that `.git/` exclusion is structural (`ALWAYS_EXCLUDED_GLOBS`)
 * and must hold in both cases, not just inside a genuine checkout.
 */
function buildFixture(root: string, options: { git: boolean }): void {
  if (options.git) {
    execFileSync('git', ['init', '-q'], { cwd: root })
  } else {
    mkdirSync(join(root, '.git'), { recursive: true })
  }

  for (const target of TARGETS) {
    const absPath = join(root, ...target.path.split('/'))
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, `${target.marker}\n`)
  }

  // Governs secret.env and ignored-dir/** — matches the task's fixture spec.
  // matched by excludeGlobs separately, via EXCLUDE_GLOBS above.
  writeFileSync(join(root, '.gitignore'), 'secret.env\nignored-dir/\n')
}

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** Untyped result, matching the `run()` helper convention in the sibling *.test.ts files — the caller casts to whichever of the result/refusal shapes it expects. */
async function runReadFile(tool: ReturnType<typeof createReadFileTool>, path: string): Promise<unknown> {
  if (!tool.execute) throw new Error('read_file tool has no execute()')
  return tool.execute({ path }, { toolCallId: 'call-1', messages: [], context: {} })
}

async function runListDir(tool: ReturnType<typeof createListDirTool>): Promise<unknown> {
  if (!tool.execute) throw new Error('list_dir tool has no execute()')
  return tool.execute({ path: '.', depth: 3 }, { toolCallId: 'call-1', messages: [], context: {} })
}

async function runGrep(tool: ReturnType<typeof createGrepTool>): Promise<unknown> {
  if (!tool.execute) throw new Error('grep tool has no execute()')
  return tool.execute(
    { pattern: 'MARKER_', path: '.', maxMatches: 50 },
    { toolCallId: 'call-1', messages: [], context: {} },
  )
}

/** Same as `runGrep`, but searches the given `path` directly — the axis this file's second table exercises. */
async function runGrepAt(tool: ReturnType<typeof createGrepTool>, path: string): Promise<unknown> {
  if (!tool.execute) throw new Error('grep tool has no execute()')
  return tool.execute(
    { pattern: 'MARKER_', path, maxMatches: 50 },
    { toolCallId: 'call-1', messages: [], context: {} },
  )
}

async function runListDirAt(tool: ReturnType<typeof createListDirTool>, path: string): Promise<unknown> {
  if (!tool.execute) throw new Error('list_dir tool has no execute()')
  return tool.execute({ path, depth: 1 }, { toolCallId: 'call-1', messages: [], context: {} })
}

describe.each([
  { label: 'a real git init checkout', git: true },
  { label: 'not a git checkout', git: false },
])('tool visibility invariant ($label)', ({ git }) => {
  let scopeRoot: string
  let readFileTool: ReturnType<typeof createReadFileTool>
  let listDirTool: ReturnType<typeof createListDirTool>
  let grepTool: ReturnType<typeof createGrepTool>
  let listedNames: Set<string>
  let grepFiles: Set<string>

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'scoutling-visibility-'))
    tempDirs.push(root)
    buildFixture(root, { git })
    scopeRoot = resolveScopeRoot(root)

    readFileTool = createReadFileTool(scopeRoot, { excludeGlobs: EXCLUDE_GLOBS })
    listDirTool = createListDirTool(scopeRoot, { excludeGlobs: EXCLUDE_GLOBS })
    grepTool = createGrepTool(scopeRoot, { excludeGlobs: EXCLUDE_GLOBS })

    const listResult = (await runListDir(listDirTool)) as { entries: { name: string }[] }
    listedNames = new Set(listResult.entries.map((e) => e.name))

    const grepResult = (await runGrep(grepTool)) as GrepResult | { error: string; message: string }
    // A refusal shape has no `matches` — fail loudly rather than silently
    // treating "grep errored" as "grep found nothing".
    if (!('matches' in grepResult)) throw new Error(`grep refused: ${JSON.stringify(grepResult)}`)
    grepFiles = new Set(grepResult.matches.map((m) => m.file))
  })

  it.each(TARGETS)('$path: read_file, list_dir and grep all agree ($visible)', async (target) => {
    const readResult = (await runReadFile(readFileTool, target.path)) as { content?: string; error?: string }
    const readVisible = readResult.error === undefined
    const listVisible = listedNames.has(target.path)
    const grepVisible = grepFiles.has(target.path)

    // The actual invariant: all three AGREE with each other, not just each
    // individually happening to match `target.visible`. A test that checked
    // each tool separately against `target.visible` could still pass while
    // the tools disagreed with each other in some other, untested way; this
    // asserts the agreement directly.
    expect({ readVisible, listVisible, grepVisible }).toEqual({
      readVisible: target.visible,
      listVisible: target.visible,
      grepVisible: target.visible,
    })

    if (target.visible) {
      expect(readResult.content).toContain(target.marker)
    } else {
      expect(readResult.error).toBe('PATH_EXCLUDED')
    }
  })
})

/**
 * Second axis, added 2026-08-28 as a follow-up to the fix above: the table
 * above only ever asks each tool about a path it *discovered itself* by
 * traversal (`list_dir`'s own walk, `grep`'s own search of `.`). It never
 * pointed a tool directly at an excluded path — and until this follow-up,
 * neither `grep` nor `list_dir` checked their model-supplied `path` argument
 * against `explainPathExclusion` at all, only the results a traversal
 * produced under it. That left an explicitly-named excluded path completely
 * unguarded:
 *
 * - `grep(pattern, path: 'secret.env')` returned a real match — a genuine
 *   content leak, not just an inconsistency, because ripgrep searches an
 *   explicitly-named file or directory regardless of any `--glob` flag (see
 *   `runRipgrep`'s doc comment in `grep.ts`), so no ripgrep flag could ever
 *   have caught this; it has to be refused before either backend runs.
 * - `list_dir(path: '.git')` / `path: 'excluded'` / `path: 'ignored-dir'`
 *   returned `{entries: []}` — a false *definitive empty state* (AXI
 *   principle 5): "you may not look here" rendered indistinguishably from
 *   "this directory genuinely has nothing in it."
 *
 * This block asks each tool directly, mirroring the fixture and
 * `git`/non-`git` variants above rather than duplicating them.
 */
const EXCLUDED_FILE_TARGETS = [
  { path: 'secret.env' },
  { path: 'ignored-dir/f.md' },
  { path: 'excluded/f.md' },
  { path: '.git/HEAD' },
] as const

const EXCLUDED_DIR_TARGETS = [{ path: '.git' }, { path: 'excluded' }, { path: 'ignored-dir' }] as const

const VISIBLE_FILE_PATH = 'plain.md'
/** `.dotdir` is a plain visible directory in the fixture (built implicitly by `.dotdir/inside.md`). */
const VISIBLE_DIR_PATH = '.dotdir'

describe.each([
  { label: 'a real git init checkout', git: true },
  { label: 'not a git checkout', git: false },
])('explicit excluded path is refused, not just traversal results ($label)', ({ git }) => {
  let scopeRoot: string
  let readFileTool: ReturnType<typeof createReadFileTool>
  let listDirTool: ReturnType<typeof createListDirTool>
  let grepTool: ReturnType<typeof createGrepTool>

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'scoutling-visibility-explicit-'))
    tempDirs.push(root)
    buildFixture(root, { git })
    scopeRoot = resolveScopeRoot(root)

    readFileTool = createReadFileTool(scopeRoot, { excludeGlobs: EXCLUDE_GLOBS })
    listDirTool = createListDirTool(scopeRoot, { excludeGlobs: EXCLUDE_GLOBS })
    grepTool = createGrepTool(scopeRoot, { excludeGlobs: EXCLUDE_GLOBS })
  })

  it.each(EXCLUDED_FILE_TARGETS)('$path named directly: read_file and grep both refuse PATH_EXCLUDED', async (target) => {
    const readResult = (await runReadFile(readFileTool, target.path)) as { error?: string; content?: string }
    const grepResult = (await runGrepAt(grepTool, target.path)) as {
      error?: string
      matches?: unknown[]
    }

    expect(readResult.error).toBe('PATH_EXCLUDED')
    expect(readResult.content).toBeUndefined()

    // Assert the refusal SHAPE directly, not just "grep returned some error"
    // — a shallow "no matches leaked" check could pass by accident if grep
    // returned `{matches: [...], someOtherField: 'PATH_EXCLUDED'}`. This is
    // the exact leak the bug produced: matches returned despite exclusion.
    expect(grepResult.error).toBe('PATH_EXCLUDED')
    expect(grepResult.matches).toBeUndefined()
  })

  it.each(EXCLUDED_DIR_TARGETS)(
    '$path named directly: read_file, grep and list_dir all refuse PATH_EXCLUDED',
    async (target) => {
      const readResult = (await runReadFile(readFileTool, target.path)) as { error?: string }
      const grepResult = (await runGrepAt(grepTool, target.path)) as { error?: string; matches?: unknown[] }
      const listResult = (await runListDirAt(listDirTool, target.path)) as {
        error?: string
        entries?: unknown[]
      }

      expect(readResult.error).toBe('PATH_EXCLUDED')

      expect(grepResult.error).toBe('PATH_EXCLUDED')
      expect(grepResult.matches).toBeUndefined()

      // The list_dir-specific half of the bug: this used to be
      // `{entries: [], note: 'directory is empty'}` — a false definitive
      // empty state — instead of a refusal.
      expect(listResult.error).toBe('PATH_EXCLUDED')
      expect(listResult.entries).toBeUndefined()
    },
  )

  it('a visible file and a visible directory are still accepted by all three (no false positives)', async () => {
    const readFileResult = (await runReadFile(readFileTool, VISIBLE_FILE_PATH)) as { error?: string; content?: string }
    const grepOnFileResult = (await runGrepAt(grepTool, VISIBLE_FILE_PATH)) as { error?: string; matches?: unknown[] }
    const grepOnDirResult = (await runGrepAt(grepTool, VISIBLE_DIR_PATH)) as { error?: string; matches?: unknown[] }
    const listDirResult = (await runListDirAt(listDirTool, VISIBLE_DIR_PATH)) as { error?: string; entries?: unknown[] }

    expect(readFileResult.error).toBeUndefined()
    expect(readFileResult.content).toContain('MARKER_PLAIN')

    expect(grepOnFileResult.error).toBeUndefined()
    expect(grepOnFileResult.matches).toEqual([{ file: VISIBLE_FILE_PATH, line: 1, text: 'MARKER_PLAIN' }])

    expect(grepOnDirResult.error).toBeUndefined()
    expect(grepOnDirResult.matches).toEqual([{ file: `${VISIBLE_DIR_PATH}/inside.md`, line: 1, text: 'MARKER_DOTDIR' }])

    expect(listDirResult.error).toBeUndefined()
    expect(listDirResult.entries).toEqual([{ name: 'inside.md', type: 'file', size: expect.any(Number) }])
  })
})
