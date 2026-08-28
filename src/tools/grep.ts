import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { rgPath as bundledRgPath } from '@vscode/ripgrep'
import { z } from 'zod'
import { tool, type Tool } from 'ai'

import { isProbablyBinary, resolvePath } from '../guardrails.js'
import { walkScope } from '../scope-walk.js'
import { ScoutlingError } from '../errors.js'
import { toonModelOutput } from '../toon.js'

const execFileAsync = promisify(execFile)

/** Matches returned when the caller doesn't ask for a specific count. */
export const DEFAULT_MAX_MATCHES = 100
/** Hard ceiling regardless of what the model asks for — a small model can request an unbounded amount of context. */
export const MAX_MAX_MATCHES = 500
/** Lines of surrounding context returned when the caller doesn't ask for any — unchanged output by default. */
export const DEFAULT_CONTEXT_LINES = 0
/** Hard ceiling on `contextLines`: enough to usually avoid a follow-up `read_file`, not enough for a small model to smuggle a near-whole-file read through a single match. */
export const MAX_CONTEXT_LINES = 10
/** A minified bundle can put an entire file on one line; truncate so one match can't blow the tool-output budget. */
export const MAX_MATCH_TEXT_CHARS = 300
/**
 * The JS fallback (see below) walks lines through a plain `RegExp`, which
 * carries no linear-time guarantee the way ripgrep's Rust regex engine does.
 * A long, adversarial-looking pattern (nested quantifiers) can blow up
 * catastrophically; capping pattern length is the cheapest defence available
 * without reimplementing a regex engine. Ripgrep itself is not subject to
 * this cap.
 */
export const MAX_FALLBACK_PATTERN_CHARS = 200

/** Whole-run wall-clock budget for the ripgrep child process. Covers a huge tree or a pathological pattern. */
const RG_TIMEOUT_MS = 20_000
/** Generous headroom for a large result set before `execFile` gives up and errors instead of buffering forever. */
const RG_MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** Per-file budget for the fallback engine, checked between lines so one huge file can't hang the whole run. */
const FALLBACK_PER_FILE_BUDGET_MS = 250
/** Generous cap on how many files the fallback will even attempt to open, independent of `maxMatches`. */
const FALLBACK_MAX_FILES = 5000

/**
 * A refusal, shaped the same for every reason so a small model only has to
 * learn one error shape: `{error, message, hint?}` instead of one per
 * failure mode. Matches the convention in `read-file.ts`.
 */
interface GrepRefusal {
  error: string
  message: string
  hint?: string
}

export interface GrepMatch {
  /** Relative to the *scope root* (never to `path`), POSIX-separated, so the model can hand it straight to `read_file`. */
  file: string
  /** 1-based. */
  line: number
  /** The line's text, trailing newline stripped, truncated to `MAX_MATCH_TEXT_CHARS`. Same truncation for context lines as for matches. */
  text: string
  /**
   * Only present when the caller asked for `contextLines > 0` — in which
   * case *every* row carries it, never a mix (rows must stay uniform for
   * `toon.ts`'s tabular encoding). Absent entirely at `contextLines: 0` (the
   * default), which is what keeps that response byte-identical to before
   * this field existed.
   */
  kind?: 'match' | 'context'
}

export interface GrepResult {
  pattern: string
  path: string
  matches: GrepMatch[]
  note?: string
  /**
   * Which backend answered. Per `docs/adr/0004-bundled-ripgrep.md` the JS
   * fallback must be visible, never a silent, weaker stand-in for ripgrep —
   * this is how a parent agent debugging a surprising result can tell it
   * came from the slower, non-linear-time engine.
   */
  engine: 'ripgrep' | 'fallback'
}

const inputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for (ripgrep/Rust regex syntax).'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search, relative to the scope root (default ".").'),
  glob: z
    .string()
    .optional()
    .describe(
      'ripgrep-style glob to filter which files are searched. No "/" matches the basename ' +
        'at any depth (e.g. "*.ts"); with "/" matches the path relative to the searched path.',
    ),
  caseSensitive: z
    .boolean()
    .optional()
    .describe('Case-sensitive matching. Default false — case-insensitive is more useful for exploration.'),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum matches to return (default ${DEFAULT_MAX_MATCHES}, max ${MAX_MAX_MATCHES}).`),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT_LINES)
    .optional()
    .describe(
      `Lines of surrounding context to include around each match (default ${DEFAULT_CONTEXT_LINES}, max ` +
        `${MAX_CONTEXT_LINES}). Try this before reading a whole file just to see a few lines around a hit — ` +
        'a nonzero value is usually enough to answer without a follow-up read_file call.',
    ),
})

/** Convert a possibly platform-separated path to the POSIX form the `file` field always speaks in. */
function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

/** Ripgrep reports a target of "." as "./name"; strip that so `file` is a plain scope-relative path. */
function stripLeadingDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path
}

/** `data.lines.text` from ripgrep's `--json` output includes the line's own trailing newline. */
function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

function truncateText(text: string): string {
  return text.length > MAX_MATCH_TEXT_CHARS ? `${text.slice(0, MAX_MATCH_TEXT_CHARS)}…` : text
}

/**
 * Shared by both backends so a caller sees identical note text regardless of
 * which engine answered. Empty state is definitive per AXI principle 5:
 * names both `pattern` and `path` rather than a bare `[]`. Truncation is
 * only ever reported when genuinely truncated — the caller collects
 * `maxMatches + 1` and trims, mirroring the distinction `walkScope` makes
 * for `list_dir`.
 */
function buildResult(
  pattern: string,
  path: string,
  matches: GrepMatch[],
  truncated: boolean,
  maxMatches: number,
  engine: 'ripgrep' | 'fallback',
): GrepResult {
  if (matches.length === 0) {
    return { pattern, path, matches, note: `no matches for ${pattern} under ${path}`, engine }
  }
  if (truncated) {
    return {
      pattern,
      path,
      matches,
      note: `truncated at ${maxMatches} matches — narrow the pattern, glob, or path to see more`,
      engine,
    }
  }
  return { pattern, path, matches, engine }
}

interface BackendArgs {
  scopeRoot: string
  resolvedPath: string
  /** The path as given by the caller (or "." by default) — echoed back in the result, not used for I/O. */
  displayPath: string
  /** `resolvedPath` relative to `scopeRoot`, or "." when they're equal — what actually gets searched. */
  searchTarget: string
  pattern: string
  glob: string | undefined
  caseSensitive: boolean
  excludeGlobs: string[]
  maxMatches: number
  contextLines: number
}

type RipgrepOutcome =
  | { kind: 'unavailable' } // binary missing — the only case that falls back, per ADR 0004
  | { kind: 'done'; value: GrepResult | GrepRefusal }

/** The shape of one `--json` line ripgrep emits that this tool cares about; every other `type` is ignored. */
interface RipgrepMatchLine {
  type?: string
  data?: {
    path?: { text?: string; bytes?: string }
    line_number?: number
    lines?: { text?: string }
  }
}

/**
 * Invoke the bundled ripgrep binary and turn its `--json` stream into
 * `GrepMatch[]`.
 *
 * The argument order below is a security requirement, not a style choice
 * (ADR 0002/0004): the pattern always follows `-e`, and `--` always
 * separates flags from paths, so a model-chosen pattern starting with `-`
 * (e.g. `--pre=sh`, which would otherwise make ripgrep run a command per
 * file) can never be parsed as a flag. Never reorder this, and never add
 * `shell: true`. `grep-injection.test.ts` asserts the argv directly so a
 * refactor that reorders this is caught.
 */
async function runRipgrep(rgPath: string, args: BackendArgs): Promise<RipgrepOutcome> {
  const { scopeRoot, searchTarget, pattern, glob, caseSensitive, excludeGlobs, maxMatches, displayPath, contextLines } =
    args

  const flags: string[] = ['--json', '--line-number', '--no-messages']
  flags.push(caseSensitive ? '-s' : '-i')
  // Goes in the flags section, well before `-e`/`--`, so it can never be
  // mistaken for part of the pattern or a path — same placement discipline
  // as `--glob` and `--no-require-git` below.
  if (contextLines > 0) flags.push('-C', String(contextLines))
  if (glob !== undefined) flags.push('--glob', glob)
  // .gitignore handling is left to ripgrep's own machinery rather than
  // reimplemented here — it honours .gitignore (and .git/info/exclude,
  // global excludes, ...) out of the box. Verified empirically: ripgrep's
  // *actual* default only applies .gitignore when the search root sits
  // inside a real git repository (a bare .gitignore with no .git anywhere
  // above it is silently ignored) — `--no-require-git` is what makes it
  // honour .gitignore unconditionally, which is what a scope root that
  // isn't itself a git checkout still needs.
  flags.push('--no-require-git')
  for (const excludeGlob of excludeGlobs) flags.push('--glob', `!${excludeGlob}`)

  const rgArgs = [...flags, '-e', pattern, '--', searchTarget]

  let stdout: string
  try {
    const result = await execFileAsync(rgPath, rgArgs, {
      cwd: scopeRoot,
      timeout: RG_TIMEOUT_MS,
      maxBuffer: RG_MAX_BUFFER_BYTES,
    })
    stdout = result.stdout
  } catch (error) {
    const execError = error as {
      code?: number | string
      stdout?: string
      stderr?: string
      killed?: boolean
      message?: string
    }

    // Binary missing: the one failure ADR 0004 says falls back rather than
    // refuses. Every other ripgrep failure below is reported as a refusal —
    // silently answering with a slower, weaker engine is exactly how a
    // wrong answer looks right.
    if (execError.code === 'ENOENT') {
      return { kind: 'unavailable' }
    }

    if (execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        kind: 'done',
        value: {
          error: 'SEARCH_FAILED',
          message: `Search produced more than ${RG_MAX_BUFFER_BYTES} bytes of output.`,
          hint: 'The pattern matches far too much. Narrow the pattern, add a glob, or search a subdirectory.',
        },
      }
    }

    if (execError.killed) {
      return {
        kind: 'done',
        value: {
          error: 'TIMEOUT',
          message: `Search timed out after ${RG_TIMEOUT_MS}ms.`,
          hint: 'Narrow the path, glob, or pattern and try again.',
        },
      }
    }

    // Exit code 1 = ripgrep ran fine and found nothing; NOT an error.
    // execFile rejects on any nonzero exit, so this must be unwrapped here
    // rather than treated as a failure.
    if (execError.code === 1) {
      stdout = execError.stdout ?? ''
    } else if (execError.code === 2) {
      const stderr = (execError.stderr ?? '').trim()
      if (/regex parse error/i.test(stderr)) {
        return {
          kind: 'done',
          value: {
            error: 'INVALID_PATTERN',
            message: stderr || `Invalid pattern: ${pattern}`,
            hint: 'Fix the regex syntax (ripgrep uses Rust regex syntax).',
          },
        }
      }
      return {
        kind: 'done',
        value: { error: 'SEARCH_FAILED', message: stderr || 'ripgrep exited with an error.' },
      }
    } else {
      return {
        kind: 'done',
        value: {
          error: 'SEARCH_FAILED',
          message: (execError.stderr ?? '').trim() || execError.message || 'ripgrep failed.',
        },
      }
    }
  }

  // Two separate parse paths rather than one parameterised one: contextLines
  // === 0 is the pre-Phase-4-slice-6 code, completely untouched, so that
  // path's output is provably byte-identical rather than "identical because
  // the new branch happens to collapse to the old behaviour."
  const { matches, truncated } =
    contextLines > 0
      ? parseRipgrepWithContext(stdout, maxMatches, contextLines)
      : parseRipgrepMatchesOnly(stdout, maxMatches)

  return { kind: 'done', value: buildResult(pattern, displayPath, matches, truncated, maxMatches, 'ripgrep') }
}

/** Original (pre-context) parser: `type: 'match'` records only, one entry per record, no `kind` field. */
function parseRipgrepMatchesOnly(stdout: string, maxMatches: number): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = []
  let truncated = false

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue

    let parsed: RipgrepMatchLine
    try {
      parsed = JSON.parse(line) as RipgrepMatchLine
    } catch {
      continue
    }
    if (parsed.type !== 'match') continue

    const pathText = parsed.data?.path?.text
    // `data.path` can be `{bytes: "..."}` instead of `{text: ...}` for a
    // non-UTF-8 path — skip such a record rather than crashing.
    if (pathText === undefined) continue

    const lineNumber = parsed.data?.line_number
    const lineText = parsed.data?.lines?.text
    if (lineNumber === undefined || lineText === undefined) continue

    // One `match` record can carry multiple `submatches` (several hits on
    // the same line); that is still one match *line*, so no dedup is needed
    // here — we only ever read one match per JSON record.
    matches.push({
      file: stripLeadingDotSlash(toPosixPath(pathText)),
      line: lineNumber,
      text: truncateText(stripTrailingNewline(lineText)),
    })

    if (matches.length >= maxMatches + 1) {
      truncated = true
      break
    }
  }

  if (truncated) matches.splice(maxMatches)

  return { matches, truncated }
}

/**
 * `type: 'match'` and `type: 'context'` records, `kind`-tagged.
 *
 * ripgrep's own `-C n` windowing already merges overlapping windows and
 * already reports a line that is both a match and inside another match's
 * context as `match` (verified empirically: run `rg --json -C 2` against
 * two matches one line apart — the second is `type: match`, never
 * `type: context`, even though it falls inside the first match's window).
 * So this function does not need to recompute merging itself — it only
 * needs to decide, as records stream past, which side of `maxMatches` each
 * one falls on.
 *
 * That decision is the one place this needs its own state, because leading
 * context for a match arrives *before* that match's own record. A run of
 * context records seen while not "inside" a kept match's trailing window is
 * buffered in `pendingContext` rather than committed immediately; once the
 * match they precede is confirmed kept, the buffer is flushed as `context`
 * entries ahead of it. If that match instead turns out to be the one over
 * `maxMatches`, parsing stops immediately (matching how `runFallback`
 * below stops, per the frozen contract) and the buffered lines — which
 * belong only to the excess match, not to the last kept one — are simply
 * dropped along with it. Without this buffering, a match many lines away
 * from the last kept one but still within `maxMatches`'s reach in the byte
 * stream could otherwise leak its own leading context into the response
 * even though the match itself is never shown.
 */
function parseRipgrepWithContext(
  stdout: string,
  maxMatches: number,
  contextLines: number,
): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = []
  let matchCount = 0
  let truncated = false
  let pendingContext: GrepMatch[] = []
  let trailingRemaining = 0
  let currentFile: string | null = null

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue

    let parsed: RipgrepMatchLine
    try {
      parsed = JSON.parse(line) as RipgrepMatchLine
    } catch {
      continue
    }
    if (parsed.type !== 'match' && parsed.type !== 'context') continue

    const pathText = parsed.data?.path?.text
    if (pathText === undefined) continue
    const lineNumber = parsed.data?.line_number
    const lineText = parsed.data?.lines?.text
    if (lineNumber === undefined || lineText === undefined) continue

    const file = stripLeadingDotSlash(toPosixPath(pathText))
    // Context never spans files, so a file change resets both buffers —
    // defensive rather than load-bearing, since ripgrep never interleaves
    // records from two files.
    if (file !== currentFile) {
      pendingContext = []
      trailingRemaining = 0
      currentFile = file
    }
    const text = truncateText(stripTrailingNewline(lineText))

    if (parsed.type === 'match') {
      if (matchCount + 1 > maxMatches) {
        truncated = true
        break
      }
      matchCount++
      // The buffered leading context now provably belongs to a kept match —
      // commit it, in order, ahead of the match itself.
      for (const entry of pendingContext) matches.push(entry)
      pendingContext = []
      matches.push({ file, line: lineNumber, text, kind: 'match' })
      // Resets (not accumulates) on every kept match — this is exactly what
      // extends the window when the next match arrives before the previous
      // one's trailing budget ran out, merging the two into one run.
      trailingRemaining = contextLines
    } else {
      if (trailingRemaining > 0) {
        matches.push({ file, line: lineNumber, text, kind: 'context' })
        trailingRemaining--
      } else {
        pendingContext.push({ file, line: lineNumber, text, kind: 'context' })
      }
    }
  }

  return { matches, truncated }
}

/**
 * Pure-JS fallback used only when the bundled ripgrep binary can't be run
 * (see ADR 0004). Walks the scope with `walkScope`, reads each candidate
 * file, skips anything that looks binary, and regex-matches line by line.
 * Capped in two ways ripgrep doesn't need: a pattern-length refusal (no
 * linear-time guarantee without a real regex engine) and a per-file
 * wall-clock budget so one huge file can't hang the run.
 */
function runFallback(args: BackendArgs): GrepResult | GrepRefusal {
  const { scopeRoot, resolvedPath, displayPath, pattern, glob, caseSensitive, excludeGlobs, maxMatches, contextLines } =
    args

  if (pattern.length > MAX_FALLBACK_PATTERN_CHARS) {
    return {
      error: 'PATTERN_TOO_LONG',
      message:
        `Pattern is ${pattern.length} characters, over the ${MAX_FALLBACK_PATTERN_CHARS}-character ` +
        'limit for the fallback search engine.',
      hint:
        'The bundled ripgrep binary is unavailable, so the JavaScript fallback caps pattern length ' +
        '(it has no linear-time regex guarantee). Use a shorter pattern.',
    }
  }

  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i')
  } catch (error) {
    return {
      error: 'INVALID_PATTERN',
      message: `Invalid regular expression: ${pattern}. ${error instanceof Error ? error.message : String(error)}`,
      hint: 'Fix the regex syntax.',
    }
  }

  const stats = statSync(resolvedPath)
  const candidateFiles: string[] = []
  if (stats.isDirectory()) {
    const walkResult = walkScope({
      scopeRoot,
      dir: resolvedPath,
      depth: Number.POSITIVE_INFINITY,
      glob,
      excludeGlobs,
      limit: FALLBACK_MAX_FILES,
    })
    for (const entry of walkResult.entries) {
      if (entry.type === 'file') candidateFiles.push(join(resolvedPath, ...entry.path.split('/')))
    }
  } else {
    // A single explicit file is always searched, regardless of `glob` —
    // matches ripgrep's own behaviour (confirmed empirically: `--glob` only
    // prunes directory traversal, never an explicitly named file).
    candidateFiles.push(resolvedPath)
  }

  const matches: GrepMatch[] = []
  let truncated = false

  if (contextLines === 0) {
    // Untouched from before context lines existed, so contextLines: 0 (the
    // default) is provably byte-identical rather than "identical because
    // the windowed branch happens to collapse to the same thing."
    fileLoop: for (const filePath of candidateFiles) {
      let content: Buffer
      try {
        content = readFileSync(filePath)
      } catch {
        continue
      }
      if (isProbablyBinary(content)) continue

      const relFile = toPosixPath(relative(scopeRoot, filePath))
      const lines = content.toString('utf8').split('\n')
      const deadline = Date.now() + FALLBACK_PER_FILE_BUDGET_MS

      for (let i = 0; i < lines.length; i++) {
        // Checked between lines, not once per file, so one file with a huge
        // number of short lines can't quietly blow past the budget either.
        if (Date.now() > deadline) break

        const line = lines[i] ?? ''
        if (!regex.test(line)) continue

        matches.push({ file: relFile, line: i + 1, text: truncateText(line) })
        if (matches.length >= maxMatches + 1) {
          truncated = true
          break fileLoop
        }
      }
    }

    if (truncated) matches.splice(maxMatches)
  } else {
    // Mirrors `parseRipgrepWithContext`'s windowing exactly (see its doc
    // comment) so the two engines agree: a sliding `pendingContext` buffer
    // holds not-yet-committed leading context until the match it precedes
    // is confirmed kept, and `trailingRemaining` both emits a kept match's
    // trailing context and — by resetting rather than accumulating on the
    // next match — merges overlapping windows into one run. Here the
    // "records" are just every line of the file (ripgrep only hands us
    // lines already inside some window; the fallback has to look at every
    // line itself to reach the same conclusion), so a plain-text line is
    // the direct equivalent of ripgrep's `type: 'context'` record and a
    // regex match is the equivalent of `type: 'match'`.
    let matchCount = 0

    fileLoop: for (const filePath of candidateFiles) {
      let content: Buffer
      try {
        content = readFileSync(filePath)
      } catch {
        continue
      }
      if (isProbablyBinary(content)) continue

      const relFile = toPosixPath(relative(scopeRoot, filePath))
      const contentText = content.toString('utf8')
      const lines = contentText.split('\n')
      // `"a\n".split('\n')` is `["a", ""]` — a trailing newline manufactures
      // a fictitious final empty "line" that doesn't exist in the file. The
      // matches-only path above never notices (an empty string essentially
      // never matches a real pattern), but as *trailing context* of a match
      // on the real last line it would otherwise surface as a bogus extra
      // row ripgrep — which knows the file's true line count — never emits.
      const lineCount = contentText.endsWith('\n') ? lines.length - 1 : lines.length
      const deadline = Date.now() + FALLBACK_PER_FILE_BUDGET_MS
      // Reset per file: context never spans files.
      let pendingContext: GrepMatch[] = []
      let trailingRemaining = 0

      for (let i = 0; i < lineCount; i++) {
        if (Date.now() > deadline) break

        const line = lines[i] ?? ''
        const text = truncateText(line)

        if (regex.test(line)) {
          if (matchCount + 1 > maxMatches) {
            truncated = true
            break fileLoop
          }
          matchCount++
          for (const entry of pendingContext) matches.push(entry)
          pendingContext = []
          matches.push({ file: relFile, line: i + 1, text, kind: 'match' })
          trailingRemaining = contextLines
        } else if (trailingRemaining > 0) {
          matches.push({ file: relFile, line: i + 1, text, kind: 'context' })
          trailingRemaining--
        } else {
          // Bounded ring buffer: only the most recent `contextLines` lines
          // can ever be needed as leading context of a future match, so an
          // older entry is dropped rather than kept around indefinitely —
          // this is what stops a long run of non-matching lines between two
          // distant matches from leaking irrelevant "context" into the
          // result once the second match is reached.
          pendingContext.push({ file: relFile, line: i + 1, text, kind: 'context' })
          if (pendingContext.length > contextLines) pendingContext.shift()
        }
      }
    }
  }

  return buildResult(pattern, displayPath, matches, truncated, maxMatches, 'fallback')
}

/**
 * Full-text regex search over the scope, backed by the npm-bundled ripgrep
 * binary with a pure-JS fallback for the one case ADR 0004 allows it: the
 * binary genuinely isn't runnable. The scope root and (optionally) the
 * ripgrep path are bound at construction — never model-supplied — so a
 * model can't widen its own scope or redirect the search to another binary.
 *
 * `rgPath` is injectable so tests can force the fallback path (pass a
 * nonexistent binary) without touching the real `@vscode/ripgrep` dependency.
 */
export function createGrepTool(
  scopeRoot: string,
  options?: { excludeGlobs?: string[]; rgPath?: string },
): Tool<z.infer<typeof inputSchema>, GrepResult | GrepRefusal> {
  const excludeGlobs = options?.excludeGlobs ?? []
  const rgPath = options?.rgPath ?? bundledRgPath

  return tool({
    description:
      'Search file contents in the scope with a regular expression (ripgrep/Rust regex syntax). ' +
      'Returns matching lines with file and 1-based line number. Prefer this over reading whole ' +
      'files when you only need to find where something occurs — and set contextLines to pull a ' +
      'few lines of surrounding code into the same result instead of following up with read_file.',
    inputSchema,
    // DESIGN.md §6: grep's result is tabular (`{file,line,text}[]`), so the
    // model sees it as TOON rather than JSON. The typed return value below
    // (and every refusal shape) is unchanged — this only governs how
    // `execute`'s result is rendered into the model-facing prompt.
    toModelOutput: ({ output }) => toonModelOutput(output),
    execute: async ({
      pattern,
      path = '.',
      glob,
      caseSensitive = false,
      maxMatches = DEFAULT_MAX_MATCHES,
      contextLines = DEFAULT_CONTEXT_LINES,
    }): Promise<GrepResult | GrepRefusal> => {
      // Clamped here as well as in the schema: a local model can still emit
      // an out-of-range value the schema's `.min(1)` alone wouldn't cap from
      // above, or (via a looser client) skip validation entirely.
      const clampedMaxMatches = Math.min(Math.max(Math.trunc(maxMatches), 1), MAX_MAX_MATCHES)
      // Same precedent as maxMatches — a negative value clamps to 0 (i.e. no
      // context, the default), not an error.
      const clampedContextLines = Math.min(Math.max(Math.trunc(contextLines), 0), MAX_CONTEXT_LINES)

      let resolvedPath: string
      try {
        resolvedPath = resolvePath(scopeRoot, path)
      } catch (error) {
        if (error instanceof ScoutlingError) {
          return { error: error.code, message: error.message, hint: error.hint }
        }
        throw error
      }

      if (!existsSync(resolvedPath)) {
        return {
          error: 'PATH_NOT_FOUND',
          message: `Path not found: ${path}`,
          hint: 'Check the path, e.g. with a directory listing of its parent.',
        }
      }

      const relTarget = toNativeRelative(scopeRoot, resolvedPath)

      const backendArgs: BackendArgs = {
        scopeRoot,
        resolvedPath,
        displayPath: path,
        searchTarget: relTarget,
        pattern,
        glob,
        caseSensitive,
        excludeGlobs,
        maxMatches: clampedMaxMatches,
        contextLines: clampedContextLines,
      }

      const rgOutcome = await runRipgrep(rgPath, backendArgs)
      if (rgOutcome.kind === 'done') return rgOutcome.value

      return runFallback(backendArgs)
    },
  })
}

/** `resolvedPath` relative to `scopeRoot`, in native separators (what ripgrep is invoked with); "." when they're equal. */
function toNativeRelative(scopeRoot: string, resolvedPath: string): string {
  const rel = relative(scopeRoot, resolvedPath)
  return rel === '' ? '.' : rel
}
