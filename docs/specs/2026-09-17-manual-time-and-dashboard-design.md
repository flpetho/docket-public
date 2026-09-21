# Manual time entry, a readable session log, and a per-project time dashboard

**Date:** 2026-09-17 · **Status:** approved by the owner in conversation; the field question ruled
on explicitly (see *The reversal*). Raised from a client session; discussion card on this
board: *Manual time entry, a readable session log, and a per-project time dashboard*.

## Why

The owner: *"I love the timer, but I also need the ability to manually enter time to the card.
And on each time entry, can we have the text wrap so I can read the comment?"* Then, on the
bird's-eye view: *"In Notion, I had a roll up table that showed all the jobs and time associated to
each job… time spent, due dates, time left, hourly rate, with visual charts. It would be easier to
manually enter time on that type of page than on each individual card. But the dashboard should
update docket."*

Three separate wants, and only the first two are about the timer:

1. **Time that was not clocked.** The timer only records work done at the keyboard with the panel
   open. Work away from it — a call, a whiteboard, a drive — currently cannot be recorded at all.
2. **A log that can be read.** Today a row is one string from `formatSession()`
   (`Sun 14 Sep · 09:12–10:24 · 1h 12m`) in a flex row beside the note input, so a description has
   nowhere to wrap and the eye cannot scan the column of durations.
3. **One page across cards**, because per-card totals answer "how long did this take" and never
   "where did the month go".

## The reversal, recorded

`docs/specs/2026-08-21-board-design.md` ruled out due dates and estimates by name: *"a
two-participant board doesn't need them, and each one is another field competing for the card
face."* The dashboard needs both. **Owner's ruling, 2026-09-17: add them, panel only, never rendered
on the card face.** That honours what the original ruling was protecting — face clutter — while
letting the dashboard compute time left. A decision-log entry records the reversal and its reason.

## The fields

Two optional additions to the card, beside `time`:

```
estimateMinutes: <number> | null     — the budget for this card, in minutes
due:             <YYYY-MM-DD> | null — a date, not a timestamp: a day is the unit people mean
```

`due` is a plain date string rather than an ISO instant deliberately. A deadline is a day, and a
timestamp would render differently either side of midnight in another timezone for no gain.

Both normalise to `null` when absent, so **no board migrates**; the first write to each board adds
them once, exactly as `time` did. `CARD_KEYS` gains both. `validateCard` rejects a non-numeric
non-null `estimateMinutes`, a negative one, and a `due` that is not `null` or `YYYY-MM-DD`.

**Neither appears on the card face.** The face already carries tags, title, detail, a time chip and
a verdict; the ruling being reversed exists because that list is full.

## The pure logic

`board/ui/time.js` gains the mutation and the arithmetic, so the panel, the dashboard and the
snapshot cannot disagree — the reason that module exists:

- `addSession(card, { start, stop, note })` — validates and appends, then **keeps `sessions` sorted
  by `start`** so a backdated entry lands in the right place rather than at the end. Returns the
  session. Refuses when `stop` is not after `start`, when either is unparseable, and when the span
  exceeds 24 hours, which is a typo rather than a day's work.
- `remaining(card)` — `estimateMinutes` minus logged time, in ms; `null` when there is no estimate.
  Negative means over budget, and the caller decides how to say so.
- `formatSessionParts(session, opts)` — the same pieces `formatSession` assembles, returned
  separately (`{ day, clock, duration }`), so a layout can place them independently. `formatSession`
  stays, unchanged, and is now built from it: the snapshot and the `remove` confirm still want one
  string.

**`addSession` does not touch `running`.** A manual entry while a timer runs is legitimate — logging
this morning's call during this afternoon's session — and stopping the clock as a side effect of
typing would be a surprise.

## The panel

The Time section keeps its head (label, total, Start/Stop) and gains:

**A row that can be read.** Two lines instead of one: the day and clock (`Sun 14 Sep · 09:12–10:24`)
in the mono micro style on top, the description beneath it in sans, wrapping, and the duration
right-aligned on the row in mono tabular figures. The eye runs down the right edge for time and down
the left for what was done. `remove` moves to a hover affordance on the row, as notes already do.

**A total at the foot**, in the same right-hand column as the durations, so the column adds up
visually. The head keeps its own total: the foot one is the sum of what is on screen, and they agree.

**Add time**, a button beside Start. It opens a small form in the log: date, start, stop, description.
Defaults are today, an hour ago, now — so the common case is type a description and save. A bad span
is refused inline, naming what is wrong, and the form stays open with what was typed.

**Estimate and due** sit in the panel's field grid, not the Time section: a number input reading
`minutes`, and a date input. Empty means unset. When an estimate exists, the Time head reads
`2h 15m of 5h · 2h 45m left`, and over budget reads `5h 30m of 5h · 30m over` in the warn colour,
never the accent, which is spoken for three times already.

## The dashboard

A new route, `/dashboard?project=<slug>`, served by the daemon from `board/ui/dashboard.html` with
its own module — the first second page this daemon serves, and the reason the static branch already
handles any path under `ui/`.

It shows, for one board: total tracked, per-card time with bars, a fourteen-day column chart, the
session log newest first, and — when the project config carries a `rate` — a money column. Cards
with an estimate show progress and time left; cards with a `due` show days remaining and read as
late when the date has passed.

**It writes through the same door.** Adding time on the dashboard `PUT`s the whole board to
`/api/board` with the rev it read, exactly as the panel does. On a 409 it adopts the returned
document and re-applies, which is the client behaviour already in `sync.js`. There is no second
write path, no direct file access, and the daemon remains the only writer of record.

**Rate lives in the project's `.docket/config.json`**, not on a card: `{"rate": 175}`. A rate on a
card would imply per-card pricing, which is not how any of this is billed.

⚠️ **The dashboard is not an invoice.** Tracked time is what happened; an invoice is what was agreed.
On one client project the invoice bills a monthly allocation and is generated from Trello — the two numbers
will differ, and the page says so in the footer rather than leaving someone to discover it.

## Untouched, on purpose

`startTimer`, `stopTimer`, one-timer-per-board, offline read-only, the draft rule, `store.js` as the
only writer, the snapshot's no-script property, zero dependencies, no build step. The MCP tools keep
presenting time read-only: **Claude still never writes time.** The card face is untouched.

## Acceptance

1. `normalizeCard({})` yields `estimateMinutes: null` and `due: null`; supplied values survive;
   `validateCard` rejects a non-null non-number `estimateMinutes`, a negative one, and a `due` that
   is neither `null` nor `YYYY-MM-DD`.
2. `addSession` appends `{start, stop, note}` and returns it; sessions stay ordered by `start` when
   a backdated entry is added between two existing ones; it refuses `stop` equal to or before
   `start`, an unparseable date, and a span over 24 hours, in each case leaving `sessions` unchanged
   and `running` untouched — including while a timer runs on that card.
3. `remaining` returns `null` with no estimate, the positive remainder under budget, and a negative
   number over it. `formatSessionParts` in UTC returns `{ day: 'Sun 14 Sep', clock: '09:12–10:24',
   duration: '1h 12m' }` for the timer spec's instants, and `formatSession` still returns the single
   string it always did, built from those parts.
4. Live panel, throwaway board: **Add time** opens the form with today, an hour ago and now; saving
   with a description writes one session to the file and the row shows the description on its own
   line, wrapping at a narrow panel rather than truncating; the foot total equals the head total; a
   stop before its start is refused inline and writes nothing.
5. A card with `estimateMinutes: 300` and 2h 15m logged reads `2h 15m of 5h · 2h 45m left`; at 5h 30m
   it reads `30m over` in the warn colour. A card with no estimate reads as it does today.
6. `GET /dashboard?project=<slug>` returns the page; an unknown project 404s. It lists every card
   with time, and the totals equal the sum of the sessions in the file. Adding time there writes one
   session, and the card panel shows the same row after the board syncs.
7. The card face is byte-identical for a card carrying an estimate and a due date: no new element,
   no new class.
8. `cd board && npm test` and `cd mcp && npm test` green; `check-phone-geometry.mjs` green at 390
   and 320; the dashboard has no horizontal scroll at 390.

## Verify with

```
cd board && npm test && cd ../mcp && npm test
node board/scripts/check-phone-geometry.mjs && node board/scripts/check-phone-geometry.mjs 320
node board/scripts/probe.mjs http://localhost:7777/dashboard?project=<throwaway> \
  "return [document.querySelectorAll('.row').length, document.body.scrollWidth <= innerWidth]"
node board/scripts/shot.mjs "http://localhost:7777/dashboard?project=<throwaway>" /tmp/dashboard.png
```

Against a throwaway board on a spare port, never a real one: add a session by hand in the panel, add
another on the dashboard, then read the board file and confirm two sessions, ordered by `start`,
with `running` untouched.

## Must not break

`store.js` the only writer · rev-checked writes and the 409 adopt-and-retry · offline read-only ·
one running timer per board · the draft rule · the snapshot's no-script property and the geometry
gate at 390 and 320 · zero dependencies · no build step · Claude reads time through the MCP and
never writes it · the card face.

## Evolution paths — recorded, not built

1. **Time across every board on one page.** This dashboard is per project, which is the unit the
   owner thinks in. A portfolio view is a different page and a different question.
2. **Editing a session's start and stop** in the row, which `addSession` makes cheap to add.
3. **`docket time [--day]`** from the timer spec, still unbuilt, and now derivable from the same
   module.
4. **Effort beside cycle time** on the metrics card — the comparison it is waiting for.

## Resolved in the build, 2026-09-17 — the open question

The hand-off left one question for the owner: does **Add time** take date + start + stop, or a
duration? **Built: both, linked.** The form has date, start, stop and minutes; typing a start or a
stop recomputes the minutes, and typing minutes moves the stop. A person who knows "a 45-minute
call" and a person who knows "from 2 to 3" both type what they know, and the card still stores honest
instants, so every row means the same thing. The owner can veto; it is one field to remove.
