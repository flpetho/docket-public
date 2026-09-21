/**
 * The dashboard's arithmetic, pure, so the page and any later command agree.
 * Spec: docs/specs/2026-09-17-manual-time-and-dashboard-design.md
 */
import { overBudget, remaining, totalMs } from './time.js'

const span = (s) => Math.max(0, (Date.parse(s.stop) || 0) - (Date.parse(s.start) || 0))

/** Cards that carry time, an estimate or a due date — biggest first, each with its share. */
export function perCard(cards, nowMs = Date.now()) {
  const rows = cards
    .filter((c) => totalMs(c.time, nowMs) > 0 || typeof c.estimateMinutes === 'number' || c.due)
    .map((c) => ({
      id: c.id,
      title: c.title,
      column: c.column,
      ms: totalMs(c.time, nowMs),
      running: Boolean(c.time?.running),
      estimateMinutes: typeof c.estimateMinutes === 'number' ? c.estimateMinutes : null,
      due: c.due ?? null,
      remainingMs: remaining(c, nowMs),
      // ONE over-budget decision per row, through the shared rule, so the text
      // and the bar cannot disagree. They did: the row's text tested
      // `remainingMs < 0` and turned amber a millisecond past the estimate
      // while the bar waited for a whole minute, so the live page read
      // "<1m over" in amber beside an accent bar (seen 2026-09-18).
      // `overBudget`'s own comment says both must decide through it.
      over:
        typeof c.estimateMinutes === 'number'
          ? overBudget(totalMs(c.time, nowMs), c.estimateMinutes * 60e3)
          : false,
    }))
    .sort((a, b) => b.ms - a.ms)
  const total = rows.reduce((sum, r) => sum + r.ms, 0)
  return rows.map((r) => ({ ...r, share: total ? r.ms / total : 0 }))
}

/** `YYYY-MM-DD` of an instant in a timezone (the machine's by default). */
export function dayKey(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(ms))
}

/** The last `days` days ending today; a session counts on the day it started. */
export function dailyTotals(cards, days = 14, nowMs = Date.now(), timeZone) {
  const buckets = new Map()
  for (let i = days - 1; i >= 0; i -= 1) buckets.set(dayKey(nowMs - i * 86400e3, timeZone), 0)
  for (const card of cards) {
    for (const session of card.time?.sessions ?? []) {
      const key = dayKey(Date.parse(session.start) || 0, timeZone)
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + span(session))
    }
  }
  return [...buckets].map(([date, ms]) => ({ date, ms }))
}

/** Days until a `YYYY-MM-DD` due date from a `YYYY-MM-DD` today; negative is late. */
export function dueStatus(due, todayKey) {
  if (!due) return null
  const at = (d) => Date.UTC(...d.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)))
  const daysLeft = Math.round((at(due) - at(todayKey)) / 86400e3)
  return { daysLeft, late: daysLeft < 0 }
}

/** Hours times the project's rate; nothing without a rate. Not an invoice. */
export function money(ms, rate) {
  return typeof rate === 'number' ? (ms / 3600e3) * rate : null
}

/** Every session on the board, newest first, naming its card. */
export function allSessions(cards) {
  return cards
    .flatMap((c) => (c.time?.sessions ?? []).map((s) => ({ ...s, cardId: c.id, title: c.title })))
    .sort((a, b) => (Date.parse(b.start) || 0) - (Date.parse(a.start) || 0))
}

/**
 * What the per-card bar shows. Without an estimate, the card's share of the
 * board's total — the bar as it always was. With one, a meter: the fraction of
 * the estimate spent, capped at the full bar, `over` once logged time passes it
 * so the caller can colour it the way the "30m over" text already is.
 */
export function barFor(row) {
  if (typeof row.estimateMinutes !== 'number') return { kind: 'share', fraction: row.share ?? 0, over: false }
  const budget = row.estimateMinutes * 60e3
  // The row already carries the decision (see perCard); fall back to the rule
  // itself so barFor stays usable on a hand-built row in a test.
  const over = row.over ?? overBudget(row.ms, budget)
  const fraction = budget > 0 ? Math.min(1, row.ms / budget) : row.ms > 0 ? 1 : 0
  return { kind: 'budget', fraction, over }
}
