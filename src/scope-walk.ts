import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import ignoreFactory from 'ignore'

/** The type returned by the `ignore` factory function; there is no separately-exported type name. */
type Ignore = ReturnType<typeof ignoreFactory>

/** One entry a walk yields. `path` is relative to the walked directory, always POSIX-separated. */
export interface WalkEntry {
  path: string
  type: 'file' | 'dir'
  size: number // bytes for a file; 0 for a directory
}

export interface WalkResult {
  entries: WalkEntry[]
  /** True when `limit` cut the walk short. */
  truncated: boolean
}

export interface WalkOptions {
  /** Canonical scope root (already through resolveScopeRoot). */
  scopeRoot: string
  /** Absolute directory to walk; the caller has already run it through resolvePath(). */
  dir: string
  /** 1 = `dir`'s own entries only. Pass Number.POSITIVE_INFINITY for unbounded. */
  depth: number
  /** Optional inclusion filter, ripgrep-style (see matchesGlob). Applies to output only, never to traversal. */
  glob?: string
  /** Exclusion globs from config, matched relative to the SCOPE ROOT (not `dir`). */
  excludeGlobs?: string[]
  /** Stop after this many entries and set `truncated`. */
  limit: number
}

/**
 * Globs excluded no matter what the config says. `.git/` is enormous, is
 * never useful as text, and since `grep` now searches hidden directories
 * (DESIGN.md §6, §15 — the fix for the grep/list_dir hidden-file divergence)
 * it would otherwise be reachable whenever a config's `excludeGlobs` omits
 * it — config layers *replace* this key rather than merging it (config.ts),
 * so a user narrowing `excludeGlobs` must not silently re-expose the object
 * store. Applied by every caller of `isExcludedByGlobs` in addition to
 * whatever `excludeGlobs` it was given, never instead of it.
 */
export const ALWAYS_EXCLUDED_GLOBS: readonly string[] = ['.git/**']

const GITIGNORE_FILENAME = '.gitignore'

/**
 * Compiled-regex cache for `globToRegExp`, keyed by the raw glob string.
 * `walkScope` calls `matchesGlob` once per entry per exclude glob (via
 * `excludeGlobMatches`), so on a large tree this is the hot path: without
 * caching, the same handful of glob strings gets recompiled into a `RegExp`
 * tens of thousands of times per walk. Deliberately unbounded: glob strings
 * come from config files and single tool-call arguments, not from
 * arbitrary high-cardinality input, so the cache stays tiny in practice and
 * bounding it would just add complexity for no real benefit.
 */
const globRegExpCache = new Map<string, RegExp>()

/**
 * Convert a possibly platform-separated path (or path segment) to the
 * POSIX-separated form every entry and glob in this module speaks in. Never
 * assume the input is already POSIX — on Windows `sep` is `\`, and both
 * `node:path` output and a model-supplied glob could use either.
 */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/**
 * Turn a single glob character (already known not to be `*` or `?`, which the
 * caller handles specially) into a regex-safe literal. Deliberately escapes
 * `/` too even though it needs no escaping in a `RegExp` built from a string
 * — a blanket rule is easier to verify by inspection than a hand-picked set.
 */
function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char
}

/**
 * Translate a ripgrep-style glob into an anchored regex. Supported
 * metacharacters: `*` (any run except `/`), `**` (any run including `/`),
 * `?` (one character except `/`). Everything else is a regex-escaped
 * literal.
 *
 * The one piece of special handling: a `**` that is its own path segment —
 * bounded by `/` on its trailing side, and on its leading side by either a
 * literal `/` in the glob (e.g. the `**` in `a/**`, followed by `/b`) or the
 * start of the glob itself (e.g. a glob starting `**`, followed by
 * `/foo.ts`) — also matches the zero-directory case. So the glob `a/**`
 * followed by `/b` matches literal `a/b` as well as `a/x/b`, and the glob
 * `**` followed by `/foo.ts` matches literal `foo.ts` as well as `a/foo.ts`.
 * A naive `**` -> `.*` translation would require a `/` on each side of the
 * expansion (or the start of the string on the leading side) and so would
 * only ever match with at least one path segment in between. Every other
 * placement of `**` (trailing, or mid-segment without bounding slashes)
 * just becomes `.*`.
 */
function globToRegExp(glob: string): RegExp {
  const cached = globRegExpCache.get(glob)
  if (cached) return cached

  let pattern = ''
  let i = 0
  while (i < glob.length) {
    const char = glob[i]
    if (char === undefined) break // unreachable given the loop condition; narrows the type for TS
    if (char === '*' && glob[i + 1] === '*') {
      const hasLeadingSlashOrStart = i === 0 || glob[i - 1] === '/'
      const hasTrailingSlash = glob[i + 2] === '/'
      if (hasLeadingSlashOrStart && hasTrailingSlash) {
        // Optional-directories segment: either a middle segment (the
        // mandatory '/' before '**' is already in `pattern`) or a leading
        // '**/' (nothing needed before it). Append an optional
        // "zero-or-more-dirs-then-/" group so that a single slash alone (or
        // nothing, at the start of the string) is enough.
        pattern += '(?:.*/)?'
        i += 3 // consume '**' and the '/' that followed it
        continue
      }
      pattern += '.*'
      i += 2
      continue
    }
    if (char === '*') {
      pattern += '[^/]*'
      i += 1
      continue
    }
    if (char === '?') {
      pattern += '[^/]'
      i += 1
      continue
    }
    pattern += escapeRegExpChar(char)
    i += 1
  }
  const regExp = new RegExp(`^${pattern}$`)
  globRegExpCache.set(glob, regExp)
  return regExp
}

/**
 * Ripgrep-style glob match, exported for direct testing and reuse by grep.
 * A glob with no `/` matches only the basename of `relativePath` (so `*.ts`
 * finds `src/a.ts`); a glob containing `/` matches the whole path. Matching
 * is always whole-string. `relativePath` is converted to POSIX separators
 * before matching, so callers can pass a platform-native relative path.
 */
export function matchesGlob(glob: string, relativePath: string): boolean {
  const posixPath = toPosix(relativePath)
  const target = glob.includes('/') ? posixPath : (posixPath.split('/').pop() ?? posixPath)
  return globToRegExp(glob).test(target)
}

/**
 * Does `glob` (an exclude glob from config, matched relative to the scope
 * root) exclude this candidate? Beyond the ordinary `matchesGlob` check,
 * a glob ending in `/**` also excludes the directory it's rooted at:
 * `node_modules/**` must exclude `node_modules` itself, not just its
 * contents, because `**` requires a `/` on each side of its expansion and
 * so `matchesGlob('node_modules/**', 'node_modules')` alone is false.
 */
function excludeGlobMatches(glob: string, relativeToScopeRoot: string, isDir: boolean): boolean {
  if (matchesGlob(glob, relativeToScopeRoot)) return true
  if (isDir && glob.endsWith('/**')) {
    const directoryGlob = glob.slice(0, -3)
    if (matchesGlob(directoryGlob, relativeToScopeRoot)) return true
  }
  return false
}

/**
 * The one glob-exclusion check every tool shares: `excludeGlobs` (config,
 * never the model) unioned with `ALWAYS_EXCLUDED_GLOBS` (structural, always
 * on). `walkScope` and `isPathVisible` both call this rather than each
 * keeping its own copy of "which globs apply" — see the module doc comment
 * on `isPathVisible` for why a literal shared call isn't used for the
 * traversal case instead.
 */
function isExcludedByGlobs(relativeToScopeRoot: string, isDir: boolean, excludeGlobs: readonly string[]): boolean {
  for (const glob of ALWAYS_EXCLUDED_GLOBS) {
    if (excludeGlobMatches(glob, relativeToScopeRoot, isDir)) return true
  }
  for (const glob of excludeGlobs) {
    if (excludeGlobMatches(glob, relativeToScopeRoot, isDir)) return true
  }
  return false
}

/** One level of the `.gitignore` stack: a directory and the matcher built from its `.gitignore`, if any. */
interface GitignoreFrame {
  dirPath: string
  matcher: Ignore
}

/**
 * Load `<dirPath>/.gitignore` into a matcher, or return `undefined` if it's
 * absent or unreadable. Never throws — an unreadable `.gitignore` is
 * indistinguishable from "no matcher for that directory", not an error.
 */
function loadGitignoreFrame(dirPath: string): GitignoreFrame | undefined {
  const gitignorePath = join(dirPath, GITIGNORE_FILENAME)
  if (!existsSync(gitignorePath)) return undefined
  try {
    const content = readFileSync(gitignorePath, 'utf8')
    return { dirPath, matcher: ignoreFactory().add(content) }
  } catch {
    return undefined
  }
}

/** Append `dirPath`'s own `.gitignore` frame to `stack`, if it has one. */
function extendGitignoreStack(stack: GitignoreFrame[], dirPath: string): GitignoreFrame[] {
  const frame = loadGitignoreFrame(dirPath)
  return frame ? [...stack, frame] : stack
}

/**
 * Build the starting `.gitignore` stack: every ancestor from `scopeRoot`
 * down to `dir` inclusive. Without this, walking a subdirectory would miss
 * the scope root's own `.gitignore` entirely.
 */
function buildInitialGitignoreStack(scopeRoot: string, dir: string): GitignoreFrame[] {
  let stack = extendGitignoreStack([], scopeRoot)
  const relativeDir = relative(scopeRoot, dir)
  if (relativeDir === '') return stack

  let current = scopeRoot
  for (const segment of relativeDir.split(sep)) {
    current = join(current, segment)
    stack = extendGitignoreStack(stack, current)
  }
  return stack
}

/**
 * Does any frame on the `.gitignore` stack match `absPath`? Each frame is
 * tested against `absPath` relative to *that frame's own directory* — a
 * `.gitignore` only ever governs the subtree it sits in. Directories are
 * tested with a trailing `/`, which is how the `ignore` package
 * distinguishes `foo/`-only patterns from patterns that also match a file
 * named `foo`.
 */
function matchesGitignoreStack(stack: GitignoreFrame[], absPath: string, isDir: boolean): boolean {
  return stack.some((frame) => {
    const relativeToFrame = toPosix(relative(frame.dirPath, absPath))
    if (relativeToFrame === '' || relativeToFrame.startsWith('..')) return false
    const candidate = isDir ? `${relativeToFrame}/` : relativeToFrame
    return frame.matcher.ignores(candidate)
  })
}

/**
 * Which rule made a path invisible — `undefined` means it's visible. Lets a
 * refusal (`read_file`'s `PATH_EXCLUDED`, DESIGN.md §15) name the rule
 * instead of leaving a small model to guess why. Checked in the same order
 * `isExcludedByGlobs` would evaluate them, just kept separate here rather
 * than folded into one boolean-returning loop so each branch can report
 * *which* glob or rule fired.
 */
export type PathExclusionReason =
  | { rule: 'git' }
  | { rule: 'excludeGlobs'; glob: string }
  | { rule: 'gitignore' }

/**
 * Explains (or clears) the visibility of `absPath` under the same rule
 * `walkScope` applies: not `.git/**` (always), not `excludeGlobs`-matched,
 * not gitignored by any `.gitignore` from `scopeRoot` down to it. `absPath`
 * must already be inside `scopeRoot` (callers go through `resolvePath`
 * first, per `guardrails.ts` — this function does not itself re-check
 * containment).
 *
 * This is a single-path check used by `read_file` (DESIGN.md §6, §15): a
 * model names one file directly rather than discovering it through a
 * traversal, so there is no `walkScope` queue item to reuse. It reuses
 * `ALWAYS_EXCLUDED_GLOBS`, `excludeGlobMatches` and `matchesGitignoreStack` —
 * the same building blocks `walkScope`'s loop (via `isExcludedByGlobs`)
 * calls — rather than re-deriving the rule, which is the whole point of the
 * fix (having two independent copies of "what's visible" is exactly bug
 * A/B). What it does NOT share is `walkScope`'s incremental, breadth-first
 * stack-building: `walkScope` extends one `.gitignore` stack once per
 * directory as it descends, amortized across every entry in that directory,
 * whereas a single-path check has no walk to amortize over and rebuilds the
 * stack from `scopeRoot` down on every call. Calling into `walkScope` itself
 * to answer one path would mean walking (and reading every `.gitignore` in)
 * the whole path prefix on every `read_file` call — for a one-file question,
 * correct but needlessly expensive — so the two functions share logic, not a
 * call site.
 *
 * `isDir` is inferred with a best-effort `statSync` rather than required
 * from the caller: `read_file` calls this before its own `existsSync` check
 * (a path's visibility is a property of the path, not of whether it
 * currently exists), so the file may not exist yet, or may not be readable.
 * This only matters for a `.gitignore` pattern that targets `absPath` itself
 * with a dir-only trailing slash (e.g. `foo/` vs `foo`) — a pattern that
 * ignores a *directory* also ignores everything under it regardless of
 * trailing slash (verified:
 * `ignore().add('ignored-dir/\n').ignores('ignored-dir/f.md')` is `true`
 * with no `isDir` involved), so guessing wrong here only risks the one edge
 * case of checking the excluded directory's own path, which `read_file`
 * immediately rejects as `NOT_A_FILE` afterwards anyway.
 */
export function explainPathExclusion(
  scopeRoot: string,
  absPath: string,
  options?: { excludeGlobs?: string[] },
): PathExclusionReason | undefined {
  const excludeGlobs = options?.excludeGlobs ?? []
  const relFromScopeRoot = toPosix(relative(scopeRoot, absPath))

  // The scope root itself is never excludable — there is no glob or
  // .gitignore entry that could sensibly match "." — so short-circuit
  // rather than let `dirname(scopeRoot)` walk the stack above the root.
  if (relFromScopeRoot === '') return undefined

  let isDir = false
  try {
    isDir = statSync(absPath).isDirectory()
  } catch {
    // Doesn't exist (yet) or isn't statable: see the doc comment above.
  }

  for (const glob of ALWAYS_EXCLUDED_GLOBS) {
    if (excludeGlobMatches(glob, relFromScopeRoot, isDir)) return { rule: 'git' }
  }
  for (const glob of excludeGlobs) {
    if (excludeGlobMatches(glob, relFromScopeRoot, isDir)) return { rule: 'excludeGlobs', glob }
  }

  const stack = buildInitialGitignoreStack(scopeRoot, dirname(absPath))
  if (matchesGitignoreStack(stack, absPath, isDir)) return { rule: 'gitignore' }

  return undefined
}

/** True when `absPath` is visible — see `explainPathExclusion` for the rule and why a path may not be. */
export function isPathVisible(scopeRoot: string, absPath: string, options?: { excludeGlobs?: string[] }): boolean {
  return explainPathExclusion(scopeRoot, absPath, options) === undefined
}

/**
 * Names WHICH rule made a path invisible, for a `PATH_EXCLUDED` refusal
 * message (DESIGN.md §15) — so a small model stops retrying the same path
 * instead of guessing why it failed. Shared by `read_file`, `grep` and
 * `list_dir` (all three refuse an explicitly-named excluded path the same
 * way, per DESIGN.md §6/§15's 2026-08-28 follow-up) rather than each tool
 * keeping its own copy of this switch, which is exactly the kind of
 * independent-copies-of-"what's visible" drift the original fix closed.
 */
export function describeExclusionReason(reason: PathExclusionReason): string {
  switch (reason.rule) {
    case 'git':
      return 'it is under .git/, which is never a readable path regardless of config'
    case 'excludeGlobs':
      return `it matches the excludeGlobs entry "${reason.glob}"`
    case 'gitignore':
      return 'it is gitignored'
  }
}

/** Sorted string comparison, deliberately plain `<` (not `localeCompare`) so ordering is portable across locales/platforms. */
function compareNames(a: Dirent, b: Dirent): number {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

/** One directory still to be read, carrying the walk state that's cheapest to compute once and hand down. */
interface QueueItem {
  absDir: string
  /** Path of `absDir` relative to the walked `dir`, POSIX-separated; `''` for `dir` itself. */
  relFromDir: string
  /** Depth of the entries this item's children will produce (`dir`'s own children are depth 1). */
  level: number
  /** `.gitignore` matchers effective for this directory's children, including this directory's own `.gitignore`. */
  stack: GitignoreFrame[]
}

/**
 * Walk `options.dir`, breadth-first by depth and sorted by name within each
 * directory, applying exclusion (`.git`, `excludeGlobs`, hierarchical
 * `.gitignore`) to both output and traversal, and an optional `glob` filter
 * to output only. Shared by the upcoming `list_dir` and `grep` tools so
 * directory-walking policy — what's pruned, what's skipped silently, how
 * `limit` truncates — lives in exactly one place.
 */
export function walkScope(options: WalkOptions): WalkResult {
  const { scopeRoot, dir, depth, glob, excludeGlobs = [], limit } = options

  const entries: WalkEntry[] = []

  const queue: QueueItem[] = [
    { absDir: dir, relFromDir: '', level: 1, stack: buildInitialGitignoreStack(scopeRoot, dir) },
  ]

  walking: while (queue.length > 0) {
    const item = queue.shift() as QueueItem

    let dirents: Dirent[]
    try {
      dirents = readdirSync(item.absDir, { withFileTypes: true })
    } catch {
      // Unreadable directory (EACCES, a broken symlink target, ...): skipped
      // silently rather than failing the whole walk.
      continue
    }
    dirents.sort(compareNames)

    for (const dirent of dirents) {
      const absPath = join(item.absDir, dirent.name)
      const relFromScopeRoot = toPosix(relative(scopeRoot, absPath))
      const relFromDirPosix = item.relFromDir === '' ? dirent.name : `${item.relFromDir}/${dirent.name}`

      const isSymlink = dirent.isSymbolicLink()
      const isDirCandidate = !isSymlink && dirent.isDirectory()

      if (isExcludedByGlobs(relFromScopeRoot, isDirCandidate, excludeGlobs)) continue
      if (matchesGitignoreStack(item.stack, absPath, isDirCandidate)) continue

      let entry: WalkEntry
      if (isSymlink) {
        // Never followed: reported as its own entry, never recursed into.
        entry = { path: relFromDirPosix, type: 'file', size: 0 }
      } else if (isDirCandidate) {
        entry = { path: relFromDirPosix, type: 'dir', size: 0 }
      } else {
        let size = 0
        try {
          size = statSync(absPath).size
        } catch {
          // Vanished between readdir and stat, or otherwise unreadable:
          // skip this single entry rather than failing the walk.
          continue
        }
        entry = { path: relFromDirPosix, type: 'file', size }
      }

      const included = glob === undefined || matchesGlob(glob, relFromDirPosix)
      if (included) {
        entries.push(entry)
        // Collect one entry beyond `limit` before stopping: only then do we
        // actually know whether there was more to find. Stopping dead at
        // `limit` cannot distinguish "this was the last entry ever" from
        // "there's more" — see the truncated-flag correction below.
        if (entries.length >= limit + 1) {
          break walking
        }
      }

      if (isDirCandidate && item.level < depth) {
        queue.push({
          absDir: absPath,
          relFromDir: relFromDirPosix,
          level: item.level + 1,
          stack: extendGitignoreStack(item.stack, absPath),
        })
      }
    }
  }

  // `entries` may hold one surplus item past `limit` (the ceiling above lets
  // the walk find it). Only that surplus means "truncated": drop it so the
  // caller never sees more than `limit` entries, and only then is
  // `truncated: true` correct.
  const truncated = entries.length > limit
  if (truncated) entries.splice(limit)

  return { entries, truncated }
}
