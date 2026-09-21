/**
 * The loop contract — what a card needs before it can be worked unattended.
 *
 * Imported by both the browser (which pre-fills it) and the MCP tools (which
 * report what's missing), so the two can never disagree about what a complete
 * contract is.
 *
 * "Contract" rather than "brief" is deliberate, and the distinction is Phil
 * McDonald's (The Night Shift, AI Builder Day 2026): a *wish* says what you want
 * and hopes, so the agent shortcuts to "done!" with no evidence; a *design*
 * spells out the how, which caps the agent at your imagination. A contract is
 * **tight on the outcome, loose on the route.**
 *
 * That is why `Pointers` is named as such and not `Where`, and why there is no
 * `Don't` — both were route-prescription in an earlier version of this file.
 * Constraints that matter belong in `Must not break`, phrased as an outcome.
 */

export const LOOP_COLUMN = 'loop'

export const BRIEF_FIELDS = [
  {
    key: 'objective',
    label: 'Objective',
    required: false,
    hint: 'The outcome in one sentence. Intent, not implementation.',
    example:
      'A card that landed on the wrong board can be sent to the right one from its panel, and arrives in that board\'s Inbox for re-triage, with nothing lost on the way.',
  },
  {
    key: 'acceptance',
    label: 'Acceptance',
    required: true,
    hint: 'What a skeptic verifies firsthand. Could a stub pass it? Then tighten it.',
    weak: 'The move works and nothing is lost.',
    example:
      '1. In a card\'s panel on board A, choosing B in the Board dropdown closes the panel, the status line says "moved to B", the card is gone from A and sits in B\'s first column with its notes, tags, flag and attachments intact.\n2. A test fails the source write after the target write and asserts the card is on BOTH boards — a duplicate, never a loss.',
    why: 'A stub passes the weak clause by printing "moved". The strong one names what a skeptic sees on each board, and how a failure must look.',
  },
  {
    key: 'verifyWith',
    label: 'Verify with',
    required: true,
    hint: 'The exact command. Without one, "done" is a guess.',
    weak: 'Run the tests.',
    example:
      'cd board && npm test\nnode board/scripts/probe.mjs --width 390 http://localhost:7777/ "return document.querySelector(\'.column\').getBoundingClientRect().width"',
    why: 'An exact command re-runs the same way for the verifier at 2am. "Run the tests" means whatever was convenient, and skips the browser entirely.',
  },
  {
    key: 'mustNotBreak',
    label: 'Must not break',
    required: false,
    hint: 'Existing behaviour a regression would violate. Regressions fail the contract.',
    example:
      'store.js stays the only writer · offline stays read-only · the snapshot keeps its no-script property · zero dependencies · no build step',
  },
  {
    key: 'pointers',
    label: 'Pointers',
    required: false,
    hint: 'Specs and files worth reading. A map, never a design.',
    example:
      'docs/specs/2026-09-11-move-between-boards-design.md — read it first\nboard/src/store.js (readBoard, writeBoard)\nbot/test/inbox.test.js — the create-then-delete order test, for the pattern',
  },
  {
    key: 'ifBlocked',
    label: 'If blocked',
    required: false,
    hint: 'Default: escalate to Waiting on you. Never guess.',
    example:
      'Escalate to Waiting on you with the question stated plainly. Do not add an MCP tool, undo or bulk move — all ruled out of scope.',
  },
]

/**
 * The skeleton written into a card's detail when it lands in Loop.
 *
 * Deliberately hint-free: hint text placed after a colon would parse as that
 * heading's *content*, so a card would report complete while saying nothing.
 * The hints, examples and weak-versus-strong pairs live on BRIEF_FIELDS and the
 * panel renders them BESIDE the detail field (the guide under Detail), never in
 * it — decision log 2026-09-15. The test 'no guide text can manufacture a
 * heading' keeps it that way.
 */
export const LOOP_BRIEF = `${BRIEF_FIELDS.map((f) => `${f.label}:`).join('\n')}\n`

const LABELS = BRIEF_FIELDS.map((f) => f.label)
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when the detail is empty or is nothing but an untouched skeleton. */
export function isBlankBrief(detail) {
  const text = (detail ?? '').trim()
  if (!text) return true
  const stripped = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !LABELS.some((label) => line === `${label}:`))
    .join('')
  return stripped.length === 0
}

/** True when the detail already uses at least one contract heading. */
export function hasBriefHeadings(detail) {
  const text = detail ?? ''
  return LABELS.some((label) => new RegExp(`^[ \\t]*${escape(label)}[ \\t]*:`, 'mi').test(text))
}

/**
 * Reads a contract out of a detail field. Returns which required headings carry
 * content, so the pre-flight pass is mechanical rather than a judgment call.
 */
export function parseBrief(detail) {
  const text = detail ?? ''
  const values = {}

  for (const field of BRIEF_FIELDS) {
    const others = LABELS.filter((l) => l !== field.label).map(escape).join('|')
    // Everything after this label's colon, up to the next known label or the end.
    //
    // The terminator is `(?![\s\S])` — end of INPUT. A bare `$` under the `m`
    // flag means end of LINE, which stopped the lazy capture at the first
    // newline and silently truncated every multi-line heading to nothing.
    const pattern = new RegExp(
      `^[ \\t]*${escape(field.label)}[ \\t]*:` +
        `([\\s\\S]*?)(?=^[ \\t]*(?:${others})[ \\t]*:|(?![\\s\\S]))`,
      'mi',
    )
    const match = pattern.exec(text)
    values[field.key] = match ? match[1].trim() : ''
  }

  const missing = BRIEF_FIELDS.filter((f) => f.required && !values[f.key]).map((f) => f.label)
  return { values, missing, complete: missing.length === 0 }
}

/**
 * What the board should say about a card's contract, given the column it sits in.
 *
 * Null when there is nothing to say, which is most of the time. Silence is the
 * default on purpose: a badge that appears on every card stops being read, and
 * this one only earns its place by being rare.
 *
 * Deliberately a pure function of (column, detail) so the board and the MCP
 * pre-flight cannot disagree about what a complete contract is — they call the
 * same `parseBrief` underneath. Two definitions of "ready to work unattended"
 * is exactly the disagreement that costs a night.
 */
export function briefWarning(column, detail) {
  if (column !== LOOP_COLUMN) return null
  const { missing } = parseBrief(detail)
  if (!missing.length) return null
  // An untouched skeleton lands here rather than reading as complete: every
  // heading is present, none carries content, so parseBrief reports both
  // required ones missing. That is the 11pm card this exists to catch.
  return { missing, label: `needs ${missing.join(' + ')}` }
}

/**
 * The contract as fields — a form over the detail text (spec 2026-09-16).
 *
 * The detail stays the ONLY source: the parser, the verifier, the pre-flight
 * report and the snapshot all keep reading one combined text. These two are the
 * seam. `splitBrief` hands the panel the prose before the first heading and the
 * six values; `joinBrief` writes them back — canonical order, empty headings
 * omitted, a single-line value inline after the colon and a multi-line value on
 * the lines below, which is how the real cards were already written.
 *
 * Not byte-preserving for arbitrary input, and not meant to be: a paragraph the
 * owner typed between two headings is absorbed into the heading above it (as
 * parseBrief has always done) and comes back under that heading. What IS pinned:
 * every value the parser sees is identical before and after, and a normalised
 * detail is a fixed point.
 */
const FIRST_HEADING = () => new RegExp(`^[ \\t]*(?:${LABELS.map(escape).join('|')})[ \\t]*:`, 'mi')

export function splitBrief(detail) {
  const text = detail ?? ''
  const first = FIRST_HEADING().exec(text)
  const prose = (first ? text.slice(0, first.index) : text).trim()
  return { prose, values: parseBrief(text).values }
}

export function joinBrief(prose, values) {
  const lines = []
  for (const field of BRIEF_FIELDS) {
    const value = String(values?.[field.key] ?? '').trim()
    if (!value) continue
    lines.push(value.includes('\n') ? `${field.label}:\n${value}` : `${field.label}: ${value}`)
  }
  const head = String(prose ?? '').trim()
  if (!lines.length) return head
  return head ? `${head}\n\n${lines.join('\n')}` : lines.join('\n')
}
