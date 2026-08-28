#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { APICallError, RetryError } from 'ai'

import { isBudgetPreset, resolveBudget } from './budget.js'
import { loadConfig } from './config.js'
import { ScoutlingError } from './errors.js'
import { resolvePath, resolveScopeRoot } from './guardrails.js'
import { runScoutling, type StepSummary } from './loop.js'
import { formatAnswerJson, formatAnswerText, isOutputFormat, type OutputFormat } from './output.js'
import { buildSystemPrompt } from './prompt.js'
import { createProvider, listModels } from './provider.js'
import type { ScoutlingConfig } from './types.js'

const USAGE = `🐦 scoutling — read-only, bounded codebase investigation with list_dir, grep and read_file.

scoutling "<question>" --model <id> [--path <dir>] [--base-url <url>] [--api-key <key>]
          [--budget quick|normal|deep] [--max-steps <n>] [--max-tool-bytes <n>] [--timeout-ms <n>]
          [--format text|json] [--require-citations] [--verbose]
scoutling --help

Runs a bounded, read-only investigation of the directory tree at --path (default: the current
directory) and prints a cited answer to stdout.

  --model <id>          Model to run, e.g. qwen/qwen3-coder-next. Required (flag, env, or config).
  --path <dir>          Scope root — the only directory the run can see. Default: cwd.
  --base-url <url>      OpenAI-compatible endpoint. Default: http://localhost:1234/v1.
  --api-key <key>       Sent as a Bearer token. Default: not-needed (fine for LM Studio/Ollama).
  --budget <preset>     quick, normal or deep — sets maxSteps/maxToolBytes/timeoutMs together. Default: normal.
  --max-steps <n>       Maximum tool-call steps before the run stops and reports exhausted. Overrides --budget.
  --max-tool-bytes <n>  Cumulative tool-output byte cap before further tool calls are refused. Overrides --budget.
  --timeout-ms <n>      Whole-run wall-clock timeout, including model load. Overrides --budget.
  --format <fmt>        text (default) or json — see DESIGN.md §9 for the json object's shape.
  --require-citations   Exit 1 if the answer verifies zero citations against the scope.
  --verbose             Log one line per step to stderr (tool name, args, bytes returned).
  --help                Print this message and exit 0.

Examples:
  scoutling "Where is resolvePath defined?" --model qwen/qwen3-coder-next
  scoutling "What does this repo do?" --path ../other-repo --model qwen/qwen3-next-80b --verbose
  scoutling "Survey the auth module" --model qwen/qwen3-next-80b --budget deep
  scoutling "Where is X validated?" --model qwen/qwen3-coder-next --format json --require-citations`

export interface ParsedArgs {
  help: boolean
  verbose: boolean
  requireCitations: boolean
  question?: string
  model?: string
  path?: string
  baseUrl?: string
  apiKey?: string
  /** Validated against `isBudgetPreset` later, once merged with config-file/env sources — not here. */
  budget?: string
  maxSteps?: number
  maxToolBytes?: number
  timeoutMs?: number
  /**
   * Validated here, unlike `budget`: `--format` has no config-file/env layer
   * to merge with, so there is no reason to defer the check the way
   * `isBudgetPreset` is deferred to `runCli`.
   */
  format?: OutputFormat
}

const FLAGS_WITH_VALUE = {
  '--model': 'model',
  '--path': 'path',
  '--base-url': 'baseUrl',
  '--api-key': 'apiKey',
  '--budget': 'budget',
} as const

/** Flags parsed via this table get a genuine number, not a string forced through the string-keyed table above. */
const NUMERIC_FLAGS = {
  '--max-steps': 'maxSteps',
  '--max-tool-bytes': 'maxToolBytes',
  '--timeout-ms': 'timeoutMs',
} as const

const BOOLEAN_FLAGS = {
  '--verbose': 'verbose',
  '--help': 'help',
  '--require-citations': 'requireCitations',
} as const

/**
 * Pure argument parsing — no I/O, no config, no filesystem — so it is
 * exhaustively unit-testable. Fails loud on anything it does not recognize
 * (AXI principle: an unknown flag is an error, never silently ignored).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { help: false, verbose: false, requireCitations: false }
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token in BOOLEAN_FLAGS) {
      args[BOOLEAN_FLAGS[token as keyof typeof BOOLEAN_FLAGS]] = true
      continue
    }

    if (token === '--format') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new ScoutlingError('BAD_ARGS', `${token} requires a value.`, `Usage: ${token} <text|json>`)
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

    if (token in NUMERIC_FLAGS) {
      const rawValue = argv[i + 1]
      if (rawValue === undefined || rawValue.startsWith('--')) {
        throw new ScoutlingError('BAD_ARGS', `${token} requires a value.`, `Usage: ${token} <n>`)
      }
      const value = Number(rawValue)
      if (!Number.isInteger(value) || value < 1) {
        throw new ScoutlingError(
          'BAD_ARGS',
          `${token} must be a positive integer, got: ${rawValue}`,
          `Usage: ${token} <n>, e.g. ${token} 8`,
        )
      }
      args[NUMERIC_FLAGS[token as keyof typeof NUMERIC_FLAGS]] = value
      i += 1
      continue
    }

    if (token.startsWith('--')) {
      const validFlags = [
        ...Object.keys(FLAGS_WITH_VALUE),
        '--format',
        ...Object.keys(NUMERIC_FLAGS),
        ...Object.keys(BOOLEAN_FLAGS),
      ].join(', ')
      throw new ScoutlingError('BAD_ARGS', `Unknown flag: ${token}`, `Valid flags: ${validFlags}`)
    }

    positionals.push(token)
  }

  if (args.help) return args

  if (positionals.length === 0) {
    throw new ScoutlingError(
      'BAD_ARGS',
      'A question is required.',
      'scoutling "<question>" --model <id>',
    )
  }
  if (positionals.length > 1) {
    throw new ScoutlingError(
      'BAD_ARGS',
      `Unexpected extra argument(s): ${positionals.slice(1).join(' ')}`,
      'Quote the question so it is a single argument: scoutling "<question>" --model <id>',
    )
  }

  args.question = positionals[0]
  return args
}

function formatStepLog(step: StepSummary): string {
  const calls = step.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join(', ')
  return `[step ${step.index}] ${calls || '(answer)'} — ${step.bytes} bytes`
}

/**
 * Classify what generateText threw. A connection failure surfaces as
 * RetryError wrapping an APICallError whose statusCode is undefined — fetch
 * itself failed, so no HTTP response ever came back. An APICallError *with*
 * a statusCode is a real response from the provider (e.g. model not found)
 * and is reported as-is, not masked as "unreachable".
 */
function classifyRunError(error: unknown, baseUrl: string): ScoutlingError {
  const candidate = RetryError.isInstance(error) ? error.lastError : error

  if (APICallError.isInstance(candidate) && candidate.statusCode === undefined) {
    return new ScoutlingError(
      'PROVIDER_UNREACHABLE',
      `Could not reach the provider at ${baseUrl}.`,
      'Check --base-url and that the provider (e.g. LM Studio) is running.',
    )
  }

  if (error instanceof ScoutlingError) return error

  return new ScoutlingError('INTERNAL', error instanceof Error ? error.message : String(error))
}

/** Everything runCli needs from the outside world, all injectable for hermetic tests. */
export interface CliIO {
  argv: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Injected so tests never need a reachable provider. */
  fetch?: typeof fetch
  writeStdout?: (text: string) => void
  writeStderr?: (text: string) => void
}

/**
 * Run the CLI end to end and return the process exit code — never calls
 * `process.exit` itself, so it stays testable in-process.
 */
export async function runCli(io: CliIO): Promise<number> {
  const writeStdout = io.writeStdout ?? ((text: string) => process.stdout.write(text))
  const writeStderr = io.writeStderr ?? ((text: string) => process.stderr.write(text))
  const cwd = io.cwd ?? process.cwd()

  function emitError(error: ScoutlingError): number {
    writeStderr(`${JSON.stringify(error.toJSON())}\n`)
    return error.exitCode
  }

  let args: ParsedArgs
  try {
    args = parseArgs(io.argv)
  } catch (error) {
    return emitError(error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error)))
  }

  if (args.help) {
    writeStdout(`${USAGE}\n`)
    return 0
  }

  let scopeRoot: string
  try {
    scopeRoot = resolveScopeRoot(args.path ?? cwd)
  } catch (error) {
    return emitError(error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error)))
  }

  const flagOverrides: Partial<ScoutlingConfig> = {
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
    ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
    // Not validated as a real BudgetPreset here — parseArgs only knows it
    // received a string. isBudgetPreset checks it below, alongside
    // config.budget from every other layer (a config file, SCOUTLING_BUDGET),
    // none of which validate it at load time either.
    ...(args.budget !== undefined ? { budget: args.budget as ScoutlingConfig['budget'] } : {}),
  }

  const { config, warnings } = loadConfig({
    scopeRoot,
    env: io.env ?? process.env,
    flags: flagOverrides,
  })

  for (const warning of warnings) writeStderr(`warning: ${warning}\n`)

  if (!isBudgetPreset(config.budget)) {
    return emitError(
      new ScoutlingError(
        'BAD_ARGS',
        `--budget must be one of quick, normal, deep; got: ${config.budget}`,
        'Valid presets: quick, normal, deep.',
      ),
    )
  }

  if (!config.model) {
    let hint: string
    try {
      const models = await listModels({ baseUrl: config.baseUrl, apiKey: config.apiKey, fetch: io.fetch })
      hint =
        models.length > 0
          ? `Models available at ${config.baseUrl}: ${models.join(', ')}`
          : `${config.baseUrl} is reachable but has no models loaded.`
    } catch {
      hint = `${config.baseUrl} is unreachable, so the live model list is unavailable too. Check --base-url.`
    }
    return emitError(new ScoutlingError('BAD_ARGS', '--model is required.', hint))
  }

  let systemPromptOverride: string | undefined
  if (config.systemPromptFile !== null) {
    try {
      systemPromptOverride = readFileSync(resolvePath(scopeRoot, config.systemPromptFile), 'utf8')
    } catch {
      return emitError(
        new ScoutlingError(
          'BAD_ARGS',
          `systemPromptFile not found: ${config.systemPromptFile}`,
          'Fix or remove systemPromptFile in the config.',
        ),
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
    ...(io.fetch ? { fetch: io.fetch } : {}),
  })
  const model = provider.chatModel(config.model)

  const budget = resolveBudget(config.budget, {
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    ...(args.maxToolBytes !== undefined ? { maxToolOutputBytes: args.maxToolBytes } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  })

  const format: OutputFormat = args.format ?? 'text'

  try {
    const result = await runScoutling({
      question: args.question as string,
      scopeRoot,
      model,
      temperature: config.temperature,
      systemPrompt,
      excludeGlobs: config.excludeGlobs,
      budget,
      ...(args.verbose ? { onStep: (step: StepSummary) => writeStderr(`${formatStepLog(step)}\n`) } : {}),
    })

    writeStdout(format === 'json' ? formatAnswerJson(result, config.model) : `${formatAnswerText(result)}\n`)

    // Next-step hints (DESIGN.md §7/§9): a `warning` line on stderr, never
    // the `error` shape `emitError` writes, so a parent agent can always
    // tell "the run finished but you should know X" apart from "the run
    // failed with exit code Y". Both conditions are independent and can
    // both fire on the same run — each gets its own line.
    if (result.exhausted) {
      writeStderr(
        `${JSON.stringify({
          warning: 'BUDGET_EXHAUSTED',
          message: 'The run stopped before the model finished: a step or tool-output budget ran out.',
          hint: 'Narrow --path or ask a more specific question.',
        })}\n`,
      )
    }

    const citationsRequiredButMissing = args.requireCitations && result.citations.verifiedCount === 0
    if (citationsRequiredButMissing) {
      writeStderr(
        `${JSON.stringify({
          warning: 'NO_VERIFIED_CITATIONS',
          message: 'The answer did not cite any path:line that verifies against the scope.',
          hint: 'Try a narrower question, or drop --require-citations to accept the answer as-is.',
        })}\n`,
      )
    }

    // DESIGN.md §9: exit 1 covers both "answered but budget exhausted" and
    // "answered but --require-citations found nothing verified" — an answer
    // that hits both still exits 1, not some combined/worse code, since
    // there is only one non-zero "answered anyway" tier in the contract.
    return result.exhausted || citationsRequiredButMissing ? 1 : 0
  } catch (error) {
    return emitError(classifyRunError(error, config.baseUrl))
  }
}

/**
 * Is this module the program being executed, rather than one imported by a
 * test or another package?
 *
 * Must compare real file URLs, not interpolate a path into a `file://`
 * string: an install path containing a space (an npx cache directory, a
 * `My Documents`) percent-encodes in `import.meta.url` but not in a naive
 * template, and a Windows path uses backslashes and a drive letter. Either
 * mismatch makes the comparison silently false, so the CLI would exit 0
 * having printed nothing at all.
 */
export function isDirectEntry(importMetaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false
  return importMetaUrl === pathToFileURL(argv1).href
}

async function main(): Promise<void> {
  // Set the code rather than calling process.exit(), which can truncate a
  // still-draining stdout — and stdout is the whole product here.
  process.exitCode = await runCli({ argv: process.argv.slice(2) })
}

if (isDirectEntry(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ error: 'INTERNAL', message: String(error) }))
    process.exitCode = 10
  })
}
