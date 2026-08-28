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

// Purely a backstop for a hang *outside* the run's own accounting — a socket
// that accepts and never answers, say. It is deliberately a little longer
// than the `normal` preset's own 600s wall-clock budget (DESIGN.md §7) so
// that a run which genuinely overruns is reported by the CLI as TIMEOUT
// (exit 4), with its own message and hint, rather than being cut off here
// with neither.
//
// Before the Phase 6 re-sizing this was the other way round: `normal` allowed
// 180s against a question observed to take ~3.5 minutes, so the smoke had to
// pass an explicit `--timeout-ms` and `--budget deep` to stop a healthy
// endpoint from looking broken. Both workarounds existed only because the §7
// numbers were guesses; the smoke now runs on the shipped defaults, which is
// what it should have been testing all along.
const SMOKE_TIMEOUT_MS = 660_000

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
      // No `--budget` and no `--timeout-ms`: the smoke runs on the **shipped
      // defaults**, so what it proves is that the default preset can answer a
      // real question. Through Phase 4 it had to ask for `deep` because this
      // question costs 6 steps and 33 KB against `normal`'s then-8 and 40 KB
      // — close enough that exploring one extra file exhausted the run and it
      // answered nothing, which is exactly what happened on the first Phase 4
      // smoke. Phase 6 re-sized `normal` to 12 steps and 80 KB from measured
      // distributions, so the headroom is now real and the smoke should be
      // exercising what users actually get.
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
