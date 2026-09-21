import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_BYTES,
  attachmentsDir,
  isAttachmentName,
  kindForName,
  listAttachmentFiles,
  orphanedAttachments,
  readAttachment,
  removeAttachment,
  storeAttachment,
} from '../src/attachments.js'

const project = () => mkdtemp(join(tmpdir(), 'docket-attach-'))
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('a stored attachment gets a content-addressed name', async () => {
  const root = await project()
  const result = await storeAttachment(root, { bytes: png, kind: 'image/png' })
  assert.equal(result.ok, true)
  assert.match(result.file, /^[0-9a-f]{12}\.png$/)
  assert.equal(result.bytes, png.length)
  assert.deepEqual(await readdir(attachmentsDir(root)), [result.file])
})

test('the same bytes always land on the same name', async () => {
  const root = await project()
  const first = await storeAttachment(root, { bytes: png, kind: 'image/png' })
  const second = await storeAttachment(root, { bytes: png, kind: 'image/png' })
  assert.equal(first.file, second.file)
  assert.equal((await readdir(attachmentsDir(root))).length, 1, 'a repeat paste must not duplicate')
})

test('different bytes get different names', async () => {
  const root = await project()
  const a = await storeAttachment(root, { bytes: png, kind: 'image/png' })
  const b = await storeAttachment(root, { bytes: Buffer.from('different'), kind: 'image/png' })
  assert.notEqual(a.file, b.file)
})

test('the bytes come back byte-identical', async () => {
  const root = await project()
  const { file } = await storeAttachment(root, { bytes: png, kind: 'image/png' })
  const back = await readAttachment(root, file)
  assert.ok(png.equals(back))
})

test('an unsupported type is refused', async () => {
  const root = await project()
  const result = await storeAttachment(root, { bytes: png, kind: 'application/x-msdownload' })
  assert.equal(result.ok, false)
  assert.match(result.error, /unsupported/)
})

test('an empty body is refused', async () => {
  const root = await project()
  const result = await storeAttachment(root, { bytes: Buffer.alloc(0), kind: 'image/png' })
  assert.equal(result.ok, false)
  assert.match(result.error, /empty/)
})

test('an oversized body is refused before anything is written', async () => {
  const root = await project()
  const result = await storeAttachment(root, {
    bytes: Buffer.alloc(MAX_BYTES + 1),
    kind: 'image/png',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /too large/)
  await assert.rejects(() => readdir(attachmentsDir(root)))
})

test('name validation accepts the shape we generate and nothing else', () => {
  assert.equal(isAttachmentName('a3f9c21e08b4.png'), true)
  assert.equal(isAttachmentName('../../etc/passwd'), false)
  assert.equal(isAttachmentName('a3f9c21e08b4.png/../x'), false)
  assert.equal(isAttachmentName('NOTHEX00000.png'), false)
  assert.equal(isAttachmentName('a3f9c21e08b4'), false)
  assert.equal(isAttachmentName(''), false)
  assert.equal(isAttachmentName(null), false)
})

test('readAttachment refuses a traversal attempt outright', async () => {
  const root = await project()
  await writeFile(join(root, 'secret.txt'), 'do not read me')
  assert.equal(await readAttachment(root, '../secret.txt'), null)
})

test('readAttachment returns null for a missing file', async () => {
  assert.equal(await readAttachment(await project(), 'a3f9c21e08b4.png'), null)
})

test('kindForName maps an extension back to its mime type', () => {
  assert.equal(kindForName('a3f9c21e08b4.png'), 'image/png')
  assert.equal(kindForName('a3f9c21e08b4.pdf'), 'application/pdf')
  assert.equal(kindForName('a3f9c21e08b4.zzz'), null)
})

// ---------------------------------------------------------------------------
// orphanedAttachments — pure over (files on disk, cards). The attachments
// array is the ONLY reference site; prose mentions do not count. The test
// named "decided, not defaulted" below explains why.

const cardWith = (over) => ({
  id: 'c1',
  detail: '',
  notes: [],
  attachments: [],
  column: 'inbox',
  ...over,
})

test('a file no card references is an orphan; a referenced one never is', () => {
  const cards = [cardWith({ attachments: [{ file: 'aaaaaaaaaaaa.png', kind: 'image/png' }] })]
  assert.deepEqual(orphanedAttachments(['aaaaaaaaaaaa.png', 'bbbbbbbbbbbb.png'], cards), [
    'bbbbbbbbbbbb.png',
  ])
})

test('the shared case: two cards, one file, one card deleted — the file survives', () => {
  const shared = { file: 'cccccccccccc.png', kind: 'image/png' }
  const survivor = cardWith({ id: 'keeper', attachments: [shared] })
  // The other card is gone from the board entirely — deletion means absence.
  assert.deepEqual(orphanedAttachments(['cccccccccccc.png'], [survivor]), [])
})

test('a card in done still counts as a reference — old cards keep their evidence', () => {
  const done = cardWith({ column: 'done', attachments: [{ file: 'dddddddddddd.png', kind: 'image/png' }] })
  assert.deepEqual(orphanedAttachments(['dddddddddddd.png'], [done]), [])
})

test('a filename merely mentioned in text is NOT a reference — decided, not defaulted', () => {
  // The system never resolves a filename out of a note or a detail; only the
  // attachments array renders. Counting mentions would have protected the very
  // junk file this sweep was written to remove, because the card describing
  // the problem names it. The safety lives elsewhere: doctor only reports, and
  // prune is an explicit command that prints every name it deletes.
  const inNote = cardWith({ notes: [{ author: 'owner', at: 'x', text: 'see eeeeeeeeeeee.png' }] })
  const inDetail = cardWith({ id: 'c2', detail: 'compare with ffffffffffff.png' })
  assert.deepEqual(orphanedAttachments(['eeeeeeeeeeee.png', 'ffffffffffff.png'], [inNote, inDetail]), [
    'eeeeeeeeeeee.png',
    'ffffffffffff.png',
  ])
})

test('an empty board orphans everything on disk', () => {
  assert.deepEqual(orphanedAttachments(['abababababab.png'], []), ['abababababab.png'])
})

test('listAttachmentFiles sees only validly-named files, and an absent dir is empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docket-att-'))
  assert.deepEqual(await listAttachmentFiles(root), [])
  const stored = await storeAttachment(root, { bytes: Buffer.from('x'), kind: 'image/png' })
  await writeFile(join(attachmentsDir(root), 'not-an-attachment.txt'), 'junk')
  assert.deepEqual(await listAttachmentFiles(root), [stored.file])
})

test('removeAttachment deletes by valid name only, through this module alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docket-att-'))
  const stored = await storeAttachment(root, { bytes: Buffer.from('y'), kind: 'image/png' })
  assert.equal(await removeAttachment(root, '../../board.json'), false, 'shape-guarded')
  assert.equal(await removeAttachment(root, stored.file), true)
  assert.equal(await readAttachment(root, stored.file), null, 'the bytes are gone')
  assert.equal(await removeAttachment(root, stored.file), false, 'a second remove is a no-op')
})
