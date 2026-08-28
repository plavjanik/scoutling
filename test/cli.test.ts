import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isDirectEntry, parseArgs, runCli } from '../src/cli.js'
import { ScoutlingError } from '../src/errors.js'

/** Read-only fixture scope shared by every citation-related test below — no mkdtemp needed. */
const fixtureScopeRoot = resolve(import.meta.dirname, 'fixtures/scope')

/** A one-shot OpenAI-compatible chat completion with plain text content and finish_reason 'stop'. */
function textCompletionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chat-1',
      object: 'chat.completion',
      created: 0,
      model: 'a-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** A chat completion that always calls list_dir — a model that never stops on its own, to force exhaustion. */
function toolCallCompletionResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chat-1',
      object: 'chat.completion',
      created: 0,
      model: 'a-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

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
      requireCitations: false,
      question: 'What does resolvePath do?',
      model: 'qwen/qwen3-coder-next',
      path: '/tmp/repo',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-test',
    })
  })

  it('parses --format and --require-citations', () => {
    const args = parseArgs(['a question', '--format', 'json', '--require-citations'])
    expect(args.format).toBe('json')
    expect(args.requireCitations).toBe(true)
  })

  it('defaults --format to undefined (runCli applies the "text" default) and --require-citations to false', () => {
    const args = parseArgs(['a question'])
    expect(args.format).toBeUndefined()
    expect(args.requireCitations).toBe(false)
  })

  it('rejects an unknown --format value, naming both valid values', () => {
    expect(() => parseArgs(['a question', '--format', 'nonsense'])).toThrow(ScoutlingError)
    try {
      parseArgs(['a question', '--format', 'nonsense'])
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
      expect((error as ScoutlingError).message).toContain('text')
      expect((error as ScoutlingError).message).toContain('json')
    }
  })

  it('rejects --format with a missing value', () => {
    expect(() => parseArgs(['a question', '--format'])).toThrow(ScoutlingError)
  })

  it('parses --max-steps as a number', () => {
    const args = parseArgs(['a question', '--max-steps', '5'])
    expect(args.maxSteps).toBe(5)
  })

  it('rejects --max-steps 0', () => {
    expect(() => parseArgs(['a question', '--max-steps', '0'])).toThrow(ScoutlingError)
    try {
      parseArgs(['a question', '--max-steps', '0'])
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
    }
  })

  it('rejects --max-steps abc (non-integer)', () => {
    expect(() => parseArgs(['a question', '--max-steps', 'abc'])).toThrow(ScoutlingError)
    try {
      parseArgs(['a question', '--max-steps', 'abc'])
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
    }
  })

  it('rejects --max-steps with a missing value', () => {
    expect(() => parseArgs(['a question', '--max-steps'])).toThrow(ScoutlingError)
    try {
      parseArgs(['a question', '--max-steps'])
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
    }
  })

  it('rejects a non-integer --max-steps like 2.5', () => {
    expect(() => parseArgs(['a question', '--max-steps', '2.5'])).toThrow(ScoutlingError)
  })

  it('parses --budget as a string, unvalidated at this layer', () => {
    const args = parseArgs(['a question', '--budget', 'deep'])
    expect(args.budget).toBe('deep')
  })

  it('parses --max-tool-bytes as a number', () => {
    const args = parseArgs(['a question', '--max-tool-bytes', '20000'])
    expect(args.maxToolBytes).toBe(20000)
  })

  it('rejects --max-tool-bytes 0', () => {
    expect(() => parseArgs(['a question', '--max-tool-bytes', '0'])).toThrow(ScoutlingError)
    try {
      parseArgs(['a question', '--max-tool-bytes', '0'])
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
    }
  })

  it('parses --timeout-ms as a number', () => {
    const args = parseArgs(['a question', '--timeout-ms', '5000'])
    expect(args.timeoutMs).toBe(5000)
  })

  it('rejects --timeout-ms abc (non-integer)', () => {
    expect(() => parseArgs(['a question', '--timeout-ms', 'abc'])).toThrow(ScoutlingError)
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
    expect(() => parseArgs(['q', '--bogus-flag', 'json'])).toThrow(ScoutlingError)
    try {
      parseArgs(['q', '--bogus-flag', 'json'])
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
      argv: ['a question', '--bogus-flag', 'json'],
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
  })

  it('exits BAD_ARGS (2) for an unknown --budget preset passed as a flag, before any network call', async () => {
    const io = captureIO()
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      throw new Error('should never be called')
    }) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['a question', '--model', 'x', '--budget', 'nonsense'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
    expect(error.message).toContain('quick')
    expect(error.message).toContain('normal')
    expect(error.message).toContain('deep')
    expect(fetchCalled).toBe(false)
  })

  it('exits BAD_ARGS (2) for an unknown "budget" value in scoutling.config.json, before any network call', async () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-cli-budget-config-'))
    try {
      writeFileSync(join(scopeRoot, 'scoutling.config.json'), JSON.stringify({ budget: 'nonsense' }))

      const io = captureIO()
      let fetchCalled = false
      const fetchImpl = (async () => {
        fetchCalled = true
        throw new Error('should never be called')
      }) as unknown as typeof fetch

      const exitCode = await runCli({
        argv: ['a question', '--model', 'x', '--path', scopeRoot],
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      expect(exitCode).toBe(2)
      const error = JSON.parse(io.stderr.join(''))
      expect(error.error).toBe('BAD_ARGS')
      expect(error.message).toContain('nonsense')
      expect(fetchCalled).toBe(false)
    } finally {
      rmSync(scopeRoot, { recursive: true, force: true })
    }
  })

  it('honours --max-steps: a model that keeps calling tools is cut off at exactly that many steps', async () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), 'scoutling-cli-maxsteps-'))
    try {
      const io = captureIO()
      const calls: unknown[] = []
      // Always returns a tool call (list_dir), so the loop would run forever
      // without a cap — this is what proves --max-steps is actually wired
      // through to runScoutling rather than just parsed and discarded.
      const fetchImpl = (async (_url: string | URL | Request, init: RequestInit = {}) => {
        calls.push(init)
        return new Response(
          JSON.stringify({
            id: 'chat-1',
            object: 'chat.completion',
            created: 0,
            model: 'a-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const exitCode = await runCli({
        argv: [
          'a question',
          '--model',
          'a-model',
          '--path',
          scopeRoot,
          '--max-steps',
          '2',
        ],
        fetch: fetchImpl,
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
      })

      // Exhausted mid-loop (the model still wanted to call tools) -> exit 1.
      expect(exitCode).toBe(1)
      expect(calls).toHaveLength(2)
    } finally {
      rmSync(scopeRoot, { recursive: true, force: true })
    }
  })

  it('--format json emits parseable JSON on stdout with every documented key', async () => {
    const io = captureIO()
    const fetchImpl = (async () =>
      textCompletionResponse('The value is set (a.txt:1) at startup.')) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['a question', '--model', 'a-model', '--path', fixtureScopeRoot, '--format', 'json'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.stdout.join(''))
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'answer',
        'exhausted',
        'model',
        'sources',
        'stepsUsed',
        'timedOut',
        'toolCalls',
        'toolOutputBytes',
        'usage',
        'wallMs',
      ].sort(),
    )
    expect(parsed.model).toBe('a-model')
    expect(parsed.timedOut).toBe(false)
    expect(Array.isArray(parsed.sources)).toBe(true)
  })

  it('--format text puts the Sources: line on stdout after the answer; --format json does not print it separately', async () => {
    const answerText = 'The value is set (a.txt:1) at startup.'
    const fetchImpl = (async () => textCompletionResponse(answerText)) as unknown as typeof fetch

    const textIo = captureIO()
    const textExit = await runCli({
      argv: ['a question', '--model', 'a-model', '--path', fixtureScopeRoot],
      fetch: fetchImpl,
      writeStdout: textIo.writeStdout,
      writeStderr: textIo.writeStderr,
    })
    expect(textExit).toBe(0)
    const textOut = textIo.stdout.join('')
    expect(textOut).toContain(answerText)
    expect(textOut).toContain('Sources:')
    expect(textOut.indexOf('Sources:')).toBeGreaterThan(textOut.indexOf(answerText))

    const jsonIo = captureIO()
    const jsonExit = await runCli({
      argv: ['a question', '--model', 'a-model', '--path', fixtureScopeRoot, '--format', 'json'],
      fetch: fetchImpl,
      writeStdout: jsonIo.writeStdout,
      writeStderr: jsonIo.writeStderr,
    })
    expect(jsonExit).toBe(0)
    expect(jsonIo.stdout.join('')).not.toContain('Sources:')
  })

  it('--format nonsense exits BAD_ARGS (2)', async () => {
    const io = captureIO()
    const exitCode = await runCli({
      argv: ['a question', '--model', 'a-model', '--format', 'nonsense'],
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
    expect(error.message).toContain('text')
    expect(error.message).toContain('json')
  })

  it('--require-citations with an answer that cites nothing exits 1, still prints the answer, and warns NO_VERIFIED_CITATIONS', async () => {
    const io = captureIO()
    const fetchImpl = (async () =>
      textCompletionResponse('There is nothing relevant in this scope.')) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['a question', '--model', 'a-model', '--path', fixtureScopeRoot, '--require-citations'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(1)
    expect(io.stdout.join('')).toContain('There is nothing relevant')
    const warnings = io.stderr.map((line) => JSON.parse(line))
    expect(warnings).toContainEqual(expect.objectContaining({ warning: 'NO_VERIFIED_CITATIONS' }))
  })

  it('--require-citations with an answer that verifies against the scope exits 0 with no warning', async () => {
    const io = captureIO()
    const fetchImpl = (async () =>
      textCompletionResponse('The value is set (a.txt:1) at startup.')) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['a question', '--model', 'a-model', '--path', fixtureScopeRoot, '--require-citations'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    expect(io.stderr).toEqual([])
  })

  it('an exhausted run emits a BUDGET_EXHAUSTED warning on stderr and exits 1', async () => {
    const io = captureIO()
    const fetchImpl = (async () => toolCallCompletionResponse()) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['a question', '--model', 'a-model', '--path', fixtureScopeRoot, '--max-steps', '1'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(1)
    const warnings = io.stderr.map((line) => JSON.parse(line))
    expect(warnings).toContainEqual(expect.objectContaining({ warning: 'BUDGET_EXHAUSTED' }))
  })

  it('exhausted and zero verified citations under --require-citations still exits 1, with both warnings', async () => {
    const io = captureIO()
    const fetchImpl = (async () => toolCallCompletionResponse()) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: [
        'a question',
        '--model',
        'a-model',
        '--path',
        fixtureScopeRoot,
        '--max-steps',
        '1',
        '--require-citations',
      ],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(1)
    const warnings = io.stderr.map((line) => JSON.parse(line))
    expect(warnings).toContainEqual(expect.objectContaining({ warning: 'BUDGET_EXHAUSTED' }))
    expect(warnings).toContainEqual(expect.objectContaining({ warning: 'NO_VERIFIED_CITATIONS' }))
  })
})

describe('runCli: "scoutling -" reads the question from stdin', () => {
  it('runs the question read from an injected readStdin, trimming trailing whitespace', async () => {
    const io = captureIO()
    let requestBody = ''

    const exitCode = await runCli({
      argv: ['-', '--model', 'a-model', '--path', fixtureScopeRoot],
      readStdin: async () => 'What does resolvePath do?\n\n  ',
      fetch: (async (_url: string | URL | Request, init: RequestInit = {}) => {
        requestBody = (init.body as string) ?? requestBody
        return textCompletionResponse('The value is set (a.txt:1) at startup.')
      }) as unknown as typeof fetch,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    expect(io.stdout.join('')).toContain('The value is set')
    // Trailing whitespace (including the newline `echo` appends) must be
    // gone; leading formatting is left alone, so this also proves the
    // question text actually reached the model rather than being dropped.
    expect(requestBody).toContain('What does resolvePath do?')
    expect(requestBody).not.toContain('What does resolvePath do?\\n\\n')
  })

  it('empty stdin is BAD_ARGS (2), not an empty run', async () => {
    const io = captureIO()
    const exitCode = await runCli({
      argv: ['-', '--model', 'a-model'],
      readStdin: async () => '',
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
  })

  it('whitespace-only stdin is BAD_ARGS (2)', async () => {
    const io = captureIO()
    const exitCode = await runCli({
      argv: ['-', '--model', 'a-model'],
      readStdin: async () => '   \n\t  \n',
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
  })
})

describe('runCli: models/doctor subcommand dispatch', () => {
  it('"scoutling models" dispatches to the models subcommand, never requiring --model', async () => {
    const io = captureIO()
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'a-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['models'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    expect(io.stdout.join('')).toBe('a-model\n')
    expect(io.stderr.join('')).not.toContain('--model is required')
  })

  it('"scoutling doctor" dispatches to the doctor subcommand, never requiring --model', async () => {
    const io = captureIO()
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['doctor'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(io.stderr.join('')).not.toContain('--model is required')
    expect(io.stdout.join('')).toContain('config:')
    expect(typeof exitCode).toBe('number')
  })

  it('a question whose text is not exactly "models" or "doctor" still runs as a normal question (no regression)', async () => {
    const io = captureIO()
    const fetchImpl = (async () => textCompletionResponse('Answer text.')) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['list all the models in this repo', '--model', 'a-model', '--path', fixtureScopeRoot],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    expect(exitCode).toBe(0)
    expect(io.stdout.join('')).toContain('Answer text.')
  })

  it('a single-word question that is exactly "models" is dispatched as the subcommand (documented casualty)', async () => {
    const io = captureIO()
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const exitCode = await runCli({
      argv: ['models', '--model', 'a-model'],
      fetch: fetchImpl,
      writeStdout: io.writeStdout,
      writeStderr: io.writeStderr,
    })

    // The models subcommand does not accept --model, so this is BAD_ARGS —
    // proving dispatch happened rather than the string "models" running as
    // a question (which would have accepted --model just fine).
    expect(exitCode).toBe(2)
    const error = JSON.parse(io.stderr.join(''))
    expect(error.error).toBe('BAD_ARGS')
    expect(error.message).toContain('--model')
  })
})

describe('direct-entry detection', () => {
  it('recognizes the CLI being run from a path containing a space', () => {
    const path = '/tmp/my scoutling/dist/cli.js'

    expect(isDirectEntry(pathToFileURL(path).href, path)).toBe(true)
  })

  it('recognizes the CLI being run from a plain path', () => {
    const path = '/usr/local/lib/node_modules/scoutling/dist/cli.js'

    expect(isDirectEntry(pathToFileURL(path).href, path)).toBe(true)
  })

  it('does not fire when the module is imported rather than executed', () => {
    expect(
      isDirectEntry(pathToFileURL('/repo/dist/cli.js').href, '/repo/node_modules/.bin/vitest'),
    ).toBe(false)
  })

  it('does not throw when there is no argv[1] at all', () => {
    expect(isDirectEntry(pathToFileURL('/repo/dist/cli.js').href, undefined)).toBe(false)
  })
})
