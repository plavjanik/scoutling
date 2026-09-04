import { existsSync, readFileSync, statSync, type Stats } from 'node:fs'

import type { Attachment } from './attachments.js'
import { isProbablyBinary, resolvePath } from './guardrails.js'
import { ScoutlingError } from './errors.js'

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

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g
const URL_RE = /https?:\/\/[^\s)\]}"'<>,]+/g

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
const PATH_TOKEN_RE = /[A-Za-z0-9_.][A-Za-z0-9_.\-/\\]*(?::(\d+)(?:-(\d+))?)?/g

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

function verifyOne(scopeRoot: string, candidate: CitationCandidate, cache: LineCountCache, attachments: Attachment[]): Source {
  if (candidate.attachment) return verifyAttachmentCitation(candidate, attachments)

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

  if (!existsSync(resolved)) return { path, line, endLine, verified: false }

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
function verifyCitationsWithCache(
  scopeRoot: string,
  answer: string,
  cache: LineCountCache,
  attachments: Attachment[],
): CitationReport {
  const candidates = extractCitations(answer)
  const sources = candidates.map((candidate) => verifyOne(scopeRoot, candidate, cache, attachments))

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
export function verifyCitations(scopeRoot: string, answer: string, attachments: Attachment[] = []): CitationReport {
  return verifyCitationsWithCache(scopeRoot, answer, new Map(), attachments)
}

/**
 * A verifier bound to one scope root (and, when given, one set of attachments) that shares its
 * line-count cache across calls.
 *
 * DESIGN.md §8's brief mode (`sections.ts`) verifies an answer once as a whole for the top-level
 * `citations` report, and then verifies each of its sections again for that section's own
 * `sources` — a five-item brief that all cites the same large file would otherwise read that file
 * once per verification (six times: once whole-answer, once per section) instead of once. The
 * factory exists so a caller doing that repeated verification against one scope root pays for the
 * read exactly once, no matter how many times the returned function is called.
 */
export function createCitationVerifier(
  scopeRoot: string,
  attachments: Attachment[] = [],
): (answer: string) => CitationReport {
  const cache: LineCountCache = new Map()
  return (answer: string) => verifyCitationsWithCache(scopeRoot, answer, cache, attachments)
}
