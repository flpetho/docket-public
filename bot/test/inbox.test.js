import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createInbox } from '../src/inbox.js'

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

/** Records requests and replies from a scripted table keyed by `METHOD path`. */
function fakeFetch(routes) {
  const seen = []
  const f = async (url, opts = {}) => {
    const method = opts.method ?? 'GET'
    const path = url.replace('https://api.github.com/repos/o/r/contents/', '')
    seen.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null })
    const hit = routes[`${method} ${path}`] ?? routes[method] ?? { status: 404 }
    return {
      ok: hit.status < 400,
      status: hit.status,
      json: async () => hit.json ?? {},
      text: async () => JSON.stringify(hit.json ?? {}),
    }
  }
  f.seen = seen
  return f
}

const inbox = (routes, now = () => 0) =>
  createInbox({ token: 'tok', repo: 'o/r', fetch: fakeFetch(routes), now })

test('getFile decodes base64 and returns the sha', async () => {
  const i = inbox({ 'GET a.md': { status: 200, json: { content: b64('hello'), sha: 'abc' } } })
  assert.deepEqual(await i.getFile('a.md'), { content: 'hello', sha: 'abc' })
})

test('getFile returns null on 404', async () => {
  assert.equal(await inbox({}).getFile('missing.md'), null)
})

test('putFile sends no sha when the path is new', async () => {
  const f = fakeFetch({ 'PUT a.md': { status: 201, json: {} } })
  const i = createInbox({ token: 'tok', repo: 'o/r', fetch: f, now: () => 0 })
  await i.putFile('a.md', 'body', 'msg')
  const put = f.seen.find((r) => r.method === 'PUT')
  assert.equal(put.body.sha, undefined)
  assert.equal(Buffer.from(put.body.content, 'base64').toString('utf8'), 'body')
})

test('putFile carries the existing sha so a retry is idempotent', async () => {
  const f = fakeFetch({
    'GET a.md': { status: 200, json: { content: b64('old'), sha: 'sha1' } },
    'PUT a.md': { status: 200, json: {} },
  })
  const i = createInbox({ token: 'tok', repo: 'o/r', fetch: f, now: () => 0 })
  await i.putFile('a.md', 'new', 'msg')
  assert.equal(f.seen.find((r) => r.method === 'PUT').body.sha, 'sha1')
})

test('listDir returns [] for a directory that does not exist yet', async () => {
  assert.deepEqual(await inbox({}).listDir('captures/unfiled'), [])
})

test('findByUpdateId matches the update-id suffix', async () => {
  const i = inbox({
    'GET captures/unfiled': {
      status: 200,
      json: [
        { name: '2026-08-21T10-00-00Z-111.md', path: 'captures/unfiled/2026-08-21T10-00-00Z-111.md' },
        { name: '2026-08-21T11-00-00Z-222.md', path: 'captures/unfiled/2026-08-21T11-00-00Z-222.md' },
      ],
    },
  })
  assert.equal(await i.findByUpdateId(222), 'captures/unfiled/2026-08-21T11-00-00Z-222.md')
  assert.equal(await i.findByUpdateId(999), null)
})

test('move creates the target before deleting the source', async () => {
  const f = fakeFetch({
    'GET from.md': { status: 200, json: { content: b64('x'), sha: 'sha1' } },
    'PUT to.md': { status: 201, json: {} },
    'DELETE from.md': { status: 200, json: {} },
  })
  const i = createInbox({ token: 'tok', repo: 'o/r', fetch: f, now: () => 0 })
  assert.equal(await i.move('from.md', 'to.md', 'msg'), true)
  const order = f.seen.filter((r) => r.method !== 'GET').map((r) => r.method)
  assert.deepEqual(order, ['PUT', 'DELETE'])
})

test('move returns false when the source is gone', async () => {
  assert.equal(await inbox({}).move('from.md', 'to.md', 'msg'), false)
})

test('readBuckets falls back to unfiled when buckets.json is absent', async () => {
  assert.deepEqual(await inbox({}).readBuckets(), ['unfiled'])
})

test('readBuckets caches for 60 seconds', async () => {
  const f = fakeFetch({
    'GET buckets.json': { status: 200, json: { content: b64('["a","b"]'), sha: 's' } },
  })
  let clock = 0
  const i = createInbox({ token: 'tok', repo: 'o/r', fetch: f, now: () => clock })
  assert.deepEqual(await i.readBuckets(), ['a', 'b'])
  await i.readBuckets()
  assert.equal(f.seen.filter((r) => r.path === 'buckets.json').length, 1)
  clock = 61_000
  await i.readBuckets()
  assert.equal(f.seen.filter((r) => r.path === 'buckets.json').length, 2)
})

test('a failing request throws without naming the token', async () => {
  const i = inbox({ GET: { status: 500, json: { message: 'boom' } } })
  await assert.rejects(
    () => i.listDir('x'),
    (e) => {
      assert.doesNotMatch(e.message, /tok/)
      return true
    },
  )
})
