import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { actionFor, handleTriggerKey, nextIndex } from '../ui/dropdown.js'

const UI = (name) => readFileSync(fileURLToPath(new URL(`../ui/${name}`, import.meta.url)), 'utf8')
/**
 * The board's markup. The card panel moved out of index.html into panel.js on
 * 2026-09-18, so the dashboard could mount the same modal from one copy — the
 * markup is a template literal in that module now. These checks are about the
 * board's markup wherever it lives, so they read both. Deliberately NOT
 * dashboard.html: that page has its own native <select> card picker, and the
 * no-select rule below is about the panel's converted controls.
 */
const BOARD_MARKUP = `${UI('index.html')}\n${UI('panel.js')}`

test('the module imports with no document — the pure half is genuinely pure', () => {
  // If this file ran at all, the import above already proved it. Stated as a
  // test because it is the property that makes the rest of these possible:
  // board/ has no DOM harness and adding one would mean adding a dependency.
  assert.equal(typeof nextIndex, 'function')
  assert.equal(typeof actionFor, 'function')
})

test('ArrowDown walks forward and wraps at the end', () => {
  assert.equal(nextIndex(0, 'ArrowDown', 3), 1)
  assert.equal(nextIndex(1, 'ArrowDown', 3), 2)
  assert.equal(nextIndex(2, 'ArrowDown', 3), 0)
})

test('ArrowUp walks back and wraps at the start', () => {
  assert.equal(nextIndex(2, 'ArrowUp', 3), 1)
  assert.equal(nextIndex(0, 'ArrowUp', 3), 2)
})

test('nothing highlighted yet: down lands on the first, up on the last', () => {
  assert.equal(nextIndex(-1, 'ArrowDown', 3), 0)
  assert.equal(nextIndex(-1, 'ArrowUp', 3), 2)
})

test('Home and End jump to the ends', () => {
  assert.equal(nextIndex(1, 'Home', 4), 0)
  assert.equal(nextIndex(1, 'End', 4), 3)
})

test('an unclaimed key leaves the highlight alone', () => {
  assert.equal(nextIndex(1, 'x', 4), 1)
  assert.equal(nextIndex(1, 'PageDown', 4), 1)
})

test('an empty list cannot highlight anything', () => {
  assert.equal(nextIndex(-1, 'ArrowDown', 0), -1)
  assert.equal(nextIndex(0, 'End', 0), -1)
})

test('closed: the three opening keys open it and nothing else does', () => {
  for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) {
    assert.equal(actionFor(key, false), 'open', key)
  }
  for (const key of ['Escape', 'Tab', 'Home', 'End', 'a', '/']) {
    assert.equal(actionFor(key, false), null, key)
  }
})

test('open: movement, commit, cancel, and passthrough are distinct', () => {
  assert.equal(actionFor('ArrowDown', true), 'move')
  assert.equal(actionFor('End', true), 'move')
  assert.equal(actionFor('Enter', true), 'commit')
  assert.equal(actionFor(' ', true), 'commit')
  // cancel swallows, passthrough does not. That difference is the fix.
  assert.equal(actionFor('Escape', true), 'cancel')
  assert.equal(actionFor('Tab', true), 'passthrough')
})

test("the board's own shortcuts are never swallowed, open or closed", () => {
  // app.js listens on document for '/' and 'n'. Closed, the dropdown ignores
  // them entirely. Open, it closes itself and still lets them through — the
  // handler treats 'passthrough' without preventDefault or stopPropagation.
  for (const key of ['/', 'n', 'j', '?']) {
    assert.equal(actionFor(key, false), null, key)
    assert.equal(actionFor(key, true), 'passthrough', key)
  }
})

test('an open list never survives an unclaimed keypress', () => {
  // The defect this fixes: '/' propagated correctly and left the list open with
  // focus in the search box. Every key while open now resolves to an action, so
  // there is no branch that leaves the list up.
  const keys = ['/', 'n', 'Tab', 'Escape', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'q', 'F5']
  for (const key of keys) {
    const action = actionFor(key, true)
    assert.notEqual(action, null, `${key} must resolve to an action while open`)
    assert.ok(
      ['move', 'commit', 'cancel', 'passthrough'].includes(action),
      `unexpected action ${action} for ${key}`,
    )
  }
})

test('WIRING CHECK ONLY: the Column label strings are present in the source', () => {
  // <label for> cannot target a div, which is how the affordance was lost when
  // the <select> went away. Plain substring checks — these strings are full of
  // regex metacharacters and escaping them proves nothing.
  //
  // Named for what it is: this catches a DELETION of the wiring and nothing
  // more. Paste these strings as dead code and it stays green; whether the
  // click actually works is pinned only by a hand-run browser probe, because
  // board/ has no DOM harness by design.
  assert.ok(BOARD_MARKUP.includes('id="f-column-label"'))
  // In panel.js since 2026-09-18, not app.js: both pages that mount the panel
  // build this dropdown, so the call moved with the markup. This assertion
  // caught the move, which is the most it claims to do.
  assert.ok(UI('panel.js').includes("labelElement: document.getElementById('f-column-label')"))
  assert.ok(UI('dropdown.js').includes("labelElement?.addEventListener('click'"))
})

test('no native select survives in the markup', () => {
  // The point of the card: one styled control and one OS control a click apart
  // is the thing being removed, so a half-converted interface is a regression.
  assert.doesNotMatch(BOARD_MARKUP, /<select/i)
  assert.doesNotMatch(UI('app.js'), /createElement\('option'\)/)
})

// ---------------------------------------------------------------------------
// handleTriggerKey — the keydown contract, pure over an event-shaped object.
// The guarantee these tests pin is ORDER: passthrough must return before
// preventDefault/stopPropagation ever run. That position IS the fix the ddfix
// card shipped — move the early return below them and '/', 'n' and Tab
// silently stop working while every substring assertion stays green.

function fakeEvent(key) {
  const calls = []
  return {
    key,
    calls,
    preventDefault: () => calls.push('preventDefault'),
    stopPropagation: () => calls.push('stopPropagation'),
  }
}

function fakeUi({ isOpen = true } = {}) {
  const calls = []
  return {
    calls,
    isOpen: () => isOpen,
    close: () => calls.push('close'),
    show: () => calls.push('show'),
    cancel: () => calls.push('cancel'),
    move: (key) => calls.push(`move:${key}`),
    commit: () => calls.push('commit'),
  }
}

test('a passthrough key closes the list and never touches the event', () => {
  for (const key of ['/', 'n', 'Tab', 'q']) {
    const event = fakeEvent(key)
    const ui = fakeUi()
    handleTriggerKey(event, ui)
    assert.deepEqual(ui.calls, ['close'], `${key} must close the open list`)
    assert.deepEqual(
      event.calls,
      [],
      `${key} must keep propagating — Tab needs its focus move and '/' belongs to the board`,
    )
  }
})

test('a claimed key stops the event before acting, in that order', () => {
  const claims = [
    ['Escape', 'cancel'],
    ['ArrowDown', 'move:ArrowDown'],
    ['Enter', 'commit'],
  ]
  for (const [key, expected] of claims) {
    const event = fakeEvent(key)
    const ui = fakeUi()
    handleTriggerKey(event, ui)
    assert.deepEqual(event.calls, ['preventDefault', 'stopPropagation'], `${key} must be swallowed`)
    assert.deepEqual(ui.calls, [expected])
  }
})

test('closed, an opening key is swallowed and opens; a dead key does nothing at all', () => {
  const opener = fakeEvent('ArrowDown')
  const openerUi = fakeUi({ isOpen: false })
  handleTriggerKey(opener, openerUi)
  assert.deepEqual(openerUi.calls, ['show'])
  assert.deepEqual(opener.calls, ['preventDefault', 'stopPropagation'])

  const dead = fakeEvent('x')
  const deadUi = fakeUi({ isOpen: false })
  handleTriggerKey(dead, deadUi)
  assert.deepEqual(deadUi.calls, [], 'a closed list ignores ordinary typing')
  assert.deepEqual(dead.calls, [], 'and must not swallow it either')
})
