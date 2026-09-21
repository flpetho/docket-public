import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../src/config.js'
import { createDaemon } from '../src/daemon.js'
import { addProject } from '../src/registry.js'

const at = () => new Date('2026-08-21T12:00:00.000Z')

/** A registry with one initialised project, plus a started daemon. */
async function harness() {
  const home = await mkdtemp(join(tmpdir(), 'docket-home-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'docket-proj-'))
  const registryFile = join(home, 'projects.json')
  await mkdir(join(projectRoot, '.docket'), { recursive: true })
  await writeFile(
    join(projectRoot, '.docket', 'config.json'),
    `${JSON.stringify(defaultConfig('Test Project'), null, 2)}\n`,
  )
  await writeFile(
    join(projectRoot, '.docket', 'board.json'),
    `${JSON.stringify({ rev: 1, updatedAt: '2026-08-21T00:00:00.000Z', cards: [] }, null, 2)}\n`,
  )
  await addProject(registryFile, { path: projectRoot, name: 'Test Project', now: at })

  const daemon = createDaemon({ registryFile, now: at })
  const port = await daemon.listen(0)
  return {
    daemon,
    projectRoot,
    registryFile,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => daemon.close(),
  }
}

const card = (over = {}) => ({
  id: 'a',
  title: 'A',
  detail: '',
  tags: ['strategy'],
  column: 'inbox',
  flag: false,
  notes: [],
  origin: '',
  createdBy: 'owner',
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
  ...over,
})

test('GET /api/projects lists registered projects with card counts', async () => {
  const h = await harness()
  try {
    const body = await (await fetch(h.url('/api/projects'))).json()
    assert.equal(body.projects.length, 1)
    assert.equal(body.projects[0].slug, 'test-project')
    assert.equal(body.projects[0].name, 'Test Project')
    assert.equal(body.projects[0].cards, 0)
  } finally {
    await h.close()
  }
})

test('GET /api/board returns the stored doc', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/board?project=test-project'))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.rev, 1)
    assert.deepEqual(body.cards, [])
  } finally {
    await h.close()
  }
})

test('GET /api/board 404s for an unknown project', async () => {
  const h = await harness()
  try {
    assert.equal((await fetch(h.url('/api/board?project=nope'))).status, 404)
  } finally {
    await h.close()
  }
})

test('PUT /api/board with a matching rev succeeds', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/board?project=test-project'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rev: 1, cards: [card()] }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, rev: 2 })

    const after = await (await fetch(h.url('/api/board?project=test-project'))).json()
    assert.equal(after.cards.length, 1)
  } finally {
    await h.close()
  }
})

test('PUT with a stale rev is 409 and carries the current doc', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/board?project=test-project'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rev: 0, cards: [card({ title: 'clobber' })] }),
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.rev, 1)
    assert.deepEqual(body.cards, [])
  } finally {
    await h.close()
  }
})

test('PUT with an unknown column is 400 and names the field', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/board?project=test-project'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rev: 1, cards: [card({ column: 'nowhere' })] }),
    })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /column/)
  } finally {
    await h.close()
  }
})

test('PUT with malformed JSON is 400, not a crash', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/board?project=test-project'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(response.status, 400)
  } finally {
    await h.close()
  }
})

test('an unknown route is 404', async () => {
  const h = await harness()
  try {
    assert.equal((await fetch(h.url('/api/nothing'))).status, 404)
  } finally {
    await h.close()
  }
})

// ---- POST /api/move: one route, both writes, the spec's refusals ----

import { readBoard } from '../src/store.js'

/** The one-project harness plus a second registered project, 'Beta'. */
async function twoBoards() {
  const h = await harness()
  const betaRoot = await mkdtemp(join(tmpdir(), 'docket-beta-'))
  await mkdir(join(betaRoot, '.docket'), { recursive: true })
  await writeFile(join(betaRoot, '.docket', 'config.json'), `${JSON.stringify(defaultConfig('Beta'), null, 2)}\n`)
  await writeFile(
    join(betaRoot, '.docket', 'board.json'),
    `${JSON.stringify({ rev: 1, updatedAt: at().toISOString(), cards: [] }, null, 2)}\n`,
  )
  await addProject(h.registryFile, { path: betaRoot, name: 'Beta', now: at })
  return { ...h, betaRoot }
}
const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const seed = (h, cards) =>
  fetch(h.url('/api/board?project=test-project'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rev: 1, cards }),
  })

test("POST /api/move sends a card to another board's first column and answers with the revs", async () => {
  const h = await twoBoards()
  try {
    await seed(h, [card({ column: 'loop' })])
    const response = await post(h.url('/api/move?project=test-project'), { id: 'a', to: 'beta' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.duplicate, false)
    assert.equal(body.column, 'inbox')
    assert.deepEqual((await readBoard(join(h.projectRoot, '.docket', 'board.json'))).cards, [])
    const landed = (await readBoard(join(h.betaRoot, '.docket', 'board.json'))).cards[0]
    assert.equal(landed.id, 'a')
    assert.equal(landed.column, 'inbox')
    assert.equal(landed.notes.at(-1).text, 'moved from Test Project')
  } finally {
    await h.close()
  }
})

test('POST /api/move refuses what the spec says it refuses, and moves nothing when it does', async () => {
  const h = await twoBoards()
  try {
    await seed(h, [card()])
    assert.equal((await post(h.url('/api/move?project=test-project'), { id: 'a', to: 'test-project' })).status, 400, 'same board')
    assert.equal((await post(h.url('/api/move?project=nope'), { id: 'a', to: 'beta' })).status, 404, 'unknown source')
    assert.equal((await post(h.url('/api/move?project=test-project'), { id: 'a', to: 'nope' })).status, 404, 'unknown target')
    assert.equal((await post(h.url('/api/move?project=test-project'), { id: 'zzz', to: 'beta' })).status, 404, 'unknown card')
    assert.equal((await post(h.url('/api/move?project=test-project'), { nope: true })).status, 400, 'bad body')
    assert.equal((await readBoard(join(h.projectRoot, '.docket', 'board.json'))).cards.length, 1, 'nothing moved')
    assert.equal((await readBoard(join(h.betaRoot, '.docket', 'board.json'))).cards.length, 0, 'nothing arrived')
  } finally {
    await h.close()
  }
})

// ---- /dashboard: the second page this daemon serves (spec 2026-09-17) ----

test('GET /dashboard serves the page for a known project and 404s for an unknown one', async () => {
  const h = await harness()
  try {
    const ok = await fetch(h.url('/dashboard?project=test-project'))
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('content-type'), /text\/html/)
    assert.ok((await ok.text()).includes('dashboard.js'), 'the page loads its module')
    assert.equal((await fetch(h.url('/dashboard?project=nope'))).status, 404)
    assert.equal((await fetch(h.url('/dashboard'))).status, 404)
  } finally {
    await h.close()
  }
})
