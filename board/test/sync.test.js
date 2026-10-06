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

test('a push that fails leaves the board as the server last confirmed it', async () => {
  // Card fzuf's review, 2026-10-06: the catch branch settled 'lost' but left
  // the edit applied to the local cards. A created card stayed on the board
  // after "nothing was saved", and the next successful push carried it to the
  // server anyway — an edit reported lost arriving inside an unrelated save.
  let failNext = true
  const sent = []
  await loaded(
    (url, init) => {
      if (init?.method === 'PUT') {
        if (failNext) {
          failNext = false
          throw new TypeError('network down')
        }
        sent.push(JSON.parse(init.body))
        return fakeResponse({ rev: 2 })
      }
      return fakeResponse(structuredClone(BOARD))
    },
    async (sync) => {
      const before = structuredClone(sync.doc.cards)
      const outcome = await sync.mutate((cards) => {
        cards.unshift({ id: 'card-new', title: 'never saved', notes: [] })
      })
      assert.equal(outcome, 'lost')
      assert.deepEqual(sync.doc.cards, before, 'the local board no longer shows the lost card')
      await sync.mutate((cards) => {
        cards[0].notes.push({ author: 'owner', at: 'y', text: 'real' })
      })
      assert.equal(sent.length, 1)
      assert.ok(!sent[0].cards.some((c) => c.id === 'card-new'), 'the lost card did not ride along')
    },
  )
})

test('replays that run out leave the board as the server sent it', async () => {
  // The other 'lost': the server kept changing. Its cards were adopted and the
  // edit replayed onto them; giving up must take the replayed edit back out.
  const sent = []
  let rev = 1
  await loaded(
    (url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body)
        if (body.cards.some((c) => c.id === 'card-new')) {
          rev += 1
          return fakeResponse({ rev, cards: structuredClone(BOARD.cards) }, 409)
        }
        sent.push(body)
        return fakeResponse({ rev: rev + 1 })
      }
      return fakeResponse(structuredClone(BOARD))
    },
    async (sync, calls) => {
      const outcome = await sync.mutate((cards) => {
        cards.unshift({ id: 'card-new', title: 'kept bouncing', notes: [] })
      })
      assert.equal(outcome, 'lost')
      assert.equal(calls.filter((c) => c.method === 'PUT').length, 4, 'the first push and all three replays were tried')
      assert.ok(!sync.doc.cards.some((c) => c.id === 'card-new'))
    },
  )
})

test('an edit survives two conflicts in a row', async () => {
  // Found while writing the test above: the replayed edit was not re-queued,
  // so a second 409 had nothing to replay and the note was dropped with the
  // wrong reason. One other writer saving twice was enough.
  let conflicts = 2
  let rev = 1
  const sent = []
  await loaded(
    (url, init) => {
      if (init?.method === 'PUT') {
        if (conflicts > 0) {
          conflicts -= 1
          rev += 1
          return fakeResponse({ rev, cards: structuredClone(BOARD.cards) }, 409)
        }
        sent.push(JSON.parse(init.body))
        return fakeResponse({ rev: rev + 1 })
      }
      return fakeResponse(structuredClone(BOARD))
    },
    async (sync) => {
      const outcome = await sync.mutate(noteAdder('a', 'kept'))
      assert.equal(outcome, 'saved')
      assert.deepEqual(sent.at(-1).cards[0].notes.map((n) => n.text), ['kept'])
    },
  )
})

// ---- the second review, 2026-10-06 ---------------------------------------
// Each of these pins one line a mutant could remove with the suite still green.

/** A promise you resolve from outside: holds a PUT open until the test says. */
const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

test('a failure after a save rolls back only to that save, never to the load', async () => {
  // Pins `confirmed = sentCards`. Without it a failure would roll the board
  // back to how it loaded, and the next push would delete saved work.
  let put = 0
  const sent = []
  await loaded(
    (url, init) => {
      if (init?.method !== 'PUT') return fakeResponse(structuredClone(BOARD))
      put += 1
      if (put === 2) throw new TypeError('network down')
      sent.push(JSON.parse(init.body))
      return fakeResponse({ rev: put + 1 })
    },
    async (sync) => {
      assert.equal(await sync.mutate(noteAdder('a', 'first')), 'saved')
      assert.equal(await sync.mutate(noteAdder('a', 'second')), 'lost')
      assert.deepEqual(sync.doc.cards[0].notes.map((n) => n.text), ['first'], 'the saved note is still there')
      assert.equal(await sync.mutate(noteAdder('a', 'third')), 'saved')
      assert.deepEqual(sent.at(-1).cards[0].notes.map((n) => n.text), ['first', 'third'])
    },
  )
})

test('an edit made while a push fails is kept and pushed on its own', async () => {
  // Pins the replay of pending inside rollBack: that edit has not been tried.
  const hold = deferred()
  let put = 0
  const sent = []
  await loaded(
    async (url, init) => {
      if (init?.method !== 'PUT') return fakeResponse(structuredClone(BOARD))
      put += 1
      if (put === 1) {
        await hold.promise
        throw new TypeError('network down')
      }
      sent.push(JSON.parse(init.body))
      return fakeResponse({ rev: 9 })
    },
    async (sync) => {
      const first = sync.mutate(noteAdder('a', 'in the failing push'))
      await tick(450) // past the debounce: the first PUT is now in flight
      const second = sync.mutate(noteAdder('a', 'typed meanwhile'))
      hold.resolve()
      assert.equal(await first, 'lost')
      assert.deepEqual(sync.doc.cards[0].notes.map((n) => n.text), ['typed meanwhile'], 'kept on screen')
      assert.equal(await second, 'saved')
      assert.deepEqual(sent.at(-1).cards[0].notes.map((n) => n.text), ['typed meanwhile'])
    },
  )
})

test('an edit is told the fate of ITS push, not of the one in flight when it was made', async () => {
  // settle() used to resolve every waiter, so an edit made during a push that
  // succeeded was told 'saved' — its caller cleared the text — and then its own
  // push failed and the rollback erased it. Each push answers its own edits.
  const hold = deferred()
  let put = 0
  await loaded(
    async (url, init) => {
      if (init?.method !== 'PUT') return fakeResponse(structuredClone(BOARD))
      put += 1
      if (put === 1) {
        await hold.promise
        return fakeResponse({ rev: 2 })
      }
      throw new TypeError('network down')
    },
    async (sync) => {
      const first = sync.mutate(noteAdder('a', 'A'))
      await tick(450)
      const second = sync.mutate(noteAdder('a', 'B'))
      hold.resolve()
      assert.equal(await first, 'saved')
      assert.equal(await second, 'lost', 'B was in the push that failed')
    },
  )
})

test('one push at a time: an edit made during a push waits for it', async () => {
  // Two PUTs in flight could let the second carry an edit the first then
  // rolls back, and the save after that would delete it from the server.
  const hold = deferred()
  let inFlight = 0
  let most = 0
  await loaded(
    async (url, init) => {
      if (init?.method !== 'PUT') return fakeResponse(structuredClone(BOARD))
      inFlight += 1
      most = Math.max(most, inFlight)
      if (inFlight === 1 && most === 1) await hold.promise
      inFlight -= 1
      return fakeResponse({ rev: 5 })
    },
    async (sync) => {
      const first = sync.mutate(noteAdder('a', 'A'))
      await tick(450)
      const second = sync.mutate(noteAdder('a', 'B'))
      await tick(900) // the second debounce has long expired
      hold.resolve()
      assert.equal(await first, 'saved')
      assert.equal(await second, 'saved')
      assert.equal(most, 1)
    },
  )
})

test('a 200 whose body cannot be read is still a save', async () => {
  // The server holds the write. Rolling back would put the edit back in the
  // owner's hands as lost, and a retry would apply it twice.
  await loaded(
    (url, init) =>
      init?.method === 'PUT'
        ? { ok: true, status: 200, json: async () => { throw new SyntaxError('truncated') } }
        : fakeResponse(structuredClone(BOARD)),
    async (sync) => {
      assert.equal(await sync.mutate(noteAdder('a', 'landed')), 'saved')
      assert.deepEqual(sync.doc.cards[0].notes.map((n) => n.text), ['landed'])
    },
  )
})
