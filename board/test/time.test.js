import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addSession,
  deleteSession,
  emptyTime,
  formatDuration,
  formatSession,
  formatSessionParts,
  remaining,
  setSessionNote,
  startTimer,
  stopTimer,
  totalMs,
} from '../ui/time.js'

// Time worked, as a field on the card (decision log 2026-09-14). Pure and shared:
// the panel, the face, the snapshot and the MCP tools all import this.

const T0 = '2026-09-14T09:12:00.000Z'
const T1 = '2026-09-14T10:24:00.000Z' // 1h 12m later
const T2 = '2026-09-14T11:00:00.000Z'
const card = (id, time = emptyTime()) => ({ id, title: id, time })

test('an empty time has nothing running and no sessions', () => {
  assert.deepEqual(emptyTime(), { running: null, sessions: [] })
})

test('totalMs sums the sessions and the running span', () => {
  const time = { running: T1, sessions: [{ start: T0, stop: T1, note: '' }] }
  assert.equal(totalMs(time, Date.parse(T2)), 72 * 60e3 + 36 * 60e3)
  assert.equal(totalMs({ running: null, sessions: [] }, Date.parse(T2)), 0)
  assert.equal(totalMs(undefined, Date.parse(T2)), 0, 'a card from before the field')
})

test('formatDuration reads like a human wrote it', () => {
  assert.equal(formatDuration(0), '<1m')
  assert.equal(formatDuration(59e3), '<1m')
  assert.equal(formatDuration(12 * 60e3), '12m')
  assert.equal(formatDuration(72 * 60e3), '1h 12m')
  assert.equal(formatDuration(2 * 3600e3), '2h 0m')
  assert.equal(formatDuration(754e3, { seconds: true }), '12m 34s')
  assert.equal(formatDuration(5e3, { seconds: true }), '0m 5s')
})

test('formatSession is the day, the date, the span and the length', () => {
  assert.equal(formatSession({ start: T0, stop: T1, note: '' }, { timeZone: 'UTC' }), 'Mon 14 Sep · 09:12–10:24 · 1h 12m')
})

test('startTimer stops whatever else is running on the board and logs it, in the same pass', () => {
  const a = card('A', { running: T0, sessions: [] })
  const b = card('B')
  const c = card('C', { running: null, sessions: [{ start: T0, stop: T1, note: 'earlier' }] })
  const stopped = startTimer([a, b, c], 'B', T1)
  assert.deepEqual(stopped, ['A'])
  assert.equal(a.time.running, null)
  assert.deepEqual(a.time.sessions, [{ start: T0, stop: T1, note: '' }])
  assert.equal(b.time.running, T1)
  assert.deepEqual(c.time.sessions.length, 1, 'an idle card is untouched')
})

test('startTimer on a card already running is a no-op', () => {
  const a = card('A', { running: T0, sessions: [] })
  assert.deepEqual(startTimer([a], 'A', T1), [])
  assert.equal(a.time.running, T0)
})

test('startTimer on a card from before the field gives it one', () => {
  const old = { id: 'old', title: 'old' }
  startTimer([old], 'old', T0)
  assert.deepEqual(old.time, { running: T0, sessions: [] })
})

test('stopTimer closes the session, appends it, clears running, and hands it back', () => {
  const a = card('A', { running: T0, sessions: [] })
  const session = stopTimer(a, T1)
  assert.deepEqual(session, { start: T0, stop: T1, note: '' })
  assert.deepEqual(a.time, { running: null, sessions: [{ start: T0, stop: T1, note: '' }] })
  assert.equal(stopTimer(a, T2), null, 'nothing running, nothing stopped')
})

test('a description is set on one session; a session can be removed', () => {
  const a = card('A', { running: null, sessions: [{ start: T0, stop: T1, note: '' }, { start: T1, stop: T2, note: 'x' }] })
  setSessionNote(a, 0, 'wrote the spec')
  assert.equal(a.time.sessions[0].note, 'wrote the spec')
  assert.equal(a.time.sessions[1].note, 'x')
  deleteSession(a, 1)
  assert.deepEqual(a.time.sessions.map((s) => s.note), ['wrote the spec'])
  deleteSession(a, 7)
  assert.equal(a.time.sessions.length, 1, 'an index off the end removes nothing')
})

// Manual entry, the estimate arithmetic, and the parts a two-line row needs.
// Spec: docs/specs/2026-09-17-manual-time-and-dashboard-design.md

test('addSession appends a session and hands it back', () => {
  const a = card('A')
  const session = addSession(a, { start: T0, stop: T1, note: 'a call' })
  assert.deepEqual(session, { start: T0, stop: T1, note: 'a call' })
  assert.deepEqual(a.time.sessions, [{ start: T0, stop: T1, note: 'a call' }])
})

test('addSession keeps sessions ordered by start, so a backdated entry lands in place', () => {
  const early = '2026-09-14T07:00:00.000Z'
  const a = card('A', { running: null, sessions: [{ start: T0, stop: T1, note: 'second' }, { start: T1, stop: T2, note: 'third' }] })
  addSession(a, { start: early, stop: T0, note: 'first' })
  assert.deepEqual(a.time.sessions.map((s) => s.note), ['first', 'second', 'third'])
})

test('addSession refuses a span that is not real, and changes nothing when it does', () => {
  const a = card('A', { running: null, sessions: [{ start: T0, stop: T1, note: 'kept' }] })
  const before = JSON.stringify(a.time)
  assert.equal(addSession(a, { start: T1, stop: T0, note: 'backwards' }), null)
  assert.equal(addSession(a, { start: T0, stop: T0, note: 'zero' }), null)
  assert.equal(addSession(a, { start: 'not a date', stop: T1, note: 'junk' }), null)
  assert.equal(addSession(a, { start: T0, stop: '2026-09-16T09:12:00.000Z', note: 'two days' }), null)
  assert.equal(JSON.stringify(a.time), before, 'a refusal leaves the card alone')
})

test('addSession does not touch a running timer — logging a call mid-session is legitimate', () => {
  const a = card('A', { running: T2, sessions: [] })
  addSession(a, { start: T0, stop: T1, note: 'this morning' })
  assert.equal(a.time.running, T2, 'still clocked in')
  assert.equal(a.time.sessions.length, 1)
})

test('addSession gives a card from before the field a time', () => {
  const old = { id: 'old', title: 'old' }
  addSession(old, { start: T0, stop: T1, note: '' })
  assert.deepEqual(old.time, { running: null, sessions: [{ start: T0, stop: T1, note: '' }] })
})

test('remaining is the estimate minus what is logged, and null without one', () => {
  const none = card('A', { running: null, sessions: [{ start: T0, stop: T1, note: '' }] })
  assert.equal(remaining(none), null, 'no estimate, no remainder')

  const under = { ...card('B', { running: null, sessions: [{ start: T0, stop: T1, note: '' }] }), estimateMinutes: 300 }
  assert.equal(remaining(under), (300 - 72) * 60e3)

  const over = { ...card('C', { running: null, sessions: [{ start: T0, stop: T1, note: '' }] }), estimateMinutes: 60 }
  assert.ok(remaining(over) < 0, 'over budget reads negative')
  assert.equal(remaining(over), (60 - 72) * 60e3)
})

test('formatSessionParts returns the pieces a two-line row places itself', () => {
  const parts = formatSessionParts({ start: T0, stop: T1, note: '' }, { timeZone: 'UTC' })
  assert.deepEqual(parts, { day: 'Mon 14 Sep', clock: '09:12–10:24', duration: '1h 12m' })
})

test('formatSession still returns the one string it always did, built from those parts', () => {
  assert.equal(
    formatSession({ start: T0, stop: T1, note: '' }, { timeZone: 'UTC' }),
    'Mon 14 Sep · 09:12–10:24 · 1h 12m',
  )
})

// The budget line, the form's clock arithmetic, and the span rule the form and
// addSession share. Spec: docs/specs/2026-09-17-manual-time-and-dashboard-design.md

import { formatBudget, localIso, localParts, spanFromDuration, validSpan } from '../ui/time.js'

test('formatBudget reads "logged of estimate · left", and "over" past the budget', () => {
  const under = { estimateMinutes: 300, time: { running: null, sessions: [{ start: '2026-09-14T09:00:00.000Z', stop: '2026-09-14T11:15:00.000Z', note: '' }] } }
  assert.deepEqual(formatBudget(under, Date.parse(T2)), { text: '2h 15m of 5h · 2h 45m left', over: false })
  const over = { estimateMinutes: 300, time: { running: null, sessions: [{ start: '2026-09-14T09:00:00.000Z', stop: '2026-09-14T14:30:00.000Z', note: '' }] } }
  assert.deepEqual(formatBudget(over, Date.parse(T2)), { text: '5h 30m of 5h · 30m over', over: true })
  assert.equal(formatBudget({ estimateMinutes: null, time: emptyTime() }), null, 'no estimate, no budget line')
  assert.deepEqual(formatBudget({ estimateMinutes: 90, time: emptyTime() }), { text: '<1m of 1h 30m · 1h 30m left', over: false })
})

test('the form composes a local date and clock into an instant, and reads one back', () => {
  const iso = localIso('2026-09-14', '09:12')
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(localParts(iso), { date: '2026-09-14', clock: '09:12' })
  assert.equal(localIso('2026-13-40', '09:12'), null, 'an impossible date is null, not an Invalid Date')
  assert.equal(localIso('2026-09-14', '25:00'), null)
})

test('a duration typed into the form moves the stop', () => {
  assert.equal(spanFromDuration('2026-09-14T09:12:00.000Z', 72), '2026-09-14T10:24:00.000Z')
  assert.equal(spanFromDuration('2026-09-14T09:12:00.000Z', 0), null, 'nothing long is not a session')
  assert.equal(spanFromDuration('2026-09-14T09:12:00.000Z', -5), null)
})

test('validSpan is the one rule the form and addSession both apply', () => {
  assert.equal(validSpan(T0, T1), null, 'a real span has nothing to say')
  assert.match(validSpan(T1, T0), /stop must come after start/)
  assert.match(validSpan(T0, T0), /stop must come after start/)
  assert.match(validSpan('nope', T1), /date/)
  assert.match(validSpan(T0, '2026-09-16T09:12:00.000Z'), /24 hours/)
})

// "Over" means at least one whole minute over — the smallest amount the display
// can show. A timer stops on a second, not a minute boundary, and 2.3 seconds
// past a two-hour estimate turned a bar amber on 2026-09-18.
import { overBudget } from '../ui/time.js'

test('overBudget: seconds past the estimate are not over; a whole minute is', () => {
  assert.equal(overBudget(7200000 + 2312, 7200000), false)
  assert.equal(overBudget(7200000 + 59999, 7200000), false)
  assert.equal(overBudget(7200000 + 60000, 7200000), true)
  assert.equal(overBudget(0, 0), false, 'nothing logged against nothing estimated is not over')
  assert.equal(overBudget(60000, 0), true)
})

test('formatBudget follows the same minute: full but not over, then over', () => {
  const at = (extraMs) => ({ estimateMinutes: 120, time: { running: null, sessions: [{ start: '2026-09-18T09:00:00.000Z', stop: new Date(Date.parse('2026-09-18T11:00:00.000Z') + extraMs).toISOString(), note: '' }] } })
  assert.deepEqual(formatBudget(at(2312), Date.parse(T2)), { text: '2h 0m of 2h · <1m left', over: false })
  assert.deepEqual(formatBudget(at(60000), Date.parse(T2)), { text: '2h 1m of 2h · 1m over', over: true })
})
