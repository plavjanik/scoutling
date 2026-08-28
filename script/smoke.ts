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

// Passed to the run explicitly, and deliberately equal to the smoke's own
// backstop above. Since Phase 4 the CLI enforces its own wall-clock budget,
// and the `normal` preset's 180s is *less* than the 3.5 minutes this exact
// question has been observed to take — so without this the run would abort
// itself with TIMEOUT (exit 4) before the smoke's outer race ever fired, and
// a perfectly healthy endpoint would look broken. The outer race stays as a
// backstop for a hang that happens outside the run's own accounting.
const RUN_TIMEOUT_MS = SMOKE_TIMEOUT_MS

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

  // `--require-citations` is what makes this smoke check the *product* rather
  // than just "a run completed". The question has always ended in "Cite
  // path:line", but until Phase 4 nothing verified that it did — an answer
  // citing nothing, or citing files that do not exist, exited 0 exactly like
  // a good one. Now zero verified citations is exit 1 and the smoke fails.
  const run = runCli({
    argv: [
      QUESTION,
      '--model',
      MODEL,
      '--base-url',
      BASE_URL,
      '--path',
      '.',
      // `deep`, not the `normal` default, on purpose. This question has been
      // measured at 6 steps and 33 KB of tool output — inside `normal`'s 8
      // and 40 KB, but close enough that a run which explores one extra file
      // exhausts and answers nothing. That happened on the first Phase 4
      // smoke. Whether `normal` is big enough is a real question, but it is
      // a *tuning* question that belongs to the eval (Phase 6) and the
      // dogfood log; letting it decide whether the smoke passes would mean a
      // healthy build failing at random.
      '--budget',
      'deep',
      '--timeout-ms',
      String(RUN_TIMEOUT_MS),
      '--require-citations',
      '--verbose',
    ],
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
