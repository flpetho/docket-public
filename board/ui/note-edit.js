/**
 * Identifying a note, editing it, and saying when it last changed.
 *
 * WHY A KEY RATHER THAN AN INDEX. Notes carry no id, and adding one would
 * rewrite every note on every board. They do carry a natural key: one author
 * does not write two notes in the same millisecond. Addressing by that key is
 * what lets an edit survive the sync layer's 409 replay — pending mutations are
 * re-run against the server's cards, and a position-addressed edit replayed
 * onto a thread somebody else has deleted from rewrites the wrong note with no
 * error anywhere.
 *
 * WHY editedAt RATHER THAN MOVING at. `at` orders the thread, so re-stamping a
 * note on edit would make fixing a typo reorder the conversation and lose when
 * the thing was actually said. But a correction has to reach the next session,
 * and `docket news` compares a watermark against a single timestamp — so it
 * compares against noteStamp() instead, and gets both.
 *
 * Pure and stamp-injected: the caller passes `editedAt`, so this is testable
 * without a clock. Shared by the browser (through app.js) and the server
 * (through news.js), the way tag-color.js and brief.js already are.
 */

/** Enough to find a note again on a newer copy of the board. */
export const noteKey = (note) => ({ author: note?.author ?? '', at: note?.at ?? '' })

/** Its index in `notes`, or -1 when it is gone. */
export function findNote(notes, key) {
  if (!Array.isArray(notes) || !key) return -1
  return notes.findIndex((note) => note?.author === key.author && note?.at === key.at)
}

/**
 * Replace a note's text in place. Returns true when something actually changed,
 * which is the answer sync.mutate reads to decide between 'saved' and 'lost'.
 *
 * Three refusals, each deliberate:
 *   - empty text — a note is removed with remove, never emptied
 *   - unchanged text — opening the editor and closing it costs no rev
 *   - a note that is gone — the one case no replay can rescue
 */
export function applyEdit(notes, key, text, editedAt) {
  const next = String(text ?? '').trim()
  if (!next) return false
  const index = findNote(notes, key)
  if (index === -1) return false
  const note = notes[index]
  if (note.text === next) return false
  note.text = next
  note.editedAt = editedAt
  return true
}

/**
 * When a note last changed: the later of `at` and `editedAt`.
 *
 * Never earlier than `at`, so a skewed or unparseable editedAt cannot hide a
 * note from news by stamping it in the past.
 */
export function noteStamp(note) {
  const at = note?.at ?? ''
  const edited = note?.editedAt ?? ''
  const atMs = Date.parse(at)
  const editedMs = Date.parse(edited)
  if (!Number.isFinite(editedMs)) return at
  if (!Number.isFinite(atMs)) return edited
  return editedMs > atMs ? edited : at
}
