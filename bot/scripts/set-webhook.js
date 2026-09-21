/**
 * Registers the Telegram webhook. Run once after the first deploy, and again
 * whenever the production URL changes.
 *
 *   node scripts/set-webhook.js https://docket-bot.vercel.app/api/telegram
 */
const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET
const url = process.argv[2]

if (!token || !secret) {
  console.error('need TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in the environment')
  process.exit(1)
}
if (!url?.startsWith('https://')) {
  console.error('usage: node scripts/set-webhook.js <https url>')
  process.exit(1)
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
  }),
})
const json = await response.json()
if (!json.ok) {
  console.error('setWebhook failed:', json.description)
  process.exit(1)
}
console.log('webhook set →', url)
