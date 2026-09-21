/**
 * Claude → phone. The owner must have messaged the bot at least once, because
 * Telegram forbids a bot from opening a conversation.
 *
 *   node scripts/tell.js "chunk 12 merged, ready for review"
 */
const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.TELEGRAM_CHAT_ID
const text = process.argv.slice(2).join(' ')

if (!token || !chatId) {
  console.error('need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment')
  process.exit(1)
}
if (!text.trim()) {
  console.error('usage: node scripts/tell.js "message"')
  process.exit(1)
}

const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: Number(chatId), text }),
})
const json = await response.json()
if (!json.ok) {
  console.error('sendMessage failed:', json.description)
  process.exit(1)
}
console.log('sent')
