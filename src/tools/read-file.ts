import { existsSync, readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import { tool, type Tool } from 'ai'

import { isProbablyBinary, resolvePath } from '../guardrails.js'
import { ScoutlingError } from '../errors.js'
import { describeExclusionReason, explainPathExclusion } from '../scope-walk.js'

/** Files larger than this are refused rather than dumped whole into context. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

const DEFAULT_LIMIT = 400
const MAX_LIMIT = 2000
const DEFAULT_OFFSET = 1

/**
 * A refusal, shaped the same for every reason (outside scope, missing,
 * binary, too large) so a small model only has to learn one error shape:
 * `{error, message, hint?}` instead of one per failure mode.
 */
interface ReadFileRefusal {
  error: string
  message: string
  hint?: string
}

/**
 * A successful read. `totalLines` is always the file's real total — even
 * when `content` covers only part of it — so the model can decide to
 * paginate (bump `offset`) instead of re-reading from the start. `note`
 * carries a definitive-empty-state explanation (AXI principle 5) when
 * `content` is `""` for a reason other than "you asked for zero lines".
 */
interface ReadFileResult {
  path: string
  offset: number
  limit: number
  totalLines: number
  content: string
  note?: string
}

const inputSchema = z.object({
  path: z.string().describe('Path to the file, relative to the scope root.'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`1-based line number to start from (default ${DEFAULT_OFFSET}).`),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum number of lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
})

/** Split file content into lines, dropping the phantom empty final "line" a trailing newline produces. */
function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** `path.padStart` width chosen so 1–4 digit line numbers line up like `cat -n`. */
function formatLine(lineNumber: number, text: string): string {
  return `${String(lineNumber).padStart(4)}→${text}`
}

/**
 * The one read-only tool of Phase 2. Returns line-numbered text (not TOON —
 * prose/code isn't tabular) plus `totalLines`, so a model that wants more of
 * a long file pages forward with `offset` instead of re-reading everything
 * it already has in context.
 *
 * The scope root is bound at construction (a factory, not a model-supplied
 * argument) so the model can never widen its own scope by passing a
 * different root. `excludeGlobs` likewise comes from config, never the
 * model — mirrors `createListDirTool`/`createGrepTool` (Phase 5 follow-up:
 * before this, `read_file` was the one tool of the three that ignored
 * `excludeGlobs` and `.gitignore` entirely, so it could read `.git/HEAD` or
 * a gitignored secret file that `list_dir` would never surface — DESIGN.md
 * §15 "bug B").
 */
export function createReadFileTool(
  scopeRoot: string,
  options?: { excludeGlobs?: string[] },
): Tool<z.infer<typeof inputSchema>, ReadFileResult | ReadFileRefusal> {
  const excludeGlobs = options?.excludeGlobs ?? []

  return tool({
    description:
      'Read a text file from the scope, with line numbers. Returns totalLines so you can ' +
      'page forward with offset instead of re-reading from the start.',
    inputSchema,
    execute: async ({
      path,
      offset = DEFAULT_OFFSET,
      limit = DEFAULT_LIMIT,
    }): Promise<ReadFileResult | ReadFileRefusal> => {
      const clampedLimit = Math.min(limit, MAX_LIMIT)

      let resolvedPath: string
      try {
        resolvedPath = resolvePath(scopeRoot, path)
      } catch (error) {
        if (error instanceof ScoutlingError) {
          return { error: error.code, message: error.message, hint: error.hint }
        }
        throw error
      }

      // Visibility is a property of the path, not of whether it currently
      // exists (DESIGN.md §15 "bug B"), so this runs before existsSync — a
      // caller retrying a gitignored path with a different offset should
      // still get PATH_EXCLUDED, not PATH_NOT_FOUND, on every attempt.
      const exclusionReason = explainPathExclusion(scopeRoot, resolvedPath, { excludeGlobs })
      if (exclusionReason !== undefined) {
        return {
          error: 'PATH_EXCLUDED',
          message: `${path} is outside the visible scope: ${describeExclusionReason(exclusionReason)}.`,
          hint: 'This path is deliberately excluded (excludeGlobs, .gitignore, or .git/) — pick a different file.',
        }
      }

      if (!existsSync(resolvedPath)) {
        return {
          error: 'PATH_NOT_FOUND',
          message: `File not found: ${path}`,
          hint: 'Check the path, e.g. with a directory listing of its parent.',
        }
      }

      const stats = statSync(resolvedPath)
      if (stats.isDirectory()) {
        return {
          error: 'NOT_A_FILE',
          message: `${path} is a directory, not a file.`,
          hint: 'Pass a file path.',
        }
      }

      if (stats.size > MAX_FILE_BYTES) {
        return {
          error: 'FILE_TOO_LARGE',
          message: `${path} is ${(stats.size / (1024 * 1024)).toFixed(1)} MB, over the 2 MB read limit.`,
          hint: 'Narrow the request, e.g. grep for the part you need instead of reading the whole file.',
        }
      }

      const buffer = readFileSync(resolvedPath)
      if (isProbablyBinary(buffer)) {
        return {
          error: 'BINARY_FILE',
          message: `${path} looks like a binary file, not text.`,
          hint: 'read_file only handles text files.',
        }
      }

      const lines = splitLines(buffer.toString('utf8'))
      const totalLines = lines.length

      if (totalLines === 0) {
        return { path, offset, limit: clampedLimit, totalLines, content: '', note: 'file is empty' }
      }

      if (offset > totalLines) {
        return {
          path,
          offset,
          limit: clampedLimit,
          totalLines,
          content: '',
          note: `offset ${offset} is past the end of the file (${totalLines} lines)`,
        }
      }

      const startIndex = offset - 1
      const endIndex = Math.min(startIndex + clampedLimit, totalLines)
      const content = lines
        .slice(startIndex, endIndex)
        .map((line, i) => formatLine(offset + i, line))
        .join('\n')

      return { path, offset, limit: clampedLimit, totalLines, content }
    },
  })
}
