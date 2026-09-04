/**
 * DESIGN.md §8 (brief mode): a real investigation brief is rarely one question — the
 * `docs/subagent-census.md` survey found 70% of them bundle three to eight numbered items and
 * expect the answer sectioned the same way. `builtInPrompt` (`prompt.ts`) asks the model to
 * answer that shape under one numbered heading per item; this module is the part that turns the
 * model's prose back into structured sections so a caller does not have to re-parse markdown
 * headings itself, and so `citations.ts` can attribute each cited source to the item that made
 * the claim rather than only to the answer as a whole.
 *
 * Pure text in, structured data out — no filesystem, no model call, nothing that can fail. A
 * small local model is erratic about exactly which markdown syntax it reaches for on a given
 * run, so two heading shapes are recognized rather than one: an ATX heading (`## 1. Title`) and a
 * bold line (`**1. Title**`) that plays the same role when the model skips heading syntax
 * entirely. Both require the number to be the very first thing after the marker — a numbered
 * heading mid-sentence ("see item ## 2 below") is prose, not a section boundary.
 *
 * **Section boundaries are only the numbered headings at the shallowest level present.** A real
 * five-item brief came back with `## 1. ...`-`## 5. ...` top-level items, each internally broken
 * into `### 1a. ...` / `### 1b. ...` numbered sub-headings (and, under item 5, un-numbered
 * `### Path A: ...` sub-headings). Matching every numbered heading regardless of depth split each
 * `### 1a.` line into its own top-level section — the ATX regex captures the leading digit and
 * leaves "a. ..." as the heading text, so item 1's own section came back with an *empty* `answer`
 * while its real content was scattered across sibling sections all mis-numbered `1`. The caller
 * grading item 1 got nothing. So a heading only starts a new section when its level (ATX `#`
 * count, 1-6; a bold line counts as level 7, deeper than any ATX heading) equals the minimum
 * level among every numbered heading found in the answer. Every heading strictly deeper than that
 * — numbered or not — is ordinary text and stays inside the enclosing section's `answer`,
 * verbatim, so a sub-heading and its citations are attributed to the item it is nested under.
 */
export interface AnswerSection {
  /** The number the model put on the heading; 0 for text before the first numbered heading. */
  index: number
  /** Heading text with the number and markdown syntax stripped; '' when there was no heading. */
  heading: string
  /** The section's own text, heading line excluded, trimmed. */
  answer: string
}

// Anchored per-line (not with the multiline flag): each candidate line is matched on its own via
// `.exec`, so `^`/`$` naturally mean "the whole of this line" without needing `m`. That is also
// why a heading-shaped fragment that merely appears somewhere inside a longer line never matches
// — it is never tested against the regex as a lone line to begin with.
const ATX_HEADING_RE = /^(#{1,6})\s+(\d+)[.):]?\s*(.*)$/
const BOLD_HEADING_RE = /^\*\*(\d+)[.):]?\s*(.*?)\*\*\s*$/

/** A bold numbered line has no heading-level markup of its own, so it is treated as deeper than every possible ATX level (1-6) — an aside nested under an ATX item stays nested, while a bold-only brief (no ATX heading anywhere) still gets boundaries, since level 7 is then the minimum level present. */
const BOLD_HEADING_LEVEL = 7

interface HeadingMatch {
  lineIndex: number
  level: number
  index: number
  heading: string
}

/** Drop the number/punctuation the heading regexes already consumed, plus any leftover run of `#`/`*` a model appended to "close" the heading (`## 1. Title ##`, `**1. Title**`-with-extra-stars) or trailing whitespace. */
function cleanHeading(rawTitle: string): string {
  return rawTitle.replace(/[\s*#]+$/, '').trim()
}

function findHeadingMatch(line: string): { level: number; index: number; heading: string } | undefined {
  const atx = ATX_HEADING_RE.exec(line)
  if (atx) {
    const level = (atx[1] ?? '').length
    return { level, index: Number(atx[2]), heading: cleanHeading(atx[3] ?? '') }
  }

  const bold = BOLD_HEADING_RE.exec(line)
  if (bold) return { level: BOLD_HEADING_LEVEL, index: Number(bold[1]), heading: cleanHeading(bold[2] ?? '') }

  return undefined
}

/**
 * Split an answer at its numbered headings. Never drops any of the model's text: everything
 * before the first section-level heading becomes an `index: 0` section (dropped only when
 * blank), everything after the last one belongs to that last section, and an answer with no
 * numbered heading at all comes back as exactly one `index: 1` section holding the whole trimmed
 * answer — so a caller can rely on `sections.length >= 1` whenever `answer.trim()` is non-blank.
 *
 * Only numbered headings at the shallowest level found in the answer are boundaries (see the
 * module doc comment); a deeper numbered or un-numbered heading is left in place as part of its
 * enclosing section's text.
 *
 * Numbers are kept exactly as the model wrote them, in document order: no sorting, no
 * de-duplicating, no renumbering. A model that answers items 1, 3, 2 gets sections in that order,
 * and a model that emits two "## 1." headings gets two separate sections — the caller is grading
 * the answer against the brief it sent, and silently normalizing either case would hide a defect
 * (a skipped item, a duplicated one) that the caller needs to see.
 */
export function splitSections(answer: string): AnswerSection[] {
  if (answer.trim().length === 0) return []

  const lines = answer.split('\n')
  const allHeadings: HeadingMatch[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = findHeadingMatch(lines[lineIndex] ?? '')
    if (match) allHeadings.push({ lineIndex, ...match })
  }

  if (allHeadings.length === 0) {
    return [{ index: 1, heading: '', answer: answer.trim() }]
  }

  const boundaryLevel = Math.min(...allHeadings.map((heading) => heading.level))
  const markers = allHeadings.filter((heading) => heading.level === boundaryLevel)

  const sections: AnswerSection[] = []

  const firstMarker = markers[0]
  if (firstMarker) {
    const preamble = lines.slice(0, firstMarker.lineIndex).join('\n').trim()
    if (preamble.length > 0) sections.push({ index: 0, heading: '', answer: preamble })
  }

  for (let m = 0; m < markers.length; m += 1) {
    const marker = markers[m]
    if (!marker) continue
    const bodyStart = marker.lineIndex + 1
    const bodyEnd = markers[m + 1]?.lineIndex ?? lines.length
    const body = lines.slice(bodyStart, bodyEnd).join('\n').trim()
    sections.push({ index: marker.index, heading: marker.heading, answer: body })
  }

  return sections
}
