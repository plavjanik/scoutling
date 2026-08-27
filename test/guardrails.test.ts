import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isProbablyBinary, resolvePath, resolveScopeRoot } from '../src/guardrails.js'
import { ScoutlingError } from '../src/errors.js'

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

describe('resolveScopeRoot', () => {
  it('canonicalizes an existing directory', () => {
    const root = resolveScopeRoot(fixtureScope)
    expect(root).toBe(resolve(fixtureScope))
  })

  it('throws PATH_NOT_FOUND for a path that does not exist', () => {
    expect(() => resolveScopeRoot(join(fixtureScope, 'does-not-exist'))).toThrow(ScoutlingError)
    try {
      resolveScopeRoot(join(fixtureScope, 'does-not-exist'))
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('PATH_NOT_FOUND')
    }
  })

  it('throws PATH_NOT_FOUND for a path that is not a directory', () => {
    expect(() => resolveScopeRoot(join(fixtureScope, 'a.txt'))).toThrow(ScoutlingError)
  })
})

describe('resolvePath', () => {
  const scopeRoot = resolveScopeRoot(fixtureScope)

  it('resolves a normal relative path inside the scope', () => {
    expect(resolvePath(scopeRoot, 'a.txt')).toBe(join(scopeRoot, 'a.txt'))
  })

  it('resolves a nested relative path', () => {
    expect(resolvePath(scopeRoot, 'sub/nested.txt')).toBe(join(scopeRoot, 'sub', 'nested.txt'))
  })

  it('resolves the scope root itself (".")', () => {
    expect(resolvePath(scopeRoot, '.')).toBe(scopeRoot)
  })

  it('rejects ../ traversal out of the scope', () => {
    expect(() => resolvePath(scopeRoot, '../../etc/passwd')).toThrow(ScoutlingError)
    try {
      resolvePath(scopeRoot, '../../etc/passwd')
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('PATH_NOT_FOUND')
    }
  })

  it('rejects an absolute path outside the scope', () => {
    expect(() => resolvePath(scopeRoot, '/etc/passwd')).toThrow(ScoutlingError)
  })

  it('rejects a symlink that points outside the scope', () => {
    const outside = tempDir('scoutling-outside-')
    const secretFile = join(outside, 'secret.txt')
    writeFileSync(secretFile, 'top secret')

    const linkPath = join(scopeRoot, 'escape-link')
    symlinkSync(secretFile, linkPath)
    try {
      expect(() => resolvePath(scopeRoot, 'escape-link')).toThrow(ScoutlingError)
    } finally {
      rmSync(linkPath)
    }
  })

  it('allows a symlink that points inside the scope', () => {
    const linkPath = join(scopeRoot, 'inside-link')
    symlinkSync(join(scopeRoot, 'a.txt'), linkPath)
    try {
      expect(resolvePath(scopeRoot, 'inside-link')).toBe(join(scopeRoot, 'a.txt'))
    } finally {
      rmSync(linkPath)
    }
  })

  it('resolves a path that does not exist yet but whose parent is in scope, then still requires it to exist for reading', () => {
    // resolvePath itself only checks containment, not existence — the caller (read_file) checks existence.
    expect(resolvePath(scopeRoot, 'does-not-exist-yet.txt')).toBe(
      join(scopeRoot, 'does-not-exist-yet.txt'),
    )
  })

  it('rejects a nonexistent path whose parent directory does not exist either, when that walks outside scope', () => {
    expect(() => resolvePath(scopeRoot, '../outside/does-not-exist.txt')).toThrow(ScoutlingError)
  })
})

describe('isProbablyBinary', () => {
  it('is true for a buffer containing a NUL byte', () => {
    expect(isProbablyBinary(Buffer.from([65, 66, 0, 67]))).toBe(true)
  })

  it('is false for plain text', () => {
    expect(isProbablyBinary(Buffer.from('line1\nline2\n', 'utf8'))).toBe(false)
  })

  it('only sniffs the first ~8 KB', () => {
    const text = Buffer.from('a'.repeat(8192), 'utf8')
    const withLateNul = Buffer.concat([text, Buffer.from([0])])
    expect(isProbablyBinary(withLateNul)).toBe(false)
  })
})
