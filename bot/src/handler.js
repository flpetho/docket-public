import { captureBody, captureFilename, capturePath, firstLine, parseCapture } from './capture.js'

const LIST_LIMIT = 10

/** Two buttons per row; `callback_data` is `<updateId>:<bucketIndex>` to stay under 64 bytes. */
function bucketKeyboard(updateId, buckets) {
  const buttons = buckets.map((bucket, index) => ({
    text: bucket,
    callback_data: `${updateId}:${index}`,
  }))
  const rows = []
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
  return { inline_keyboard: rows }
}

async function handleCapture(update, { inbox, telegram, now }) {
  const message = update.message
  const at = now().toISOString()
  const filename = captureFilename(at, update.update_id)

  // Write before replying: a note must never be lost waiting for a bucket tap.
  await inbox.putFile(
    capturePath('unfiled', filename),
    captureBody({ updateId: update.update_id, bucket: 'unfiled', at, text: message.text }),
    `capture ${update.update_id}`,
  )

  const buckets = await inbox.readBuckets()
  await telegram.sendMessage(message.chat.id, `📥 ${firstLine(message.text)}`, {
    reply_markup: bucketKeyboard(update.update_id, buckets),
  })
}

async function handleCommand(message, { inbox, telegram }) {
  const chatId = message.chat.id
  const command = message.text.split(/\s+/)[0].replace(/@.*$/, '').toLowerCase()
  const buckets = await inbox.readBuckets()

  if (command === '/help' || command === '/start') {
    await telegram.sendMessage(
      chatId,
      [
        'Send any text and it becomes a capture. Then tap a bucket to file it.',
        '',
        `Buckets: ${buckets.join(', ')}`,
        '',
        '/list — recent captures not yet filed',
        '/help — this message',
      ].join('\n'),
    )
    return
  }

  if (command === '/list') {
    const waiting = []
    for (const bucket of ['unfiled', ...buckets]) {
      for (const entry of await inbox.listDir(`captures/${bucket}`)) {
        waiting.push({ bucket, ...entry })
      }
    }
    // Filenames start with the UTC instant, so a descending name sort is newest-first.
    waiting.sort((a, b) => (a.name < b.name ? 1 : -1))

    const lines = []
    for (const entry of waiting.slice(0, LIST_LIMIT)) {
      const file = await inbox.getFile(entry.path)
      const parsed = file ? parseCapture(file.content) : null
      lines.push(`• ${entry.bucket} — ${parsed ? firstLine(parsed.text, 60) : entry.name}`)
    }

    await telegram.sendMessage(
      chatId,
      lines.length
        ? `Waiting to be filed:\n${lines.join('\n')}`
        : 'Nothing waiting. Everything is filed.',
    )
    return
  }

  await telegram.sendMessage(chatId, `Unknown command ${command}. Try /help.`)
}

async function handleCallback(query, { inbox, telegram }) {
  // Answer within Telegram's 10-second window or the phone spins forever.
  await telegram.answerCallbackQuery(query.id)

  const chatId = query.message.chat.id
  const messageId = query.message.message_id
  const original = query.message.text
  const [updateId, bucketIndex] = String(query.data).split(':')

  const buckets = await inbox.readBuckets()
  const bucket = buckets[Number(bucketIndex)]
  if (!bucket) {
    await telegram.editMessageText(chatId, messageId, `${original}\n\nUnknown bucket.`)
    return
  }

  const from = await inbox.findByUpdateId(updateId)
  if (!from) {
    await telegram.editMessageText(chatId, messageId, `${original}\n\nAlready filed.`)
    return
  }

  const filename = from.split('/').pop()
  await inbox.move(from, capturePath(bucket, filename), `file ${updateId} → ${bucket}`)
  await telegram.editMessageText(chatId, messageId, `${original}\n\n→ ${bucket} ✓`)
}

export async function handleUpdate(update, { inbox, telegram, ownerChatId, now = () => new Date() }) {
  const message = update.message
  const query = update.callback_query
  const chatId = message?.chat?.id ?? query?.message?.chat?.id
  if (chatId === undefined) return

  if (chatId !== ownerChatId) {
    await telegram.sendMessage(chatId, 'This bot is private.')
    return
  }

  if (query) return handleCallback(query, { inbox, telegram })

  if (typeof message.text !== 'string') {
    await telegram.sendMessage(chatId, 'Text notes only for now.')
    return
  }

  if (message.text.startsWith('/')) return handleCommand(message, { inbox, telegram })

  return handleCapture(update, { inbox, telegram, now })
}
