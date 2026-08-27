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
// The question names the file on purpose. Phase 2 ships read_file and nothing
// else — no list_dir, no grep — so the model has no way to *find* a file, and
// an open "where is X handled?" question is unanswerable by construction until
// Phase 3. What this smoke proves is DESIGN.md §13's actual Phase 2 goal:
// connectivity and tool-calling end to end against a real provider.
const QUESTION =
  'Read src/guardrails.ts and explain what resolvePath does when it is given a path that ' +
  'resolves outside the scope root. Cite path:line.'

// Cold JIT model load in LM Studio can take 60s+ (DESIGN.md §7); give it
// real headroom but never hang forever if nothing is listening at all.
const SMOKE_TIMEOUT_MS = 120_000

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
