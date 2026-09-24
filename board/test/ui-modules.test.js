import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The cheapest gate available, asked for in STATE.md after a shell-mangled
 * `$('chart')` shipped broken for one commit: in a `node -e` script inside
 * double quotes the shell eats `$(…)`.
 *
 * TWO legs, because one would not have caught that bug. app.js and dashboard.js
 * touch document and location at load, so they can be parsed but never
 * imported — and dashboard.js is where the mangling was. `node --check` parses
 * every module; the import leg covers the rest.
 */

const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const modules = readdirSync(UI)
  .filter((name) => name.endsWith('.js'))
  .sort()

/**
 * The page entries. Named rather than detected, so a third one is a deliberate
 * act rather than a silent gap.
 */
const ENTRIES = ['app.js', 'dashboard.js']

test('there are UI modules to check at all', () => {
  // A glob that silently matches nothing is a green test that proves nothing.
  assert.ok(modules.length >= 10, `expected the UI modules, found ${modules.length}`)
})

test('every UI module parses', () => {
  for (const name of modules) {
    // Throws with the syntax error on a non-zero exit, which is the failure
    // message you want to read.
    execFileSync(process.execPath, ['--check', UI + name])
  }
})

test('every UI module that is not a page entry imports cleanly', async () => {
  for (const name of modules.filter((n) => !ENTRIES.includes(n))) {
    await import(UI + name)
  }
})

test('the page entries are still page entries', async () => {
  // If one of these becomes importable it stopped touching the DOM at load —
  // take it out of ENTRIES and let the leg above cover it, rather than leaving
  // it checked only for syntax.
  for (const name of ENTRIES) {
    await assert.rejects(import(UI + name), `${name} now imports — move it out of ENTRIES`)
  }
})
