import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A pasted URL in a card title is one unbreakable token, ~40-70 characters,
// and a column fits about 35. Without a wrapping rule the title runs past the
// card's right edge — seen live on 2026-09-04 and again on 2026-09-06 (a
// 325px title in a 267px card). The snapshot fixed the same defect on
// 2026-08-24 with ONE inherited declaration on body, after a per-element list
// missed four selectors; the live UI never got it. This pins the live rule
// the same way. The browser measurement is board/scripts/probe.mjs, run in
// the PR; this is the cheap guard that a later edit cannot drop the line.

const css = readFileSync(fileURLToPath(new URL('../ui/style.css', import.meta.url)), 'utf8')

const block = (sel) => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  assert.ok(m, `no rule for ${sel}`)
  return m[1]
}

test('unbreakable tokens wrap: one inherited overflow-wrap on body', () => {
  // "anywhere", not "break-word": only anywhere shrinks a box's min-content
  // size, and card metadata rows are flex containers whose items would
  // otherwise refuse to shrink below their longest word.
  assert.match(block('body'), /overflow-wrap:\s*anywhere/)
})
