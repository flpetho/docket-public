import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PANEL_HTML, injectPanel, panelElements } from '../ui/panel.js'

/**
 * The card panel's markup left index.html on 2026-09-18 so the time dashboard
 * could mount the same modal from one copy. The seam that move created is the
 * element map: modal.js queries nothing itself, so if an id in the markup and
 * an id in the map ever disagree, the panel loses a control with no error
 * anywhere — and the board suite has no DOM to notice.
 *
 * These tests are that seam, and they need no DOM: panelElements and
 * injectPanel both take their document, so a fake object is enough to
 * exercise them for real rather than grep their source.
 */

const read = (name) => readFileSync(fileURLToPath(new URL(`../ui/${name}`, import.meta.url)), 'utf8')

/** Every `id="..."` in a piece of markup. */
const idsIn = (markup) => [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1])

/** A document that answers getElementById with the id itself. */
const fakeDoc = (present = null) => ({
  getElementById: (id) => (present === null || present.includes(id) ? id : null),
})

test('every element the map asks for is actually in the markup', () => {
  // The whole point. A renamed or deleted element in PANEL_HTML, or a typo in
  // the map, turns one control into undefined — and modal.js guards some of
  // its elements with `?.`, so several would fail silently rather than throw.
  const present = new Set(idsIn(PANEL_HTML))
  const map = panelElements(fakeDoc())
  const missing = Object.entries(map)
    .filter(([, id]) => !present.has(id))
    .map(([key, id]) => `${key} → id="${id}"`)
  assert.deepEqual(missing, [], `the map names ids the markup does not have: ${missing.join(', ')}`)
})

test('the map reaches every element modal.js reads', () => {
  // The other direction: modal.js asking for a key the map never sets. Only
  // contractStatus is exempt — modal.js creates that element itself and
  // assigns it onto the map at runtime, which is why it is not markup.
  const asked = new Set([...read('modal.js').matchAll(/elements\.([A-Za-z]+)/g)].map((m) => m[1]))
  asked.delete('contractStatus')
  const provided = new Set(Object.keys(panelElements(fakeDoc())))
  const missing = [...asked].filter((key) => !provided.has(key))
  assert.deepEqual(missing, [], `modal.js reads elements the map does not provide: ${missing.join(', ')}`)
})

test('panelElements takes its document rather than reaching for a global', () => {
  // It is called on two pages and in this test. A hardcoded `document` would
  // work in both browsers and fail only here, which is the wrong way round.
  const map = panelElements(fakeDoc())
  assert.equal(map.title, 'f-title')
  assert.equal(map.commit, 'f-close')
  assert.equal(map.overlay, 'overlay')
})

test('a missing element becomes null, not a throw', () => {
  // A page served by an older daemon could hold stale markup. The map must
  // still build, because modal.js decides per element what it can do without.
  const map = panelElements(fakeDoc(['overlay', 'panel', 'f-title']))
  assert.equal(map.title, 'f-title')
  assert.equal(map.due, null)
})

test('no id appears twice in the markup', () => {
  // Two pages mount this. A duplicate id would make getElementById pick one
  // and leave the other permanently dead.
  const ids = idsIn(PANEL_HTML)
  const seen = new Set()
  const twice = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)))
  assert.deepEqual(twice, [], `duplicate ids: ${twice.join(', ')}`)
})

test('injectPanel appends the markup’s children, not its wrapper', () => {
  // The wrapper is a scratch div used only to parse the string. Appending IT
  // would put an unstyled element between the flex body and #overlay, which
  // the CSS positions directly.
  const appended = []
  const holder = { children: ['a', 'b'], set innerHTML(value) { this._html = value }, get innerHTML() { return this._html } }
  const doc = { getElementById: () => null, createElement: () => holder }
  injectPanel({ append: (...nodes) => appended.push(...nodes) }, doc)
  assert.equal(holder.innerHTML, PANEL_HTML, 'the markup goes in unmodified')
  assert.deepEqual(appended, ['a', 'b'])
})

test('injectPanel is idempotent — a second mount adds nothing', () => {
  // Both pages call it through mountPanel, and a page that called it twice
  // would otherwise duplicate every id in the document.
  const appended = []
  const doc = { getElementById: (id) => (id === 'overlay' ? 'already here' : null), createElement: () => ({}) }
  injectPanel({ append: (...nodes) => appended.push(...nodes) }, doc)
  assert.deepEqual(appended, [], 'nothing is appended when an overlay is already present')
})

test('the panel markup is the only copy — index.html no longer holds it', () => {
  // The reason for the move. Two copies of 39 ids would drift, which is why
  // tag-color.js and brief.js are shared with the server rather than retyped.
  assert.doesNotMatch(read('index.html'), /id="overlay"/)
  assert.doesNotMatch(read('dashboard.html'), /id="overlay"/)
  assert.match(PANEL_HTML, /id="overlay"/)
})

test('the markup carries no script tag', () => {
  // It is assigned through innerHTML. A script there would not execute, so one
  // appearing would be a silently dead instruction rather than a live one.
  assert.doesNotMatch(PANEL_HTML, /<script/i)
})

test('the markup did not lose a chunk in the move', () => {
  // A truncated template literal still parses and still mounts. The bottom of
  // the panel is the part a partial lift would drop, so name both ends.
  assert.match(PANEL_HTML, /id="overlay"/)
  assert.match(PANEL_HTML, /id="f-title"/)
  assert.match(PANEL_HTML, /id="f-delete"/)
  assert.match(PANEL_HTML, /id="f-close"/)
  assert.ok(idsIn(PANEL_HTML).length >= 39, `expected the whole panel, found ${idsIn(PANEL_HTML).length} ids`)
})
