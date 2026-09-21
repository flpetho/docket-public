import { test } from 'node:test'
import assert from 'node:assert/strict'

import { handleUpdate } from '../src/handler.js'
import { fakeInbox, fakeTelegram } from './fakes.js'

const OWNER = 555
const at = () => new Date('2026-08-21T15:04:12.000Z')

const textUpdate = (text, chatId = OWNER, updateId = 4823) => ({
  update_id: updateId,
  message: { message_id: 1, chat: { id: chatId }, text },
})

test('a text note is written to captures/unfiled with frontmatter', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(textUpdate('Check OCR for dropped documents'), {
    inbox,
    telegram,
    ownerChatId: OWNER,
    now: at,
  })

  const path = 'captures/unfiled/2026-08-21T15-04-12Z-4823.md'
  assert.ok(path in inbox.files, `expected ${path}, got ${Object.keys(inbox.files)}`)
  assert.match(inbox.files[path], /^---\nid: 4823\nbucket: unfiled\n/)
  assert.match(inbox.files[path], /Check OCR for dropped documents/)
})

test('the reply echoes the first line and offers every bucket', async () => {
  const inbox = fakeInbox({ buckets: ['atlas', 'ideas', 'personal'] })
  const telegram = fakeTelegram()
  await handleUpdate(textUpdate('First line\nsecond line'), {
    inbox,
    telegram,
    ownerChatId: OWNER,
    now: at,
  })

  const [method, chatId, text, extra] = telegram.calls.at(-1)
  assert.equal(method, 'sendMessage')
  assert.equal(chatId, OWNER)
  assert.match(text, /First line/)
  assert.doesNotMatch(text, /second line/)
  const labels = extra.reply_markup.inline_keyboard.flat().map((b) => b.text)
  assert.deepEqual(labels, ['atlas', 'ideas', 'personal'])
})

test('callback data stays under Telegram 64-byte cap and carries update id', async () => {
  const inbox = fakeInbox({ buckets: ['atlas', 'ideas'] })
  const telegram = fakeTelegram()
  await handleUpdate(textUpdate('x'), { inbox, telegram, ownerChatId: OWNER, now: at })

  for (const button of telegram.calls.at(-1)[3].reply_markup.inline_keyboard.flat()) {
    assert.ok(Buffer.byteLength(button.callback_data) < 64, button.callback_data)
    assert.match(button.callback_data, /^4823:\d+$/)
  }
})

test('the file is written before the reply is sent, so a note is never lost', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(textUpdate('x'), { inbox, telegram, ownerChatId: OWNER, now: at })
  assert.equal(inbox.calls[0][0], 'putFile')
})

test('a foreign chat is refused and nothing is written', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(textUpdate('hello', 999), { inbox, telegram, ownerChatId: OWNER, now: at })

  assert.deepEqual(Object.keys(inbox.files), [])
  assert.equal(telegram.calls.length, 1)
  assert.equal(telegram.calls[0][0], 'sendMessage')
  assert.equal(telegram.calls[0][1], 999)
  assert.match(telegram.calls[0][2], /private/i)
})

test('a non-text message says so rather than dropping silently', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(
    { update_id: 1, message: { message_id: 1, chat: { id: OWNER }, photo: [{}] } },
    { inbox, telegram, ownerChatId: OWNER, now: at },
  )
  assert.deepEqual(Object.keys(inbox.files), [])
  assert.match(telegram.calls[0][2], /text/i)
})

test('an update with no chat is ignored without throwing', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(
    { update_id: 1, edited_channel_post: {} },
    { inbox, telegram, ownerChatId: OWNER, now: at },
  )
  assert.equal(telegram.calls.length, 0)
})
