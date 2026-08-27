import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseArgs, runCli } from '../src/cli.js'
import { ScoutlingError } from '../src/errors.js'

describe('parseArgs', () => {
  it('parses the question and known flags', () => {
    const args = parseArgs([
      'What does resolvePath do?',
      '--model',
      'qwen/qwen3-coder-next',
      '--path',
      '/tmp/repo',
      '--base-url',
      'http://localhost:1234/v1',
      '--api-key',
      'sk-test',
      '--verbose',
    ])

    expect(args).toEqual({
      help: false,
      verbose: true,
      question: 'What does resolvePath do?',
      model: 'qwen/qwen3-coder-next',
      path: '/tmp/repo',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-test',
    })
  })

  it('parses --help with no question required', () => {
    const args = parseArgs(['--help'])
    expect(args.help).toBe(true)
  })

  it('rejects a missing question', () => {
    expect(() => parseArgs([])).toThrow(ScoutlingError)
    expect(() => parseArgs(['--model', 'x'])).toThrow(ScoutlingError)
  })

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['q', '--format', 'json'])).toThrow(ScoutlingError)
    try {
      parseArgs(['q', '--format', 'json'])
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
    }
  })

  it('rejects a flag missing its value', () => {
    expect(() => parseArgs(['q', '--model'])).toThrow(ScoutlingError)
  })

  it('rejects more than one positional argument', () => {
    expect(() => parseArgs(['question', 'extra'])).toThrow(ScoutlingError)
  })
})

/** Collects everything runCli would otherwise write to stdout/stderr. */
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

describe('runCli', () => {
  it('--help prints usage on stdout and exits 0', async () => {
    const io = captureIO()
    const exitCode = await runCli({
      argv: ['--help'],
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    expect(io.stdout.join('')).toContain('scoutling')
    expect(io.stderr).toEqual([])
  })

  it('exits with PATH_NOT_FOUND (5) for a nonexistent --path', async () => {
    const io = captureIO()
    const exitCode = await runCli({
      argv: ['a question', '--model', 'x', '--path', '/definitely/does/not/exist'],
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(5)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('PATH_NOT_FOUND')
    expect(io.stdout).toEqual([])
  })

  it('exits BAD_ARGS (2) for a missing --model, and its message includes the live model list', async () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-cli-'))
    const userConfigHome = mkdtempSync(join(tmpdir(), 'scoutling-cli-xdg-'))
    try {
      const io = captureIO()
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3-coder-next' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch

      const exitCode = await runCli({
        argv: ['a question', '--path', scopeRoot],
        env: { XDG_CONFIG_HOME: userConfigHome },
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(2)
      const error = JSON.parse(io.stderr.join(''))
      expect(error.error).toBe('BAD_ARGS')
      expect(error.message + ' ' + error.hint).toContain('qwen/qwen3-coder-next')
    } finally {
      rmSync(scopeRoot, { recursive: true, force: true })
      rmSync(userConfigHome, { recursive: true, force: true })
    }
  })

  it('missing --model still reports BAD_ARGS when the provider is unreachable for the list too', async () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-cli-'))
    const userConfigHome = mkdtempSync(join(tmpdir(), 'scoutling-cli-xdg-'))
    try {
      const io = captureIO()
      const fetchImpl = (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch

      const exitCode = await runCli({
        argv: ['a question', '--path', scopeRoot],
        env: { XDG_CONFIG_HOME: userConfigHome },
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(2)
      const error = JSON.parse(io.stderr.join(''))
      expect(error.error).toBe('BAD_ARGS')
      expect(error.hint).toMatch(/unreachable/i)
    } finally {
      rmSync(scopeRoot, { recursive: true, force: true })
      rmSync(userConfigHome, { recursive: true, force: true })
    }
  })

  it('rejects an unknown flag with BAD_ARGS (2) before touching config or the provider', async () => {
    const io = captureIO()
    const exitCode = await runCli({
      argv: ['a question', '--format', 'json'],
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
  })
})
