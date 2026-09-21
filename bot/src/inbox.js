const API = 'https://api.github.com'
const BUCKET_TTL_MS = 60_000

/**
 * The inbox repo, through the GitHub Contents API. One capture is one file, so
 * concurrent captures never conflict. `fetch` and `now` are injectable for tests.
 */
export function createInbox({ token, repo, fetch: doFetch = fetch, now = () => Date.now() }) {
  let buckets = null

  const request = async (method, path, body) => {
    const response = await doFetch(`${API}/repos/${repo}/contents/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'docket-bot',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (method === 'GET' && response.status === 404) return null
    if (!response.ok) {
      // The URL holds the token, so it must never reach the message.
      throw new Error(`github ${method} ${path} → ${response.status}`)
    }
    return response.status === 204 ? null : response.json()
  }

  const getFile = async (path) => {
    const json = await request('GET', path)
    if (!json || Array.isArray(json)) return null
    return { content: Buffer.from(json.content, 'base64').toString('utf8'), sha: json.sha }
  }

  /** Reads the existing sha first so a retried webhook updates instead of 409-ing. */
  const putFile = async (path, content, message) => {
    const existing = await request('GET', path)
    return request('PUT', path, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(existing && !Array.isArray(existing) && existing.sha ? { sha: existing.sha } : {}),
    })
  }

  const deleteFile = (path, sha, message) => request('DELETE', path, { message, sha })

  const listDir = async (path) => {
    const json = await request('GET', path)
    return Array.isArray(json) ? json.map((e) => ({ name: e.name, path: e.path })) : []
  }

  const findByUpdateId = async (updateId) => {
    const entries = await listDir('captures/unfiled')
    return entries.find((e) => e.name.endsWith(`-${updateId}.md`))?.path ?? null
  }

  /** Create-then-delete, so a crash mid-move duplicates rather than loses. */
  const move = async (from, to, message) => {
    const file = await getFile(from)
    if (!file) return false
    await putFile(to, file.content, message)
    await deleteFile(from, file.sha, message)
    return true
  }

  const readBuckets = async () => {
    if (buckets && now() - buckets.at < BUCKET_TTL_MS) return buckets.value
    const file = await getFile('buckets.json')
    const value = file ? JSON.parse(file.content) : ['unfiled']
    buckets = { at: now(), value }
    return value
  }

  return { getFile, putFile, deleteFile, listDir, findByUpdateId, move, readBuckets }
}
