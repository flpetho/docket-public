import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PHONE_MAX, PHONE_QUERY, columnAtScroll, positionLabel, stepIndex } from '../ui/phone.js'

const css = readFileSync(fileURLToPath(new URL('../ui/style.css', import.meta.url)), 'utf8')
const read = (name) => readFileSync(fileURLToPath(new URL(`../ui/${name}`, import.meta.url)), 'utf8')
/** index.html holds the chrome; panel.js holds the card panel (see dropdown.test.js). */
const BOARD_MARKUP = `${read('index.html')}\n${read('panel.js')}`

test('the breakpoint exists in exactly one place in the CSS', () => {
  // Clause 5 of the contract: one documented threshold, not a scattering of
  // media queries that disagree. Asserted rather than promised.
  const queries = css.match(/@media[^{]+/g) ?? []
  assert.equal(queries.length, 1, `expected one media query, found ${queries.length}: ${queries}`)
  assert.match(queries[0], new RegExp(`max-width:\\s*${PHONE_MAX}px`))
})

test('the CSS breakpoint and PHONE_MAX cannot drift apart', () => {
  // The number lives in JS and is repeated once in CSS, which a media query
  // forces (custom properties are not allowed there). This is the seam.
  assert.match(css, new RegExp(`max-width:\\s*${PHONE_MAX}px`))
  assert.equal(PHONE_QUERY, `(max-width: ${PHONE_MAX}px)`)
})

test('a phone viewport is inside the breakpoint and a laptop is outside', () => {
  assert.ok(390 <= PHONE_MAX, 'iPhone-class width must get the phone layout')
  assert.ok(1024 > PHONE_MAX, 'a laptop must not')
})

test('the resting column is the nearest snap position', () => {
  assert.equal(columnAtScroll(0, 390, 7), 0)
  assert.equal(columnAtScroll(390, 390, 7), 1)
  assert.equal(columnAtScroll(1170, 390, 7), 3)
  // Mid-swipe, before the snap settles.
  assert.equal(columnAtScroll(200, 390, 7), 1)
  assert.equal(columnAtScroll(189, 390, 7), 0)
})

test('the resting column never leaves the board', () => {
  assert.equal(columnAtScroll(99999, 390, 7), 6)
  assert.equal(columnAtScroll(-40, 390, 7), 0)
})

test('a zero-width or empty board does not divide by nothing', () => {
  assert.equal(columnAtScroll(100, 0, 7), 0)
  assert.equal(columnAtScroll(100, 390, 0), 0)
})

test('stepping clamps at both ends rather than wrapping', () => {
  // Wrapping from Done back to Inbox would lose the reader's place in a
  // sequence whose whole point is order.
  assert.equal(stepIndex(0, -1, 7), 0)
  assert.equal(stepIndex(6, 1, 7), 6)
  assert.equal(stepIndex(3, 1, 7), 4)
  assert.equal(stepIndex(3, -1, 7), 2)
  assert.equal(stepIndex(0, -1, 0), 0)
})

test('the label names the column and says where it sits', () => {
  // Clause 2: a swipe-only design leaves no way to know where you are.
  assert.equal(positionLabel('Loop', 3, 7), 'Loop · 4 of 7')
  assert.equal(positionLabel('Inbox', 0, 7), 'Inbox · 1 of 7')
  assert.equal(positionLabel('Done', 6, 7), 'Done · 7 of 7')
})

test('the label survives a board with no columns', () => {
  assert.equal(positionLabel('', 0, 0), '')
})

test('the pager markup the wiring expects is present', () => {
  const html = readFileSync(fileURLToPath(new URL('../ui/index.html', import.meta.url)), 'utf8')
  for (const id of ['phone-nav', 'pn-prev', 'pn-next', 'pn-label']) {
    assert.match(html, new RegExp(`id="${id}"`), id)
  }
  // The position changes without a reload, so it has to be announced.
  assert.match(html, /id="pn-label"[^>]*aria-live="polite"/)
})

test('a note can be committed without a modifier key', () => {
  // The gate failed this card because ⌘↵ was the ONLY commit path, and an iOS
  // software keyboard cannot produce ⌘ or Ctrl — so the note field was a dead
  // end on a phone, which breaks "every card gets a note" exactly when the
  // owner is most likely to be holding one.
  const html = BOARD_MARKUP
  const modal = read('modal.js')

  assert.match(html, /id="f-note-add"/, 'a tappable commit path must exist in the markup')
  assert.match(modal, /noteAdd\?\.addEventListener\('click', commitNote\)/)
  // One commit path reached two ways, not two implementations that can diverge.
  // Counted on the CALL, not on its argument names — a previous version pinned
  // `onAddNote(openId, text)` verbatim and broke when the variable was renamed,
  // which tested the spelling rather than the property.
  assert.equal((modal.match(/const commitNote =/g) ?? []).length, 1)
  assert.equal((modal.match(/\bonAddNote\(/g) ?? []).length, 1)
})

test('the button is hidden on desktop and shown only under the breakpoint', () => {
  // Clause 4 of the phone card: desktop behaviour unchanged.
  const [beforeQuery, insideQuery] = css.split('@media')
  assert.match(beforeQuery, /#f-note-add\s*{\s*display:\s*none/)
  assert.match(insideQuery, /#f-note-add\s*{[^}]*display:\s*block/)
})

test('the note hint is not a dead instruction on a phone', () => {
  const html = BOARD_MARKUP
  const modal = read('modal.js')
  // No hardcoded ⌘↵ in the markup — the hint is chosen per viewport instead.
  assert.doesNotMatch(html, /placeholder="Add a note/)
  assert.match(modal, /matchMedia\(PHONE_QUERY\)/)
})
