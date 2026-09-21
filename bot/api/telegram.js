import { readConfig } from '../src/config.js'
import { handleUpdate } from '../src/handler.js'
import { createInbox } from '../src/inbox.js'
import { createTelegram } from '../src/telegram.js'

// Built once per warm container so the bucket cache survives between invocations.
let cached = null

function buildDeps(env) {
  if (cached && cached.env === env) return cached
  const cfg = readConfig(env)
  cached = {
    env,
    cfg,
    inbox: createInbox({ token: cfg.githubToken, repo: cfg.inboxRepo }),
    telegram: createTelegram({ token: cfg.botToken }),
  }
  return cached
}

/**
 * The Telegram webhook. `overrides` is for tests only — production passes nothing
 * and everything resolves from process.env.
 *
 * Status contract: 200 on every handled case including refusals, so Telegram stops
 * retrying; 401 on a bad secret; 405 on a non-POST; 500 only on genuine failure,
 * where Telegram's retry becomes the recovery path.
 */
export default async function handler(req, res, overrides = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  let cfg
  let inbox
  let telegram
  try {
    const built = buildDeps(overrides.env ?? process.env)
    cfg = built.cfg
    inbox = overrides.inbox ?? built.inbox
    telegram = overrides.telegram ?? built.telegram
  } catch (error) {
    console.error('config:', error.message)
    return res.status(500).json({ error: 'misconfigured' })
  }

  if (req.headers['x-telegram-bot-api-secret-token'] !== cfg.webhookSecret) {
    return res.status(401).json({ error: 'bad secret' })
  }

  try {
    await handleUpdate(req.body, { inbox, telegram, ownerChatId: cfg.ownerChatId })
    return res.status(200).json({ ok: true })
  } catch (error) {
    // Never log req.body — it holds the owner's private note text.
    console.error('handler:', error.message)
    return res.status(500).json({ error: 'handler failed' })
  }
}
