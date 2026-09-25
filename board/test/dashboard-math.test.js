import { test } from 'node:test'
import assert from 'node:assert/strict'

import { allSessions, dailyTotals, dueStatus, money, perCard, timeFormHoldsEntry } from '../ui/dashboard-math.js'

// The dashboard's arithmetic, pure, so the page and any later command agree.
// Spec: docs/specs/2026-09-17-manual-time-and-dashboard-design.md

const NOW = Date.parse('2026-09-17T12:00:00.000Z')
const s = (day, h1, h2, note = '') => ({ start: `${day}T${h1}:00:00.000Z`, stop: `${day}T${h2}:00:00.000Z`, note })
const card = (id, over = {}) => ({ id, title: id, column: 'next', estimateMinutes: null, due: null, time: { running: null, sessions: [] }, ...over })

test('perCard lists cards that carry time, an estimate or a due date — biggest first, with each share of the total', () => {
  const cards = [
    card('quiet'),
    card('big', { time: { running: null, sessions: [s('2026-09-16', '09', '12')] } }),
    card('small', { time: { running: null, sessions: [s('2026-09-16', '13', '14')] }, estimateMinutes: 120 }),
    card('planned', { due: '2026-09-30' }),
  ]
  const rows = perCard(cards, NOW)
  assert.deepEqual(rows.map((r) => r.id), ['big', 'small', 'planned'])
  assert.equal(rows[0].ms, 3 * 3600e3)
  assert.equal(rows[0].share, 0.75)
  assert.equal(rows[1].remainingMs, 60 * 60e3, 'two hours estimated, one logged')
  assert.equal(rows[2].ms, 0)
})

test('dailyTotals covers the last N days ending today, attributing a session to the day it started', () => {
  const cards = [card('a', { time: { running: null, sessions: [s('2026-09-17', '08', '10'), s('2026-09-16', '22', '23'), s('2026-09-01', '09', '10')] } })]
  const days = dailyTotals(cards, 14, NOW, 'UTC')
  assert.equal(days.length, 14)
  assert.equal(days.at(-1).date, '2026-09-17')
  assert.equal(days.at(-1).ms, 2 * 3600e3)
  assert.equal(days.at(-2).ms, 3600e3)
  assert.equal(days[0].date, '2026-09-04')
  assert.equal(days.reduce((sum, d) => sum + d.ms, 0), 3 * 3600e3, 'the 1 Sep session is outside the window')
})

test('dueStatus counts days and says late', () => {
  assert.deepEqual(dueStatus('2026-09-20', '2026-09-17'), { daysLeft: 3, late: false })
  assert.deepEqual(dueStatus('2026-09-17', '2026-09-17'), { daysLeft: 0, late: false })
  assert.deepEqual(dueStatus('2026-09-15', '2026-09-17'), { daysLeft: -2, late: true })
  assert.equal(dueStatus(null, '2026-09-17'), null)
})

test('money is hours times rate, and nothing without a rate', () => {
  assert.equal(money(90 * 60e3, 100), 150)
  assert.equal(money(90 * 60e3, null), null)
  assert.equal(money(90 * 60e3, undefined), null)
})

test('allSessions flattens every card, newest first, naming the card', () => {
  const cards = [
    card('a', { time: { running: null, sessions: [s('2026-09-15', '09', '10', 'older')] } }),
    card('b', { time: { running: null, sessions: [s('2026-09-16', '09', '10', 'newer')] } }),
  ]
  assert.deepEqual(allSessions(cards).map((x) => [x.cardId, x.note]), [['b', 'newer'], ['a', 'older']])
})

// The per-card bar: a share of the board's total when there is no estimate; a
// meter of time spent against the estimate when there is one, warn when over.
// The owner's ask, 2026-09-18.
import { barFor } from '../ui/dashboard-math.js'

test('barFor: no estimate → the share of the total, as before', () => {
  assert.deepEqual(barFor({ ms: 3 * 3600e3, share: 0.75, estimateMinutes: null }), { kind: 'share', fraction: 0.75, over: false })
})

test('barFor: an estimate → the fraction of it that is spent, capped at the full bar and flagged when over', () => {
  assert.deepEqual(barFor({ ms: 60 * 60e3, share: 0.2, estimateMinutes: 120 }), { kind: 'budget', fraction: 0.5, over: false })
  assert.deepEqual(barFor({ ms: 150 * 60e3, share: 0.9, estimateMinutes: 120 }), { kind: 'budget', fraction: 1, over: true })
  assert.deepEqual(barFor({ ms: 0, share: 0, estimateMinutes: 120 }), { kind: 'budget', fraction: 0, over: false })
  assert.deepEqual(barFor({ ms: 10 * 60e3, share: 1, estimateMinutes: 0 }), { kind: 'budget', fraction: 1, over: true }, 'an estimate of nothing is over the moment anything is logged')
})

test('barFor: seconds past the estimate fill the bar without turning it over; a minute does', () => {
  assert.deepEqual(barFor({ ms: 120 * 60e3 + 2312, share: 1, estimateMinutes: 120 }), { kind: 'budget', fraction: 1, over: false })
  assert.deepEqual(barFor({ ms: 121 * 60e3, share: 1, estimateMinutes: 120 }), { kind: 'budget', fraction: 1, over: true })
})

// Card vtdz: the self-reload asked only whether focus was inside the Add time
// form, so a filled-in entry the owner had clicked away from was thrown away by
// the next UI version. "Entered" means changed from what openDefaults put there
// — the clocks are pre-filled, so non-empty proves nothing.
const baseline = { date: '2026-09-24', start: '11:00', stop: '12:00', minutes: '60', note: '' }

test('an untouched form holds nothing, pre-filled clocks and all', () => {
  assert.equal(timeFormHoldsEntry({ ...baseline }, baseline), false)
})

test('a typed description is an entry', () => {
  assert.equal(timeFormHoldsEntry({ ...baseline, note: 'wrote the spec' }, baseline), true)
})

test('whitespace alone in the description is not an entry', () => {
  assert.equal(timeFormHoldsEntry({ ...baseline, note: '   ' }, baseline), false)
})

test('a changed clock, date or duration is an entry', () => {
  for (const change of [{ start: '09:30' }, { stop: '12:45' }, { date: '2026-09-23' }, { minutes: '90' }]) {
    assert.equal(timeFormHoldsEntry({ ...baseline, ...change }, baseline), true, JSON.stringify(change))
  }
})

test('a half-typed time reads as empty and still counts as an entry', () => {
  // An <input type=time> reports '' until complete; that is a change, not idleness.
  assert.equal(timeFormHoldsEntry({ ...baseline, start: '' }, baseline), true)
})

test('typing back to the defaults is idle again', () => {
  assert.equal(timeFormHoldsEntry({ ...baseline, note: '' }, { ...baseline }), false)
})

test('missing input does not throw and counts as untouched', () => {
  assert.equal(timeFormHoldsEntry({}, {}), false)
  assert.equal(timeFormHoldsEntry(undefined, undefined), false)
})
