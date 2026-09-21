import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BRIEF_FIELDS,
  LOOP_BRIEF,
  LOOP_COLUMN,
  briefWarning,
  hasBriefHeadings,
  isBlankBrief,
  parseBrief,
  splitBrief,
  joinBrief,
} from '../ui/brief.js'

test('the skeleton carries every heading and nothing else', () => {
  assert.equal(LOOP_BRIEF.trim().split('\n').length, BRIEF_FIELDS.length)
  for (const field of BRIEF_FIELDS) {
    assert.match(LOOP_BRIEF, new RegExp(`^${field.label.replace("'", "'")}:$`, 'm'))
  }
})

test('exactly the two load-bearing headings are required', () => {
  assert.deepEqual(
    BRIEF_FIELDS.filter((f) => f.required).map((f) => f.label),
    ['Acceptance', 'Verify with'],
  )
})

test('an untouched skeleton counts as blank', () => {
  assert.equal(isBlankBrief(LOOP_BRIEF), true)
  assert.equal(isBlankBrief(''), true)
  assert.equal(isBlankBrief('   \n  '), true)
  assert.equal(isBlankBrief(undefined), true)
})

test('a skeleton with one heading filled is no longer blank', () => {
  assert.equal(isBlankBrief(`${LOOP_BRIEF}`.replace('Objective:', 'Objective: ship it')), false)
})

test('free-form detail that is not a brief counts as written, not blank', () => {
  assert.equal(isBlankBrief('Small motion on the cards themselves.'), false)
})

test('a complete brief parses and reports nothing missing', () => {
  const detail = [
    'Objective: Cards respond to hover without a library.',
    'Acceptance: hover raises the border to --hair-lit within 120ms.',
    'Verify with: pnpm ui-check',
    'Must not break: the entrance keyframe.',
    'Pointers: src/canvas/*Node.tsx',
    'If blocked: escalate to Waiting on you.',
  ].join('\n')

  const brief = parseBrief(detail)
  assert.equal(brief.complete, true)
  assert.deepEqual(brief.missing, [])
  assert.equal(brief.values.objective, 'Cards respond to hover without a library.')
  assert.equal(brief.values.verifyWith, 'pnpm ui-check')
  assert.equal(brief.values.mustNotBreak, 'the entrance keyframe.')
  assert.equal(brief.values.pointers, 'src/canvas/*Node.tsx')
})

test('an unrecognised heading is absorbed into the field above it', () => {
  // Free text under a heading is kept whole, which means a made-up label is not
  // silently dropped — it stays visible as part of the preceding field.
  const brief = parseBrief('Acceptance: it works\nWhere: src/thing.js\nVerify with: npm test')
  assert.match(brief.values.acceptance, /Where: src\/thing\.js/)
  assert.equal(brief.complete, true)
})

test('a brief missing a done-condition is reported incomplete', () => {
  const brief = parseBrief('Objective: do the thing\nVerify with: npm test')
  assert.equal(brief.complete, false)
  assert.deepEqual(brief.missing, ['Acceptance'])
})

test('a brief missing the verify command is reported incomplete', () => {
  const brief = parseBrief('Acceptance: the tests pass')
  assert.equal(brief.complete, false)
  assert.deepEqual(brief.missing, ['Verify with'])
})

test('an empty heading counts as missing, not as present-but-blank', () => {
  const brief = parseBrief('Acceptance:\nVerify with: npm test')
  assert.deepEqual(brief.missing, ['Acceptance'])
})

test('multi-line content under a heading is kept whole', () => {
  const brief = parseBrief(
    ['Acceptance:', '  - the suite is green', '  - no card moves column', 'Verify with: npm test'].join(
      '\n',
    ),
  )
  assert.match(brief.values.acceptance, /suite is green/)
  assert.match(brief.values.acceptance, /no card moves column/)
  assert.equal(brief.values.verifyWith, 'npm test')
})

test('headings are matched case-insensitively, since nobody types consistently at 11pm', () => {
  const brief = parseBrief('acceptance: it works\nVERIFY WITH: npm test')
  assert.equal(brief.complete, true)
})

test('free-form detail with no headings is simply incomplete, not an error', () => {
  const brief = parseBrief('Small motion on the cards, beyond the entrance animation.')
  assert.equal(brief.complete, false)
  assert.deepEqual(brief.missing, ['Acceptance', 'Verify with'])
})

test("a multi-word heading with spaces parses correctly", () => {
  const brief = parseBrief("Acceptance: x\nVerify with: y\nMust not break: the zero-dependency rule")
  assert.equal(brief.values.mustNotBreak, 'the zero-dependency rule')
  assert.equal(brief.complete, true)
})

test('hasBriefHeadings spots a heading anywhere in the text', () => {
  assert.equal(hasBriefHeadings('some prose\nVerify with: npm test'), true)
  assert.equal(hasBriefHeadings('just prose'), false)
  assert.equal(hasBriefHeadings(''), false)
})

// ---- briefWarning: what the board says about a contract -------------------

test('a card outside Loop never warns, however thin its detail', () => {
  for (const column of ['inbox', 'next', 'progress', 'review', 'done', 'waiting']) {
    assert.equal(briefWarning(column, ''), null, column)
    assert.equal(briefWarning(column, LOOP_BRIEF), null, column)
  }
})

test('an empty Loop detail names both required headings', () => {
  assert.deepEqual(briefWarning(LOOP_COLUMN, '').missing, ['Acceptance', 'Verify with'])
})

test('an untouched skeleton reads as incomplete, not complete', () => {
  // The trap: all six headings are present, so anything checking for headings
  // rather than for content would call this ready to work unattended.
  const warning = briefWarning(LOOP_COLUMN, LOOP_BRIEF)
  assert.ok(warning, 'an untouched skeleton must warn')
  assert.deepEqual(warning.missing, ['Acceptance', 'Verify with'])
})

test('one required heading filled still warns, naming only the other', () => {
  const warning = briefWarning(LOOP_COLUMN, 'Acceptance: the thing works')
  assert.deepEqual(warning.missing, ['Verify with'])
  assert.match(warning.label, /Verify with/)
  assert.doesNotMatch(warning.label, /Acceptance/)
})

test('both required headings filled is silence', () => {
  assert.equal(
    briefWarning(LOOP_COLUMN, 'Acceptance: it works\nVerify with: npm test'),
    null,
  )
})

test('the optional headings are never required', () => {
  // Only Acceptance and Verify with do damage by their absence; a contract with
  // no Pointers is terse, not broken.
  assert.equal(briefWarning(LOOP_COLUMN, 'Acceptance: a\nVerify with: b'), null)
})

test('the warning agrees with parseBrief exactly', () => {
  // The property that matters: one definition of complete, not two.
  for (const detail of ['', LOOP_BRIEF, 'Acceptance: a', 'Acceptance: a\nVerify with: b']) {
    const parsed = parseBrief(detail)
    const warning = briefWarning(LOOP_COLUMN, detail)
    assert.equal(warning === null, parsed.complete, JSON.stringify(detail))
    if (warning) assert.deepEqual(warning.missing, parsed.missing)
  }
})

// ---- The guide: every heading explains itself, and none of it can leak into a detail ----
// (spec 2026-09-15). The hints were on the fields from the start and never shown; the
// examples join them here, and the panel finally renders both.

test('every heading carries a hint and an example, and the required two show the trap', () => {
  for (const field of BRIEF_FIELDS) {
    assert.ok(field.hint?.trim(), `${field.label} has a hint`)
    assert.ok(field.example?.trim(), `${field.label} has an example`)
    if (field.required) {
      assert.ok(field.weak?.trim(), `${field.label} shows a clause a stub could pass`)
      assert.ok(field.why?.trim(), `${field.label} says why the weak one is weak`)
    } else {
      assert.equal(field.weak, undefined, `${field.label} needs no weak clause`)
    }
  }
})

test('no guide text can manufacture a heading if pasted into a detail', () => {
  for (const field of BRIEF_FIELDS) {
    for (const text of [field.hint, field.example, field.weak, field.why].filter(Boolean)) {
      assert.equal(hasBriefHeadings(text), false, `${field.label}: ${text.slice(0, 40)}…`)
    }
  }
})

test('the guide changes nothing about what lands in a detail', () => {
  assert.equal(LOOP_BRIEF, 'Objective:\nAcceptance:\nVerify with:\nMust not break:\nPointers:\nIf blocked:\n')
  assert.equal(parseBrief(LOOP_BRIEF).complete, false)
})

// ---- The contract as fields: split out of the detail, join back into it (spec 2026-09-16) ----
// The detail text stays the only source. Fields are a view; these two are the seam.

const MOVE = `Objective: a card that landed on the wrong board can be sent to the right one from its panel.

Rulings (owner, 2026-09-11): lands in Inbox; the writes run in the daemon.

Acceptance:
1. Choosing B closes the panel and the card is gone from A.
2. A test fails the source write and asserts the card is on BOTH boards.

Verify with:
cd board && npm test
node board/bin/docket.js doctor

Must not break: store.js the only writer; the draft rule.

If blocked: escalate; no MCP tool, undo or bulk move.`

test('splitBrief separates the prose before the first heading from the six values', () => {
  const { prose, values } = splitBrief('Some prose the owner wrote first.\n\nObjective: ship it.\nAcceptance:\n1. a probe says so.\n2. a test pins it.\nVerify with: npm test')
  assert.equal(prose, 'Some prose the owner wrote first.')
  assert.equal(values.objective, 'ship it.')
  assert.equal(values.acceptance, '1. a probe says so.\n2. a test pins it.')
  assert.equal(values.verifyWith, 'npm test')
  assert.equal(values.mustNotBreak, '')
  assert.equal(values.pointers, '')
  assert.equal(values.ifBlocked, '')
})

test('a detail with no headings is all prose and six empty values', () => {
  assert.deepEqual(splitBrief('Just a thought.'), {
    prose: 'Just a thought.',
    values: { objective: '', acceptance: '', verifyWith: '', mustNotBreak: '', pointers: '', ifBlocked: '' },
  })
  assert.equal(splitBrief('').prose, '')
})

test('joinBrief writes headings in canonical order, omits empty ones, inline when single-line', () => {
  const detail = joinBrief('Prose.', { verifyWith: 'npm test', objective: 'ship it.', acceptance: '1. a\n2. b', mustNotBreak: '', pointers: '', ifBlocked: '' })
  assert.equal(detail, 'Prose.\n\nObjective: ship it.\nAcceptance:\n1. a\n2. b\nVerify with: npm test')
})

test('joinBrief with nothing to say is the prose alone, and nothing at all is the empty string', () => {
  const none = { objective: '', acceptance: '', verifyWith: '', mustNotBreak: '', pointers: '', ifBlocked: '' }
  assert.equal(joinBrief('Only prose.', none), 'Only prose.')
  assert.equal(joinBrief('', none), '')
  assert.equal(joinBrief('', { ...none, objective: 'x' }), 'Objective: x')
})

test('the round-trip keeps every value and every heading, and is stable after one normalisation', () => {
  const once = joinBrief(splitBrief(MOVE).prose, splitBrief(MOVE).values)
  const twice = joinBrief(splitBrief(once).prose, splitBrief(once).values)
  assert.equal(twice, once, 'normalising a normalised detail changes nothing')
  assert.deepEqual(parseBrief(once).values, parseBrief(MOVE).values, 'the parser sees identical values before and after')
  assert.equal(splitBrief(once).prose, splitBrief(MOVE).prose)
  assert.equal(parseBrief(once).complete, true)
})

test('a field edit rewrites one heading and leaves the prose and the others byte-identical', () => {
  const { prose, values } = splitBrief(MOVE)
  const edited = joinBrief(prose, { ...values, verifyWith: 'cd board && npm test' })
  const back = splitBrief(edited)
  assert.equal(back.prose, prose)
  assert.equal(back.values.verifyWith, 'cd board && npm test')
  for (const key of ['objective', 'acceptance', 'mustNotBreak', 'pointers', 'ifBlocked']) assert.equal(back.values[key], values[key], key)
})
