# Docket — a reusable local planning board

**2026-08-21.** Owner request: extract the atlas tracker kanban into a standalone tool that
drops into every new project "just like a CLAUDE.md file," with the owner and Claude as equal
partners on the same board. Named **Docket** — a list of matters awaiting decision, which is
measurably what the board is: 22 of atlas's 46 cards sit in *Waiting on you* or *In review*.

Owner decisions taken during the brainstorm: **standalone tool**, **state as a JSON file in each
project repo**, **desktop only** (Obsidian is the phone surface), **MCP server** as Claude's
interface, **one always-on daemon serving all projects**, **modal stays** (the owner likes the
current click-to-open-a-modal interaction), visual direction taken from
`~/Sites/projects/ferencpetho/gemini-directions/studies.html`.

## Why extract, and what was wrong with the predecessor

`docs/backlog.html` + `server/tracker/board.ts` worked: server-authoritative state held for a full
day of use with no heal-back, which was the failure it was built to fix (see the 2026-08-20 kanban
spec). What it could not do:

1. **The card face hides the content.** It shows title, one track tag, and a free-text `src` line.
   An owner-created card titled `http://localhost:50567/` carries 300 characters of substance in
   `detail`, invisible until clicked; Claude's verification evidence is behind a 9px ✎.
2. **`note` is one field with two authors.** Claude writes status into the same box the owner
   answers questions in. On the `journey-reroot` card Claude's report has consumed the field. A
   poll adopting a newer server doc mid-typing can also drop one of the two edits.
3. **`src` is three fields wearing one coat** — provenance ("chunk 13"), a date
   ("added 2026-08-20"), and a commit ("merged 52cec54") — none of it sortable or clickable.
4. **It does not scale past one screen.** No search, no filter, no per-column scroll (the page
   scrolls, so headers leave), no bound on Done. Inbox already spills below the fold at 12 cards.
5. **`track` is single-select.** Area, type (decision / bug / build), and state (blocked) all
   compete for one slot, with a single 🔥 as the only escape valve.
6. **🔥 force-sorts above unflagged**, silently overriding where the owner dragged a card.
7. **Nothing is portable.** 46 seed cards baked into the HTML, columns and tracks hardcoded, the
   API absolute to `:5174`, and the board dies with `pnpm dev` — dropping to a read-only cache.

## Architecture

```
~/Sites/projects/docket/           the tool, its own git repo
  bin/docket                       CLI: init · ui · install · doctor
  daemon/                          node:http on :7777 — UI, board API, SSE, fs.watch
  mcp/                             stdio MCP server
  ui/                              ES modules + bundled Geist woff2
  store/                           shared: read, rev-checked write, migrate
~/.docket/projects.json            registry — which projects exist (feeds the switcher)
~/.docket/config.json              port, default accent

<project>/.docket/board.json       state — committed, travels with the repo
<project>/.docket/config.json      columns, tag colors, accent, display name — committed
```

**Two processes, the file between them.** The MCP server is stdio, spawned per Claude session,
short-lived, and edits the board file directly. The daemon is long-lived, serves the UI, and
watches every registered board file. Neither depends on the other: Claude can triage a board with
nothing running, and the browser picks the change up the moment the daemon's watcher fires. The
rejected alternative — one daemon serving both the UI and MCP over streamable HTTP — is fewer
moving parts on paper but breaks Claude's board tools whenever the daemon is down.

**The board file is the single authority**, as it is today. Every write is revision-checked
(`rev` must match the stored rev; mismatch returns 409 with the current doc, which the client
adopts) and lands via write-temp-then-`rename` so a crash cannot truncate it.

**Stack: zero dependencies except `@modelcontextprotocol/sdk`.** The UI is native ES modules the
daemon serves directly — six or so focused files rather than today's single 500-line HTML, which
would pass 1500 lines with tags, filters, threads and search in it. The server is plain
`node:http` and `fs.watch`. React + Vite would make the interaction code easier but puts a bundler
between the owner and a tool that should still work untouched in three years. Requires Node 22+
(`node --test`, native fetch).

### `bin/docket`

| Command | Does |
|---|---|
| `docket init` | Writes `.docket/board.json` (empty) and `.docket/config.json` (defaults) in the cwd; appends the project to the registry. Idempotent — re-running never overwrites an existing board |
| `docket ui` | Opens `http://localhost:7777/?project=<slug>` for the cwd's project; starts the daemon if it isn't up |
| `docket install` | Writes `~/Library/LaunchAgents/com.docket.daemon.plist` (RunAtLoad, KeepAlive, logs to `~/.docket/logs/`) and bootstraps it, so the port is simply always there. One-time |
| `docket doctor` | Prints daemon status, port, registry contents, and any registered project whose board file is missing |

Port 7777 (verified free on this machine; 5173/5174/5432/5433/5434 are all taken by other
projects, so the check matters). Overridable in `~/.docket/config.json`.

**Slug and registry.** A project's slug is its directory name lowercased with non-alphanumerics
collapsed to `-`; a collision appends `-2`, `-3`. Registry entries are
`{ slug, path, name, addedAt }` — `path` is the project root, and the board file is always
`<path>/.docket/board.json`. `docket doctor` reports entries whose path or board file has gone.

### Daemon routes

| Route | Behavior |
|---|---|
| `GET /` | The board UI. `?project=<slug>` selects one; absent, the most recently updated |
| `GET /api/projects` | The registry, each entry with its display name and card counts |
| `GET /api/board?project=` | `{ rev, updatedAt, cards }`, or 404 if the project is unknown |
| `PUT /api/board?project=` | Body `{ rev, cards }`. Rev check → 409 with the current doc on mismatch, 400 on a malformed body or unknown column, else `{ ok, rev }` |
| `GET /api/events?project=` | SSE. Emits `{ type: 'board', rev, doc }` when the watcher sees a change |

**Watcher.** `fs.watch` on each registered board file, debounced 100ms, then re-read and compare
`rev`. Clients ignore events carrying a rev they already hold, which is what stops the daemon's
own writes from echoing. macOS `fs.watch` drops and duplicates events, so the client also keeps a
60-second safety poll and reconnects SSE on error — the SSE path is the fast path, not the only
path.

### MCP tools

Six, each doing a read-modify-write with a rev check and one retry on conflict. The project
resolves from `--project <path>`, else by walking up from cwd for `.docket/board.json` (Claude
Code spawns MCP servers with cwd set to the project), else the registry when a project is named.

| Tool | Signature |
|---|---|
| `docket_projects` | `()` → registry with card counts |
| `docket_board` | `({ project?, column?, tag? })` → matching cards |
| `docket_add` | `({ project?, title, detail?, tags?, column?, note? })` → id. `createdBy` and any `note` are authored `claude` |
| `docket_update` | `({ id, title?, detail?, tags?, column?, flag? })` |
| `docket_note` | `({ id, text })` → appends to the thread as author `claude` |
| `docket_delete` | `({ id })` |

Registered once globally, so a new project costs no MCP setup.

## The card

```jsonc
{
  "id": "chunk-12",
  "title": "Record-search shape",
  "detail": "Agent capability, a results-holding node, or both?",
  "tags": ["research-desk", "decision"],
  "column": "waiting",
  "flag": false,
  "notes": [{ "author": "claude", "at": "2026-08-20T18:02:00Z", "text": "Needs a brainstorm first." }],
  "origin": "chunk 12",
  "createdBy": "seed",
  "createdAt": "2026-08-20T00:00:00Z",
  "updatedAt": "2026-08-20T18:02:00Z"
}
```

Four changes from the predecessor, each fixing a numbered problem above:

- **`track` → `tags[]`** (fixes 5). Multi-tag, free-form, autocompleted from tags already in the
  project. `config.tags` names colors for known tags; unknown tags get a stable color hashed from
  the tag name. A tag filter row above the board is what makes 46 cards navigable (fixes 4).
- **`note` → `notes[]`, append-only and authored** (fixes 2). Both parties append; each author may
  edit or delete only their own most recent note. No shared mutable field, so no clobber.
- **`src` → `origin`, plus auto-linkified text** (fixes 3). URLs, repo-relative paths and 7–40
  character hex SHAs in any field render as links, so "merged 52cec54" and
  "docs/mockups/scanning-state/" stop being dead text.
- **`updatedAt` per card** (fixes 4's attention half). The browser keeps `lastSeen` per project in
  localStorage — the one legitimately local value, since it is a view preference rather than
  state — and any card carrying a note **by another author** newer than that wears an accent dot.
  Your own notes never mark a card unread. This is the answer to "what did Claude say while I was
  away."

**🔥 becomes decoration only** (fixes 6). Manual drag order wins; flags no longer re-sort.

### Project config

```jsonc
{
  "name": "Atlas",
  "accent": "#ff5227",
  "columns": [
    { "key": "inbox", "name": "Inbox" },
    { "key": "waiting", "name": "Waiting on you" },
    { "key": "next", "name": "Up next" },
    { "key": "progress", "name": "In progress" },
    { "key": "review", "name": "In review" },
    { "key": "done", "name": "Done" }
  ],
  "tags": { "demo-polish": "#baddc6", "decision": "#ff5227" }
}
```

Columns are validated against this config on every write, so a project can have three columns or
eight without touching the tool.

## Visual design

From `studies.html`, which maps onto a board almost directly: `.opt` is already a card (hairline
border, square corners, no fill, mono micro-label above the title) and `.verdict`'s accent left
rule is already a priority marker.

```
--bg #0b0b0c   --fg #f4f2ef   --muted #8d8a85   --accent #ff5227
--hair rgba(244,242,239,.085)
Geist (100–900) + Geist Mono, bundled woff2 (OFL) — copies, not a path into another project
```

Rules carried over: square corners, hairline borders, no shadows, no filled panels. Mono uppercase
at .60–.68rem with .13–.18em tracking for all metadata; sans 500 at -.02em for titles and -.035em
for the page heading. Accent reserved for priority, unread, drag-insertion, and focus — nothing
decorative.

**Card face**, top to bottom: mono tag row with 🔥 and the unread dot right-aligned; sans title;
muted detail clamped to two lines; mono footer reading `2 NOTES · CLAUDE 3D` and the origin.
Hover lifts the border from .085 to .18 alpha. Flagged cards take a 2px accent left rule.

**Board chrome.** Columns divided by vertical hairlines, no panel fill; column headers are mono
uppercase with a muted count, sticky, each column scrolling independently so headers never leave.
Above the board: project switcher, tag filter row (click to narrow, AND semantics, state in the
URL hash so a reload keeps it), `/` to focus search over titles/details/notes, and sync status as
a mono micro-label (`SYNCED · REV 228` / `SAVING…` / `OFFLINE — READ ONLY`). Done renders its five
most recent by `updatedAt` behind a "show all" — no archive file, it simply stops growing forever.
Drag insertion is a 1px accent line between cards, replacing the dashed outline around the column.

**Modal**, kept centered per the owner's preference: 620px, `#0f0f10`, 1px hair border, square
corners, sections divided by hairlines. Inputs lose their boxes for bottom-hairline fields, and
every textarea auto-grows by setting height from `scrollHeight` on input (a five-line handler,
rather than `field-sizing: content`, which is Chrome-only). The notes thread renders
`AUTHOR · 3D AGO` in mono above each note's sans text, with a composer at the bottom (`⌘↵` adds).
Tags are chips with an ×, plus an autocompleting input. Keyboard: `n` new card, `/` search, `esc`
close, `⌘↵` add note.

**Offline is read-only**, as today — no offline writes. That rule is what prevented the
localStorage heal-back loop and it carries over unchanged.

## atlas migration

atlas is the first consumer. Its 46 cards convert in one shot from
`data/tracker-board.json`:

- `track` → `tags[0]`; the seven track colors become `config.tags` entries.
- `note` → a one-entry `notes[]`. Notes opening with `Claude:` are authored `claude`, the rest
  `owner`. (5 of 46 cards have notes; all five are checked by hand after conversion.)
- `src` → `origin`. A date parsed out of it where present (`added 2026-08-20`) seeds `createdAt`,
  otherwise the doc's `updatedAt`; `updatedAt` starts equal to `createdAt`.
- Columns carry over unchanged, so no card moves.

**The old board stays live until the owner has used the new one and confirmed it.** Only then does
the removal land: `server/tracker/board.ts`, `server/tracker/board.test.ts`, `docs/backlog.html`,
`data/tracker-board.json`, the mount at `server/index.ts:495` and its import at line 37, the
`docs/backlog.html` row in CLAUDE.md's document index (replaced by a Docket row), and the
tracker-board mention in `docs/STATE.md`.

**Known cost of a committed board file:** the debounced write bumps `rev` on every edit burst, so
the file churns in git. Accepted — it is a planning file, and commits are deliberate rather than
per-keystroke.

## Verification

| Layer | How |
|---|---|
| Store | `node --test` against temp project dirs: rev-check accept and stale-rev reject, unknown column rejected, a write never leaves a partial file observable to a concurrent reader (temp path + rename), slug collision suffixing |
| Daemon | `node --test` over real HTTP on an ephemeral port: 409 carries the current doc, malformed body 400, unknown project 404, and an SSE client receives an event after an out-of-band file write |
| Migration | `node --test`: the real 46-card `tracker-board.json` as a fixture → asserted tags, note authorship, parsed dates, no card changing column |
| MCP tools | `node --test`: each of the six against a temp project; cwd-upward project resolution; conflict retry |
| UI | CDP script in docket's repo: add-card reaches the file, drag reaches the file, tag filter narrows the set, a note appends with the right author, **an external file edit reaches an open page over SSE**, offline shows the read-only banner, a textarea's height grows on input |
| Visual | Screenshot at 1600×1100 compared against `studies.html`'s language |

The CDP script carries over the two lessons `scripts/ui-check/cdp.mjs` records: no fixed sleeps
(poll for a condition), and no case-sensitive text assertions — both produced false failures
before.

## Build order

Four phases, each independently verifiable, so nothing depends on a piece that isn't proven:

1. **Store + daemon.** The repo, `store/`, the routes, the watcher, `bin/docket init|doctor`.
   Verified by the store and daemon test suites — no UI yet.
2. **UI.** The board, the modal, tags and filtering, auto-grow, SSE consumption, the visual pass.
   Verified by the CDP script and a screenshot. At the end of this phase the tool is usable.
3. **MCP + install.** The six tools, `docket install`, and `docket ui`. Verified by the MCP suite
   and by Claude actually driving a temp board end to end.
4. **atlas migration and cutover.** Convert the 46 cards, run both boards in parallel, get the
   owner's confirmation, then remove the predecessor. Only this phase touches atlas.

Docket's repo gets its own `CLAUDE.md` and a copy of this spec at
`docs/specs/2026-08-21-board-design.md`, since it becomes a project in its own right.

## Out of scope

Deliberately excluded, and why:

- **Phone / responsive view** — owner ruling: Obsidian is the phone surface; Claude triages those
  notes onto the board at the desk.
- **Due dates, assignees, estimates, swimlanes, WIP limits** — a two-participant board doesn't
  need them, and each one is another field competing for the card face.
- **Multi-machine or cloud sync** — the board travels in the git repo, which is the sync.
- **Auth** — localhost, single operator.
- **Vim-style card navigation** — `n`, `/`, `esc`, `⌘↵` cover the real traffic.
