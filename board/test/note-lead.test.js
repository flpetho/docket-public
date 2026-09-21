import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitNote } from '../ui/note-lead.js'

// The first paragraph is the TL;DR, by convention (decision log, 2026-09-11).
// Both renderers import this, so the two cannot cut a note in different places.

test('a note with no blank line is all lead and no rest', () => {
  assert.deepEqual(splitNote('one paragraph, however long it runs'), {
    lead: 'one paragraph, however long it runs',
    rest: '',
  })
})

test('the first blank line is the cut; the rest keeps its own paragraphs', () => {
  assert.deepEqual(splitNote('VERDICT: fails\n\nRan: x → y\n\nRegressions: none'), {
    lead: 'VERDICT: fails',
    rest: 'Ran: x → y\n\nRegressions: none',
  })
})

test('surrounding whitespace, CRLF endings, and a blank line made of spaces do not change the cut', () => {
  assert.deepEqual(splitNote('  lead\r\n  \r\nrest  '), { lead: 'lead', rest: 'rest' })
  assert.deepEqual(splitNote('\n\nlead\n\nrest\n\n'), { lead: 'lead', rest: 'rest' })
})

test('a single newline is a line break inside the lead, not a paragraph break', () => {
  assert.deepEqual(splitNote('line one\nline two'), { lead: 'line one\nline two', rest: '' })
})

test('nothing in, nothing out', () => {
  assert.deepEqual(splitNote(''), { lead: '', rest: '' })
  assert.deepEqual(splitNote(undefined), { lead: '', rest: '' })
})
