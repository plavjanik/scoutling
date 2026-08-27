import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BuildSystemPromptOptions {
  /** The scope root, already resolved (DESIGN.md §6). */
  scopeRoot: string
  /** Paths, relative to the scope root, of prose given to the model as project context. */
  contextFiles?: string[]
  /** Each context file is truncated at this many characters. */
  contextFilesMaxChars?: number
  /** Full replacement for the built-in prompt (config's `systemPromptFile`, already read). */
  systemPromptOverride?: string
}

const DEFAULT_CONTEXT_FILES_MAX_CHARS = 4000

/**
 * Build the system prompt for a run: the built-in prompt (or a full
 * replacement) plus a "Project context" block assembled from `contextFiles`.
 *
 * `systemPromptOverride` fully replaces the built-in prompt — including
 * project context — for special uses (e.g. a doc-vs-code audit template)
 * that want to control every word the model sees before the question.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  if (options.systemPromptOverride !== undefined) {
    return options.systemPromptOverride
  }

  const contextBlock = buildProjectContextBlock(
    options.scopeRoot,
    options.contextFiles ?? [],
    options.contextFilesMaxChars ?? DEFAULT_CONTEXT_FILES_MAX_CHARS,
  )

  return [contextBlock, builtInPrompt(options.scopeRoot)].filter((part) => part.length > 0).join('\n\n')
}

function builtInPrompt(scopeRoot: string): string {
  return [
    'You are scoutling, a read-only investigator. You have no capability to change, create or',
    'delete anything — there is no write tool, so this is not a rule you could break even if',
    'asked to.',
    '',
    `Your scope root is: ${scopeRoot}`,
    'Nothing outside this directory tree exists as far as you are concerned. Use the read_file',
    'tool to investigate; it paginates long files via offset/limit rather than truncating them.',
    '',
    'Cite your evidence: every factual claim in your answer must carry a path:line (or',
    'path:line-line) citation pointing at the file and line you saw it in, relative to the scope',
    'root.',
    '',
    'If you run out of budget (steps) before you are confident in an answer, say so explicitly —',
    'state what you were not able to verify — rather than guessing or presenting a plausible',
    'answer as fact.',
    '',
    'Answer in the language of the question.',
  ].join('\n')
}

/**
 * Read each context file relative to the scope root, truncate it at
 * `maxChars` with a visible note, and skip a file that does not exist —
 * project context is a convenience, not a requirement the run should fail
 * over.
 */
function buildProjectContextBlock(scopeRoot: string, contextFiles: string[], maxChars: number): string {
  const sections = contextFiles
    .map((file) => readContextFile(scopeRoot, file, maxChars))
    .filter((section): section is string => section !== undefined)

  if (sections.length === 0) return ''

  return ['Project context', '', ...sections].join('\n')
}

function readContextFile(scopeRoot: string, file: string, maxChars: number): string | undefined {
  let content: string
  try {
    content = readFileSync(join(scopeRoot, file), 'utf8')
  } catch {
    return undefined
  }

  const truncated =
    content.length > maxChars
      ? `${content.slice(0, maxChars)}\n... (truncated, ${content.length} chars total)`
      : content

  return `### ${file}\n\n${truncated}`
}
