export function fakeTelegram() {
  const calls = []
  return {
    calls,
    sendMessage: async (...args) => {
      calls.push(['sendMessage', ...args])
      return { message_id: 100 }
    },
    editMessageText: async (...args) => {
      calls.push(['editMessageText', ...args])
      return {}
    },
    answerCallbackQuery: async (...args) => {
      calls.push(['answerCallbackQuery', ...args])
      return true
    },
  }
}

export function fakeInbox({ files = {}, buckets = ['atlas', 'ideas'] } = {}) {
  const calls = []
  return {
    calls,
    files,
    putFile: async (path, content, message) => {
      calls.push(['putFile', path, content, message])
      files[path] = content
      return {}
    },
    getFile: async (path) => (path in files ? { content: files[path], sha: `sha-${path}` } : null),
    deleteFile: async (path) => {
      calls.push(['deleteFile', path])
      delete files[path]
      return null
    },
    listDir: async (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => ({ name: p.split('/').pop(), path: p })),
    findByUpdateId: async (id) =>
      Object.keys(files).find((p) => p.startsWith('captures/unfiled/') && p.endsWith(`-${id}.md`)) ??
      null,
    move: async (from, to, message) => {
      calls.push(['move', from, to, message])
      if (!(from in files)) return false
      files[to] = files[from]
      delete files[from]
      return true
    },
    readBuckets: async () => buckets,
  }
}
