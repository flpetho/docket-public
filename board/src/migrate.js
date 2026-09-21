import { normalizeCard } from './card.js'

export const NOTE_AUTHOR_PREFIX = 'Claude:'

const DATE = /\d{4}-\d{2}-\d{2}/

/**
 * The atlas tracker board → a Docket board.
 *
 * Lossless by construction, which `migrate.test.js` proves by converting the
 * committed rev-233 fixture forward, back, and deep-comparing. Three rules do
 * the work:
 *
 *   track  → tags[0]
 *   note   → exactly ONE note entry, text verbatim, author from the prefix.
 *            Splitting a note into a thread on `Claude:` markers would work for
 *            14 of 15 real notes and silently halve any note using the word
 *            mid-paragraph. Verbatim beats tidy.
 *   src    → origin, and a date inside it seeds createdAt.
 *
 * Card order is the owner's dragged intent and is never touched.
 */
export function toDocket(trackerDoc) {
  const cards = trackerDoc.cards.map((old) => {
    const match = DATE.exec(old.src ?? '')
    const createdAt = match ? `${match[0]}T00:00:00.000Z` : trackerDoc.updatedAt
    const note = old.note ?? ''
    return normalizeCard({
      id: old.id,
      title: old.title,
      detail: old.detail ?? '',
      tags: old.track ? [old.track] : [],
      column: old.column,
      flag: old.flag === true,
      notes: note.trim()
        ? [
            {
              author: note.trimStart().startsWith(NOTE_AUTHOR_PREFIX) ? 'claude' : 'owner',
              at: createdAt,
              text: note,
            },
          ]
        : [],
      origin: old.src ?? '',
      createdBy: old.createdBy,
      createdAt,
      updatedAt: createdAt,
      // Only claim a column age when a real date was parseable. The old board
      // never recorded column moves, so for the rest the honest answer is
      // silence — 'just moved' would be an invention.
      columnSince: match ? createdAt : '',
    })
  })
  return { rev: trackerDoc.rev, updatedAt: trackerDoc.updatedAt, cards }
}

/**
 * A Docket board → the tracker shape. Exists so the migration's losslessness is
 * testable rather than asserted, and as an escape hatch back to the old board.
 * Drops what the old shape cannot hold: note authorship and timestamps, tags
 * beyond the first, and per-card dates.
 */
export function toTracker(docketDoc) {
  const cards = docketDoc.cards.map((card) => ({
    id: card.id,
    title: card.title,
    detail: card.detail,
    track: card.tags[0] ?? '',
    column: card.column,
    flag: card.flag,
    note: card.notes.map((n) => n.text).join('\n\n'),
    src: card.origin,
    createdBy: card.createdBy,
  }))
  return { rev: docketDoc.rev, updatedAt: docketDoc.updatedAt, cards }
}

/**
 * An evenly-spaced palette for the distinct tracks a tracker board contains.
 *
 * Hashed auto-colours are stable but not *spread* — three of atlas's seven
 * tracks hashed into the same green. Since the tracks are known at migration
 * time, they get declared colours instead, and hashing stays the fallback for
 * tags nobody declared. Sorted input keeps the assignment deterministic.
 */
export function paletteForTracks(trackerDoc) {
  const tracks = [...new Set(trackerDoc.cards.map((c) => c.track).filter(Boolean))].sort()
  const tags = {}
  // 45–340 is the band tag-color.js leaves free; the accent owns the rest.
  const span = 295
  tracks.forEach((track, index) => {
    const hue = Math.round(45 + (span * index) / tracks.length)
    tags[track] = `hsl(${hue} 42% 66%)`
  })
  return tags
}

/**
 * Rename a column key — config and cards in one motion, because doing one
 * without the other is exactly how a card goes invisible: still in the file,
 * pointing at a column no config mentions. Pure; the caller owns the writes.
 *
 * A re-key is not a move, so columnSince is left alone. If the target key
 * already exists, the old column folds into it rather than duplicating —
 * validateConfig rejects duplicate keys.
 */
export function renameColumn({ config, cards, from, to, name }) {
  const hasTarget = config.columns.some((c) => c.key === to)
  const columns = config.columns.flatMap((c) => {
    if (c.key !== from) return [{ ...c }]
    return hasTarget ? [] : [{ key: to, name: name ?? c.name }]
  })
  let moved = 0
  const next = cards.map((card) => {
    if (card.column !== from) return card
    moved += 1
    return { ...card, column: to }
  })
  return { config: { ...config, columns }, cards: next, moved }
}
