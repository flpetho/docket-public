import { test } from 'node:test'
import assert from 'node:assert/strict'

import { replayOnto } from '../ui/sync.js'

/**
 * The conflict-replay half of the fix for the owner's 2026-08-23 report. A note
 * typed while another session wrote the same board was discarded outright: the
 * 409 branch adopted the server's copy and dropped the local edit.
 *
 * Only the pure part is testable here — board/ has no DOM harness and adding one
 * means adding a dependency — so this pins the decision, and the round trip is
 * verified in a real browser.
 */

const noteAdder = (id, text) => (cards) => {
  const card = cards.find((c) => c.id === id)
  if (!card) return false
  card.notes.push({ author: 'owner', at: '2026-08-23T00:00:00Z', text })
}
const card = (id, notes = []) => ({ id, notes })

test('an edit is re-applied onto the cards that arrived while it was in flight', () => {
  // The server created a card we had never seen. The owner's note must land AND
  // the new card must survive — the old code kept one or the other, never both.
  const server = [card('theirs'), card('mine')]
  const result = replayOnto(server, [noteAdder('mine', 'my note')])
  assert.equal(result.applied, 1)
  assert.deepEqual(result.lost, [])
  assert.equal(server.find((c) => c.id === 'mine').notes[0].text, 'my note')
  assert.ok(server.some((c) => c.id === 'theirs'), "the other session's card survives")
})

test('several queued edits all survive a single conflict', () => {
  const server = [card('a'), card('b')]
  const result = replayOnto(server, [noteAdder('a', 'one'), noteAdder('b', 'two'), noteAdder('a', 'three')])
  assert.equal(result.applied, 3)
  assert.deepEqual(server.find((c) => c.id === 'a').notes.map((n) => n.text), ['one', 'three'])
  assert.deepEqual(server.find((c) => c.id === 'b').notes.map((n) => n.text), ['two'])
})

test('an edit whose card was deleted underneath is reported lost, not silently dropped', () => {
  // The one case a replay cannot rescue. It has to be distinguishable, because
  // the caller puts the owner's text back when it hears 'lost'.
  const server = [card('survivor')]
  const result = replayOnto(server, [noteAdder('deleted-card', 'orphan note')])
  assert.equal(result.applied, 0)
  assert.equal(result.lost.length, 1)
})

test('a partial loss still saves what it can', () => {
  const server = [card('alive')]
  const result = replayOnto(server, [noteAdder('alive', 'kept'), noteAdder('gone', 'lost')])
  assert.equal(result.applied, 1)
  assert.equal(result.lost.length, 1)
  assert.equal(server[0].notes[0].text, 'kept')
})

test('replaying nothing is not an error and is not a loss', () => {
  const result = replayOnto([card('a')], [])
  assert.equal(result.applied, 0)
  assert.deepEqual(result.lost, [])
})

test('a replay never duplicates a note it already applied', () => {
  // The obvious way to get the fix wrong: retry the whole queue against cards
  // that already have the note. Each replay runs against the SERVER's cards,
  // which by definition rejected the write, so applying once is correct — this
  // pins that replayOnto itself does not double-apply.
  const server = [card('a')]
  const one = noteAdder('a', 'exactly once')
  replayOnto(server, [one])
  assert.equal(server[0].notes.length, 1)
})

test('the mutation contract is false-means-lost, nothing else', () => {
  // undefined is the success case: a mutation that just does its work returns
  // nothing. Treating any falsy value as a loss would call every success a loss.
  const server = [card('a')]
  assert.equal(replayOnto(server, [() => undefined]).lost.length, 0)
  assert.equal(replayOnto(server, [() => null]).lost.length, 0)
  assert.equal(replayOnto(server, [() => 0]).lost.length, 0)
  assert.equal(replayOnto(server, [() => false]).lost.length, 1)
})
