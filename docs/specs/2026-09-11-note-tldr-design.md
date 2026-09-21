# Card notes: the first paragraph shows, the rest opens on demand

**Date:** 2026-09-11 · **Status:** approved by the owner ("Go"); design settled in conversation 2026-09-04.

## Why

The owner, 2026-09-04: *"I LOVE all your claude responses that get added to the card… But… it would
be nice to just get a short summary at the top and then a disclose or read more to see everything."*
Measured that day on the docket board: 93 notes by Claude, median 1,485 characters, longest 13,704;
77 of the 93 already have a blank-line paragraph break, and the first line runs about 120 characters
at the median. The summary paragraph is, in most notes, already there. This makes the board show it.

## The rule

**The first paragraph is the TL;DR, by convention.** No marker, no new field. One pure function,
`splitNote(text)` in `board/ui/note-lead.js`, returns `{ lead, rest }`: `lead` is everything before
the first blank line, `rest` everything after, both trimmed. No blank line means `rest` is `''` and
the note shows whole. **Both renderers import it** — the live panel (`board/ui/modal.js`) and the
snapshot (`board/src/snapshot.js`) — the way `brief.js` and `verdict.js` are shared today, so the two
cannot cut a note in different places.

Why convention over the alternatives, recorded in the decision log: a `TL;DR:` marker leaves every
unmarked note without a summary; a summary field is a schema change across the card model, the
store, the MCP tool and the snapshot, and every existing note lacks it. The convention works on 77
of 93 notes today and asks Claude for nothing it was not already mostly doing.

## The disclosure

For a note with a `rest`, both renderers emit the lead in `.note-text` as today, then a native
`<details class="note-more">` element, **closed by default**, whose `<summary>` reads **more** in
the mono micro style and **less** once open (two spans, one shown per state, CSS only), holding the
rest in a second `.note-text`, linkified like the lead. A one-paragraph note emits no `details`.
Opening one note opens no other. Native `details` is the whole reason this stays small: no state
code in the panel, it works in the snapshot which has no script tag by design, and it is keyboard
accessible for free.

**Any** multi-paragraph note collapses, whoever wrote it — one rule for the thread; the owner's
notes are short today so in practice Claude's collapse. The verifier's notes begin `VERDICT: meets`
followed by a blank line, so their lead is the verdict, which is exactly right.

## The convention

One sentence added to the loop protocol's *Every card gets a note* row in `CLAUDE.md`: **lead with
one sentence a phone can triage from, then a blank line, then the rest — the board shows only the
first paragraph until asked.**

## Untouched, on purpose

Note text itself (never rewritten — `news`, `tell` and `latestVerdict` read it whole); the card face
(it shows a count and the latest author, not note text); the snapshot's no-script property; a
thread-wide expand-all (one tap per note is the ask); any marker or field.

## Acceptance

1. `splitNote`: `'a'` → `{lead:'a', rest:''}`; `'a\n\nb\n\nc'` → `{lead:'a', rest:'b\n\nc'}`;
   leading or trailing whitespace and `\r\n` line endings do not change the cut; a blank line made
   of spaces counts as blank.
2. Snapshot: a two-paragraph note renders `<details class="note-more">` with the lead **outside** it
   and the rest **inside**; a one-paragraph note renders no `details`; `<b>` in the rest arrives as
   `&lt;b&gt;`.
3. Live panel, on a real card with a long note: each multi-paragraph note shows one closed
   `details.note-more`; toggling one makes its rest visible and leaves the others closed.
4. `CLAUDE.md` carries the sentence above.
5. `cd board && npm test` green; `check-phone-geometry.mjs` green at 390 and 320.

## Verify with

```
cd board && npm test
node board/scripts/check-phone-geometry.mjs 390 && node board/scripts/check-phone-geometry.mjs 320
node board/scripts/probe.mjs "http://localhost:7777/?project=docket" "<open a card with long notes; count details.note-more, all closed; open one; measure>"
```
