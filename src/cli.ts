#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isBudgetPreset, resolveBudget } from './budget.js'
import { classifyRunError } from './classify-run-error.js'
import { runDoctorCommand, runModelsCommand } from './commands.js'
import { loadConfig } from './config.js'
import { ScoutlingError } from './errors.js'
import { resolveScopeRoot } from './guardrails.js'
import { runScoutling, type RunResult, type StepSummary } from './loop.js'
import { formatAnswerJson, formatAnswerText, isOutputFormat, type OutputFormat } from './output.js'
import { listModels } from './provider.js'
import { buildRunInputs, type RunInputs } from './run-setup.js'
import type { ScoutlingConfig } from './types.js'

const USAGE = `🐦 scoutling — read-only, bounded codebase investigation with list_dir, grep and read_file.

scoutling "<question>" --model <id> [--path <dir>] [--base-url <url>] [--api-key <key>]
          [--budget quick|normal|deep] [--max-steps <n>] [--max-tool-bytes <n>] [--timeout-ms <n>]
          [--format text|json] [--require-citations] [--verbose]
scoutling -                    Read the question from stdin instead of an argument (long
                                prompts from a parent agent). Empty/whitespace-only stdin is
                                an error.
scoutling models [--format text|json] [--base-url <url>] [--api-key <key>] [--path <dir>]
                                GET <base-url>/models — what can I pass to --model? Does not
                                require --model. See 'scoutling models --help'.
scoutling doctor [--format text|json] [--base-url <url>] [--api-key <key>] [--path <dir>]
                                Resolved config + which layer set each key, plus reachability,
                                model-presence, ripgrep-binary and context-length checks. Does
                                not require --model; a nonzero exit means it found problems. See
                                'scoutling doctor --help'.
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

Note: "scoutling models" and "scoutling doctor" are recognised as subcommands only when the
entire, single-word question is exactly "models" or "doctor" — an accepted casualty; quote a
longer question to avoid the collision.

Examples:
  scoutling "Where is resolvePath defined?" --model qwen/qwen3-coder-next
  scoutling "What does this repo do?" --path ../other-repo --model qwen/qwen3-next-80b --verbose
  scoutling "Survey the auth module" --model qwen/qwen3-next-80b --budget deep
  scoutling "Where is X validated?" --model qwen/qwen3-coder-next --format json --require-citations
  echo "A long question from a parent agent..." | scoutling -
  scoutling models
  scoutling doctor`

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

/** `steps, bytes` / `timeout` / etc. — a human-readable list of which cap(s) fired, for the BUDGET_EXHAUSTED warning's `message`. */
function namedExhaustedCaps(exhaustedBy: RunResult['exhaustedBy']): string {
  return exhaustedBy.join(', ')
}

/**
 * The BUDGET_EXHAUSTED warning's `hint`, tailored to which cap(s) actually
 * fired: `--max-tool-bytes` only helps when bytes ran out, `--max-steps`
 * only when steps did, `--timeout-ms` only for a timeout. When more than one
 * fired, all the relevant flags are named in one sentence.
 */
function exhaustedCapsHint(exhaustedBy: RunResult['exhaustedBy']): string {
  const flags: string[] = []
  if (exhaustedBy.includes('bytes')) flags.push('--max-tool-bytes')
  if (exhaustedBy.includes('steps')) flags.push('--max-steps')
  if (exhaustedBy.includes('timeout')) flags.push('--timeout-ms')

  if (flags.length === 0) return 'Narrow --path or ask a more specific question.'
  return `Try raising ${flags.join(' and/or ')}, narrow --path, or ask a more specific question.`
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
  /**
   * Reads the question for `scoutling -` (DESIGN.md §9: long prompts from a
   * parent agent). Kept just as injectable as `fetch`/the writers so this
   * stays hermetically testable — `runCli` never reads `process.stdin`
   * directly. The real reader lives in `main()`, not here.
   */
  readStdin?: () => Promise<string>
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

  // Subcommand dispatch happens before parseArgs, and only on the *first*
  // argv token, matching "recognised only when the subcommand is the first
  // positional argument" — parseArgs would otherwise treat a bare "models"
  // or "doctor" as a perfectly valid one-word question. That collision is a
  // documented, accepted casualty (see USAGE): it only bites a question that
  // is exactly that single word. Each subcommand validates its own flags
  // (unknown-flag strictness is per-command, same as the main command's).
  const subcommand = io.argv[0]
  if (subcommand === 'models' || subcommand === 'doctor') {
    const subcommandIo = {
      env: io.env,
      cwd: io.cwd,
      fetch: io.fetch,
      writeStdout,
      writeStderr,
    }
    return subcommand === 'models'
      ? runModelsCommand(io.argv.slice(1), subcommandIo)
      : runDoctorCommand(io.argv.slice(1), subcommandIo)
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

  // "scoutling -": the question comes from stdin instead of argv, e.g. a
  // parent agent piping a long prompt it would rather not risk truncating
  // or mis-escaping as a single shell argument.
  if (args.question === '-') {
    if (io.readStdin === undefined) {
      return emitError(
        new ScoutlingError(
          'INTERNAL',
          'No stdin reader is available to read the question.',
          'This is a scoutling bug; please report it.',
        ),
      )
    }
    let stdinText: string
    try {
      stdinText = await io.readStdin()
    } catch (error) {
      return emitError(
        new ScoutlingError('BAD_ARGS', `Could not read the question from stdin: ${error instanceof Error ? error.message : String(error)}`),
      )
    }
    // Trim trailing whitespace only (a trailing newline from `echo`/a
    // pasted prompt is noise, not part of the question); leading whitespace
    // is left alone as potentially meaningful formatting.
    const trimmed = stdinText.replace(/\s+$/, '')
    if (trimmed.length === 0) {
      return emitError(
        new ScoutlingError(
          'BAD_ARGS',
          'No question was provided on stdin.',
          'Pipe a non-empty question, e.g.: echo "..." | scoutling -',
        ),
      )
    }
    args.question = trimmed
  }

  // resolveScopeRoot resolves a relative path against process.cwd(), not the
  // injected `cwd` — so a relative --path must be made absolute against the
  // effective cwd *here*, before it reaches resolveScopeRoot, or a
  // programmatic caller whose process.cwd() differs from the injected cwd
  // (a test, a script, an embedding agent) gets a scope root resolved
  // against the wrong directory. An absolute --path and the no-path default
  // (already cwd) both pass through unchanged.
  let scopeRoot: string
  try {
    const scopeRootInput = args.path === undefined || isAbsolute(args.path) ? (args.path ?? cwd) : resolve(cwd, args.path)
    scopeRoot = resolveScopeRoot(scopeRootInput)
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

  // Shared with eval/run-eval.ts (Phase 5) — see run-setup.ts's own doc
  // comment for why this must be the one place both build a model + system
  // prompt from resolved config.
  let model: RunInputs['model']
  let systemPrompt: string
  try {
    ;({ model, systemPrompt } = buildRunInputs({
      scopeRoot,
      config,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    }))
  } catch (error) {
    return emitError(error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error)))
  }

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
          message: `The run stopped before the model finished: ${namedExhaustedCaps(result.exhaustedBy)} exhausted.`,
          hint: exhaustedCapsHint(result.exhaustedBy),
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

/** Reads all of `process.stdin` as utf8 — the real implementation behind `scoutling -`, kept out of `runCli` itself. */
async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  const chunks: string[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as string)
  return chunks.join('')
}

async function main(): Promise<void> {
  // Set the code rather than calling process.exit(), which can truncate a
  // still-draining stdout — and stdout is the whole product here.
  process.exitCode = await runCli({ argv: process.argv.slice(2), readStdin: readProcessStdin })
}

if (isDirectEntry(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ error: 'INTERNAL', message: String(error) }))
    process.exitCode = 10
  })
}
