import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OWNER, advanceWatermark, boardNews, markFor, summarise } from '../src/news.js'

const note = (author, at, text = 'hello') => ({ author, at, text })
const card = (over = {}) => ({
  id: 'card-1',
  title: 'a card',
  column: 'inbox',
  detail: '',
  origin: '',
  createdAt: '2026-08-22T00:00:00Z',
  notes: [],
  ...over,
})
const doc = (cards) => ({ rev: 1, cards })
const SINCE = '2026-08-22T01:00:00Z'

test("Claude's own notes are NEVER news, in any arrangement", () => {
  // The loop this prevents: agent sees its own reply, answers it, sees that, and
  // with tell.js wired up the owner's phone buzzes all night.
  const doubled = doc([
    card({ notes: [note('claude', '2026-08-22T02:00:00Z', 'I did the thing')] }),
    card({ id: 'card-2', notes: [note('claude', '2026-08-22T03:00:00Z', 'VERDICT: meets')] }),
  ])
  const result = boardNews({ slug: 'docket', doc: doubled, since: SINCE })
  assert.deepEqual(result.notes, [])
})

test('an unknown author is not news either — the filter allows, it does not deny', () => {
  // Written as an allowlist on purpose. A denylist of "not claude" would treat a
  // future author, or a typo, as the owner speaking.
  for (const author of ['claude', 'verifier', 'bot', '', undefined, null, 'Owner', 'OWNER']) {
    const result = boardNews({
      slug: 'docket',
      doc: doc([card({ notes: [note(author, '2026-08-22T02:00:00Z')] })]),
      since: SINCE,
    })
    assert.deepEqual(result.notes, [], String(author))
  }
  // And the exact string does come through.
  const ok = boardNews({
    slug: 'docket',
    doc: doc([card({ notes: [note(OWNER, '2026-08-22T02:00:00Z')] })]),
    since: SINCE,
  })
  assert.equal(ok.notes.length, 1)
})

test('an owner note newer than the mark is reported once, with what a reply needs', () => {
  const result = boardNews({
    slug: 'docket',
    doc: doc([card({ notes: [note(OWNER, '2026-08-22T02:00:00Z', 'can you look at this')] })]),
    since: SINCE,
  })
  assert.equal(result.notes.length, 1)
  const [item] = result.notes
  assert.equal(item.project, 'docket')
  assert.equal(item.cardId, 'card-1')
  assert.equal(item.text, 'can you look at this')
  assert.equal(item.column, 'inbox') // enough to act without another lookup
})

test('a note older than the mark is not news', () => {
  const result = boardNews({
    slug: 'docket',
    doc: doc([card({ notes: [note(OWNER, '2026-08-22T00:30:00Z')] })]),
    since: SINCE,
  })
  assert.deepEqual(result.notes, [])
})

test('exactly once: a note at the mark itself does not repeat', () => {
  // The watermark is advanced to "now" after a run, so an item stamped exactly at
  // that instant was already reported. Reporting it again is the failure the
  // contract calls out — an agent answering the same message twice.
  const result = boardNews({
    slug: 'docket',
    doc: doc([card({ notes: [note(OWNER, SINCE)] })]),
    since: SINCE,
  })
  assert.deepEqual(result.notes, [])
})

test('no watermark yet reports nothing rather than dumping history', () => {
  // Reporting everything on a first run floods a session's context with months
  // of threads. Silence plus an explicit reason is recoverable; that is not.
  const busy = doc([
    card({ notes: [note(OWNER, '2020-01-01T00:00:00Z'), note(OWNER, '2026-08-22T02:00:00Z')] }),
  ])
  for (const since of [null, undefined]) {
    const result = boardNews({ slug: 'docket', doc: busy, since })
    assert.deepEqual(result.notes, [])
    assert.deepEqual(result.cards, [])
  }
})

test('a capture-born card is news; a hand-made one is not', () => {
  const drained = card({ id: 'c-drained', origin: 'telegram · 2026-08-22', createdAt: '2026-08-22T02:00:00Z' })
  const typed = card({ id: 'c-typed', origin: '', createdAt: '2026-08-22T02:00:00Z' })
  const result = boardNews({ slug: 'docket', doc: doc([drained, typed]), since: SINCE })
  assert.deepEqual(result.cards.map((c) => c.cardId), ['c-drained'])
})

test('a card the owner typed in the browser is not mistaken for a capture', () => {
  // This exact case appeared on 2026-08-22: a card with createdBy "owner" and an
  // empty origin, which is a card typed in the UI, not a drained capture.
  const result = boardNews({
    slug: 'docket',
    doc: doc([card({ origin: '', createdBy: 'owner', createdAt: '2026-08-22T02:00:00Z' })]),
    since: SINCE,
  })
  assert.deepEqual(result.cards, [])
})

test('a malformed timestamp is never news, and never throws', () => {
  for (const at of ['', 'yesterday', undefined, null, 'NaN']) {
    const result = boardNews({
      slug: 'docket',
      doc: doc([card({ notes: [note(OWNER, at)] })]),
      since: SINCE,
    })
    assert.deepEqual(result.notes, [], String(at))
  }
})

test('an empty or absent board does not throw', () => {
  assert.deepEqual(boardNews({ slug: 'x', doc: doc([]), since: SINCE }).notes, [])
  assert.deepEqual(boardNews({ slug: 'x', doc: null, since: SINCE }).notes, [])
  assert.deepEqual(boardNews({ slug: 'x', doc: { cards: [card({ notes: null })] }, since: SINCE }).notes, [])
})

test('news is ordered oldest first, so a session reads a conversation in order', () => {
  const result = boardNews({
    slug: 'docket',
    doc: doc([
      card({ id: 'a', notes: [note(OWNER, '2026-08-22T05:00:00Z', 'third')] }),
      card({ id: 'b', notes: [note(OWNER, '2026-08-22T02:00:00Z', 'first')] }),
      card({ id: 'c', notes: [note(OWNER, '2026-08-22T03:00:00Z', 'second')] }),
    ]),
    since: SINCE,
  })
  assert.deepEqual(result.notes.map((n) => n.text), ['first', 'second', 'third'])
})

test('the watermark is per project, so adding a board later replays nothing', () => {
  const mark = advanceWatermark({ docket: SINCE }, 'personal', '2026-08-22T04:00:00Z')
  assert.equal(markFor(mark, 'docket'), SINCE)
  assert.equal(markFor(mark, 'personal'), '2026-08-22T04:00:00Z')
  assert.equal(markFor(mark, 'never-seen'), null) // → first run for that board
})

test('a corrupt watermark reads as absent rather than as a date', () => {
  for (const bad of [{ docket: 'garbage' }, { docket: 42 }, { docket: null }, {}, null, undefined]) {
    assert.equal(markFor(bad, 'docket'), null, JSON.stringify(bad))
  }
})

test('advancing a watermark leaves other projects alone', () => {
  const before = { docket: SINCE, personal: '2026-08-01T00:00:00Z' }
  const after = advanceWatermark(before, 'docket', '2026-08-22T09:00:00Z')
  assert.equal(after.personal, '2026-08-01T00:00:00Z')
  assert.equal(after.docket, '2026-08-22T09:00:00Z')
  assert.equal(before.docket, SINCE) // not mutated
})

test('summarise interleaves notes and captures across boards, oldest first', () => {
  const items = summarise([
    { notes: [{ at: '2026-08-22T03:00:00Z', project: 'a' }], cards: [{ at: '2026-08-22T01:00:00Z', project: 'a' }] },
    { notes: [{ at: '2026-08-22T02:00:00Z', project: 'b' }], cards: [] },
  ])
  assert.deepEqual(items.map((i) => i.at), [
    '2026-08-22T01:00:00Z',
    '2026-08-22T02:00:00Z',
    '2026-08-22T03:00:00Z',
  ])
  assert.deepEqual(items.map((i) => i.kind), ['capture', 'note', 'note'])
})
