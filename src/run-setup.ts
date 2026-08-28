import { readFileSync } from 'node:fs'
import type { LanguageModel } from 'ai'

import { ScoutlingError } from './errors.js'
import { resolvePath } from './guardrails.js'
import { buildSystemPrompt } from './prompt.js'
import { createProvider } from './provider.js'
import type { ScoutlingConfig } from './types.js'

export interface RunInputsOptions {
  /** Already resolved (`resolveScopeRoot`) — never re-resolved here, matching `loop.ts`'s own trust boundary. */
  scopeRoot: string
  /** Must have a `model`; a config missing one is a caller bug (the CLI checks this earlier, with a live-models-list hint), so this throws rather than silently building an unusable model. */
  config: ScoutlingConfig
  /** Injected so tests, and the eval harness, never need a reachable provider. */
  fetch?: typeof fetch
}

export interface RunInputs {
  model: LanguageModel
  systemPrompt: string
}

/**
 * Everything a run needs that is derived from resolved config: the
 * provider-bound model and the assembled system prompt.
 *
 * Shared by the CLI (`cli.ts`) and the eval harness (`eval/run-eval.ts`) so
 * the eval can never measure a different system prompt — or a differently
 * constructed model — than the CLI ships. Before this existed, that wiring
 * lived only inline in `cli.ts`; extracting it here is what makes it
 * possible to call it identically from two places without copy-pasting the
 * `systemPromptFile` read (and its `BAD_ARGS` error) a second time.
 */
export function buildRunInputs(options: RunInputsOptions): RunInputs {
  const { scopeRoot, config } = options

  if (!config.model) {
    throw new ScoutlingError(
      'BAD_ARGS',
      '--model is required.',
      'Pass --model, or set it via config/env — see DESIGN.md §5.',
    )
  }

  let systemPromptOverride: string | undefined
  if (config.systemPromptFile !== null) {
    try {
      systemPromptOverride = readFileSync(resolvePath(scopeRoot, config.systemPromptFile), 'utf8')
    } catch {
      throw new ScoutlingError(
        'BAD_ARGS',
        `systemPromptFile not found: ${config.systemPromptFile}`,
        'Fix or remove systemPromptFile in the config.',
      )
    }
  }

  const systemPrompt = buildSystemPrompt({
    scopeRoot,
    contextFiles: config.contextFiles,
    contextFilesMaxChars: config.contextFilesMaxChars,
    ...(systemPromptOverride !== undefined ? { systemPromptOverride } : {}),
  })

  const provider = createProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const model = provider.chatModel(config.model)

  return { model, systemPrompt }
}
