import { existsSync, statSync } from 'node:fs'
import { z } from 'zod'
import { tool, type Tool } from 'ai'

import { resolvePath } from '../guardrails.js'
import { ScoutlingError } from '../errors.js'
import { walkScope } from '../scope-walk.js'

/** Entries beyond this are cut off; the caller gets a truncation note instead of an unbounded reply. */
const MAX_ENTRIES = 500

const DEFAULT_PATH = '.'
const DEFAULT_DEPTH = 1
const MIN_DEPTH = 1
const MAX_DEPTH = 3

/**
 * A refusal, shaped the same for every reason (outside scope, missing, not a
 * directory) so a small model only has to learn one error shape:
 * `{error, message, hint?}` instead of one per failure mode. Mirrors
 * `ReadFileRefusal` in read-file.ts.
 */
interface ListDirRefusal {
  error: string
  message: string
  hint?: string
}

/**
 * One listed entry. Called `name`, not `path`, because that is the
 * three-field `{name,type,size}` list-item contract from DESIGN.md §6 — but
 * for a `depth > 1` entry it still carries the path relative to the listed
 * directory (e.g. `sub/nested.txt`), not just a bare filename, so the model
 * can feed it straight back into `read_file` without reconstructing it.
 */
interface ListDirEntry {
  name: string
  type: 'file' | 'dir'
  size: number
}

interface ListDirResult {
  path: string
  entries: ListDirEntry[]
  /** Definitive empty state / truncation explanation, AXI principle 5 + 3. */
  note?: string
}

const inputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(`Directory to list, relative to the scope root (default "${DEFAULT_PATH}").`),
  depth: z
    .number()
    .int()
    .min(MIN_DEPTH)
    .max(MAX_DEPTH)
    .optional()
    .describe(
      `How many levels deep to list, ${MIN_DEPTH}-${MAX_DEPTH} (default ${DEFAULT_DEPTH}). ` +
        `${DEFAULT_DEPTH} = this directory's own entries only.`,
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Ripgrep-style glob that filters which entries are returned — it never changes which ' +
        'directories are traversed. A glob with no "/" matches the basename at any depth ' +
        '(e.g. "*.ts"); a glob containing "/" matches the path relative to the listed directory.',
    ),
})

/** A local model can emit a depth outside 1-3 even with a schema bound in place; enforce it in code too. */
function clampDepth(depth: number): number {
  return Math.min(Math.max(depth, MIN_DEPTH), MAX_DEPTH)
}

/**
 * The directory-listing tool of Phase 3. Delegates the actual traversal to
 * `walkScope` (gitignore + `excludeGlobs` + glob filtering all live there,
 * shared with `grep`) and adds the tool-facing concerns: input defaults and
 * clamping, refusal shapes, and definitive empty/truncation notes.
 *
 * The scope root is bound at construction (a factory, not a model-supplied
 * argument) so the model can never widen its own scope by passing a
 * different root. `excludeGlobs` likewise comes from config, never the model.
 */
export function createListDirTool(
  scopeRoot: string,
  options?: { excludeGlobs?: string[] },
): Tool<z.infer<typeof inputSchema>, ListDirResult | ListDirRefusal> {
  const excludeGlobs = options?.excludeGlobs

  return tool({
    description:
      'List the entries (files and subdirectories) of a directory in the scope, optionally ' +
      'several levels deep and filtered by glob.',
    inputSchema,
    execute: async ({
      path = DEFAULT_PATH,
      depth = DEFAULT_DEPTH,
      glob,
    }): Promise<ListDirResult | ListDirRefusal> => {
      const clampedDepth = clampDepth(depth)

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
          message: `Directory not found: ${path}`,
          hint: 'Check the path, e.g. with a directory listing of its parent.',
        }
      }

      const stats = statSync(resolvedPath)
      if (!stats.isDirectory()) {
        return {
          error: 'NOT_A_DIRECTORY',
          message: `${path} is a file, not a directory.`,
          hint: 'Use read_file to read it instead.',
        }
      }

      const { entries: walkEntries, truncated } = walkScope({
        scopeRoot,
        dir: resolvedPath,
        depth: clampedDepth,
        glob,
        excludeGlobs,
        limit: MAX_ENTRIES,
      })

      const entries: ListDirEntry[] = walkEntries.map((entry) => ({
        name: entry.path,
        type: entry.type,
        size: entry.size,
      }))

      // Phase 4 wraps this result in TOON per DESIGN.md §6; Phase 3 (this
      // slice) returns plain JSON, so don't mistake the absence for an
      // oversight.
      if (entries.length === 0) {
        const note = glob === undefined ? 'directory is empty' : `no entries matching ${glob} under ${path}`
        return { path, entries, note }
      }

      if (truncated) {
        return {
          path,
          entries,
          note: `listing capped at ${MAX_ENTRIES} entries; narrow path or add a glob to see more`,
        }
      }

      return { path, entries }
    },
  })
}
