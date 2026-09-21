import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { unsavedParts } from '../ui/modal.js'

const src = readFileSync(fileURLToPath(new URL('../ui/modal.js', import.meta.url)), 'utf8')

/**
 * The draft-versus-committed decision. Exported and tested because a gate pointed
 * out it had shipped as a closure with no coverage at all — and that is exactly
 * how three handlers that still wrote to the board from a draft got through.
 */

const draft = (over = {}) => ({ title: '', detail: '', ...over })

test('an untouched draft has nothing to lose, so nothing is asked', () => {
  assert.deepEqual(unsavedParts({ draft: draft(), draftDetailAtOpen: '', noteText: '' }), [])
})

test('an untouched draft in the work column is still untouched', () => {
  // The trap: that column pre-fills the contract skeleton, so a draft opens with
  // a detail already in it. Comparing against the detail AS OPENED is what stops
  // a pointless question every single time [+] is pressed there.
  const skeleton = 'Objective:\nAcceptance:\nVerify with:\n'
  assert.deepEqual(
    unsavedParts({ draft: draft({ detail: skeleton }), draftDetailAtOpen: skeleton, noteText: '' }),
    [],
  )
})

test('a typed title counts', () => {
  assert.deepEqual(unsavedParts({ draft: draft({ title: 'x' }), draftDetailAtOpen: '', noteText: '' }), ['this card'])
})

test('whitespace is not content', () => {
  assert.deepEqual(unsavedParts({ draft: draft({ title: '   \n\t ' }), draftDetailAtOpen: '', noteText: '' }), [])
  assert.deepEqual(unsavedParts({ draft: null, draftDetailAtOpen: '', noteText: '  \n ' }), [])
})

test('a detail changed from what it opened with counts', () => {
  const skeleton = 'Objective:\nAcceptance:\n'
  assert.deepEqual(
    unsavedParts({ draft: draft({ detail: skeleton + 'the actual objective' }), draftDetailAtOpen: skeleton, noteText: '' }),
    ['this card'],
  )
})

test('a typed note counts, on a draft or on a committed card', () => {
  assert.deepEqual(unsavedParts({ draft: null, draftDetailAtOpen: '', noteText: 'half a thought' }), ['a note'])
  assert.deepEqual(
    unsavedParts({ draft: draft({ title: 'x' }), draftDetailAtOpen: '', noteText: 'and a note' }),
    ['this card', 'a note'],
  )
})

test('a committed card with an empty note box asks nothing', () => {
  // Closing a saved card must never interrupt: there is nothing unsaved.
  assert.deepEqual(unsavedParts({ draft: null, draftDetailAtOpen: '', noteText: '' }), [])
})

test('missing or malformed input does not throw', () => {
  for (const args of [
    {},
    { draft: null },
    { draft: draft({ title: undefined }), draftDetailAtOpen: undefined, noteText: undefined },
  ]) {
    assert.ok(Array.isArray(unsavedParts(args)), JSON.stringify(args))
  }
})

test('EVERY board-writing handler in the modal goes through applyEdit', () => {
  // The defect a gate found and no clause covered: the tag chip's ×, the
  // attachment remove, and the upload still called onChange directly, so a draft
  // interaction reached the board file and bumped its rev for a no-op.
  // applyEdit is the single seam, so onChange must appear exactly once — inside it.
  const calls = src.match(/\bonChange\(/g) ?? []
  assert.equal(calls.length, 1, `onChange should be called once, inside applyEdit; found ${calls.length}`)
  assert.match(src, /const applyEdit = \(fn\) => \{[\s\S]*?onChange\(openId, fn\)/)
})

test('an attachment is refused on a draft rather than written for a card that may not exist', () => {
  // Uploading first would put bytes in .docket/attachments/ for a draft the owner
  // might discard. Same rule as a note: add the card first.
  assert.match(src, /const upload = async \(blob\) => \{\s*\n\s*if \(draft\)/)
})
