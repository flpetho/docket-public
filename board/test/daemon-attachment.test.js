import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_BYTES } from '../src/attachments.js'
import { defaultConfig } from '../src/config.js'
import { createDaemon } from '../src/daemon.js'
import { addProject } from '../src/registry.js'

const at = () => new Date('2026-08-21T12:00:00.000Z')
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

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
    projectRoot,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => daemon.close(),
  }
}

const post = (h, bytes, kind = 'image/png') =>
  fetch(h.url('/api/attachment?project=test-project'), {
    method: 'POST',
    headers: { 'content-type': kind },
    body: bytes,
  })

test('posting an image stores it and returns its reference', async () => {
  const h = await harness()
  try {
    const response = await post(h, png)
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.match(body.file, /^[0-9a-f]{12}\.png$/)
    assert.equal(body.kind, 'image/png')
    assert.equal(body.bytes, png.length)
  } finally {
    await h.close()
  }
})

test('the stored image comes back byte-identical over GET', async () => {
  const h = await harness()
  try {
    const { file } = await (await post(h, png)).json()
    const response = await fetch(h.url(`/api/attachment?project=test-project&file=${file}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.ok(png.equals(Buffer.from(await response.arrayBuffer())))
  } finally {
    await h.close()
  }
})

test('a content-type with a charset suffix is still understood', async () => {
  const h = await harness()
  try {
    const response = await post(h, Buffer.from('hello'), 'text/plain; charset=utf-8')
    assert.equal(response.status, 201)
    assert.match((await response.json()).file, /\.txt$/)
  } finally {
    await h.close()
  }
})

test('an unsupported type is 415', async () => {
  const h = await harness()
  try {
    assert.equal((await post(h, png, 'application/x-msdownload')).status, 415)
  } finally {
    await h.close()
  }
})

test('an oversized upload is 415, not a crash', async () => {
  const h = await harness()
  try {
    assert.equal((await post(h, Buffer.alloc(MAX_BYTES + 1))).status, 415)
  } finally {
    await h.close()
  }
})

test('a traversal filename is rejected before touching disk', async () => {
  const h = await harness()
  try {
    await writeFile(join(h.projectRoot, 'secret.txt'), 'do not read me')
    const response = await fetch(
      h.url('/api/attachment?project=test-project&file=..%2Fsecret.txt'),
    )
    assert.equal(response.status, 400)
  } finally {
    await h.close()
  }
})

test('a missing attachment is 404', async () => {
  const h = await harness()
  try {
    const response = await fetch(
      h.url('/api/attachment?project=test-project&file=a3f9c21e08b4.png'),
    )
    assert.equal(response.status, 404)
  } finally {
    await h.close()
  }
})

test('an unknown project is 404 for both verbs', async () => {
  const h = await harness()
  try {
    const get = await fetch(h.url('/api/attachment?project=nope&file=a3f9c21e08b4.png'))
    assert.equal(get.status, 404)
    const posted = await fetch(h.url('/api/attachment?project=nope'), {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    })
    assert.equal(posted.status, 404)
  } finally {
    await h.close()
  }
})

test('a card carrying an attachment round-trips through the board API', async () => {
  const h = await harness()
  try {
    const { file, kind } = await (await post(h, png)).json()
    const card = {
      id: 'a',
      title: 'Layout is wrong',
      detail: '',
      tags: ['demo-polish'],
      column: 'inbox',
      flag: false,
      notes: [],
      origin: '',
      createdBy: 'owner',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      columnSince: '2026-08-21T00:00:00.000Z',
      attachments: [{ file, kind, addedBy: 'owner', addedAt: '2026-08-21T00:00:00.000Z' }],
    }
    const put = await fetch(h.url('/api/board?project=test-project'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rev: 1, cards: [card] }),
    })
    assert.equal(put.status, 200)

    const doc = await (await fetch(h.url('/api/board?project=test-project'))).json()
    assert.deepEqual(doc.cards[0].attachments, card.attachments)
  } finally {
    await h.close()
  }
})

test('a card whose attachment lacks a file is rejected', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/board?project=test-project'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rev: 1,
        cards: [
          {
            id: 'a',
            title: 'A',
            detail: '',
            tags: [],
            column: 'inbox',
            flag: false,
            notes: [],
            origin: '',
            createdBy: 'owner',
            createdAt: '2026-08-21T00:00:00.000Z',
            updatedAt: '2026-08-21T00:00:00.000Z',
            columnSince: '2026-08-21T00:00:00.000Z',
            attachments: [{ kind: 'image/png' }],
          },
        ],
      }),
    })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /attachment/)
  } finally {
    await h.close()
  }
})
