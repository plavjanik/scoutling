import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../src/config.js'

let scopeRoot: string
let userConfigHome: string

/** An env with no SCOUTLING_* vars and a user config dir that does not exist. */
function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: userConfigHome, ...overrides }
}

function writeSharedConfig(value: unknown): void {
  writeFileSync(join(scopeRoot, 'scoutling.config.json'), JSON.stringify(value))
}

function writeLocalOverride(value: unknown): void {
  writeFileSync(join(scopeRoot, 'scoutling.config.local.json'), JSON.stringify(value))
}

function writeUserConfig(value: unknown): void {
  mkdirSync(join(userConfigHome, 'scoutling'), { recursive: true })
  writeFileSync(join(userConfigHome, 'scoutling', 'config.json'), JSON.stringify(value))
}

beforeEach(() => {
  scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-scope-'))
  userConfigHome = mkdtempSync(join(tmpdir(), 'scoutling-xdg-'))
})

afterEach(() => {
  rmSync(scopeRoot, { recursive: true, force: true })
  rmSync(userConfigHome, { recursive: true, force: true })
})

describe('built-in defaults', () => {
  it('provides a working config with no files, env or flags — except a model', () => {
    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.baseUrl).toBe('http://localhost:1234/v1')
    expect(config.budget).toBe('normal')
    expect(config.contextFiles).toEqual([])
    expect(config.temperature).toBe(0)
  })

  it('has no default model, because which models exist is a property of the machine', () => {
    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.model).toBeUndefined()
  })
})

describe('layer precedence', () => {
  it('prefers a flag over every other layer', () => {
    writeUserConfig({ model: 'from-user-config' })
    writeSharedConfig({ model: 'from-shared-config' })
    writeLocalOverride({ model: 'from-local-override' })

    const { config } = loadConfig({
      scopeRoot,
      flags: { model: 'from-flag' },
      env: cleanEnv({ SCOUTLING_MODEL: 'from-environment' }),
    })

    expect(config.model).toBe('from-flag')
  })

  it('prefers the environment over the config files', () => {
    writeUserConfig({ model: 'from-user-config' })
    writeSharedConfig({ model: 'from-shared-config' })
    writeLocalOverride({ model: 'from-local-override' })

    const { config } = loadConfig({
      scopeRoot,
      env: cleanEnv({ SCOUTLING_MODEL: 'from-environment' }),
    })

    expect(config.model).toBe('from-environment')
  })

  it('prefers the local override over the shared config and the user config', () => {
    writeUserConfig({ model: 'from-user-config' })
    writeSharedConfig({ model: 'from-shared-config' })
    writeLocalOverride({ model: 'from-local-override' })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.model).toBe('from-local-override')
  })

  it('prefers the shared config over the user config', () => {
    writeUserConfig({ model: 'from-user-config' })
    writeSharedConfig({ model: 'from-shared-config' })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.model).toBe('from-shared-config')
  })

  it('prefers the user config over the built-in defaults', () => {
    writeUserConfig({ baseUrl: 'http://localhost:11434/v1' })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.baseUrl).toBe('http://localhost:11434/v1')
  })
})

describe('merging', () => {
  it('merges per key, so a higher layer setting one key leaves the others alone', () => {
    writeSharedConfig({ model: 'shared-model', budget: 'deep', temperature: 0.5 })
    writeLocalOverride({ model: 'my-model' })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.model).toBe('my-model')
    expect(config.budget).toBe('deep')
    expect(config.temperature).toBe(0.5)
  })

  it('replaces arrays rather than concatenating them', () => {
    writeSharedConfig({ excludeGlobs: ['dist/**', 'out/**'] })
    writeLocalOverride({ excludeGlobs: ['vendor/**'] })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.excludeGlobs).toEqual(['vendor/**'])
  })

  it('does not treat an absent key in a higher layer as an override', () => {
    writeSharedConfig({ model: 'shared-model' })
    writeLocalOverride({ baseUrl: 'http://localhost:8080/v1' })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.model).toBe('shared-model')
    expect(config.baseUrl).toBe('http://localhost:8080/v1')
  })
})

describe('context files', () => {
  it('dedupes by realpath, so listing a symlink and its target keeps one', () => {
    writeFileSync(join(scopeRoot, 'CLAUDE.md'), '# project context')
    symlinkSync(join(scopeRoot, 'CLAUDE.md'), join(scopeRoot, 'AGENTS.md'))
    writeSharedConfig({ contextFiles: ['CLAUDE.md', 'AGENTS.md'] })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.contextFiles).toEqual(['CLAUDE.md'])
  })

  it('dedupes a file listed twice under different relative spellings', () => {
    writeFileSync(join(scopeRoot, 'CLAUDE.md'), '# project context')
    writeSharedConfig({ contextFiles: ['CLAUDE.md', './CLAUDE.md'] })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.contextFiles).toEqual(['CLAUDE.md'])
  })

  it('keeps a context file that does not exist, so the run can report it', () => {
    writeSharedConfig({ contextFiles: ['CLAUDE.md', 'MISSING.md'] })

    const { config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(config.contextFiles).toEqual(['CLAUDE.md', 'MISSING.md'])
  })
})

describe('secrets', () => {
  it('warns when an apiKey is found in the shared config, which is committed', () => {
    writeSharedConfig({ model: 'a-model', apiKey: 'sk-leaked-into-git' })

    const { warnings } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('scoutling.config.json')
    expect(warnings[0]).toContain('apiKey')
  })

  it('never puts the secret itself in the warning', () => {
    writeSharedConfig({ apiKey: 'sk-leaked-into-git' })

    const { warnings } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(warnings.join('\n')).not.toContain('sk-leaked-into-git')
  })

  it('does not warn about an apiKey in the local override, which is gitignored', () => {
    writeLocalOverride({ apiKey: 'sk-only-on-my-machine' })

    const { warnings, config } = loadConfig({ scopeRoot, env: cleanEnv() })

    expect(warnings).toEqual([])
    expect(config.apiKey).toBe('sk-only-on-my-machine')
  })
})

describe('provenance, for doctor', () => {
  it('records which layer set each key', () => {
    writeUserConfig({ baseUrl: 'http://localhost:11434/v1' })
    writeSharedConfig({ budget: 'deep', contextFiles: ['CLAUDE.md'] })
    writeLocalOverride({ model: 'my-model' })

    const { provenance } = loadConfig({
      scopeRoot,
      flags: { temperature: 0.7 },
      env: cleanEnv(),
    })

    expect(provenance.temperature).toBe('flag')
    expect(provenance.model).toBe('local-override')
    expect(provenance.budget).toBe('shared-config')
    expect(provenance.baseUrl).toBe('user-config')
    expect(provenance.excludeGlobs).toBe('built-in')
  })

  it('attributes a key set by an environment variable to the environment', () => {
    const { provenance } = loadConfig({
      scopeRoot,
      env: cleanEnv({ SCOUTLING_MODEL: 'from-environment' }),
    })

    expect(provenance.model).toBe('environment')
  })
})

describe('malformed config files', () => {
  it('reports the offending file by name rather than throwing a JSON parse error', () => {
    writeFileSync(join(scopeRoot, 'scoutling.config.json'), '{ not json')

    expect(() => loadConfig({ scopeRoot, env: cleanEnv() })).toThrowError(
      /scoutling\.config\.json/,
    )
  })
})
