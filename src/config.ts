import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { ScoutlingError } from './errors.js'
import type {
  ConfigLayer,
  ConfigProvenance,
  ResolvedConfig,
  ScoutlingConfig,
} from './types.js'

/** Filename of the committed, team-wide config layer. */
export const SHARED_CONFIG_FILE = 'scoutling.config.json'
/** Filename of the gitignored, per-developer config layer. */
export const LOCAL_OVERRIDE_FILE = 'scoutling.config.local.json'

const CONFIG_KEYS = [
  'baseUrl',
  'model',
  'apiKey',
  'budget',
  'contextFiles',
  'contextFilesMaxChars',
  'excludeGlobs',
  'systemPromptFile',
  'temperature',
] as const

/**
 * Built-in defaults — the lowest layer. Deliberately no `model`: a baked-in
 * default would be a portability leak dressed as convenience (ADR 0003).
 */
export const BUILT_IN_DEFAULTS: ScoutlingConfig = {
  baseUrl: 'http://localhost:1234/v1',
  apiKey: 'not-needed',
  budget: 'normal',
  contextFiles: [],
  contextFilesMaxChars: 4000,
  excludeGlobs: ['node_modules/**', '.git/**', 'dist/**', 'out/**'],
  systemPromptFile: null,
  temperature: 0,
}

/** `SCOUTLING_*` variable → config key, with the parse each one needs. */
const ENV_KEYS: Record<string, { key: keyof ScoutlingConfig; parse: (raw: string) => unknown }> = {
  SCOUTLING_BASE_URL: { key: 'baseUrl', parse: (raw) => raw },
  SCOUTLING_MODEL: { key: 'model', parse: (raw) => raw },
  SCOUTLING_API_KEY: { key: 'apiKey', parse: (raw) => raw },
  SCOUTLING_BUDGET: { key: 'budget', parse: (raw) => raw },
  SCOUTLING_CONTEXT_FILES: { key: 'contextFiles', parse: parseList },
  SCOUTLING_CONTEXT_FILES_MAX_CHARS: { key: 'contextFilesMaxChars', parse: Number },
  SCOUTLING_EXCLUDE_GLOBS: { key: 'excludeGlobs', parse: parseList },
  SCOUTLING_SYSTEM_PROMPT_FILE: { key: 'systemPromptFile', parse: (raw) => raw },
  SCOUTLING_TEMPERATURE: { key: 'temperature', parse: Number },
}

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export interface LoadConfigOptions {
  /** Directory the run is allowed to see; both repo config files are looked up here only. */
  scopeRoot: string
  /** Settings the caller passed as command-line flags. */
  flags?: Partial<ScoutlingConfig>
  /** Injected so tests never depend on the ambient environment. */
  env?: NodeJS.ProcessEnv
}

/**
 * Resolve the six config layers into one config, recording which layer set each
 * key so `doctor` can answer "why is it using that model?" in one command.
 */
export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const { scopeRoot } = options
  const env = options.env ?? process.env
  const warnings: string[] = []

  const sharedConfig = readConfigFile(join(scopeRoot, SHARED_CONFIG_FILE))
  if (sharedConfig !== undefined && sharedConfig.apiKey !== undefined) {
    warnings.push(
      `apiKey found in ${SHARED_CONFIG_FILE}, which is committed to the repository. ` +
        `Move it to ${LOCAL_OVERRIDE_FILE}, the user config, or SCOUTLING_API_KEY.`,
    )
  }

  // Lowest layer first; each following layer overrides individual keys of the ones before it.
  const layers: Array<{ layer: ConfigLayer; values: Partial<ScoutlingConfig> | undefined }> = [
    { layer: 'built-in', values: BUILT_IN_DEFAULTS },
    { layer: 'user-config', values: readConfigFile(userConfigPath(env)) },
    { layer: 'shared-config', values: sharedConfig },
    { layer: 'local-override', values: readConfigFile(join(scopeRoot, LOCAL_OVERRIDE_FILE)) },
    { layer: 'environment', values: readEnv(env) },
    { layer: 'flag', values: options.flags },
  ]

  const config = { ...BUILT_IN_DEFAULTS }
  const provenance = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, 'built-in']),
  ) as ConfigProvenance

  for (const { layer, values } of layers) {
    if (values === undefined) continue
    for (const key of CONFIG_KEYS) {
      // An absent key is not an override; only a present one wins. Arrays are
      // whole values, so a higher layer replaces rather than concatenates.
      const value = values[key]
      if (value === undefined) continue
      Object.assign(config, { [key]: value })
      provenance[key] = layer
    }
  }

  config.contextFiles = dedupeByRealpath(config.contextFiles, scopeRoot)

  return { config, provenance, warnings }
}

/** `$XDG_CONFIG_HOME/scoutling/config.json`, falling back to `~/.config`. */
function userConfigPath(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config')
  return join(configHome, 'scoutling', 'config.json')
}

function readConfigFile(path: string): Partial<ScoutlingConfig> | undefined {
  if (!existsSync(path)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new ScoutlingError(
      'BAD_ARGS',
      `${path} is not valid JSON: ${(cause as Error).message}`,
      'Fix the file, or delete it to fall back to the layer below.',
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ScoutlingError('BAD_ARGS', `${path} must contain a JSON object.`)
  }

  return pickConfigKeys(parsed as Record<string, unknown>)
}

function readEnv(env: NodeJS.ProcessEnv): Partial<ScoutlingConfig> {
  const values: Record<string, unknown> = {}
  for (const [name, { key, parse }] of Object.entries(ENV_KEYS)) {
    const raw = env[name]
    if (raw === undefined) continue
    values[key] = parse(raw)
  }
  return values as Partial<ScoutlingConfig>
}

function pickConfigKeys(source: Record<string, unknown>): Partial<ScoutlingConfig> {
  const values: Record<string, unknown> = {}
  for (const key of CONFIG_KEYS) {
    if (source[key] !== undefined) values[key] = source[key]
  }
  return values as Partial<ScoutlingConfig>
}

/**
 * Collapse context files that name the same file. `AGENTS.md` is commonly a
 * symlink to `CLAUDE.md`, so listing both must not send the prose twice.
 */
function dedupeByRealpath(contextFiles: string[], scopeRoot: string): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []

  for (const entry of contextFiles) {
    const absolute = resolve(scopeRoot, entry)
    // A file that does not exist cannot be realpathed; keep it under its own
    // absolute path so the run can report it as missing rather than drop it.
    const identity = existsSync(absolute) ? realpathSync(absolute) : absolute
    if (seen.has(identity)) continue
    seen.add(identity)
    deduped.push(entry)
  }

  return deduped
}
