import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { renameColumn, toDocket, toTracker } from '../src/migrate.js'
import { normalizeCard } from '../src/card.js'

/**
 * A real tracker board of 53 cards, structurally intact and pseudonymized: the
 * ids, columns, tracks, flags, sources, note lengths and the `Claude:` prefixes
 * are the originals, the prose is not. The counts below are therefore real
 * counts over real shapes, which is the point — a hand-written fixture drifts
 * toward the happy path and would weaken the losslessness proof while still
 * passing.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/migration-board-rev233.json', import.meta.url))
const load = () => JSON.parse(readFileSync(FIXTURE, 'utf8'))

test('the fixture is the board we think it is', () => {
  const tracker = load()
  assert.equal(tracker.rev, 233)
  assert.equal(tracker.cards.length, 53)
  assert.equal(tracker.cards.filter((c) => c.note.trim()).length, 15)
  assert.equal(
    tracker.cards.reduce((sum, c) => sum + c.note.length, 0),
    5811,
  )
})

// ---- The losslessness proof ------------------------------------------------

test('round trip: converting forward and back reproduces the board exactly', () => {
  const tracker = load()
  const back = toTracker(toDocket(tracker))
  assert.deepStrictEqual(back, tracker)
})

test('round trip preserves every character of note text', () => {
  const tracker = load()
  const back = toTracker(toDocket(tracker))
  const chars = (doc) => doc.cards.reduce((sum, c) => sum + c.note.length, 0)
  assert.equal(chars(back), 5811)
  assert.equal(chars(back), chars(tracker))
})

test('round trip preserves card order, not just membership', () => {
  const tracker = load()
  const back = toTracker(toDocket(tracker))
  assert.deepEqual(
    back.cards.map((c) => c.id),
    tracker.cards.map((c) => c.id),
  )
})

// ---- Forward conversion ---------------------------------------------------

test('every card survives, in the same order', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  assert.equal(docket.cards.length, 53)
  assert.deepEqual(
    docket.cards.map((c) => c.id),
    tracker.cards.map((c) => c.id),
  )
})

test('no card changes column', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  for (const [i, card] of docket.cards.entries()) {
    assert.equal(card.column, tracker.cards[i].column, `card ${card.id} moved column`)
  }
})

test('track becomes the first tag', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  for (const [i, card] of docket.cards.entries()) {
    assert.deepEqual(card.tags, [tracker.cards[i].track])
  }
  assert.equal(new Set(docket.cards.flatMap((c) => c.tags)).size, 7)
})

test('each note becomes exactly one entry with its text untouched', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  const noted = docket.cards.filter((c) => c.notes.length)
  assert.equal(noted.length, 15)
  for (const card of noted) {
    assert.equal(card.notes.length, 1, `${card.id} was split into ${card.notes.length} notes`)
    const original = tracker.cards.find((c) => c.id === card.id).note
    assert.equal(card.notes[0].text, original)
  }
})

test('note authorship follows the Claude prefix', () => {
  const docket = toDocket(load())
  const authors = docket.cards.flatMap((c) => c.notes.map((n) => n.author))
  assert.equal(authors.filter((a) => a === 'claude').length, 14)
  assert.equal(authors.filter((a) => a === 'owner').length, 1)
})

test('cards with no note get an empty thread rather than a blank entry', () => {
  const docket = toDocket(load())
  assert.equal(docket.cards.filter((c) => c.notes.length === 0).length, 38)
})

test('src becomes origin, verbatim', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  for (const [i, card] of docket.cards.entries()) {
    assert.equal(card.origin, tracker.cards[i].src)
  }
})

test('flags and createdBy carry over', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  assert.equal(docket.cards.filter((c) => c.flag).length, 2)
  for (const [i, card] of docket.cards.entries()) {
    assert.equal(card.flag, tracker.cards[i].flag)
    assert.equal(card.createdBy, tracker.cards[i].createdBy)
  }
})

test('createdAt uses a date parsed out of origin where there is one', () => {
  const docket = toDocket(load())
  const dated = docket.cards.filter((c) => /\d{4}-\d{2}-\d{2}/.test(c.origin))
  assert.equal(dated.length, 18)
  for (const card of dated) {
    const [date] = card.origin.match(/\d{4}-\d{2}-\d{2}/)
    assert.equal(card.createdAt, `${date}T00:00:00.000Z`)
  }
})

test('cards with no date in origin fall back to the document timestamp', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  const undated = docket.cards.filter((c) => !/\d{4}-\d{2}-\d{2}/.test(c.origin))
  assert.equal(undated.length, 35)
  for (const card of undated) assert.equal(card.createdAt, tracker.updatedAt)
})

test('rev and updatedAt carry over so the first daemon write does not conflict', () => {
  const tracker = load()
  const docket = toDocket(tracker)
  assert.equal(docket.rev, 233)
  assert.equal(docket.updatedAt, tracker.updatedAt)
})

// ---- Reverse conversion, on synthetic input ------------------------------

test('reverse joins a multi-entry thread with a blank line', () => {
  const tracker = toTracker({
    rev: 1,
    updatedAt: '2026-08-21T00:00:00.000Z',
    cards: [
      {
        id: 'a',
        title: 'A',
        detail: '',
        tags: ['strategy'],
        column: 'inbox',
        flag: false,
        notes: [
          { author: 'claude', at: '2026-08-21T00:00:00.000Z', text: 'first' },
          { author: 'owner', at: '2026-08-21T00:00:00.000Z', text: 'second' },
        ],
        origin: 'x',
        createdBy: 'claude',
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
  })
  assert.equal(tracker.cards[0].note, 'first\n\nsecond')
})

test('reverse keeps only the first tag, since track held one value', () => {
  const tracker = toTracker({
    rev: 1,
    updatedAt: '2026-08-21T00:00:00.000Z',
    cards: [
      {
        id: 'a',
        title: 'A',
        detail: '',
        tags: ['strategy', 'decision', 'blocked'],
        column: 'inbox',
        flag: false,
        notes: [],
        origin: '',
        createdBy: 'owner',
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
  })
  assert.equal(tracker.cards[0].track, 'strategy')
})

test('columnSince is only claimed where a real date was parseable', () => {
  const docket = toDocket(load())
  const dated = docket.cards.filter((c) => /\d{4}-\d{2}-\d{2}/.test(c.origin))
  const undated = docket.cards.filter((c) => !/\d{4}-\d{2}-\d{2}/.test(c.origin))
  for (const card of dated) assert.equal(card.columnSince, card.createdAt)
  // The tracker board never recorded column moves. Inventing "just moved" for
  // 35 cards would have been a claim the data cannot support.
  for (const card of undated) assert.equal(card.columnSince, '')
})

test('every migrated card gets an empty attachments array', () => {
  const docket = toDocket(load())
  for (const card of docket.cards) assert.deepEqual(card.attachments, [])
})

// ---------------------------------------------------------------------------
// renameColumn — the overnight → loop rename, generalised just enough to test.

const boardConfig = () => ({
  name: 'Test',
  accent: '#ff5227',
  columns: [
    { key: 'inbox', name: 'Inbox' },
    { key: 'overnight', name: 'Overnight' },
    { key: 'done', name: 'Done' },
  ],
  tags: {},
})

const cardIn = (id, column) =>
  normalizeCard({ id, title: id, column, columnSince: '2026-08-20T00:00:00.000Z' })

test('renameColumn re-keys the column in place, position and all', () => {
  const { config } = renameColumn({
    config: boardConfig(),
    cards: [],
    from: 'overnight',
    to: 'loop',
    name: 'Loop',
  })
  assert.deepEqual(
    config.columns.map((c) => c.key),
    ['inbox', 'loop', 'done'],
  )
  assert.equal(config.columns[1].name, 'Loop')
})

test('renameColumn moves every card in the old key and touches nothing else', () => {
  const cards = [cardIn('a', 'overnight'), cardIn('b', 'inbox'), cardIn('c', 'overnight')]
  const result = renameColumn({
    config: boardConfig(),
    cards,
    from: 'overnight',
    to: 'loop',
    name: 'Loop',
  })
  assert.equal(result.moved, 2)
  assert.deepEqual(
    result.cards.map((c) => c.column),
    ['loop', 'inbox', 'loop'],
  )
  // A re-key is not a column move: the card has sat in the same queue all
  // along, so its clock must not restart.
  assert.equal(result.cards[0].columnSince, '2026-08-20T00:00:00.000Z')
  assert.equal(result.cards[0].id, 'a')
})

test('renameColumn with no such column changes nothing', () => {
  const config = boardConfig()
  const cards = [cardIn('a', 'inbox')]
  const result = renameColumn({ config, cards, from: 'ghost', to: 'loop', name: 'Loop' })
  assert.equal(result.moved, 0)
  assert.deepEqual(result.config, config)
  assert.deepEqual(result.cards, cards)
})

test('renameColumn never mutates its inputs', () => {
  const config = boardConfig()
  const cards = [cardIn('a', 'overnight')]
  renameColumn({ config, cards, from: 'overnight', to: 'loop', name: 'Loop' })
  assert.equal(config.columns[1].key, 'overnight')
  assert.equal(cards[0].column, 'overnight')
})

test('renameColumn into a key that already exists merges instead of duplicating', () => {
  const config = boardConfig()
  config.columns.splice(2, 0, { key: 'loop', name: 'Loop' })
  const result = renameColumn({
    config,
    cards: [cardIn('a', 'overnight')],
    from: 'overnight',
    to: 'loop',
    name: 'Loop',
  })
  assert.deepEqual(
    result.config.columns.map((c) => c.key),
    ['inbox', 'loop', 'done'],
    'no duplicate keys — validateConfig rejects those',
  )
  assert.equal(result.cards[0].column, 'loop')
})
