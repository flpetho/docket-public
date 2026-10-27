import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STRIKES, strikesFor } from '../ui/verdict.js'

// Three strikes, counted from the card's own verdicts (2026-10-27, card p864).
// A strike is a fails verdict since the card last entered Loop: the owner
// moving it back in after an escalation starts a fresh count.

const loop = (verdicts, columnSince = '2026-10-27T10:00:00.000Z') => ({ column: 'loop', columnSince, verdicts })
const fails = (at) => ({ result: 'fails', at, evidence: 'e' })

test('three, spelled once', () => {
  assert.equal(STRIKES, 3)
})

test('fails since the card entered Loop count; meets and earlier fails do not', () => {
  const card = loop([
    fails('2026-10-26T09:00:00.000Z'),
    fails('2026-10-27T11:00:00.000Z'),
    { result: 'meets', at: '2026-10-27T12:00:00.000Z', evidence: 'e' },
    fails('2026-10-27T13:00:00.000Z'),
  ])
  assert.equal(strikesFor(card), 2)
})

test('a verdict at the very moment the card entered Loop counts', () => {
  assert.equal(strikesFor(loop([fails('2026-10-27T10:00:00.000Z')])), 1)
})

test('a card outside Loop has no strikes, and neither does one with no verdicts', () => {
  assert.equal(strikesFor({ ...loop([fails('2026-10-27T11:00:00.000Z')]), column: 'waiting' }), 0)
  assert.equal(strikesFor(loop(undefined)), 0)
})

test('a Loop card with no columnSince counts every fails', () => {
  assert.equal(strikesFor(loop([fails('2026-01-01T00:00:00.000Z'), fails('2026-10-27T11:00:00.000Z')], null)), 2)
})

test('the chip word carries the strikes only for a failed card in Loop', async () => {
  const { chipWord } = await import('../ui/verdict.js')
  const card = loop([fails('2026-10-27T11:00:00.000Z'), fails('2026-10-27T12:00:00.000Z')])
  assert.deepEqual(chipWord({ verdict: 'fails', word: 'failed' }, card), { word: 'failed 2/3', strikes: 2 })
  assert.deepEqual(chipWord({ verdict: 'meets', word: 'met' }, card), { word: 'met', strikes: 0 })
  assert.deepEqual(chipWord({ verdict: 'fails', word: 'failed' }, { ...card, column: 'waiting' }), { word: 'failed', strikes: 0 })
})
