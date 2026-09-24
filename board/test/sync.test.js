import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSync, replayOnto } from '../ui/sync.js'

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

// ---- mutate honours its mutator's answer ----------------------------------

/**
 * The bug this closes: `mutate` applied the mutation and threw the answer away,
 * so a mutation returning false — the card it wanted is gone — was queued
 * anyway, pushed unchanged cards, got a 200, and resolved 'saved'. The owner
 * was told their edit landed when nothing was written. Carded as
 * card-mu7h71qd-3qsg and reported first in STATE.md's Next.
 *
 * No DOM is needed: mutate touches only fetch and setTimeout, both of which
 * node has. EventSource is only reached by listen(), which these never call.
 */
const fakeResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const BOARD = { rev: 1, cards: [{ id: 'a', notes: [] }] }

/** Swaps global fetch for the duration, and hands the run its call log. */
const withFetch = async (impl, run) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', init })
    return impl(String(url), init)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const loaded = async (impl, run) =>
  withFetch(impl, async (calls) => {
    const sync = createSync({ project: 'p', onDoc: () => {}, onStatus: () => {} })
    await sync.load()
    return run(sync, calls)
  })

test('a mutation that cannot apply resolves lost and never reaches the network', async () => {
  await loaded(
    () => fakeResponse(structuredClone(BOARD)),
    async (sync, calls) => {
      const outcome = await sync.mutate(() => false)
      assert.equal(outcome, 'lost')
      assert.deepEqual(calls.filter((c) => c.method === 'PUT'), [], 'nothing was pushed')
    },
  )
})

test('a mutation that changes something and THEN returns false is still not pushed', async () => {
  // The guard is on the return value, not on whether anything moved. A partial
  // mutation that then gives up must not be queued, or the 409 replay applies
  // it a second time onto the server's cards.
  await loaded(
    () => fakeResponse(structuredClone(BOARD)),
    async (sync, calls) => {
      const outcome = await sync.mutate((cards) => {
        cards[0].notes.push({ author: 'owner', at: 'x', text: 'half' })
        return false
      })
      assert.equal(outcome, 'lost')
      assert.deepEqual(calls.filter((c) => c.method === 'PUT'), [], 'nothing was pushed')
    },
  )
})

test('a mutation that applies still resolves saved and pushes exactly once', async () => {
  // The regression guard. The fix must not make every mutation lost.
  await loaded(
    (url, init) => (init?.method === 'PUT' ? fakeResponse({ rev: 2 }) : fakeResponse(structuredClone(BOARD))),
    async (sync, calls) => {
      const outcome = await sync.mutate((cards) => {
        cards[0].notes.push({ author: 'owner', at: 'x', text: 'real' })
      })
      assert.equal(outcome, 'saved')
      assert.equal(calls.filter((c) => c.method === 'PUT').length, 1)
    },
  )
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

test('a mutation that gave up leaves nothing behind for the NEXT push to carry', async () => {
  // The assertion the first version of this test was missing. Reporting 'lost'
  // is not enough: push() serialises the whole cards array, so an abandoned
  // change would reach the server inside the next unrelated save.
  const sent = []
  await loaded(
    (url, init) => {
      if (init?.method === 'PUT') {
        sent.push(JSON.parse(init.body))
        return fakeResponse({ rev: 2 })
      }
      return fakeResponse(structuredClone(BOARD))
    },
    async (sync) => {
      await sync.mutate((cards) => {
        cards[0].notes.push({ author: 'owner', at: 'x', text: 'abandoned' })
        return false
      })
      await sync.mutate((cards) => {
        cards[0].notes.push({ author: 'owner', at: 'y', text: 'real' })
      })
      assert.equal(sent.length, 1)
      assert.deepEqual(sent[0].cards[0].notes.map((n) => n.text), ['real'])
    },
  )
})

test('replayOnto also undoes a mutation that gave up halfway', () => {
  // Same property on the 409 path, which has had it since it was written.
  const server = [card('a')]
  const result = replayOnto(server, [
    (cards) => {
      cards[0].notes.push({ author: 'owner', at: 'x', text: 'abandoned' })
      return false
    },
  ])
  assert.equal(result.applied, 0)
  assert.deepEqual(server[0].notes, [], 'the abandoned change is gone')
})

test('replayOnto still keeps the changes of mutations that succeeded', () => {
  // The regression guard: the snapshot must not undo good work alongside bad.
  const server = [card('a'), card('b')]
  const result = replayOnto(server, [
    (cards) => {
      cards.find((c) => c.id === 'a').notes.push({ author: 'owner', at: 'x', text: 'kept' })
    },
    (cards) => {
      cards.find((c) => c.id === 'b').notes.push({ author: 'owner', at: 'y', text: 'undone' })
      return false
    },
  ])
  assert.equal(result.applied, 1)
  assert.deepEqual(server.find((c) => c.id === 'a').notes.map((n) => n.text), ['kept'])
  assert.deepEqual(server.find((c) => c.id === 'b').notes, [])
})
