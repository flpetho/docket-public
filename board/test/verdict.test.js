import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { latestVerdict, verdictDate } from '../ui/verdict.js'

const note = (text, at) => ({ author: 'claude', at, text })

test('no notes at all is no verdict', () => {
  assert.equal(latestVerdict([]), null)
  assert.equal(latestVerdict(), null)
  assert.equal(latestVerdict(undefined), null)
})

test('a thread with no verdict note is no verdict', () => {
  assert.equal(
    latestVerdict([note('built the thing', '2026-08-21T01:00:00Z'), note('and tested it', '2026-08-21T02:00:00Z')]),
    null,
  )
})

test('meets reads as met, fails reads as failed', () => {
  assert.equal(latestVerdict([note('VERDICT: meets\nall clauses met', '2026-08-21T01:00:00Z')]).word, 'met')
  assert.equal(latestVerdict([note('VERDICT: fails\nclause 3', '2026-08-21T01:00:00Z')]).word, 'failed')
})

test('the verdict carries its date', () => {
  const ruling = latestVerdict([note('VERDICT: meets', '2026-08-21T01:00:00Z')])
  assert.equal(ruling.at, '2026-08-21T01:00:00Z')
})

test('failed, then fixed, then met reads as met', () => {
  // The clause that a naive "first match wins" implementation gets wrong.
  const ruling = latestVerdict([
    note('VERDICT: fails\nclause 2: not met', '2026-08-21T01:00:00Z'),
    note('fixed the wrapping', '2026-08-21T02:00:00Z'),
    note('VERDICT: meets\nre-ran, clause 2 now met', '2026-08-21T03:00:00Z'),
  ])
  assert.equal(ruling.verdict, 'meets')
  assert.equal(ruling.at, '2026-08-21T03:00:00Z')
})

test('newest by timestamp, not by array position', () => {
  // Relying on push order would be relying on an accident.
  const ruling = latestVerdict([
    note('VERDICT: meets', '2026-08-21T03:00:00Z'),
    note('VERDICT: fails', '2026-08-21T01:00:00Z'),
  ])
  assert.equal(ruling.verdict, 'meets')
})

test('prose about a verdict is not a verdict', () => {
  // The near-miss the contract asks for by name.
  for (const text of [
    'I disagree with the verdict on this one',
    'the verdict: it needs more work',
    'see the VERDICT note above',
    'Ran the tests. VERDICT: meets was written on the other card, not this one.',
  ]) {
    assert.equal(latestVerdict([note(text, '2026-08-21T01:00:00Z')]), null, text)
  }
})

test('leading whitespace before the first line is tolerated', () => {
  assert.equal(latestVerdict([note('\n  VERDICT: fails\nbecause', '2026-08-21T01:00:00Z')]).verdict, 'fails')
})

test('a note missing its timestamp still parses, with a null date', () => {
  const ruling = latestVerdict([note('VERDICT: meets', undefined)])
  assert.equal(ruling.verdict, 'meets')
  assert.equal(ruling.at, null) // normalised, so the renderer has one absent case
  assert.equal(verdictDate(ruling.at), '')
})

test('the date is short enough to sit beside the unread dot', () => {
  assert.equal(verdictDate('2026-08-21T01:00:00Z').length <= 6, true)
  assert.equal(verdictDate('nonsense'), '')
  assert.equal(verdictDate(undefined), '')
})

test('the shape matched is the one the verifier is told to write', () => {
  // Guards against the agent spec and this parser drifting apart: if the spec's
  // documented shape changes, this fails rather than the board quietly showing
  // nothing after every future run.
  const spec = readFileSync(
    fileURLToPath(new URL('../../.claude/agents/docket-verifier.md', import.meta.url)),
    'utf8',
  )
  assert.match(spec, /^VERDICT: meets \| fails$/m)
  for (const word of ['meets', 'fails']) {
    assert.ok(latestVerdict([note(`VERDICT: ${word}\nRan: npm test`, '2026-08-21T01:00:00Z')]))
  }
})
