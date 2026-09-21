/**
 * What the owner has said since a session last looked.
 *
 * The inbound half of a conversation through the board. `bot/scripts/tell.js` is
 * the outbound half and already worked; this is what makes a reply possible,
 * because a reply needs something to be a reply to.
 *
 * It builds the MECHANISM and stops there. Which message deserves an answer is
 * judgment and stays with the session — a command that decided it would be
 * guessing in code and wrong in a new way every week.
 *
 * THE DANGEROUS PART is the author filter. A reporter that hands back Claude's
 * own notes produces an agent in conversation with itself, and with tell.js wired
 * up, a phone that buzzes all night. That is the cheapest catastrophic failure
 * available here, so it is enforced in one place and tested by construction.
 *
 * A KNOWN HOLE, stated rather than papered over: the only identity a note carries
 * is its `author` string, and the browser has no identity to offer beyond
 * `owner`. So an agent driving the UI is recorded as the owner — which actually
 * happened on 2026-08-21, when a verifier wrote a note through the board while
 * testing and it came out attributed to the owner. This module cannot distinguish
 * that case, and pretending otherwise would be worse than saying so.
 */

/** The one author whose notes are news. Everything else is us, or a tool. */
export const OWNER = 'owner'

/** A capture-born card announces itself in `origin`; that is how the drain marks one. */
const FROM_CAPTURE = /^telegram/i

const newer = (iso, since) => {
  if (since === null || since === undefined) return false
  const at = Date.parse(iso ?? '')
  const mark = Date.parse(since)
  return Number.isFinite(at) && Number.isFinite(mark) && at > mark
}

/**
 * News on one board.
 *
 * `since === null` means no watermark yet and yields nothing — see the note on
 * `firstRun` below. Anything Claude authored is dropped before any other test, so
 * no later condition can accidentally let it through.
 */
export function boardNews({ slug, doc, since }) {
  const notes = []
  const cards = []

  for (const card of doc?.cards ?? []) {
    for (const note of card.notes ?? []) {
      if (note?.author !== OWNER) continue
      if (!newer(note.at, since)) continue
      notes.push({
        project: slug,
        cardId: card.id,
        cardTitle: card.title,
        column: card.column,
        at: note.at,
        text: note.text,
      })
    }

    if (FROM_CAPTURE.test(card.origin ?? '') && newer(card.createdAt, since)) {
      cards.push({
        project: slug,
        cardId: card.id,
        cardTitle: card.title,
        column: card.column,
        at: card.createdAt,
        detail: card.detail,
      })
    }
  }

  const at = (x) => Date.parse(x.at) || 0
  notes.sort((a, b) => at(a) - at(b))
  cards.sort((a, b) => at(a) - at(b))
  return { notes, cards }
}

/**
 * A first run reports NOTHING and sets the mark.
 *
 * The alternative — reporting everything — dumps months of note threads into a
 * session's context the first time anybody runs this, which the contract named as
 * the thing not to do. Silence plus an explicit line saying why is recoverable;
 * a context flooded with history is not.
 */
export const firstRun = { reports: 'nothing', reason: 'marking now, so the next run reports only what arrives after this moment' }

/** Per project, so adding a board later does not replay its whole history. */
export function advanceWatermark(watermark, slug, iso) {
  return { ...(watermark ?? {}), [slug]: iso }
}

export function markFor(watermark, slug) {
  const value = watermark?.[slug]
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

/** Everything worth showing, oldest first, across every board. */
export function summarise(all) {
  const items = [
    ...all.flatMap((r) => r.notes.map((n) => ({ ...n, kind: 'note' }))),
    ...all.flatMap((r) => r.cards.map((c) => ({ ...c, kind: 'capture' }))),
  ]
  items.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
  return items
}
