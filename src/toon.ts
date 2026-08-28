import { encode } from '@toon-format/toon'

/**
 * Recursively drop keys whose value is `undefined`.
 *
 * Verified empirically against the installed @toon-format/toon 4.1.1:
 * `encode` does NOT drop an `undefined`-valued property the way
 * `JSON.stringify` does — it renders `key: null` (and round-trips to
 * `null`), which tells the model the field exists and is null, not that
 * it's absent. `list-dir.ts` / `grep.ts` already avoid ever *setting* an
 * optional field (`note`, `hint`) to `undefined` — they omit the key
 * entirely when there's nothing to say — but this strips the difference
 * away regardless, so a future caller that does set `note: undefined`
 * can't leak a spurious `note: null` into the model's context.
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined)
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue === undefined) continue
      result[key] = stripUndefined(entryValue)
    }
    return result
  }
  return value
}

/** TOON-encode an arbitrary value for model consumption, dropping `undefined`-valued keys first (see `stripUndefined`). */
export function encodeToon(value: unknown): string {
  return encode(stripUndefined(value))
}

/**
 * Render a tool's structured result as the AI SDK's `ToolResultOutput` text
 * shape, TOON-encoded.
 *
 * `encode` can throw on input it structurally can't represent (verified
 * empirically: a string containing an unpaired UTF-16 surrogate throws a
 * `TypeError`; a circular object also throws, though `JSON.stringify` would
 * throw on that one too). Falling back to `JSON.stringify` on any throw is
 * not a silent degradation the way a weaker search engine would be — JSON
 * is self-evident to the reader on the other end, so there's nothing to
 * flag. A presentation layer must never fail a tool call over a rendering
 * choice, which is also why the fallback is itself guarded: the one input
 * known to defeat `encode` *and* `JSON.stringify` is a circular object, and
 * a rendering failure there would otherwise propagate out of `execute` as a
 * thrown error — the exact lossy shape CLAUDE.md's tool-refusal convention
 * exists to avoid.
 */
export function toonModelOutput(value: unknown): { type: 'text'; value: string } {
  try {
    return { type: 'text', value: encodeToon(value) }
  } catch {
    try {
      return { type: 'text', value: JSON.stringify(value) ?? String(value) }
    } catch {
      return { type: 'text', value: String(value) }
    }
  }
}
