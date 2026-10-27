/**
 * Reading the gate's verdict out of a card's note thread.
 *
 * The note thread stays the record. This is a *read* of it, never a second place
 * the verdict is stored — a derived copy is a thing that can disagree with its
 * source, and the board has already been bitten once by two copies of the same
 * truth (see the decision log on localStorage).
 *
 * Since 2026-10-06 `docket_verdict` also records each ruling on the card's
 * `verdicts` field, and is the only bridge call that moves a Loop card past
 * the gate. It writes this note in the same call, so the two agree unless a
 * hand writes a VERDICT note without the tool; the face keeps reading the
 * thread it shows.
 *
 * The shape it matches is the one `.claude/agents/docket-verifier.md` specifies:
 * a note whose FIRST line is `VERDICT: meets` or `VERDICT: fails`. Anchored to
 * the start of the note rather than to any line, so a note discussing a verdict
 * in prose — "I disagree with the verdict on this one" — is not one.
 */

const VERDICT = /^\s*VERDICT:\s*(meets|fails)\b/i

/** met/failed rather than meets/fails: the card face reports an outcome, not an act. */
const WORD = { meets: 'met', fails: 'failed' }

/**
 * The newest verdict in a note thread, or null when there is none.
 *
 * Newest by timestamp, not by array position. A card that failed, was fixed, and
 * then met must read as met, and relying on push order to establish that would
 * be relying on an accident.
 */
export function latestVerdict(notes = []) {
  let best = null
  for (const [index, note] of (notes ?? []).entries()) {
    const match = VERDICT.exec(note?.text ?? '')
    if (!match) continue
    const at = Date.parse(note?.at) || 0
    if (best && (at < best.at || (at === best.at && index < best.index))) continue
    best = { verdict: match[1].toLowerCase(), at, index, iso: note?.at ?? null }
  }
  if (!best) return null
  return { verdict: best.verdict, word: WORD[best.verdict], at: best.iso }
}

/** `AUG 21` — short enough to sit beside the unread dot without crowding it. */
export function verdictDate(iso) {
  // Falsy first, and not by way of the NaN check: `new Date(null)` is the epoch,
  // not an invalid date, so a note with no timestamp would render as "DEC 31".
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase()
}

/**
 * How the gate rules one acceptance clause. Since 2026-10-27, from the Night
 * Shift review:
 *
 * - met: verified firsthand, with evidence.
 * - not_met: checked, and it is not true.
 * - mismatch: evidence arrived, but not the evidence the clause asked for — an
 *   assertion where a screenshot was promised. The costume work the gate exists
 *   to catch, named so it cannot hide inside a paragraph.
 * - not_evaluated: could not be checked. Never a pass.
 *
 * Shared by the bridge (which refuses a bad verdict) and card validation (which
 * refuses a bad stored one), so the two cannot disagree on the vocabulary.
 */
export const CLAUSE_OUTCOMES = ['met', 'not_met', 'mismatch', 'not_evaluated']

const filled = (value) => typeof value === 'string' && value.trim() !== ''

/** What is wrong with a list of clause rulings, or null when nothing is. */
export function clauseProblem(clauses) {
  if (!Array.isArray(clauses)) return 'clauses must be a list of {clause, outcome, evidence}'
  for (const [index, item] of clauses.entries()) {
    const at = `clause ${index + 1}`
    if (!item || typeof item !== 'object') return `${at} must be {clause, outcome, evidence}`
    if (!filled(item.clause)) return `${at} needs its text: the acceptance clause being ruled on`
    if (!CLAUSE_OUTCOMES.includes(item.outcome)) return `${at} outcome must be ${CLAUSE_OUTCOMES.join(' | ')}`
    if (!filled(item.evidence)) return `${at} needs evidence: what you saw, or why it could not be checked`
  }
  return null
}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim()

/** One line per clause, outcome first, so a column of outcomes scans down the left. */
export function clauseLines(clauses) {
  return clauses.map((c) => `${c.outcome} — ${oneLine(c.clause)}: ${oneLine(c.evidence)}`).join('\n')
}
