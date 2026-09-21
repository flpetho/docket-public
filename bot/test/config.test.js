import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readConfig } from '../src/config.js'

const good = {
  TELEGRAM_BOT_TOKEN: 'tok',
  TELEGRAM_WEBHOOK_SECRET: 'sec',
  OWNER_CHAT_ID: '12345',
  GITHUB_TOKEN: 'gh',
  INBOX_REPO: 'someone/docket-inbox',
}

test('reads a complete environment', () => {
  const cfg = readConfig(good)
  assert.equal(cfg.botToken, 'tok')
  assert.equal(cfg.webhookSecret, 'sec')
  assert.equal(cfg.ownerChatId, 12345)
  assert.equal(cfg.githubToken, 'gh')
  assert.equal(cfg.inboxRepo, 'someone/docket-inbox')
})

test('names every missing variable', () => {
  assert.throws(
    () => readConfig({ TELEGRAM_BOT_TOKEN: 'tok' }),
    (e) => {
      assert.match(e.message, /TELEGRAM_WEBHOOK_SECRET/)
      assert.match(e.message, /OWNER_CHAT_ID/)
      assert.match(e.message, /GITHUB_TOKEN/)
      assert.match(e.message, /INBOX_REPO/)
      return true
    },
  )
})

test('rejects a non-numeric chat id', () => {
  assert.throws(() => readConfig({ ...good, OWNER_CHAT_ID: 'nope' }), /OWNER_CHAT_ID/)
})

test('never puts a secret value in the error', () => {
  assert.throws(
    () => readConfig({ ...good, OWNER_CHAT_ID: 'nope' }),
    (e) => {
      assert.doesNotMatch(e.message, /tok|sec|gh/)
      return true
    },
  )
})
