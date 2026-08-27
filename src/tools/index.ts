import { createGrepTool } from './grep.js'
import { createListDirTool } from './list-dir.js'
import { createReadFileTool } from './read-file.js'

export { createGrepTool } from './grep.js'
export { createListDirTool } from './list-dir.js'
export { createReadFileTool } from './read-file.js'

export interface ToolSetOptions {
  /** The scope root every tool is bound to — never model-supplied. */
  scopeRoot: string
  /** Passed through to `list_dir` and `grep`; config's excludeGlobs, never the model's. */
  excludeGlobs?: string[]
}

/**
 * Exactly the tools a run has — three named members, no index signature.
 *
 * Deliberately a `type` and not an `interface`: the AI SDK's own `ToolSet` is
 * `Record<string, Tool>`, and a type alias with only known properties gets an
 * implicit index signature for assignability while an interface does not. The
 * obvious workaround — declaring `[toolName: string]: Tool` here — would
 * typecheck, but it states that any string key may map to a tool, which is the
 * exact opposite of what this file exists to guarantee, and it would silence
 * the excess-property check that makes adding a `write_file` member an error.
 */
export type ToolSet = {
  read_file: ReturnType<typeof createReadFileTool>
  list_dir: ReturnType<typeof createListDirTool>
  grep: ReturnType<typeof createGrepTool>
}

/**
 * The complete capability set of a scoutling run: `read_file`, `list_dir`
 * and `grep`, all bound to `scopeRoot` at construction. Nothing else exists.
 *
 * This is the one place to look to verify the ADR 0002 guarantee — the
 * returned object has no write member and never will. `loop.ts` passes this
 * object to `generateText({ tools })` unmodified; a model can never call
 * anything not listed here (an unrecognized tool name surfaces to the model
 * as a `tool-error`, per `no-write.test.ts`).
 */
export function createTools(options: ToolSetOptions): ToolSet {
  return {
    read_file: createReadFileTool(options.scopeRoot),
    list_dir: createListDirTool(options.scopeRoot, { excludeGlobs: options.excludeGlobs }),
    grep: createGrepTool(options.scopeRoot, { excludeGlobs: options.excludeGlobs }),
  }
}
