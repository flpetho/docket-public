/**
 * The three Bot API methods v1 needs. Errors name the method only — the request
 * URL embeds the bot token, so it must never reach a message or a log line.
 */
export function createTelegram({ token, fetch: doFetch = fetch }) {
  const call = async (method, payload) => {
    const response = await doFetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await response.json().catch(() => null)
    if (!response.ok || !json?.ok) {
      throw new Error(`telegram ${method} → ${response.status} ${json?.description ?? 'no body'}`)
    }
    return json.result
  }

  return {
    sendMessage: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, ...extra }),
    editMessageText: (chatId, messageId, text, extra = {}) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }),
    answerCallbackQuery: (id, text) =>
      call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
  }
}
