# Moving a card to another board

**Date:** 2026-09-11 · **Status:** approved by the owner 2026-09-11 ("go ahead and merge and move forward with the plan"); built the same day — plan in `docs/plans/2026-09-11-move-between-boards.md`.

## Why

A card sometimes lands on the wrong board: a capture routed by the wrong bucket, a thought
filed under the project it came from rather than the one it belongs to. Today the only fix
is to retype it. The owner asked for a control in the card panel, beside **Column**, labelled
**Board**, preselected to the board the card is on, listing every registered board; pick
another and the card goes there.

## What a move is

Each board is one JSON file in its own project repo, and nothing can span two repos in one
write. So a move is **a create on the target board, then a delete on the source board, in
that order** — the same rule the capture pipe lives by. A crash between the two leaves a
duplicate, never a lost card.

The card keeps its `id`, `title`, `detail`, `tags`, `flag`, `notes`, `origin`, `createdBy`,
`createdAt`, and `attachments`. Three things change:

1. **It lands in the target board's first column** (Inbox on every board today), whatever
   column it left — **the owner's ruling, 2026-09-11.** A card that changes project should
   be re-triaged where it arrives, not resume a position it earned somewhere else. Landing
   in Inbox also means a move can never place a card in another board's Loop, which keeps
   the authorization rule intact without a special case.
2. **Its column clock resets** (`columnSince` = now), because it is a move.
3. **It gains a note**, `moved from <Source name>`, authored `docket` — the tool, not the
   owner. The card's git history splits across two repos at that moment, and the note is
   the trail on the card itself. Authored by the tool, it stays out of what `docket news`
   treats as a message from the owner.

**Attachments travel.** Blobs are content-addressed, so copying one into the target's
`.docket/attachments/` yields the same filename and the card's `attachments` list needs no
rewriting. The copy left behind on the source is an orphan, which `docket doctor` counts and
`docket prune` removes — nothing new to build.

## Where the two writes run: the daemon

One route, `POST /api/move?project=<source>` with body `{ id, to }`, does both writes through
`store.js`, which stays the only writer. Not the browser, for three reasons: the
create-then-delete order lives in one place and a test can pin it; attachment blobs can only
be copied where they live, on disk; and the MCP bridge can reuse the route later if Claude
ever needs to correct a misrouted capture — **not in this change** (see *Out of scope*).

The logic is a module, `board/src/move.js`:

- `planMove(card, { targetColumnKeys, sourceName, now })` — pure. Returns the card as it
  will land: first target column, clock reset, the note appended. Testable without disk.
- `moveCard({ id, source, target, now })` — the two writes plus the attachment copy, over
  the real store in temp directories in tests. No mocks.

### Refusals and failures, all explicit

| Case | Response | Board state |
|---|---|---|
| `to` is the same board | 400 `same board` | untouched |
| unknown source or target project | 404 | untouched |
| card id not on the source board | 404 | untouched |
| a card with that id already on the target | 409 `id collision` | untouched |
| target write hits a rev conflict | 409 `target changed, try again` | untouched |
| source delete hits a rev conflict | retry the delete with a fresh read, bounded (3) | — |
| source delete still failing after retries | 200 with `duplicate: true` and a plain message | **card on both boards** — the safe failure, reported, never silent |

The last row is the invariant made visible: the UI shows the message and the card stays on
the source board too, for the owner to delete by hand.

## The control

In the card panel, a second dropdown beside Column, built with the same `createDropdown`,
labelled **Board** (not "Docket": Docket is the product and also one of the seven boards, and
a control labelled Docket that opens to show Docket as one option reads wrong). Options are
the registered projects the UI already loads for the header switcher; the value is the
board being viewed.

- **Changing it moves the card at once**, the way changing Column does. No confirm dialog:
  the move is reversible by the same control on the other board, and a dialog on every
  column change would be intolerable, so the two controls behave alike.
- On success the card is gone from this board, so the panel closes and the status line
  reads `moved to <Target name>`. The header switcher is right there to follow it; the card
  sits in that board's Inbox with a fresh "just moved" clock. (There is no card deep-link in
  the UI today — filters live in the hash, cards do not — and this change does not add one.)
- **A draft has no Board control.** A draft is not on any board; there is nothing to move.
- **Offline, the control is disabled.** Offline is read-only.
- The browser does not touch its local copy: the daemon already rewrote this board, and the
  stream frame carrying the new rev repaints it. It is never authoritative.

## Out of scope, on purpose

- **An MCP tool for moving.** The route makes it possible; the ruling that Claude must never
  land a card in Loop is already satisfied by the Inbox landing, but the tool is a separate
  decision and a separate card.
- **Undo.** The reverse move is one dropdown change on the other board.
- **A card deep-link.** Wanted independently of this; its own card if the owner wants it.
- **Bulk moves.** One card, one control.

## Acceptance

1. In the panel of a card on board A, a **Board** dropdown beside Column shows A selected and
   lists every registered board. Choosing B closes the panel; the status line says
   `moved to <B's name>`; the card is gone from A and present in B's **first column** with
   `columnSince` within seconds of now, its id, notes, tags, flag, origin and attachments
   intact, and a final note `moved from <A's name>` by author `docket`.
2. The attachment blob exists under B's `.docket/attachments/` after the move; `docket doctor`
   on A counts one orphan.
3. **Order is pinned:** a test makes the source write fail after the target write succeeds
   and asserts the card is on BOTH boards — a duplicate, never a loss — and the response says
   so.
4. `POST /api/move` refuses same-board, unknown project, unknown card, and id collision with
   the codes above, and the boards are byte-identical afterwards in every refused case.
5. A draft card's panel has no Board control; with the daemon stopped the control is disabled.
6. `cd board && npm test` passes; `mcp` and `bot` suites are untouched and still pass.

## Verify with

```
cd board && npm test
# live, docket board: open a throwaway card, pick another board in the Board dropdown, then
node board/bin/docket.js doctor          # orphan count on the source, card counts shifted by one
node board/scripts/probe.mjs "http://localhost:7777/?project=<target>" \
  "return [...document.querySelectorAll('.card')].map(c => c.querySelector('.card-title').textContent).slice(0,3)"
```

## Must not break

`store.js` the only writer · rev-checked temp-then-rename writes · the draft rule (nothing is
board state until committed) · offline read-only · the Loop authorization (no path lands a
card in Loop) · the snapshot (read-only, untouched) · zero dependencies · no build step.

## Pointers

`board/src/store.js` (`readBoard`, `writeBoard`) · `board/src/daemon.js` (`/api/board` PUT for
the route shape, `project(slug)` for resolution) · `board/src/attachments.js`
(`readAttachment`, `storeAttachment`) · `board/ui/app.js` line ~148 for how the Column
dropdown is built · `board/ui/modal.js` `elements.column` change handler for the sibling ·
`board/test/daemon.test.js` for the route-test harness · the bot's create-then-delete test for
the order-pinning pattern.
