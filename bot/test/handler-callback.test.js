import { test } from 'node:test'
import assert from 'node:assert/strict'

import { handleUpdate } from '../src/handler.js'
import { fakeInbox, fakeTelegram } from './fakes.js'

const OWNER = 555
const UNFILED = 'captures/unfiled/2026-08-21T15-04-12Z-4823.md'

const tap = (data, chatId = OWNER) => ({
  update_id: 9,
  callback_query: {
    id: 'cb1',
    data,
    message: { message_id: 100, chat: { id: chatId }, text: '📥 Check OCR' },
  },
})

const withCapture = () => fakeInbox({ files: { [UNFILED]: 'body' }, buckets: ['atlas', 'ideas'] })

test('a tap moves the capture into the chosen bucket', async () => {
  const inbox = withCapture()
  const telegram = fakeTelegram()
  await handleUpdate(tap('4823:0'), { inbox, telegram, ownerChatId: OWNER })

  assert.equal(UNFILED in inbox.files, false)
  assert.ok('captures/atlas/2026-08-21T15-04-12Z-4823.md' in inbox.files)
})

test('the callback is answered first, so the phone stops spinning', async () => {
  const inbox = withCapture()
  const telegram = fakeTelegram()
  await handleUpdate(tap('4823:1'), { inbox, telegram, ownerChatId: OWNER })
  assert.equal(telegram.calls[0][0], 'answerCallbackQuery')
  assert.equal(telegram.calls[0][1], 'cb1')
})

test('the message is edited to show the destination and loses its buttons', async () => {
  const inbox = withCapture()
  const telegram = fakeTelegram()
  await handleUpdate(tap('4823:1'), { inbox, telegram, ownerChatId: OWNER })

  const edit = telegram.calls.find((c) => c[0] === 'editMessageText')
  assert.equal(edit[1], OWNER)
  assert.equal(edit[2], 100)
  assert.match(edit[3], /Check OCR/)
  assert.match(edit[3], /→ ideas ✓/)
  assert.equal(edit[4], undefined)
})

test('a second tap reports it is already filed instead of erroring', async () => {
  const inbox = fakeInbox({ files: {}, buckets: ['atlas', 'ideas'] })
  const telegram = fakeTelegram()
  await handleUpdate(tap('4823:0'), { inbox, telegram, ownerChatId: OWNER })

  const edit = telegram.calls.find((c) => c[0] === 'editMessageText')
  assert.match(edit[3], /already filed/i)
  assert.equal(
    inbox.calls.some((c) => c[0] === 'move'),
    false,
  )
})

test('an out-of-range bucket index is reported, not guessed', async () => {
  const inbox = withCapture()
  const telegram = fakeTelegram()
  await handleUpdate(tap('4823:99'), { inbox, telegram, ownerChatId: OWNER })

  const edit = telegram.calls.find((c) => c[0] === 'editMessageText')
  assert.match(edit[3], /unknown bucket/i)
  assert.ok(UNFILED in inbox.files)
})

test('a tap from a foreign chat is refused and moves nothing', async () => {
  const inbox = withCapture()
  const telegram = fakeTelegram()
  await handleUpdate(tap('4823:0', 999), { inbox, telegram, ownerChatId: OWNER })

  assert.ok(UNFILED in inbox.files)
  assert.equal(telegram.calls[0][0], 'sendMessage')
  assert.match(telegram.calls[0][2], /private/i)
})
