#!/usr/bin/env -S npx tsx
/**
 * Live smoke test — NOT part of `pnpm test` (that must stay hermetic, no
 * network, no live model). Runs the real CLI end to end against a real
 * OpenAI-compatible endpoint, asking a question this repo can independently
 * check the answer to.
 *
 * Usage: pnpm smoke
 * Override the target with SCOUTLING_BASE_URL / SCOUTLING_MODEL, e.g. to
 * point at a different LM Studio instance or model.
 */
import { runCli } from '../src/cli.js'

const BASE_URL = process.env.SCOUTLING_BASE_URL ?? 'http://localhost:1234/v1'
const MODEL = process.env.SCOUTLING_MODEL ?? 'qwen/qwen3-coder-next'
// The question deliberately does NOT name a file. Phase 2's version had to —
// with read_file as the only tool the model had no way to *find* anything, so
// an open "where is X?" was unanswerable by construction. Phase 3 ships
// list_dir and grep, so what this smoke now proves is the discovery path
// itself: the run has to locate the file before it can read it. If a future
// change breaks grep or list_dir, this question stops being answerable and
// the smoke says so, which naming the file would hide.
const QUESTION =
  'Where is the guard that stops a model-chosen grep pattern from being parsed as a ripgrep ' +
  'flag, and what exactly does it do? Cite path:line.'

// Cold JIT model load in LM Studio can take 60s+ (DESIGN.md §7), and since
// Phase 3 a run gets 8 steps rather than 3 and spends the first one or two on
// discovery — observed runs of this exact question land around 3.5 minutes on
// qwen/qwen3-coder-next. 120s was right for Phase 2 and would now fail a
// perfectly healthy run. Still bounded, so nothing hangs when the endpoint is
// simply not listening.
const SMOKE_TIMEOUT_MS = 300_000

async function main(): Promise<number> {
  console.error(`scoutling smoke: ${BASE_URL} model=${MODEL}`)
  console.error(`question: ${QUESTION}`)
  console.error('--- step log (stderr) ---')

  const timeout = new Promise<number>((resolve) => {
    setTimeout(() => {
      console.error(
        `\nsmoke: timed out after ${SMOKE_TIMEOUT_MS}ms. Is LM Studio running at ${BASE_URL} ` +
          `with ${MODEL} loaded? (pnpm dev:server / start LM Studio, then retry.)`,
      )
      resolve(1)
    }, SMOKE_TIMEOUT_MS).unref()
  })

  const run = runCli({
    argv: [QUESTION, '--model', MODEL, '--base-url', BASE_URL, '--path', '.', '--verbose'],
  }).then((exitCode) => {
    if (exitCode === 3) {
      console.error(
        `\nsmoke: provider unreachable at ${BASE_URL}. Is LM Studio running? ` +
          `Start it, or point SCOUTLING_BASE_URL at a running OpenAI-compatible endpoint.`,
      )
    }
    console.error('--- end step log ---')
    return exitCode
  })

  return Promise.race([run, timeout])
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((error: unknown) => {
    console.error('smoke: unexpected error', error)
    process.exit(10)
  })
