import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILT_IN_DEFAULTS } from '../src/config.js'
import { ScoutlingError } from '../src/errors.js'
import { buildRunInputs } from '../src/run-setup.js'
import type { ScoutlingConfig } from '../src/types.js'

function withScope(fn: (scopeRoot: string) => void): void {
  const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-run-setup-'))
  try {
    fn(scopeRoot)
  } finally {
    rmSync(scopeRoot, { recursive: true, force: true })
  }
}

/** A complete, valid config — the same shape `loadConfig` would hand `runCli`, model included. */
function buildConfig(overrides: Partial<ScoutlingConfig> = {}): ScoutlingConfig {
  return { ...BUILT_IN_DEFAULTS, model: 'qwen/qwen3-coder-next', ...overrides }
}

describe('buildRunInputs', () => {
  it('builds the default built-in system prompt when systemPromptFile is null', () => {
    withScope((scopeRoot) => {
      const { systemPrompt } = buildRunInputs({ scopeRoot, config: buildConfig() })

      expect(systemPrompt).toContain(scopeRoot)
      expect(systemPrompt).toMatch(/read-only/i)
    })
  })

  it('constructs a model bound to config.baseUrl/model — same LanguageModel shape the CLI passes to runScoutling', () => {
    withScope((scopeRoot) => {
      const { model } = buildRunInputs({ scopeRoot, config: buildConfig() })

      // The AI SDK's LanguageModel is a discriminated union of a string id or
      // an object with a modelId; the openai-compatible provider returns the
      // object form. This is not a network call — just checking the wiring
      // constructed something addressable by the configured model id.
      expect(model).toBeTruthy()
      expect(typeof model === 'object' ? model.modelId : model).toBe('qwen/qwen3-coder-next')
    })
  })

  it('honours systemPromptFile: fully replaces the built-in prompt with the file contents', () => {
    withScope((scopeRoot) => {
      writeFileSync(join(scopeRoot, 'audit.md'), 'You are a doc-vs-code auditor. Nothing else.')

      const { systemPrompt } = buildRunInputs({
        scopeRoot,
        config: buildConfig({ systemPromptFile: 'audit.md' }),
      })

      expect(systemPrompt).toBe('You are a doc-vs-code auditor. Nothing else.')
      expect(systemPrompt).not.toMatch(/read-only/i)
    })
  })

  it('throws a BAD_ARGS ScoutlingError, same message and hint as the CLI, when systemPromptFile is missing', () => {
    withScope((scopeRoot) => {
      let caught: unknown
      try {
        buildRunInputs({ scopeRoot, config: buildConfig({ systemPromptFile: 'does-not-exist.md' }) })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(ScoutlingError)
      const error = caught as ScoutlingError
      expect(error.code).toBe('BAD_ARGS')
      expect(error.message).toBe('systemPromptFile not found: does-not-exist.md')
      expect(error.hint).toBe('Fix or remove systemPromptFile in the config.')
    })
  })

  it('throws a BAD_ARGS ScoutlingError when config has no model', () => {
    withScope((scopeRoot) => {
      let caught: unknown
      try {
        buildRunInputs({ scopeRoot, config: { ...BUILT_IN_DEFAULTS } })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(ScoutlingError)
      expect((caught as ScoutlingError).code).toBe('BAD_ARGS')
    })
  })

  it('includes contextFiles in the built-in prompt', () => {
    withScope((scopeRoot) => {
      writeFileSync(join(scopeRoot, 'CLAUDE.md'), 'Use two-space indentation everywhere.')

      const { systemPrompt } = buildRunInputs({
        scopeRoot,
        config: buildConfig({ contextFiles: ['CLAUDE.md'] }),
      })

      expect(systemPrompt).toContain('Use two-space indentation everywhere.')
      expect(systemPrompt).toContain('Project context')
    })
  })
})
