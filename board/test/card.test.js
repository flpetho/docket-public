import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CARD_KEYS, normalizeCard, orphanedCards, validateCard } from '../src/card.js'

const COLUMNS = ['inbox', 'next', 'done']

test('normalizeCard fills every key with a sane default', () => {
  const card = normalizeCard({ id: 'a', title: 'A' })
  assert.deepEqual(Object.keys(card).sort(), [...CARD_KEYS].sort())
  assert.equal(card.detail, '')
  assert.deepEqual(card.tags, [])
  assert.equal(card.column, 'inbox')
  assert.equal(card.flag, false)
  assert.deepEqual(card.notes, [])
  assert.equal(card.origin, '')
  assert.equal(card.createdBy, 'owner')
})

test('normalizeCard never overwrites a supplied value', () => {
  const card = normalizeCard({
    id: 'a',
    title: 'A',
    detail: 'd',
    tags: ['x'],
    column: 'done',
    flag: true,
    notes: [{ author: 'claude', at: '2026-08-21T00:00:00.000Z', text: 't' }],
    origin: 'chunk 1',
    createdBy: 'claude',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  })
  assert.equal(card.detail, 'd')
  assert.deepEqual(card.tags, ['x'])
  assert.equal(card.column, 'done')
  assert.equal(card.flag, true)
  assert.equal(card.notes[0].text, 't')
  assert.equal(card.origin, 'chunk 1')
  assert.equal(card.createdBy, 'claude')
  assert.equal(card.createdAt, '2026-08-20T00:00:00.000Z')
})

test('validateCard accepts a normalized card', () => {
  assert.deepEqual(validateCard(normalizeCard({ id: 'a', title: 'A' }), COLUMNS), [])
})

test('validateCard names each problem it finds', () => {
  const errors = validateCard(
    { id: '', title: 5, detail: null, tags: 'nope', column: 'nowhere', flag: 'yes', notes: {} },
    COLUMNS,
  )
  const joined = errors.join(' | ')
  assert.match(joined, /id/)
  assert.match(joined, /title/)
  assert.match(joined, /tags/)
  assert.match(joined, /column/)
  assert.match(joined, /flag/)
  assert.match(joined, /notes/)
})

test('validateCard rejects a malformed note entry', () => {
  const card = normalizeCard({ id: 'a', title: 'A', notes: [{ author: 'claude' }] })
  assert.match(validateCard(card, COLUMNS).join(' '), /note/)
})

test('validateCard rejects a column outside the project config', () => {
  const card = normalizeCard({ id: 'a', title: 'A', column: 'review' })
  assert.match(validateCard(card, COLUMNS).join(' '), /column/)
})

test('orphanedCards finds every card whose column is absent from the config', () => {
  const keys = ['inbox', 'loop', 'done']
  const cards = [
    normalizeCard({ id: 'a', column: 'inbox' }),
    normalizeCard({ id: 'b', column: 'overnight' }),
    normalizeCard({ id: 'c', column: 'done' }),
  ]
  assert.deepEqual(
    orphanedCards(cards, keys).map((c) => c.id),
    ['b'],
  )
  assert.deepEqual(orphanedCards([cards[0], cards[2]], keys), [])
})

// ---- time: the field the timer writes (spec 2026-09-14) ----------------------

test('normalizeCard gives a card from before the timer an empty time, and keeps a supplied one', () => {
  assert.deepEqual(normalizeCard({ id: 'a', title: 'A' }).time, { running: null, sessions: [] })
  const time = { running: '2026-09-14T09:12:00.000Z', sessions: [{ start: '2026-09-14T08:00:00.000Z', stop: '2026-09-14T08:30:00.000Z', note: 'x' }] }
  assert.deepEqual(normalizeCard({ id: 'a', title: 'A', time }).time, time)
  assert.ok(CARD_KEYS.includes('time'))
})

test('validateCard checks the time shapes', () => {
  const base = normalizeCard({ id: 'a', title: 'A' })
  assert.deepEqual(validateCard(base, COLUMNS), [])
  assert.deepEqual(validateCard({ ...base, time: { running: 5, sessions: [] } }, COLUMNS), ['time.running must be an ISO string or null'])
  assert.deepEqual(validateCard({ ...base, time: { running: null, sessions: 'no' } }, COLUMNS), ['time.sessions must be an array'])
  assert.deepEqual(
    validateCard({ ...base, time: { running: null, sessions: [{ start: 'x', stop: 'y' }] } }, COLUMNS),
    ['each time session needs string start, stop, and note'],
  )
})

// The estimate and the due date: optional, panel only, never on the card face.
// The 2026-08-21 spec ruled both out; reversed by the owner 2026-09-17 on the
// condition that neither reaches the face. Spec:
// docs/specs/2026-09-17-manual-time-and-dashboard-design.md

test('normalizeCard leaves the estimate and the due date unset rather than guessing', () => {
  const card = normalizeCard({ id: 'a', title: 'A' })
  assert.equal(card.estimateMinutes, null)
  assert.equal(card.due, null)
  assert.ok(CARD_KEYS.includes('estimateMinutes') && CARD_KEYS.includes('due'))
})

test('normalizeCard keeps an estimate and a due date it is given', () => {
  const card = normalizeCard({ id: 'a', title: 'A', estimateMinutes: 300, due: '2026-10-01' })
  assert.equal(card.estimateMinutes, 300)
  assert.equal(card.due, '2026-10-01')
})

test('validateCard rejects an estimate that is not a number of minutes', () => {
  const bad = (patch) => validateCard({ ...normalizeCard({ id: 'a', title: 'A' }), ...patch }, COLUMNS).join(' | ')
  assert.match(bad({ estimateMinutes: 'five hours' }), /estimateMinutes/)
  assert.match(bad({ estimateMinutes: -30 }), /estimateMinutes/)
  assert.match(bad({ estimateMinutes: Number.NaN }), /estimateMinutes/)
  assert.deepEqual(validateCard(normalizeCard({ id: 'a', title: 'A', estimateMinutes: 0 }), COLUMNS), [], 'zero is a real estimate')
})

test('validateCard wants a due date as a day, not a timestamp', () => {
  const bad = (patch) => validateCard({ ...normalizeCard({ id: 'a', title: 'A' }), ...patch }, COLUMNS).join(' | ')
  assert.match(bad({ due: '2026-10-01T09:00:00.000Z' }), /due/)
  assert.match(bad({ due: '01/10/2026' }), /due/)
  assert.match(bad({ due: 5 }), /due/)
  assert.deepEqual(validateCard(normalizeCard({ id: 'a', title: 'A', due: '2026-10-01' }), COLUMNS), [])
})
