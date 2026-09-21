# docket-bot

The Telegram capture bot. A message becomes one file in the private
`docket-inbox` repo; one tap files it into a bucket.

Design: `../docs/specs/2026-08-21-capture-pipe-design.md`
Plan: `../docs/plans/2026-08-21-capture-pipe.md`

## Layout

| Path | Responsibility |
|---|---|
| `api/telegram.js` | Vercel entry: secret check, dependency construction, status contract |
| `src/handler.js` | Pure dispatcher — capture, bucket tap, commands. All I/O injected |
| `src/inbox.js` | The inbox repo over the GitHub Contents API |
| `src/telegram.js` | The three Bot API methods v1 uses |
| `src/capture.js` | Filenames, frontmatter, parsing. No I/O |
| `src/config.js` | Environment validation |
| `scripts/set-webhook.js` | One-shot webhook registration |
| `scripts/tell.js` | Claude → phone |

## Environment

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_CHAT_ID`, `GITHUB_TOKEN`
(fine-grained PAT, `contents:write` on `docket-inbox` only), `INBOX_REPO`.

`scripts/tell.js` additionally needs `TELEGRAM_CHAT_ID`.

A non-interactive shell does not source `~/.zshrc`, so export before use:

    export TELEGRAM_BOT_TOKEN=$(grep -oE 'TELEGRAM_BOT_TOKEN="[^"]+"' ~/.zshrc | head -1 | cut -d'"' -f2)

## Tests

    npm test

Zero dependencies — `node:test` and `node:assert/strict`, with `fetch` injected
and faked. No network call in the suite.

## Status contract

The webhook returns 200 on every handled case **including refusals**, so Telegram
stops retrying; 401 on a bad secret; 405 on a non-POST; 500 only on genuine
failure, where Telegram's own retry is the recovery path. A retried capture is
safe because the filename carries the `update_id` and `putFile` reads the
existing SHA before writing.
