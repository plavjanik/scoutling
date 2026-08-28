import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runEval, toPosixExcludeGlob, type EvalIo, type EvalRunInput } from '../eval/run-eval.js'
import type { RunResult } from '../src/loop.js'

const fixtureRepo = resolve(import.meta.dirname, 'fixtures/scope')

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scoutling-eval-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeQuestionFile(dir: string, content: unknown): string {
  const path = join(dir, 'questions.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

/** A minimal, valid question file: two questions, neither with `expect` or `path`. */
function basicQuestionFile(overrides: { questions?: unknown[] } = {}) {
  return {
    description: 'test questions',
    questions: overrides.questions ?? [
      { id: 'q1', question: 'What does a.txt say?' },
      { id: 'q2', question: 'What is in sub/?' },
    ],
  }
}

function fakeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    answer: 'The answer is here (a.txt:1).',
    stepsUsed: 2,
    toolCalls: { read_file: 1, list_dir: 0, grep: 0 },
    exhausted: false,
    exhaustedBy: [],
    timedOut: false,
    usage: { inputTokens: 10, outputTokens: 5 },
    wallMs: 42,
    toolOutputBytes: 100,
    toolCallErrors: 0,
    citations: {
      sources: [{ path: 'a.txt', line: 1, verified: true }],
      verifiedCount: 1,
      unverifiedCount: 0,
      summaryLine: 'Sources: 1 verified',
    },
    ...overrides,
  }
}

/** Captures everything runEval writes/records, for assertions. */
function buildIo(argv: string[], overrides: Partial<EvalIo> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const files = new Map<string, string>()
  const calls: EvalRunInput[] = []

  const io: EvalIo = {
    argv,
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    writeResultFile: (path, content) => files.set(path, content),
    now: () => new Date('2026-08-28T12-00-00'.replace(/-(\d\d)-(\d\d)$/, ':$1:$2') + 'Z'),
    runQuestion: async (input) => {
      calls.push(input)
      return fakeRunResult()
    },
    ...overrides,
  }

  return { io, stdout, stderr, files, calls }
}

describe('runEval — flags', () => {
  it('--help exits 0 and prints usage to stdout', async () => {
    const { io, stdout } = buildIo(['--help'])
    const code = await runEval(io)

    expect(code).toBe(0)
    expect(stdout.join('')).toContain('--models')
    expect(stdout.join('')).toContain('--dry-run')
  })

  it('an unknown flag exits 2 with a one-line JSON BAD_ARGS on stderr', async () => {
    const { io, stderr } = buildIo(['--models', 'a', '--nonsense'])
    const code = await runEval(io)

    expect(code).toBe(2)
    const parsed = JSON.parse(stderr.join('').trim())
    expect(parsed.error).toBe('BAD_ARGS')
    expect(parsed.message).toContain('--nonsense')
  })

  it('missing --models exits 2 with a message saying a model id is required and there is no default', async () => {
    const { io, stderr } = buildIo([])
    const code = await runEval(io)

    expect(code).toBe(2)
    const parsed = JSON.parse(stderr.join('').trim())
    expect(parsed.error).toBe('BAD_ARGS')
    expect(parsed.message.toLowerCase()).toMatch(/model id is required/)
    expect(parsed.message.toLowerCase()).toMatch(/no default/)
  })
})

describe('runEval — question-file validation', () => {
  it('rejects a duplicate question id, naming it', async () => {
    withTempDir((dir) => {
      writeQuestionFile(dir, basicQuestionFile({ questions: [
        { id: 'dup', question: 'A?' },
        { id: 'dup', question: 'B?' },
      ] }))
      return dir
    })

    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [
        { id: 'dup', question: 'A?' },
        { id: 'dup', question: 'B?' },
      ] }))
      const { io, stderr } = buildIo(['--models', 'a', '--questions', path, '--repo', fixtureRepo])
      const code = await runEval(io)

      expect(code).toBe(2)
      const parsed = JSON.parse(stderr.join('').trim())
      expect(parsed.error).toBe('BAD_ARGS')
      expect(parsed.message).toContain('dup')
    })
  })

  it('rejects a question missing "question", naming its id', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'no-question' }] }))
      const { io, stderr } = buildIo(['--models', 'a', '--questions', path, '--repo', fixtureRepo])
      const code = await runEval(io)

      expect(code).toBe(2)
      const parsed = JSON.parse(stderr.join('').trim())
      expect(parsed.message).toContain('no-question')
    })
  })

  it('rejects an invalid budget preset, naming the question id', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(
        dir,
        basicQuestionFile({ questions: [{ id: 'bad-budget', question: 'A?', budget: 'extreme' }] }),
      )
      const { io, stderr } = buildIo(['--models', 'a', '--questions', path, '--repo', fixtureRepo])
      const code = await runEval(io)

      expect(code).toBe(2)
      const parsed = JSON.parse(stderr.join('').trim())
      expect(parsed.message).toContain('bad-budget')
    })
  })

  it('rejects an uncompilable expect.mustMatch regex, naming the question id', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(
        dir,
        basicQuestionFile({
          questions: [
            {
              id: 'bad-regex',
              question: 'A?',
              expect: { fact: 'x', mustMatch: ['(unclosed'] },
            },
          ],
        }),
      )
      const { io, stderr } = buildIo(['--models', 'a', '--questions', path, '--repo', fixtureRepo])
      const code = await runEval(io)

      expect(code).toBe(2)
      const parsed = JSON.parse(stderr.join('').trim())
      expect(parsed.message).toContain('bad-regex')
    })
  })
})

describe('runEval — scheduling', () => {
  it('calls runQuestion in model-major, then question-major, then run order, with the right temperature per run', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile())
      const { io, calls } = buildIo([
        '--models',
        'model-a,model-b',
        '--questions',
        path,
        '--repo',
        fixtureRepo,
        '--temperatures',
        '0,0,0.5',
      ])
      const code = await runEval(io)

      expect(code).toBe(0)
      expect(calls).toHaveLength(12)

      const order = calls.map((call) => `${call.config.model}:${call.question.id}:${call.temperature}`)
      expect(order).toEqual([
        'model-a:q1:0',
        'model-a:q1:0',
        'model-a:q1:0.5',
        'model-a:q2:0',
        'model-a:q2:0',
        'model-a:q2:0.5',
        'model-b:q1:0',
        'model-b:q1:0',
        'model-b:q1:0.5',
        'model-b:q2:0',
        'model-b:q2:0',
        'model-b:q2:0.5',
      ])
    })
  })

  it('--runs 5 with --temperatures 0,0.5 cycles to [0, 0.5, 0, 0.5, 0]', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }] }))
      const { io, calls } = buildIo([
        '--models',
        'model-a',
        '--questions',
        path,
        '--repo',
        fixtureRepo,
        '--temperatures',
        '0,0.5',
        '--runs',
        '5',
      ])
      const code = await runEval(io)

      expect(code).toBe(0)
      expect(calls.map((call) => call.temperature)).toEqual([0, 0.5, 0, 0.5, 0])
    })
  })
})

describe('runEval — budget resolution', () => {
  it("a question's own budget overrides --budget; a question without one gets --budget's value", async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(
        dir,
        basicQuestionFile({
          questions: [
            { id: 'has-budget', question: 'A?', budget: 'deep' },
            { id: 'no-budget', question: 'B?' },
          ],
        }),
      )
      const { io, calls } = buildIo([
        '--models',
        'model-a',
        '--questions',
        path,
        '--repo',
        fixtureRepo,
        '--budget',
        'quick',
        '--temperatures',
        '0',
      ])
      const code = await runEval(io)

      expect(code).toBe(0)
      const byId = Object.fromEntries(calls.map((call) => [call.question.id, call.budget]))
      expect(byId['has-budget']).toBe('deep')
      expect(byId['no-budget']).toBe('quick')
    })
  })
})

describe('runEval — question path scoping', () => {
  it("a question's path scopes that run to the subdirectory", async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'sub-q', question: 'A?', path: 'sub' }] }))
      const { io, calls } = buildIo(['--models', 'model-a', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'])
      const code = await runEval(io)

      expect(code).toBe(0)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.scopeRoot).toBe(join(fixtureRepo, 'sub'))
    })
  })
})

describe('runEval — auto-grading', () => {
  it('grades pass when every mustMatch regex matches (case-insensitively), fail when one misses, null with no expect', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(
        dir,
        basicQuestionFile({
          questions: [
            { id: 'will-pass', question: 'A?', expect: { fact: 'x', mustMatch: ['ANSWER', 'a\\.txt:1'] } },
            { id: 'will-fail', question: 'B?', expect: { fact: 'y', mustMatch: ['nope-not-here'] } },
            { id: 'no-expect', question: 'C?' },
          ],
        }),
      )
      const { io, files } = buildIo([
        '--models',
        'model-a',
        '--questions',
        path,
        '--repo',
        fixtureRepo,
        '--temperatures',
        '0',
      ])
      const code = await runEval(io)
      expect(code).toBe(0)

      const modelFile = [...files.entries()].find(([filePath]) => filePath.endsWith('model-a.json'))
      expect(modelFile).toBeDefined()
      const parsed = JSON.parse(modelFile![1])
      const grades = Object.fromEntries(
        (parsed.runs as Array<{ questionId: string; autoGrade: string | null }>).map((run) => [run.questionId, run.autoGrade]),
      )
      expect(grades['will-pass']).toBe('pass')
      expect(grades['will-fail']).toBe('fail')
      expect(grades['no-expect']).toBeNull()
    })
  })
})

describe('runEval — error handling', () => {
  it('a run that throws is recorded ok:false with the error code, the eval continues, and the exit code is 1', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }, { id: 'q2', question: 'B?' }] }))
      let call = 0
      const { io, files } = buildIo(
        ['--models', 'model-a', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'],
        {
          runQuestion: async () => {
            call += 1
            if (call === 1) {
              const { ScoutlingError } = await import('../src/errors.js')
              throw new ScoutlingError('TIMEOUT', 'took too long')
            }
            return fakeRunResult()
          },
        },
      )
      const code = await runEval(io)

      expect(code).toBe(1)
      expect(call).toBe(2) // the eval continued to q2 after q1's failure

      const modelFile = [...files.entries()].find(([filePath]) => filePath.endsWith('model-a.json'))
      const parsed = JSON.parse(modelFile![1])
      const q1 = parsed.runs.find((run: { questionId: string }) => run.questionId === 'q1')
      expect(q1.ok).toBe(false)
      expect(q1.error.code).toBe('TIMEOUT')
      expect(q1.stepsUsed).toBe(0)
      expect(q1.answer).toBe('')
    })
  })

  it('a PROVIDER_UNREACHABLE error aborts immediately: runQuestion is not called again, exit 3, and collected results are written', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(
        dir,
        basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }, { id: 'q2', question: 'B?' }] }),
      )
      let call = 0
      const { io, files } = buildIo(
        ['--models', 'model-a,model-b', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'],
        {
          runQuestion: async () => {
            call += 1
            if (call === 2) {
              const { ScoutlingError } = await import('../src/errors.js')
              throw new ScoutlingError('PROVIDER_UNREACHABLE', 'unreachable')
            }
            return fakeRunResult()
          },
        },
      )
      const code = await runEval(io)

      expect(code).toBe(3)
      expect(call).toBe(2) // never reached model-b, or q2's second call

      // model-a's file was still written, with the one successful run collected before the abort.
      const modelAFile = [...files.entries()].find(([filePath]) => filePath.endsWith('model-a.json'))
      expect(modelAFile).toBeDefined()
      const parsed = JSON.parse(modelAFile![1])
      expect(parsed.runs).toHaveLength(1)
      expect(parsed.runs[0].questionId).toBe('q1')

      // model-b was never started.
      const modelBFile = [...files.entries()].find(([filePath]) => filePath.endsWith('model-b.json'))
      expect(modelBFile).toBeUndefined()
    })
  })
})

describe('runEval — output files', () => {
  it('filenames are deterministic given the injected now(), and a model id containing "/" is slugged', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }] }))
      const { io, files } = buildIo([
        '--models',
        'qwen/qwen3-coder-next',
        '--questions',
        path,
        '--repo',
        fixtureRepo,
        '--temperatures',
        '0',
        '--out-dir',
        join(dir, 'results'),
      ])
      const code = await runEval(io)

      expect(code).toBe(0)
      const paths = [...files.keys()]
      expect(paths).toContain(join(dir, 'results', '2026-08-28T12-00-00Z-qwen-qwen3-coder-next.json'))
      expect(paths).toContain(join(dir, 'results', '2026-08-28T12-00-00Z-summary.md'))
    })
  })

  it("the summary markdown's correct? column is empty on every row, including auto-graded ones", async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(
        dir,
        basicQuestionFile({
          questions: [{ id: 'q1', question: 'A?', expect: { fact: 'x', mustMatch: ['answer'] } }],
        }),
      )
      const { io, files } = buildIo(['--models', 'model-a', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'])
      const code = await runEval(io)
      expect(code).toBe(0)

      const summary = [...files.entries()].find(([filePath]) => filePath.endsWith('summary.md'))
      expect(summary).toBeDefined()
      const content = summary![1]
      const runRow = content.split('\n').find((line) => line.startsWith('| q1 |'))
      expect(runRow).toBeDefined()
      // The row's last cell (correct?) is empty: the row ends "| |" (the auto
      // column's value, then an empty correct? cell, then the row-closing pipe).
      expect(runRow?.trim().endsWith('| |')).toBe(true)
    })
  })
})

describe('runEval — exhaustedBy', () => {
  it('exhaustedBy reaches the written EvalRunRecord verbatim from the RunResult', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }] }))
      const { io, files } = buildIo(
        ['--models', 'model-a', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'],
        {
          runQuestion: async () => fakeRunResult({ exhausted: true, exhaustedBy: ['steps', 'bytes'] }),
        },
      )
      const code = await runEval(io)
      expect(code).toBe(0)

      const modelFile = [...files.entries()].find(([filePath]) => filePath.endsWith('model-a.json'))
      expect(modelFile).toBeDefined()
      const parsed = JSON.parse(modelFile![1])
      const q1 = parsed.runs.find((run: { questionId: string }) => run.questionId === 'q1')
      expect(q1.exhaustedBy.sort()).toEqual(['bytes', 'steps'])
    })
  })

  it("the per-run markdown table renders which cap(s) fired as e.g. 'steps+bytes'", async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }] }))
      const { io, files } = buildIo(
        ['--models', 'model-a', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'],
        {
          runQuestion: async () => fakeRunResult({ exhausted: true, exhaustedBy: ['steps', 'bytes'] }),
        },
      )
      const code = await runEval(io)
      expect(code).toBe(0)

      const summary = [...files.entries()].find(([filePath]) => filePath.endsWith('summary.md'))
      expect(summary).toBeDefined()
      const runRow = summary![1].split('\n').find((line) => line.startsWith('| q1 |'))
      expect(runRow).toBeDefined()
      // "exhausted" (true) immediately followed by the "exhausted by" column.
      expect(runRow).toContain('| true | steps+bytes |')
    })
  })

  it('the per-model summary table counts runs per cap correctly across a mix of exhaustedBy combinations', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(
        dir,
        basicQuestionFile({
          questions: [
            { id: 'q1', question: 'A?' },
            { id: 'q2', question: 'B?' },
          ],
        }),
      )
      const { io, files } = buildIo(
        ['--models', 'model-a', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'],
        {
          runQuestion: async (input) => {
            if (input.question.id === 'q1') {
              return fakeRunResult({ exhausted: true, exhaustedBy: ['steps'] })
            }
            // q2: both steps and bytes fired.
            return fakeRunResult({ exhausted: true, exhaustedBy: ['steps', 'bytes'] })
          },
        },
      )
      const code = await runEval(io)
      expect(code).toBe(0)

      const summary = [...files.entries()].find(([filePath]) => filePath.endsWith('summary.md'))
      expect(summary).toBeDefined()
      const modelRow = summary![1].split('\n').find((line) => line.startsWith('| model-a |'))
      expect(modelRow).toBeDefined()

      const cells = modelRow!.split('|').map((cell) => cell.trim())
      // | model | runs | errors | auto pass/total | mean steps | mean bytes | mean wallMs | exhausted | exhausted: steps | exhausted: bytes | exhausted: timeout |
      expect(cells[9]).toBe('2') // both q1 and q2 hit steps
      expect(cells[10]).toBe('1') // only q2 hit bytes
      expect(cells[11]).toBe('0') // neither hit timeout
    })
  })
})

describe('runEval — questions-file self-exclusion', () => {
  // These questions live at the repo root the eval is investigating (see
  // eval/questions.example.json's own doc comment): "the eval's question
  // file contains the answers" (task brief) is not a hypothetical — an
  // auto-graded question's expect.fact literally states the fact under test,
  // so a model that can grep the question file itself would "pass" without
  // investigating anything. This whole block proves the automatic exclusion
  // that prevents that, per the frozen contract in the task brief.

  it('a questions file inside --repo is added to excludeGlobs (repo-relative, POSIX) and warns once on stderr', async () => {
    await withTempDir(async (dir) => {
      // dir is both --repo and where the question file lives, so its
      // repo-relative path is just the bare filename.
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }] }))
      const { io, calls, stderr } = buildIo(['--models', 'model-a', '--questions', path, '--repo', dir, '--temperatures', '0'])
      const code = await runEval(io)

      expect(code).toBe(0)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.config.excludeGlobs).toContain('questions.json')

      const warnings = stderr.filter((line) => line.includes('QUESTIONS_FILE_EXCLUDED'))
      expect(warnings).toHaveLength(1)
      const parsed = JSON.parse(warnings[0]!.trim())
      expect(parsed.warning).toBe('QUESTIONS_FILE_EXCLUDED')
      expect(parsed.message).toContain('questions.json')
    })
  })

  it('a questions file outside --repo leaves excludeGlobs unchanged and emits no warning', async () => {
    await withTempDir(async (dir) => {
      // The existing fixture setup already has this shape: the question file
      // lives in a temp dir, --repo is the separate fixtures/scope tree.
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }] }))
      const { io, calls, stderr } = buildIo(['--models', 'model-a', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'])
      const code = await runEval(io)

      expect(code).toBe(0)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.config.excludeGlobs).not.toContain('questions.json')
      expect(calls[0]?.config.excludeGlobs).toEqual(
        expect.not.arrayContaining([expect.stringContaining('questions.json')]),
      )

      expect(stderr.some((line) => line.includes('QUESTIONS_FILE_EXCLUDED'))).toBe(false)
    })
  })

  it('the appended exclusion survives alongside a config-supplied excludeGlobs, rather than replacing it', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, 'scoutling.config.json'), JSON.stringify({ excludeGlobs: ['custom/**'] }))
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'A?' }] }))
      const { io, calls } = buildIo(['--models', 'model-a', '--questions', path, '--repo', dir, '--temperatures', '0'])
      const code = await runEval(io)

      expect(code).toBe(0)
      expect(calls[0]?.config.excludeGlobs).toContain('custom/**')
      expect(calls[0]?.config.excludeGlobs).toContain('questions.json')
    })
  })
})

describe('toPosixExcludeGlob', () => {
  it('converts Windows-style backslash separators to POSIX forward slashes', () => {
    expect(toPosixExcludeGlob('sub\\dir\\questions.json')).toBe('sub/dir/questions.json')
  })

  it('leaves an already-POSIX relative path unchanged', () => {
    expect(toPosixExcludeGlob('docs/scoutling-eval.json')).toBe('docs/scoutling-eval.json')
  })
})

describe('runEval — dry run', () => {
  it('--dry-run calls runQuestion zero times and exits 0', async () => {
    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile())
      const { io, calls, stdout } = buildIo([
        '--models',
        'model-a,model-b',
        '--questions',
        path,
        '--repo',
        fixtureRepo,
        '--dry-run',
      ])
      const code = await runEval(io)

      expect(code).toBe(0)
      expect(calls).toHaveLength(0)
      expect(stdout.join('')).toContain('model-a')
      expect(stdout.join('')).toContain('total run')
    })
  })
})

describe('runEval — default wiring (no runQuestion injection)', () => {
  it('runs the real default wiring against a fixture scope with a fetch-mocked model', async () => {
    // No `runQuestion` override: this exercises buildRunInputs + runScoutling
    // for real. The only injection is `fetch`, mirroring how src/cli.ts's own
    // tests prove the real wiring (see test/cli.test.ts) — a plain OpenAI
    // chat-completion response with finish_reason 'stop' and no tool calls,
    // so the run finishes in one step without ever needing a real endpoint.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: 'chat-1',
          object: 'chat.completion',
          created: 0,
          model: 'a-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'The file says hello (a.txt:1).' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    await withTempDir(async (dir) => {
      const path = writeQuestionFile(dir, basicQuestionFile({ questions: [{ id: 'q1', question: 'What does a.txt say?' }] }))
      const { io, files } = buildIo(
        ['--models', 'a-model', '--questions', path, '--repo', fixtureRepo, '--temperatures', '0'],
        { runQuestion: undefined, fetch: fetchImpl },
      )
      const code = await runEval(io)

      expect(code).toBe(0)
      const modelFile = [...files.entries()].find(([filePath]) => filePath.endsWith('a-model.json'))
      expect(modelFile).toBeDefined()
      const parsed = JSON.parse(modelFile![1])
      expect(parsed.runs).toHaveLength(1)
      expect(parsed.runs[0].ok).toBe(true)
      expect(parsed.runs[0].answer).toContain('hello')
      expect(parsed.runs[0].sources).toContainEqual({ path: 'a.txt', line: 1, verified: true })
    })
  })
})
