# The board's type scale: one notch larger, everything in proportion

**Date:** 2026-09-04 · **Status:** approved by the owner in conversation, building

## Why

At 100% browser zoom the board's type is on the small side for the amount of reading it
now carries — card detail, briefs, note threads. The owner previewed browser zoom 110% on
the live board and wanted exactly that, as the default: *everything* larger, in proportion.
Not a re-tuned scale; the design's proportions are right, the base is small.

## What changes

Every declared size in `board/ui/style.css` is already `rem`, and no root size is set, so
the scale hangs off the browser default of 16px. Three edits:

1. **`html { font-size: 112.5% }`** — 18px on a default browser. A percentage, not `18px`,
   so a user who raises their browser's default type gets the ratio, not a pin.
2. **`.column { flex: 0 0 16.5rem }`** — was `264px`. Renders at 297px. Without this the
   type would grow inside a fixed column and lines would shorten; zoom 110% widened the
   columns too, and that is what was approved.
3. **`#panel { width: 38.75rem }`** — was `620px`. Renders at 698px. `max-width` already
   viewport-based.

Two code comments naming 264px (`board/ui/phone.js`, `board/ui/render.js`) are corrected.

## What deliberately does not change

- **Hairlines stay `1px`.** A hairline is a hairline at any type size.
- **The phone breakpoint stays `640px`** in both the media query and `PHONE_MAX`. It
  describes the device, not the type.
- **The snapshot** (`board/src/snapshot.js`) carries its own CSS, already tuned a notch
  larger for a phone, and has the geometry gate. Untouched here. Following suit is one
  line plus a run of `check-phone-geometry.mjs`, a separate decision.
- **The visual language.** Geist, hairlines, square corners, mono micro-labels, one
  accent — nothing about the design moves except its base size.

## Acceptance

1. On the live board at 1600 wide, the computed root font size is `18px` and a
   `.column` measures 297px wide.
2. At 390 wide the phone layout still shows one full-width column (the breakpoint is
   unaffected).
3. `cd board && npm test` passes, with one new test that reads `style.css` and pins the
   root rule and the absence of `px` widths on `.column` and `#panel` — so a later edit
   cannot quietly undo this.
4. A screenshot at 1600 reads as the same board, one notch larger.

## Verify with

```
cd board && npm test
node board/scripts/probe.mjs --width 1600 http://localhost:7777/ "return [getComputedStyle(document.documentElement).fontSize, document.querySelector('.column').getBoundingClientRect().width]"
node board/scripts/probe.mjs --width 390 http://localhost:7777/ "return [innerWidth, document.querySelector('.column').getBoundingClientRect().width]"
node board/scripts/shot.mjs http://localhost:7777/ /tmp/board-18.png
```
