# The board at a URL

> **⚠ 2026-09-03: do not deploy this on a Hobby-plan Vercel account.** Followed exactly,
> these steps produce a **publicly readable** board there: Vercel Authentication cannot
> cover production on that plan (`deploymentType: all` is refused), Standard Protection
> leaves production aliases open, and the preview-only workaround (production branch parked
> on a dead branch) was falsified empirically — main pushes still built as production,
> publicly, four separate times. Full record: the decision log, 2026-09-03. The steps below
> are correct **only on a plan that accepts full Vercel Authentication.** The no-URL
> alternative is the snapshot travelling through the owner's own Telegram bot.

A read-only render of a board, deployed as a static page, for the case where you are in a
browser and the machine running the daemon is unreachable.

> **This publishes everything on the board.** Card text and every note, rendered verbatim,
> readable by anyone with the URL. Snapshot rendering deliberately does not pass through
> the redaction boundary that every CLI line passes through, because a board is content
> rather than a log line. Treat the resulting URL as exactly as sensitive as the board.

Everything about *why* is in `docs/decision-log.md` (2026-08-24). The short version: the
daemon binds `127.0.0.1` and Tailscale is refused by the managed Mac, so the board needed a
route that goes through git rather than through the network.

## One-time setup

This has to be done by the account owner in a browser — it needs a Vercel login, which no
agent session has. It is all clicks; there is no CLI step.

1. **Vercel → Add New → Project → Import** your fork of this repo.
   This creates a **second** project on the same repo. Do **not** reconfigure
   `docket-bot` — that one is live, its root is `bot/`, and the capture pipe depends on it.
2. **Root Directory:** `web`
3. **Include files outside of the Root Directory in the Build Step:** **ON.**
   This is the setting that will bite if missed. `build.mjs` reads the board you point it
   at and imports `../board/src/snapshot.js`; with the toggle off, Vercel uploads only
   `web/` and the build fails on a missing file.
4. Build command and output directory come from `web/vercel.json` — leave them alone.
5. **Settings → Deployment Protection → Vercel Authentication: ON** (Standard Protection,
   which covers production and previews).
   **Do this before the first deploy finishes.** Without it the URL is public, and the board
   carries private notes. This is the whole reason the repo is private.
6. **Environment variable: `DOCKET_WEB_BOARD`**, set to the path of the board you want
   published, relative to the repo root — for example `.docket/board.json` if you commit
   your board into this repo. The build **refuses to run** without it and prints why. That
   refusal is deliberate: an earlier version read a committed board with no flag at all, so
   the first deploy of a fork published whatever that board happened to say. No token is
   needed; Vercel checks the repo out itself.

   The build also prints what it is about to publish before it writes anything:

       publishing 41 cards and 96 notes from .docket/board.json (rev 233) — unredacted

   If that line names a board or a count you did not expect, stop the deploy.

Then the production URL is the board. Bookmark it, or add it to a home screen.

## What it does and does not do

- **It is as fresh as the repo, and no fresher.** Vercel rebuilds on push, so a push
  refreshes the URL. A card moved locally and not yet pushed is not there. The page's
  own header prints the board rev, when that board was last saved, the commit, and the
  render time, so you can always tell what you are looking at.
- **It is read-only, three times over.** The rendered document contains no script tag at
  all; `vercel.json` sends `default-src 'none'` plus an explicit `script-src 'none'`,
  `script-src-elem 'none'` and `script-src-attr 'none'`; and there is no API behind it to
  write to. `CLAUDE.md` forbids making the browser or the phone authoritative, and the
  cheapest way to honour that is to ship something with nothing to write with.

  All three script directives are stated outright even though `default-src` already covers
  them, because a gate on 2026-08-24 showed why: `script-src-elem` overrides `default-src`
  for `<script>` elements, and adding one loosened directive was invisible to the test then
  guarding the file. Loosening it now means editing a line that says `'none'`.
- **It is one board.** A Vercel project builds one repo, so publishing several boards means
  several projects, one each. Point `DOCKET_WEB_BOARD` at the board you mean.
- **It is not indexed.** `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer` are set
  as defence in depth. They are not the protection — step 5 is.

- **Anything you paste into a card is published to this URL, verbatim.** The snapshot
  deliberately bypasses the `redactSecrets` boundary that every CLI line passes through,
  because rewriting a rendered document would corrupt your own card text — the reasoning is
  in `board/bin/docket.js`. The consequence is this bullet. A credential pasted into a card
  reaches the page unchanged. The only thing standing between that and the open web is
  step 5, and the build printing what it is about to publish before it writes.

  **"Verbatim" is broader than your prose, and a gate had to point this out.** One real
  board rendered `/Users/<username>/…` sixteen times — including a full nvm node path and
  the absolute path of the board file — because cards and notes quote shell commands and
  filesystem paths. So the URL discloses your username and directory layout, not just what
  you meant to write. That is the renderer being faithful, which is what it is for; it
  is also a reason step 5 is not optional.

## ⚠ The one thing no test and no agent can check

Every automated claim on this page is about the **document** and the **headers**. The thing
that actually keeps a private board private is **step 5 — Vercel Authentication** — and it
is a dashboard toggle. No test suite can see it, and no agent session has Vercel access to
confirm it.

So it is stated here rather than left implied: **the deployment could pass every check in
this repo while being world-readable.** A gate on 2026-08-24 named this as the largest gap
in its own contract and correctly refused to rule on it. After the first deploy, open the
production URL in a private window and confirm you are asked to log in. That check is
yours, and nothing substitutes for it.

## Locally

```bash
node web/build.mjs && open web/public/index.html
```

`web/public/` is gitignored. Same reason `.docket/snapshot.html` is: it is a rendered view
of a JSON file committed beside it, so committing it would put the board's content in the
repo twice, with one copy going stale.

## A note on the build step

`CLAUDE.md` says **never add a build step**, and that rule is intact. The board itself is
still native ES modules with nothing between the owner and the code — delete this directory
and `board/` is unchanged. What is built here is a separate read-only artifact for a
separate deployment. If that ever stops being true, the rule has been broken, and
`web/build.mjs` is where it happened.
