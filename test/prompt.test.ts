import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { buildSystemPrompt } from '../src/prompt.js'

function withScope(fn: (scopeRoot: string) => void): void {
  const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-prompt-'))
  try {
    fn(scopeRoot)
  } finally {
    rmSync(scopeRoot, { recursive: true, force: true })
  }
}

describe('buildSystemPrompt', () => {
  it('names the scope root', () => {
    withScope((scopeRoot) => {
      const prompt = buildSystemPrompt({ scopeRoot })
      expect(prompt).toContain(scopeRoot)
    })
  })

  it('states it is read-only', () => {
    withScope((scopeRoot) => {
      const prompt = buildSystemPrompt({ scopeRoot })
      expect(prompt).toMatch(/read-only|cannot (change|write|modify)/i)
    })
  })

  it('requires path:line citations', () => {
    withScope((scopeRoot) => {
      const prompt = buildSystemPrompt({ scopeRoot })
      expect(prompt).toMatch(/path:line/i)
    })
  })

  it('instructs saying so explicitly when the budget runs out', () => {
    withScope((scopeRoot) => {
      const prompt = buildSystemPrompt({ scopeRoot })
      expect(prompt).toMatch(/budget/i)
    })
  })

  it('instructs answering in the language of the question', () => {
    withScope((scopeRoot) => {
      const prompt = buildSystemPrompt({ scopeRoot })
      expect(prompt).toMatch(/language/i)
    })
  })

  it('includes a context file verbatim, under a Project context heading', () => {
    withScope((scopeRoot) => {
      writeFileSync(join(scopeRoot, 'CLAUDE.md'), 'Use two-space indentation everywhere.')

      const prompt = buildSystemPrompt({ scopeRoot, contextFiles: ['CLAUDE.md'] })

      expect(prompt).toContain('Project context')
      expect(prompt).toContain('Use two-space indentation everywhere.')
    })
  })

  it('truncates an over-long context file with a visible note', () => {
    withScope((scopeRoot) => {
      writeFileSync(join(scopeRoot, 'CLAUDE.md'), 'x'.repeat(5000))

      const prompt = buildSystemPrompt({
        scopeRoot,
        contextFiles: ['CLAUDE.md'],
        contextFilesMaxChars: 100,
      })

      expect(prompt).toContain('x'.repeat(100))
      expect(prompt).not.toContain('x'.repeat(101))
      expect(prompt).toMatch(/truncated/i)
    })
  })

  it('skips a missing context file without throwing', () => {
    withScope((scopeRoot) => {
      expect(() =>
        buildSystemPrompt({ scopeRoot, contextFiles: ['does-not-exist.md'] }),
      ).not.toThrow()

      const prompt = buildSystemPrompt({ scopeRoot, contextFiles: ['does-not-exist.md'] })
      expect(prompt).not.toContain('does-not-exist.md is missing content')
    })
  })

  it('systemPromptOverride replaces everything, including context files', () => {
    withScope((scopeRoot) => {
      writeFileSync(join(scopeRoot, 'CLAUDE.md'), 'Project-specific rules.')

      const prompt = buildSystemPrompt({
        scopeRoot,
        contextFiles: ['CLAUDE.md'],
        systemPromptOverride: 'You are a custom auditor. Only answer yes or no.',
      })

      expect(prompt).toBe('You are a custom auditor. Only answer yes or no.')
    })
  })
})

describe('project context stays inside the scope', () => {
  it('skips a context file that escapes the scope root', () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-prompt-scope-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'scoutling-prompt-outside-'))
    writeFileSync(join(outsideDir, 'secret.txt'), 'SUPER-SECRET-VALUE')
    const escaping = relative(scopeRoot, join(outsideDir, 'secret.txt'))

    const prompt = buildSystemPrompt({ scopeRoot, contextFiles: [escaping] })

    expect(prompt).not.toContain('SUPER-SECRET-VALUE')
    rmSync(scopeRoot, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })
})

describe('the built-in prompt names the tools that exist', () => {
  it('names all three tools: list_dir, grep and read_file', () => {
    const prompt = buildSystemPrompt({ scopeRoot: '/some/scope' })

    expect(prompt).toContain('list_dir')
    expect(prompt).toContain('grep')
    expect(prompt).toContain('read_file')
  })

  it('still states these are the only tools available, with no shell, so the model stops inventing others', () => {
    const prompt = buildSystemPrompt({ scopeRoot: '/some/scope' })

    expect(prompt.toLowerCase()).toMatch(/only tools? you have|only tools? available/)
    expect(prompt.toLowerCase()).toContain('no shell')
  })
})
