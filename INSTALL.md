# Installing Docket

Two halves, and they are independent. **The board works on its own** — no accounts, no
tokens, no network. **The capture pipe** is the phone half, and it needs a Telegram bot, a
private repo and a free Vercel function.

Install the board first. Use it for a week. Add the pipe only if typing thoughts on a phone
is a problem you actually have.

---

## Requirements

| | |
|---|---|
| Node | 22 or newer. `node --version` |
| git | any recent version |
| OS | macOS for the always-on parts. Everything else is portable — see [Not on macOS](#not-on-macos) |

Nothing to install beyond that. `board/`, `bot/` and `web/` have **zero dependencies** and
run straight from a clone. `mcp/` is the one package with any, and it is the only one that
needs `npm install`.

---

## The board

### 1. Clone it somewhere permanent

The daemon and the tool bridge both point at absolute paths inside the clone, so moving it
later means redoing steps 3 and 4. Put it where it will stay.

```bash
git clone https://github.com/<you>/docket.git ~/docket
cd ~/docket
```

### 2. Check it runs

```bash
cd board && npm test      # 444 tests, no network, no install
```

If that passes, the board works. Nothing below can fail in a way this would not have caught,
except your own configuration.

### 3. Adopt your first project

Run this **inside a project you actually work on**, not inside the Docket clone. It writes
one directory, `.docket/`, holding the board and its config.

```bash
cd ~/code/my-project
node ~/docket/board/bin/docket.js init --name "My Project"
```

> **The name decides the slug**, and the slug is how a Telegram bucket later finds this
> board. `--name "My Project"` becomes `my-project`. If you plan to use the capture pipe,
> pick the name now and match the bucket to it exactly.

Commit `.docket/` if you want the board to travel with the repo, which is the intended
shape. It is a JSON file; it merges badly, so treat it as one person's document.

### 4. Serve it

```bash
node ~/docket/board/bin/docket.js serve     # http://localhost:7777
```

One daemon serves **every** project you adopt. It binds `127.0.0.1` only, deliberately: the
board is never exposed to your network.

To keep it running across reboots, on macOS:

```bash
node ~/docket/board/bin/docket.js install   # a LaunchAgent, restarts on crash and at login
node ~/docket/board/bin/docket.js doctor    # says whether it is loaded AND answering
```

`doctor` asks those as two separate questions on purpose. A LaunchAgent pointing at a node
binary that has moved is "loaded" and dead.

### 5. Give your coding agent the same board

This is the part that makes it shared state rather than a personal kanban. Registered at
user scope, so the tools appear in **every** project you open, present and future.

```bash
claude mcp add docket -s user -- node ~/docket/mcp/server.js
```

First install the one dependency it needs, or the server will not start:

```bash
cd ~/docket/mcp && npm install && npm test   # 34 tests
```

Then restart your agent session and confirm six tools appear. If they do not, run
`claude mcp get docket` and check the path is absolute and correct.

### 6. Teach the agent the protocol

Installing the tools gives your agent the board. It does not give it the working agreement —
the columns' meaning, what authorizes unattended work, or the rule that it never grades its
own output.

Copy [`docs/ADOPTING.md`](docs/ADOPTING.md) into each project you adopt, as that project's
`CLAUDE.md` or appended to the one it already has. It is written to be pasted.

The gate needs one more file. Copy it into each project too:

```bash
mkdir -p ~/code/my-project/.claude/agents
cp ~/docket/.claude/agents/docket-verifier.md ~/code/my-project/.claude/agents/
```

Or put it in `~/.claude/agents/` to have it everywhere at once. Without it, unattended work
has nothing grading it, which is the one rule worth not skipping.

---

## The capture pipe

Optional, and only worth it if you want to type a thought on a phone and have it become a
card without opening a laptop. Four things, in this order.

### 1. A private repo for the captures

Create an **empty private** repo. It holds notes and nothing else — never code. If it held
its own source, every capture would trigger a redeploy.

```bash
gh repo create <you>/docket-inbox --private
```

Add one file, `buckets.json`, listing the project slugs you want as one-tap destinations.
These must match the slugs from `docket init`:

```json
["my-project", "side-thing", "ideas"]
```

A capture with no bucket chosen lands in `unfiled` and waits.

### 2. A bot

1. Message **@BotFather** on Telegram and send `/newbot`. Pick a name and a username. It
   returns a token. That token is a credential — treat it like a password.
2. Send your new bot any message.
3. Get your own chat id, **before** registering a webhook:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[0-9]*' | head -1
   ```
   Telegram refuses `getUpdates` once a webhook exists, so doing this in the other order
   means deleting the webhook to recover. No third-party "what is my id" bot needed.

### 3. Deploy the function

Import this repo into Vercel as a new project with **Root Directory `bot/`**. Set five
production environment variables, production only, so no secret sits on a preview URL:

| Variable | What |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | any long random string you invent |
| `OWNER_CHAT_ID` | your chat id from step 2 |
| `GITHUB_TOKEN` | a fine-grained PAT, `contents:write` on the inbox repo **only** |
| `INBOX_REPO` | `<you>/docket-inbox` |

Then point Telegram at it:

```bash
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_WEBHOOK_SECRET=...
node bot/scripts/set-webhook.js https://<your-deployment>.vercel.app/api/telegram
```

Use the project's **permanent** domain, not a deployment-specific URL. Short aliases can
vanish, and when the webhook points at a dead URL the bot fails silently.

> **Deployment Protection must be OFF for this project.** Telegram has to POST to it. That
> is safe here because the function authenticates every request twice: a secret header, and
> a check that the sender is your chat id. Both are required, and the chat-id check is the
> one never to remove — a bot's username is public and guessable.

### 4. Drain

Captures accumulate in the inbox repo until you pull them onto a board:

```bash
export INBOX_REPO=<you>/docket-inbox
export GITHUB_TOKEN=...                    # or just be logged in with `gh auth login`
node ~/docket/board/bin/docket.js drain --dry-run   # says what it would do
node ~/docket/board/bin/docket.js drain
```

On macOS, on a timer:

```bash
node ~/docket/board/bin/docket.js install-drain --every 300
```

---

## Not on macOS

Everything works except the three installers, which write macOS LaunchAgents:
`install`, `install-drain` and `install-push`. There is no Linux or Windows path for those.

Run the equivalents yourself, or write systemd units around these three commands:

| Instead of | Run |
|---|---|
| `docket install` | `docket serve` |
| `docket install-drain` | `docket drain`, on your own timer |
| `docket install-push` | `docket push`, on your own timer |

`doctor` will report the service half as absent. Its board checks still work.

---

## Verifying the whole thing

```bash
cd board && npm test     # 444
cd ../mcp  && npm test   # 34, needs npm install first
cd ../bot  && npm test   # 55
cd ../web  && npm test   # 7
node board/bin/docket.js doctor
```

`doctor` prints every registered project, the state of each background service, and which
Telegram bucket reaches which board. A bucket with no matching project is the failure that
is otherwise invisible: captures file successfully and never become cards.

---

## Things that will bite

- **A bucket name must equal a project slug**, and the slug comes from `--name`. `--name
  "Ferenc Petho"` becomes `ferenc-petho`, which does not match a `ferencpetho` bucket.
- **A non-interactive shell does not read `~/.zshrc`.** Anything invoking the bot scripts
  from a timer or a script has to export the variables itself.
- **The board file is one person's document.** Two people editing one board through git will
  conflict on every line. That is not a bug being fixed; it is what the tool is.
- **`docket push` only ships the default branch**, and only when the only thing ahead is the
  board. An unfinished code commit on the same branch stops it, deliberately.
- **The web deployment publishes every note on the board.** It refuses to run without being
  told which board, for that reason. See [`web/README.md`](web/README.md).
