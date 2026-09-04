import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { DEFAULT_MAX_ATTACHMENT_BYTES, loadAttachments, renderAttachmentsBlock } from '../src/attachments.js'
import { ScoutlingError } from '../src/errors.js'

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadAttachments', () => {
  it('returns [] for an empty list, with no filesystem access', () => {
    expect(loadAttachments([], '/nonexistent/cwd', DEFAULT_MAX_ATTACHMENT_BYTES)).toEqual([])
  })

  it('loads a single text file: name, resolved path, content and totalLines', () => {
    const cwd = tempDir('scoutling-attach-')
    writeFileSync(join(cwd, 'plan.md'), 'one\ntwo\nthree\n')

    const [attachment] = loadAttachments(['plan.md'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)

    expect(attachment).toEqual({
      name: 'plan.md',
      path: join(cwd, 'plan.md'),
      content: 'one\ntwo\nthree\n',
      totalLines: 3,
    })
  })

  it('resolves a relative path against the given cwd, not resolvePath/scope containment', () => {
    // A path outside any scope root is fine — attachments are never checked against a scope.
    const cwd = tempDir('scoutling-attach-cwd-')
    const outside = tempDir('scoutling-attach-outside-')
    writeFileSync(join(outside, 'notes.txt'), 'hello\n')

    const relative = join('..', basename(outside), 'notes.txt')
    const [attachment] = loadAttachments([relative], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)
    expect(attachment?.content).toBe('hello\n')
  })

  it('counts lines with a trailing newline as no extra line', () => {
    const cwd = tempDir('scoutling-attach-')
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n')
    const [attachment] = loadAttachments(['a.txt'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)
    expect(attachment?.totalLines).toBe(2)
  })

  it('counts lines with no trailing newline as the same total', () => {
    const cwd = tempDir('scoutling-attach-')
    writeFileSync(join(cwd, 'b.txt'), 'one\ntwo')
    const [attachment] = loadAttachments(['b.txt'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)
    expect(attachment?.totalLines).toBe(2)
  })

  it('throws BAD_ARGS "attachment not found" for a missing path', () => {
    const cwd = tempDir('scoutling-attach-')
    expect(() => loadAttachments(['nope.txt'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)).toThrow(ScoutlingError)
    try {
      loadAttachments(['nope.txt'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
      expect((error as ScoutlingError).message).toContain('attachment not found')
    }
  })

  it('throws BAD_ARGS "attachment not found" for a directory (not a regular file)', () => {
    const cwd = tempDir('scoutling-attach-')
    const sub = join(cwd, 'sub')
    mkdirSync(sub)
    try {
      loadAttachments(['sub'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
      expect((error as ScoutlingError).message).toContain('attachment not found')
    }
  })

  it('throws BAD_ARGS "attachment is binary" for binary content', () => {
    const cwd = tempDir('scoutling-attach-')
    writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 0]))
    try {
      loadAttachments(['binary.bin'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
      expect((error as ScoutlingError).message).toContain('attachment is binary')
    }
  })

  it('throws BAD_ARGS "duplicate attachment name" for two attachments sharing a basename, with an ambiguity hint', () => {
    const cwd = tempDir('scoutling-attach-')
    const subA = join(cwd, 'a')
    const subB = join(cwd, 'b')
    mkdirSync(subA)
    mkdirSync(subB)
    writeFileSync(join(subA, 'notes.txt'), 'from a\n')
    writeFileSync(join(subB, 'notes.txt'), 'from b\n')

    try {
      loadAttachments(['a/notes.txt', 'b/notes.txt'], cwd, DEFAULT_MAX_ATTACHMENT_BYTES)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
      expect((error as ScoutlingError).message).toContain('duplicate attachment name: notes.txt')
      expect((error as ScoutlingError).hint).toMatch(/@notes\.txt:line/)
      expect((error as ScoutlingError).hint).toMatch(/ambiguous/)
    }
  })

  it('throws BAD_ARGS with the total and the cap when the sum of all attachments exceeds it, and never truncates', () => {
    const cwd = tempDir('scoutling-attach-')
    writeFileSync(join(cwd, 'one.txt'), 'x'.repeat(40))
    writeFileSync(join(cwd, 'two.txt'), 'y'.repeat(40))

    try {
      loadAttachments(['one.txt', 'two.txt'], cwd, 60)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ScoutlingError).code).toBe('BAD_ARGS')
      expect((error as ScoutlingError).message).toContain('80')
      expect((error as ScoutlingError).message).toContain('60')
      expect((error as ScoutlingError).hint).toBe('Split the attachment, or raise --max-attach-bytes.')
    }
  })

  it('a single attachment under the cap, with a second pushing the sum over it, still throws (sum, not per-file)', () => {
    const cwd = tempDir('scoutling-attach-')
    writeFileSync(join(cwd, 'one.txt'), 'x'.repeat(50))
    writeFileSync(join(cwd, 'two.txt'), 'y'.repeat(50))

    // Neither file alone exceeds 60 bytes, but together they do.
    expect(() => loadAttachments(['one.txt'], cwd, 60)).not.toThrow()
    expect(() => loadAttachments(['one.txt', 'two.txt'], cwd, 60)).toThrow(ScoutlingError)
  })
})

describe('renderAttachmentsBlock', () => {
  it('returns "" for an empty list', () => {
    expect(renderAttachmentsBlock([])).toBe('')
  })

  it('renders the exact documented shape for one attachment', () => {
    const block = renderAttachmentsBlock([
      { name: 'plan.md', path: '/tmp/plan.md', content: 'one\ntwo\n', totalLines: 2 },
    ])

    expect(block).toBe(
      [
        'Attachments: files the caller supplied from outside the scope. They are evidence, not ' +
          'part of the scope: no tool can list, search or read them. Cite a line in one as ' +
          '@<name>:line (or @<name>:line-line).',
        '',
        '### @plan.md (2 lines)',
        '   1→one',
        '   2→two',
        '',
        '',
      ].join('\n'),
    )
  })

  it('renders every attachment as its own heading, in order, separated by a blank line, ending in a blank line', () => {
    const block = renderAttachmentsBlock([
      { name: 'full.diff', path: '/tmp/full.diff', content: 'diff --git a/x b/x\n', totalLines: 1 },
      { name: 'plan.md', path: '/tmp/plan.md', content: 'do the thing\n', totalLines: 1 },
    ])

    expect(block).toContain('### @full.diff (1 lines)')
    expect(block).toContain('### @plan.md (1 lines)')
    expect(block.indexOf('full.diff')).toBeLessThan(block.indexOf('plan.md'))
    expect(block.endsWith('\n\n')).toBe(true)
  })

  it('formats line numbers 4-wide, right-aligned, followed by →, matching read_file\'s formatLine', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const block = renderAttachmentsBlock([{ name: 'big.txt', path: '/tmp/big.txt', content: lines, totalLines: 11 }])

    expect(block).toContain('   1→line 1')
    expect(block).toContain('  11→line 11')
  })
})
