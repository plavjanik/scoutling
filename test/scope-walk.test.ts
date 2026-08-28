import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ALWAYS_EXCLUDED_GLOBS,
  explainPathExclusion,
  isPathVisible,
  matchesGlob,
  walkScope,
  type WalkEntry,
} from '../src/scope-walk.js'

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

/** Sorts entries by path only for assertions that don't care about order. */
function paths(entries: WalkEntry[]): string[] {
  return entries.map((entry) => entry.path)
}

describe('matchesGlob', () => {
  it('matches the zero-directory case for a/**/b', () => {
    expect(matchesGlob('a/**/b', 'a/b')).toBe(true)
  })

  it('matches a/**/b against one intervening directory', () => {
    expect(matchesGlob('a/**/b', 'a/x/b')).toBe(true)
  })

  it('matches a/**/b against two intervening directories', () => {
    expect(matchesGlob('a/**/b', 'a/x/y/b')).toBe(true)
  })

  it('does not match a/**/b against an unrelated path', () => {
    expect(matchesGlob('a/**/b', 'a/x/c')).toBe(false)
  })

  it('? matches exactly one non-separator character', () => {
    expect(matchesGlob('a?c', 'abc')).toBe(true)
    expect(matchesGlob('a?c', 'ac')).toBe(false)
    expect(matchesGlob('a?c', 'abbc')).toBe(false)
  })

  it('? never matches a path separator', () => {
    expect(matchesGlob('a?c', 'a/c')).toBe(false)
  })

  it('a glob with no slash matches the basename', () => {
    expect(matchesGlob('*.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('*.ts', 'a.ts')).toBe(true)
  })

  it('a glob with a slash matches the whole relative path', () => {
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('src/*.ts', 'other/a.ts')).toBe(false)
  })

  it('a literal regex metacharacter in the glob is matched literally', () => {
    expect(matchesGlob('a+b.txt', 'a+b.txt')).toBe(true)
    expect(matchesGlob('a+b.txt', 'aab.txt')).toBe(false) // would match if '+' were a regex quantifier
    expect(matchesGlob('a+b.txt', 'b.txt')).toBe(false)
  })

  it('bare directory name matches the directory itself (basename form)', () => {
    expect(matchesGlob('node_modules', 'node_modules')).toBe(true)
    expect(matchesGlob('node_modules', 'src/node_modules')).toBe(true)
  })

  it('matches the zero-directory case for a leading **/', () => {
    expect(matchesGlob('**/foo.ts', 'foo.ts')).toBe(true)
  })

  it('matches a leading **/ against one intervening directory', () => {
    expect(matchesGlob('**/foo.ts', 'a/foo.ts')).toBe(true)
  })

  it('matches a leading **/ against two intervening directories', () => {
    expect(matchesGlob('**/foo.ts', 'a/b/foo.ts')).toBe(true)
  })

  it('discriminates correctly per path across repeated calls with the same glob (cache safety)', () => {
    expect(matchesGlob('*.ts', 'a.ts')).toBe(true)
    expect(matchesGlob('*.ts', 'a.js')).toBe(false)
    expect(matchesGlob('*.ts', 'b.ts')).toBe(true)
  })
})

describe('walkScope', () => {
  it('lists only dir\'s own entries at depth 1', () => {
    const root = tempDir('scoutling-walk-depth-')
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'b.txt'), 'b')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 1, limit: 100 })

    expect(paths(result.entries).sort()).toEqual(['a.txt', 'sub'])
    expect(result.truncated).toBe(false)
  })

  it('descends one more level at depth 2', () => {
    const root = tempDir('scoutling-walk-depth2-')
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'b.txt'), 'b')
    mkdirSync(join(root, 'sub', 'deeper'))
    writeFileSync(join(root, 'sub', 'deeper', 'c.txt'), 'c')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 2, limit: 100 })

    expect(paths(result.entries).sort()).toEqual(['a.txt', 'sub', 'sub/b.txt', 'sub/deeper'])
  })

  it('descends three levels at depth 3', () => {
    const root = tempDir('scoutling-walk-depth3-')
    mkdirSync(join(root, 'sub'))
    mkdirSync(join(root, 'sub', 'deeper'))
    writeFileSync(join(root, 'sub', 'deeper', 'c.txt'), 'c')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 3, limit: 100 })

    expect(paths(result.entries).sort()).toEqual(['sub', 'sub/deeper', 'sub/deeper/c.txt'])
  })

  it('walks unbounded with Number.POSITIVE_INFINITY', () => {
    const root = tempDir('scoutling-walk-unbounded-')
    let current = root
    for (let i = 0; i < 6; i++) {
      current = join(current, `level${i}`)
      mkdirSync(current)
    }
    writeFileSync(join(current, 'deep.txt'), 'deep')

    const result = walkScope({
      scopeRoot: root,
      dir: root,
      depth: Number.POSITIVE_INFINITY,
      limit: 1000,
    })

    expect(paths(result.entries)).toContain(
      'level0/level1/level2/level3/level4/level5/deep.txt',
    )
    expect(result.truncated).toBe(false)
  })

  it('truncates exactly at limit and reports truncated: true', () => {
    const root = tempDir('scoutling-walk-limit-')
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, `f${i}.txt`), 'x')
    }

    const result = walkScope({ scopeRoot: root, dir: root, depth: 1, limit: 4 })

    expect(result.entries).toHaveLength(4)
    expect(result.truncated).toBe(true)
  })

  it('does not report truncated when the walk ends exactly at the limit (exact fit)', () => {
    const root = tempDir('scoutling-walk-exact-fit-')
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, `f${i}.txt`), 'x')
    }

    const result = walkScope({ scopeRoot: root, dir: root, depth: 1, limit: 4 })

    expect(result.entries).toHaveLength(4)
    expect(result.truncated).toBe(false)
  })

  it('truncates at limit - 1 when one more entry than the limit would exist', () => {
    const root = tempDir('scoutling-walk-exact-fit-minus-one-')
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, `f${i}.txt`), 'x')
    }

    const result = walkScope({ scopeRoot: root, dir: root, depth: 1, limit: 3 })

    expect(result.entries).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('does not truncate when the limit is not hit', () => {
    const root = tempDir('scoutling-walk-no-limit-')
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, `f${i}.txt`), 'x')
    }

    const result = walkScope({ scopeRoot: root, dir: root, depth: 1, limit: 100 })

    expect(result.entries).toHaveLength(3)
    expect(result.truncated).toBe(false)
  })

  it('always prunes .git, even with no excludeGlobs passed', () => {
    const root = tempDir('scoutling-walk-git-')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(root, 'a.txt'), 'a')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 5, limit: 100 })

    expect(paths(result.entries)).toEqual(['a.txt'])
  })

  it('prunes a directory matched by the node_modules/** exclude glob form', () => {
    const root = tempDir('scoutling-walk-exclude-glob-star-')
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'pkg.js'), 'x')
    writeFileSync(join(root, 'a.txt'), 'a')

    const result = walkScope({
      scopeRoot: root,
      dir: root,
      depth: 5,
      limit: 100,
      excludeGlobs: ['node_modules/**'],
    })

    expect(paths(result.entries)).toEqual(['a.txt'])
  })

  it('prunes a directory matched by the bare node_modules exclude glob form', () => {
    const root = tempDir('scoutling-walk-exclude-glob-bare-')
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'pkg.js'), 'x')
    writeFileSync(join(root, 'a.txt'), 'a')

    const result = walkScope({
      scopeRoot: root,
      dir: root,
      depth: 5,
      limit: 100,
      excludeGlobs: ['node_modules'],
    })

    expect(paths(result.entries)).toEqual(['a.txt'])
  })

  it('honours a nested .gitignore', () => {
    const root = tempDir('scoutling-walk-gitignore-nested-')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(root, 'sub', 'ignored.txt'), 'x')
    writeFileSync(join(root, 'sub', 'kept.txt'), 'x')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 5, limit: 100 })

    expect(paths(result.entries).sort()).toEqual(['sub', 'sub/.gitignore', 'sub/kept.txt'])
  })

  it('honours the scope root .gitignore even when walking a subdirectory', () => {
    const root = tempDir('scoutling-walk-gitignore-root-')
    writeFileSync(join(root, '.gitignore'), 'sub/ignored.txt\n')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'ignored.txt'), 'x')
    writeFileSync(join(root, 'sub', 'kept.txt'), 'x')

    const result = walkScope({
      scopeRoot: root,
      dir: join(root, 'sub'),
      depth: 5,
      limit: 100,
    })

    expect(paths(result.entries).sort()).toEqual(['kept.txt'])
  })

  it('honours a negated gitignore pattern', () => {
    const root = tempDir('scoutling-walk-gitignore-negated-')
    writeFileSync(join(root, '.gitignore'), '*.txt\n!keep.txt\n')
    writeFileSync(join(root, 'drop.txt'), 'x')
    writeFileSync(join(root, 'keep.txt'), 'x')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 5, limit: 100 })

    expect(paths(result.entries).sort()).toEqual(['.gitignore', 'keep.txt'])
  })

  it('filters output by glob without blocking traversal through non-matching directories', () => {
    const root = tempDir('scoutling-walk-glob-filter-')
    mkdirSync(join(root, 'js-dir'))
    mkdirSync(join(root, 'js-dir', 'more'))
    writeFileSync(join(root, 'js-dir', 'more', 'found.ts'), 'x')
    writeFileSync(join(root, 'js-dir', 'skip.js'), 'x')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 3, glob: '*.ts', limit: 100 })

    const filePaths = result.entries.filter((e) => e.type === 'file').map((e) => e.path)
    expect(filePaths).toEqual(['js-dir/more/found.ts'])
  })

  it('is deterministic: breadth-first by depth, sorted by name within a directory', () => {
    const root = tempDir('scoutling-walk-order-')
    writeFileSync(join(root, 'b.txt'), 'b')
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'z-dir'))
    writeFileSync(join(root, 'z-dir', 'inner.txt'), 'x')
    mkdirSync(join(root, 'm-dir'))
    writeFileSync(join(root, 'm-dir', 'inner.txt'), 'x')

    const result = walkScope({ scopeRoot: root, dir: root, depth: 2, limit: 100 })

    expect(paths(result.entries)).toEqual([
      'a.txt',
      'b.txt',
      'm-dir',
      'z-dir',
      'm-dir/inner.txt',
      'z-dir/inner.txt',
    ])
  })

  it('reports a symlink as its own entry and never recurses into it', () => {
    const root = tempDir('scoutling-walk-symlink-')
    const target = tempDir('scoutling-walk-symlink-target-')
    writeFileSync(join(target, 'secret.txt'), 'shh')

    symlinkSync(target, join(root, 'link'))

    const result = walkScope({ scopeRoot: root, dir: root, depth: 5, limit: 100 })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toEqual({ path: 'link', type: 'file', size: 0 })
  })
})

describe('isPathVisible / explainPathExclusion (DESIGN.md §6, §15 — the shared visibility rule read_file now applies too)', () => {
  it('exports .git/** as the structural, always-on exclusion', () => {
    expect(ALWAYS_EXCLUDED_GLOBS).toEqual(['.git/**'])
  })

  it('a plain file is visible', () => {
    const root = tempDir('scoutling-visible-plain-')
    writeFileSync(join(root, 'a.txt'), 'a')

    expect(isPathVisible(root, join(root, 'a.txt'))).toBe(true)
    expect(explainPathExclusion(root, join(root, 'a.txt'))).toBeUndefined()
  })

  it('a hidden (dot-prefixed) file or directory is visible — the whole point of bug A', () => {
    const root = tempDir('scoutling-visible-hidden-')
    writeFileSync(join(root, '.dotfile.md'), 'x')
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'x')

    expect(isPathVisible(root, join(root, '.dotfile.md'))).toBe(true)
    expect(isPathVisible(root, join(root, '.github', 'workflows', 'ci.yml'))).toBe(true)
  })

  it('a file under .git/ is never visible, and the reason names the git rule — even with no excludeGlobs at all', () => {
    const root = tempDir('scoutling-visible-git-')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')

    expect(isPathVisible(root, join(root, '.git', 'HEAD'))).toBe(false)
    expect(explainPathExclusion(root, join(root, '.git', 'HEAD'))).toEqual({ rule: 'git' })
  })

  it('.git/ stays excluded even when excludeGlobs is narrowed to something that never mentions it', () => {
    const root = tempDir('scoutling-visible-git-backstop-')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')

    expect(isPathVisible(root, join(root, '.git', 'HEAD'), { excludeGlobs: ['some-other-dir/**'] })).toBe(false)
  })

  it('a path matched by excludeGlobs is invisible, and the reason names the matching glob', () => {
    const root = tempDir('scoutling-visible-excludeglobs-')
    mkdirSync(join(root, 'excluded'), { recursive: true })
    writeFileSync(join(root, 'excluded', 'f.md'), 'x')

    const reason = explainPathExclusion(root, join(root, 'excluded', 'f.md'), { excludeGlobs: ['excluded/**'] })
    expect(reason).toEqual({ rule: 'excludeGlobs', glob: 'excluded/**' })
  })

  it('a gitignored path is invisible, and the reason names the gitignore rule', () => {
    const root = tempDir('scoutling-visible-gitignore-')
    writeFileSync(join(root, '.gitignore'), 'secret.env\n')
    writeFileSync(join(root, 'secret.env'), 'x')

    expect(isPathVisible(root, join(root, 'secret.env'))).toBe(false)
    expect(explainPathExclusion(root, join(root, 'secret.env'))).toEqual({ rule: 'gitignore' })
  })

  it('a file nested under a gitignored directory is invisible even though the file itself is never named', () => {
    const root = tempDir('scoutling-visible-gitignore-dir-')
    writeFileSync(join(root, '.gitignore'), 'ignored-dir/\n')
    mkdirSync(join(root, 'ignored-dir'), { recursive: true })
    writeFileSync(join(root, 'ignored-dir', 'f.md'), 'x')

    expect(isPathVisible(root, join(root, 'ignored-dir', 'f.md'))).toBe(false)
  })

  it('checks visibility for a path that does not exist yet — a property of the path, not of existence', () => {
    const root = tempDir('scoutling-visible-nonexistent-')
    writeFileSync(join(root, '.gitignore'), 'secret.env\n')

    // Never created on disk — read_file calls explainPathExclusion before
    // its own existsSync check specifically so this doesn't crash or
    // silently report "visible".
    expect(isPathVisible(root, join(root, 'secret.env'))).toBe(false)
    expect(isPathVisible(root, join(root, 'never-existed.txt'))).toBe(true)
  })

  it('the scope root itself is always visible', () => {
    const root = tempDir('scoutling-visible-root-')
    expect(isPathVisible(root, root)).toBe(true)
    expect(explainPathExclusion(root, root)).toBeUndefined()
  })
})
