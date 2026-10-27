import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLAUSE_OUTCOMES, clauseProblem, clauseLines } from '../ui/verdict.js'

test('the four outcome tokens, spelled exactly', () => {
  assert.deepEqual(CLAUSE_OUTCOMES, ['met', 'not_met', 'mismatch', 'not_evaluated'])
})

test('clauseProblem names what is wrong, and null when nothing is', () => {
  const ok = [{ clause: 'the panel closes', outcome: 'met', evidence: 'probe returned 0' }]
  assert.equal(clauseProblem(ok), null)
  assert.match(clauseProblem(undefined), /list/)
  assert.match(clauseProblem({}), /list/)
  assert.match(clauseProblem([null]), /clause 1/)
  assert.match(clauseProblem([{ clause: ' ', outcome: 'met', evidence: 'e' }]), /clause 1.*text/)
  assert.match(clauseProblem([...ok, { clause: 'c', outcome: 'passed', evidence: 'e' }]), /clause 2.*met \| not_met \| mismatch \| not_evaluated/)
  assert.match(clauseProblem([{ clause: 'c', outcome: 'not_evaluated', evidence: '' }]), /clause 1.*evidence/)
})

test('clauseLines renders one line per clause, outcome first, in the order given', () => {
  const text = clauseLines([
    { clause: 'the panel closes', outcome: 'met', evidence: 'probe returned 0' },
    { clause: 'a screenshot at 390', outcome: 'mismatch', evidence: 'a passing assertion arrived, no screenshot' },
  ])
  assert.equal(text, 'met — the panel closes: probe returned 0\nmismatch — a screenshot at 390: a passing assertion arrived, no screenshot')
})

test('a clause written over several lines stays on one rendered line', () => {
  assert.equal(clauseLines([{ clause: 'a\nb', outcome: 'not_met', evidence: 'x\n  y' }]), 'not_met — a b: x y')
})
