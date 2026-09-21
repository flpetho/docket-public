# A timer on the card

**Date:** 2026-09-14 · **Status:** approved by the owner in conversation ("Yes. Cook."); built the same day.

## Why

The owner: *"a timer to the card… Start/Stop… catalog the day, date and time spent and then a place
to add a description if I wanted to include what was done."* The board already records when a card
entered a column; it has no idea how long anyone actually worked on it. That number is the one the
metrics card (`card-mt3zwcbb-umwm`) cannot derive from git history, and effort next to elapsed time
is the comparison that card is waiting for.

## The field

Every card gains `time`:

```
time: {
  running:  <ISO start> | null          — a timer is running on this card
  sessions: [{ start, stop, note }]     — ISO, ISO, string (may be '')
}
```

Totals are **computed, never stored** — from the sessions plus the running span. The normalizer
fills a missing `time` as empty, so no board needs a migration; the first write to each board adds
the empty field to every card, once. The validator checks the shapes. `CARD_KEYS` gains `time`.
This is the first schema addition since attachments and it touches the same four places: the card
model, the panel, the snapshot, and the MCP presentation.

The pure logic lives in **`board/ui/time.js`**, imported by the panel, the card face, the snapshot
and the MCP tools — the shared-module pattern of `brief.js`, `verdict.js`, `note-lead.js`:

- `totalMs(time, nowMs)` — sessions plus the running span.
- `formatDuration(ms, { seconds })` — `<1m`, `12m`, `1h 12m`; with seconds, `12m 34s`, for the live tick.
- `formatSession(session, { timeZone, locale })` — `Sun 14 Sep · 09:12–10:24 · 1h 12m`.
- `startTimer(cards, id, nowIso)` — **one timer per board, the owner's ruling:** any other card
  running on this board is stopped and its session logged in the same write; returns the ids stopped.
  Starting a card already running is a no-op.
- `stopTimer(card, nowIso)` — closes the session, appends it, clears `running`; returns it.
- `setSessionNote(card, index, text)`, `deleteSession(card, index)`.

The three mutators work in place on the cards the sync layer hands them, which is how every
mutation on this board is written; the tests hand them fresh arrays.

## The panel

A **Time** section above Attachments: a head with the label, the card's total, and one button —
**Start**, or **Stop · 12m 34s** ticking once a second while the panel is open and the card is
running. Below it the sessions, newest first, each a row: the formatted session, a text field for
the description (placeholder *what was done*, saved on change, editable forever), and *remove*
behind a confirm, because a forgotten timer is a real case and a nine-hour accidental session
should not be permanent. **Stop focuses the new row's description field** so the words can follow
the button press without a second click; leaving it empty is fine.

A draft has no Time section (nothing to time). Offline, the button is disabled — Start and Stop are
both writes. The section is hidden when the card has no sessions and nothing running? **No** — it
always shows, because the Start button is how a timer begins.

## The face

In the card foot, a mono chip: the total (`2h 15m`) when there is one, and **running** in the accent
colour while a timer runs — no live minutes on the face, the panel has those. The chip is how the
board shows which one card is clocked in.

## The snapshot

Read-only, as with notes: the same chip on the face, and a Time block in the card body listing the
sessions with their descriptions and the total. Times render in the Mac's timezone, which is where
the snapshot is made.

## The bridge

`docket_board` presents `time: { running, total, sessions }` on every card. **Read-only:** no MCP
tool starts, stops or edits a timer. The log is the owner's record of the owner's hours; Claude may
read it (the metrics conversation needs it) and never writes it. `docket_update` now preserves the
field through its normalize-and-write path, which it must, or an update would erase the log.

## Untouched, on purpose

Editing a session's times (delete and redo). A cross-board "one timer anywhere" rule. Any rollup.
Note text and the note thread (a session is not a note). `columnSince`, which measures a different
thing.

## Evolution paths — recorded at the owner's request, not built

1. **`docket time [--day YYYY-MM-DD]`** — a day's sessions across every card on a board, with the
   day's total; the per-day catalogue the owner described, as a command rather than a view.
2. **One timer across all boards** — Start on any board stops a timer on any other; needs a
   cross-board write, which `move.js` now shows the shape of.
3. **Editing a session's start and stop** in the row.
4. **Effort next to cycle time on the metrics card** — the comparison that card exists to make.
5. **A board view of days and totals** — the metrics card argues the board should not look at
   itself; recorded as the option not taken.

## Acceptance

1. `normalizeCard({})` yields `time: { running: null, sessions: [] }`; a supplied `time` survives;
   `validateCard` rejects a non-null non-string `running`, a non-array `sessions`, and a session
   missing string `start`/`stop`/`note`.
2. `startTimer` on card B while A runs: A gains a session `{start: A's running, stop: now, note: ''}`
   and `running: null`; B's `running` is `now`; returns `['A']`. `stopTimer` appends and clears.
   `totalMs` sums sessions and the running span. `formatDuration(0)` is `<1m`; `formatDuration(72*60e3)`
   is `1h 12m`; with seconds `754e3` is `12m 34s`. `formatSession` in UTC renders
   `Sun 14 Sep · 09:12–10:24 · 1h 12m` for those instants.
3. Live panel, throwaway board: Start on card 1 → its head reads `Stop · …` and ticks; the face
   chip reads `running`; Start on card 2 → card 1's face shows a total and its file has one
   session, card 2 is running; Stop on card 2 → a row appears with the description field focused;
   typing and blurring saves the text into the file; *remove* deletes the row after confirm.
4. A draft's panel has no Time section; offline the button is disabled.
5. Snapshot: a card with two sessions renders both rows, escaped, and the total; a running card
   renders `running` on the face.
6. `docket_board` shows `time` with the total; `docket_update` on a card with sessions leaves them
   intact.
7. `cd board && npm test`, `cd mcp && npm test` green; `check-phone-geometry.mjs` green at 390 and 320.

## Verify with

```
cd board && npm test && cd ../mcp && npm test
node board/scripts/check-phone-geometry.mjs 390 && node board/scripts/check-phone-geometry.mjs 320
node board/scripts/probe.mjs "http://127.0.0.1:7780/?project=alpha" "<start, start another, stop, type, remove — read #f-time-log and the board file>"
```

## Must not break

`store.js` the only writer · the draft rule · offline read-only · the note thread untouched · the
snapshot's no-script property · zero deps · no build step · the tracker round-trip in `migrate.js`.
