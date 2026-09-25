/**
 * One board's time, as a page: total tracked, per-card bars, fourteen days,
 * the session log, and a form that adds time through the same door the panel
 * uses — sync.js PUTs the whole board with the rev it read and adopts on 409.
 * There is no second write path. Spec: docs/specs/2026-09-17-manual-time-and-dashboard-design.md
 */
import { allSessions, barFor, dailyTotals, dayKey, dueStatus, money, perCard, timeFormHoldsEntry } from './dashboard-math.js'
import { mountPanel } from './panel.js'
import { createSync, loadProjects } from './sync.js'
import {
  addSession,
  deleteSession,
  formatDuration,
  formatSessionParts,
  localIso,
  localParts,
  setSessionNote,
  spanFromDuration,
  startTimer,
  stopTimer,
  totalMs,
  validSpan,
} from './time.js'

const slug = new URLSearchParams(location.search).get('project')
const $ = (id) => document.getElementById(id)
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const stamp = () => new Date().toISOString()
const fmtMoney = (n) => (n === null ? '' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
/** `5h` rather than `5h 0m` for a budget. */
const tidy = (ms) => formatDuration(ms).replace(/ 0m$/, '')

let config = { name: slug ?? 'Docket', rate: null }
let doc = null
let modal = null

const cardById = (id) => doc?.cards.find((card) => card.id === id) ?? null

const setStatus = (kind, text) => {
  const status = $('status')
  status.className = `micro ${kind}`
  status.textContent = text
  // Offline is read-only; the panel knows which of its controls that reaches.
  modal?.setOffline(kind === 'offline')
}

function renderTiles(cards, now) {
  const total = cards.reduce((sum, c) => sum + totalMs(c.time, now), 0)
  const days = dailyTotals(cards, 7, now)
  const week = days.reduce((sum, d) => sum + d.ms, 0)
  const today = days.at(-1)?.ms ?? 0
  const withTime = cards.filter((c) => totalMs(c.time, now) > 0).length
  const tiles = [
    ['Total tracked', formatDuration(total)],
    ['Today', formatDuration(today)],
    ['Last 7 days', formatDuration(week)],
    ['Cards with time', String(withTime)],
  ]
  if (typeof config.rate === 'number') tiles.push([`At ${config.rate}/h`, fmtMoney(money(total, config.rate))])
  const root = $('tiles')
  root.replaceChildren()
  for (const [label, value] of tiles) {
    const tile = el('div', 'tile')
    tile.append(el('span', 'micro', label), el('span', 'tile-value', value))
    root.append(tile)
  }
}

function renderChart(cards, now) {
  // Fourteen columns as a CSS grid, matching docket-dashboard/dashboard.html:
  // a hairline stub for an empty day, the accent for a day with time, height
  // scaled to the busiest day with a floor so a short day still shows, a title
  // per column as the tooltip, and the day of the month beneath each.
  const chart = $('chart')
  const labels = $('chart-labels')
  chart.replaceChildren()
  labels.replaceChildren()
  const days = dailyTotals(cards, 14, now)
  const peak = Math.max(1, ...days.map((d) => d.ms))
  for (const d of days) {
    const noon = new Date(`${d.date}T12:00:00`)
    const column = el('div', d.ms ? 'has' : '')
    column.style.height = `${d.ms ? Math.max(6, (d.ms / peak) * 100) : 2}%`
    column.title = `${noon.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${formatDuration(d.ms)}`
    chart.append(column)
    labels.append(el('span', '', noon.toLocaleDateString('en-US', { day: 'numeric' })))
  }
  $('days-total').textContent = formatDuration(days.reduce((sum, d) => sum + d.ms, 0))
}

function renderCards(cards, now) {
  const rows = perCard(cards, now)
  const root = $('cards')
  root.replaceChildren()
  const today = dayKey(now)
  $('rate-note').textContent = typeof config.rate === 'number' ? `at ${config.rate}/h · tracked time is not an invoice` : ''
  if (!rows.length) root.append(el('div', 'micro dim', 'no time on this board yet'))
  for (const row of rows) {
    const line = el('div', 'row')
    const title = el('div', 'row-title', row.title)
    const meta = el('div', 'row-meta')
    meta.append(el('span', 'session-duration' + (row.running ? ' running' : ''), row.running ? `${formatDuration(row.ms)} · running` : formatDuration(row.ms)))
    if (row.estimateMinutes !== null) {
      // `row.over` and not `remainingMs < 0`: the same decision the bar makes,
      // so a few seconds past an estimate does not say "<1m over" in amber
      // beside an accent bar. Below a whole minute the row still reads "0m
      // left", which is true and quiet.
      const over = row.over
      const left = Math.max(0, row.remainingMs)
      meta.append(
        el(
          'span',
          over ? 'warn' : '',
          `of ${tidy(row.estimateMinutes * 60e3)} · ${over ? `${tidy(-row.remainingMs)} over` : `${tidy(left)} left`}`,
        ),
      )
    }
    if (row.due) {
      const status = dueStatus(row.due, today)
      meta.append(el('span', status.late ? 'warn' : '', status.late ? `late ${Math.abs(status.daysLeft)}d` : status.daysLeft === 0 ? 'due today' : `due in ${status.daysLeft}d`))
    }
    if (typeof config.rate === 'number') meta.append(el('span', '', fmtMoney(money(row.ms, config.rate))))
    // The bar: a share of the board's total without an estimate; with one, a
    // meter — a lighter track for the whole estimate, the accent filling as
    // time is logged, the warn colour once it is over. The owner's ask.
    const meter = barFor(row)
    const bar = el('div', meter.kind === 'budget' ? `bar budget${meter.over ? ' over' : ''}` : 'bar')
    const fill = el('i')
    fill.style.width = `${Math.round(meter.fraction * 1000) / 10}%`
    if (meter.kind === 'budget') bar.title = meter.over ? 'over the estimate' : `${Math.round(meter.fraction * 100)}% of the estimate spent`
    bar.append(fill)
    line.append(title, meta, bar)
    root.append(line)
  }
}

function renderSessions(cards) {
  // A table, newest first, each column in its own voice so the hierarchy reads:
  // the when in mono micro grey, the card name small and secondary, the
  // description as the one line in body type, the duration in tabular mono on
  // the right — and the total beneath that column, so the eye can run down it.
  const sessions = allSessions(cards)
  const body = $('sessions-body')
  const foot = $('sessions-foot')
  body.replaceChildren()
  foot.replaceChildren()
  $('sessions-count').textContent = `${sessions.length}`
  let total = 0
  for (const session of sessions) {
    const parts = formatSessionParts(session)
    total += Math.max(0, (Date.parse(session.stop) || 0) - (Date.parse(session.start) || 0))
    const row = el('tr')
    const when = el('td', 's-when')
    when.append(el('span', 'when-day', parts.day), el('span', 'when-clock', parts.clock))
    // The card name opens the card, in the same panel the board uses. A button
    // rather than a link: it opens something here, it does not navigate, and a
    // button is what a keyboard and a screen reader already understand.
    const card = el('td', 's-card')
    const open = el('button', 's-open', session.title)
    open.type = 'button'
    open.title = 'Open this card'
    open.addEventListener('click', () => {
      const found = cardById(session.cardId)
      if (found) modal?.open(found)
      else setStatus('offline', 'that card is no longer on this board')
    })
    card.append(open)
    row.append(card, el('td', 's-note', session.note || ''), el('td', 's-time', parts.duration))
    row.prepend(when)
    body.append(row)
  }
  if (sessions.length) {
    const row = el('tr')
    const label = el('td', 'foot-label')
    label.colSpan = 3
    label.textContent = `${sessions.length} session${sessions.length > 1 ? 's' : ''} · total`
    row.append(label, el('td', 's-time', formatDuration(total)))
    foot.append(row)
  }
}

function renderAddCard(cards) {
  const select = $('add-card')
  const chosen = select.value
  select.replaceChildren()
  for (const card of [...cards].sort((a, b) => a.title.localeCompare(b.title))) {
    const option = el('option', '', card.title)
    option.value = card.id
    select.append(option)
  }
  if (chosen && cards.some((c) => c.id === chosen)) select.value = chosen
}

function render(next) {
  doc = next
  const now = Date.now()
  renderTiles(doc.cards, now)
  renderChart(doc.cards, now)
  renderCards(doc.cards, now)
  renderSessions(doc.cards)
  renderAddCard(doc.cards)
  // An open card repaints from the new document, the way the board's does —
  // otherwise a stream frame would leave the panel showing a stale card.
  modal?.refresh(cardById(modal.openId))
}

// ---- Add time: the same form as the panel, the same rules, the same door ----
const formInstants = () => ({
  start: localIso($('add-date').value, $('add-start').value),
  stop: localIso($('add-date').value, $('add-stop').value),
})
const syncMinutes = () => {
  const { start, stop } = formInstants()
  const minutes = start && stop ? Math.round((Date.parse(stop) - Date.parse(start)) / 60e3) : NaN
  $('add-minutes').value = minutes > 0 ? String(minutes) : ''
}
/** The Add time form's values, in the shape timeFormHoldsEntry compares. */
const readForm = () => ({
  date: $('add-date').value,
  start: $('add-start').value,
  stop: $('add-stop').value,
  minutes: $('add-minutes').value,
  note: $('add-note').value,
})
// What openDefaults last put in the form — the line between "untouched" and "entered".
let formBaseline = {}

function openDefaults() {
  const now = Date.now()
  const stopParts = localParts(new Date(now).toISOString())
  const startParts = localParts(new Date(now - 3600e3).toISOString())
  $('add-date').value = stopParts.date
  $('add-start').value = startParts.date === stopParts.date ? startParts.clock : '00:00'
  $('add-stop').value = stopParts.clock
  syncMinutes()
  formBaseline = readForm()
}

let uiVersion = null
let pendingReload = false
/**
 * Safe to reload? Not while the Add time form holds anything the owner entered,
 * and not while a card is open — that is #27's rule, and the panel here holds
 * exactly what it was written to protect: an unsaved edit and a half-typed note.
 *
 * It used to ask whether the form had FOCUS, so an entry filled in and then
 * clicked away from was lost to the next version (card vtdz). Focus alone no
 * longer defers anything: an untouched form has nothing to lose, and a deferral
 * held by focus would outlive the submit that emptied the form.
 */
const idle = () => !timeFormHoldsEntry(readForm(), formBaseline) && !(modal && modal.openId !== null)
const reloadSoon = () => {
  setStatus('live', 'new version · reloading')
  setTimeout(() => location.reload(), 400)
}

const sync = createSync({
  project: slug,
  onDoc: render,
  onStatus: setStatus,
  onUiVersion: (version) => {
    if (uiVersion === null) return void (uiVersion = version)
    if (version === uiVersion || pendingReload) return
    if (idle()) return reloadSoon()
    pendingReload = true
    setStatus('live', modal?.openId != null ? 'new version · reloading when the card closes' : 'new version · reloading once your entry is saved or cleared')
  },
})

async function boot() {
  if (!slug) {
    setStatus('offline', 'no project in the URL — open /dashboard?project=<slug>')
    return
  }
  try {
    const response = await fetch(`/api/config?project=${encodeURIComponent(slug)}`)
    if (response.ok) config = { ...config, ...(await response.json()) }
  } catch {
    /* the page still renders without a rate or a name */
  }
  document.documentElement.style.setProperty('--accent', config.accent ?? '#ff5227')
  $('project-name').textContent = `${config.name ?? slug} · time`
  document.title = `${config.name ?? slug} · time — Docket`
  $('back').href = `/?project=${encodeURIComponent(slug)}`
  try {
    const { version } = await (await fetch('/api/version')).json()
    if (uiVersion === null) uiVersion = version
  } catch {
    /* an older daemon */
  }
  // The card panel, the same one the board opens, mounted from the same module
  // so there is one copy of its markup and one element map. Every write goes
  // through this page's own sync — the same door the Add time form below uses.
  // `projects` only feeds the Board dropdown; without it, moving is the one
  // thing the panel cannot offer, and it still opens.
  let projects = []
  try {
    projects = await loadProjects()
  } catch {
    /* the panel opens without the Board dropdown's options */
  }
  modal = mountPanel({
    config,
    project: slug,
    projects,
    onChange: (id, apply) => {
      if (!id) return
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return
        const before = card.column
        apply(card)
        card.updatedAt = stamp()
        if (card.column !== before) card.columnSince = stamp()
      })
    },
    onAddNote: (id, text) =>
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return false
        card.notes.push({ author: 'owner', at: stamp(), text })
        card.updatedAt = stamp()
      }),
    onDeleteNote: (id, index) =>
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card || index < 0 || index >= card.notes.length) return false
        card.notes.splice(index, 1)
        card.updatedAt = stamp()
      }),
    // This page never opens a draft — it only opens cards that already carry a
    // session — so onCreate cannot fire. It is wired anyway rather than left
    // undefined, because a silent no-op that drops a card would be worse than
    // an honest write if some later path ever reaches it.
    onCreate: (card) =>
      sync.mutate((cards) => {
        cards.unshift(card)
      }),
    onDelete: (id) => {
      sync.mutate((cards) => {
        const index = cards.findIndex((card) => card.id === id)
        if (index !== -1) cards.splice(index, 1)
      })
    },
    onNotice: (message) => setStatus('offline', message),
    onTimer: (id, action) =>
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return false
        const now = stamp()
        if (action.type === 'start') {
          for (const stoppedId of startTimer(cards, id, now)) {
            const other = cards.find((c) => c.id === stoppedId)
            if (other) other.updatedAt = now
          }
        } else if (action.type === 'stop') stopTimer(card, now)
        else if (action.type === 'note') setSessionNote(card, action.index, action.text)
        else if (action.type === 'delete') deleteSession(card, action.index)
        else if (action.type === 'add') {
          if (!addSession(card, { start: action.start, stop: action.stop, note: action.note })) return false
        }
        card.updatedAt = now
      }),
    onMoveBoard: async (id, to) => {
      const response = await fetch(`/api/move?project=${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, to }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setStatus('offline', body.error ?? `move failed (${response.status})`)
        return { ok: false }
      }
      const name = projects.find((p) => p.slug === to)?.name ?? to
      setStatus('live', body.duplicate ? body.message : `moved to ${name}`)
      // No local mutation: the daemon rewrote the board and the stream frame
      // carrying the new rev repaints this page. The browser is a client.
      return { ok: true }
    },
  })
  openDefaults()

  // A reload deferred for an open card happens the moment the panel closes —
  // the board's own mechanism, for the same reason.
  const overlayElement = document.getElementById('overlay')
  new MutationObserver(() => {
    if (pendingReload && idle()) reloadSoon()
  }).observe(overlayElement, { attributes: true, attributeFilter: ['hidden'] })

  for (const id of ['add-date', 'add-start', 'add-stop']) $(id).addEventListener('input', syncMinutes)
  $('add-minutes').addEventListener('input', () => {
    const { start } = formInstants()
    const stop = spanFromDuration(start, Number($('add-minutes').value))
    if (!stop) return
    const parts = localParts(stop)
    if (parts.date !== $('add-date').value) return void ($('add-error').textContent = 'that many minutes would end on the next day')
    $('add-error').textContent = ''
    $('add-stop').value = parts.clock
  })
  // Clearing the form by hand releases a deferred reload as it happens; there
  // is no second event to wait for.
  $('add').addEventListener('input', () => {
    if (pendingReload && idle()) reloadSoon()
  })
  $('add').addEventListener('submit', async (event) => {
    event.preventDefault()
    const id = $('add-card').value
    const { start, stop } = formInstants()
    const problem = !id ? 'pick a card' : !start || !stop ? 'the date or a time is not valid' : validSpan(start, stop)
    if (problem) return void ($('add-error').textContent = problem)
    const note = $('add-note').value
    const outcome = await sync.mutate((cards) => {
      const card = cards.find((c) => c.id === id)
      if (!card) return false
      if (!addSession(card, { start, stop, note })) return false
      card.updatedAt = stamp()
    })
    if (outcome === 'lost') return void ($('add-error').textContent = 'could not save — nothing was written')
    $('add-error').textContent = ''
    $('add-note').value = ''
    openDefaults()
    if (pendingReload && idle()) reloadSoon()
  })

  // Only now the first board read, with every control already live. It used to
  // run before the panel was mounted, which left two windows: a click on a
  // session's card title in the first moments did nothing at all, and a write
  // by anyone else between load() and listen() went unseen until the safety
  // poll. Both closed by ordering, not by a guard. (Codex review, 2026-09-18.)
  const loaded = await sync.load()
  if (!loaded) return
  sync.listen()
  sync.pollSafety()
}

boot()
