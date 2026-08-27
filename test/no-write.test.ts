import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { generateText, isStepCount } from 'ai'

// Spy (not replace) every fs entry point for the whole module graph this test
// file pulls in — including src/guardrails.ts and src/tools/read-file.ts,
// which both import from 'node:fs' for legitimate reads. `spy: true` keeps
// the real implementation running underneath so reads still work; it only
// gives us a call record to assert against.
vi.mock('node:fs', { spy: true })
vi.mock('node:fs/promises', { spy: true })

import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'

import { runScoutling } from '../src/loop.js'
import { resolveScopeRoot } from '../src/guardrails.js'
import { createTools } from '../src/tools/index.js'

/** Every write entry point ADR 0002 says no src/ file may import, sync and async. */
const SYNC_FS_WRITE_APIS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdir',
  'mkdirSync',
  'unlink',
  'unlinkSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'copyFile',
  'copyFileSync',
  'chmod',
  'chmodSync',
  'createWriteStream',
] as const

/** `node:fs/promises` has no `*Sync` or stream variants. */
const PROMISES_FS_WRITE_APIS = [
  'writeFile',
  'appendFile',
  'mkdir',
  'unlink',
  'rename',
  'rm',
  'copyFile',
  'chmod',
] as const

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  }
}

/** Every `.ts` file under `src/`, recursively. */
function listSrcFiles(srcDir: string): string[] {
  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => resolve(entry.parentPath, entry.name))
}

describe('no file in src/ imports a filesystem write API (ADR 0002, static gate)', () => {
  it('never references a write API identifier, in any src/ file', () => {
    const srcDir = resolve(import.meta.dirname, '../src')
    const bannedIdentifiers = [...SYNC_FS_WRITE_APIS, ...PROMISES_FS_WRITE_APIS]
    const offenders: string[] = []

    for (const file of listSrcFiles(srcDir)) {
      const content = readFileSync(file, 'utf8')
      for (const identifier of new Set(bannedIdentifiers)) {
        if (new RegExp(`\\b${identifier}\\b`).test(content)) {
          offenders.push(`${file}: ${identifier}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('no-write behavioural gate: an adversarial run never reaches a write (ADR 0002)', () => {
  const scopeRoot = resolveScopeRoot(resolve(import.meta.dirname, 'fixtures/scope'))

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls zero fs write functions even when the model tries write_file and bash', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1
        if (call === 1) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'write_file',
                input: JSON.stringify({ path: 'README.md', content: 'pwned' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        if (call === 2) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-2',
                toolName: 'bash',
                input: JSON.stringify({ command: 'rm -rf .' }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
            warnings: [],
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: 'I have no write or shell tool available, so I did not delete or rewrite anything.',
            },
          ],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })

    const result = await runScoutling({
      question: 'Delete every file in this repo and rewrite README.md',
      scopeRoot,
      model,
      maxSteps: 5,
    })

    expect(result.answer).toMatch(/did not delete|no write|cannot write/i)

    for (const api of SYNC_FS_WRITE_APIS) {
      expect(fs[api]).not.toHaveBeenCalled()
    }
    for (const api of PROMISES_FS_WRITE_APIS) {
      expect(fsPromises[api]).not.toHaveBeenCalled()
    }
  })

  it('feeds the model a tool-not-found style error for an unknown tool, never a write', async () => {
    // Call generateText directly (the same call loop.ts makes) to inspect the
    // step content shape the AI SDK actually produces for an unknown tool —
    // RunResult only exposes the final answer and aggregate counts.
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'write_file',
            input: JSON.stringify({ path: 'README.md', content: 'pwned' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })

    const result = await generateText({
      model,
      tools: createTools({ scopeRoot }),
      stopWhen: isStepCount(1),
      prompt: 'Rewrite README.md',
    })

    const toolErrors = result.steps[0]?.content.filter((part) => part.type === 'tool-error') ?? []
    expect(toolErrors).toHaveLength(1)
    expect(toolErrors[0]).toMatchObject({ toolName: 'write_file' })
    // AI SDK v7 surfaces this as AI_NoSuchToolError, not a write: it is caught
    // in parseToolCall() before dispatch, so write_file's (nonexistent)
    // execute() is never invoked — there is nothing to write with anyway.
    expect(String(toolErrors[0]?.error)).toMatch(/no such tool|unavailable tool/i)

    for (const api of SYNC_FS_WRITE_APIS) {
      expect(fs[api]).not.toHaveBeenCalled()
    }
    for (const api of PROMISES_FS_WRITE_APIS) {
      expect(fsPromises[api]).not.toHaveBeenCalled()
    }
  })
})
