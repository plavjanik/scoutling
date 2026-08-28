import { existsSync } from 'node:fs'
import { rgPath as bundledRgPath } from '@vscode/ripgrep'

import { BUILT_IN_DEFAULTS, loadConfig } from './config.js'
import { ScoutlingError } from './errors.js'
import { resolveScopeRoot } from './guardrails.js'
import { isOutputFormat, type OutputFormat } from './output.js'
import { listModels } from './provider.js'
import { CONFIG_LAYER_LABELS, type ConfigProvenance, type ScoutlingConfig } from './types.js'

export const MODELS_USAGE = `scoutling models [--base-url <url>] [--api-key <key>] [--path <dir>] [--format text|json]

Prints the model ids the configured (or overridden) provider currently has available — the same
live list a missing --model error already includes. Does not require --model.

  --base-url <url>   OpenAI-compatible endpoint. Default: from the resolved config (see 'scoutling doctor').
  --api-key <key>    Sent as a Bearer token. Default: from the resolved config.
  --path <dir>       Directory whose scoutling.config.json / .local.json are read. Default: cwd.
  --format <fmt>     text (default, one model id per line) or json ({"models":[...],"baseUrl":...}).
  --help             Print this message and exit 0.

Exit codes: 0 ok (including "no models loaded", which is reported explicitly, not silently) ·
2 BAD_ARGS (bad flag) · 3 PROVIDER_UNREACHABLE.

Examples:
  scoutling models
  scoutling models --base-url http://localhost:11434/v1 --format json`

export const DOCTOR_USAGE = `scoutling doctor [--base-url <url>] [--api-key <key>] [--path <dir>] [--format text|json]

Prints the resolved config and which layer set each key (DESIGN.md §5), then reports: is the
base URL reachable, is the configured model actually loaded there, is the bundled ripgrep binary
on disk, and (best-effort, vendor-specific) what context length the configured model is loaded
with. Does not require --model — diagnosing a missing one is exactly its job.

  --base-url <url>   Override the base URL to check, instead of the resolved config's.
  --api-key <key>    Override the API key to check, instead of the resolved config's.
  --path <dir>       Directory whose scoutling.config.json / .local.json are read. Default: cwd.
  --format <fmt>     text (default) or json.
  --help             Print this message and exit 0.

Exit codes: 0 no problems found · 1 a problem was found (unreachable provider, configured model
not loaded, missing ripgrep binary, or a probed context length under 32768) · 2 BAD_ARGS (bad flag).

Examples:
  scoutling doctor
  scoutling doctor --format json`

/** Everything the two subcommands need from the outside world — the `CliIO` subset that applies to them. */
export interface SubcommandIO {
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Injected so tests never need a reachable provider. */
  fetch?: typeof fetch
  writeStdout: (text: string) => void
  writeStderr: (text: string) => void
}

interface SubcommandArgs {
  help: boolean
  format?: OutputFormat
  path?: string
  baseUrl?: string
  apiKey?: string
}

const FLAGS_WITH_VALUE = {
  '--path': 'path',
  '--base-url': 'baseUrl',
  '--api-key': 'apiKey',
} as const

const VALID_FLAGS = ['--path', '--base-url', '--api-key', '--format', '--help']

/**
 * `models` and `doctor` share the same small flag set — neither needs
 * `--model` (§ the whole point of `doctor` is diagnosing its absence) — so
 * one parser serves both, parameterized only by the command name for error
 * messages. Unknown flags and stray positionals are rejected here, the same
 * "fail loud" guarantee `parseArgs` gives the main command (AXI principle 6).
 */
function parseSubcommandArgs(command: string, argv: string[]): SubcommandArgs {
  const args: SubcommandArgs = { help: false }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token === '--help') {
      args.help = true
      continue
    }

    if (token === '--format') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new ScoutlingError('BAD_ARGS', '--format requires a value.', `Usage: scoutling ${command} --format <text|json>`)
      }
      if (!isOutputFormat(value)) {
        throw new ScoutlingError(
          'BAD_ARGS',
          `--format must be one of text, json; got: ${value}`,
          'Valid formats: text, json.',
        )
      }
      args.format = value
      i += 1
      continue
    }

    if (token in FLAGS_WITH_VALUE) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new ScoutlingError('BAD_ARGS', `${token} requires a value.`, `Usage: ${token} <value>`)
      }
      args[FLAGS_WITH_VALUE[token as keyof typeof FLAGS_WITH_VALUE]] = value
      i += 1
      continue
    }

    if (token.startsWith('--')) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `Unknown flag: ${token}`,
        `Valid flags for scoutling ${command}: ${VALID_FLAGS.join(', ')}`,
      )
    }

    throw new ScoutlingError(
      'BAD_ARGS',
      `Unexpected argument: ${token}`,
      `scoutling ${command} takes no positional arguments. See scoutling ${command} --help`,
    )
  }

  return args
}

function emitCommandError(writeStderr: (text: string) => void, error: unknown): number {
  const scoutlingError = error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error))
  writeStderr(`${JSON.stringify(scoutlingError.toJSON())}\n`)
  return scoutlingError.exitCode
}

/** Resolve config for a subcommand: same scope-root + layered-config machinery `runCli` uses for the main command. */
function resolveSubcommandConfig(
  args: SubcommandArgs,
  io: SubcommandIO,
): { scopeRoot: string; config: ScoutlingConfig; provenance: ConfigProvenance; warnings: string[] } {
  const cwd = io.cwd ?? process.cwd()
  const scopeRoot = resolveScopeRoot(args.path ?? cwd)

  const { config, provenance, warnings } = loadConfig({
    scopeRoot,
    env: io.env ?? process.env,
    flags: {
      ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
      ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
    },
  })

  return { scopeRoot, config, provenance, warnings }
}

/**
 * `GET <base-url>/models`, printed for humans to answer "what can I pass to
 * --model?" (DESIGN.md §9). Reuses `listModels` from provider.ts rather than
 * a second fetch — a second implementation would be a second place to get
 * the timeout/error handling subtly wrong.
 */
export async function runModelsCommand(argv: string[], io: SubcommandIO): Promise<number> {
  let args: SubcommandArgs
  try {
    args = parseSubcommandArgs('models', argv)
  } catch (error) {
    return emitCommandError(io.writeStderr, error)
  }

  if (args.help) {
    io.writeStdout(`${MODELS_USAGE}\n`)
    return 0
  }

  let scopeRoot: string
  let config: ScoutlingConfig
  try {
    ;({ scopeRoot, config } = resolveSubcommandConfig(args, io))
  } catch (error) {
    return emitCommandError(io.writeStderr, error)
  }
  void scopeRoot // only needed to locate the config files; not used further here.

  let models: string[]
  try {
    models = await listModels({ baseUrl: config.baseUrl, apiKey: config.apiKey, fetch: io.fetch })
  } catch {
    return emitCommandError(
      io.writeStderr,
      new ScoutlingError(
        'PROVIDER_UNREACHABLE',
        `Could not reach the provider at ${config.baseUrl}.`,
        'Check --base-url and that the provider (e.g. LM Studio) is running.',
      ),
    )
  }

  const format: OutputFormat = args.format ?? 'text'

  if (format === 'json') {
    io.writeStdout(`${JSON.stringify({ models, baseUrl: config.baseUrl }, null, 2)}\n`)
    return 0
  }

  // Definitive empty state (AXI principle 5): a reachable provider with
  // nothing loaded says so explicitly, rather than printing nothing and
  // leaving the caller to wonder whether the command even ran.
  if (models.length === 0) {
    io.writeStdout(`No models are loaded at ${config.baseUrl}.\n`)
    return 0
  }

  io.writeStdout(`${models.join('\n')}\n`)
  return 0
}

/** One field of `doctor`'s "which layer set this" report. Mirrors `ScoutlingConfig`, `apiKey` excepted (see below). */
type ConfigFinding =
  | { key: 'apiKey'; set: boolean; layer: string }
  | { key: Exclude<keyof ScoutlingConfig, 'apiKey'>; value: unknown; layer: string }

function buildConfigFindings(config: ScoutlingConfig, provenance: ConfigProvenance): ConfigFinding[] {
  const keys = Object.keys(provenance) as (keyof ScoutlingConfig)[]
  return keys.map((key) => {
    const layer = CONFIG_LAYER_LABELS[provenance[key]]
    // The API key's *value* must never reach stdout/stderr — a doctor run is
    // exactly the kind of thing that ends up pasted into a terminal
    // transcript or a CI log. Only whether one is configured, and from
    // which layer, is reported.
    if (key === 'apiKey') {
      return { key, set: config.apiKey !== BUILT_IN_DEFAULTS.apiKey, layer }
    }
    return { key, value: config[key], layer }
  })
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '(none)'
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ')
  return String(value)
}

/**
 * LM Studio's OpenAI-compatible `/v1/models` (what `listModels` calls) does
 * not expose context length. LM Studio's *native* `/api/v0/models` does —
 * verified on the reference machine (DESIGN.md §7) — returning
 * `max_context_length` / `loaded_context_length` per model. Scoutling stays
 * provider-agnostic (ADR 0003): nothing else in this codebase may assume
 * LM Studio, and this probe must not either. It is opportunistic — derived
 * purely from the base URL's origin, tried with a short timeout, and on any
 * failure or unexpected response shape the finding is simply "unknown",
 * never an error that blocks the rest of `doctor`.
 */
type ContextLengthFinding =
  | { checked: true; source: string; loadedContextLength: number; maxContextLength?: number; warning: boolean }
  | { checked: false; reason: string }

export const CONTEXT_LENGTH_WARNING_THRESHOLD = 32_768
const CONTEXT_LENGTH_PROBE_TIMEOUT_MS = 2000

interface LmStudioNativeModel {
  id?: string
  loaded_context_length?: number
  max_context_length?: number
}

async function probeContextLength(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch,
): Promise<ContextLengthFinding> {
  let probeUrl: string
  try {
    probeUrl = `${new URL(baseUrl).origin}/api/v0/models`
  } catch {
    return { checked: false, reason: `${baseUrl} is not a valid URL` }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CONTEXT_LENGTH_PROBE_TIMEOUT_MS)

  try {
    const response = await fetchImpl(probeUrl, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) {
      return { checked: false, reason: `${probeUrl} returned ${response.status} (not an LM Studio native endpoint, or unreachable)` }
    }

    const body = (await response.json()) as { data?: LmStudioNativeModel[] }
    const entry = (body.data ?? []).find((candidate) => candidate.id === model)
    if (entry === undefined || typeof entry.loaded_context_length !== 'number') {
      return { checked: false, reason: `${probeUrl} did not report a loaded context length for ${model}` }
    }

    return {
      checked: true,
      source: 'LM Studio native /api/v0/models (vendor-specific, best-effort)',
      loadedContextLength: entry.loaded_context_length,
      ...(typeof entry.max_context_length === 'number' ? { maxContextLength: entry.max_context_length } : {}),
      warning: entry.loaded_context_length < CONTEXT_LENGTH_WARNING_THRESHOLD,
    }
  } catch {
    return { checked: false, reason: `${probeUrl} did not answer (not an LM Studio native endpoint, or unreachable)` }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * DESIGN.md §5/§9: the resolved config, which layer set each key, and a set
 * of reachability checks. A failure in any one check is a *finding* to
 * report, never a reason to stop early — `doctor`'s whole job is surfacing
 * problems, so it must not die on the first one it hits.
 */
export async function runDoctorCommand(argv: string[], io: SubcommandIO): Promise<number> {
  let args: SubcommandArgs
  try {
    args = parseSubcommandArgs('doctor', argv)
  } catch (error) {
    return emitCommandError(io.writeStderr, error)
  }

  if (args.help) {
    io.writeStdout(`${DOCTOR_USAGE}\n`)
    return 0
  }

  let config: ScoutlingConfig
  let provenance: ConfigProvenance
  let warnings: string[]
  try {
    ;({ config, provenance, warnings } = resolveSubcommandConfig(args, io))
  } catch (error) {
    return emitCommandError(io.writeStderr, error)
  }
  for (const warning of warnings) io.writeStderr(`warning: ${warning}\n`)

  const fetchImpl = io.fetch ?? fetch
  const problems: string[] = []

  let models: string[] = []
  let reachable = true
  let reachError: string | undefined
  try {
    models = await listModels({ baseUrl: config.baseUrl, apiKey: config.apiKey, fetch: io.fetch })
  } catch (error) {
    reachable = false
    reachError = error instanceof Error ? error.message : String(error)
    problems.push('provider unreachable')
  }

  let modelPresent: boolean | null = null
  if (config.model === undefined) {
    // No model configured is a finding, not a neutral fact. `--model` is the
    // one hard requirement (DESIGN.md §5) and no layer supplies a default, so
    // a config in this state cannot run anything — reporting "no problems
    // found" for it would be exactly the misdiagnosis doctor exists to
    // prevent. It stays a *finding* rather than an error because the model
    // can still legitimately arrive as a per-invocation flag.
    problems.push('no model configured')
  } else if (reachable) {
    modelPresent = models.includes(config.model)
    if (!modelPresent) problems.push('configured model not loaded')
  }

  const rgPresent = existsSync(bundledRgPath)
  if (!rgPresent) problems.push('ripgrep binary missing')

  let contextLength: ContextLengthFinding = { checked: false, reason: 'no model configured' }
  if (config.model !== undefined) {
    contextLength = await probeContextLength(config.baseUrl, config.apiKey, config.model, fetchImpl)
    if (contextLength.checked && contextLength.warning) problems.push('context length under 32768')
  }

  const format: OutputFormat = args.format ?? 'text'
  const configFindings = buildConfigFindings(config, provenance)

  if (format === 'json') {
    io.writeStdout(
      `${JSON.stringify(
        {
          config: Object.fromEntries(
            configFindings.map((finding) =>
              finding.key === 'apiKey'
                ? [finding.key, { set: finding.set, layer: finding.layer }]
                : [finding.key, { value: finding.value, layer: finding.layer }],
            ),
          ),
          provider: {
            baseUrl: config.baseUrl,
            reachable,
            ...(reachError !== undefined ? { error: reachError } : {}),
            models,
            modelConfigured: config.model ?? null,
            modelPresent,
          },
          ripgrep: { path: bundledRgPath, present: rgPresent },
          contextLength,
          problems,
        },
        null,
        2,
      )}\n`,
    )
    return problems.length === 0 ? 0 : 1
  }

  const lines: string[] = ['config:']
  for (const finding of configFindings) {
    const value = finding.key === 'apiKey' ? (finding.set ? 'set' : 'not set') : formatConfigValue(finding.value)
    lines.push(`  ${finding.key}: ${value} [${finding.layer}]`)
  }

  lines.push('')
  lines.push(
    reachable
      ? `provider: reachable — ${models.length} model(s) loaded at ${config.baseUrl}`
      : `provider: NOT reachable at ${config.baseUrl} — ${reachError}`,
  )
  if (config.model === undefined) {
    lines.push(
      'model: none configured — no layer sets one and there is no built-in default, so a run ' +
        'needs --model. Run `scoutling models` to see what this provider has loaded.',
    )
  } else if (!reachable) {
    lines.push(`model: ${config.model} (cannot verify — provider unreachable)`)
  } else {
    lines.push(`model: ${config.model} — ${modelPresent ? 'present' : 'NOT loaded'} on the provider`)
  }

  lines.push('')
  lines.push(`ripgrep: ${bundledRgPath} — ${rgPresent ? 'present' : 'NOT found'}`)

  lines.push('')
  if (contextLength.checked) {
    const bound = contextLength.maxContextLength !== undefined ? `, max ${contextLength.maxContextLength}` : ''
    lines.push(
      `context length (${contextLength.source}): loaded ${contextLength.loadedContextLength}${bound}` +
        (contextLength.warning ? ` — WARNING: under ${CONTEXT_LENGTH_WARNING_THRESHOLD}` : ' — ok'),
    )
  } else {
    lines.push(`context length: unknown (${contextLength.reason})`)
  }

  lines.push('')
  lines.push(problems.length === 0 ? 'result: no problems found' : `result: ${problems.length} problem(s) found: ${problems.join(', ')}`)

  io.writeStdout(`${lines.join('\n')}\n`)
  return problems.length === 0 ? 0 : 1
}
