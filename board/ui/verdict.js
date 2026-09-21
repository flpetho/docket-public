/**
 * Reading the gate's verdict out of a card's note thread.
 *
 * The note thread stays the record. This is a *read* of it, never a second place
 * the verdict is stored — a derived copy is a thing that can disagree with its
 * source, and the board has already been bitten once by two copies of the same
 * truth (see the decision log on localStorage).
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
