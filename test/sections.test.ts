import { describe, expect, it } from 'vitest'

import { splitSections } from '../src/sections.js'

describe('splitSections', () => {
  it('returns an empty array for a blank answer', () => {
    expect(splitSections('')).toEqual([])
    expect(splitSections('   \n  \n')).toEqual([])
  })

  it('returns one section, index 1, empty heading, for an answer with no numbered heading', () => {
    expect(splitSections('Just a plain answer with no headings at all.')).toEqual([
      { index: 1, heading: '', answer: 'Just a plain answer with no headings at all.' },
    ])
  })

  it('trims the whole-answer fallback section', () => {
    expect(splitSections('\n\n  Plain answer.  \n\n')).toEqual([
      { index: 1, heading: '', answer: 'Plain answer.' },
    ])
  })

  it('splits on markdown headings whose text starts with a number', () => {
    const answer = ['## 1. Does the retry policy exist?', 'Yes, see retry.ts:5.', '', '## 2. Where is it configured?', 'In config.ts:9.'].join('\n')

    expect(splitSections(answer)).toEqual([
      { index: 1, heading: 'Does the retry policy exist?', answer: 'Yes, see retry.ts:5.' },
      { index: 2, heading: 'Where is it configured?', answer: 'In config.ts:9.' },
    ])
  })

  it('splits on bold-line headings of the same shape', () => {
    const answer = ['**1. First item**', 'Answer one.', '**2. Second item**', 'Answer two.'].join('\n')

    expect(splitSections(answer)).toEqual([
      { index: 1, heading: 'First item', answer: 'Answer one.' },
      { index: 2, heading: 'Second item', answer: 'Answer two.' },
    ])
  })

  it('accepts ")" and ":" as the punctuation after the number, not just "."', () => {
    expect(splitSections('## 1) First\nBody one.\n## 2: Second\nBody two.')).toEqual([
      { index: 1, heading: 'First', answer: 'Body one.' },
      { index: 2, heading: 'Second', answer: 'Body two.' },
    ])
  })

  it('accepts heading levels 1 through 6', () => {
    expect(splitSections('###### 1. Deep heading\nBody.')).toEqual([
      { index: 1, heading: 'Deep heading', answer: 'Body.' },
    ])
  })

  it('keeps text before the first heading as an index-0 section when non-blank', () => {
    const answer = ['A short preamble before any item.', '', '## 1. First item', 'Body one.'].join('\n')

    expect(splitSections(answer)).toEqual([
      { index: 0, heading: '', answer: 'A short preamble before any item.' },
      { index: 1, heading: 'First item', answer: 'Body one.' },
    ])
  })

  it('drops a blank preamble rather than emitting an empty index-0 section', () => {
    const answer = ['', '   ', '## 1. First item', 'Body one.'].join('\n')

    expect(splitSections(answer)).toEqual([{ index: 1, heading: 'First item', answer: 'Body one.' }])
  })

  it('attaches all trailing text after the last heading to the last section', () => {
    const answer = ['## 1. Only item', 'Line one.', 'Line two.', '', 'Line three, still item 1.'].join('\n')

    expect(splitSections(answer)).toEqual([
      { index: 1, heading: 'Only item', answer: 'Line one.\nLine two.\n\nLine three, still item 1.' },
    ])
  })

  it('keeps numbers exactly as written and in document order, even out of numeric order', () => {
    const answer = ['## 1. First', 'A.', '## 3. Third', 'B.', '## 2. Second', 'C.'].join('\n')

    expect(splitSections(answer).map((s) => s.index)).toEqual([1, 3, 2])
  })

  it('keeps duplicate-numbered headings as separate sections, not merged', () => {
    const answer = ['## 1. First pass', 'A.', '## 1. Second pass', 'B.'].join('\n')

    expect(splitSections(answer)).toEqual([
      { index: 1, heading: 'First pass', answer: 'A.' },
      { index: 1, heading: 'Second pass', answer: 'B.' },
    ])
  })

  it('does not split on a numbered-heading-shaped fragment that is not at the start of a line', () => {
    const answer = 'Note: something like ## 2. Foo appears mid-sentence here, not as a heading.'

    expect(splitSections(answer)).toEqual([{ index: 1, heading: '', answer }])
  })

  it('strips a trailing "**" or "#" run from the heading title', () => {
    expect(splitSections('## 1. Title with trailing hashes ##\nBody.')).toEqual([
      { index: 1, heading: 'Title with trailing hashes', answer: 'Body.' },
    ])
  })

  it('handles a heading with no title text after the number', () => {
    expect(splitSections('## 1.\nBody with nothing else on the heading line.')).toEqual([
      { index: 1, heading: '', answer: 'Body with nothing else on the heading line.' },
    ])
  })

  it('gives a section with nothing to report an empty (not missing) answer body', () => {
    const answer = ['## 1. Nonexistent feature', 'Not found within budget.'].join('\n')

    expect(splitSections(answer)).toEqual([
      { index: 1, heading: 'Nonexistent feature', answer: 'Not found within budget.' },
    ])
  })

  describe('nested numbered sub-headings (live-run defect)', () => {
    // Real defect: a five-item brief answered with `## 1. ...` top-level items and `### 1a. ...`
    // / `### 1b. ...` numbered sub-headings nested inside them. The old line-by-line matcher
    // treated every `### 1a.` line as a fresh top-level section (its ATX regex captures the
    // leading digit and leaves "a. ..." as the heading text), so item 1's own section came back
    // with an empty `answer` and its real content was scattered across sibling sections that were
    // all mis-numbered `1`. The caller grading item 1 got nothing.

    it('treats a deeper-level numbered sub-heading as body text of the enclosing section, not a new one', () => {
      const answer = [
        'Investigating the five items below.',
        '',
        '## 1. A',
        '### 1a. x',
        'Details for x.',
        '### 1b. y',
        'Details for y.',
        '',
        '## 2. B',
        'Body two.',
        '',
        '## 3. C',
        '### Path A: an un-numbered sub-heading',
        'Details for path A.',
      ].join('\n')

      const sections = splitSections(answer)

      expect(sections.map((s) => s.index)).toEqual([0, 1, 2, 3])
      expect(sections[0]).toEqual({ index: 0, heading: '', answer: 'Investigating the five items below.' })
      expect(sections[1]?.heading).toBe('A')
      expect(sections[1]?.answer).toContain('### 1a. x')
      expect(sections[1]?.answer).toContain('Details for x.')
      expect(sections[1]?.answer).toContain('### 1b. y')
      expect(sections[1]?.answer).toContain('Details for y.')
      expect(sections[2]).toEqual({ index: 2, heading: 'B', answer: 'Body two.' })
      expect(sections[3]?.heading).toBe('C')
      expect(sections[3]?.answer).toContain('### Path A: an un-numbered sub-heading')
      expect(sections[3]?.answer).toContain('Details for path A.')
    })

    it('uses ### as the boundary level when it is the only numbered-heading level present', () => {
      const answer = ['### 1. First', 'Body one.', '### 2. Second', 'Body two.', '### 3. Third', 'Body three.'].join(
        '\n',
      )

      expect(splitSections(answer)).toEqual([
        { index: 1, heading: 'First', answer: 'Body one.' },
        { index: 2, heading: 'Second', answer: 'Body two.' },
        { index: 3, heading: 'Third', answer: 'Body three.' },
      ])
    })

    it('keeps a bold numbered line nested inside an ATX section when ATX headings are shallower', () => {
      const answer = ['## 1. First', 'Body one.', '## 2. Second', '**3. Title**', 'Nested bold aside.'].join('\n')

      const sections = splitSections(answer)

      expect(sections.map((s) => s.index)).toEqual([1, 2])
      expect(sections[1]?.answer).toContain('**3. Title**')
      expect(sections[1]?.answer).toContain('Nested bold aside.')
    })

    it('still treats bold numbered lines as boundaries when no ATX numbered heading exists', () => {
      const answer = ['**1. First**', 'Body one.', '**2. Second**', 'Body two.'].join('\n')

      expect(splitSections(answer)).toEqual([
        { index: 1, heading: 'First', answer: 'Body one.' },
        { index: 2, heading: 'Second', answer: 'Body two.' },
      ])
    })
  })
})
