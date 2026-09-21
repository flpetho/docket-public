import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The board's type scale hangs off ONE root rule, and the two layout widths
// that must grow with it are rem, not px. Pinned here because the change is
// three lines in a 700-line stylesheet, and a later edit could undo any of
// them without a single other test noticing. See
// docs/specs/2026-09-04-type-scale-design.md for why 112.5% and why rem.

const css = readFileSync(fileURLToPath(new URL('../ui/style.css', import.meta.url)), 'utf8')

/** The declarations of the first rule whose selector list is exactly `sel`. */
const block = (sel) => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  assert.ok(m, `no rule for ${sel}`)
  return m[1]
}

test('the root sets the type scale as a percentage of the browser default', () => {
  // 112.5% of 16px is 18px. A percentage so a raised browser default scales
  // the board with it instead of being pinned under it.
  assert.match(block('html'), /font-size:\s*112\.5%/)
})

test('the column width is rem so it grows with the type', () => {
  // 16.5rem is the old 264px at a 16px root, 297px at 18px. In px, the type
  // would grow inside a fixed column and lines would shorten — the thing the
  // owner previewed with browser zoom and did NOT want.
  assert.match(block('.column'), /flex:\s*0 0 16\.5rem/)
  assert.doesNotMatch(block('.column'), /flex:[^;]*px/, 'the column basis is still in px')
})

test('the panel width is rem so it grows with the type', () => {
  assert.match(block('#panel'), /width:\s*38\.75rem/)
  assert.doesNotMatch(block('#panel'), /width:[^;]*px/, 'the panel width is still in px')
})
