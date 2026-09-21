import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readBoard, writeBoard } from '../src/store.js'

const COLUMNS = ['inbox', 'next', 'done']
const card = (over = {}) => ({
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
  ...over,
})

const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'docket-store-')), 'board.json')
const at = () => new Date('2026-08-21T12:00:00.000Z')

test('readBoard returns null when no file exists', async () => {
  assert.equal(await readBoard(await tempFile()), null)
})

test('a first write at rev 0 creates the board at rev 1', async () => {
  const file = await tempFile()
  const result = await writeBoard(file, { rev: 0, cards: [card()] }, { columnKeys: COLUMNS, now: at })
  assert.deepEqual(result, { ok: true, rev: 1 })

  const doc = await readBoard(file)
  assert.equal(doc.rev, 1)
  assert.equal(doc.updatedAt, '2026-08-21T12:00:00.000Z')
  assert.equal(doc.cards.length, 1)
})

test('a matching rev succeeds and increments', async () => {
  const file = await tempFile()
  await writeBoard(file, { rev: 0, cards: [card()] }, { columnKeys: COLUMNS, now: at })
  const result = await writeBoard(
    file,
    { rev: 1, cards: [card({ title: 'B' })] },
    { columnKeys: COLUMNS, now: at },
  )
  assert.deepEqual(result, { ok: true, rev: 2 })
  assert.equal((await readBoard(file)).cards[0].title, 'B')
})

test('a stale rev is refused and carries the current doc back', async () => {
  const file = await tempFile()
  await writeBoard(file, { rev: 0, cards: [card()] }, { columnKeys: COLUMNS, now: at })
  const result = await writeBoard(
    file,
    { rev: 0, cards: [card({ title: 'clobber' })] },
    { columnKeys: COLUMNS, now: at },
  )
  assert.equal(result.ok, false)
  assert.equal(result.conflict, true)
  assert.equal(result.doc.rev, 1)
  assert.equal((await readBoard(file)).cards[0].title, 'A', 'the stale write must not land')
})

test('an unknown column is refused with a named error', async () => {
  const file = await tempFile()
  const result = await writeBoard(
    file,
    { rev: 0, cards: [card({ column: 'nowhere' })] },
    { columnKeys: COLUMNS, now: at },
  )
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /column/)
  assert.equal(await readBoard(file), null, 'nothing should have been written')
})

test('a non-integer rev is refused', async () => {
  const file = await tempFile()
  const result = await writeBoard(file, { rev: 1.5, cards: [] }, { columnKeys: COLUMNS, now: at })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /rev/)
})

test('card order is preserved exactly', async () => {
  const file = await tempFile()
  const ids = ['c', 'a', 'b', 'z', 'm']
  await writeBoard(
    file,
    { rev: 0, cards: ids.map((id) => card({ id })) },
    { columnKeys: COLUMNS, now: at },
  )
  assert.deepEqual(
    (await readBoard(file)).cards.map((c) => c.id),
    ids,
  )
})

test('a write leaves no temp file behind', async () => {
  const file = await tempFile()
  await writeBoard(file, { rev: 0, cards: [card()] }, { columnKeys: COLUMNS, now: at })
  const entries = await readdir(join(file, '..'))
  assert.deepEqual(entries, ['board.json'], `stray files: ${entries}`)
})

test('readBoard surfaces corrupt JSON rather than pretending the board is empty', async () => {
  const file = await tempFile()
  await writeFile(file, '{ this is not json')
  await assert.rejects(() => readBoard(file), /board.json/)
})

test('the file is pretty-printed and newline-terminated so git diffs read well', async () => {
  const file = await tempFile()
  await writeBoard(file, { rev: 0, cards: [card()] }, { columnKeys: COLUMNS, now: at })
  const raw = await readFile(file, 'utf8')
  assert.ok(raw.startsWith('{\n  "rev": 1'), raw.slice(0, 40))
  assert.ok(raw.endsWith('}\n'))
})
