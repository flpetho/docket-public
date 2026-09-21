import { test } from 'node:test'
import assert from 'node:assert/strict'

import { handleUpdate } from '../src/handler.js'
import { fakeInbox, fakeTelegram } from './fakes.js'

const OWNER = 555
const cmd = (text) => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: OWNER }, text },
})

const body = (id, text) =>
  `---\nid: ${id}\nbucket: unfiled\nat: 2026-08-21T15:04:12.000Z\nsource: telegram\n---\n\n${text}\n`

test('/help lists the commands and the buckets', async () => {
  const inbox = fakeInbox({ buckets: ['atlas', 'ideas'] })
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/help'), { inbox, telegram, ownerChatId: OWNER })

  const text = telegram.calls[0][2]
  assert.match(text, /\/list/)
  assert.match(text, /atlas, ideas/)
})

test('/start behaves like /help so a first-time Start is not a dead end', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/start'), { inbox, telegram, ownerChatId: OWNER })
  assert.match(telegram.calls[0][2], /\/list/)
})

test('/list shows the first line of each waiting capture, newest first', async () => {
  const inbox = fakeInbox({
    files: {
      'captures/unfiled/2026-08-21T10-00-00Z-111.md': body(111, 'older note'),
      'captures/atlas/2026-08-21T12-00-00Z-222.md': body(222, 'newer note'),
    },
    buckets: ['atlas', 'ideas'],
  })
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/list'), { inbox, telegram, ownerChatId: OWNER })

  const text = telegram.calls[0][2]
  assert.ok(text.indexOf('newer note') < text.indexOf('older note'), text)
  assert.match(text, /atlas/)
  assert.match(text, /unfiled/)
})

test('/list caps the report at ten captures', async () => {
  const files = {}
  for (let i = 1; i <= 14; i++) {
    files[`captures/unfiled/2026-08-21T10-00-${String(i).padStart(2, '0')}Z-${i}.md`] = body(
      i,
      `note ${i}`,
    )
  }
  const inbox = fakeInbox({ files, buckets: ['atlas'] })
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/list'), { inbox, telegram, ownerChatId: OWNER })

  const bullets = telegram.calls[0][2].split('\n').filter((l) => l.startsWith('•'))
  assert.equal(bullets.length, 10)
})

test('/list says so when nothing is waiting', async () => {
  const inbox = fakeInbox({ files: {} })
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/list'), { inbox, telegram, ownerChatId: OWNER })
  assert.match(telegram.calls[0][2], /nothing waiting/i)
})

test('/list ignores filed captures', async () => {
  const inbox = fakeInbox({
    files: { 'filed/atlas/2026-08-20T10-00-00Z-99.md': body(99, 'done already') },
    buckets: ['atlas'],
  })
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/list'), { inbox, telegram, ownerChatId: OWNER })
  assert.match(telegram.calls[0][2], /nothing waiting/i)
})

test('an unknown command points at /help and writes nothing', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/wat'), { inbox, telegram, ownerChatId: OWNER })

  assert.match(telegram.calls[0][2], /\/help/)
  assert.deepEqual(Object.keys(inbox.files), [])
})

test('a command with a bot suffix still routes', async () => {
  const inbox = fakeInbox()
  const telegram = fakeTelegram()
  await handleUpdate(cmd('/help@example_docket_bot'), { inbox, telegram, ownerChatId: OWNER })
  assert.match(telegram.calls[0][2], /\/list/)
})
