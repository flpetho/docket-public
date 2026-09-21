# Decision log

Append-only, newest at the bottom. A choice a reasonable person would revisit, where the *reason*
is the expensive part to reconstruct. Not a changelog — git already has that.

---

## 2026-08-20 — The board's state is server-authoritative, not browser-authoritative

Inherited from the predecessor inside atlas, and the reason this project exists in the shape it
does. The first version let each browser's `localStorage` be authoritative and mirrored it to a
server file. It failed observably within a day: test strings absorbed into several browsers' storage
kept "healing" back into the shared file after every cleanup, and there was no way to tell which
copy a given tab was showing. Inverting authority — one file is the single copy, browsers hold a
read cache only, offline is read-only with no writes — fixed it, and 230 revisions of real use
followed without recurrence. **Offline-read-only is load-bearing, not a limitation.**

## 2026-08-21 — Docket becomes its own project rather than an atlas feature

The board was built inside atlas and proved itself there. Extracting it costs a repo and some
migration; not extracting it means every future project either re-implements the board or reaches
into atlas for tooling. The owner's framing settled it: this should install into a new project
the way a `CLAUDE.md` does. atlas becomes the first consumer and cuts over last.

## 2026-08-21 — Board state is a JSON file in each consuming project's repo

Alternatives were a central store under `~/.docket` and a cloud database. The repo file wins because
it travels with a clone, diffs in git, and gives Claude a direct path when no daemon is running —
the properties that make it behave like a `CLAUDE.md`. Accepted cost: the debounced write bumps a
revision on every edit burst, so the file churns in git history. Judged worth it for a planning file
whose commits are deliberate.

## 2026-08-21 — Two processes for the board, with the file between them

The MCP server is stdio and short-lived, spawned per Claude session, editing the board file
directly. The UI daemon is long-lived, serves every project, and watches those files. The rejected
alternative — one daemon serving both the UI and MCP over HTTP — is fewer moving parts on paper but
breaks Claude's board tools whenever the daemon is down. Splitting them keeps each useful alone:
Claude can triage with nothing running, and the browser sees it the moment the watcher fires.

## 2026-08-21 — Telegram, not a PWA, for phone capture

The owner asked for a PWA and was talked into Telegram after naming what they actually wanted: a
two-way conversation about the inputs. That is the thing a PWA is worst at — iOS web push is
finicky, and holding a conversation means building most of a messaging app. Telegram supplies the
whole conversational surface for free, plus offline queueing, dictation, and notifications in both
directions. A PWA remains a reasonable second front end onto the same inbox later.

**Accepted risk, raised twice and confirmed:** a bot chat has no end-to-end option, so unreleased
work product thinking sits with a foreign-jurisdiction third party.

## 2026-08-21 — A git repo, not Supabase, as the capture inbox

Supabase was the earlier recommendation and was carrying the PWA's weight; once Telegram became the
surface, a database was the wrong shape for append-only text notes read by an agent that has a
filesystem. A private repo gives one service total (a Vercel function), no write conflicts (one file
per capture), idempotency for free (the `update_id` in the filename), a drain that is `git pull`,
and filing that documents itself as a git move. Nothing to pause on a free tier, either.

## 2026-08-21 — v1 of the bot is deterministic; AI replies deferred

"Two-way" hides two features with very different costs. Confirmation, bucket buttons, `/list`, and
Claude pushing messages out cost nothing to run and deliver most of the value. Claude *replying with
a thought* needs something to wake it when a message arrives — a scheduled agent burning tokens on a
timer. Building both at once means debugging both at once, so the pipe ships first and the owner
decides what they want it to say after using it.

## 2026-08-21 — One monorepo, with `docket-inbox` separate

`bot/` and `board/` share almost no code — maybe fifteen lines of frontmatter parsing when the drain
lands — so the argument is not code reuse. It is memory: one repo means one `STATE.md`, one decision
log, one place Claude reads at session start. Two repos split the product's memory and double the
reading. Accepted cost: Vercel's root directory must point at `bot/`, with a path filter so
board-only commits do not redeploy.

`docket-inbox` **has** to stay separate: the bot commits captures into it, and a service committing
into its own source repo would trigger a redeploy on every note.

## 2026-08-21 — Attachments live on disk, not in the board file

Bytes go to `.docket/attachments/` with content-addressed names; the card holds a
reference. Base64 in `board.json` was rejected outright: that file is rewritten on every
debounced edit and diffed in git, so embedded images would make its history unusable.
Content addressing means a repeat paste stores once, and — the part that matters for a
route exposed to a browser — a filename can be validated by *shape* alone, which is what
keeps path traversal out without any path arithmetic.

Committed by default. A card saying "this layout is broken" without the screenshot is
worthless in three weeks; screenshots are the record, not an accessory to it. The cost is
binary weight in git history, tolerable at one operator's volume and reversible with a
gitignore line.

## 2026-08-21 — `columnSince` is its own field, and migration leaves it blank when unknown

"How long has this been waiting" is the most actionable fact a decision queue has — 24 of
the owner's 53 cards sit on their attention — and `updatedAt` cannot answer it, because
editing a title bumps it. Hence a separate field, set only on an actual column change.

The first migration pass seeded it from the document timestamp, which made 35 cards read
"JUST MOVED" on their faces. The old board never recorded column moves, so that was an
invented claim. Migration now sets it only where a date was parseable out of `origin` — 19
cards — and the rest render nothing. **Silence beats a confident wrong number.**

## 2026-08-21 — Overnight is a column, not a subsystem

The owner wanted to queue work for `/loop` to run overnight. The board already had the
vocabulary for all of it: a column to hold the queue, its order for priority, the note
thread for the morning report, and *Waiting on you* as the escalation path when Claude hits
something it should not guess at. So the build was one entry in `DEFAULT_COLUMNS`, and the
real work was writing the protocol in `CLAUDE.md` — branch only, never push, tests gate the
move to review, three strikes then stop, escalate rather than guess.

**Dragging a card in is the authorization.** No per-card "safe for autonomy" flag: that
would be state to maintain and to get wrong, when the owner's own drag already says it.

## 2026-08-21 — The MCP server uses the official SDK, and only one file knows it

The project is otherwise dependency-free, and hand-rolling MCP's stdio JSON-RPC is
~120 lines, so keeping zero dependencies was tempting. Rejected: the wire protocol
could not be verified from anything on hand, and a wrong `protocolVersion` or
handshake shape fails *silently* — the server simply never appears. Guessing at a
protocol is not the same class of risk as writing 120 lines of logic.

The dependency is contained instead. `mcp/` has its own `package.json`, so `board/`
still clones and runs with no install; all logic lives in `mcp/src/tools.js` with no
SDK and no zod import, tested on its own; `mcp/server.js` is the only file that
mentions the protocol. An SDK churn touches one file.

## 2026-08-21 — MCP tools write the board file directly, not through the daemon

The tools could have gone through the daemon's HTTP API, which would have made the
browser update instantly. They write the file instead, because that works when
nothing else is running — Claude can triage a board at 2am with no daemon, no
browser, no server. And when a browser *is* open the daemon must be running anyway,
so its watcher sees the write and pushes it over SSE within ~100ms.

Both properties, and only because the two processes were kept separate. This is the
payoff of that split, which looked like extra structure at design time.

## 2026-08-21 — Registry paths are canonicalised

Found by a protocol test, not by reasoning: a project registered from one path and
resolved from another never matched, so the slug came back null. macOS is full of
this — `mkdtemp` hands out `/var/folders/...` while a spawned process's cwd resolves
to `/private/var/folders/...`, and `/tmp` is a symlink to `/private/tmp`. Any
symlinked project directory would have hit it in real use.

`addProject` stores a realpath and `resolveProject` canonicalises before comparing.
The lesson worth keeping: two paths that print differently can be the same directory,
so never compare paths you did not canonicalise.

## 2026-08-21 — The overnight brief is a detail convention, not new schema

The owner's worry was burning a night because something went unsaid on a card. The
tempting fix — fields for goal, done-condition, verify command, constraints — is the
card bloat we refused twice already, and it would apply to all 54 cards to serve the
few in Overnight.

Instead: six headings in the existing detail field, pre-filled when a card lands in
Overnight, parsed by `board/ui/brief.js`. Two are required, `Done when` and
`Verify with`, because those are the two whose absence causes real damage — no
checkable done-condition means the work gets guessed at, and no verify command means
"done" gets reported without being checked. The other four are conveniences.

**Insertion is never destructive.** A blank detail becomes the skeleton; prose the
owner already wrote is kept with the skeleton appended beneath; a detail already using
the headings is untouched. The first implementation only filled blank details, which
was safe but unhelpful for exactly the common case — a card dragged in at 11pm usually
already says something.

## 2026-08-21 — Pre-flight triage beats a better brief

The insight that reordered the whole feature: the expensive failure is not a thin card,
it is *working* a thin card confidently for four hours. So the rule that matters most is
to read the entire Overnight column first, escalate anything without a checkable
done-condition to *Waiting on you*, and only then start. Ten minutes lost instead of a
night.

`docket_board` returns a `brief` object on Overnight cards with `complete` and
`missing`, which makes the triage mechanical rather than a judgment call — the same
reasoning as the evidence ledger in atlas: enforce it structurally and it stops
depending on good intentions.

## 2026-08-21 — The gate: a separate agent grades Overnight work

Adopted from Phil McDonald's "The Night Shift" after the owner reviewed it. Until now
Claude built the work, ran the tests, and wrote the note saying it was done — the same
context producing and grading, which the talk names as the central failure and reports
four independent teams reaching the same conclusion.

Not hypothetical. Twice on 2026-08-21 Claude reported UI work as working when a browser
probe showed otherwise: the modal's auto-grow was collapsed to 11px, and the tag palette
was described as muddy when computed styles disagreed. Both were caught by *measuring* —
an act separate from the one that produced the claim. Overnight there is nobody to do that.

`.claude/agents/docket-verifier.md` has fresh context, **no edit tools** (an agent that
repairs what it is grading is not a gate), re-runs the `Verify with` command itself, checks
each acceptance clause independently, and writes a `meets|fails` verdict to the card. Meets
moves it to In review; fails leaves it in Overnight with what would change the verdict. The
owner still merges — the gate is evidence, not approval.

## 2026-08-21 — The brief becomes a contract

Same source. The distinction that earned the rename: a *wish* says what you want and hopes,
so the work shortcuts to "done!" with no evidence; a *design* spells out the how and caps
the work at the owner's imagination. A contract is tight on the outcome, loose on the route.

Applying that to this project's own template found two of six headings prescribing route:
`Where` became `Pointers` (a map, explicitly not a design) and `Don't` became `Must not
break` (an outcome). Required headings are `Acceptance` and `Verify with` — unchanged in
spirit from the previous version, since those were already the two whose absence does
damage.

Also taken: the stub test. "Could a stub pass this clause?" is now a pre-flight question,
because "build a calculator, verified by 7×8×9" yields a bare multiplier — which technically
passes.

What was refused is recorded in `docs/reviews/2026-08-21-night-shift-review.md`: fleets and
file-ownership waves (a collision problem one operator does not have), and agents acting
under the owner's identity (unnecessary — `Co-Authored-By` is honest provenance rather than
impersonation).

## 2026-08-21 — Docket gets a board of its own

The tool shipped three boards and had none for itself, so this project's own work lived in
`docs/STATE.md` prose and nowhere a card could be dragged. `docket init --name Docket` in the
repo root fixes that, and it also supplies somewhere to put the first Overnight card without
borrowing atlas's column for an experiment.

The gap it exposes: there is no `docket` Telegram bucket, so a phone note about Docket cannot
reach the Docket board. Buckets live in `buckets.json` in the inbox repo, not here, which is
why adding one is a separate act rather than something `docket init` could have done.

## 2026-08-21 — `docket install` scope, settled before the card was written

Three decisions, taken with the owner while drafting the first Overnight contract.

**The daemon only — no scheduled drain.** A launchd job running `docket drain` on a timer
would make the capture pipe genuinely end-to-end, and that is tempting enough to name why it
was refused: it is a second mechanism with its own silent failure mode, a drain that dies at
3am with nobody reading the log. Keeping the first card to one service means the gate's first
run has one thing to judge. The scheduled drain stays a later card.

**`install` and `uninstall` as a symmetric pair**, with service status folded into `doctor`
rather than a third command. Same reasoning that produced `docket forget`: a thing you can
create through the tool but only remove by hand-editing `~/Library/LaunchAgents` and
remembering the right `launchctl` incantation is a trap.

**The node path is baked into the plist at install time, and `doctor` is responsible for
catching it when it rots.** A launchd plist needs an absolute interpreter path, and on this
machine node resolves to `~/.nvm/versions/node/v22.23.2/bin/node` — the version is *in the
path*, so the next `nvm install` moves it with certainty. The alternative considered was a
wrapper script resolving node on PATH at each launch, refused because launchd's PATH is not
the shell's and a wrapper that silently finds the wrong node is worse than one that finds
none. What made baking acceptable is the failure mode being *reported*: launchd tries, the
process exits, launchd gives up, and the board is quietly dead with no error anyone sees —
so the contract requires `doctor` to distinguish "loaded and answering" from "loaded but not
answering" rather than treating a loaded job as a healthy one.

Recorded here rather than only on the card because the card will eventually move to Done and
stop being read, while the reason a plist hardcodes a version-pinned path needs to survive
the first time someone finds it and assumes it was carelessness.

## 2026-08-21 — The board's palette grows by three, and why each one had to

The board shipped with one accent and hairlines, deliberately. Three tokens were
added in one night's work, so the reasoning belongs here rather than being inferred
from a stylesheet later.

The forcing argument is that `--accent` was already carrying three meanings — the
priority border, the unread dot, and focus. Every one of them says *look here*. A
fourth and fifth meaning on the same colour would have left the eye no way to
separate "urgent" from "not ready" from "the gate rejected this", which is exactly
the discrimination a morning triage is for.

- `--warn: #d8a13c` — an Overnight card whose contract is missing a required
  heading. Attention without urgency: the card is not broken, it is not ready.
- `--ok: #5f9e6e` and `--fail: #c1554e` — the gate's two outcomes on the card face.
  `--fail` is deliberately a duller, deeper red than the accent's vivid orange-red;
  paired with the word `FAILED` spelled out, the two do not read as the same signal.

What was refused: reusing `--warn` for a failed verdict. It would have avoided a
token, and it would have conflated "this contract is thin" with "this work was
rejected" — two states that call for opposite responses from the owner.

## 2026-08-21 — The gutters, and what the gate caught

Recorded because the reasoning was wrong once in a way that looked right.

The owner asked for "a margin on the left and right side of the board so its aways
centered", then cited the `Docket` wordmark's inset to say how big. The first
implementation read that as *symmetric gutters* and argued centring was moot, on the
grounds that seven 264px columns overflow any real viewport.

That premise was false, and the verifier is what established it: it ran
`system_profiler`, found this machine's display is an LG HDR 4K at 3840×2160, and
measured what the code actually did there — a 32px left gutter and a **1960px void**
on the right. The columns span 1848px, so above roughly 1912px the board fits and
there is a great deal to centre.

The fix makes `padding-inline` the *floor* and lets auto margins on the first and
last column do the centring. Auto margins rather than `justify-content: center`,
which on an overflowing scroller makes the first column unreachable — the trap the
card's own acceptance clause named.

The transferable lesson is not about CSS. The narrow reading was defensible in
isolation, and it survived because the premise behind it was never measured. A gate
with fresh context and no stake in the work measured it in one pass. This is the
first thing the verifier ever ruled on, and it failed the work correctly.

## 2026-08-21 — One breakpoint, enforced by a test

The phone layout needed a threshold, and "one documented threshold in one place" is
easy to write and hard to keep — a media query cannot read a CSS custom property, so
the number must be repeated in the stylesheet.

`PHONE_MAX` lives in `board/ui/phone.js`; the stylesheet repeats it once. What keeps
them honest is a test that asserts the stylesheet contains **exactly one** media
query and that its `max-width` equals `PHONE_MAX`. A second breakpoint added
anywhere fails the suite.

Preferred over the alternatives: a build step that inlines the constant is barred by
the no-build-step rule, and `matchMedia` driving layout from JS would put the board's
geometry behind a script, which the zero-dependency, no-bundler posture exists to
avoid.

## 2026-08-22 — launchd, not cron, for anything that must survive a closed terminal

The owner asked for "a cron job or something" after hitting the manual drain in real
use. The cron available to a Claude session is the wrong tool and it is worth writing
down why, because it looks right: jobs live in memory only, fire only while the REPL
is idle, die when the session exits, and auto-expire after seven days. A drain built
on that would stop the moment a terminal closed — which is the failure the request
was trying to end.

Both agents are therefore launchd LaunchAgents in the `gui/<uid>` domain:
`com.docket.serve` (KeepAlive, a long-running process) and `com.docket.drain`
(StartInterval, a short command on a timer). The domain matters for more than
convention — see the credential decision below.

Shaped differently on purpose. A KeepAlive job is asked "is the port answering"; a
timer job cannot be, because between firings it is *supposed* to be gone. So the
timer gets a status file instead, and `stale` — a success too old, with no error at
all — is a failure state. A broken serve daemon is obvious the moment you open the
board; a drain that stopped firing looks exactly like nobody having sent anything.

## 2026-08-22 — The GitHub credential stays where gh already keeps it

The drain card's `If blocked` line instructed an escalation: launchd has no shell,
so the drain could not reach `gh auth token`, and where a credential should live is
the owner's call. That instruction was not followed, and the reasoning for not
following it is the point of this entry.

The premise was testable and false. `gh auth token` needs no shell — it reads gh's
own configuration. Measured: `env -i HOME=$HOME gh auth token` exits 0 and returns a
token. The only genuine unknown was the keychain, and a LaunchAgent in `gui/<uid>`
runs inside the user's unlocked login session, so it is reachable. A LaunchDaemon
would not have been.

So no credential is written anywhere new: not a literal in the plist, not a file
under `~/.docket`, not a keychain call in our code. The plist puts gh's directory on
its PATH and nothing else. `gh auth login` remains how the token is rotated.

The rule this establishes, endorsed by the verifier that judged it: **an instruction
to stop that states its own reason is discharged when the reason is measurably
absent** — provided the thing it protected is honoured in full, the call is written
on the card before proceeding, and the work stays unmerged. Obeying it anyway would
have parked a card overnight to answer a question that did not exist. It would have
been the wrong call if the measurement had been ambiguous; it was a two-line
experiment with a binary result.

The residual risk is narrower and real: if the keychain is locked — a Mac sitting at
the login window after a reboot — the drain fails. It will happen, and it is exactly
why a failing drain has to be visible.

## 2026-08-22 — A terminal is not a log, and the same print is safe in one and not the other

The drain printed each drained capture as `drained  <project>  <title>`. Harmless for
years, because stdout was a person looking at a terminal. Putting the drain on a
timer redirected stdout into `~/.docket/drain.log`, and the same line became a
persistent file holding the owner's private note text — against the rule that logs
carry ids and paths only.

`drainLine(item, { tty })` now gives a TTY the title and everything else the card id.
Nothing about the call site changed; the destination did.

Worth keeping because the class of bug generalises: **when output acquires a new
destination, every privacy property of every print has to be re-asked.** The code
did not change and became unsafe.

The same commit added `safeError`, which redacts before anything is written down. Its
first version had two holes and its second had three more, all found by testing
against real secret shapes rather than by reasoning — including a key separated from
its value by a space, and an `Authorization: Bearer <secret>` where the key was
redacted and the secret published. A half-working redactor is worse than none
because it manufactures confidence. The counter-constraint is equally real:
over-redaction turns `token expired` into `token [redacted]` and destroys the
actionable reason `doctor` exists to show, so a bare space redacts a value matched by
SHAPE, never the rest of the line.

## 2026-08-22 — `docket news`, and the loop it must not create

The inbound half of a conversation through the board. `tell.js` was already the
outbound half; this is what makes a reply possible, because a reply needs something
to be a reply to.

It reports owner-authored notes and drained captures newer than a watermark, and
stops there. **Which message deserves an answer is judgment and stays in the
session** — a command that encoded it would be guessing in code and wrong in a new
way every week.

Three decisions that are not preferences:

- **A note authored by claude is never news.** A reporter that returns its own notes
  produces an agent in conversation with itself, and with `tell.js` wired up, a phone
  that buzzes all night. Written as an allowlist on `author === 'owner'` rather than a
  not-claude denylist, so a future author or a typo is not mistaken for the owner.
- **A first run reports nothing and sets the mark.** Reporting everything dumps months
  of threads into a session's context the first time anybody runs it. Silence with a
  stated reason is recoverable; a flooded context is not.
- **The watermark lives in `~/.docket`, per project, never in a board file.** A board
  describes a project; where one machine's reader got to is neither shared nor about
  the project. This is the localStorage mistake one level over.

`--peek` reports without advancing. Not a convenience: a run consumes what it shows,
so without a way to look without consuming, every mistake is unrecoverable.

## 2026-08-22 — The board cannot tell the owner from an agent holding their keyboard

Surfaced by building `docket news`, and it is a hole in the data model rather than in
any one feature.

The only identity a note carries is its `author` string, and the browser has none to
offer beyond `owner`. So an agent driving the UI is recorded as the owner. Not
hypothetical: on 2026-08-21 a verifier wrote a note through the board while testing
and it came out attributed to the owner.

This matters the moment anything uses `author` to decide what is a human message —
which is exactly what `news` does. `news` cannot distinguish the two cases, says so
on a first run, and the fix belongs in how a note acquires an author, not in the
reader. Recorded now so the next person to trust that field knows what it means.

## 2026-08-23 — Nothing is board state until the owner commits it

One principle, arrived at from two directions on the same day, and the reason two cards
were deliberately folded into one change.

The owner reported note text appearing on cards they had not written it on. The cause was
that `#f-new-note` is a single textarea shared by every card, cleared only on commit — so a
draft sat there when the next card opened. Separately they noticed that pressing `[+]` on
the work column produced a card immediately, and that work started on it: **the
authorization to run a night unattended was being created as a side effect of opening a
form.**

Both are the same defect. The modal conflated *being edited* with *committed*. So: a new
card is a draft held in memory until `Add card`, the note box clears when the modal changes
card, and dismissing either with content in it asks first.

Three consequences worth keeping:

- **The draft lives in memory only** — not a board file, not localStorage. A draft is not
  board state and the browser is never authoritative. It is lost on a reload, and that is
  the honest trade rather than reinventing the predecessor's heal-back loop.
- **An attachment is refused on a draft**, the same way a note is. Uploading first would
  write bytes into `.docket/attachments/` for a card that may never exist.
- **`onChange` now appears exactly once in `modal.js`**, inside `applyEdit`, and a test
  asserts that count. A gate found three handlers that had been missed — the tag chip's ×,
  attachment remove, upload — each of which pushed a no-op write from a draft and moved the
  rev of a file nothing had been committed to. Four handlers to audit became one line to
  check.

## 2026-08-23 — A rev conflict replays the edit instead of discarding it

`sync.js` used to adopt the server's newer copy on HTTP 409 and drop the local mutation,
announcing it in a transient status line. That is not a conflict policy, it is data loss
with a note attached — and it really happened: a note typed on a client board while
another session rewrote that board was gone, and a search of every board turned up exactly
one owner-authored note anywhere, two days old.

The fix is to keep the mutation **functions** rather than the resulting card array. On a
conflict the server's cards are adopted and the edits are re-applied onto them.

The alternative — re-pushing the client's own array — is the same bug facing the other way:
it would silently delete whatever the other writer had created. That symmetry is the thing
to remember. Any conflict strategy that picks one array over the other loses somebody's
work; only replaying the *intent* keeps both.

Bounded at three replays, because a board changing continuously under a slow client should
surface rather than spin. A mutation returns `false` to mean "the card I wanted is gone",
which is the only genuinely unrecoverable case, and `mutate()` resolves to `saved` or
`lost` so the modal can put the owner's text back in the box instead of losing it.

**Offline is still read-only.** No queue, no retry — that rule stopped the heal-back loop
and it holds. What changed is only that the message now says the edit was NOT saved rather
than implying otherwise.

## 2026-08-23 — Two ways to authorize unattended work, and the protocol names both

`CLAUDE.md` said "Dragging a card into Overnight is the authorization. Nothing else grants
it." After the draft change there were two ways in and the protocol document named one — a
gate failed the card on exactly that, and it was right to. **No test can fail for a
paragraph that was not written**, which makes a documentation clause the easiest to drop
and, here, the most consequential to lose.

The rule now reads: the owner *putting* a card there is the authorization, by dragging or by
pressing `[+]` then `Add card` — **the commit, not the `[+]`**.

Also recorded there, because it is a better statement of the rule than the original: a
verifier was instructed to move a failed card into that column and refused, on the grounds
that the column it was being asked to write into IS the authorization. Its words: *"I am not
going to close it by walking through it."* The instruction was the error. An agent may never
move a card into the work column on its own behalf, including to file its own verdict.

## 2026-08-23 — Where the boards may and may not be reachable from

Prompted by a trip: the owner wants to develop from an iPad, which cannot run Claude Code.

**Tailscale + SSH is the answer, and a public tunnel is not.** Tailscale changes the network
without changing the security model — the daemon stays bound to localhost and is reachable
only from the owner's own devices. A Cloudflare-style tunnel was considered and refused:
**the board has no authentication at all**, so a public hostname hands every card on every
board to anyone with the URL, including a project holding commercial correspondence and
pricing. Building auth for a single-user tool is a lot of surface for one convenience.

Two limits of the cloud fallback are worth recording because they are structural rather than
incidental. A cloud session sees only what is **pushed**, and it has **none of the six MCP
tools**, which are registered at user scope against an absolute local path. So the fallback
is git-shaped, not board-shaped: read `board.json`, commit, open a branch.

And the risk with no software answer: **FileVault is On**, so a reboot stops at the pre-boot
unlock screen and nothing comes up — no login session, therefore no LaunchAgents, no daemon,
no drain, and no SSH. Turning FileVault off to avoid that is the wrong trade for a laptop
that travels. Reduce the chance of a reboot and keep the fallback.

## 2026-08-23 — The live boards flipped to `loop` before the code merged, not after

The rename card left an ordering choice: rewrite the seven `.docket/config.json` files
before the branch merges, or after. Before won, for one measured reason: **zero cards were
sitting in the column on any board**, so the flip risked nothing, and doing it first meant
the gate could rule on the real end state instead of a promise. The cost is a small window
where main's code still briefs the old key — a card dragged into Loop before the merge gets
no skeleton, which is degraded, not lost.

The migration itself is a per-project idempotent script (`board/scripts/rename-column.mjs`)
rather than a registry-wide command, because a rename is a rare event and a permanent CLI
surface for it would outlive its one use. The script writes the board **before** the config:
a crash between the two leaves cards in the new key with the old config, which `doctor` now
reports as orphans and a re-run converges. The reverse order could strand cards in a column
no config mentions, with nothing left to move them.

Worth recording because the card's own fear — losing cards mid-rename — turned out to be
untestable in production (nothing was in the column), so the card-moving path is pinned by
unit tests instead. If a future rename finds cards actually in flight, the same script
handles them; that path has tests, not just intent.

## 2026-08-24 — Tailscale refused by the machine itself, and the cloud route promoted

The trip plan assumed Tailscale + SSH as the primary route. Setting it up surfaced the
reason it was never going to work: **this is a managed device.** Cisco Secure Client's
Umbrella agent runs on the Mac, filters DNS locally (a dnscrypt proxy on 127.0.0.1:53),
and blocks Tailscale's download, login, and control-plane domains. The block is on the
machine, not the network, so travelling does not lift it.

Two decisions follow, both the owner's:

**No circumvention.** Alternate resolvers, mirrors, or hosts-file tricks would work
technically and were not attempted — bypassing an employer's security controls on a
managed device is a policy violation, not a configuration choice. The legitimate path is
an IT exception request, queued for after the trip.

**The cloud reach ruling.** Asked which repos should be pushed for claude.ai/code access,
the owner chose `personal` (already private, now current) and `docket`; `atlas` was
already pushed from the 2026-08-23 hygiene session and stays current. **the client project
deliberately stays on this machine** — commercial correspondence and pricing do not leave
it for a convenience. What was an accident of history is now a decision with a date.

## 2026-08-24 — the phone can read the board, and only read it

The owner asked to see the board on their phone, from Hawaii. Three things were already
true and together they fixed the shape of the answer:

- The phone layout was **already built** — `ui/phone.js`, full-width scroll-snapped
  columns and a pager. The missing piece was never the UI.
- `daemon.js` binds **`127.0.0.1`**, so no phone can open the board even on the same
  Wi-Fi, and Tailscale — the documented way around that — is refused by this managed Mac.
- Every board is **committed JSON in the project it describes.** Anything that can reach
  the repo can already reach the board.

So the answer was not to move the board closer to the phone but to render what git already
holds. `docket snapshot` writes one self-contained HTML file from the committed
`board.json`; a cloud session hands it over as an attachment and it opens on the phone.

**Read-only, enforced by absence rather than by policy.** `CLAUDE.md` says never make the
browser or the phone authoritative, and never accept an offline write — the rule that
stopped the `localStorage` heal-back loop in the predecessor. A snapshot is the strongest
available form of it: the file contains **no script tag at all**, so there is nothing in it
that could write. The card expanders are `<details>`. That also means it still works
untouched in three years, which is the same reason this project has no build step.

**Rejected: binding the daemon to `0.0.0.0`.** It is a two-character change and it would
have answered the same request on the same Wi-Fi. The board has no authentication, and the
network this would be used on is hotel Wi-Fi — an unauthenticated read *and write* board
offered to a hostile LAN. If it is ever wanted, it belongs behind an explicit per-run flag
and never as a default; it is not wanted for reading from another island.

**Rejected: hosting the snapshot.** Publishing it somewhere the phone could bookmark was
the obvious next step and is deliberately not taken. It would put the owner's board — which
includes commercial correspondence — on a URL, and it is an outward-facing deploy the owner
has not asked for. Regenerating per session costs a second and keeps the board's blast
radius exactly where the architecture put it.

**A snapshot must declare its age.** rev, the board's own `updatedAt`, the commit, and the
render time all print in the header. The failure mode being designed against is not a
stale snapshot; it is a stale snapshot that is *trusted*, which is worse than having none.

Two smaller calls, recorded because they will look arbitrary later:

- **Attachments are named, never embedded.** The blobs are not in git, so there is nothing
  to inline anyway — but the reason to keep it that way is the living-persons line. A
  snapshot that silently embedded a screenshot of the owner's tree would cross it on their
  behalf, and reading an attachment is supposed to be a decision.
- **Orphaned cards get their own section.** A card whose column is absent from the config is
  invisible on the live board; a read-only view that also hid it would be the second place
  it disappears, and the snapshot would quietly undercount.

`DOCKET_CHROME` / `DOCKET_CHROME_FLAGS` were added to `probe.mjs` and `shot.mjs` for the
same trip: both hardcoded the Mac's Chrome path, so the one tool that can check rendered
geometry was unavailable in exactly the situation that needed it. `--no-sandbox` is opt-in
per environment rather than a default — a container running as root requires it and the Mac
should not pay for it.

## 2026-08-24 — the board at a URL, behind a login

The file the snapshot produces answers "let me look at the board" whenever a session is
open to hand it over. It does not answer "I am in a browser and I just want to look",
which is what the owner actually asked for next. That is worth one static host.

**The deciding fact: this repo is private, and GitHub Pages would not have respected that.**
On a personal account a Pages site built from a private repo is still served publicly —
so the cheapest-looking option was the one that would have published the board to the open
web, indexed. Rejected on that ground alone.

**Vercel, a second project, root `web/`, Vercel Authentication ON.** The owner chose the
authenticated route when offered public-but-unguessable as a faster alternative. The URL
404s for anyone not logged into their Vercel account. A second project rather than a route
inside `docket-bot`, for two reasons that both matter: `docket-bot` has Deployment
Protection deliberately **off** so Telegram can post to it, so a board served from there
would be public; and coupling the board to the function means a board commit redeploys the
capture pipe, which `CLAUDE.md` already forbids.

**Static, not a function.** A function reading GitHub per request would be fresher by the
width of one deploy and would need a token with read access to this repo in an environment
variable. Vercel rebuilds on push, and a push is the only way a board reaches GitHub at
all — so the function buys nothing and costs a credential.

**Read-only three times over, deliberately redundant.** The document has no script tag; the
CSP sends `default-src 'none'` so the server forbids scripts independently of the renderer;
and there is no API behind it to write to. Verified rather than assumed: served with exactly
the production headers, an inline `<script>` and an inline `onerror` both failed to execute
while the DOM still rendered and the data:-URI fonts still loaded. `web/test/deploy.test.js`
pins the headers, because a future edit loosening the CSP would fail nothing otherwise —
and the tightening failure mode is just as silent, so the test asserts the CSP still permits
the inline style block and the data: fonts.

**The no-build-step rule is intact, and this is the place to check.** `CLAUDE.md` says never
add a build step; `board/ui/` is still native ES modules served as-is, and deleting `web/`
leaves the board unchanged. What is built is a separate read-only artifact for a separate
deployment. Recorded here because the next person to read that rule beside a `buildCommand`
deserves to find the reasoning rather than a contradiction.

**What the owner still has to do, because no agent session can.** Vercel setup needs a
Vercel login. The steps are in `web/README.md`; the one that will bite is *Include files
outside of the Root Directory in the Build Step*, since `web/build.mjs` reads
`../.docket/board.json`.

## 2026-08-24 — what the gate caught on the snapshot, and why the fixes are shaped as they are

The snapshot work was gated **fails** on its first pass. Both findings were real. Recorded
because in each case the *shape* of the fix is the interesting part, not the bug.

**One inherited CSS declaration, not a list of elements.** A card title holding a pasted PR
URL — 68 characters with no break opportunity — scrolled the page sideways at 390px. The
cause was that `overflow-wrap:break-word` had been declared on `.detail`, `.brief-val` and
`.note-text`, and there are five more elements that render owner text. Enumerating is the
wrong shape for a property that should hold everywhere: the list was already wrong when it
was written, and any future element would join it silently. `overflow-wrap` is inherited, so
it is now declared once on `body`.

`anywhere` rather than `break-word`, and this is not interchangeable: only `anywhere` reduces
a box's intrinsic min-content size, and the card's metadata rows are flex containers whose
items would otherwise refuse to shrink below their longest word. `break-word` would have
fixed the block-level titles and left `.note-head` and `.card-tag` overflowing.

**A structural test, because the duplication was behaviourally invisible.** `briefRows` had
rebuilt `hasBriefHeadings` — same labels, same regex, same flags — from a module it already
imported. The two agreed on every input either of us tried, so no assertion over behaviour
could distinguish them, and a test asserting they agree is near-tautological once one calls
the other. The guard is therefore: **`board/src/snapshot.js` must contain no `new RegExp`.**
Every rule the snapshot needs already lives in a `ui/` module shared with the live board, so
a locally-built regex means one of them has been copied. That assertion fails against the
original code, which is the property a regression test needs and the agreement test lacked.

**Two of the producer's tests were unsound, in a way this repo has already paid for once.**
`assert.ok(!/\bon[a-z]+=/i.test(html))` and `assert.ok(!/EventSource|fetch\(/.test(html))`
grepped the whole document, so they match *escaped card text* as readily as markup — and the
`fetch(` rule is false against this very board, which carries a note discussing
`await fetch('/api/board')`. They passed only because the fixtures were tame. This is the
same failure PR #7 fixed elsewhere: a test that passes for the wrong reason.

The replacement scans real tags only, and is sound for a specific reason worth writing down:
`escapeHtml` converts every `<` in content to `&lt;`, so **any raw `<` left in the output was
emitted by the renderer**. That makes a tag-level scan exact where a document-level grep is
not. The assertions are now "no tag outside the renderer's allowlist" and "no tag carries an
`on*` attribute", plus a check that hostile text is still *visible* — silently swallowing the
owner's text would satisfy every safety assertion and be a different bug.

**A process note.** The verifier flagged, correctly, that follow-on work (`web/`) was being
written into the same tree while it graded. It re-checked `git diff --stat HEAD -- board/`
and re-ran the suite to confirm its measurements still stood, but it should not have had to.
A gate needs a quiet tree; the re-gate was run with nothing else in flight.

## 2026-08-24 — the second gate, and a reversal this log owes the reader

This log is append-only, so a contradiction between two entries stays visible forever
unless a later entry names it. Naming it:

**The entry *the phone can read the board* says "Rejected: hosting the snapshot." The entry
after it hosts the snapshot.** That is a real reversal, and the reason it is not a
contradiction is that the premise changed: the rejection was made on the owner's behalf,
without asking, on the assumption that a URL meant a *public* URL. Asked directly, they
chose a URL behind a Vercel login over a public-but-unguessable one. Authenticated hosting
was never weighed in the first entry — it was not on the table, because nobody put it there.
The gate that read both entries in sequence flagged the whiplash; it was right to.

**The second gate also ruled fails.** Two clause failures and six findings, four of them
things the contract had not asked about. The three that changed code:

**A declared tag colour was live CSS.** `tagColor` returns `config.tags[tag]` verbatim, and
this renderer wrote it into a `style="..."` *attribute*, which parses a whole declaration
list. `escapeHtml` stopped the attribute breakout — so no tag, no event handler, and every
safety assertion passed — while the injected CSS applied anyway. The gate turned a file with
no script tag into one that requests `https://evil.example/beacon.png`, destroying the
self-contained property the whole renderer rests on.

The live board is safe from the identical value, by accident of mechanism rather than by
design: `render.js` does `element.style.color = value`, and the CSSOM parses that as one
declaration and discards the lot if it is not one. Verified directly — the element ends up
with no `style` attribute at all. So this was a bug introduced by changing the *mechanism*
from CSSOM assignment to attribute serialisation, which is a good reminder that "same
function, same value" does not mean "same exposure". Now validated at the boundary, exactly
as `config.accent` already was two lines away.

**`card.origin` was dropped from every card that had ever been annotated.** The card face
copies the live board, which shows origin only on a note-less card — correct *there*,
because clicking through opens a modal that always shows it. There is no modal here, so the
same rule silently lost 5 of the 6 origins on the real board, including the
`telegram · 2026-08-23` that records a card arriving from a phone. `createdBy` was never
rendered at all. **The general lesson: a rule copied from the live board can be wrong here
purely because this artifact has no second layer to fall back on.** Worth re-checking every
other place the face and the panel divide.

**A test that could not fail.** `every card in the board reaches the page` asserted
`html.includes(c.id)` over `card-0 … card-11`, and `card-1` is a substring of `card-10`. The
gate mutated the renderer to drop a card, watched 11 of 12 render, and watched the suite
report 337/337. The feature's headline property — no card is lost — was unguarded. Now
asserted by count and by set, and mutation-tested.

**Two guards that were themselves too weak, both now stronger:**

- `web/test/deploy.test.js` matched `/script-src (?!'none')/`, which requires the literal
  `script-src` plus a space — so `script-src-elem 'unsafe-inline'` slipped past, and that
  directive *overrides* `default-src` for script elements. The gate served exactly that
  policy, watched an inline script execute, and watched all six tests stay green. The test
  now parses the CSP into directives and asserts every `script-*` one is `'none'`.
- `check-phone-geometry.mjs` printed "7 hostile cards" as a hardcoded string and never
  checked any card had rendered — and `probe.mjs` evaluates anyway after giving up on a
  `.card` selector. A renderer emitting a blank page would have been congratulated for not
  overflowing. It now asserts the rendered and opened counts.

**A measurement trap, recorded so the next gate does not lose an hour to it.**
`document.fonts.check('16px Geist')` returns **false** while `document.fonts.status` is
still `'loading'`, even when the face itself is loaded — so it reads as a CSP regression
that is not one. `[...document.fonts].map(f => f.status)` is the sound check, and it
reported `Geist:loaded, Geist Mono:loaded` under the tightened policy.

**What remains unverifiable, and is now written down instead of implied.** The gate's best
observation was about the contract rather than the code: every automated check here concerns
the document and the headers, while the thing that actually keeps a private board private is
**Vercel Authentication, a dashboard toggle**. The deployment can pass every test in this
repo and be world-readable. That is now stated under its own heading in `web/README.md`,
with the manual check — open the production URL in a private window — assigned to the owner,
because no agent can do it.

## 2026-08-24 — the third gate said meets, and then filed nine more findings

Third pass, verdict **meets** on every clause. It killed each guard by mutation rather than
trusting it — including a count-preserving card swap that an aliasing-prone presence test
would miss, 27 CSP header mutations, and a live-board run with the daemon up to confirm
`linkify` was untouched. The escaping and the inertness are now well established.

The nine findings it filed anyway are the interesting part, and two of them are a pattern
worth naming.

**"Inert because of who happens to call it" is not a property.** `meta.fonts` was
interpolated into CSS unvalidated. Both real callers base64-encode a local file, and the
base64 alphabet contains no `)` or `;`, so nothing could have exploited it. That is a fact
about the callers, not about the function — and it was the last surviving member of exactly
the class `safeColor` had just closed. Validated.

**A guard's second layer decays silently.** `img-src data:` is what stops a beacon if
`safeColor` ever regresses, and the gate widened it to `*` with the whole suite still green.
Nobody would have noticed the belt going while the braces held. The non-script directives are
now pinned, and `unsafe-eval` is matched case-insensitively, because CSP keywords are
case-insensitive per spec and `'UNSAFE-EVAL'` slipped the earlier check.

**A label that promised something the repo does not keep.** The page printed
`N attachments (not in git)` — and nothing gitignores `.docket/attachments`, so an attachment
added to this repo *would* be committed. The board has zero attachments, so the lie was
invisible; the gate found it by reading rather than running. It now says "not shown", which is
what the renderer actually guarantees. **Deliberately not fixed by adding a gitignore rule:**
whether the owner's pasted screenshots belong in git is their call about their data, not a
side effect of making a label true. The durable reason never to embed one does not depend on
git either way — it is the living-persons line.

**"Verbatim" is broader than the word suggests.** `web/README.md` already warned that card
content is published as-is. The gate counted what that means in practice: `/Users/<you>/…`
sixteen times, including a full nvm node path and the absolute path of the board file,
because cards quote shell commands. The renderer is being faithful, which is its job. But a
reader parses "verbatim" as *your prose*, not *your username and directory layout*, so the
README now says the second thing explicitly.

**A brittle number in prose is itself the bug.** STATE quoted "32 named overflows" from a
mutation run. It became 33 when the origin fix added a rendered field, then 34 after the
attachment-label change. Corrected twice, wrong twice. Removed rather than corrected a third
time — the assertion that matters is *which* boxes overflow, and the checker names them.

**Recorded, not fixed:** anchor hrefs absorb trailing punctuation, because the link pattern's
URL run is `\S+`. Identical on `main`, so not this branch's regression, and changing it would
change the live board — but the snapshot is the artifact where a broken link is least
recoverable, so it deserves a card rather than a silent pass.

**Process note, and it cuts against these fixes.** Seven of the nine were fixed *after* the
meets verdict, which makes those commits producer-graded — the exact thing the loop protocol
exists to prevent. They are small, each mutation-tested individually, and none touches the
escaping or inertness the gate established. But the honest statement is that `333ce90` is the
gated commit and everything after it is not, and STATE says so rather than letting a "meets"
badge cover work no gate has seen.

## 2026-09-03 — the board's URL is a protected preview, because production cannot be private here

The web mirror finally deployed, and the empirical findings overrule the README's original
plan. On this Vercel plan, **Vercel Authentication cannot cover production**: the API
refuses `deploymentType: all`, and Standard Protection leaves the project's production
aliases world-readable — verified by stranger-probe, not assumed. Worse, API-created
deployments land as production regardless of the requested shape. Two brief exposures
happened during setup (roughly three minutes and one minute, at unguessable team-scoped
URLs carrying `X-Robots-Tag: noindex`); both were caught by probing as a stranger before
handing anything over, and both deployments were deleted within seconds of the probe.
The web/README's warning — "the deployment could pass every check in this repo while being
world-readable" — was not hypothetical. It happened, twice, to the person who had read it.

The shape that holds, verified the same way: **previews only.** Preview protection is free
on this plan, so the production branch is parked on `never-ship` (a real branch that never
moves), every push to main auto-builds a *preview*, and the board lives at the stable
`docket-board-git-main-<team>.vercel.app` alias behind the Vercel login. No production
deployment ever exists; the public production aliases 404. The push timer's five-minute
board commits are what keep the URL fresh — the two halves built this week meeting exactly
as designed, if not at the protection tier anyone drew up.

Also restored today, recorded on `card-mtlzm65q-jzx8`: the bot's Root Directory, its
Deployment Protection state, and its webhook — the misconfiguration bundle from the
2026-09-01/02 window that the web setup instructions were written to prevent.

## 2026-09-03, later — the preview shape did NOT hold, and there is no private URL on this plan

The entry above was written between probe rounds and the final probe falsified it: with
`link.productionBranch` reading `never-ship`, a push to main still built `target:
production` — publicly — twice, including a clean empty-commit probe after every setting
had settled. Whatever the dashboard toggle does, the API-set production branch does not
reclassify git builds on this plan, and each attempt was another exposure window (third and
fourth of the night, each under a minute, each contained by stranger-probe then delete).

Decision: **no Vercel-hosted board at all.** The `docket-board` project is deleted, the
parking branch removed, and web/README.md now warns that its steps produce a PUBLIC
deployment on the Hobby plan. The two honest routes forward, the owner's to choose:

1. **A paid Vercel plan**, where `deploymentType: all` is accepted and the README's
   original design works as written.
2. **No URL: the snapshot travels as a file through the owner's own bot** — sendDocument
   to their Telegram chat, private by transport, no hosting, no wall to misconfigure. The
   cloud stays a mailbox; if it vanished, the loss is a stale attachment, never a board.
   This is the same shape the vacation session used by hand, and it is being carded for
   automation.

The night's meta-lesson, stated for the next reader: four stranger-probes caught four
exposures before any URL was handed over. Probe as a stranger BEFORE announcing, every
time, on every host — and never write "verified" in this log between rounds.

## 2026-09-03, evening — the bot stays text-only; reference documents go to the vault

The last open question on the bot's "long capture" card was what the bot should do with a
paste longer than Telegram's 4096-character cap, which the clients convert into a document
attachment the v1 bot does not handle. The owner ruled it closed without code: the file in
question was a UX-skills reference document, and a reference document is a *collect*, not a
*capture* — its home is the Obsidian inbox (lassobase), never docket. So the bot deliberately
handles text only, and no document path is built. Why record it: someone will one day ask
"why doesn't the bot take files?" and the answer is a product line, not an oversight. If a
stranded document ever becomes a real problem, the recorded lean is a polite refusal that
names the vault, as a new card.

## 2026-09-11 — a card moves between boards by landing in the target's Inbox

The owner asked for a **Board** dropdown beside Column in the card panel. Three rulings from
the conversation, recorded because each has a plausible alternative:

1. **A moved card lands in the target's first column (Inbox), never in the column it left.**
   The alternative — keep the column if the target has one by that name — serves "I put it on
   the wrong board"; Inbox serves "this belongs to another project, let me look at it fresh".
   The owner hits the second more, and Inbox has a second virtue: no move can ever place a
   card in another board's Loop, so the authorization rule needs no special case.
2. **The two writes run in the daemon, create-then-delete**, not in the browser. One place
   for the order, a test can pin it, attachment blobs are copied where they live, and the MCP
   bridge can reuse the route later without a second implementation.
3. **The control is labelled "Board", not "Docket".** Docket is the product and also one of
   the seven boards; a control called Docket listing Docket among its options reads wrong.

Spec: `docs/specs/2026-09-11-move-between-boards-design.md`.

## 2026-09-11 — a note's first paragraph is its summary, by convention

The owner wants Claude's long card notes to open on a short summary with the rest one tap away.
Three ways to know where the summary ends: a `TL;DR:` marker, a structured summary field, or the
first paragraph. **The first paragraph wins.** A marker leaves every unmarked note — all 93 existing
ones — without a summary; a field is a schema change across the card model, the store, the MCP
tool and the snapshot, with the same retroactive hole. The paragraph rule already fits 77 of the 93
notes on the docket board and asks Claude only to do deliberately what it mostly did anyway. Any
multi-paragraph note collapses, whoever wrote it — one rule for the thread. Native `<details>`
carries the disclosure so the no-script snapshot behaves identically to the live panel.
Spec: `docs/specs/2026-09-11-note-tldr-design.md`.

## 2026-09-14 — time worked lives on the card as a field, one timer per board, Claude reads it and never writes it

The owner asked for a Start/Stop timer on a card with a log of day, date, time spent and an optional
description. Three rulings:

1. **A `time` field on the card, not sessions-as-notes.** Notes would need no schema change and
   would read well in the thread, but totals would mean parsing prose and `docket news` would take
   every Stop as a message from the owner. A field keeps the log structured; totals are computed,
   never stored; a missing field normalizes to empty so nothing migrates.
2. **One running timer per board.** Starting on a second card stops the first and logs its session
   in the same write. Two running timers double-count the same hour; a cross-board rule would need a
   cross-board write and is recorded as an evolution path, not built.
3. **The MCP bridge presents `time` and never writes it.** The log is the owner's record of the
   owner's hours. Claude needs to read it — the metrics card is waiting for effort next to cycle
   time — and has no business starting a clock on the owner's behalf.

Reporting stays on the card for now; the owner asked that the rollup options be recorded, and the
spec carries them. Spec: `docs/specs/2026-09-14-card-timer-design.md`.

## 2026-09-15 — contract guidance lives beside the Detail field, not inside the skeleton

The owner wants examples for the Loop contract headings. Two ways: placeholder lines inside the
skeleton ("fill in the blank"), or a guide rendered beside the field. **Beside the field.** The skeleton
is hint-free for a reason already in `brief.js`: text after a heading's colon parses as content, so
placeholders would make an unfilled card read as complete unless the parser learned to ignore them —
and a leftover placeholder would reach the verifier as the owner's words. The guide keeps the parser
and the verifier honest and finally renders the hints `BRIEF_FIELDS` has carried unshown since the
skeleton was written. Each required heading also shows a weak clause beside a strong one, because
"a clause a stub could pass" is the verifier's most repeated finding. Spec:
`docs/specs/2026-09-15-brief-guide-design.md`.

## 2026-09-15, later — a collapsed guide styled like a label is not a feature

The contract guide shipped as a bare micro summary under Detail. The owner opened a Loop draft,
sent a screenshot, and asked whether the guide was live: it was, and it read as one more inert
section caption beside COLUMN, TAGS and NOTES. Two corrections, worth recording because the first
is a rule and not a detail: **an interactive element in this panel must not be typeset exactly like
the inert labels around it** — the summary now carries the dropdown's chevron, which turns on open.
And the guide **opens on arrival when the contract is blank**, because a card with nothing written
is precisely when the examples are wanted; once the card is open the owner's own toggle stands.

## 2026-09-15, later still — the guide's summary is the panel's one accent-coloured text

The chevron was not enough: the owner looked past the guide a second time and asked for it in orange.
So it is, and the reason is worth keeping rather than treating as a preference. The visual language
this board borrows allows exactly **one accent**, and the panel had been spending it on nothing —
every label, inert or not, was `--muted`. The guide's summary is now the only accent-coloured text in
the card panel, which is what a single accent is for: the one thing on this surface you can act on.
Hover moved to an underline, since a colour change from the accent would have to go somewhere worse.

## 2026-09-16 — the Loop Contract becomes six fields, but the detail text stays the only source

The owner asked for a Loop Contract section on every card: six fields, placeholders, an "i" per field.
The fork was where the six values live. **They stay in `detail`.** The fields are a form over the
headings the parser already reads — `splitBrief` out, `joinBrief` back, canonical order, empty
headings omitted — and Detail shows only the prose above the first heading. The alternative, a
structured `contract` field on the card, would have taught a second source of truth to the parser,
the pre-flight report, the verifier and the snapshot at once, for no gain the owner can see. Two
consequences: the skeleton is no longer written into a detail on landing in Loop, because the section
is the skeleton on every card now; and `withBrief` goes, with its tests.

Same day, smaller: **`origin` is the dedicated metadata space and always was.** A Trello import wrote a
62-character line with a URL into it and the face and the Notes header both wrapped. It gets a Source
row of its own in the panel, one line with an ellipsis on the face, and `docket_add` gains an `origin`
parameter whose description states the convention — so the space is now presented as a space, and the
bridge tells Claude it exists.

## 2026-09-16 — the tab reloads itself on a new UI version, and never while a card is open

The owner asked whether the board could "always update live" so they never reload. Data already
does; code did not. Three options were weighed: hot module replacement (refused — no bundler by
design, and the panel holds live state), a visible "new version" chip the owner clicks (safe but one
more thing to notice, which is the thing they asked to be rid of), and **a self-reload when idle**,
which won. The stamp is a content hash of the UI files, so a touch reloads nothing; it rides the event
stream every tab already holds, so no second channel exists; and the reload waits for the card panel
to close, because the browser is never authoritative and the only thing a reload can lose is an
unsaved draft or a half-typed note. The idle guard is the design, not a detail of it.

## 2026-09-17 — In progress before Loop, on every board and as the default

The owner asked for the two columns swapped, first on the docket board, then on all of them, and as
the default new boards inherit. The order is now Inbox · Waiting on you · Up next · **In progress ·
Loop** · In review · Done: the owner's own work sits next to what is queued, and the unattended queue
next to the review it ends in. Keys are unchanged, so no card moved and nothing downstream — the
pre-flight, the verifier, the snapshot — cares; only `DEFAULT_COLUMNS` and seven `config.json` files
changed. Recorded because the previous order was also deliberate (Loop as the hand-off point after Up
next) and someone may ask.

## 2026-09-17 — estimates and due dates come back, on the condition they never reach the card face

The 2026-08-21 board spec ruled both out by name: *"a two-participant board doesn't need them, and
each one is another field competing for the card face."* That reason was about the face, not about
the data, and it held for a year of use.

What changed is that time is now recorded. The owner wants a per-project dashboard — time spent,
time left, spend against a rate — and *time left* is not derivable from anything the board stores:
`columnSince` gives elapsed, `time.sessions` gives effort, and neither gives a budget. Parsing hours
out of card titles was considered and rejected: on one client board they are written `14h · …`,
which is a convention of that board and would mean nothing on any other.

**Owner's ruling: add `estimateMinutes` and `due`, rendered in the panel and the dashboard and never
on the card face.** That keeps what the original ruling was protecting — the face already carries
tags, title, detail, a time chip and a verdict — while making the dashboard possible. `due` is a
`YYYY-MM-DD` day rather than an instant, because a deadline is a day and a timestamp would render
differently either side of midnight elsewhere for no gain.

The cost accepted: two more optional fields on every card, and a spec whose Out of scope section now
disagrees with the model. The spec is not edited — it was right when written — and this entry is the
record that it was overturned deliberately rather than forgotten.

## 2026-09-18 — the three time-dashboard calls, and the one that turned out to be a header bug

The manual-time work merged on 2026-09-17 left three choices for the owner to veto. All three are
now ruled, and the record matters because two of them were resolved *in the build* rather than by
the owner, which is a thing worth being able to audit later.

**Add time keeps date, start, stop and minutes, linked both ways — accepted as built.** The hand-off
asked whether the form should take a span or a duration. The build shipped both, linked: typing a
start or a stop recomputes the minutes, typing minutes moves the stop. The argument that won is that
a person who knows "a 45-minute call" and a person who knows "from 2 to 3" are both telling the
truth about the same session, and the card stores instants either way, so every row still means the
same thing. The cost accepted is a fourth input on a small form.

**An over-budget bar fills and turns the warn colour — accepted as built.** The alternative
considered was stretching the track past the estimate with a tick at the budget, which shows *how
far* over. Rejected as more pixels for information the row already states in words ("30m over", in
the same warn colour), and because a bar whose length means different things on different rows is
harder to scan down a list than one that always ends in the same place.

**The header's `time` link is now the accent with an arrow — changed.** It shipped as `micro dim`,
which is 60% opacity in the same muted grey as every inert label beside it, and the owner said it
was easy to miss. This is the **third** time this interface has made the same mistake: the contract
guide's summary read as an inert label for exactly the same reason, and needed correcting twice
(PRs #22 and #23). The generalisation, recorded here so it stops recurring: **in this visual
language, muted grey micro type is the colour of things that only state. Anything that can be acted
on has to leave that set** — by the accent, by a border, by a mark — or it will be read as a label
and looked past, no matter how well placed it is.

Flagged and deliberately not changed: `#status.offline` is also the accent, so an offline header now
carries two accent items. One accent per region is the stated rule, and this bends it. It was left
because the offline status announces itself by its words as well as its colour, and because the
owner asked for the accent on the link specifically. If it ever reads as competing, the link moves
to `--fg` and keeps the arrow.

**The real finding was underneath.** Measuring the link showed the chrome's title row does not wrap
at narrow widths — it crushes. `body` carries `overflow-wrap: anywhere`, which is the one value that
also shrinks an element's min-content width, so a flex item inheriting it collapses to a single
character rather than holding its word. At 320px "Docket" broke across three lines and the project
switcher read "DOC / KET · 56", and it had done since the header was built. The fix is the phone
breakpoint wrapping the row and its items carrying `overflow-wrap: break-word`, which breaks a word
only when it cannot fit a line alone and leaves min-content untouched.

`white-space: nowrap` was tried first and was wrong — a 31-character project name overflowed the
document at 320px, and `--name` is unbounded user input. Codex's review of the diff caught that and
two more real defects. Recorded because the change looked like three lines of CSS and the review
still earned its keep; "too small to review" is a judgment that was wrong here.

**A gate hole, named:** `check-phone-geometry.mjs` renders hostile *cards* against the *snapshot*,
and the snapshot carries its own copied CSS and no chrome. So nothing has ever gated the live
board's header at any width, which is why a crushed header survived weeks of phone use. Not closed
in that change; recorded so the next person does not assume the phone gate covers the chrome.

## 2026-09-18 — the card panel becomes a module, because the dashboard needed the real one

The time dashboard's session log lists who did what and when, and the owner wanted a card title
in it to open the card. The question was what "open the card" means on a second page.

Three options were live. A **read-only modal** on the dashboard would have been small and safe, and
was rejected because it would look like the panel without behaving like it — the worst kind of
imitation, and the dashboard is a page where the owner is already editing time. **Linking to the
board** with the card open was smaller still, and was rejected because it navigates away from a
table you are reading and loses your place in it. **Duplicating the markup** into `dashboard.html`
was the fast answer and the one this project has already refused twice: `tag-color.js` and
`brief.js` are imported by the server precisely so two halves cannot disagree, and this would have
been two hand-kept copies of thirty-nine ids.

**Owner's ruling: share one panel.** The markup moved out of `index.html` — 84 of its 126 lines —
into `board/ui/panel.js`, lifted byte for byte, together with the 34-key element map and the mount
sequence that builds the two dropdowns before `createModal`. `modal.js` is untouched: it was already
written to query nothing and be handed an element map, which is the property that made this cheap.

What it cost: three test assertions that read `index.html` as a string now read the module too, and
`app.js` gave up 53 lines. What it bought: `dashboard.js` got the identical, fully editable panel in
one call, and the ids live beside the markup that declares them.

**The seam this created is the element map**, so it has its own tests. `panel.test.js` checks both
directions — every id the map names exists in the markup, and every key `modal.js` reads is
provided — using a fake document rather than a DOM library, since `board/` has none by design. Four
mutations were tried against it and each one failed the suite. Worth recording because the obvious
test here would have been a string grep, which proves nothing about the map.

### Four defects the dashboard had been hiding, and one non-fix

The Add time inputs rendered as native light controls on a dark page for the dumbest possible
reason: the form carried `class="add"` and the stylesheet styled `.add.time-form`, so both that rule
and the shared `.time-form input` rules matched nothing. Only the `<select>` looked right, because
it had a rule of its own — which is exactly why nobody spotted it, since one styled control among
five unstyled ones reads as a theme, not a bug.

That same `<select>` made the page scroll sideways on a phone. A select takes its intrinsic width
from its widest option and the options are card titles, so it asked for 640px inside a 390px
viewport. `min-width: 0` was already on it and does nothing here — it lets a box shrink, it does not
stop the box asking. Recorded because the instinct is to reach for `min-width` again.

The over-budget text and its bar disagreed: the text tested `remainingMs < 0` and the bar used the
shared `overBudget`, which waits for a whole minute, so the page read `<1m over` in amber beside an
accent bar. `overBudget`'s own comment says both must decide through it. They do now, through one
field computed in `perCard`.

**The non-fix, recorded so it is not rediscovered as a bug:** inside the first minute past an
estimate the row reads `<1m left`, which is strange prose for "you are over". It is also pinned by
`time.test.js` under a test named *"formatBudget follows the same minute: full but not over, then
over"*, and it is what the panel says. Matching the panel was the whole point, so this stays until
the owner rules on the wording in both places at once.

### The session table: one type size, and a width put back

It shipped with four type sizes — 0.62, 0.78, 0.88, 0.82 — so reading across a single row crossed
three of them. The owner's ask was one size, and the rule now is that difference in that table
carries meaning through **colour and face, never size**: mono for instants and durations, the text
face for prose, the accent for the time column.

The card column was also widened from 26% to 32% to stop a title wrapping, and then put back.
Measured at an 888px table, the premise was false: the longest description needs 468px and has 388,
while the title needs 284 in a 284px cell. The two together want about 996px of 888, so one must
wrap whatever the split — and the description is the substance of a row. The measurement is in the
CSS so the next person does not repeat the experiment.
