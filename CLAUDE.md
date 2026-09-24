# CLAUDE.md

Guidance for Claude Code working **on Docket itself**. If you are working on a project that
*uses* Docket, you want [`docs/ADOPTING.md`](docs/ADOPTING.md) instead — that is the protocol
file, written to be copied into a consuming project.

## Project

**Docket** is a planning system for one person and one AI working from the same board. Three
parts, all built:

- **The capture pipe** (`bot/`): a Telegram bot. A thought typed on a phone becomes one
  committed file in a private inbox repo, routed to a bucket by a single tap.
- **The board** (`board/`): a local kanban that drops into any project the way a `CLAUDE.md`
  does — state as a JSON file in that project's repo, one daemon serving every project,
  server-sent events so a file edit shows up in an open browser, installable as a PWA.
- **The bridge** (`mcp/`): seven MCP tools registered once at user scope, so an agent reads and
  writes the same board the owner does, in every project.

**The organizing idea: the board is shared state, not a report.** The owner adds, moves and
annotates; the agent reads the same document, does the work, and writes back what it
verified.

**The asymmetry that keeps it safe:** the cloud half is append-only and authoritative for
nothing. Captures are a mailbox. Boards live in git, in the project they describe. If the
cloud vanished, the loss would be unfiled notes, never a board.

## Installing and adopting

[`INSTALL.md`](INSTALL.md) is the procedure. Don't reinvent it in conversation — if a step is
wrong or missing, fix the file.

## Commands

```bash
# Test suites. Zero dependencies, no network call in any of them. --test-timeout matters:
# a stream test that hangs should fail in 20s, not block a session.
cd bot && npm test      # 55 tests
cd board && npm test    # 444 tests
cd mcp && npm test      # 34 tests. THE ONLY package with a dependency, so it is also the
                        # only suite that needs `npm install` first. Without it you get
                        # ERR_MODULE_NOT_FOUND on protocol.test.js — expected in a fresh
                        # clone, not a regression.
cd web && npm test      # 7 tests — pins the deployment's security headers

# Serve every registered board. http://localhost:7777, loopback only.
node board/bin/docket.js serve

# Adopt a project, optionally migrating a board from the older tracker format.
node board/bin/docket.js init --name "My Project" --from-tracker <path>/tracker-board.json
node board/bin/docket.js doctor [--port <port>]
node board/bin/docket.js prune    # remove attachment blobs no card references

# The board as ONE read-only HTML file, for a phone that cannot reach the daemon.
node board/bin/docket.js snapshot --out /tmp/board.html

# Look at the running board. Do NOT use --virtual-time-budget: the page holds an open
# EventSource, so the virtual clock never settles and Chrome hangs forever.
node board/scripts/shot.mjs http://localhost:7777/ /tmp/board.png
node board/scripts/probe.mjs http://localhost:7777/ "return document.querySelectorAll('.card').length"

# Both scripts assume a macOS Chrome. Point them elsewhere with DOCKET_CHROME, and use
# DOCKET_CHROME_FLAGS=--no-sandbox only in a container — it is a real reduction in isolation.
export DOCKET_CHROME=/opt/pw-browsers/chromium DOCKET_CHROME_FLAGS=--no-sandbox

# Does the snapshot still fit a phone when a card holds a word that doesn't? Renders seven
# cards built to break it, so the answer never depends on what a board happens to say today.
node board/scripts/check-phone-geometry.mjs        # 390px
node board/scripts/check-phone-geometry.mjs 320    # the narrowest phone in use

# Responsive geometry needs two widths or it proves nothing: at 1600 `--pad` is clamped to
# its maximum, so a hardcoded gutter measures identically. 640 is the phone breakpoint
# (PHONE_MAX in board/ui/phone.js).
node board/scripts/probe.mjs --width 390 http://localhost:7777/ "return innerWidth"

# The bot needs its own environment. A non-interactive shell does not read your profile.
export TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
node bot/scripts/tell.js "chunk 12 merged, ready for review"

# Register the webhook. Only after a deploy, and only when the URL changes.
node bot/scripts/set-webhook.js https://<deployment>.vercel.app/api/telegram

# Read the inbox directly.
gh api repos/<you>/docket-inbox/contents/captures/unfiled --jq '.[].name'
```

**Vercel root directories:** `bot/` for the capture function, `web/` for the read-only board
mirror. They are two separate projects on one repo. The bot's Deployment Protection must be
**off** so Telegram can post to it; the board mirror's must be **on**.

## Architecture

Node 22, ESM, **zero runtime dependencies** — global `fetch` and `Buffer`, `node:test` for
tests. The single exception is `mcp/`, which needs `@modelcontextprotocol/sdk` and `zod`; it
has its own `package.json` so `bot/` and `board/` still clone and run with no install. No
bundler anywhere: a tool meant to still work untouched in three years should not have a build
step between the owner and it.

| Module | Purpose |
|---|---|
| `bot/api/telegram.js` | The Vercel entry. Secret check, dependency construction, the status contract. Thin by design |
| `bot/src/handler.js` | Pure dispatcher — capture, bucket tap, commands. Every I/O client injected, so all behavior is testable with fakes |
| `bot/src/inbox.js` | The inbox repo over the GitHub Contents API. The only module that talks to GitHub |
| `bot/src/telegram.js` | The three Bot API methods this uses. The only module that talks to Telegram |
| `bot/src/capture.js` | Filenames, frontmatter, parsing. No I/O at all |
| `bot/src/config.js` | Environment validation. Names what's missing, never echoes a value |
| `board/src/store.js` | The board file. The **only** module that writes it — rev-checked, temp-then-rename |
| `board/src/migrate.js` | Tracker board ↔ Docket board. The reverse direction exists so losslessness is testable, not asserted |
| `board/src/daemon.js` | node:http — board routes, config, attachments, the static UI, and the stream watcher |
| `board/src/snapshot.js` | The board as one self-contained read-only HTML file. No script tag, so it cannot write |
| `board/src/attachments.js` | Content-addressed files on disk. The only module that reads or writes them |
| `board/src/move.js` | A card to another board: create on the target, then delete on the source. Duplicate on failure, never loss |
| `board/src/card.js` | Card shape: normalize, validate. Knows nothing about storage |
| `board/src/registry.js` | Which projects exist, and finding a project root by walking up |
| `board/src/service.js` | The launchd agents. macOS only, and the only macOS-specific code in the repo |
| `board/ui/` | Native ES modules, no build step. `tag-color.js` and `brief.js` are imported by the server too, so the two halves cannot disagree |
| `board/ui/panel.js` | The card panel: its markup, its 34-key element map, and the mount that wires both into `modal.js`. ONE copy, mounted by the board and by the dashboard |
| `board/ui/time.js` | Time worked, pure and shared by the panel, the face, the snapshot and the MCP: totals, labels, one timer per board |
| `board/ui/dashboard-math.js` | The time dashboard's arithmetic — per-card shares, daily totals, due status, money — pure, so the page and any later command agree |
| `board/ui/dashboard.js` | `/dashboard?project=`: one board's time as a page. Writes through `sync.js`, the same door as the panel; never a second write path |
| `web/build.mjs` | The same snapshot, rendered at deploy time for a static site. A *separate artifact* — `board/` still has no build step. Refuses to run without being told which board |
| `mcp/src/tools.js` | The seven tools as pure functions over the store. No SDK, no zod — testable alone, and an SDK churn cannot reach it |
| `mcp/server.js` | The only file that knows the MCP protocol exists |
| `.claude/agents/docket-verifier.md` | The gate. Fresh context, no edit tools, rules meets/fails on a Loop card |

The single-bridge rule: `inbox.js` is the only place that reaches GitHub and `telegram.js` the
only place that reaches Telegram. Scattered API calls mean scattered error handling.

### Invariants the tests enforce

- **The capture file is written before the reply is sent.** A note must never be lost waiting
  for a bucket tap.
- **A retried webhook is idempotent.** The filename carries the Telegram `update_id`, and
  `putFile` reads the existing SHA before writing — without that, GitHub 409s and Telegram
  retries forever.
- **Moves are create-then-delete**, in that order, so a crash mid-move duplicates rather than
  loses.
- **`callback_data` stays under 64 bytes** (Telegram's hard cap): buttons carry
  `<update_id>:<bucketIndex>`, never a path.
- **The callback is answered before any work happens**, inside Telegram's 10-second window,
  or the button spins on the phone while GitHub is being written.
- **Status contract:** 200 on every handled case *including refusals* so Telegram stops
  retrying; 401 on a bad secret; 405 on a non-POST; 500 only on genuine failure, where
  Telegram's retry is the recovery path.
- **The push timer ships the default branch only**, whatever it is named, and only when the
  board is the only thing ahead.

## The loop protocol

The rules an unattended run follows live in [`docs/ADOPTING.md`](docs/ADOPTING.md), because
they belong to a *consuming* project rather than to this repo. They apply here too — this
repo has its own board — so read that file before working a Loop card in it.

The short version, and the parts that are absolute:

- **The owner putting a card into Loop is the authorization.** Never move a card into Loop
  yourself.
- **Read the whole column and triage before starting.** An incomplete brief goes to *Waiting
  on you* rather than getting a confident guess.
- **Never grade your own work.** The `docket-verifier` subagent rules meets or fails.
- **The owner merges. Always.**

## Don't

- **Never log or echo a secret.** Not in an error message, not in a thrown string, not in a
  console line. Telegram errors name the *method*, never the URL — the URL embeds the token.
- **Never log capture text.** A note body is private content; logs carry ids and paths only.
- **Never let the inbox repo hold code, or this repo hold captures.** If the inbox held its
  own source, every capture would trigger a redeploy.
- **Never remove the chat-id whitelist.** A bot's username is public and guessable. Without
  the check, a stranger writes into someone's inbox.
- **Never make the browser or the phone authoritative.** The board file in a project repo is
  the single copy. Its predecessor let `localStorage` be authoritative and stale copies kept
  healing junk back into the shared file — see the decision log.
- **Never add a build step.** Zero dependencies and native ES modules are load-bearing.
- **Never accept an offline write.** Offline is read-only. That rule is what stopped the
  heal-back loop and it carries into the board.
- **Never commit a board into this repo.** `.docket/` is gitignored here on purpose: this is
  the tool, not somebody's planning. A board belongs in the project it describes.

## Document index

Add a row when you add a document — a resource nobody can find is a resource that doesn't
exist.

| Document | Read it when |
|---|---|
| `README.md` | Somebody asks how this works, or wants to copy it. Architecture, the loop, the load-bearing rules, and the traps |
| `INSTALL.md` | **Setting it up.** Both halves, the macOS caveat, and the things that bite |
| `docs/ADOPTING.md` | **Working in a project that uses Docket.** The protocol, written to be copied in |
| `docs/decision-log.md` | "Why was X decided this way?" Append-only, newest at the bottom |
| `docs/specs/2026-08-21-capture-pipe-design.md` | The bot's design, and why a repo rather than a database |
| `docs/specs/2026-08-21-board-design.md` | The board's design — daemon, MCP, card model, visual language |
| `docs/specs/2026-09-04-type-scale-design.md` | Why the board renders at an 18px root and rem column widths |
| `docs/specs/2026-09-11-move-between-boards-design.md` | Moving a card between boards: create-then-delete, and what is refused |
| `docs/specs/2026-09-11-note-tldr-design.md` | Why a note's first paragraph is its summary |
| `docs/specs/2026-09-14-card-timer-design.md` | The timer on a card: the `time` field, one timer per board |
| `docs/specs/2026-09-15-brief-guide-design.md` | The contract guide beside the Detail field, and the weak-versus-strong pairs |
| `docs/specs/2026-09-16-panel-refinements-design.md` | Note delete, the Source row, and the Loop Contract as six fields |
| `docs/specs/2026-09-16-ui-live-reload-design.md` | Why the tab reloads itself on a new UI version, and why never while a card is open |
| `docs/specs/2026-09-17-manual-time-and-dashboard-design.md` | Manual time entry, estimate and due, the time dashboard, and why tracked time is not an invoice |
| `bot/README.md` | Module map, environment variables, the status contract |
| `board/ui/icons/src/README.md` | How the `d.` mark is generated, and two centring traps |
| `web/README.md` | Putting a board at a URL, and what that publishes |
| `docs/reviews/2026-08-21-night-shift-review.md` | What was taken from Phil McDonald's talk, what was adapted, what was refused |

## Attachments and the living-persons line

Cards carry pasted screenshots at `.docket/attachments/`, and the point of them is that the
agent can see what the owner sees. That collides with a rule worth taking seriously: **reading
an attachment is a model prompt**, and a screenshot of someone's family tree, medical record
or private correspondence shows real people who did not consent to it.

Not a prohibition — it is the operator's own machine and their decision to paste the image.
But it is a decision, so: **do not reflexively read every attachment on every card.** Read one
when the card's work actually needs it, and say that you are doing so.
