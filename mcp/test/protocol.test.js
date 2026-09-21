import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { defaultConfig } from '../../board/src/config.js'
import { addProject } from '../../board/src/registry.js'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js')
const at = () => new Date('2026-08-21T12:00:00.000Z')

/**
 * Spawns the real server over real stdio and speaks the real protocol. The unit
 * tests cover the logic; this covers the wiring — a wrong handshake or a
 * malformed schema fails silently otherwise.
 */
async function connect({ cards = [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'docket-proto-home-'))
  const root = await mkdtemp(join(tmpdir(), 'proto-project-'))
  await mkdir(join(root, '.docket'), { recursive: true })
  await writeFile(
    join(root, '.docket', 'config.json'),
    `${JSON.stringify(defaultConfig('Proto Project'), null, 2)}\n`,
  )
  await writeFile(
    join(root, '.docket', 'board.json'),
    `${JSON.stringify({ rev: 1, updatedAt: '2026-08-21T00:00:00.000Z', cards }, null, 2)}\n`,
  )
  await addProject(join(home, '.docket', 'projects.json'), {
    path: root,
    name: 'Proto Project',
    now: at,
  })

  const client = new Client({ name: 'docket-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: root,
    env: { ...process.env, HOME: home },
  })
  await client.connect(transport)
  return {
    client,
    root,
    close: () => client.close(),
    board: async () => JSON.parse(await readFile(join(root, '.docket', 'board.json'), 'utf8')),
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      const text = result.content.map((c) => c.text).join('')
      return { isError: result.isError === true, text, json: safeParse(text) }
    },
  }
}

const safeParse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const card = (over = {}) => ({
  id: 'c1',
  title: 'A real card',
  detail: '',
  tags: ['strategy'],
  column: 'inbox',
  flag: false,
  notes: [],
  origin: '',
  createdBy: 'owner',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  columnSince: '2026-08-20T00:00:00.000Z',
  attachments: [],
  ...over,
})

test('the handshake succeeds and all six tools are advertised', async () => {
  const h = await connect()
  try {
    const { tools } = await h.client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'docket_add',
        'docket_board',
        'docket_delete',
        'docket_note',
        'docket_projects',
        'docket_update',
      ],
    )
    for (const tool of tools) {
      assert.ok(tool.description?.length > 20, `${tool.name} needs a real description`)
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema`)
    }
  } finally {
    await h.close()
  }
})

test('docket_board over the wire returns the board', async () => {
  const h = await connect({ cards: [card()] })
  try {
    const { isError, json } = await h.call('docket_board')
    assert.equal(isError, false)
    assert.equal(json.project, 'proto-project')
    assert.equal(json.total, 1)
    assert.equal(json.cards[0].title, 'A real card')
  } finally {
    await h.close()
  }
})

test('cwd decides the project with no argument passed', async () => {
  const h = await connect({ cards: [card()] })
  try {
    const { json } = await h.call('docket_board')
    assert.equal(json.name, 'Proto Project')
  } finally {
    await h.close()
  }
})

test('a full write round trip lands in the file', async () => {
  const h = await connect()
  try {
    const added = await h.call('docket_add', {
      title: 'Written over MCP',
      detail: 'body',
      tags: ['tooling'],
      note: 'created by the protocol test',
    })
    assert.equal(added.isError, false)

    const noted = await h.call('docket_note', { id: added.json.id, text: 'second note' })
    assert.equal(noted.isError, false)

    const moved = await h.call('docket_update', { id: added.json.id, column: 'review' })
    assert.equal(moved.json.movedFrom, 'inbox')

    const doc = await h.board()
    const card = doc.cards.find((c) => c.id === added.json.id)
    assert.equal(card.title, 'Written over MCP')
    assert.equal(card.column, 'review')
    assert.equal(card.createdBy, 'claude')
    assert.deepEqual(
      card.notes.map((n) => n.author),
      ['claude', 'claude'],
    )
  } finally {
    await h.close()
  }
})

test('an error comes back as isError with a readable message, not a crash', async () => {
  const h = await connect()
  try {
    const result = await h.call('docket_note', { id: 'does-not-exist', text: 'x' })
    assert.equal(result.isError, true)
    assert.match(result.text, /no card "does-not-exist"/)

    // and the connection is still usable afterwards
    const after = await h.call('docket_board')
    assert.equal(after.isError, false)
  } finally {
    await h.close()
  }
})

test('a directory outside any project reports it plainly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'docket-empty-home-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'not-a-project-'))
  const client = new Client({ name: 'docket-test', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: elsewhere,
      env: { ...process.env, HOME: home },
    }),
  )
  try {
    const result = await client.callTool({ name: 'docket_board', arguments: {} })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /no Docket board here/)
  } finally {
    await client.close()
  }
})

test('docket_delete removes the card', async () => {
  const h = await connect({ cards: [card(), card({ id: 'c2' })] })
  try {
    const result = await h.call('docket_delete', { id: 'c1' })
    assert.equal(result.isError, false)
    assert.deepEqual(
      (await h.board()).cards.map((c) => c.id),
      ['c2'],
    )
  } finally {
    await h.close()
  }
})
