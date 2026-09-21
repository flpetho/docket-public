/**
 * Time worked, as a field on the card: `{ running: <ISO> | null, sessions:
 * [{ start, stop, note }] }`. Totals are computed here, never stored. Pure and
 * shared — the panel, the card face, the snapshot and the MCP tools all import
 * this, so no two of them can disagree about a total or a label.
 * Spec: docs/specs/2026-09-14-card-timer-design.md
 */

export const emptyTime = () => ({ running: null, sessions: [] })

const ms = (iso) => Date.parse(iso) || 0
const span = (start, stop) => Math.max(0, ms(stop) - ms(start))

/** Sessions plus the running span. A card from before the field counts as zero. */
export function totalMs(time, nowMs = Date.now()) {
  if (!time) return 0
  const logged = (time.sessions ?? []).reduce((sum, s) => sum + span(s.start, s.stop), 0)
  const live = time.running ? Math.max(0, nowMs - ms(time.running)) : 0
  return logged + live
}

/** `<1m`, `12m`, `1h 12m` — or, with seconds, `12m 34s`, for the live tick. */
export function formatDuration(total, { seconds = false } = {}) {
  const wholeMinutes = Math.floor(total / 60e3)
  if (seconds) return `${wholeMinutes}m ${Math.floor((total % 60e3) / 1e3)}s`
  if (wholeMinutes < 1) return '<1m'
  const h = Math.floor(wholeMinutes / 60)
  const m = wholeMinutes % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

/**
 * The pieces of a session, returned separately so a layout can place them: en-GB
 * now spells the short month "Sept", and the pieces are wanted in this order
 * whatever a locale prefers. `timeZone` is for tests; the panel and the
 * snapshot use the machine's.
 */
export function formatSessionParts(session, { timeZone, locale = 'en-US' } = {}) {
  const start = new Date(session.start)
  const stop = new Date(session.stop)
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone })
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
  const part = (parts, type) => parts.find((p) => p.type === type)?.value ?? ''
  const d = day.formatToParts(start)
  return {
    day: `${part(d, 'weekday')} ${part(d, 'day')} ${part(d, 'month')}`,
    clock: `${clock.format(start)}–${clock.format(stop)}`,
    duration: formatDuration(span(session.start, session.stop)),
  }
}

/** `Sun 14 Sep · 09:12–10:24 · 1h 12m` — the parts above, joined. */
export function formatSession(session, options = {}) {
  const { day, clock, duration } = formatSessionParts(session, options)
  return `${day} · ${clock} · ${duration}`
}
const timeOf = (card) => {
  if (!card.time) card.time = emptyTime()
  return card.time
}

/**
 * One timer per board — the owner's ruling. Whatever else is running is
 * stopped and its session logged in the same pass, so a second Start can
 * never double-count an hour. Works in place on the cards the sync layer
 * hands it, like every mutation on this board; returns the ids it stopped.
 */
export function startTimer(cards, id, nowIso) {
  const stopped = []
  for (const other of cards) {
    if (other.id === id || !other.time?.running) continue
    stopTimer(other, nowIso)
    stopped.push(other.id)
  }
  const target = cards.find((c) => c.id === id)
  if (target) {
    const time = timeOf(target)
    if (!time.running) time.running = nowIso
  }
  return stopped
}

/** Closes the running session, appends it, clears `running`; hands the session back. */
export function stopTimer(card, nowIso) {
  const time = timeOf(card)
  if (!time.running) return null
  const session = { start: time.running, stop: nowIso, note: '' }
  time.sessions.push(session)
  time.running = null
  return session
}

export function setSessionNote(card, index, text) {
  const session = timeOf(card).sessions[index]
  if (session) session.note = String(text ?? '')
}

export function deleteSession(card, index) {
  const sessions = timeOf(card).sessions
  if (index >= 0 && index < sessions.length) sessions.splice(index, 1)
}

/**
 * A session that was not clocked — a call, a whiteboard, a drive. Validates,
 * appends, and keeps `sessions` ordered by start so a backdated entry lands
 * where it belongs rather than at the end. Returns the session, or null when
 * the span is not real, in which case the card is left exactly as it was.
 *
 * It deliberately does NOT touch `running`: logging this morning's call during
 * this afternoon's session is legitimate, and stopping the clock as a side
 * effect of typing would be a surprise.
 */
export function addSession(card, { start, stop, note = '' }) {
  if (validSpan(start, stop)) return null
  const from = ms(start)
  const to = ms(stop)
  if (!from || !to || to <= from || to - from > 86400000) return null
  const session = { start, stop, note: String(note ?? '') }
  const sessions = timeOf(card).sessions
  sessions.push(session)
  sessions.sort((a, b) => ms(a.start) - ms(b.start))
  return session
}

/**
 * What is left of the estimate, in ms. Null when the card carries none, so a
 * caller can tell "no budget" from "no time left". Negative means over, and
 * how to say that is the caller's business.
 */
export function remaining(card, nowMs = Date.now()) {
  const minutes = card?.estimateMinutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return null
  return minutes * 60e3 - totalMs(card?.time, nowMs)
}

/**
 * The one span rule, shared by the Add time form and addSession so the panel
 * cannot accept what the model refuses. Null when the span is real; otherwise
 * the sentence to show. (spec 2026-09-17)
 */
export function validSpan(start, stop) {
  const a = Date.parse(start)
  const b = Date.parse(stop)
  if (Number.isNaN(a) || Number.isNaN(b)) return 'start and stop must be dates'
  if (b <= a) return 'stop must come after start'
  if (b - a > 24 * 3600e3) return 'a session longer than 24 hours is a typo, not a day'
  return null
}

/**
 * Over means at least one whole minute over — the smallest amount the display
 * can show. A timer stops on a second, not a minute boundary; 2.3 seconds past
 * a two-hour estimate must not turn a bar amber while the text reads "2h 0m of
 * 2h". The bar and the head line both decide through this, so they agree.
 */
export function overBudget(loggedMs, budgetMs) {
  return loggedMs - budgetMs >= 60e3
}

/** `5h` rather than `5h 0m` for a budget; the logged side keeps its minutes. */
const tidy = (total) => formatDuration(total).replace(/ 0m$/, '')

/**
 * The Time head when a card carries an estimate: `2h 15m of 5h · 2h 45m left`,
 * or `5h 30m of 5h · 30m over`. Null without an estimate, so the head reads as
 * it always did. `over` is for the caller to colour — the warn colour, never
 * the accent, which is spoken for.
 */
export function formatBudget(card, nowMs = Date.now()) {
  if (typeof card?.estimateMinutes !== 'number') return null
  const logged = totalMs(card.time, nowMs)
  const budget = card.estimateMinutes * 60e3
  const left = budget - logged
  const over = overBudget(logged, budget)
  return {
    text: `${formatDuration(logged)} of ${tidy(budget)} · ${tidy(Math.abs(left))} ${over ? 'over' : 'left'}`,
    over,
  }
}

/**
 * The Add time form thinks in a local date and clock; the card stores instants.
 * These two convert, and refuse an impossible date rather than letting the Date
 * constructor roll it over into a different day.
 */
export function localIso(date, clock) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  const c = /^(\d{2}):(\d{2})$/.exec(clock ?? '')
  if (!d || !c) return null
  const [y, mo, da] = d.slice(1).map(Number)
  const [h, mi] = c.slice(1).map(Number)
  const when = new Date(y, mo - 1, da, h, mi, 0, 0)
  const same =
    when.getFullYear() === y && when.getMonth() === mo - 1 && when.getDate() === da && when.getHours() === h && when.getMinutes() === mi
  return same ? when.toISOString() : null
}

export function localParts(iso) {
  const when = new Date(iso)
  const two = (n) => String(n).padStart(2, '0')
  return {
    date: `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`,
    clock: `${two(when.getHours())}:${two(when.getMinutes())}`,
  }
}

/** A duration typed into the form moves the stop; nothing long is not a session. */
export function spanFromDuration(startIso, minutes) {
  const start = Date.parse(startIso)
  if (Number.isNaN(start) || !(minutes > 0)) return null
  return new Date(start + minutes * 60e3).toISOString()
}
