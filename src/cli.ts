#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { APICallError, RetryError } from 'ai'

import { loadConfig } from './config.js'
import { ScoutlingError } from './errors.js'
import { resolvePath, resolveScopeRoot } from './guardrails.js'
import { runScoutling, type StepSummary } from './loop.js'
import { buildSystemPrompt } from './prompt.js'
import { createProvider, listModels } from './provider.js'
import type { ScoutlingConfig } from './types.js'

const USAGE = `🐦 scoutling — read-only, bounded codebase investigation with list_dir, grep and read_file.

scoutling "<question>" --model <id> [--path <dir>] [--base-url <url>] [--api-key <key>]
          [--max-steps <n>] [--verbose]
scoutling --help

Runs a bounded, read-only investigation of the directory tree at --path (default: the current
directory) and prints a cited answer to stdout.

  --model <id>        Model to run, e.g. qwen/qwen3-coder-next. Required (flag, env, or config).
  --path <dir>        Scope root — the only directory the run can see. Default: cwd.
  --base-url <url>    OpenAI-compatible endpoint. Default: http://localhost:1234/v1.
  --api-key <key>     Sent as a Bearer token. Default: not-needed (fine for LM Studio/Ollama).
  --max-steps <n>     Maximum tool-call steps before the run stops and reports exhausted. Default: 8.
  --verbose           Log one line per step to stderr (tool name, args, bytes returned).
  --help              Print this message and exit 0.

Examples:
  scoutling "Where is resolvePath defined?" --model qwen/qwen3-coder-next
  scoutling "What does this repo do?" --path ../other-repo --model qwen/qwen3-next-80b --verbose`

export interface ParsedArgs {
  help: boolean
  verbose: boolean
  question?: string
  model?: string
  path?: string
  baseUrl?: string
  apiKey?: string
  maxSteps?: number
}

const FLAGS_WITH_VALUE = {
  '--model': 'model',
  '--path': 'path',
  '--base-url': 'baseUrl',
  '--api-key': 'apiKey',
} as const

/** Flags parsed via this table get a genuine number, not a string forced through the string-keyed table above. */
const NUMERIC_FLAGS = { '--max-steps': 'maxSteps' } as const

const BOOLEAN_FLAGS = {
  '--verbose': 'verbose',
  '--help': 'help',
} as const

/**
 * Pure argument parsing — no I/O, no config, no filesystem — so it is
 * exhaustively unit-testable. Fails loud on anything it does not recognize
 * (AXI principle: an unknown flag is an error, never silently ignored).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { help: false, verbose: false }
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token in BOOLEAN_FLAGS) {
      args[BOOLEAN_FLAGS[token as keyof typeof BOOLEAN_FLAGS]] = true
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
  }

  const { config, warnings } = loadConfig({
    scopeRoot,
    env: io.env ?? process.env,
    flags: flagOverrides,
  })

  for (const warning of warnings) writeStderr(`warning: ${warning}\n`)

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

  try {
    const result = await runScoutling({
      question: args.question as string,
      scopeRoot,
      model,
      temperature: config.temperature,
      systemPrompt,
      excludeGlobs: config.excludeGlobs,
      ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      ...(args.verbose ? { onStep: (step: StepSummary) => writeStderr(`${formatStepLog(step)}\n`) } : {}),
    })

    writeStdout(`${result.answer}\n`)
    return result.exhausted ? 1 : 0
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
