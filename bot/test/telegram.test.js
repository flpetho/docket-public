import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTelegram } from '../src/telegram.js'

function fakeFetch(reply = { ok: true, result: { message_id: 7 } }, status = 200) {
  const seen = []
  const f = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) })
    return { ok: status < 400, status, json: async () => reply }
  }
  f.seen = seen
  return f
}

test('sendMessage posts chat_id and text and returns the result', async () => {
  const f = fakeFetch()
  const t = createTelegram({ token: 'SECRET-TOKEN', fetch: f })
  const result = await t.sendMessage(42, 'hello', { reply_markup: { inline_keyboard: [] } })
  assert.equal(result.message_id, 7)
  assert.match(f.seen[0].url, /\/sendMessage$/)
  assert.equal(f.seen[0].body.chat_id, 42)
  assert.equal(f.seen[0].body.text, 'hello')
  assert.deepEqual(f.seen[0].body.reply_markup, { inline_keyboard: [] })
})

test('editMessageText carries the message id', async () => {
  const f = fakeFetch()
  await createTelegram({ token: 'x', fetch: f }).editMessageText(42, 9, 'edited')
  assert.equal(f.seen[0].body.message_id, 9)
  assert.equal(f.seen[0].body.text, 'edited')
})

test('answerCallbackQuery omits text when none is given', async () => {
  const f = fakeFetch()
  await createTelegram({ token: 'x', fetch: f }).answerCallbackQuery('cb1')
  assert.equal(f.seen[0].body.callback_query_id, 'cb1')
  assert.equal('text' in f.seen[0].body, false)
})

test('an API error throws without leaking the token', async () => {
  const t = createTelegram({
    token: 'SECRET-TOKEN',
    fetch: fakeFetch({ ok: false, description: 'chat not found' }, 400),
  })
  await assert.rejects(
    () => t.sendMessage(1, 'x'),
    (e) => {
      assert.match(e.message, /sendMessage/)
      assert.doesNotMatch(e.message, /SECRET-TOKEN/)
      return true
    },
  )
})

test('a 200 carrying ok:false is still an error', async () => {
  const t = createTelegram({ token: 'x', fetch: fakeFetch({ ok: false, description: 'nope' }, 200) })
  await assert.rejects(() => t.sendMessage(1, 'x'), /sendMessage/)
})
