# Panel refinements: note delete, the row that squeezed, a Source row, and the Loop Contract as fields

**Date:** 2026-09-16 · **Status:** approved by the owner in conversation ("go"); built in three PRs the same day.

## Why, in the owner's words

*"The way the note is displayed on the card at the bottom … seems off. Text wraps … if Claude is going to
add metadata to the card it needs its own dedicated space AND that Claude knows about this space."*
*"Make a new Loop Contract section that comes with every card … open and closed … 6 dedicated sections
and the help tips can just be the placeholder text … an 'i' icon at each section."* *"The column, board
and tag section … the more tags I add, the column it lives in adjusts."* *"When I hover, we should be able
to delete the note."*

## 1. Delete a note

A **remove** control in each note's header, shown on hover (and always under the phone breakpoint — the house allows exactly one media query), confirm names
the author and age, then the note is spliced out through the sync layer like every other mutation. Any
author: the board is the owner's. The verdict pill and the unread dot read the thread, so they follow.

## 2. Column · Board · Priority, then Tags

The four controls shared one flex row in which every column could grow, so each chip widened Tags and
squeezed Column and Board. Now two rows: Column and Board at natural width with Priority at the row's
end; Tags alone beneath, full width, chips wrapping. Adding a tag changes nothing above it.

## 3. Source — the dedicated space, and Claude told about it

The metadata the owner saw wrapping is the `origin` field. A Trello import wrote
`trello · d3g87DtJ · This month · https://trello.com/c/d3g87DtJ` (62 characters, a URL) into a field
the face prints in its foot and the panel prints inside the Notes header. The field was always the
dedicated space; it was never presented as one, and nothing told Claude the convention.

- **Panel:** a **Source** row above Attachments — the full origin, links clickable, then *added by X*.
  The Notes header no longer carries it.
- **Face and snapshot face:** the whole foot is one line. Its spans used to shrink and wrap their own words — "just moved" became two lines beside a long origin or a long note count. Fixed spans never wrap; the last span (origin, or the note count) truncates with an ellipsis, the full text a hover away and in the panel.
- **Bridge:** `docket_add` gains `origin`, described as *a short provenance line: channel · id · date,
  and a link if there is one — e.g. `trello · d3g87DtJ · https://trello.com/c/d3g87DtJ`. Shown in the
  panel's Source row; never put it in a note.* `docket_board` already returns it.
- **Existing origins are untouched.**

## 4. The Loop Contract as fields

A collapsible **Loop Contract** section on every card, in the guide's place, replacing it. Six fields,
one per heading, placeholders from the hints, an **i** beside each that opens that heading's example
and, for the required two, the weak clause beside the strong one with the why.

**The fields are a form over the detail text.** `splitBrief(detail)` yields the prose before the first
heading and the six values; `joinBrief(prose, values)` writes them back, headings in canonical order,
empty headings omitted, a single-line value inline after the colon and a multi-line value on the lines
below. **Detail shows only the prose.** The parser, the verifier, the pre-flight `brief` report and
the snapshot read the same combined text as before — one source of truth, unchanged in shape.

- **Round-trip pinned:** `joinBrief(splitBrief(d))` equals `d` for any `d` `joinBrief` produced, and
  for any detail with headings in canonical order.
- **The skeleton stops being inserted** on landing in Loop; the section is the skeleton, on every
  card. `withBrief` is removed with its tests. Downstream needs none of the empty lines: a missing
  heading is missing either way.
- **Summary states where the contract stands:** *Loop Contract · empty*, *· needs Acceptance +
  Verify with*, or *· complete*.
- **Open rule:** open on arrival when the card is in Loop or any field has content; the owner's
  toggle stands while the card is open. Drafts included.
- A field being typed into is never repainted under the caret — the same guard the notes and time
  rows use.

## Acceptance

1. Hovering a note shows *remove*; confirming it removes exactly that note from the file; a verdict
   note's removal clears the face pill.
2. With zero, three and eight tags, the Column dropdown's width is identical.
3. A card whose origin is 62 characters with a URL: the face foot has no wrapped line; the panel's
   Source row shows the whole origin with the URL as a link and *added by owner*; the Notes header
   carries no origin. `docket_add({ origin })` stores it; the tool's description states the convention.
4. `splitBrief`/`joinBrief` round-trip the move-between-boards contract byte-for-byte after one
   normalisation; a detail with only prose yields six empty values and joins back to the prose; six
   empty values and empty prose join to `''`.
5. Live panel: a card with a contract shows Detail = prose only and six filled fields; typing into
   Acceptance rewrites the file's detail with the new heading content and nothing else changed;
   typing into Detail keeps the headings; the "i" on Acceptance shows the weak/strong pair; the
   summary reads *needs …* on a Loop card with an empty Verify with and *complete* once filled;
   a Loop draft opens the section on arrival; an Inbox card without a contract shows it collapsed.
6. Landing a card in Loop no longer writes the skeleton into its detail.
7. `cd board && npm test`, `cd mcp && npm test` green; geometry gate green at 390 and 320.

## Verify with

```
cd board && npm test && cd ../mcp && npm test
node board/scripts/check-phone-geometry.mjs 390 && node board/scripts/check-phone-geometry.mjs 320
node board/scripts/probe.mjs "http://127.0.0.1:7784/?project=alpha" "<the clauses above, on a throwaway board>"
```

## Must not break

`store.js` the only writer · the parser and the pre-flight `brief` report · the snapshot (its CSS gains
only the origin ellipsis) · the draft rule · offline read-only · zero deps · no build step.
