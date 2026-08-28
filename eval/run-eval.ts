#!/usr/bin/env -S npx tsx
/**
 * The Phase 5 eval harness (DESIGN.md §12): runs `questions × models × runs`
 * in-process against any OpenAI-compatible base URL, strictly sequential per
 * model (one GPU on the reference machine — never concurrent), and writes one
 * result file per model plus a markdown summary.
 *
 * This directory is deliberately NOT under `src/`: it is not shipped
 * (`package.json`'s `files` stays `dist`/`README.md`/`LICENSE`) and is not a
 * `tsdown` entry point. `docs/eval.md` explains what it answers, what it
 * doesn't, and how to grade the output.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isBudgetPreset, resolveBudget } from '../src/budget.js'
import { isDirectEntry } from '../src/cli.js'
import { classifyRunError } from '../src/classify-run-error.js'
import type { Source } from '../src/citations.js'
import { loadConfig } from '../src/config.js'
import { ScoutlingError } from '../src/errors.js'
import { resolvePath, resolveScopeRoot } from '../src/guardrails.js'
import { runScoutling, type RunResult } from '../src/loop.js'
import { buildRunInputs } from '../src/run-setup.js'
import type { BudgetPreset, ScoutlingConfig } from '../src/types.js'

// --- question-set file schema (DESIGN.md §12 / frozen contract Part B1) -----------------------

/**
 * One JSON file's worth of eval questions. Two example questions
 * (`eval/questions.example.json`) double as this schema's documentation: one
 * carries `expect` (auto-gradable), one does not (manually graded) — see that
 * file's own `description`.
 */
export interface EvalQuestionFile {
  /** Free text: where these questions came from, for whoever reads the file later. */
  description?: string
  questions: EvalQuestion[]
}

export interface EvalQuestion {
  /** Unique within the file. Kebab-case. Used as the row label in the summary table. */
  id: string
  question: string
  /** Scope root for this question, relative to --repo. Default '.'. */
  path?: string
  /** Budget preset for this question. Overrides --budget, which is only the default for questions that omit it. */
  budget?: BudgetPreset
  /** Present only on an auto-gradable question (DESIGN §12's known-fact audits). */
  expect?: {
    /** Plain-English statement of the fact a correct answer must surface. Shown to the human grader. */
    fact: string
    /** Case-insensitive regexes. The auto verdict is `pass` only when EVERY one matches the answer. */
    mustMatch: string[]
  }
  /** Free-text guidance for the human grader. */
  note?: string
}

const KNOWN_TOP_LEVEL_KEYS = new Set(['description', 'questions'])
const KNOWN_QUESTION_KEYS = new Set(['id', 'question', 'path', 'budget', 'expect', 'note'])
const KNOWN_EXPECT_KEYS = new Set(['fact', 'mustMatch'])

/**
 * Validate a parsed question-set file loudly and specifically (AXI): every
 * rejection names the offending question id (or, for a file-level problem,
 * the file path) and the offending key, never a generic "invalid file".
 */
function validateQuestionFile(raw: unknown, filePath: string): EvalQuestionFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ScoutlingError('BAD_ARGS', `${filePath} must contain a JSON object.`)
  }
  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `${filePath}: unknown top-level key "${key}".`,
        `Valid keys: ${[...KNOWN_TOP_LEVEL_KEYS].join(', ')}`,
      )
    }
  }

  if (obj.description !== undefined && typeof obj.description !== 'string') {
    throw new ScoutlingError('BAD_ARGS', `${filePath}: "description" must be a string.`)
  }

  if (!Array.isArray(obj.questions)) {
    throw new ScoutlingError('BAD_ARGS', `${filePath}: "questions" must be an array.`)
  }

  const seenIds = new Set<string>()
  const questions = obj.questions.map((entry, index) => validateQuestion(entry, index, filePath, seenIds))

  return {
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    questions,
  }
}

function validateQuestion(
  raw: unknown,
  index: number,
  filePath: string,
  seenIds: Set<string>,
): EvalQuestion {
  const positionLabel = `${filePath} questions[${index}]`

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ScoutlingError('BAD_ARGS', `${positionLabel}: must be an object.`)
  }
  const obj = raw as Record<string, unknown>
  // Every error from here names the question id when one is available, since
  // that (not the array index) is what a human editing the file will look for.
  const idForMessages = typeof obj.id === 'string' ? obj.id : positionLabel

  for (const key of Object.keys(obj)) {
    if (!KNOWN_QUESTION_KEYS.has(key)) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `${filePath}: question "${idForMessages}" has an unknown key "${key}".`,
        `Valid keys: ${[...KNOWN_QUESTION_KEYS].join(', ')}`,
      )
    }
  }

  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    throw new ScoutlingError('BAD_ARGS', `${positionLabel}: missing or invalid "id".`)
  }
  const id = obj.id
  if (seenIds.has(id)) {
    throw new ScoutlingError('BAD_ARGS', `${filePath}: duplicate question id "${id}".`)
  }
  seenIds.add(id)

  if (typeof obj.question !== 'string' || obj.question.length === 0) {
    throw new ScoutlingError('BAD_ARGS', `${filePath}: question "${id}" is missing "question".`)
  }

  if (obj.path !== undefined && typeof obj.path !== 'string') {
    throw new ScoutlingError('BAD_ARGS', `${filePath}: question "${id}" has an invalid "path" (must be a string).`)
  }

  if (obj.budget !== undefined && !isBudgetPreset(obj.budget)) {
    throw new ScoutlingError(
      'BAD_ARGS',
      `${filePath}: question "${id}" has an invalid "budget": ${String(obj.budget)}.`,
      'Valid presets: quick, normal, deep.',
    )
  }

  let expect: EvalQuestion['expect']
  if (obj.expect !== undefined) {
    if (typeof obj.expect !== 'object' || obj.expect === null || Array.isArray(obj.expect)) {
      throw new ScoutlingError('BAD_ARGS', `${filePath}: question "${id}" has an invalid "expect" (must be an object).`)
    }
    const expectObj = obj.expect as Record<string, unknown>
    for (const key of Object.keys(expectObj)) {
      if (!KNOWN_EXPECT_KEYS.has(key)) {
        throw new ScoutlingError(
          'BAD_ARGS',
          `${filePath}: question "${id}" expect has an unknown key "${key}".`,
          `Valid keys: ${[...KNOWN_EXPECT_KEYS].join(', ')}`,
        )
      }
    }
    if (typeof expectObj.fact !== 'string' || expectObj.fact.length === 0) {
      throw new ScoutlingError('BAD_ARGS', `${filePath}: question "${id}" expect is missing "fact".`)
    }
    if (!Array.isArray(expectObj.mustMatch) || expectObj.mustMatch.some((entry) => typeof entry !== 'string')) {
      throw new ScoutlingError('BAD_ARGS', `${filePath}: question "${id}" expect.mustMatch must be an array of strings.`)
    }
    for (const pattern of expectObj.mustMatch as string[]) {
      try {
        // eslint-disable-next-line no-new -- compiled only to prove the pattern is valid
        new RegExp(pattern, 'i')
      } catch (cause) {
        throw new ScoutlingError(
          'BAD_ARGS',
          `${filePath}: question "${id}" has an uncompilable expect.mustMatch regex "${pattern}": ${(cause as Error).message}.`,
        )
      }
    }
    expect = { fact: expectObj.fact, mustMatch: expectObj.mustMatch as string[] }
  }

  if (obj.note !== undefined && typeof obj.note !== 'string') {
    throw new ScoutlingError('BAD_ARGS', `${filePath}: question "${id}" has an invalid "note" (must be a string).`)
  }

  return {
    id,
    question: obj.question,
    ...(obj.path !== undefined ? { path: obj.path as string } : {}),
    ...(obj.budget !== undefined ? { budget: obj.budget as BudgetPreset } : {}),
    ...(expect !== undefined ? { expect } : {}),
    ...(obj.note !== undefined ? { note: obj.note as string } : {}),
  }
}

// --- run records / output files (Part B4) -----------------------------------------------------

export interface EvalRunRecord {
  questionId: string
  question: string
  budget: BudgetPreset
  /** 0-based. */
  runIndex: number
  temperature: number
  ok: boolean
  error?: { code: string; message: string }
  answer: string
  /** From `RunResult.citations.sources`, verbatim. */
  sources: Source[]
  verifiedSources: number
  unverifiedSources: number
  stepsUsed: number
  toolCalls: { read_file: number; list_dir: number; grep: number }
  toolCallErrors: number
  exhausted: boolean
  wallMs: number
  toolOutputBytes: number
  usage: { inputTokens: number | undefined; outputTokens: number | undefined }
  /** 'pass' | 'fail' when the question has `expect`; null when it is graded manually. */
  autoGrade: 'pass' | 'fail' | null
}

interface EvalModelResultFile {
  schemaVersion: 1
  startedAt: string
  model: string
  baseUrl: string
  repo: string
  questionsFile: string
  defaultBudget: BudgetPreset
  temperatures: number[]
  runs: EvalRunRecord[]
}

/**
 * `null` when the question has no `expect` — DESIGN §12/B1: the auto verdict
 * is `pass` only when *every* `mustMatch` regex matches the answer text,
 * case-insensitively (a small local model's casing is not the fact under
 * test).
 */
function autoGrade(question: EvalQuestion, answer: string): 'pass' | 'fail' | null {
  if (question.expect === undefined) return null
  return question.expect.mustMatch.every((pattern) => new RegExp(pattern, 'i').test(answer)) ? 'pass' : 'fail'
}

function buildOkRecord(
  question: EvalQuestion,
  budget: BudgetPreset,
  runIndex: number,
  temperature: number,
  result: RunResult,
): EvalRunRecord {
  return {
    questionId: question.id,
    question: question.question,
    budget,
    runIndex,
    temperature,
    ok: true,
    answer: result.answer,
    sources: result.citations.sources,
    verifiedSources: result.citations.verifiedCount,
    unverifiedSources: result.citations.unverifiedCount,
    stepsUsed: result.stepsUsed,
    toolCalls: result.toolCalls,
    toolCallErrors: result.toolCallErrors,
    exhausted: result.exhausted,
    wallMs: result.wallMs,
    toolOutputBytes: result.toolOutputBytes,
    usage: result.usage,
    autoGrade: autoGrade(question, result.answer),
  }
}

/**
 * A run that threw is *recorded*, not a crash (DESIGN §12/B3): a model that
 * cannot tool-call at all is exactly the kind of result this eval exists to
 * capture. Every numeric field is 0 and `answer`/`sources` are empty, per the
 * frozen "on a failed run" contract.
 */
function buildFailedRecord(
  question: EvalQuestion,
  budget: BudgetPreset,
  runIndex: number,
  temperature: number,
  error: unknown,
): EvalRunRecord {
  const scoutlingError =
    error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', error instanceof Error ? error.message : String(error))
  return {
    questionId: question.id,
    question: question.question,
    budget,
    runIndex,
    temperature,
    ok: false,
    error: { code: scoutlingError.code, message: scoutlingError.message },
    answer: '',
    sources: [],
    verifiedSources: 0,
    unverifiedSources: 0,
    stepsUsed: 0,
    toolCalls: { read_file: 0, list_dir: 0, grep: 0 },
    toolCallErrors: 0,
    exhausted: false,
    wallMs: 0,
    toolOutputBytes: 0,
    usage: { inputTokens: undefined, outputTokens: undefined },
    autoGrade: null,
  }
}

// --- flags (Part B2) ---------------------------------------------------------------------------

interface EvalArgs {
  help: boolean
  dryRun: boolean
  questions?: string
  repo?: string
  models?: string
  baseUrl?: string
  apiKey?: string
  budget?: string
  temperatures?: string
  runs?: number
  outDir?: string
}

const FLAGS_WITH_VALUE = {
  '--questions': 'questions',
  '--repo': 'repo',
  '--models': 'models',
  '--base-url': 'baseUrl',
  '--api-key': 'apiKey',
  '--budget': 'budget',
  '--temperatures': 'temperatures',
  '--out-dir': 'outDir',
} as const

const BOOLEAN_FLAGS = {
  '--dry-run': 'dryRun',
  '--help': 'help',
} as const

const ALL_FLAG_NAMES = [...Object.keys(FLAGS_WITH_VALUE), '--runs', ...Object.keys(BOOLEAN_FLAGS)]

/** Pure argument parsing (no I/O), same shape as `src/cli.ts`'s `parseArgs`: fails loud on anything unrecognized. */
function parseEvalArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { help: false, dryRun: false }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token in BOOLEAN_FLAGS) {
      args[BOOLEAN_FLAGS[token as keyof typeof BOOLEAN_FLAGS]] = true
      continue
    }

    if (token === '--runs') {
      const raw = argv[i + 1]
      if (raw === undefined || raw.startsWith('--')) {
        throw new ScoutlingError('BAD_ARGS', '--runs requires a value.', 'Usage: --runs <n>')
      }
      const value = Number(raw)
      if (!Number.isInteger(value) || value < 1) {
        throw new ScoutlingError('BAD_ARGS', `--runs must be a positive integer, got: ${raw}`, 'Usage: --runs <n>, e.g. --runs 3')
      }
      args.runs = value
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
      throw new ScoutlingError('BAD_ARGS', `Unknown flag: ${token}`, `Valid flags: ${ALL_FLAG_NAMES.join(', ')}`)
    }

    throw new ScoutlingError(
      'BAD_ARGS',
      `Unexpected argument: ${token}`,
      'eval/run-eval.ts takes no positional arguments — everything is a flag. See --help.',
    )
  }

  return args
}

function parseTemperatures(raw: string): number[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    throw new ScoutlingError('BAD_ARGS', '--temperatures must list at least one value.', 'Usage: --temperatures 0,0,0.5')
  }
  return parts.map((part) => {
    const value = Number(part)
    if (!Number.isFinite(value)) {
      throw new ScoutlingError('BAD_ARGS', `--temperatures contains a non-numeric value: "${part}".`)
    }
    return value
  })
}

const DEFAULT_TEMPERATURES_RAW = '0,0,0.5'
const DEFAULT_QUESTIONS_FILE = 'eval/questions.example.json'
const DEFAULT_OUT_DIR = 'eval/results'

const USAGE = `pnpm eval [options]

Runs eval/run-eval.ts's questions × models × runs matrix in-process against any OpenAI-compatible
base URL, strictly sequential per model (one GPU — DESIGN.md §12), and writes one result JSON per
model plus a markdown summary (also printed to stdout). See docs/eval.md for how to grade it.

  --questions <file>     Question-set JSON. Default: ${DEFAULT_QUESTIONS_FILE} (relative to cwd).
  --repo <dir>           Repository the questions are about; the default scope root. Default: cwd.
  --models <a,b,c>       Comma-separated model ids. REQUIRED — there is no default model (ADR 0003).
  --base-url <url>       OpenAI-compatible endpoint.
  --api-key <key>
  --budget <preset>      Default budget for questions that do not name their own. Default: normal.
  --temperatures <list>  Comma-separated temperature schedule, one entry per run. Default: ${DEFAULT_TEMPERATURES_RAW}.
  --runs <n>             Runs per cell. Default: the length of --temperatures. If larger, the schedule cycles.
  --out-dir <dir>        Where result files are written. Default: ${DEFAULT_OUT_DIR} (relative to cwd).
  --dry-run              Print the plan (cells, order, total run count) and exit without calling a model.
  --help                 Print this message and exit 0.

Exit codes: 0 every run completed · 1 the eval finished but at least one run errored (results
still written) · 2 BAD_ARGS · 3 PROVIDER_UNREACHABLE (aborted) · 10 INTERNAL.

Examples:
  pnpm eval --models qwen/qwen3-coder-next,qwen/qwen3-next-80b
  pnpm eval --models qwen/qwen3-coder-next --dry-run
  pnpm eval --questions ../local-ai/docs/scoutling-eval.json --repo ../local-ai --models qwen/qwen3-coder-next`

// --- timestamp / filenames (Part B4) --------------------------------------------------------

/** `YYYY-MM-DDTHH-mm-ssZ` — no colons, so the filename is valid on Windows too. */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

/** Lowercase, every char outside `[a-z0-9._-]` replaced with `-` — so a model id containing `/` is a valid filename component. */
function slugifyModel(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

// --- I/O interface (Part B6) -------------------------------------------------------------------

/** What `EvalRunInput.budget` names by preset; `defaultRunQuestion` resolves it to a full `Budget` right before calling `runScoutling`, mirroring the frozen call shape in DESIGN's Part B3. */
export interface EvalRunInput {
  question: EvalQuestion
  scopeRoot: string
  config: ScoutlingConfig
  temperature: number
  budget: BudgetPreset
}

export interface EvalIo {
  argv: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  writeStdout?: (text: string) => void
  writeStderr?: (text: string) => void
  /** Injected so tests never touch disk. Default: writeFileSync + mkdirSync from node:fs. */
  writeResultFile?: (path: string, content: string) => void
  /** Injected so tests never need a provider. Default: the real buildRunInputs + runScoutling wiring. */
  runQuestion?: (input: EvalRunInput) => Promise<RunResult>
  /** Injected so result filenames are deterministic in tests. Default: () => new Date(). */
  now?: () => Date
  /**
   * NOT part of the frozen `EvalIo` shape in the task brief — added because
   * without it, "run the real default wiring with a mocked model" (Part C's
   * required no-`runQuestion` test) is impossible to do hermetically: the
   * default path's model construction goes through `buildRunInputs` →
   * `createProvider`, which needs a `fetch` to reach at all. `src/cli.ts`'s
   * own `CliIO` has exactly this field for the identical reason. See the
   * deviations note in the Phase 5 report.
   */
  fetch?: typeof fetch
}

/**
 * The real default `runQuestion`: builds a model + system prompt from
 * resolved config (Part A2's `buildRunInputs`), then runs it. Mirrors the
 * frozen call in Part B3 exactly.
 *
 * Errors are reclassified with the same `classifyRunError` `cli.ts` uses
 * before they reach `runEval`'s per-run try/catch — without this, a
 * genuinely unreachable provider surfaces as a bare fetch failure, which is
 * not a `ScoutlingError` at all, let alone one with code
 * `PROVIDER_UNREACHABLE`. The frozen "aborts the whole eval" behaviour (Part
 * B3) would then only ever fire for a test that injects the error directly —
 * never for a real dead endpoint, which is the actual case it exists for.
 */
function createDefaultRunQuestion(fetchImpl: typeof fetch | undefined): (input: EvalRunInput) => Promise<RunResult> {
  return async (input) => {
    const { model, systemPrompt } = buildRunInputs({
      scopeRoot: input.scopeRoot,
      config: input.config,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
    try {
      return await runScoutling({
        question: input.question.question,
        scopeRoot: input.scopeRoot,
        model,
        systemPrompt,
        excludeGlobs: input.config.excludeGlobs,
        temperature: input.temperature,
        budget: resolveBudget(input.budget),
      })
    } catch (error) {
      throw classifyRunError(error, input.config.baseUrl)
    }
  }
}

function defaultWriteResultFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// --- dry-run plan --------------------------------------------------------------------------

function buildDryRunPlan(
  models: string[],
  questions: EvalQuestion[],
  temperatures: number[],
  runsPerCell: number,
  defaultBudget: BudgetPreset,
): string {
  const lines: string[] = ['model | question | run | temperature | budget', '---']
  let totalRuns = 0

  for (const model of models) {
    for (const question of questions) {
      const budget = question.budget ?? defaultBudget
      for (let runIndex = 0; runIndex < runsPerCell; runIndex++) {
        const temperature = temperatures[runIndex % temperatures.length] as number
        lines.push(`${model} | ${question.id} | ${runIndex} | ${temperature} | ${budget}`)
        totalRuns += 1
      }
    }
  }

  lines.push('---')
  lines.push(`${totalRuns} total run(s): ${models.length} model(s) x ${questions.length} question(s) x up to ${runsPerCell} run(s) each.`)
  return `${lines.join('\n')}\n`
}

// --- summary markdown (Part B4) -----------------------------------------------------------

function formatToolCalls(toolCalls: EvalRunRecord['toolCalls']): string {
  return `r${toolCalls.read_file}/l${toolCalls.list_dir}/g${toolCalls.grep}`
}

function mean(values: number[]): string {
  if (values.length === 0) return 'n/a'
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)
}

function buildRunRow(model: string, record: EvalRunRecord): string {
  if (!record.ok) {
    const code = record.error?.code ?? 'ERROR'
    // Failed runs show their error code in place of the numbers (Part B4) —
    // every numeric column becomes the same code, so the row stays the same
    // width as a successful one and the failure is impossible to miss.
    return `| ${record.questionId} | ${model} | ${record.runIndex} | ${record.temperature} | ${code} | ${code} | ${code} | ${code} | ${code} | ${code} | ${code} | ${code} | ${code} | ${record.autoGrade ?? ''} | |`
  }
  return (
    `| ${record.questionId} | ${model} | ${record.runIndex} | ${record.temperature} | ${record.stepsUsed} | ` +
    `${formatToolCalls(record.toolCalls)} | ${record.toolCallErrors} | ${record.toolOutputBytes} | ` +
    `${record.usage.inputTokens ?? ''} | ${record.usage.outputTokens ?? ''} | ${record.wallMs} | ` +
    `${record.exhausted} | ${record.verifiedSources} | ${record.autoGrade ?? ''} | |`
  )
}

function buildModelSummaryRow(result: EvalModelResultFile): string {
  const ok = result.runs.filter((run) => run.ok)
  const errors = result.runs.length - ok.length
  const autoGraded = result.runs.filter((run) => run.autoGrade !== null)
  const autoPassed = autoGraded.filter((run) => run.autoGrade === 'pass')
  const exhaustedCount = ok.filter((run) => run.exhausted).length

  return (
    `| ${result.model} | ${result.runs.length} | ${errors} | ${autoPassed.length}/${autoGraded.length} | ` +
    `${mean(ok.map((run) => run.stepsUsed))} | ${mean(ok.map((run) => run.toolOutputBytes))} | ` +
    `${mean(ok.map((run) => run.wallMs))} | ${exhaustedCount} |`
  )
}

function buildSummaryMarkdown(
  stamp: string,
  questionFile: EvalQuestionFile,
  modelResults: EvalModelResultFile[],
): string {
  const lines: string[] = [`# 🐦 scoutling eval — ${stamp}`, '']

  lines.push('## Per-run results', '')
  lines.push(
    '| question | model | run | temp | steps | tools | tool errs | bytes | in tok | out tok | wallMs | exhausted | verified | auto | correct? |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const result of modelResults) {
    for (const run of result.runs) {
      lines.push(buildRunRow(result.model, run))
    }
  }

  lines.push('', '## Per-model summary', '')
  lines.push('| model | runs | errors | auto pass/total | mean steps | mean bytes | mean wallMs | exhausted |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const result of modelResults) {
    lines.push(buildModelSummaryRow(result))
  }

  lines.push(
    '',
    '## How to grade',
    '',
    'See docs/eval.md. The `auto` column is a regex proxy over the answer text, not a verdict —',
    'a `pass` there is evidence worth checking, not a correct answer. Fill in `correct?` yourself',
    'for every row, including the auto-graded ones.',
    '',
  )

  const autoGradedQuestions = questionFile.questions.filter((question) => question.expect !== undefined)
  if (autoGradedQuestions.length > 0) {
    lines.push('Auto-graded questions (what `mustMatch` is checking):', '')
    for (const question of autoGradedQuestions) {
      lines.push(`- ${question.id}: ${question.expect?.fact}`)
    }
    lines.push('')
  }

  const manualQuestions = questionFile.questions.filter((question) => question.expect === undefined && question.note)
  if (manualQuestions.length > 0) {
    lines.push('Manual questions:', '')
    for (const question of manualQuestions) {
      lines.push(`- ${question.id}: ${question.note}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

// --- execution (Part B3) ------------------------------------------------------------------

/**
 * Run the eval end to end and return the process exit code — never calls
 * `process.exit`, mirroring `src/cli.ts`'s `runCli`.
 */
export async function runEval(io: EvalIo): Promise<number> {
  const writeStdout = io.writeStdout ?? ((text: string) => process.stdout.write(text))
  const writeStderr = io.writeStderr ?? ((text: string) => process.stderr.write(text))
  const writeResultFile = io.writeResultFile ?? defaultWriteResultFile
  const now = io.now ?? (() => new Date())
  const cwd = io.cwd ?? process.cwd()
  const env = io.env ?? process.env

  function emitError(error: ScoutlingError): number {
    writeStderr(`${JSON.stringify(error.toJSON())}\n`)
    return error.exitCode
  }

  let args: EvalArgs
  try {
    args = parseEvalArgs(io.argv)
  } catch (error) {
    return emitError(error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error)))
  }

  if (args.help) {
    writeStdout(`${USAGE}\n`)
    return 0
  }

  if (args.models === undefined || args.models.trim().length === 0) {
    return emitError(
      new ScoutlingError(
        'BAD_ARGS',
        'A model id is required — there is no default model (ADR 0003).',
        'Pass --models <a,b,c>.',
      ),
    )
  }
  const models = args.models
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (models.length === 0) {
    return emitError(
      new ScoutlingError(
        'BAD_ARGS',
        'A model id is required — there is no default model (ADR 0003).',
        'Pass --models <a,b,c>.',
      ),
    )
  }

  let temperatures: number[]
  let defaultBudget: BudgetPreset
  let repoRoot: string
  let questionsPath: string
  let questionFile: EvalQuestionFile
  try {
    temperatures = parseTemperatures(args.temperatures ?? DEFAULT_TEMPERATURES_RAW)

    const budgetCandidate = args.budget ?? 'normal'
    if (!isBudgetPreset(budgetCandidate)) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `--budget must be one of quick, normal, deep; got: ${budgetCandidate}`,
        'Valid presets: quick, normal, deep.',
      )
    }
    defaultBudget = budgetCandidate

    repoRoot = resolveScopeRoot(resolve(cwd, args.repo ?? '.'))

    questionsPath = isAbsolute(args.questions ?? '')
      ? (args.questions as string)
      : join(cwd, args.questions ?? DEFAULT_QUESTIONS_FILE)
    let rawQuestionFile: unknown
    try {
      rawQuestionFile = JSON.parse(readFileSync(questionsPath, 'utf8'))
    } catch (cause) {
      throw new ScoutlingError(
        'BAD_ARGS',
        `Could not read/parse ${questionsPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        'Pass --questions <file> pointing at a valid question-set JSON file.',
      )
    }
    questionFile = validateQuestionFile(rawQuestionFile, questionsPath)
  } catch (error) {
    return emitError(error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error)))
  }

  const runsPerCell = args.runs ?? temperatures.length
  const outDir = resolve(cwd, args.outDir ?? DEFAULT_OUT_DIR)

  if (args.dryRun) {
    writeStdout(buildDryRunPlan(models, questionFile.questions, temperatures, runsPerCell, defaultBudget))
    return 0
  }

  const runQuestion = io.runQuestion ?? createDefaultRunQuestion(io.fetch)

  const startedAt = now()
  const stamp = formatTimestamp(startedAt)

  const modelResults: EvalModelResultFile[] = []
  let anyError = false

  for (const model of models) {
    let config: ScoutlingConfig
    try {
      // Deliberately loaded from --repo, not from a question's `path`
      // subdirectory: every cell in one eval run has to be comparable, and
      // reloading config per-question could silently change baseUrl/budget
      // mid-run if a subdirectory carried its own scoutling.config.json.
      // This is a deliberate difference from the CLI, where --path is both
      // the scope root and the config lookup directory.
      const loaded = loadConfig({
        scopeRoot: repoRoot,
        env,
        flags: {
          model,
          ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
          ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
        },
      })
      config = loaded.config
    } catch (error) {
      return emitError(error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error)))
    }

    const runs: EvalRunRecord[] = []
    const modelResult: EvalModelResultFile = {
      schemaVersion: 1,
      startedAt: startedAt.toISOString(),
      model,
      baseUrl: config.baseUrl,
      repo: repoRoot,
      questionsFile: questionsPath,
      defaultBudget,
      temperatures,
      runs,
    }

    for (const question of questionFile.questions) {
      let scopeRoot: string
      try {
        // Every question-file-supplied path goes through `resolvePath`,
        // exactly like a config-supplied one (CLAUDE.md) — a question set is
        // as untrusted as a committed config file.
        scopeRoot = resolveScopeRoot(resolvePath(repoRoot, question.path ?? '.'))
      } catch (error) {
        return emitError(error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error)))
      }

      const budget = question.budget ?? defaultBudget

      for (let runIndex = 0; runIndex < runsPerCell; runIndex++) {
        const temperature = temperatures[runIndex % temperatures.length] as number

        writeStderr(`start  model=${model} question=${question.id} run=${runIndex} temp=${temperature}\n`)

        try {
          const result = await runQuestion({ question, scopeRoot, config, temperature, budget })
          runs.push(buildOkRecord(question, budget, runIndex, temperature, result))
          writeStderr(
            `finish model=${model} question=${question.id} run=${runIndex} ` +
              `steps=${result.stepsUsed} bytes=${result.toolOutputBytes} wallMs=${result.wallMs} exhausted=${result.exhausted}\n`,
          )
        } catch (error) {
          if (error instanceof ScoutlingError && error.code === 'PROVIDER_UNREACHABLE') {
            // The one exception to "a failed run is recorded, not a crash"
            // (DESIGN §12/B3): nothing else in the eval can succeed either,
            // so abort immediately rather than burn through every remaining
            // cell failing the same way. Write what this model has already
            // collected before exiting, on top of every earlier model's file
            // (already written at the end of its own loop, below).
            writeStderr(`abort  model=${model} question=${question.id} run=${runIndex}: ${error.message}\n`)
            modelResults.push(modelResult)
            writeResultFile(join(outDir, `${stamp}-${slugifyModel(model)}.json`), `${JSON.stringify(modelResult, null, 2)}\n`)
            return emitError(error)
          }

          anyError = true
          runs.push(buildFailedRecord(question, budget, runIndex, temperature, error))
          const scoutlingError = error instanceof ScoutlingError ? error : new ScoutlingError('INTERNAL', String(error))
          writeStderr(`finish model=${model} question=${question.id} run=${runIndex} error=${scoutlingError.code}\n`)
        }
      }
    }

    modelResults.push(modelResult)
    writeResultFile(join(outDir, `${stamp}-${slugifyModel(model)}.json`), `${JSON.stringify(modelResult, null, 2)}\n`)
  }

  const summary = buildSummaryMarkdown(stamp, questionFile, modelResults)
  writeResultFile(join(outDir, `${stamp}-summary.md`), summary)
  writeStdout(summary)

  return anyError ? 1 : 0
}

if (isDirectEntry(import.meta.url, process.argv[1])) {
  runEval({ argv: process.argv.slice(2) })
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ error: 'INTERNAL', message: String(error) }))
      process.exitCode = 10
    })
}
