import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { cardVanished, trapIndex, unsavedParts } from '../ui/modal.js'

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

test('an open note editor counts, on its own and alongside the others', () => {
  // The third thing a Close or an Escape must not discard silently — same
  // family as an unsaved draft and a typed note, and it composes with both.
  assert.deepEqual(
    unsavedParts({ draft: null, draftDetailAtOpen: '', noteText: '', editing: true }),
    ['an edit in progress'],
  )
  assert.deepEqual(
    unsavedParts({ draft: null, draftDetailAtOpen: '', noteText: '', editing: false }),
    [],
  )
  assert.deepEqual(
    unsavedParts({ draft: draft({ title: 'x' }), draftDetailAtOpen: '', noteText: 'and a note', editing: true }),
    ['this card', 'a note', 'an edit in progress'],
  )
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

/**
 * The open card vanished — deleted, or moved to another board — versus the cases
 * that look the same from outside because the card is legitimately absent. Both
 * pages call refresh(cardById(openId)), so all refresh ever sees is "no card".
 * Card b2o5: the owner ruled freeze-with-banner, never a silent close.
 */
const gone = (over = {}) => ({ openId: 'card-a', isDraft: false, creating: false, card: null, ...over })

test('an open committed card missing from the document has vanished', () => {
  assert.equal(cardVanished(gone()), true)
})

test('a draft is absent from the board on purpose and has not vanished', () => {
  assert.equal(cardVanished(gone({ isDraft: true })), false)
})

test('a draft mid-commit is not yet on the board and has not vanished', () => {
  // commitDraft clears the draft before onCreate lands; a frame in that window
  // must not freeze the card the owner is in the middle of adding.
  assert.equal(cardVanished(gone({ creating: true })), false)
})

test('nothing open means nothing vanished', () => {
  assert.equal(cardVanished(gone({ openId: null })), false)
})

test('a card still in the document has not vanished', () => {
  assert.equal(cardVanished(gone({ card: { id: 'card-a' } })), false)
})

test('a frozen panel refuses every write path, keyboard ones included', () => {
  // A read-only textarea still takes ⌘↵, and a read-only input still submits
  // its form on Enter — so disabling buttons is not enough on its own.
  assert.match(src, /const applyEdit = \(fn\) => \{\s*\n\s*if \(gone\) return/)
  assert.match(src, /const commitNote = async \(\) => \{\s*\n\s*if \(gone\) return/)
  assert.match(src, /const commitTodo = async \(\) => \{\s*\n\s*if \(gone\) return/)
  assert.match(src, /timeForm\?\.addEventListener\('submit'[\s\S]{0,120}if \(!openId \|\| draft \|\| gone\) return/)
})

test('the offline disable lives in the modal, so it cannot re-enable a frozen panel', () => {
  // Both pages used to toggle four panel controls on EVERY status change. The
  // status that follows a vanishing card ("updated elsewhere") re-enabled them
  // the instant after the freeze. One owner of the disabled state: the modal.
  for (const page of ['app.js', 'dashboard.js']) {
    const text = readFileSync(fileURLToPath(new URL(`../ui/${page}`, import.meta.url)), 'utf8')
    assert.doesNotMatch(text, /toggleAttribute\('disabled'/, `${page} still reaches into the panel`)
    assert.match(text, /modal\?\.setOffline\(kind === 'offline'\)/, `${page} does not tell the modal`)
  }
  assert.match(src, /disabled = offline \|\| gone/)
})

test('the write paths that fire before applyEdit also refuse while frozen', () => {
  // Found by review: ⌘↵ in an open note editor reached onEditNote and rebuilt
  // a live editor inside the frozen panel; Enter in the tag field cleared the
  // owner's typed tag before applyEdit refused it; a paste still uploaded a
  // blob; an open Board list still posted a move.
  assert.match(src, /const commit = async \(\) => \{\s*\n\s*if \(gone\) return/)
  assert.match(src, /elements\.tagInput\.addEventListener\('keydown', \(event\) => \{\s*\n\s*if \(gone\) return/)
  assert.match(src, /const upload = async \(blob\) => \{[\s\S]{0,200}if \(!openId \|\| gone\) return/)
  assert.match(src, /if \(!openId \|\| draft \|\| gone \|\| to === project\) return/)
})

// The panel is aria-modal, but Tab walked straight out of it into the board
// behind. The wrap is pure so it can be tested without a browser.
test('Tab from the last control wraps to the first', () => {
  assert.equal(trapIndex(4, 5, false), 0)
})

test('Shift+Tab from the first control wraps to the last', () => {
  assert.equal(trapIndex(0, 5, true), 4)
})

test('Tab in the middle is left to the browser', () => {
  assert.equal(trapIndex(2, 5, false), null)
  assert.equal(trapIndex(2, 5, true), null)
})

test('focus outside the panel is pulled back in', () => {
  assert.equal(trapIndex(-1, 5, false), 0)
  assert.equal(trapIndex(-1, 5, true), 4)
})

test('focus inside the panel but not in the list is left to the browser', () => {
  // The Loop Contract's <summary> is focusable natively. Read as "outside", Tab
  // from it jumped back to Title and the contract fields were unreachable.
  assert.equal(trapIndex(-1, 5, false, true), null)
  assert.equal(trapIndex(-1, 5, true, true), null)
})

test('a panel with nothing focusable traps nothing', () => {
  assert.equal(trapIndex(-1, 0, false), null)
})

test('Escape closes the panel on both pages, from the modal, exactly once', () => {
  // The board had it in app.js; the dashboard never did. It lives in the
  // shared modal now, and app.js must not also close, or a declined
  // "Discard …?" would be asked a second time.
  // Anchored to the modal's own handler: a loose match also hit the note
  // editor's Escape, which closes the editor, and passed with this one deleted.
  assert.match(src, /if \(elements\.overlay\.hidden\) return\n\s*if \(event\.key === 'Escape'\) return void close\(\)/)
  const app = readFileSync(fileURLToPath(new URL('../ui/app.js', import.meta.url)), 'utf8')
  assert.doesNotMatch(app, /Escape/)
})
