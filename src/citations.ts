import { existsSync, readFileSync, statSync, type Stats } from 'node:fs'

import type { Attachment } from './attachments.js'
import { isProbablyBinary, resolvePath } from './guardrails.js'
import { ScoutlingError } from './errors.js'
import { walkScope } from './scope-walk.js'

/**
 * DESIGN.md §8: a `path:line` (or `path:line-line`) reference, before it is checked. `line` is
 * required, not optional — a bare path is not a citation (see `isPlausibleCitation`), so no
 * candidate exists without one.
 *
 * ADR 0005: `attachment: true` marks the other grammar, `@<name>:line` — an attachment can never
 * be verified against the scope, so this flag is what tells `verifyOne` which universe to check
 * a candidate against. `path` is `@<name>` (the `@` included) on such a candidate, matching how
 * it was written in the answer and how it appears on the resulting `Source`.
 */
export interface CitationCandidate {
  path: string
  line: number
  endLine?: number
  attachment?: true
}

/** A citation after it has been checked against the scope, or against the attachment it names (CONTEXT.md "Source"). */
export interface Source {
  /**
   * Scope-root-relative, POSIX-separated, exactly as it will be shown to the caller — or, for an
   * attachment source, the citation as written including the `@` (e.g. `'@full.diff'`).
   */
  path: string
  /** 1-based. Always present: a citation without a line number is not extracted at all. */
  line: number
  /** 1-based, when the citation named a range `path:line-line`. */
  endLine?: number
  /** The file (or attachment) exists and any line/range is within its length. */
  verified: boolean
  /** Present only when this source cites an attachment (ADR 0005) rather than a file in the scope. */
  attachment?: true
  /**
   * Present only when the answer cited a bare filename (`candidates.ts:19`) that was resolved to
   * the one visible file of that name in the scope: the name as written, while `path` carries the
   * resolved scope-relative path.
   */
  citedAs?: string
  /** Why a citation could not be checked, when that is not obvious from the path and line alone (e.g. an ambiguous bare filename). */
  note?: string
}

/** What a verifier needs to know about the scope beyond its root — the same config-supplied visibility the tools are bound to. */
export interface CitationVerifierOptions {
  /** Config's `excludeGlobs`, never the model's: a bare filename is only resolved to a file every tool could also see. */
  excludeGlobs?: string[]
}

export interface CitationReport {
  sources: Source[]
  /** Every verified source, attachments included — see `verifiedScopeCount` for the scope-only count. */
  verifiedCount: number
  /**
   * Verified sources that are NOT attachments — the number `--require-citations` actually cares
   * about (ADR 0005: a citation into an attachment is not evidence about the scope, so it must
   * not satisfy that flag).
   */
  verifiedScopeCount: number
  unverifiedCount: number
  /** One line for text output, e.g. "Sources: 7 verified, 2 in attachments, 1 unverifiable (lib/foo.ts:999)". */
  summaryLine: string
}

// --- extraction -------------------------------------------------------------------------------
//
// The model's answer is prose, not a structured format, so citations have to be picked out of
// running text. Two passes strip things that would otherwise be misread as a path, then a single
// token regex does the picking:
//
//   1. Unwrap markdown links `[label](url)` to just `label` — the destination is never a
//      citation (it is usually a URL, occasionally a relative path the model invented for the
//      link), only the visible label is.
//   2. Delete bare `http(s)://…` URLs outright. Without this, a path-shaped fragment of the URL
//      itself (e.g. "example.com/foo.md" out of "https://example.com/foo.md") would pass the
//      token regex's own "contains a slash" test and be mistaken for a citation.
//
// What's left is scanned for tokens matching PATH_TOKEN_RE. The token's character class
// deliberately excludes the wrapper punctuation prose puts around a citation — backticks,
// parens, brackets, commas — so those fall out of the match for free instead of needing a
// separate trim step. A trailing run of `.` is trimmed explicitly afterwards, because `.` *is*
// a legal path character (it's how an extension is spelled) and the regex cannot otherwise tell
// "src/cli.ts" apart from "src/cli.ts." at a sentence's end.

// The label may itself hold up to two levels of balanced brackets, so a link whose label is a
// Next.js route path (`[app/learn/[slug]/page.tsx:173](url)`, or `[[...slug]]`) is still unwrapped
// whole — a flat `[^\]]*` label would fail to match at all and leave the brackets and the URL in
// the text.
const MARKDOWN_LINK_RE = /\[((?:[^[\]]|\[(?:[^[\]]|\[[^[\]]*\])*\])*)\]\([^)]*\)/g
// `]` is deliberately *not* a terminator: a URL with a route segment in it
// (`…/app/[slug]/page.tsx:3`) would otherwise stop at the `]` and leave `/page.tsx:3` behind as a
// phantom bare-filename citation.
const URL_RE = /https?:\/\/[^\s)}"'<>,]+/g

// ADR 0005's attachment grammar, `@<name>:line` or `@<name>:line-line` — resolved against
// `Attachment[]`, never the filesystem. Extracted and blanked out of the text *before*
// PATH_TOKEN_RE ever runs over it: PATH_TOKEN_RE's start-char class excludes `@` (that is what
// lets `@README.md` never shadow `README.md`), so without the '@' stripped, `@full.diff:42` would
// still hand PATH_TOKEN_RE a perfectly path-shaped `full.diff:42` to match starting one character
// in — a phantom scope citation to a file that was never claimed to exist in scope.
const ATTACHMENT_TOKEN_RE = /@([A-Za-z0-9_.\-]+):(\d+)(?:-(\d+))?/g

// Start char excludes `/ - \` so a match can never begin mid-path at a bare separator (which
// would otherwise let the fragment after a stripped URL's scheme, e.g. the leftover
// "//example.com/x", start a bogus match at the slash). `.` *is* allowed to start a token —
// otherwise a relative citation like `../../etc/passwd` or `./foo.ts` would never be seen, since
// the regex would only start matching at "etc"/"foo". The rest of the class allows the
// punctuation an ordinary relative path is built from, including `\` so a Windows-style citation
// is still picked up (and later normalized to `/`). The optional trailing group captures `:line`
// or `:line-line` only when it immediately follows the path with no space, which is how every
// citation in the system prompt's contract is shaped.
//
// Brackets and parens stay out of the plain character class — that is what lets `[src/cli.ts:10]`
// and `(a.txt:1)` drop their wrappers for free — and come back in only as the two *balanced*
// shapes a Next.js route path is spelled with (2026-10-22 eval: `app/learn/[slug]/page.tsx` was
// recorded as `page.tsx` by every model that cited it):
//   - ROUTE_PARAM: `[slug]`, `[...slug]`, `[[...slug]]`, anywhere in a segment (`[id].tsx` is a
//     pages-router filename). Its inside admits no `/`, `:`, `,` or space, so a wrapper around a
//     whole citation or a quoted spread like `[...flags, path/operand]` never matches it.
//   - ROUTE_GROUP: `(marketing)`, only as a whole directory segment — it must be followed by a
//     separator, so prose `foo(x)` and a parenthesized citation never become part of a path.
const ROUTE_PARAM = String.raw`\[\[[\w.\-]+\]\]|\[[\w.\-]+\]`
const ROUTE_GROUP = String.raw`\([\w.\-]+\)(?=[/\\])`
const PATH_TOKEN_RE = new RegExp(
  String.raw`(?:[A-Za-z0-9_.]|${ROUTE_PARAM}|${ROUTE_GROUP})(?:[A-Za-z0-9_.\-/\\]|${ROUTE_PARAM}|${ROUTE_GROUP})*(?::(\d+)(?:-(\d+))?)?`,
  'g',
)

/**
 * A token is a citation only when it carries a line number and its path part looks like a path.
 *
 * **The line number is required**, which is narrower than DESIGN.md §8's original
 * `path(:line(-line)?)?` grammar. That grammar was measured against real answers in Phase 4 and
 * the bare-path half of it produced almost only noise: a model that quotes a code snippet
 * (`[...flags, path/operand]`), names two ADRs at once ("ADR 0002/0004"), or illustrates a
 * *rejected* input (`../../etc/passwd`) puts slash-bearing tokens in its prose that were never
 * claims about the code. Each became an unverifiable source, and one correct smoke answer
 * reported "2 verified, 4 unverifiable". Since the built-in prompt requires a `path:line` for
 * every factual claim, a bare path is not a citation by the tool's own contract — dropping it
 * costs no true positive and removes every false one observed so far.
 *
 * The path part must additionally look like a path rather than a word: contain a `/`, end in a
 * file extension, or start with a letter (which is what lets `Makefile:12` and `LICENSE:5`
 * through while a clock reading like "10:30" is rejected).
 */
function isPlausibleCitation(path: string, hasLine: boolean): boolean {
  if (!hasLine) return false
  // A token of only digits and dots is a version or a decimal ("1.18", "3.14"), never a path.
  if (/^[\d.]+$/.test(path)) return false
  return path.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(path) || /^[A-Za-z]/.test(path)
}

/** A candidate plus its position in the scanned text, kept only long enough to restore document order once both grammars have been extracted separately. */
type PositionedCandidate = CitationCandidate & { at: number }

export function extractCitations(answer: string): CitationCandidate[] {
  const withoutLinkUrls = answer.replace(MARKDOWN_LINK_RE, '$1')
  const withoutUrls = withoutLinkUrls.replace(URL_RE, ' ')

  const seen = new Set<string>()
  const candidates: PositionedCandidate[] = []

  // Attachment citations first, and blanked out of the text before the scope scan below ever
  // sees it — see ATTACHMENT_TOKEN_RE's doc comment for why the order matters.
  let withoutAttachments = withoutUrls
  for (const match of withoutUrls.matchAll(ATTACHMENT_TOKEN_RE)) {
    const [full, name, lineText, endLineText] = match
    const at = match.index ?? 0
    if (name !== undefined && lineText !== undefined) {
      const line = Number(lineText)
      const endLine = endLineText === undefined ? undefined : Number(endLineText)
      const key = `@${name} ${line} ${endLine ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        candidates.push({
          path: `@${name}`,
          line,
          ...(endLine === undefined ? {} : { endLine }),
          attachment: true,
          at,
        })
      }
    }
    // Blank the exact matched span (same length, so every later match index in `withoutUrls`
    // still lines up) rather than deleting it, so a trailing ":42" can never re-surface as a bare
    // scope path token once the leading '@name' is gone.
    withoutAttachments = withoutAttachments.slice(0, at) + ' '.repeat(full.length) + withoutAttachments.slice(at + full.length)
  }

  for (const match of withoutAttachments.matchAll(PATH_TOKEN_RE)) {
    const [full, lineText, endLineText] = match
    // The line/range suffix, when present, was captured as part of `full` by PATH_TOKEN_RE's
    // trailing group — strip exactly that many characters back off to recover the bare path.
    const suffixLength =
      lineText === undefined ? 0 : 1 + lineText.length + (endLineText === undefined ? 0 : 1 + endLineText.length)
    let path = suffixLength > 0 ? full.slice(0, full.length - suffixLength) : full
    path = path.replace(/\.+$/, '')
    if (path.length === 0) continue

    if (!isPlausibleCitation(path, lineText !== undefined)) continue
    // isPlausibleCitation rejects every token with no line, so lineText is set from here on.
    const line = Number(lineText)

    const normalizedPath = path.replace(/\\/g, '/')
    const endLine = endLineText === undefined ? undefined : Number(endLineText)

    const key = `${normalizedPath} ${line} ${endLine ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)

    candidates.push({
      path: normalizedPath,
      line,
      ...(endLine === undefined ? {} : { endLine }),
      at: match.index ?? 0,
    })
  }

  return candidates.sort((a, b) => a.at - b.at).map(({ at: _at, ...candidate }) => candidate)
}

// --- verification -------------------------------------------------------------------------------
//
// No model call: this is a filesystem check against the same scope the run itself was bounded
// to. `resolvePath` is the same containment choke point every tool goes through — a citation
// that names a path outside the scope is exactly as untrusted as a model-supplied tool argument,
// since the model wrote both.

/**
 * Files this large or that sniff as binary make a *line-numbered* citation unverifiable — there
 * is no line count to check the citation against without reading (and for a binary file,
 * meaningfully counting lines in) the whole thing. A bare citation to the same file needs no
 * line count, so it is still verified: the file existing is the whole claim. This mirrors
 * `read_file`'s own 2 MB cap and binary sniff (`guardrails.ts#isProbablyBinary`) rather than
 * inventing a second policy for what counts as "too big to read".
 */
const MAX_VERIFIABLE_FILE_BYTES = 2 * 1024 * 1024

/** Cached per resolved path within one `verifyCitations` call: line count, or `null` if the file is too large/binary to count. */
type LineCountCache = Map<string, number | null>

/**
 * Every visible file in the scope, grouped by basename (scope-relative POSIX paths) — or
 * `'too-large'` when the walk hit `MAX_INDEXED_ENTRIES` and so cannot prove a name is unique.
 */
type BasenameIndex = Map<string, string[]> | 'too-large'

/** Everything one verifier caches across calls: line counts per file, and the basename index (built on the first bare-filename citation, never before). */
interface VerifierState {
  scopeRoot: string
  excludeGlobs: string[]
  lineCounts: LineCountCache
  basenames?: BasenameIndex
}

/**
 * Ceiling on the scope walk behind bare-filename resolution. A walk that stops early cannot tell
 * "one file of this name" from "one file of this name *so far*", so past it a bare filename is
 * left unverified (with a note) rather than resolved on partial evidence.
 */
const MAX_INDEXED_ENTRIES = 200_000

/** Line count matching `read_file`'s own accounting: a trailing newline doesn't count as an extra empty line. */
function countLines(text: string): number {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** `null` means "exists, but too large or binary to count lines in" — distinct from the file not existing at all, which the caller handles before ever reaching here. */
function getLineCount(resolvedPath: string, stats: Stats, cache: LineCountCache): number | null {
  const cached = cache.get(resolvedPath)
  if (cached !== undefined) return cached

  if (stats.size > MAX_VERIFIABLE_FILE_BYTES) {
    cache.set(resolvedPath, null)
    return null
  }

  const buffer = readFileSync(resolvedPath)
  if (isProbablyBinary(buffer)) {
    cache.set(resolvedPath, null)
    return null
  }

  const total = countLines(buffer.toString('utf8'))
  cache.set(resolvedPath, total)
  return total
}

/**
 * ADR 0005: an attachment citation never touches the filesystem — it is checked purely against
 * the `Attachment[]` the run was given, the same way a scope citation is checked against files on
 * disk. `candidate.path` is `@<name>` (see `CitationCandidate`'s doc comment); the attachment's
 * own `name` has no `@`, so it is stripped before the lookup.
 */
function verifyAttachmentCitation(candidate: CitationCandidate, attachments: Attachment[]): Source {
  const { path, line, endLine } = candidate
  const name = path.slice(1)
  const attachment = attachments.find((candidateAttachment) => candidateAttachment.name === name)

  const verified =
    attachment !== undefined &&
    line <= attachment.totalLines &&
    (endLine === undefined || (endLine >= line && endLine <= attachment.totalLines))

  return {
    path,
    line,
    ...(endLine === undefined ? {} : { endLine }),
    attachment: true,
    verified,
  }
}

/**
 * Built lazily from the same `walkScope` behind `list_dir` and the grep fallback, so "visible"
 * here means exactly what it means to the tools: `.git/` never, `excludeGlobs` and every
 * `.gitignore` from the root down applied. A file the model could not have read is never what a
 * bare filename resolves to.
 */
function getBasenameIndex(state: VerifierState): BasenameIndex {
  if (state.basenames !== undefined) return state.basenames

  const { entries, truncated } = walkScope({
    scopeRoot: state.scopeRoot,
    dir: state.scopeRoot,
    depth: Number.POSITIVE_INFINITY,
    excludeGlobs: state.excludeGlobs,
    limit: MAX_INDEXED_ENTRIES,
  })
  if (truncated) {
    state.basenames = 'too-large'
    return state.basenames
  }

  const index = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    const paths = index.get(name)
    if (paths) paths.push(entry.path)
    else index.set(name, [entry.path])
  }
  state.basenames = index
  return index
}

/** Ambiguous matches listed in a note are capped, for the same reason as the summary line's unverifiable list. */
const MAX_LISTED_MATCHES = 3

/**
 * A citation with no directory (`candidates.ts:19`) that names no file at the scope root. Models
 * write these routinely — one baseline model in the 2026-10-22 eval failed two audit cells on
 * nothing else. Resolved only when exactly one visible file has that basename: with two, picking
 * one would be a guess, and a guessed citation that happens to verify is worse than an honest
 * unverified one, so ambiguity and absence are both reported in `note` instead.
 */
function verifyBareName(state: VerifierState, candidate: CitationCandidate, attachments: Attachment[]): Source {
  const { path, line, endLine } = candidate
  const unverified = (note: string): Source => ({
    path,
    line,
    ...(endLine === undefined ? {} : { endLine }),
    verified: false,
    note,
  })

  const index = getBasenameIndex(state)
  if (index === 'too-large') {
    return unverified(`the scope has more than ${MAX_INDEXED_ENTRIES} entries, too many to resolve a bare filename`)
  }

  const matches = index.get(path) ?? []
  if (matches.length === 0) return unverified(`no file in scope is named ${path}`)
  if (matches.length > 1) {
    const listed = matches.slice(0, MAX_LISTED_MATCHES)
    if (matches.length > listed.length) listed.push(`+${matches.length - listed.length} more`)
    return unverified(`ambiguous: ${matches.length} files in scope are named ${path} (${listed.join(', ')})`)
  }

  // No second lookup on the resolved path: a dangling symlink at the root is listed by the walk yet
  // fails `existsSync`, and would otherwise bounce between here and `verifyOne` forever.
  const resolved = verifyOne(state, { ...candidate, path: matches[0] as string }, attachments, false)
  return { ...resolved, citedAs: path }
}

function verifyOne(
  state: VerifierState,
  candidate: CitationCandidate,
  attachments: Attachment[],
  resolveBareName = true,
): Source {
  if (candidate.attachment) return verifyAttachmentCitation(candidate, attachments)

  const { scopeRoot, lineCounts: cache } = state
  const { path, line, endLine } = candidate

  let resolved: string
  try {
    resolved = resolvePath(scopeRoot, path)
  } catch (error) {
    // Both the documented case (ScoutlingError for a path escaping the scope) and any other
    // resolution failure land here as "unverified" — verifyCitations makes no model call and
    // must never throw partway through an answer's citations because one of them is hostile.
    if (error instanceof ScoutlingError || error instanceof Error) {
      return { path, line, endLine, verified: false }
    }
    throw error
  }

  if (!existsSync(resolved)) {
    // A bare filename that is not at the scope root may still name exactly one file deeper down.
    if (resolveBareName && !path.includes('/')) return verifyBareName(state, candidate, attachments)
    return { path, line, endLine, verified: false }
  }

  const stats = statSync(resolved)
  if (!stats.isFile()) return { path, line, endLine, verified: false } // a directory is not verified

  const totalLines = getLineCount(resolved, stats, cache)
  if (totalLines === null) return { path, line, endLine, verified: false }
  if (line > totalLines) return { path, line, endLine, verified: false }
  if (endLine !== undefined && (endLine < line || endLine > totalLines)) {
    return { path, line, endLine, verified: false }
  }

  return endLine === undefined ? { path, line, verified: true } : { path, line, endLine, verified: true }
}

/** Render a source the way it was cited, for the summary line's unverifiable list. */
function renderSource(source: Source): string {
  if (source.line === undefined) return source.path
  return source.endLine === undefined
    ? `${source.path}:${source.line}`
    : `${source.path}:${source.line}-${source.endLine}`
}

/** Unverifiable citations listed in the summary are capped so a bad answer with hundreds of dangling citations can't produce an unbounded line. */
const MAX_LISTED_UNVERIFIABLE = 3

function buildSummaryLine(verifiedCount: number, attachmentVerifiedCount: number, unverified: Source[]): string {
  if (verifiedCount === 0 && unverified.length === 0) return 'Sources: none cited'

  // ADR 0005: called out separately from the plain verified count, since a citation into an
  // attachment is not evidence about the scope — a caller skimming the summary line should not
  // read "5 verified" as "5 verified against the code" when 2 of those are attachment citations.
  const attachmentsClause = attachmentVerifiedCount > 0 ? `, ${attachmentVerifiedCount} in attachments` : ''

  if (unverified.length === 0) return `Sources: ${verifiedCount} verified${attachmentsClause}`

  const listed = unverified.slice(0, MAX_LISTED_UNVERIFIABLE).map(renderSource)
  const remaining = unverified.length - listed.length
  if (remaining > 0) listed.push(`+${remaining} more`)

  return `Sources: ${verifiedCount} verified${attachmentsClause}, ${unverified.length} unverifiable (${listed.join(', ')})`
}

/** Shared body of `verifyCitations` and `createCitationVerifier` — the only difference between them is whether `cache` is fresh per call or shared across many. */
function verifyCitationsWithCache(state: VerifierState, answer: string, attachments: Attachment[]): CitationReport {
  const candidates = extractCitations(answer)
  const sources: Source[] = []
  // Extraction already collapsed identical tokens; a resolved bare filename can still land on a
  // path+line cited elsewhere in full (`lib/a.ts:19 … a.ts:19`), and that is one claim, not two.
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const source = verifyOne(state, candidate, attachments)
    const key = `${source.attachment ? '@' : ''}${source.path} ${source.line} ${source.endLine ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(source)
  }

  const verifiedCount = sources.filter((source) => source.verified).length
  const verifiedScopeCount = sources.filter((source) => source.verified && !source.attachment).length
  const attachmentVerifiedCount = verifiedCount - verifiedScopeCount
  const unverified = sources.filter((source) => !source.verified)

  return {
    sources,
    verifiedCount,
    verifiedScopeCount,
    unverifiedCount: unverified.length,
    summaryLine: buildSummaryLine(verifiedCount, attachmentVerifiedCount, unverified),
  }
}

/**
 * Extract every citation from `answer` and check it against `scopeRoot` — and, when given, against
 * `attachments` (ADR 0005: `@<name>:line` citations, never checked against the filesystem). No
 * model call — this is the structural half of DESIGN.md §8's cited-answer contract;
 * `--require-citations` (a later slice) decides what to do with a report that has zero verified
 * *scope* sources (`verifiedScopeCount`).
 */
export function verifyCitations(
  scopeRoot: string,
  answer: string,
  attachments: Attachment[] = [],
  options: CitationVerifierOptions = {},
): CitationReport {
  return verifyCitationsWithCache(createVerifierState(scopeRoot, options), answer, attachments)
}

function createVerifierState(scopeRoot: string, options: CitationVerifierOptions): VerifierState {
  return { scopeRoot, excludeGlobs: options.excludeGlobs ?? [], lineCounts: new Map() }
}

/**
 * A verifier bound to one scope root (and, when given, one set of attachments) that shares its
 * line-count cache — and its bare-filename index — across calls.
 *
 * DESIGN.md §8's brief mode (`sections.ts`) verifies an answer once as a whole for the top-level
 * `citations` report, and then verifies each of its sections again for that section's own
 * `sources` — a five-item brief that all cites the same large file would otherwise read that file
 * once per verification (six times: once whole-answer, once per section) instead of once. The
 * factory exists so a caller doing that repeated verification against one scope root pays for the
 * read exactly once, no matter how many times the returned function is called. The same holds
 * for the scope walk behind bare-filename resolution: at most one per verifier.
 */
export function createCitationVerifier(
  scopeRoot: string,
  attachments: Attachment[] = [],
  options: CitationVerifierOptions = {},
): (answer: string) => CitationReport {
  const state = createVerifierState(scopeRoot, options)
  return (answer: string) => verifyCitationsWithCache(state, answer, attachments)
}
