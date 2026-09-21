/**
 * The board as one self-contained, read-only HTML file.
 *
 * WHY THIS EXISTS. The daemon binds 127.0.0.1 (see daemon.js), so the board is
 * reachable from a phone only over Tailscale — and Tailscale is dead on the
 * owner's Mac, blocked by a managed-device DNS filter. That left the phone with
 * the capture bot and no way to *read* the board at all. But every board is
 * committed JSON in the project it describes, so anything that can reach the
 * repo can already reach the board; it just had no way to look at it.
 *
 * WHAT IT DELIBERATELY IS NOT. It is not a second board, and it is not a way to
 * write to one from a phone. `CLAUDE.md`: *never make the browser or the phone
 * authoritative*, and *never accept an offline write* — the predecessor let a
 * stale client heal junk back into the shared file. A read-only render is the
 * strongest available form of that rule: there is nothing here to write with.
 * No form, no fetch, no EventSource, and no script tag of any kind — the card
 * expanders are `<details>`, which the browser has done since 2020.
 *
 * SO IT MUST DECLARE ITS OWN AGE. A snapshot that looked live would be worse
 * than no snapshot, because it would be trusted. Every file states the board rev
 * it came from, when that board was last saved, and when the render happened,
 * in the header where they cannot be missed.
 *
 * Self-contained is load-bearing rather than tidy: fonts inline as data URIs so
 * the file opens with the right face on a plane, and one file is a thing that
 * can be mailed, saved to Files, or opened from a chat months later.
 *
 * Every derived value — tag colours, ages, the gate's verdict, whether a Loop
 * contract is thin, what becomes a link — is imported from the modules the live
 * board uses. None of it is reimplemented here, so the snapshot cannot quietly
 * start disagreeing with the board it claims to show.
 */

import { briefWarning, BRIEF_FIELDS, hasBriefHeadings, parseBrief } from '../ui/brief.js'
import { splitNote } from '../ui/note-lead.js'
import { columnAge, linkPattern, relativeAge } from '../ui/render.js'
import { formatDuration, formatSession, totalMs } from '../ui/time.js'
import { latestVerdict, verdictDate } from '../ui/verdict.js'
import { tagColor } from '../ui/tag-color.js'

/**
 * Ampersand first, or every later replacement gets double-escaped.
 *
 * Quotes are escaped along with the angle brackets rather than only in
 * attribute position: one function used everywhere is auditable, two functions
 * chosen per call site is a decision that gets made wrong once.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A colour, or the fallback. Anything that is not plainly a colour is not one.
 *
 * WHY THIS IS NOT PARANOIA. `config.tags` lets the owner declare a colour per
 * tag, and `tagColor` returns that value verbatim. The live board is safe from
 * it by accident of mechanism: `render.js` does `element.style.color = value`,
 * and the CSSOM parses that as a single declaration and rejects the whole thing
 * if it is not one — verified, a value carrying `;background-image:url(...)`
 * leaves the element with no style attribute at all.
 *
 * This renderer writes into a `style="..."` ATTRIBUTE, which parses a whole
 * declaration list, so the same value became live CSS here. `escapeHtml` stops
 * the attribute breakout — no tag, no event handler, so every safety assertion
 * still passed — and the injected CSS applied anyway. The gate demonstrated a
 * declared colour turning a file with no script tag into one that requests
 * `https://evil.example/beacon.png`, which quietly destroys the property this
 * whole file is built on: that a snapshot is self-contained and touches nothing.
 *
 * So: validated at the boundary, exactly as `config.accent` already was two
 * lines away. Hex, a bare keyword, or an rgb/hsl function with nothing but
 * numbers and separators inside it. No semicolons, no colons, no url().
 */
const COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|(?:rgb|rgba|hsl|hsla)\([0-9a-zA-Z.,%/\s+-]*\))$/

/** Nothing but the base64 alphabet, so an inlined font cannot carry a CSS payload. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function safeColor(value, fallback = 'inherit') {
  const text = String(value ?? '').trim()
  return COLOR.test(text) ? text : fallback
}

/**
 * Card text with links, escaped.
 *
 * The order matters and is the whole point: each plain run is escaped, then the
 * tags are added around it. Escaping after insertion would escape the markup
 * this just built, and linkifying after escaping would let `&amp;` inside a URL
 * split the match. Same pattern the live board uses, from render.js.
 */
export function linkifyHtml(text) {
  const raw = String(text ?? '')
  let out = ''
  let last = 0
  for (const match of raw.matchAll(linkPattern())) {
    const [value, url] = match
    if (match.index > last) out += escapeHtml(raw.slice(last, match.index))
    if (url) {
      // rel includes noopener: target=_blank without it hands the opened page a
      // window.opener back to this file.
      const safe = escapeHtml(url)
      out += `<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a>`
    } else {
      out += `<code>${escapeHtml(value)}</code>`
    }
    last = match.index + value.length
  }
  if (last < raw.length) out += escapeHtml(raw.slice(last))
  return out
}

/** `24 AUG 2026 · 16:40 UTC` — unambiguous, and the same string in any timezone. */
export function stamp(iso) {
  const date = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${day} ${month} ${date.getUTCFullYear()} · ${hh}:${mm} UTC`
}

/**
 * A Loop contract rendered as its headings rather than as a wall of text.
 *
 * Returns null for a detail that is not a contract, so ordinary prose stays
 * ordinary prose. On a phone this is the difference between a readable card and
 * a paragraph nobody scrolls: `Acceptance` is the part being looked for, and it
 * is usually four screens down in the raw text.
 */
export function briefRows(detail) {
  const text = String(detail ?? '')
  // brief.js's own answer to "is this a contract", not a rebuilt copy of it.
  // This was a verbatim reimplementation of hasBriefHeadings — behaviourally
  // identical on every input tried, which is exactly how the drift this file's
  // header promises to avoid would have started.
  if (!hasBriefHeadings(text)) return null
  const { values } = parseBrief(text)
  return BRIEF_FIELDS.filter((field) => values[field.key]).map((field) => ({
    label: field.label,
    value: values[field.key],
    required: field.required,
  }))
}

function noteHtml(note, nowMs) {
  // latestVerdict over a one-note array asks "is THIS note a verdict", reusing
  // the anchored rule rather than a second regex that could drift from it.
  const ruling = latestVerdict([note])
  const attrs = ruling
    ? `class="note note-verdict" data-verdict="${escapeHtml(ruling.verdict)}"`
    : 'class="note"'
  // The first paragraph shows; the rest opens on demand. Native <details>,
  // because this file has no script tag by design — and the live panel does
  // the same thing with the same splitNote, so the two cannot disagree.
  const { lead, rest } = splitNote(note?.text ?? '')
  return [
    `<div ${attrs}>`,
    `<div class="note-head micro">`,
    `<span>${escapeHtml(note?.author ?? 'unknown')}</span>`,
    `<span class="dim">${escapeHtml(relativeAge(note?.at, nowMs))}</span>`,
    `</div>`,
    `<div class="note-text">${linkifyHtml(lead)}</div>`,
    rest
      ? `<details class="note-more"><summary class="micro"><span class="when-closed">more</span><span class="when-open">less</span></summary><div class="note-text">${linkifyHtml(rest)}</div></details>`
      : '',
    `</div>`,
  ].join('')
}

/**
 * The sessions, newest first, each with its description, and the total. A
 * running timer is named with its start; the snapshot cannot tick.
 */
function timeLogHtml(time, nowMs) {
  const sessions = time?.sessions ?? []
  if (!sessions.length && !time?.running) return ''
  const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const rows = [...sessions]
    .reverse()
    .map(
      (s) =>
        `<div class="session"><span>${escapeHtml(formatSession(s))}</span>${s.note ? `<span class="session-note">${escapeHtml(s.note)}</span>` : ''}</div>`,
    )
  if (time.running) {
    rows.unshift(`<div class="session running">running since ${escapeHtml(clock.format(new Date(time.running)))}</div>`)
  }
  return `<div class="time-log"><div class="micro">Time · ${escapeHtml(formatDuration(totalMs(time, nowMs)))}</div>${rows.join('')}</div>`
}

function cardHtml(card, { config, nowMs }) {
  const tags = (card.tags ?? [])
    .map(
      (tag) =>
        `<span class="card-tag" style="color:${escapeHtml(safeColor(tagColor(tag, config.tags ?? {})))}">${escapeHtml(tag)}</span>`,
    )
    .join('')

  const marks = []
  const ruling = latestVerdict(card.notes ?? [])
  if (ruling) {
    const date = verdictDate(ruling.at)
    marks.push(
      `<span class="verdict" data-verdict="${escapeHtml(ruling.verdict)}">${escapeHtml(date ? `${ruling.word} · ${date}` : ruling.word)}</span>`,
    )
  }
  if (card.flag) marks.push('<span class="flag micro">!</span>')

  const warning = briefWarning(card.column, card.detail)
  const warn = warning
    ? `<div class="brief-warn micro">${escapeHtml(warning.label)}</div>`
    : ''

  const foot = []
  // Time worked: the total, or 'running' in the accent while a timer runs. No
  // live minutes on a face; the panel has those.
  const worked = totalMs(card.time, nowMs)
  if (card.time?.running) foot.push('<span class="time-chip running">running</span>')
  else if (worked) foot.push(`<span class="time-chip">${escapeHtml(formatDuration(worked))}</span>`)
  const age = columnAge(card.columnSince, nowMs)
  if (age) foot.push(`<span>${escapeHtml(age)}</span>`)
  const notes = card.notes ?? []
  if (notes.length) {
    const latest = notes[notes.length - 1]
    foot.push(
      `<span>${notes.length} note${notes.length > 1 ? 's' : ''} · ${escapeHtml(latest.author ?? '')} ${escapeHtml(relativeAge(latest.at, nowMs))}</span>`,
    )
  } else if (card.origin) {
    foot.push(`<span class="origin">${escapeHtml(card.origin)}</span>`)
  }
  if (card.attachments?.length) {
    // Named, never shown, and the label says "not shown" rather than "not in
    // git" — because nothing gitignores .docket/attachments, so an attachment
    // added to this repo WOULD be committed and the older label would have been
    // a lie printed to the reader. A gate caught it while the count was still 0.
    //
    // The durable reason to never embed one does not depend on git either way: a
    // screenshot of the owner's tree is exactly the living-persons line CLAUDE.md
    // draws, and reading an attachment is meant to be their decision, not a side
    // effect of rendering a page.
    const n = card.attachments.length
    foot.push(`<span class="dim">${n} attachment${n > 1 ? 's' : ''} (not shown)</span>`)
  }

  const rows = briefRows(card.detail)
  const detail = String(card.detail ?? '').trim()
  let body = ''
  if (rows) {
    body = rows
      .map(
        (row) =>
          `<div class="brief-row"><div class="micro${row.required ? ' req' : ''}">${escapeHtml(row.label)}</div><div class="brief-val">${linkifyHtml(row.value)}</div></div>`,
      )
      .join('')
  } else if (detail) {
    body = `<div class="detail">${linkifyHtml(detail)}</div>`
  }
  const thread = notes.map((note) => noteHtml(note, nowMs)).join('')
  const timeLog = timeLogHtml(card.time, nowMs)

  // Provenance, and it has to be HERE rather than only on the face.
  //
  // The face copies the live board, which shows `origin` only when a card has no
  // notes — correct there, because clicking the card opens a modal that always
  // shows it. This has no modal, so that same rule silently dropped the origin
  // of every card that had ever been annotated: 5 of the 6 on the real board,
  // including the `telegram · 2026-08-23` that says a card came from a phone.
  // `createdBy` was never rendered at all. Both now match modal.js:209.
  const provenance = [
    card.origin,
    card.createdBy ? `added by ${card.createdBy}` : '',
    card.id,
  ].filter(Boolean)
  const idLine = `<div class="micro dim idline">${escapeHtml(provenance.join(' · '))}</div>`

  // The summary is the card face the live board paints; the panel underneath is
  // what its modal would show. Same split, so a card looks like itself.
  const preview = detail ? `<div class="card-detail">${escapeHtml(detail)}</div>` : ''
  return [
    `<details class="card${card.flag ? ' flagged' : ''}">`,
    `<summary>`,
    `<div class="card-meta">${tags}<span class="card-marks">${marks.join('')}</span></div>`,
    `<div class="card-title">${escapeHtml(card.title ?? '')}</div>`,
    preview,
    warn,
    foot.length ? `<div class="card-foot micro">${foot.join('')}</div>` : '',
    `</summary>`,
    `<div class="card-body">${body}${timeLog}${thread}${idLine}</div>`,
    `</details>`,
  ].join('')
}

/**
 * The whole file.
 *
 * `board` and `config` are the two committed documents, unmodified. `meta`
 * carries the provenance the header prints — the commit it was rendered from and
 * the moment of rendering — injected rather than read, so the output is a pure
 * function of its inputs and a test can assert on the exact bytes.
 */
export function renderSnapshot({ board, config, meta = {} }) {
  // Injected by every real caller so a test can assert exact bytes; falling back
  // to the wall clock rather than to the epoch, because the epoch would print
  // "01 JAN 1970" in the one line whose whole job is to be trusted.
  const now = meta.now ? new Date(meta.now) : new Date()
  const nowMs = now.getTime()
  const cards = Array.isArray(board?.cards) ? board.cards : []
  const columns = Array.isArray(config?.columns) ? config.columns : []
  const accent = /^#[0-9a-fA-F]{6}$/.test(config?.accent ?? '') ? config.accent : '#ff5227'

  const byColumn = new Map(columns.map((c) => [c.key, []]))
  const orphans = []
  for (const card of cards) {
    const bucket = byColumn.get(card.column)
    if (bucket) bucket.push(card)
    else orphans.push(card)
  }

  const nav = columns
    .map((column) => {
      const n = byColumn.get(column.key).length
      return `<a class="chip micro${n ? '' : ' empty'}" href="#col-${escapeHtml(column.key)}">${escapeHtml(column.name)} <span class="n">${n}</span></a>`
    })
    .join('')

  const sections = columns
    .map((column) => {
      const list = byColumn.get(column.key)
      const inner = list.length
        ? list.map((card) => cardHtml(card, { config, nowMs })).join('')
        : '<div class="column-empty micro">empty</div>'
      return [
        `<section class="column" id="col-${escapeHtml(column.key)}">`,
        `<div class="column-head">`,
        `<span class="micro">${escapeHtml(column.name)}</span>`,
        `<span class="micro count">${list.length}</span>`,
        `</div>`,
        inner,
        `</section>`,
      ].join('')
    })
    .join('')

  // A card whose column is absent from the config is invisible on the live
  // board and still in the file — the orphan state `docket doctor` reports. A
  // read-only view that also hid it would be the second place it disappears.
  const orphanSection = orphans.length
    ? [
        `<section class="column orphans" id="col-orphans">`,
        `<div class="column-head"><span class="micro warnfg">not in any column</span><span class="micro count">${orphans.length}</span></div>`,
        `<div class="column-note micro">these cards name a column this board's config does not define, so the live board cannot show them at all. <code>docket doctor</code> reports them.</div>`,
        orphans.map((card) => cardHtml(card, { config, nowMs })).join(''),
        `</section>`,
      ].join('')
    : ''

  const provenance = [
    `rev ${escapeHtml(String(board?.rev ?? '?'))}`,
    board?.updatedAt ? `board saved ${escapeHtml(stamp(board.updatedAt))}` : '',
    meta.commit ? `commit <code>${escapeHtml(meta.commit)}</code>` : '',
    `rendered ${escapeHtml(stamp(now))}`,
  ]
    .filter(Boolean)
    .join(' · ')

  const title = config?.name ? `${config.name} · snapshot` : 'Docket · snapshot'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<style>
${styles(accent, meta.fonts ?? {})}
</style>
</head>
<body>
<header>
<div class="banner micro">read-only snapshot — nothing here writes to the board</div>
<h1>${escapeHtml(config?.name ?? 'Docket')}</h1>
<div class="prov micro">${provenance}</div>
<nav>${nav}</nav>
</header>
<main>
${sections}
${orphanSection}
</main>
<footer class="micro">
<p>Rendered from the committed <code>.docket/board.json</code>. The board in the project repo is the single copy; this is a view of it at rev ${escapeHtml(String(board?.rev ?? '?'))} and will not update.</p>
<p>To change anything, use the live board on the Mac, or send a note to the capture bot — a phone can still write that way, and it queues in git until the drain runs.</p>
</footer>
</body>
</html>
`
}

/**
 * The visual language, copied in intent from ui/style.css: Geist, hairlines,
 * square corners, mono micro-labels, one accent.
 *
 * Restated here rather than imported because a snapshot must survive with no
 * server to serve style.css and no build step to concatenate it — and because
 * the layouts genuinely differ. The live board is seven horizontal columns for
 * a mouse; this is one vertical scroll for a thumb, which is the same content
 * with a different geometry rather than the same CSS at a breakpoint.
 */
function styles(accent, fonts) {
  // The last unvalidated interpolation into CSS in this file, closed for the same
  // reason safeColor exists. Inert for both real callers — docket.js and
  // build.mjs each base64-encode a local file, and the base64 alphabet contains
  // no `)`, `;` or `{` — but "inert because of who happens to call it" is the
  // property that stops being true first. A gate demonstrated a hostile
  // fonts.sans producing a live `body{background-image:url(...)}` rule.
  const face = (family, data) =>
    BASE64.test(String(data ?? ''))
      ? `@font-face{font-family:'${family}';font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${data}) format('woff2');}`
      : ''
  return `
${face('Geist', fonts.sans)}
${face('Geist Mono', fonts.mono)}
:root{
  --bg:#0b0b0c; --fg:#f4f2ef; --muted:#8d8a85; --accent:${accent};
  --hair:rgba(244,242,239,.085); --hair-lit:rgba(244,242,239,.2);
  --warn:#d8a13c; --ok:#5f9e6e; --fail:#c1554e;
  --mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --pad:clamp(1rem,4vw,2rem);
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font-family:'Geist',ui-sans-serif,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
  padding-bottom:3rem;
  /* ONE inherited declaration, not a list of elements.
     A pasted PR URL in a card title is ~68 unbroken characters and a 390px
     column fits about 35, so without this the page scrolls sideways on the one
     device it exists for. It was a per-element list first, and it missed
     .card-title, .card-tag, .note-head and .idline - which is what a list does.
     "anywhere" rather than "break-word" because only anywhere shrinks a box's
     min-content size, and the metadata rows are flex containers whose items
     would otherwise refuse to shrink below their longest word. */
  overflow-wrap:anywhere;
}
.micro{font-family:var(--mono);font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.micro.dim,.dim{opacity:.65}
code{font-family:var(--mono);font-size:.85em;background:rgba(244,242,239,.06);padding:.05em .3em}
a{color:var(--accent)}

/* ---- Header. Sticky nav, because a seven-column board is a long scroll on a
   phone and the alternative is thumbing back to the top every time. -------- */
header{padding:var(--pad) var(--pad) 0;border-bottom:1px solid var(--hair)}
.banner{
  display:block;color:var(--warn);border:1px solid var(--hair-lit);
  padding:.45rem .6rem;margin-bottom:.9rem;line-height:1.5;
}
h1{font-size:1.35rem;font-weight:500;letter-spacing:-.035em;margin:0}
.prov{margin-top:.4rem;line-height:1.7;text-transform:none;letter-spacing:.06em}
nav{
  display:flex;gap:.4rem;overflow-x:auto;padding:.9rem 0 .8rem;
  scrollbar-width:none;-webkit-overflow-scrolling:touch;
}
nav::-webkit-scrollbar{display:none}
.chip{
  flex:0 0 auto;border:1px solid var(--hair);padding:.32rem .5rem;
  text-decoration:none;color:var(--muted);white-space:nowrap;
}
.chip .n{color:var(--fg);margin-left:.15rem}
.chip.empty{opacity:.45}
.chip.empty .n{color:var(--muted)}

/* ---- Columns, stacked ---------------------------------------------------- */
main{padding:0 var(--pad)}
.column{padding:1.6rem 0 .4rem;border-bottom:1px solid var(--hair)}
.column:last-child{border-bottom:0}
.column-head{
  display:flex;align-items:baseline;gap:.6rem;
  position:sticky;top:0;z-index:2;background:var(--bg);
  padding:.5rem 0;margin-bottom:.5rem;
}
.column-head .count{color:var(--fg)}
.column-head .warnfg{color:var(--warn)}
.column-note{text-transform:none;letter-spacing:.04em;line-height:1.7;margin-bottom:.8rem;color:var(--warn)}
.column-empty{padding:.3rem 0 .8rem;opacity:.5}

/* ---- Cards. <details> so expanding needs no script. --------------------- */
.card{border:1px solid var(--hair);margin-bottom:.55rem;background:rgba(244,242,239,.014)}
.card.flagged{border-left:2px solid var(--accent)}
.card[open]{border-color:var(--hair-lit)}
summary{
  list-style:none;cursor:pointer;padding:.7rem .75rem;
  /* The tap target is the whole face, so no min-height is needed — but the
     marker has to go on both engines or a stray triangle sits in the corner. */
}
summary::-webkit-details-marker{display:none}
summary::marker{content:''}
.card-meta{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.4rem}
.card-tag{font-family:var(--mono);font-size:.6rem;letter-spacing:.12em;text-transform:uppercase}
.card-marks{margin-left:auto;display:flex;align-items:center;gap:.4rem}
.verdict{
  font-family:var(--mono);font-size:.58rem;letter-spacing:.12em;text-transform:uppercase;
  border:1px solid currentColor;padding:.1rem .3rem;
}
.verdict[data-verdict=meets]{color:var(--ok)}
.verdict[data-verdict=fails]{color:var(--fail)}
.flag{color:var(--accent)}
.card-title{font-size:.95rem;line-height:1.4;letter-spacing:-.01em}
.card-detail{
  margin-top:.35rem;font-size:.82rem;line-height:1.5;color:var(--muted);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.card[open] .card-detail{display:none}
.brief-warn{margin-top:.45rem;color:var(--warn)}
.card-foot{display:flex;gap:.7rem;margin-top:.5rem}
.card-foot>span{white-space:nowrap;flex:0 0 auto}
.card-foot>span:last-child{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}

.card-body{padding:0 .75rem .8rem;border-top:1px solid var(--hair);margin-top:.15rem;padding-top:.75rem}
.detail{font-size:.86rem;line-height:1.65;white-space:pre-wrap}
.brief-row{margin-bottom:.75rem}
.brief-row .micro{color:var(--muted);margin-bottom:.2rem}
.brief-row .micro.req{color:var(--fg)}
.brief-val{font-size:.86rem;line-height:1.6;white-space:pre-wrap}
.note{border-left:1px solid var(--hair-lit);padding:.1rem 0 .1rem .6rem;margin-top:.8rem}
.note-verdict[data-verdict=meets]{border-left-color:var(--ok)}
.note-verdict[data-verdict=fails]{border-left-color:var(--fail)}
.note-head{display:flex;gap:.5rem;margin-bottom:.25rem}
.note-text{font-size:.82rem;line-height:1.6;white-space:pre-wrap}
.note-more>summary{list-style:none;cursor:pointer;margin-top:.3rem;color:var(--muted)}
.note-more>summary::-webkit-details-marker{display:none}
.note-more>summary:hover{color:var(--accent)}
.note-more .when-open{display:none}
.note-more[open] .when-open{display:inline}
.note-more[open] .when-closed{display:none}
.note-more>.note-text{margin-top:.4rem}
.time-chip.running{color:var(--accent)}
.time-log{margin-top:.8rem;border-left:1px solid var(--hair-lit);padding:.1rem 0 .1rem .6rem}
.session{font-family:var(--mono);font-size:.62rem;letter-spacing:.04em;color:var(--muted);margin-top:.35rem;display:flex;flex-wrap:wrap;gap:.2rem .8rem}
.session.running{color:var(--accent)}
.session-note{font-family:'Geist',ui-sans-serif,system-ui,sans-serif;font-size:.78rem;letter-spacing:0;color:var(--fg)}
.idline{margin-top:.9rem;text-transform:none;letter-spacing:.06em;opacity:.4}

footer{padding:1.6rem var(--pad) 0;border-top:1px solid var(--hair);margin-top:1.5rem}
footer p{text-transform:none;letter-spacing:.04em;line-height:1.8;margin:0 0 .7rem;max-width:44rem}

/* A tablet or a desktop gets two columns of the same stack — the content is
   identical, so this is the one place a breakpoint is only about width. */
@media (min-width:900px){
  main{columns:2;column-gap:2rem}
  .column{break-inside:avoid-column}
  .column-head{position:static}
}
`
}
