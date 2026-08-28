import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgPath as bundledRgPath } from '@vscode/ripgrep'
import { existsSync } from 'node:fs'

import { CONTEXT_LENGTH_WARNING_THRESHOLD, runDoctorCommand, runModelsCommand } from '../src/commands.js'

/** Collects everything a command would otherwise write to stdout/stderr. */
function captureIO() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    writeStdout: (text: string) => stdout.push(text),
    writeStderr: (text: string) => stderr.push(text),
  }
}

/** A fresh, empty scope root with an isolated XDG config home, so no config files leak between tests. */
function freshScope() {
  const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-cmd-scope-'))
  const userConfigHome = mkdtempSync(join(tmpdir(), 'scoutling-cmd-xdg-'))
  return {
    scopeRoot,
    userConfigHome,
    cleanup: () => {
      rmSync(scopeRoot, { recursive: true, force: true })
      rmSync(userConfigHome, { recursive: true, force: true })
    },
  }
}

function modelsListResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('runModelsCommand', () => {
  it('prints one model id per line on stdout and exits 0', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () =>
        modelsListResponse(['qwen/qwen3-coder-next', 'qwen/qwen3-next-80b'])) as unknown as typeof fetch

      const exitCode = await runModelsCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(0)
      expect(io.stdout.join('')).toBe('qwen/qwen3-coder-next\nqwen/qwen3-next-80b\n')
      expect(io.stderr).toEqual([])
    } finally {
      scope.cleanup()
    }
  })

  it('honours --format json, emitting {models, baseUrl}', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse(['a-model'])) as unknown as typeof fetch

      const exitCode = await runModelsCommand(['--format', 'json'], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(0)
      const parsed = JSON.parse(io.stdout.join(''))
      expect(parsed).toEqual({ models: ['a-model'], baseUrl: 'http://localhost:1234/v1' })
    } finally {
      scope.cleanup()
    }
  })

  it('prints a definitive empty-state line when the provider is reachable but has no models loaded', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse([])) as unknown as typeof fetch

      const exitCode = await runModelsCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(0)
      expect(io.stdout.join('')).toContain('No models are loaded')
      expect(io.stdout.join('')).toContain('http://localhost:1234/v1')
    } finally {
      scope.cleanup()
    }
  })

  it('exits 3 with PROVIDER_UNREACHABLE JSON on stderr when the provider cannot be reached', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch

      const exitCode = await runModelsCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(3)
      expect(io.stdout).toEqual([])
      const error = JSON.parse(io.stderr.join(''))
      expect(error.error).toBe('PROVIDER_UNREACHABLE')
    } finally {
      scope.cleanup()
    }
  })

  it('rejects an unknown flag with BAD_ARGS (2)', async () => {
    const io = captureIO()
    const exitCode = await runModelsCommand(['--bogus'], { writeStdout: io.writeStdout, writeStderr: io.writeStderr })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
  })

  it('does not require --model: an invocation with no --model flag at all still succeeds', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse(['a-model'])) as unknown as typeof fetch

      const exitCode = await runModelsCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(0)
      expect(io.stderr.join('')).not.toContain('--model is required')
    } finally {
      scope.cleanup()
    }
  })

  it('--help prints usage and exits 0 without touching the network', async () => {
    const io = captureIO()
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      throw new Error('should never be called')
    }) as unknown as typeof fetch

    const exitCode = await runModelsCommand(['--help'], {
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    expect(io.stdout.join('')).toContain('scoutling models')
    expect(fetchCalled).toBe(false)
  })
})

describe('runDoctorCommand', () => {
  it('reports which layer set a key, proven by two different layers setting the same key', async () => {
    const scope = freshScope()
    try {
      writeFileSync(join(scope.scopeRoot, 'scoutling.config.json'), JSON.stringify({ model: 'from-shared-config' }))

      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse(['from-env-model'])) as unknown as typeof fetch

      const exitCode = await runDoctorCommand([], {
        // SCOUTLING_MODEL (environment layer) must win over scoutling.config.json (shared-config layer).
        env: { XDG_CONFIG_HOME: scope.userConfigHome, SCOUTLING_MODEL: 'from-env-model' },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      const out = io.stdout.join('')
      expect(out).toContain('from-env-model')
      expect(out).not.toContain('from-shared-config')
      expect(out).toContain('SCOUTLING_* environment variable')
      expect(exitCode).toBe(0)
    } finally {
      scope.cleanup()
    }
  })

  it('never prints the apiKey value, in text or json format', async () => {
    const scope = freshScope()
    const secret = 'sk-super-secret-value-12345'
    try {
      for (const format of ['text', 'json'] as const) {
        const io = captureIO()
        const fetchImpl = (async () => modelsListResponse(['a-model'])) as unknown as typeof fetch

        await runDoctorCommand(format === 'json' ? ['--format', 'json'] : [], {
          env: { XDG_CONFIG_HOME: scope.userConfigHome, SCOUTLING_API_KEY: secret, SCOUTLING_MODEL: 'a-model' },
          cwd: scope.scopeRoot,
          fetch: fetchImpl,
          writeStdout: io.writeStdout,
          writeStderr: io.writeStderr,
        })

        expect(io.stdout.join('')).not.toContain(secret)
        expect(io.stderr.join('')).not.toContain(secret)
      }
    } finally {
      scope.cleanup()
    }
  })

  it('exits 0 when reachable, model present, rg present and context length ok', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        if (href.includes('/api/v0/models')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'a-model', loaded_context_length: 65536, max_context_length: 131072 }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return modelsListResponse(['a-model'])
      }) as unknown as typeof fetch

      const exitCode = await runDoctorCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome, SCOUTLING_MODEL: 'a-model' },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(0)
      expect(io.stdout.join('')).toContain('no problems found')
    } finally {
      scope.cleanup()
    }
  })

  it('exits 1 when no model is configured, even though everything else is healthy', async () => {
    // A config with no model cannot run anything: --model is the one hard
    // requirement (DESIGN.md §5) and no layer supplies a default. Reporting
    // "no problems found" for it would be the exact misdiagnosis doctor
    // exists to prevent, so this stays pinned.
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse(['a-model'])) as unknown as typeof fetch

      const exitCode = await runDoctorCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      const stdout = io.stdout.join('')
      expect(exitCode).toBe(1)
      expect(stdout).toContain('no model configured')
      expect(stdout).not.toContain('no problems found')
      // The finding has to be actionable, not just a complaint.
      expect(stdout).toContain('scoutling models')
    } finally {
      scope.cleanup()
    }
  })

  it('exits 1 and reports a problem when the provider is unreachable', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch

      const exitCode = await runDoctorCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(1)
      const out = io.stdout.join('')
      expect(out).toContain('NOT reachable')
      expect(out).toMatch(/problem\(s\) found/)
    } finally {
      scope.cleanup()
    }
  })

  it('reports the ripgrep binary presence, matching the real filesystem state', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse([])) as unknown as typeof fetch

      await runDoctorCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      const out = io.stdout.join('')
      expect(out).toContain(bundledRgPath)
      expect(out).toContain(existsSync(bundledRgPath) ? 'present' : 'NOT found')
    } finally {
      scope.cleanup()
    }
  })

  it('requests the LM Studio native /api/v0/models path derived from the base URL origin, and reports the context length', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const requestedUrls: string[] = []
      const fetchImpl = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        requestedUrls.push(href)
        if (href.includes('/api/v0/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'a-model', loaded_context_length: 4096 }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return modelsListResponse(['a-model'])
      }) as unknown as typeof fetch

      const exitCode = await runDoctorCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome, SCOUTLING_MODEL: 'a-model' },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(requestedUrls).toContain('http://localhost:1234/api/v0/models')
      const out = io.stdout.join('')
      expect(out).toContain('4096')
      expect(out).toContain(`under ${CONTEXT_LENGTH_WARNING_THRESHOLD}`)
      expect(exitCode).toBe(1)
    } finally {
      scope.cleanup()
    }
  })

  it('reports the context length as unknown when the native endpoint 404s, without failing the whole command', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const requestedUrls: string[] = []
      const fetchImpl = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
        requestedUrls.push(href)
        if (href.includes('/api/v0/models')) {
          return new Response('not found', { status: 404 })
        }
        return modelsListResponse(['a-model'])
      }) as unknown as typeof fetch

      const exitCode = await runDoctorCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome, SCOUTLING_MODEL: 'a-model' },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(requestedUrls).toContain('http://localhost:1234/api/v0/models')
      const out = io.stdout.join('')
      expect(out).toContain('context length: unknown')
      // Provider reachable + model present + rg present: only the context
      // length is unknown, which is not itself a problem, so this must not
      // depend on the ripgrep binary's real presence on the test machine.
      expect(exitCode).toBe(existsSync(bundledRgPath) ? 0 : 1)
    } finally {
      scope.cleanup()
    }
  })

  it('honours --format json with the same never-leak-apiKey and provenance guarantees', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse(['a-model'])) as unknown as typeof fetch

      const exitCode = await runDoctorCommand(['--format', 'json'], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome, SCOUTLING_MODEL: 'a-model' },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      const parsed = JSON.parse(io.stdout.join(''))
      expect(parsed.config.model).toEqual({ value: 'a-model', layer: 'SCOUTLING_* environment variable' })
      expect(parsed.config.apiKey).toEqual({ set: false, layer: 'built-in default' })
      expect(Array.isArray(parsed.problems)).toBe(true)
      expect(typeof exitCode).toBe('number')
    } finally {
      scope.cleanup()
    }
  })

  it('does not require --model: an invocation with no --model flag at all still runs and reports "none configured"', async () => {
    const scope = freshScope()
    try {
      const io = captureIO()
      const fetchImpl = (async () => modelsListResponse([])) as unknown as typeof fetch

      const exitCode = await runDoctorCommand([], {
        env: { XDG_CONFIG_HOME: scope.userConfigHome },
        cwd: scope.scopeRoot,
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(io.stderr.join('')).not.toContain('--model is required')
      expect(io.stdout.join('')).toContain('none configured')
      // It diagnoses rather than refusing. BAD_ARGS (2) would mean doctor
      // demanded the very thing it exists to help you discover; 1 is the
      // "found problems" tier, and an unrunnable config is one of them.
      expect(exitCode).toBe(1)
    } finally {
      scope.cleanup()
    }
  })

  it('--help prints usage and exits 0 without touching the network', async () => {
    const io = captureIO()
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      throw new Error('should never be called')
    }) as unknown as typeof fetch

    const exitCode = await runDoctorCommand(['--help'], {
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    expect(io.stdout.join('')).toContain('scoutling doctor')
    expect(fetchCalled).toBe(false)
  })

  it('rejects an unknown flag with BAD_ARGS (2)', async () => {
    const io = captureIO()
    const exitCode = await runDoctorCommand(['--bogus'], { writeStdout: io.writeStdout, writeStderr: io.writeStderr })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
  })
})
