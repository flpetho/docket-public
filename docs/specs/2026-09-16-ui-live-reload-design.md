# The board reloads itself when its code changes — but only when nothing is at risk

**Date:** 2026-09-16 · **Status:** approved by the owner ("Do it. I like it."); built the same day.

## Why

Board *data* has always been live: the daemon watches each board file and pushes the new revision down
the event stream every open tab holds, within ~100ms. Board *code* is not: a merge that changes
`modal.js` or `style.css` reaches a tab only when the owner reloads it, and twice this week they looked
at an old tab and asked whether a shipped change was live. The daemon already serves the UI with
`no-cache`, so a reload always fetches the new files; the only missing piece is the tab knowing that a
new version exists.

## The design

**A version stamp.** `board/src/version.js` computes a 12-hex SHA-256 over the names and bytes of the
files the browser loads from `board/ui/` (top level: `.html`, `.js`, `.css`, `.webmanifest`). Content,
not mtime, so a touch that changes nothing reloads nothing. Pure over `[{ name, bytes }]`, with a small
reader for a directory.

**The daemon knows it and says it.** `createDaemon` gains an injectable `uiDir` (default `board/ui`).
It computes the version at startup, serves `GET /api/version → { version }`, writes
`data: {"type":"ui","version"}` as the first frame of every event stream, watches `uiDir` (debounced,
like the board watcher) and, when the stamp changes, broadcasts the same frame to every client of
every stream. The watcher closes with the daemon.

**The tab decides.** At boot the client fetches `/api/version` and remembers it. `sync.js` hands
every `ui` frame to `onUiVersion(version)` — before the "a local edit is about to push" guard, because
a version frame is not a board frame and must never be dropped. In `app.js`, a different version means
**reload — when safe**: the card panel is closed. If a card is open (a draft, a half-typed note, a
field mid-edit), the status line reads *new version · reloading when you close this card*, and a
MutationObserver on the overlay's `hidden` attribute performs the reload the moment it closes. When
the panel is already closed the status flashes *new version · reloading* for 400ms first, so the
reload is never a mystery.

**A daemon restart is covered too.** The browser reconnects the stream on its own; the first frame
after reconnect carries the version. Same code, same stamp → nothing happens. New code → reload.

## Untouched, on purpose

Hot module replacement (no bundler, by design, and the panel holds live state). Any templating of
`index.html` at serve time (the version travels on the stream and `/api/version`, so no file is
rewritten on the way out). The board-data path.

## Acceptance

1. `versionOf` is deterministic, order-independent, 12 hex, and changes when any byte of any file
   changes.
2. `GET /api/version` equals the `ui` frame that opens `/api/events`; changing a byte in a file under
   the injected `uiDir` broadcasts a new `ui` frame with a different version to an open stream within
   two seconds; the daemon closes cleanly with the watcher.
3. Live, throwaway daemon: with no card open, appending a comment to `style.css` under its `uiDir`
   reloads the tab (a marker set on `window` before the change is gone after); with a card open, the
   status line says *new version · reloading when you close this card*, the marker survives, and
   closing the card reloads.
4. `cd board && npm test` green; `check-phone-geometry.mjs` green at 390 and 320 (regression only).

## Verify with

```
cd board && npm test
node board/scripts/probe.mjs "http://127.0.0.1:7785/?project=alpha" "<set window.__probe; append to the served style.css; wait; is __probe gone?>"
```

## Must not break

The board-data stream and its rev guard · `store.js` the only writer · offline read-only · zero deps ·
no build step · the one-media-query rule.
