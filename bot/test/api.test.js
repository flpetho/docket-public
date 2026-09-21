import { test } from 'node:test'
import assert from 'node:assert/strict'

import handler from '../api/telegram.js'
import { fakeInbox, fakeTelegram } from './fakes.js'

const ENV = {
  TELEGRAM_BOT_TOKEN: 'tok',
  TELEGRAM_WEBHOOK_SECRET: 'sec',
  OWNER_CHAT_ID: '555',
  GITHUB_TOKEN: 'gh',
  INBOX_REPO: 'o/r',
}

function fakeRes() {
  const res = { code: null, body: null }
  res.status = (c) => {
    res.code = c
    return res
  }
  res.json = (b) => {
    res.body = b
    return res
  }
  return res
}

const req = (over = {}) => ({
  method: 'POST',
  headers: { 'x-telegram-bot-api-secret-token': 'sec' },
  body: { update_id: 1, message: { message_id: 1, chat: { id: 555 }, text: 'note' } },
  ...over,
})

const deps = () => ({ inbox: fakeInbox(), telegram: fakeTelegram() })

test('a valid update is handled and answered 200', async () => {
  const res = fakeRes()
  await handler(req(), res, { env: ENV, ...deps() })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { ok: true })
})

test('a wrong secret is 401 and nothing is written', async () => {
  const res = fakeRes()
  const d = deps()
  await handler(req({ headers: { 'x-telegram-bot-api-secret-token': 'wrong' } }), res, {
    env: ENV,
    ...d,
  })
  assert.equal(res.code, 401)
  assert.deepEqual(Object.keys(d.inbox.files), [])
})

test('a missing secret header is 401', async () => {
  const res = fakeRes()
  await handler(req({ headers: {} }), res, { env: ENV, ...deps() })
  assert.equal(res.code, 401)
})

test('a non-POST is 405', async () => {
  const res = fakeRes()
  await handler(req({ method: 'GET' }), res, { env: ENV, ...deps() })
  assert.equal(res.code, 405)
})

test('a misconfigured environment is 500 and never echoes a value', async () => {
  const res = fakeRes()
  await handler(req(), res, { env: { TELEGRAM_BOT_TOKEN: 'tok' }, ...deps() })
  assert.equal(res.code, 500)
  assert.doesNotMatch(JSON.stringify(res.body), /tok/)
})

test('a refused foreign chat is still 200, so Telegram stops retrying', async () => {
  const res = fakeRes()
  await handler(
    req({ body: { update_id: 1, message: { message_id: 1, chat: { id: 999 }, text: 'x' } } }),
    res,
    { env: ENV, ...deps() },
  )
  assert.equal(res.code, 200)
})

test('a handler failure is 500 so the Telegram retry can recover it', async () => {
  const res = fakeRes()
  const inbox = fakeInbox()
  inbox.putFile = async () => {
    throw new Error('github down')
  }
  await handler(req(), res, { env: ENV, inbox, telegram: fakeTelegram() })
  assert.equal(res.code, 500)
})

test('the response body never contains the capture text', async () => {
  const res = fakeRes()
  await handler(
    req({
      body: { update_id: 1, message: { message_id: 1, chat: { id: 555 }, text: 'secret thought' } },
    }),
    res,
    { env: ENV, ...deps() },
  )
  assert.doesNotMatch(JSON.stringify(res.body), /secret thought/)
})
