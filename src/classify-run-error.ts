import { APICallError, RetryError } from 'ai'

import { ScoutlingError } from './errors.js'

/**
 * Classify what `runScoutling`/`generateText` threw. A connection failure
 * surfaces as `RetryError` wrapping an `APICallError` whose `statusCode` is
 * `undefined` — fetch itself failed, so no HTTP response ever came back. An
 * `APICallError` *with* a `statusCode` is a real response from the provider
 * (e.g. model not found) and is reported as-is, not masked as "unreachable".
 *
 * Extracted out of `cli.ts` (Phase 5) so `eval/run-eval.ts`'s default
 * `runQuestion` wiring classifies a run's error identically: DESIGN.md §12's
 * eval harness treats `PROVIDER_UNREACHABLE` as the one error that aborts the
 * whole run rather than being recorded as a per-question failure, and that
 * only works if the harness can actually recognize the error the same way
 * the CLI does — not just when a test injects one directly.
 */
export function classifyRunError(error: unknown, baseUrl: string): ScoutlingError {
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
