const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'OWNER_CHAT_ID',
  'GITHUB_TOKEN',
  'INBOX_REPO',
]

/** Reads and validates the function's environment. Never includes a value in an error. */
export function readConfig(env) {
  const missing = REQUIRED.filter((key) => !env[key])
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`)

  const ownerChatId = Number(env.OWNER_CHAT_ID)
  if (!Number.isInteger(ownerChatId)) throw new Error('OWNER_CHAT_ID must be an integer')

  return {
    botToken: env.TELEGRAM_BOT_TOKEN,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    ownerChatId,
    githubToken: env.GITHUB_TOKEN,
    inboxRepo: env.INBOX_REPO,
  }
}
