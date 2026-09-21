import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MOVER, planMove } from '../src/move.js'

const at = () => new Date('2026-09-11T10:00:00.000Z')
const card = (over = {}) => ({
  id: 'c1',
  title: 'T',
  detail: 'D',
  tags: ['x'],
  column: 'loop',
  flag: true,
  notes: [{ author: 'owner', at: '2026-09-01T00:00:00.000Z', text: 'hi' }],
  origin: 'telegram · 2026-09-01',
  createdBy: 'owner',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  columnSince: '2026-09-03T00:00:00.000Z',
  attachments: [{ file: 'abc123abc123.png', kind: 'image/png' }],
  ...over,
})

test("a moved card lands in the target's first column with its clock reset", () => {
  // The owner's ruling: re-triage where it arrives. And since no board's first
  // column is Loop, no move can ever land a card there.
  const landed = planMove(card(), { targetColumnKeys: ['inbox', 'next', 'loop'], sourceName: 'Docket', now: at })
  assert.equal(landed.column, 'inbox')
  assert.equal(landed.columnSince, '2026-09-11T10:00:00.000Z')
  assert.equal(landed.updatedAt, '2026-09-11T10:00:00.000Z')
})

test('the move leaves a trail note by the tool, not the owner', () => {
  // The card's git history splits across two repos here; the note is the
  // trail. Authored by the tool so `docket news` never reads it as the owner.
  const landed = planMove(card(), { targetColumnKeys: ['inbox'], sourceName: 'Docket', now: at })
  assert.equal(landed.notes.length, 2)
  assert.deepEqual(landed.notes.at(-1), { author: MOVER, at: '2026-09-11T10:00:00.000Z', text: 'moved from Docket' })
  assert.equal(MOVER, 'docket')
})

test('everything else travels untouched, and the input is not mutated', () => {
  const input = card()
  const landed = planMove(input, { targetColumnKeys: ['inbox'], sourceName: 'Docket', now: at })
  for (const key of ['id', 'title', 'detail', 'tags', 'flag', 'origin', 'createdBy', 'createdAt', 'attachments']) {
    assert.deepEqual(landed[key], input[key], key)
  }
  assert.equal(input.column, 'loop')
  assert.equal(input.notes.length, 1)
})

// ---- moveCard: the two writes, over the real store in temp directories ----

import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { storeAttachment } from '../src/attachments.js'
import { moveCard } from '../src/move.js'
import { readBoard, writeBoard } from '../src/store.js'

const KEYS = ['inbox', 'next', 'loop', 'review', 'done']
const boardFile = (root) => join(root, '.docket', 'board.json')

async function project(name, cards) {
  const root = await mkdtemp(join(tmpdir(), `docket-${name}-`))
  await mkdir(join(root, '.docket'), { recursive: true })
  await writeFile(boardFile(root), `${JSON.stringify({ rev: 1, updatedAt: at().toISOString(), cards }, null, 2)}\n`)
  return { root, name, columnKeys: KEYS }
}
const cardsOf = async (p) => (await readBoard(boardFile(p.root))).cards

test('moveCard: the card leaves the source, lands first-column on the target, blob copied', async () => {
  const source = await project('Alpha', [])
  const blob = await storeAttachment(source.root, { bytes: Buffer.from('png-bytes'), kind: 'image/png' })
  await writeBoard(
    boardFile(source.root),
    { rev: 1, cards: [card({ attachments: [{ file: blob.file, kind: 'image/png' }] })] },
    { columnKeys: KEYS, now: at },
  )
  const target = await project('Beta', [card({ id: 'other' })])

  const result = await moveCard({ id: 'c1', source, target, now: at })

  assert.equal(result.ok, true)
  assert.equal(result.duplicate, false)
  assert.equal(result.column, 'inbox')
  assert.deepEqual((await cardsOf(source)).map((c) => c.id), [])
  const after = await cardsOf(target)
  const landed = after.find((c) => c.id === 'c1')
  assert.equal(landed.column, 'inbox')
  assert.equal(landed.notes.at(-1).text, 'moved from Alpha')
  assert.equal(after[0].id, 'c1', 'lands on top, like a new card')
  await access(join(target.root, '.docket', 'attachments', blob.file))
})

test('moveCard refuses the same board, an unknown card, and an id collision, touching nothing', async () => {
  const source = await project('Alpha', [card()])
  const target = await project('Beta', [card({ id: 'c1', title: 'already here' })])
  const snapshot = async () => [await readFile(boardFile(source.root), 'utf8'), await readFile(boardFile(target.root), 'utf8')]
  const before = await snapshot()

  assert.equal((await moveCard({ id: 'c1', source, target: source, now: at })).status, 400)
  assert.equal((await moveCard({ id: 'nope', source, target, now: at })).status, 404)
  assert.equal((await moveCard({ id: 'c1', source, target, now: at })).status, 409)

  assert.deepEqual(await snapshot(), before)
})

test('moveCard writes the target BEFORE the source, so a failed delete duplicates rather than loses', async () => {
  const source = await project('Alpha', [card()])
  const target = await project('Beta', [])
  const seen = []
  const store = {
    readBoard,
    writeBoard: async (file, doc, opts) => {
      seen.push(file === boardFile(target.root) ? 'target' : 'source')
      if (file === boardFile(source.root)) return { ok: false, conflict: true, doc: await readBoard(file) }
      return writeBoard(file, doc, opts)
    },
  }
  const result = await moveCard({ id: 'c1', source, target, now: at, store, retries: 2 })

  assert.equal(seen[0], 'target')
  assert.deepEqual(seen, ['target', 'source', 'source'], 'the delete is retried, bounded')
  assert.equal(result.ok, true)
  assert.equal(result.duplicate, true)
  assert.match(result.message, /still on Alpha/)
  assert.equal((await cardsOf(source)).length, 1, 'the original is still on the source')
  assert.equal((await cardsOf(target)).length, 1, 'and the copy is on the target')
})

test('moveCard: a target rev conflict is a 409 and the source is untouched', async () => {
  const source = await project('Alpha', [card()])
  const target = await project('Beta', [])
  const store = {
    readBoard,
    writeBoard: async (file, doc, opts) =>
      file === boardFile(target.root)
        ? { ok: false, conflict: true, doc: await readBoard(file) }
        : writeBoard(file, doc, opts),
  }
  const result = await moveCard({ id: 'c1', source, target, now: at, store })
  assert.equal(result.status, 409)
  assert.equal((await cardsOf(source)).length, 1)
  assert.equal((await cardsOf(target)).length, 0)
})
