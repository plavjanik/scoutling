import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { ScoutlingError } from './errors.js'
import { isProbablyBinary } from './guardrails.js'

/**
 * ADR 0005: a file the caller hands a run from outside the scope — a saved diff, a plan, a list
 * of claims to check — placed in the prompt as evidence rather than made visible to any tool.
 * Unlike every model-supplied or config-supplied path in this codebase, an attachment path is
 * never run through `resolvePath`: it comes from the caller's own command line and is trusted
 * exactly like `--path` itself (ADR 0005's "considered options").
 */
export interface Attachment {
  /** Basename of the file as given, the `<name>` in an `@<name>:line` citation. */
  name: string
  /** The path the caller gave, resolved against cwd — for error messages only. */
  path: string
  content: string
  /** Same line accounting as read_file/citations: a trailing newline is not an extra line. */
  totalLines: number
}

/** DESIGN.md §7-style default, but attachments count against the model's context, not the tool-byte budget — so they get their own cap (ADR 0005), overridable with `--max-attach-bytes`. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 64_000

/** Line count matching `read_file`'s own accounting: a trailing newline doesn't count as an extra empty line. */
function countLines(content: string): number {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * Load every `--attach`ed file, in the order given. Throws `ScoutlingError('BAD_ARGS', …)` for
 * any of: a path that doesn't exist or isn't a regular file, binary content, two attachments
 * sharing a basename (their `@<name>:line` citations would be ambiguous), or the **sum** of every
 * attachment's byte length exceeding `maxTotalBytes`. Never truncates — an attachment over the
 * cap is a caller error to fix (split it, or raise the cap), not something scoutling silently
 * shrinks (the never-degrade-silently rule, CLAUDE.md).
 *
 * `cwd` is the process cwd the CLI was given; every path resolves against it with `node:path`
 * only, never through `resolvePath` — ADR 0005 is explicit that an attachment path is trusted
 * like `--path` itself, not treated as untrusted model/config input.
 */
export function loadAttachments(paths: string[], cwd: string, maxTotalBytes: number): Attachment[] {
  const attachments: Attachment[] = []
  const seenNames = new Set<string>()
  let totalBytes = 0

  for (const rawPath of paths) {
    const resolvedPath = resolve(cwd, rawPath)

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `attachment not found: ${resolvedPath}`,
        'Check the path and try again.',
      )
    }

    const name = basename(resolvedPath)
    if (seenNames.has(name)) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `duplicate attachment name: ${name}`,
        // Deliberately not the verb the brief used for this hint: that word is one of the fs
        // write-API identifiers test/no-write.test.ts bans anywhere in src/ (ADR 0002's static
        // gate), even inside a string with nothing to do with the filesystem.
        `@${name}:line citations would be ambiguous — give one of them a different name.`,
      )
    }
    seenNames.add(name)

    const buffer = readFileSync(resolvedPath)
    if (isProbablyBinary(buffer)) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `attachment is binary: ${resolvedPath}`,
        'Attachments are placed in the prompt as text; only text files are supported.',
      )
    }

    totalBytes += buffer.byteLength
    const content = buffer.toString('utf8')
    attachments.push({ name, path: resolvedPath, content, totalLines: countLines(content) })
  }

  if (totalBytes > maxTotalBytes) {
    throw new ScoutlingError(
      'BAD_ARGS',
      `attachments total ${totalBytes} bytes, over the ${maxTotalBytes} byte cap.`,
      'Split the attachment, or raise --max-attach-bytes.',
    )
  }

  return attachments
}

/** `path.padStart` width chosen so 1–4 digit line numbers line up like `read_file`'s own `formatLine` (`cat -n` style). */
function formatLine(lineNumber: number, text: string): string {
  return `${String(lineNumber).padStart(4)}→${text}`
}

/** Split attachment content into lines, dropping the phantom empty final "line" a trailing newline produces — mirrors `read_file`'s `splitLines`. */
function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The block placed before the question in the user prompt (`loop.ts`), one `###` heading per
 * attachment with `read_file`-style line numbers, so a model can cite `@<name>:line` the same way
 * it cites a scope file's `path:line`. `''` when there are no attachments, so a run with none
 * builds a prompt identical to before attachments existed.
 */
export function renderAttachmentsBlock(attachments: Attachment[]): string {
  if (attachments.length === 0) return ''

  const intro =
    'Attachments: files the caller supplied from outside the scope. They are evidence, not part ' +
    'of the scope: no tool can list, search or read them. Cite a line in one as @<name>:line (or ' +
    '@<name>:line-line).'

  const sections = attachments.map((attachment) => {
    const body = splitLines(attachment.content)
      .map((line, i) => formatLine(i + 1, line))
      .join('\n')
    return `### @${attachment.name} (${attachment.totalLines} lines)\n${body}`
  })

  return `${intro}\n\n${sections.join('\n\n')}\n\n`
}
