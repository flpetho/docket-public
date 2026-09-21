# Capture pipe — phone thoughts into the workflow

**2026-08-21.** Owner request: a way to capture thoughts from the phone that works for atlas
*and* for other projects and unattached ideas, with a two-way conversation about the inputs.
Companion to `2026-08-21-board-design.md`; **this gets built first**, because it is the piece
currently missing (nothing on the phone reaches Claude today) and it does not depend on Docket
existing.

Owner decisions taken during the brainstorm: **Telegram bot** rather than a PWA (the two-way
conversation is the point, and Telegram supplies the whole conversational surface — push both
directions, offline queueing, dictation via the phone keyboard); **v1 is the deterministic pipe
only**, with AI replies deferred until the pipe has been used for a few days; the existing
Obsidian note gets pasted into chat once rather than read from the vault.

## The distinction that shapes everything

**Capture is an inbox, not the board.** Putting the board in the cloud so a phone could edit it
would cost everything the Docket design buys — state in the repo, travelling with a clone, diffing
in git, working when the network doesn't — to solve a problem the owner does not have. Nobody wants
to drag cards on a phone. They want to dump a thought and stop carrying it.

So the cloud half is **append-only and never authoritative for anything.** It is a mailbox. If it
vanished, the loss would be unfiled notes, not boards. That asymmetry is what makes it safe to put
on the internet.

```
PHONE                  VERCEL                      GITHUB                  MAC
Telegram message   →   webhook function       →    docket-inbox repo   →   git pull
                       verify · file · reply       one file per capture     Claude triages
                                                                           ↓
                                                   file moves to filed/ ← card created
```

## Why a repo and not a database

Supabase was the earlier recommendation, and it was carrying the PWA's weight. With Telegram as the
surface, a database is the wrong shape for append-only text notes read by an agent that has a
filesystem. A private GitHub repo gives:

- **One service total** (a Vercel function). No database, and nothing that pauses on a free tier.
- **No write conflicts, ever** — one file per capture, so concurrent notes cannot collide.
- **Idempotency for free** — Telegram retries webhooks on any non-200, and the `update_id` is part
  of the filename, so a duplicate delivery overwrites the identical file.
- **A drain that is `git pull`** — captures become files Claude reads with the tools it already
  has, versioned, greppable, diffable.
- **Filing that documents itself** — a capture becoming a card is a git move into `filed/`.

It also matches the philosophy Docket commits to: state lives in repos.

## Components

### 1. `docket-inbox` — private GitHub repo, the mailbox

```
buckets.json                                    ["atlas","ferencpetho","ideas","personal"]
captures/unfiled/2026-08-21T15-04-12Z-4823.md   awaiting a bucket tap
captures/atlas/2026-08-21T15-04-12Z-4821.md filed to a bucket, not yet a card
filed/atlas/2026-08-20T09-11-02Z-4801.md    became a card
```

Each capture is frontmatter plus body:

```markdown
---
id: 4823
bucket: atlas
at: 2026-08-21T15:04:12Z
source: telegram
---

Record search is overwhelming for new users — what if the canvas organised
what search found instead of being the query builder?
```

`buckets.json` lives in the repo rather than the function's environment, so adding a bucket needs a
commit, not a redeploy. The function caches it for 60 seconds.

Filenames are the capture's UTC instant with colons replaced by dashes, then the `update_id`:
`2026-08-21T15-04-12Z-4823.md`. Colons are legal on the API but miserable in a shell.

### 2. `docket-bot` — private GitHub repo, deployed to Vercel

A single serverless function, `api/telegram.ts`. Separate repo from the inbox so a capture commit
never triggers a redeploy.

**On every request, in order:**

1. Compare the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`.
   Mismatch → 401, nothing else happens.
2. Compare the chat id against `OWNER_CHAT_ID`. Mismatch → a flat refusal and stop. Without this,
   anyone who finds the bot can write to the inbox.
3. Dispatch on the update type.

| Update | Behavior |
|---|---|
| Text message | Commit to `captures/unfiled/<ts>-<update_id>.md` **first**, then reply with the note's first line and an inline keyboard of buckets. Writing before asking is deliberate — a note is never lost waiting for a tap |
| Callback query (bucket tap) | Move the file to `captures/<bucket>/` (create at the new path, delete the old) and edit the original message to read `→ atlas ✓`, so the chat log shows where each note went |
| `/list` | The ten most recent captures not under `filed/`, grouped by bucket |
| `/help` | The three commands and the bucket list |
| Anything else | A short "text notes only for now" — no silent drops |

Returns 200 on every handled case, including refusals, so Telegram stops retrying. A genuine
failure returns 500 and Telegram's retry becomes the recovery path — safe, because a retried text
message rewrites the identical path.

**Callback routing.** Telegram caps `callback_data` at 64 bytes, which is not enough for a file
path, so a button carries `<update_id>:<bucket index>`. The function finds the capture by matching
`captures/unfiled/*-<update_id>.md`. If nothing matches — a double tap, or a bucket already
chosen — it edits the message to show where the note actually is rather than reporting an error.

### 3. `docket tell` — Claude to phone

A ~20-line script posting to `sendMessage`, so a session can end with the phone buzzing: *"chunk 12
merged, ready for review."* This is the half of "two-way" that needs no AI anywhere and delivers
most of the value. Lives in the Docket repo once it exists; standalone until then.

### 4. The drain

For v1, manual and honest: `git pull` in `docket-inbox`, read the unfiled and bucketed captures,
turn the ones that deserve it into cards, and `git mv` those into `filed/` with a commit. When
Docket's daemon lands, it takes over the pull and card creation; the file layout does not change,
so nothing here is rework.

## Secrets

| Secret | Where |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Vercel env; and `~/.zshrc` for `docket tell` |
| `TELEGRAM_WEBHOOK_SECRET` | Vercel env; passed once to `setWebhook` |
| `OWNER_CHAT_ID` | Vercel env; and `~/.zshrc` |
| `GITHUB_TOKEN` | Vercel env — fine-grained PAT, `contents:write` on `docket-inbox` only |

Never committed, never logged, never echoed into a reply. Note the project's standing caveat: a
non-interactive shell does not source `~/.zshrc`, so anything invoking `docket tell` must export
the values first — the same trap `CLAUDE.md` records for `OPENAI_API_KEY`.

## Owner setup steps

Three things Claude cannot do:

1. **Create the bot.** Message `@BotFather` on Telegram → `/newbot` → pick a name and username →
   it returns the token. Paste the token into chat.
2. **Get the chat id.** Send the new bot any message, then Claude reads it back from `getUpdates`
   and records the id. No third-party "get my id" bot required. **This must happen before
   `setWebhook`** — Telegram refuses `getUpdates` while a webhook is registered, so doing it in the
   other order means deleting the webhook to recover.
3. **Deploy.** Link `docket-bot` to Vercel and set the four environment variables — the dashboard,
   or `npx vercel` (the CLI is not installed on this machine).

Claude does the rest: both repos, the function, the tests, `setWebhook`, and `docket tell`.

## Verification

| Layer | How |
|---|---|
| Handlers | `node --test` against fixture Telegram payloads: text message writes the expected path, callback query moves the file, a duplicate `update_id` produces the identical path, a wrong secret returns 401 without touching GitHub, a foreign chat id is refused, an unknown update type replies rather than dropping |
| GitHub writes | `node --test` with the GitHub client faked: correct paths, correct frontmatter, `filed/` move is create-then-delete in that order (so a crash mid-move duplicates rather than loses) |
| End to end | The owner sends a note from the phone; the file is confirmed in `docket-inbox`; a bucket tap is confirmed to move it. Not fakeable, and it is the real acceptance test |
| `docket tell` | The owner confirms the message arrives on the phone |

## Known risks

- **Notes live in Telegram's cloud.** A bot chat has no end-to-end option, so unreleased
  work product thinking will sit with a foreign-jurisdiction third party. Raised twice
  during the brainstorm and accepted by the owner; recorded here so the decision is visible rather
  than assumed.
- **Vercel free tier** is ample for a personal webhook, but a cold start adds a second or two to
  the confirmation reply. Acceptable for a capture tool.
- **The drain needs the Mac.** Captures accumulate safely in the repo and land whenever Claude next
  pulls, so nothing is lost — but "I typed it on the train" and "it is on the board" are not the
  same moment, by design.

## Out of scope for v1

- **AI replies.** Deferred by owner decision until the pipe has real use. When it lands, the
  natural shape is a scheduled agent draining new captures and replying with substance ("that OCR
  idea overlaps chunk 12 — merge them?"). Nothing in v1 blocks it.
- **Photos and voice.** A photographed document is squarely on the atlas thesis and Telegram
  delivers both, but neither was asked for. Text only, so v1 stays small.
- **A PWA.** Still a reasonable second front end onto the same repo later; Telegram earns its place
  first.
- **Editing or deleting a capture from the phone.** Captures are append-only. Wrong notes get
  triaged into nothing at the desk.
