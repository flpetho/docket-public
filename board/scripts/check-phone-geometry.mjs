/**
 * Does the snapshot still fit a phone when a card holds a word that doesn't?
 *
 * The gate failed this on 2026-08-24 and the reason is worth keeping: the
 * acceptance clause asserted no horizontal overflow *in the delivered file*,
 * and the delivered file passed — because none of the 29 cards on the board
 * that day happened to contain a token longer than about 35 characters. The
 * property held by luck of content. One pasted PR URL in a title and the page
 * scrolled sideways on the only device it exists for.
 *
 * So this asserts the property against input chosen to break it, not against
 * whatever the board currently says. Not in `npm test` because it needs a real
 * browser, and the suites are meant to run anywhere with no network and no
 * install — this is the geometry counterpart to probe.mjs, and it shells out to
 * probe.mjs rather than opening a second CDP client.
 *
 *   node board/scripts/check-phone-geometry.mjs [width]
 *
 * Needs DOCKET_CHROME on a machine whose Chrome is not at the macOS path.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderSnapshot } from '../src/snapshot.js'

const here = dirname(fileURLToPath(import.meta.url))
const width = Number(process.argv[2] ?? 390)

/** 400 characters with no break opportunity anywhere in it. */
const LONG = 'x'.repeat(400)
/** The realistic one. A PR permalink is ~68 unbroken characters. */
const URL_TITLE = 'https://github.com/example/docket/pull/12/files#diff-abcdef0123456789'

const card = (over) => ({
  id: 'c',
  title: 't',
  detail: '',
  tags: [],
  column: 'inbox',
  flag: false,
  notes: [],
  origin: '',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  columnSince: '2026-08-20T00:00:00.000Z',
  attachments: [],
  ...over,
})

// One long token in every field that reaches the page, because the bug was a
// per-element CSS list that missed four of them.
const board = {
  rev: 1,
  updatedAt: '2026-08-24T10:00:00.000Z',
  cards: [
    card({ id: 'url-title', title: URL_TITLE }),
    card({ id: 'long-title', title: LONG }),
    card({ id: 'long-tag', title: 'tag', tags: [LONG.slice(0, 120)] }),
    card({ id: 'long-detail', title: 'detail', detail: LONG }),
    card({ id: 'long-origin', title: 'origin', origin: LONG.slice(0, 100) }),
    card({
      id: 'long-note',
      title: 'note',
      notes: [{ author: LONG.slice(0, 80), at: '2026-08-24T09:00:00.000Z', text: LONG }],
    }),
    card({
      id: 'long-brief',
      title: 'contract',
      column: 'loop',
      detail: `Acceptance: ${LONG}\nVerify with: ${URL_TITLE}\n`,
    }),
  ],
}

const config = {
  name: 'Geometry check',
  accent: '#ff5227',
  columns: [
    { key: 'inbox', name: 'Inbox' },
    { key: 'loop', name: 'Loop' },
  ],
  tags: {},
}

const dir = await mkdtemp(join(tmpdir(), 'docket-geometry-'))
const file = join(dir, 'wide.html')
await writeFile(file, renderSnapshot({ board, config, meta: { now: '2026-08-24T12:00:00.000Z' } }))

// Every <details> opened: the collapsed page can pass while the expanded one
// overflows, and the whole point of the page is that you open cards.
// `cards` is reported so the check cannot pass on an empty page. It could
// before: the success line said "7 hostile cards" as a hardcoded string while
// nothing verified any had rendered, and probe.mjs evaluates anyway after
// waiting ~12s for a .card that never appears. A renderer that emitted a blank
// document would have been congratulated for not overflowing.
const EXPRESSION = `
for (const d of document.querySelectorAll('details')) d.open = true;
const over = [];
for (const el of document.querySelectorAll('body *')) {
  // overflowX visible only: the column nav scrolls sideways by design.
  if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible') {
    over.push((el.className || el.tagName) + ' sw=' + el.scrollWidth + ' cw=' + el.clientWidth);
  }
}
return {
  doc: document.documentElement.scrollWidth,
  view: window.innerWidth,
  cards: document.querySelectorAll('.card').length,
  open: document.querySelectorAll('details[open]').length,
  over,
}
`

const probe = spawn(
  process.execPath,
  [join(here, 'probe.mjs'), '--width', String(width), `file://${file}`, EXPRESSION],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)
let out = ''
probe.stdout.on('data', (chunk) => (out += chunk))
const code = await new Promise((resolve) => probe.on('close', resolve))
if (code !== 0) {
  console.error('probe failed to run')
  process.exit(2)
}

let result
try {
  result = JSON.parse(out)
} catch {
  console.error(`probe returned something that is not JSON:\n${out}`)
  process.exit(2)
}

const failures = []
// Emptiness first: "nothing overflows" is trivially true of a blank page, so
// establish that there is something to measure before believing the measurement.
if (result.cards !== board.cards.length) {
  failures.push(`rendered ${result.cards} cards, expected ${board.cards.length} — nothing was measured`)
}
if (result.open !== board.cards.length) {
  failures.push(`${result.open} of ${board.cards.length} cards opened — the expanded case went unchecked`)
}
if (result.doc > result.view) {
  failures.push(`the document scrolls sideways: scrollWidth ${result.doc} > innerWidth ${result.view}`)
}
for (const element of result.over ?? []) failures.push(`overflows its box: ${element}`)

if (failures.length) {
  console.error(`FAIL at ${width}px — ${failures.length} problem(s):`)
  for (const line of failures) console.error(`  ${line}`)
  console.error('\nIf these are overflows: a long unbroken token escaped the wrap rule.')
  console.error('snapshot.js sets overflow-wrap on body so every descendant inherits it;')
  console.error('check that nothing below it resets the property.')
  process.exit(1)
}

console.log(
  `ok at ${width}px — ${result.cards} hostile cards, all open, nothing overflows ` +
    `(doc ${result.doc} <= view ${result.view})`,
)
