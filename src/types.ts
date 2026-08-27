/** A named budget: the set of caps a run may not exceed, chosen with one word. */
export type BudgetPreset = 'quick' | 'normal' | 'deep'

/**
 * One of the ordered places a setting can come from. Each layer overrides the
 * ones below it; `flag` is highest, `built-in` lowest.
 */
export type ConfigLayer =
  | 'flag'
  | 'environment'
  | 'local-override'
  | 'shared-config'
  | 'user-config'
  | 'built-in'

/** Human-readable name of each config layer, for `scoutling doctor`. */
export const CONFIG_LAYER_LABELS: Record<ConfigLayer, string> = {
  flag: 'command-line flag',
  environment: 'SCOUTLING_* environment variable',
  'local-override': 'scoutling.config.local.json',
  'shared-config': 'scoutling.config.json',
  'user-config': '~/.config/scoutling/config.json',
  'built-in': 'built-in default',
}

/** Everything a run needs to know that is not the question or the scope. */
export interface ScoutlingConfig {
  /** OpenAI-compatible endpoint that serves the model. */
  baseUrl: string
  /** No built-in default: which models exist is a property of the machine. */
  model?: string
  apiKey: string
  budget: BudgetPreset
  /** Paths, relative to the scope root, of prose given to the model as project context. */
  contextFiles: string[]
  contextFilesMaxChars: number
  excludeGlobs: string[]
  /** Full replacement for the built-in system prompt, or null to use it. */
  systemPromptFile: string | null
  temperature: number
}

export type ConfigProvenance = Record<keyof ScoutlingConfig, ConfigLayer>

export interface ResolvedConfig {
  config: ScoutlingConfig
  /** Which layer set each key. This is what makes `doctor` able to answer "why that model?". */
  provenance: ConfigProvenance
  warnings: string[]
}
