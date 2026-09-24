import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { briefRows, escapeHtml, linkifyHtml, renderSnapshot, safeColor, stamp } from '../src/snapshot.js'
import { hasBriefHeadings, LOOP_BRIEF } from '../ui/brief.js'

const CONFIG = {
  name: 'Docket',
  accent: '#ff5227',
  columns: [
    { key: 'inbox', name: 'Inbox' },
    { key: 'loop', name: 'Loop' },
    { key: 'review', name: 'In review' },
  ],
  tags: {},
}

const card = (over = {}) => ({
  id: 'card-1',
  title: 'a card',
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

const board = (cards) => ({ rev: 7, updatedAt: '2026-08-24T10:00:00.000Z', cards })

const render = (cards, over = {}) =>
  renderSnapshot({
    board: board(cards),
    config: CONFIG,
    meta: { now: '2026-08-24T12:00:00.000Z', commit: 'abc1234', ...over },
  })

// ---- Escaping ------------------------------------------------------------
// The board holds arbitrary owner-authored text and this renders it into HTML
// with no framework in between, so escaping is the one thing here that is a
// security property rather than a cosmetic one.

test('escapeHtml handles the five characters, ampersand first', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  // Ampersand-first is the ordering bug: escape < before & and this reads
  // '&amp;lt;' instead of '&lt;'.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
})

test('escapeHtml coerces nullish to empty rather than to "null"', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('a card title carrying markup cannot open a tag', () => {
  const html = render([card({ title: '<img src=x onerror=alert(1)>' })])
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
})

test('a card cannot inject a script tag, and the file has none of its own', () => {
  const html = render([
    card({ title: 'ok', detail: '</style><script>alert(1)</script>' }),
  ])
  assert.ok(!/<script/i.test(html), 'no script tag survives anywhere in the document')
  // </style> matters specifically: the CSS is inlined above the body, so an
  // unescaped one would end the style element early and dump the rest as text.
  assert.ok(!html.includes('</style><script>'))
})

test('a tag name cannot break out of the style attribute it colours', () => {
  const html = render([card({ tags: ['"><script>x</script>'] })])
  assert.ok(!/<script/i.test(html))
})

test('a declared tag colour cannot smuggle CSS into the style attribute', () => {
  // The gate's find: escapeHtml stops the attribute breakout, so no tag and no
  // event handler appears and every safety assertion passes — while the injected
  // CSS applies anyway, because a style ATTRIBUTE parses a declaration list. It
  // made a file with no script tag fetch https://evil.example/beacon.png, which
  // destroys the self-contained property this whole renderer rests on.
  const html = render([card({ tags: ['t'] })], {}).replace(/x/g, 'x')
  assert.ok(html.includes('style="color:hsl('), 'the ordinary case still colours')

  const hostile = renderSnapshot({
    board: board([card({ tags: ['t'] })]),
    config: {
      ...CONFIG,
      tags: { t: 'red;background-image:url(https://evil.example/beacon.png);position:fixed' },
    },
    meta: { now: '2026-08-24T12:00:00.000Z' },
  })
  assert.ok(!hostile.includes('evil.example'), 'no url() reaches the document')
  assert.ok(!hostile.includes('position:fixed'))
  assert.ok(hostile.includes('style="color:inherit"'), 'falls back rather than emitting it')
})

test('safeColor passes real colours and rejects declarations', () => {
  for (const good of ['#fff', '#ff5227', '#ff5227aa', 'red', 'rebeccapurple',
    'hsl(200 42% 66%)', 'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)', 'hsl(200deg 42% 66% / 50%)']) {
    assert.equal(safeColor(good), good, `${good} is a colour`)
  }
  for (const bad of ['red;background:url(x)', 'url(https://x/y)', 'red;position:fixed',
    'expression(alert(1))', 'var(--x); background:red', '', null, undefined, 'a'.repeat(40)]) {
    assert.equal(safeColor(bad), 'inherit', `${JSON.stringify(bad)} is not a colour`)
  }
  // A bare word IS accepted — named colours are real, and an unknown one is
  // simply ignored by the browser. What must never pass is a declaration.
  assert.equal(safeColor('rebeccapurple'), 'rebeccapurple')
  assert.equal(safeColor('red;x', '#000'), '#000', 'the fallback is caller-chosen')
})

test('a note author cannot inject markup', () => {
  const html = render([
    card({ notes: [{ author: '<b>owner</b>', at: '2026-08-24T11:00:00.000Z', text: 'hi' }] }),
  ])
  assert.ok(!html.includes('<b>owner</b>'))
  assert.ok(html.includes('&lt;b&gt;owner&lt;/b&gt;'))
})

// ---- Linkification -------------------------------------------------------

test('linkifyHtml turns a url into an anchor with noopener', () => {
  const html = linkifyHtml('see https://example.com/x for more')
  assert.ok(html.includes('<a href="https://example.com/x" target="_blank" rel="noreferrer noopener">'))
  assert.ok(html.includes('for more'))
})

test('linkifyHtml escapes a url that carries markup', () => {
  // A URL run is \S+, so a quote is part of the match rather than a delimiter —
  // escaping it is what stops the href attribute being closed early.
  const html = linkifyHtml('https://example.com/"><script>alert(1)</script>')
  assert.ok(!/<script/i.test(html))
  assert.ok(html.includes('&quot;&gt;'))
})

test('linkifyHtml escapes the text around a link, not just the link', () => {
  const html = linkifyHtml('<b>before</b> https://example.com <i>after</i>')
  assert.ok(html.includes('&lt;b&gt;before&lt;/b&gt;'))
  assert.ok(html.includes('&lt;i&gt;after&lt;/i&gt;'))
})

test('linkifyHtml codes shas and repo paths', () => {
  assert.ok(linkifyHtml('at 1812a41 now').includes('<code>1812a41</code>'))
  assert.ok(linkifyHtml('see docs/STATE.md ok').includes('<code>docs/STATE.md</code>'))
})

test('linkifyHtml is not stateful across calls', () => {
  // The shared pattern used to be a module-level `g` regex. One would have
  // carried lastIndex into the next call and silently dropped early matches.
  const once = linkifyHtml('https://example.com/a')
  const twice = linkifyHtml('https://example.com/a')
  assert.equal(once, twice)
})

// ---- Provenance ----------------------------------------------------------
// A snapshot that looked live would be trusted, which is worse than none.

test('the header carries rev, board save time, commit and render time', () => {
  const html = render([card()])
  assert.ok(html.includes('rev 7'))
  assert.ok(html.includes('<code>abc1234</code>'))
  assert.ok(html.includes('24 AUG 2026 · 12:00 UTC'), 'render time')
  assert.ok(html.includes('24 AUG 2026 · 10:00 UTC'), 'board save time')
})

/** The provenance line alone — the footer prose says "committed" and would match. */
const provLine = (html) => html.match(/<div class="prov micro">(.*?)<\/div>/s)[1]

test('a missing commit degrades rather than failing', () => {
  const html = render([card()], { commit: null })
  const prov = provLine(html)
  assert.ok(prov.includes('rev 7'))
  assert.ok(prov.includes('rendered'))
  assert.ok(!prov.includes('commit'), 'no empty "commit" fragment left behind')
})

test('the read-only claim is stated where it cannot be missed', () => {
  const html = render([card()])
  assert.ok(html.includes('read-only snapshot — nothing here writes to the board'))
})

test('stamp is timezone-independent and rejects an unparseable date', () => {
  assert.equal(stamp('2026-08-24T12:00:00.000Z'), '24 AUG 2026 · 12:00 UTC')
  assert.equal(stamp('not a date'), '')
})

// ---- Structure -----------------------------------------------------------

test('every configured column appears, with its count, in config order', () => {
  const html = render([
    card({ id: 'a', column: 'inbox' }),
    card({ id: 'b', column: 'review' }),
    card({ id: 'c', column: 'review' }),
  ])
  const order = ['id="col-inbox"', 'id="col-loop"', 'id="col-review"'].map((needle) =>
    html.indexOf(needle),
  )
  assert.ok(order.every((i) => i !== -1), 'all three columns rendered')
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'rendered in config order')
  // An empty column is still shown: "Loop is empty" is information.
  assert.ok(html.includes('empty'))
})

/** The provenance line of every rendered card — one per card, id last. */
const renderedIds = (html) =>
  [...html.matchAll(/<div class="micro dim idline">([^<]*)<\/div>/g)].map((m) => {
    const parts = m[1].split(' · ')
    return parts[parts.length - 1]
  })

test('every card in the board reaches the page — by set and by count', () => {
  // This test used to be `for (const c of cards) assert.ok(html.includes(c.id))`
  // over ids card-0..card-11, and it did not work: 'card-1' is a substring of
  // 'card-10', so a renderer that dropped card-1 still satisfied it. The gate
  // proved it — mutated the renderer to drop a card per column, watched 11 of 12
  // render, and watched the whole suite report 337/337 green. Aliasing made the
  // feature's headline property unguarded.
  //
  // Count and set, not substring presence: a dropped card changes both.
  const cards = Array.from({ length: 12 }, (_, i) => card({ id: `card-${i}`, title: `t${i}` }))
  const html = render(cards)
  const ids = renderedIds(html)
  assert.equal(ids.length, cards.length, 'one rendered card per card in the board')
  assert.deepEqual(new Set(ids), new Set(cards.map((c) => c.id)))
})

test('the aliasing that hid a dropped card is gone', () => {
  // Renders card-1 and card-10 only. The old assertion passed on this pair with
  // card-1 absent; this one must not.
  const html = render([card({ id: 'card-10' })])
  const ids = renderedIds(html)
  assert.deepEqual(ids, ['card-10'])
  assert.ok(!ids.includes('card-1'), 'card-10 does not count as card-1')
})

test('a card keeps its provenance even after it has been annotated', () => {
  // The face copies the live board and shows origin only on a note-less card,
  // because there the modal always shows it. There is no modal here, so that
  // rule dropped the origin of 5 of the 6 cards on the real board that had one.
  const html = render([
    card({
      id: 'c1',
      origin: 'telegram · 2026-08-23',
      createdBy: 'owner',
      notes: [{ author: 'claude', at: '2026-08-24T11:00:00.000Z', text: 'worked it' }],
    }),
  ])
  assert.ok(html.includes('telegram · 2026-08-23'), 'origin survives having notes')
  assert.ok(html.includes('added by owner'), 'createdBy is rendered at all')
})

test('a card in no configured column is surfaced, not silently dropped', () => {
  // The orphan state docket doctor reports. The live board cannot show it at
  // all, so a read-only view that also hid it would be the second place it
  // vanishes — and the snapshot would undercount without saying so.
  const html = render([card({ id: 'lost', column: 'nowhere' })])
  assert.ok(html.includes('lost'), 'the orphan card is rendered')
  assert.ok(html.includes('not in any column'))
})

test('the gate verdict is read from the note thread onto the card face', () => {
  const html = render([
    card({
      notes: [
        // Noon UTC, so the LOCAL calendar date is the same in any inhabited
        // timezone — verdictDate renders local time, and a midnight-UTC fixture
        // passed in the cloud's UTC container while failing on the Mac.
        { author: 'verifier', at: '2026-08-22T12:00:00.000Z', text: 'VERDICT: fails\nbecause x' },
        { author: 'verifier', at: '2026-08-23T12:00:00.000Z', text: 'VERDICT: meets\nall clauses' },
      ],
    }),
  ])
  // Newest wins, so a card that failed and was fixed reads as met.
  assert.ok(html.includes('data-verdict="meets"'))
  assert.ok(html.includes('met · AUG 23'))
})

test('a thin Loop contract is flagged, exactly as the live card face flags it', () => {
  const html = render([card({ column: 'loop', detail: LOOP_BRIEF })])
  assert.ok(html.includes('needs Acceptance + Verify with'))
})

test('a complete Loop contract is not flagged', () => {
  const detail = 'Acceptance: a skeptic runs it\nVerify with: npm test\n'
  const html = render([card({ column: 'loop', detail })])
  assert.ok(!html.includes('needs Acceptance'))
})

test('attachments are named but never embedded', () => {
  // The blobs are not in git, and a screenshot of the owner's tree is the
  // living-persons line — a snapshot must not cross it on their behalf.
  // "not shown", NOT "not in git": nothing gitignores .docket/attachments, so
  // an attachment added here would be committed and the old label printed a
  // claim the repo does not keep. A gate caught it while the count was still 0.
  const html = render([
    card({ attachments: [{ name: 'a.png', path: '.docket/attachments/dead.png' }, { name: 'b.png' }] }),
  ])
  assert.ok(html.includes('2 attachments (not shown)'))
  assert.ok(!html.includes('not in git'), 'no claim about git we cannot keep')
  assert.ok(!html.includes('a.png'))
  assert.ok(!html.includes('dead.png'), 'no attachment path reaches the page')
})

test('the renderer builds no regex of its own', () => {
  // THIS is the test that would have failed the first version of this file, and
  // the reason it is phrased structurally rather than behaviourally: briefRows
  // had its own dynamically-built copy of brief.js's heading regex, and the two
  // agreed on every input, so no behavioural assertion could tell them apart.
  // Duplication that is invisible today is exactly the duplication that drifts.
  //
  // Every rule the snapshot needs already lives in a ui/ module that both halves
  // import — the heading parser, the verdict shape, the link pattern, the tag
  // hash. A `new RegExp` here means one of them has been rebuilt locally.
  // Matches `RegExp(` with or without `new`, and with any whitespace between —
  // a gate pointed out that `new RegExp` as a literal substring is evaded by
  // `RegExp(str)` and by `new  RegExp`. Still a source check and still not
  // airtight (the docstring above is honest about that); it is a tripwire for
  // the specific mistake that was made, not a proof.
  const source = readFileSync(new URL('../src/snapshot.js', import.meta.url), 'utf8')
  const built = [...source.matchAll(/(?:new\s+)?\bRegExp\s*\(/g)]
  assert.deepEqual(
    built.map((m) => m[0]),
    [],
    'no locally-built regex — import the rule from ui/ instead',
  )
})

test('an inlined font cannot carry a CSS payload', () => {
  // The last unvalidated interpolation into CSS in the renderer. Inert for both
  // real callers, since base64 of a local file contains no `)` or `;` — but a
  // gate showed a hostile fonts.sans producing a live background-image rule, and
  // "inert because of who happens to call it" is what stops being true first.
  const hostile = renderSnapshot({
    board: board([card()]),
    config: CONFIG,
    meta: {
      now: '2026-08-24T12:00:00.000Z',
      fonts: { sans: 'AAAA) format("woff2");}body{background-image:url(https://evil.example/f.png);}', mono: null },
    },
  })
  assert.ok(!hostile.includes('evil.example'), 'no url() reaches the stylesheet')
  assert.ok(!hostile.includes('@font-face'), 'a rejected font emits no rule at all')
  // A real base64 payload still produces its @font-face.
  const good = renderSnapshot({
    board: board([card()]),
    config: CONFIG,
    meta: { now: '2026-08-24T12:00:00.000Z', fonts: { sans: 'd09GMgABAAAAAA==', mono: null } },
  })
  assert.ok(good.includes("@font-face{font-family:'Geist'"))
  assert.ok(good.includes('data:font/woff2;base64,d09GMgABAAAAAA=='))
})

test('briefRows agrees with brief.js on what a contract is, on every edge', () => {
  // Weaker than it looks, and deliberately kept anyway: briefRows now calls
  // hasBriefHeadings, so this is near-tautological today. It earns its place as
  // a tripwire for someone re-inlining a *divergent* copy — the structural test
  // above is what actually guards against re-inlining an identical one.
  const cases = [
    'Acceptance: x',
    'objective:  y',
    '  Verify with : z',
    'Acceptancex: q',
    'talking about Acceptance: in prose',
    'Must not break:',
    '',
    'no headings at all',
    LOOP_BRIEF,
  ]
  for (const input of cases) {
    assert.equal(
      briefRows(input) !== null,
      hasBriefHeadings(input),
      `disagreement on ${JSON.stringify(input)}`,
    )
  }
  for (const input of [null, undefined]) {
    assert.equal(briefRows(input) !== null, hasBriefHeadings(input))
  }
})

test('long tokens wrap by inheritance from body, not by a list of elements', () => {
  // The gate failed this on 2026-08-24: wrap was declared on three text
  // elements and .card-title, .card-tag, .note-head and .idline were missed, so
  // a pasted PR URL in a title scrolled the phone sideways. A list is the wrong
  // shape for this property — one inherited declaration cannot miss a element.
  // Geometry itself is asserted in a browser by
  // board/scripts/check-phone-geometry.mjs; this pins the mechanism.
  const html = render([card()])
  const body = html.match(/\nbody\{([^}]*)\}/)
  assert.ok(body, 'a body rule exists')
  assert.match(body[1], /overflow-wrap:\s*anywhere/, 'declared on body, so it inherits')
  const perElement = [...html.matchAll(/\.[a-z-]+\{[^}]*overflow-wrap/g)]
  assert.deepEqual(perElement, [], 'no per-element overflow-wrap list has crept back')
})

test('only http and https become links', () => {
  // A javascript: or data: URL rendered as an anchor would be the classic hole
  // here, and it is the one the contract forgot to ask about.
  for (const scheme of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x']) {
    const html = linkifyHtml(scheme)
    assert.ok(!html.includes('<a '), `${scheme} is not linkified`)
  }
  assert.ok(linkifyHtml('https://ok.example').includes('<a '))
})

test('briefRows returns null for prose and rows for a contract', () => {
  assert.equal(briefRows('just a normal note about a thing'), null)
  const rows = briefRows('Objective: ship it\nAcceptance: it works\nVerify with: npm test\n')
  assert.deepEqual(
    rows.map((r) => r.label),
    ['Objective', 'Acceptance', 'Verify with'],
  )
  assert.equal(rows[1].value, 'it works')
  assert.equal(rows[1].required, true)
})

test('an empty board renders a valid page rather than throwing', () => {
  const html = render([])
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.trimEnd().endsWith('</html>'))
})

test('a malformed board does not throw', () => {
  const html = renderSnapshot({ board: {}, config: CONFIG, meta: {} })
  assert.ok(html.includes('<!doctype html>'))
})

test('an omitted render time falls back to now, never to the epoch', () => {
  // The epoch would print "01 JAN 1970" in the provenance line — a snapshot
  // claiming to be 56 years old is worse than one claiming nothing.
  const html = renderSnapshot({ board: board([card()]), config: CONFIG, meta: {} })
  assert.ok(!html.includes('1970'))
  assert.ok(/rendered \d\d [A-Z]{3} 20\d\d/.test(html))
})

test('an accent that is not a hex colour falls back rather than reaching the CSS', () => {
  // The accent lands inside a custom property, so an unvalidated one would be
  // a CSS injection point with no escaping available.
  const html = renderSnapshot({
    board: board([card()]),
    config: { ...CONFIG, accent: 'red;} body{display:none' },
    meta: {},
  })
  assert.ok(!html.includes('body{display:none'))
  assert.ok(html.includes('--accent:#ff5227'))
})

/**
 * Every real tag in the output, as {name, attrs}.
 *
 * Sound because of one property of the renderer: escapeHtml turns every `<` in
 * card content into `&lt;`, so any raw `<` left in the output was emitted by the
 * renderer itself. That makes a scan for real tags exact, where a scan of the
 * whole document is not.
 *
 * This replaced three assertions that grepped the raw document, all of which
 * the gate showed were unsound on 2026-08-24: `/\bon[a-z]+=/i` matches the
 * escaped text `onerror=alert(1)` in a card body, and `/fetch\(/` matches this
 * very board, which has a card whose note discusses `await fetch('/api/board')`.
 * They passed only because the fixtures were tame. The property being claimed is
 * "no live code", and that is about tags, not about characters.
 */
const tagsIn = (html) =>
  [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: m[2],
  }))

/** Exactly what the renderer is allowed to emit. Growth here is the alarm. */
const ALLOWED_TAGS = new Set([
  'html', 'head', 'meta', 'title', 'style', 'body', 'header', 'div', 'h1',
  'nav', 'a', 'main', 'section', 'details', 'summary', 'span', 'code', 'footer', 'p',
])

test('the document emits no tag outside the renderer allowlist', () => {
  const html = render([
    card({ notes: [{ author: 'owner', at: '2026-08-24T11:00:00.000Z', text: 'a note' }] }),
  ])
  const unexpected = [...new Set(tagsIn(html).map((t) => t.name))].filter(
    (name) => !ALLOWED_TAGS.has(name),
  )
  assert.deepEqual(unexpected, [], 'no tag the renderer was not written to emit')
})

test('hostile content creates no tag and no event handler — checked per tag, not by grep', () => {
  const hostile = '<img src=x onerror=alert(1)></script><script>alert(1)</script>'
  const html = render([
    card({
      title: hostile,
      detail: `Objective: ${hostile}`,
      tags: [hostile],
      notes: [{ author: hostile, at: '2026-08-24T11:00:00.000Z', text: hostile }],
    }),
  ])
  const tags = tagsIn(html)
  const names = new Set(tags.map((t) => t.name))
  for (const forbidden of ['script', 'img', 'iframe', 'svg', 'object', 'embed', 'form', 'input']) {
    assert.ok(!names.has(forbidden), `no ${forbidden} element`)
  }
  const handlered = tags.filter((t) => /\son[a-z]+\s*=/i.test(t.attrs))
  assert.deepEqual(handlered, [], 'no tag carries an on* attribute')
  // Escaped, not dropped: silently swallowing the owner's text would also pass
  // every assertion above, and would be a different bug.
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
})

// ---- The first paragraph shows; the rest opens on demand ------------------
// Native <details>, because the snapshot has no script tag by design and the
// live panel must behave identically. Spec: docs/specs/2026-09-11-note-tldr-design.md

const noted = (text) => card({ notes: [{ author: 'claude', at: '2026-08-24T11:00:00.000Z', text }] })

test('a multi-paragraph note renders its lead outside a closed details and the rest inside', () => {
  const html = render([noted('The short version.\n\nThe long version, with a https://example.com/link in it.')])
  const start = html.indexOf('<details class="note-more">')
  assert.ok(start !== -1, 'a details element for the rest')
  assert.ok(html.indexOf('The short version.') < start, 'the lead comes before the details')
  assert.ok(html.indexOf('The long version') > start, 'the rest is inside the details')
  assert.ok(!html.includes('<details open'), 'closed by default')
  assert.match(html, /<summary class="micro"><span class="when-closed">more<\/span><span class="when-open">less<\/span><\/summary>/)
  assert.ok(html.indexOf('<a href="https://example.com/link"') > start, 'the rest is linkified like the lead')
})

test('a one-paragraph note renders no details at all', () => {
  const html = render([noted('Just the one paragraph, however long it runs on.')])
  assert.ok(!html.includes('<details class="note-more">'), 'nothing to open (the class name itself lives in the stylesheet)')
})

test('markup in the rest is escaped exactly as the lead is', () => {
  const html = render([noted('lead\n\n<b>bold</b> & <script>alert(1)</script>')])
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;'), 'escaped')
  assert.ok(!html.includes('<script>alert'), 'never raw')
})

// ---- Time worked: the face chip and the log (spec 2026-09-14) ---------------

const timed = (time, over = {}) => card({ id: 'timed', title: 'timed', time, ...over })
const S1 = { start: '2026-09-14T09:12:00.000Z', stop: '2026-09-14T10:24:00.000Z', note: 'wrote the spec' }
const S2 = { start: '2026-09-14T11:00:00.000Z', stop: '2026-09-14T11:30:00.000Z', note: '<b>bold</b> claim' }

test('a card with sessions shows its total on the face and every session in the body, escaped', () => {
  const html = render([timed({ running: null, sessions: [S1, S2] })])
  assert.match(html, /<span class="time-chip">1h 42m<\/span>/, 'the face total')
  assert.equal((html.match(/class="session"/g) ?? []).length, 2, 'both rows')
  assert.ok(html.includes('wrote the spec'))
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt; claim'), 'the description is escaped')
  assert.ok(!html.includes('<b>bold</b>'))
  assert.ok(html.includes('· 1h 12m') && html.includes('· 30m'), 'each row carries its length')
})

test('a running card says so on the face, in the accent, and counts the live span into the total', () => {
  const html = render([timed({ running: '2026-08-24T11:00:00.000Z', sessions: [] })])
  assert.match(html, /<span class="time-chip running">running<\/span>/)
  assert.ok(html.includes('running since'), 'the body names the open session')
})

test('a card with no time renders no chip and no log', () => {
  const html = render([card()])
  assert.ok(!html.includes('<span class="time-chip'), 'no chip (the class name itself lives in the stylesheet)')
  assert.ok(!html.includes('class="time-log"'))
})

// ---- origin on the face is one line (spec 2026-09-16) ---------------------------

test('a note-less card with an origin marks it on the face so the CSS can keep it to one line', () => {
  const html = render([card({ origin: 'trello · a1b2c3d4 · This month · https://trello.com/c/a1b2c3d4' })])
  assert.ok(html.includes('<span class="origin">trello · a1b2c3d4 · This month · https://trello.com/c/a1b2c3d4</span>'))
  assert.ok(html.includes('.card-foot>span:last-child{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}'), 'the foot is one line')
})

// ---- editedAt on the phone snapshot (spec: note edit) ----------------------

test('an edited note says so in the snapshot', () => {
  const html = render([
    card({ notes: [{ author: 'owner', at: '2026-09-23T10:00:00.000Z', text: 'corrected', editedAt: '2026-09-23T12:00:00.000Z' }] }),
  ])
  assert.match(html, /edited/)
})

test('an unedited note does not', () => {
  const html = render([card({ notes: [{ author: 'owner', at: '2026-09-23T10:00:00.000Z', text: 'plain' }] })])
  assert.doesNotMatch(html, /edited/)
})

// ---- todos, read-only (spec: note-edit-and-todos) --------------------------

test('a card with todos renders them read-only in the snapshot', () => {
  const html = render([
    card({
      todos: [
        { id: 't1', text: 'read the spec', done: true, doneBy: 'claude', doneAt: '2026-09-23T10:00:00.000Z' },
        { id: 't2', text: 'make it pass', done: false, doneBy: null, doneAt: null },
      ],
    }),
  ])
  assert.match(html, /read the spec/)
  assert.match(html, /make it pass/)
  assert.match(html, /1\/2/)
})

test('the snapshot still has no way to write', () => {
  // The strongest form of "never make the phone authoritative": no script tag
  // at all. A checkbox is rendered disabled; nothing can change it, and nothing
  // could send it anywhere if it did.
  const html = render([card({ todos: [{ id: 't1', text: 'x', done: false, doneBy: null, doneAt: null }] })])
  assert.doesNotMatch(html, /<script/i)
  assert.match(html, /disabled/)
})

test('a card with no todos renders no todo markup at all', () => {
  const html = render([card({ todos: [] })])
  assert.doesNotMatch(html, /class="todo"/)
})

test('todo text is escaped, not injected', () => {
  const html = render([card({ todos: [{ id: 't1', text: '<img src=x onerror=alert(1)>', done: false, doneBy: null, doneAt: null }] })])
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;img/)
})
