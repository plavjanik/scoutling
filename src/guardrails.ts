import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import { ScoutlingError } from './errors.js'

/**
 * Canonicalize a path given on the command line (`--path`, default cwd) into
 * the scope root: the directory tree a run is allowed to see. Nothing outside
 * it exists as far as the run is concerned.
 */
export function resolveScopeRoot(path: string): string {
  let realPath: string
  try {
    realPath = realpathSync(resolve(path))
  } catch {
    throw new ScoutlingError(
      'PATH_NOT_FOUND',
      `Scope root does not exist: ${path}`,
      'Pass an existing directory with --path.',
    )
  }

  if (!statSync(realPath).isDirectory()) {
    throw new ScoutlingError(
      'PATH_NOT_FOUND',
      `Scope root is not a directory: ${path}`,
      'Pass a directory, not a file, with --path.',
    )
  }

  return realPath
}

/**
 * Resolve a model-supplied path against the scope root and assert the result
 * is inside it — the single choke point every tool must call before touching
 * the filesystem. Defeats both `../` traversal and symlink escape: the
 * nearest existing ancestor of the candidate is realpath'd, so a symlink
 * anywhere on the path (including the final component) is followed before
 * the containment check runs.
 *
 * Existence of the final component is deliberately not required here — a
 * caller like `read_file` needs to resolve-then-check-existence itself, to
 * give a "file not found" message distinct from "outside scope".
 */
export function resolvePath(scopeRoot: string, candidate: string): string {
  const normalized = normalize(candidate)
  const absoluteCandidate = isAbsolute(normalized) ? normalized : join(scopeRoot, normalized)

  const realBase = realpathNearestAncestor(absoluteCandidate)
  // Re-attach whatever suffix of the original path was beyond the realpath'd
  // ancestor, so a nonexistent leaf (e.g. a new file under an existing,
  // possibly symlinked, directory) still gets checked in its true location.
  const suffix = absoluteCandidate.slice(realBase.ancestor.length)
  const resolved = suffix.length > 0 ? join(realBase.real, suffix) : realBase.real

  const withTrailingSep = scopeRoot.endsWith(sep) ? scopeRoot : scopeRoot + sep
  const isInsideScope = resolved === scopeRoot || resolved.startsWith(withTrailingSep)

  if (!isInsideScope) {
    throw new ScoutlingError(
      'PATH_NOT_FOUND',
      `Path escapes the scope root: ${candidate}`,
      `Only paths inside ${scopeRoot} are accessible.`,
    )
  }

  return resolved
}

/**
 * Realpath the nearest existing ancestor of `path` (walking up from the path
 * itself). Returns both the original (un-realpath'd) ancestor and its
 * realpath, so the caller can re-attach any suffix beyond it.
 */
function realpathNearestAncestor(path: string): { ancestor: string; real: string } {
  let ancestor = path
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break // reached filesystem root without finding anything that exists
    ancestor = parent
  }
  return { ancestor, real: realpathSync(ancestor) }
}

/** Bytes sniffed for a NUL byte when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8192

/** A NUL byte in the first ~8 KB is the standard heuristic for "not text". */
export function isProbablyBinary(buffer: Buffer): boolean {
  const sniffLength = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < sniffLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}
