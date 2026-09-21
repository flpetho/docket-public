# The contract guide — examples beside the Loop skeleton

**Date:** 2026-09-15 · **Status:** approved by the owner in conversation ("Proceed"); built the same day.

## Why

The owner: *"On the Loop column, we have the contract portion. Which I love… But I would like to have
examples. I get the Objective, but Acceptance, Verify with, Must not break, Pointers, If blocked… better
examples or fill in the blank type of things to help the user along."*

The gap is exact. `BRIEF_FIELDS` in `board/ui/brief.js` has carried a one-line `hint` per heading since
the skeleton was written, and a comment there says "the modal renders them instead". Nothing renders
them anywhere. The skeleton is hint-free on purpose — text after a heading's colon parses as that
heading's content, so an unfilled card would read as complete — and the other half of that decision
was never built. The owner sees six bare labels at 11pm.

## Rulings

1. **The guidance lives beside the Detail field, never inside the text.** A fill-in-the-blank
   skeleton would need the parser to learn to ignore placeholders, and a leftover placeholder would
   reach the verifier as content. The parser and the verifier keep seeing exactly what the owner wrote.
2. **One example per heading, in the house voice, from cards that passed the gate — plus, for the two
   required headings, a weak clause a stub could pass beside the strong one, with one line on why.**
   The verifier's recurring *Contract quality* finding is that clauses are stub-passable; the guide
   shows the trap, not just the shape.

## The content

Each entry of `BRIEF_FIELDS` gains `example` (string); `acceptance` and `verifyWith` also gain `weak`
and `why`. The hints stay. **Invariant, pinned by a test:** no example, weak clause or why may itself
contain a contract heading followed by a colon (`hasBriefHeadings` is false for each), so pasting one
into a detail can never manufacture a heading.

| Heading | Example (abridged here; full text in `brief.js`) |
|---|---|
| Objective | *A card that landed on the wrong board can be sent to the right one from its panel, and arrives in that board's Inbox with nothing lost on the way.* |
| Acceptance | weak: *the move works.* — strong: *choosing B in the panel closes it, the status line says "moved to B", the card is gone from A and sits in B's first column with notes, tags, flag and attachments intact; a test fails the source write after the target write and asserts the card is on BOTH boards.* — why: *a stub passes the weak one by printing "moved"; the strong one names what a skeptic sees on each board and how a failure must look.* |
| Verify with | weak: *run the tests* — strong: `cd board && npm test` and a probe command, verbatim — why: *an exact command re-runs the same way for the verifier; "run the tests" means whatever was convenient.* |
| Must not break | *store.js the only writer · offline read-only · the snapshot's no-script property · zero deps · no build step* — existing behaviour, phrased as outcomes. |
| Pointers | *docs/specs/…-design.md; board/src/store.js (readBoard, writeBoard); the bot's create-then-delete test for the order pattern* — a map, never a design. |
| If blocked | *Escalate to Waiting on you with the question stated plainly. Do not add an MCP tool, undo or bulk move — ruled out of scope.* |

## The guide

Under the Detail field in the card panel: a native `<details id="f-brief-guide" class="brief-guide">`,
**collapsed**, summary *How to write the contract* in the micro style. Built once from `BRIEF_FIELDS`
when the panel is created. **Shown when the open card is in Loop or its detail already uses the
headings — drafts included**, since a Loop draft is the moment a contract is being written. Hidden
otherwise. Each heading: the label (required ones marked as the snapshot marks them), the hint, the
example in a small preformatted block, and for the required two a row with the weak clause struck
through in the fail colour and the strong clause in the ok colour, then the why.

**Corrected the same day, from a screenshot the owner sent.** As first shipped the summary was
bare micro text, identical to every inert label in the panel (COLUMN, TAGS, NOTES), and a Loop draft
therefore showed six empty headings and a caption that did not read as a control. Two changes: the
summary carries the dropdown's own chevron (two rotated borders, turning on open), and **the guide
opens on arrival when the contract is blank** (`isBlankBrief`) — the moment the examples are wanted.
It is keyed on the card id, so once a card is open the owner's own toggle stands.

Nothing here is board state. The snapshot does not render the guide: a phone cannot write a contract.
`LOOP_BRIEF` is unchanged, so what lands in a detail is exactly what landed before.

## Untouched, on purpose

The skeleton text; `parseBrief`, `briefWarning`, the MCP `brief` report; the verifier. A per-heading
"insert this example" button (a paste is one keystroke and the examples are examples, not templates).

## Acceptance

1. Every `BRIEF_FIELDS` entry has a non-empty `hint` and `example`; `acceptance` and `verifyWith` have
   non-empty `weak` and `why`; `hasBriefHeadings` is false for every example, weak and why.
2. `LOOP_BRIEF` is byte-identical to before; `parseBrief(LOOP_BRIEF).complete` is false.
3. Live panel, throwaway board: a Loop card's panel shows `#f-brief-guide` visible and closed with six
   headings; opening it shows the two weak/strong rows; an Inbox card with plain prose shows no guide;
   an Inbox card whose detail uses the headings shows it; a Loop draft shows it.
4. `cd board && npm test` green; `check-phone-geometry.mjs` green at 390 and 320 (the snapshot is
   untouched, so this is a regression check only).

## Verify with

```
cd board && npm test
node board/scripts/probe.mjs "http://127.0.0.1:7781/?project=alpha" "<open a Loop card; read #f-brief-guide hidden/open, count .guide-field; open it; count .guide-pair>"
```

## Must not break

The skeleton and its parser · the pre-flight `brief` report · the snapshot · the draft rule · zero
deps · no build step.
