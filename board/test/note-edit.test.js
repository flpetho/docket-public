import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyEdit, findNote, noteKey, noteStamp } from '../ui/note-edit.js'

const note = (over = {}) => ({ author: 'owner', at: '2026-09-23T10:00:00.000Z', text: 'first', ...over })
const EDITED = '2026-09-23T12:00:00.000Z'

// ---- identity -------------------------------------------------------------

test('a note is found by its author and timestamp, not its position', () => {
  const notes = [note({ at: '2026-09-23T09:00:00.000Z' }), note({ text: 'second' })]
  assert.equal(findNote(notes, noteKey(notes[1])), 1)
})

test('the RIGHT note is found after one earlier in the thread is removed', () => {
  // The whole reason this module exists. The sync layer replays pending
  // mutations onto the server's cards after a 409; a position-addressed edit
  // replayed onto a re-ordered thread rewrites a different note, silently.
  const target = note({ at: '2026-09-23T11:00:00.000Z', text: 'mine' })
  const before = [note({ at: '2026-09-23T09:00:00.000Z' }), target]
  const key = noteKey(target)
  assert.equal(findNote(before, key), 1)

  const afterServerDeletedTheFirst = [target]
  assert.equal(findNote(afterServerDeletedTheFirst, key), 0, 'the key still finds it at its new index')
})

test('two authors writing at the same instant are told apart', () => {
  const at = '2026-09-23T10:00:00.000Z'
  const notes = [note({ author: 'claude', at }), note({ author: 'owner', at })]
  assert.equal(findNote(notes, { author: 'owner', at }), 1)
})

test('a note that is gone reports -1 rather than 0', () => {
  assert.equal(findNote([note()], { author: 'owner', at: 'never' }), -1)
  assert.equal(findNote([], noteKey(note())), -1)
  assert.equal(findNote(undefined, noteKey(note())), -1)
})

// ---- the edit -------------------------------------------------------------

test('an edit replaces the text, keeps at, and records editedAt', () => {
  const notes = [note()]
  assert.equal(applyEdit(notes, noteKey(notes[0]), 'second', EDITED), true)
  assert.equal(notes[0].text, 'second')
  assert.equal(notes[0].at, '2026-09-23T10:00:00.000Z', 'at is never moved')
  assert.equal(notes[0].editedAt, EDITED)
})

test('an unchanged text writes nothing at all', () => {
  // Opening the editor and closing it must not cost a rev or stamp an edit.
  const notes = [note()]
  assert.equal(applyEdit(notes, noteKey(notes[0]), 'first', EDITED), false)
  assert.equal(notes[0].editedAt, undefined)
})

test('surrounding whitespace is not a change', () => {
  const notes = [note()]
  assert.equal(applyEdit(notes, noteKey(notes[0]), '  first  ', EDITED), false)
  assert.equal(notes[0].editedAt, undefined)
})

test('an empty text is refused — a note is removed, never emptied', () => {
  const notes = [note()]
  assert.equal(applyEdit(notes, noteKey(notes[0]), '   ', EDITED), false)
  assert.equal(notes[0].text, 'first', 'the original survives')
  assert.equal(notes[0].editedAt, undefined)
})

test('editing a note that is gone returns false and touches nothing', () => {
  // This is what mutate() turns into 'lost', which is what puts the owner's
  // text back in the box.
  const notes = [note()]
  assert.equal(applyEdit(notes, { author: 'owner', at: 'never' }, 'new', EDITED), false)
  assert.equal(notes[0].text, 'first')
})

test('a second edit overwrites the first editedAt rather than accumulating', () => {
  const notes = [note()]
  applyEdit(notes, noteKey(notes[0]), 'second', EDITED)
  const later = '2026-09-23T13:00:00.000Z'
  assert.equal(applyEdit(notes, noteKey(notes[0]), 'third', later), true)
  assert.equal(notes[0].editedAt, later)
  assert.equal(notes[0].text, 'third')
})

// ---- the stamp ------------------------------------------------------------

test('an unedited note stamps at its at', () => {
  assert.equal(noteStamp(note()), '2026-09-23T10:00:00.000Z')
})

test('an edited note stamps at its editedAt', () => {
  assert.equal(noteStamp(note({ editedAt: EDITED })), EDITED)
})

test('an editedAt older than at — a skewed clock — never moves the stamp backwards', () => {
  const skewed = note({ editedAt: '2026-09-23T08:00:00.000Z' })
  assert.equal(noteStamp(skewed), '2026-09-23T10:00:00.000Z')
})

test('an unparseable editedAt falls back to at rather than to NaN', () => {
  assert.equal(noteStamp(note({ editedAt: 'nonsense' })), '2026-09-23T10:00:00.000Z')
})
