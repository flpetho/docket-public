import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../src/config.js'
import { captureToCard, drain, drainLine, firstLine, parseCapture } from '../src/drain.js'
import { addProject } from '../src/registry.js'

const at = () => new Date('2026-08-21T12:00:00.000Z')

const capture = (text, stamp = '2026-08-21T19:31:31.903Z', id = 111) =>
  `---\nid: ${id}\nbucket: unfiled\nat: ${stamp}\nsource: telegram\n---\n\n${text}\n`

/** Stands in for the bot's GitHub Contents client. */
function fakeInbox({ files = {}, buckets = ['atlas', 'ideas'] } = {}) {
  const moved = []
  return {
    moved,
    files,
    readBuckets: async () => buckets,
    listDir: async (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => ({ name: p.split('/').pop(), path: p })),
    getFile: async (path) => (path in files ? { content: files[path], sha: `sha-${path}` } : null),
    move: async (from, to) => {
      moved.push([from, to])
      files[to] = files[from]
      delete files[from]
      return true
    },
  }
}

async function project(name = 'Atlas') {
  const home = await mkdtemp(join(tmpdir(), 'docket-drain-home-'))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-')))
  const registryFile = join(home, 'projects.json')
  await mkdir(join(root, '.docket'), { recursive: true })
  await writeFile(
    join(root, '.docket', 'config.json'),
    `${JSON.stringify(defaultConfig(name), null, 2)}\n`,
  )
  await writeFile(
    join(root, '.docket', 'board.json'),
    `${JSON.stringify({ rev: 5, updatedAt: '2026-08-21T00:00:00.000Z', cards: [] }, null, 2)}\n`,
  )
  await addProject(registryFile, { path: root, name, now: at })
  return {
    root,
    registryFile,
    board: async () => JSON.parse(await readFile(join(root, '.docket', 'board.json'), 'utf8')),
  }
}

// ---- pieces ---------------------------------------------------------------

test('parseCapture reads the frontmatter and the body', () => {
  const parsed = parseCapture(capture('This is a test'))
  assert.equal(parsed.text, 'This is a test')
  assert.equal(parsed.at, '2026-08-21T19:31:31.903Z')
  assert.equal(parsed.id, '111')
})

test('parseCapture survives a file with no frontmatter', () => {
  assert.equal(parseCapture('just words').text, 'just words')
})

test('firstLine truncates long notes for the title', () => {
  assert.equal(firstLine('one\ntwo'), 'one')
  assert.equal(firstLine('x'.repeat(100), 10), `${'x'.repeat(9)}…`)
})

test('a short capture becomes a title with no redundant detail', () => {
  const card = captureToCard({
    text: 'This is a test',
    at: '2026-08-21T19:31:31.903Z',
    bucket: 'atlas',
    column: 'inbox',
    id: '111',
    now: at,
  })
  assert.equal(card.title, 'This is a test')
  assert.equal(card.detail, '', 'the detail would just repeat the title')
  assert.deepEqual(card.tags, ['captured'])
  assert.equal(card.column, 'inbox')
  assert.match(card.origin, /telegram · 2026-08-21/)
})

test('a long capture keeps the whole text in the detail', () => {
  const text = `${'a'.repeat(90)}\nsecond line`
  const card = captureToCard({ text, at: null, bucket: 'x', column: 'inbox', id: '1', now: at })
  assert.ok(card.title.endsWith('…'))
  assert.equal(card.detail, text, 'nothing the owner typed may be lost to truncation')
})

test('a drained card is authored by the owner, not Claude', () => {
  const card = captureToCard({ text: 'mine', at: null, bucket: 'x', column: 'inbox', id: '1', now: at })
  // Getting this wrong would give every drained card an unread dot, as though
  // Claude had said something.
  assert.equal(card.createdBy, 'owner')
})

// ---- the drain ------------------------------------------------------------

test('a capture in a mapped bucket becomes a card and the file is filed', async () => {
  const p = await project()
  const inbox = fakeInbox({
    files: { 'captures/atlas/2026-08-21T19-31-31Z-111.md': capture('This is a test') },
  })
  const report = await drain({ inbox, registryFile: p.registryFile, now: at })

  assert.equal(report.drained.length, 1)
  assert.equal(report.drained[0].project, 'atlas')

  const doc = await p.board()
  assert.equal(doc.cards.length, 1)
  assert.equal(doc.cards[0].title, 'This is a test')
  assert.equal(doc.rev, 6)

  assert.deepEqual(inbox.moved, [
    ['captures/atlas/2026-08-21T19-31-31Z-111.md', 'filed/atlas/2026-08-21T19-31-31Z-111.md'],
  ])
})

test('a bucket with no matching project is reported, never dropped', async () => {
  const p = await project()
  const inbox = fakeInbox({
    files: { 'captures/ideas/2026-08-21T19-31-33Z-222.md': capture('an idea') },
  })
  const report = await drain({ inbox, registryFile: p.registryFile, now: at })

  assert.equal(report.drained.length, 0)
  assert.deepEqual(report.unmapped, [{ bucket: 'ideas', count: 1 }])
  assert.equal(inbox.moved.length, 0, 'an unmapped capture must stay where it is')
  assert.ok('captures/ideas/2026-08-21T19-31-33Z-222.md' in inbox.files)
})

test('the bucket comes from the directory, not the stale frontmatter', async () => {
  const p = await project()
  // The bot moves the file on a bucket tap but leaves `bucket: unfiled` behind.
  const inbox = fakeInbox({
    files: { 'captures/atlas/2026-08-21T19-31-31Z-111.md': capture('tapped into atlas') },
  })
  const report = await drain({ inbox, registryFile: p.registryFile, now: at })
  assert.equal(report.drained[0].project, 'atlas')
})

test('draining twice does not create a duplicate card', async () => {
  const p = await project()
  const file = 'captures/atlas/2026-08-21T19-31-31Z-111.md'
  const inbox = fakeInbox({ files: { [file]: capture('once only') } })

  await drain({ inbox, registryFile: p.registryFile, now: at })
  // Put the capture back, as a failed move would have.
  inbox.files[file] = capture('once only')
  await drain({ inbox, registryFile: p.registryFile, now: at })

  const doc = await p.board()
  assert.equal(doc.cards.length, 1, 'the capture id makes a re-drain a no-op')
})

test('dry run reports what would happen and changes nothing', async () => {
  const p = await project()
  const inbox = fakeInbox({
    files: { 'captures/atlas/2026-08-21T19-31-31Z-111.md': capture('This is a test') },
  })
  const report = await drain({ inbox, registryFile: p.registryFile, now: at, dryRun: true })

  assert.equal(report.drained[0].dryRun, true)
  assert.equal((await p.board()).cards.length, 0)
  assert.equal(inbox.moved.length, 0)
})

test('an empty capture is skipped with a reason rather than becoming a blank card', async () => {
  const p = await project()
  const inbox = fakeInbox({
    files: { 'captures/atlas/2026-08-21T19-31-31Z-111.md': capture('   ') },
  })
  const report = await drain({ inbox, registryFile: p.registryFile, now: at })
  assert.equal(report.drained.length, 0)
  assert.match(report.skipped[0].reason, /empty/)
})

test('existing cards keep their order, with the capture on top', async () => {
  const p = await project()
  const doc = JSON.parse(await readFile(join(p.root, '.docket', 'board.json'), 'utf8'))
  doc.cards = ['a', 'b'].map((id) => ({
    id,
    title: id,
    detail: '',
    tags: [],
    column: 'inbox',
    flag: false,
    notes: [],
    origin: '',
    createdBy: 'owner',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    columnSince: '2026-08-20T00:00:00.000Z',
    attachments: [],
  }))
  await writeFile(join(p.root, '.docket', 'board.json'), `${JSON.stringify(doc, null, 2)}\n`)

  const inbox = fakeInbox({
    files: { 'captures/atlas/2026-08-21T19-31-31Z-111.md': capture('newest') },
  })
  await drain({ inbox, registryFile: p.registryFile, now: at })

  const after = await p.board()
  assert.deepEqual(after.cards.map((c) => c.title).slice(1), ['a', 'b'])
  assert.equal(after.cards[0].title, 'newest')
})

// ---- what a drained line may say, and where ------------------------------

test('a terminal gets the title; a log file never does', () => {
  // The rule from CLAUDE.md: logs carry ids and paths only. Under launchd,
  // stdout IS a log file, so the same print that is fine interactively becomes a
  // persistent file holding the owner's private note text.
  const item = { project: 'docket', id: 'capture-961383753', title: 'my private thought' }
  assert.match(drainLine(item, { tty: true }), /my private thought/)
  assert.doesNotMatch(drainLine(item, { tty: false }), /my private thought/)
  assert.match(drainLine(item, { tty: false }), /capture-961383753/)
})

test('every drain outcome is still distinguishable without the title', () => {
  const base = { project: 'docket', id: 'capture-1', title: 'secret' }
  assert.match(drainLine(base, { tty: false }), /^drained /)
  assert.match(drainLine({ ...base, dryRun: true }, { tty: false }), /^would drain /)
  assert.match(drainLine({ ...base, duplicate: true }, { tty: false }), /^already on board /)
  // None of them leak, whichever branch is taken.
  for (const extra of [{}, { dryRun: true }, { duplicate: true }]) {
    assert.doesNotMatch(drainLine({ ...base, ...extra }, { tty: false }), /secret/)
  }
})

test('a report item with no id still produces a usable line', () => {
  const line = drainLine({ project: 'docket', title: 'x' }, { tty: false })
  assert.doesNotMatch(line, /\bx\b/)
  assert.match(line, /no id/)
})

test('the drain report carries an id, so a safe line has something to name', () => {
  // drainLine falls back to "(no id)" — useful as a guard, useless as a log. The
  // report has to supply the id for the non-TTY path to be worth anything.
  const source = readFileSync(fileURLToPath(new URL('../src/drain.js', import.meta.url)), 'utf8')
  const pushes = source.match(/report\.drained\.push\(\{[\s\S]*?\}\)/g) ?? []
  assert.ok(pushes.length >= 2, 'expected both the dry-run and the real push')
  for (const push of pushes) assert.match(push, /\bid\b/)
})

test('a dry run says already-on-board for a capture the board already holds', async () => {
  const p = await project()
  const file = 'captures/atlas/2026-08-21T19-31-31Z-111.md'
  const inbox = fakeInbox({ files: { [file]: capture('once only') } })
  await drain({ inbox, registryFile: p.registryFile, now: at })

  // The same frontmatter id under a different filename — the case a real
  // failed move produces, and the one a dry run exists to predict honestly.
  inbox.files['captures/atlas/2026-08-21T19-40-00Z-111.md'] = capture('once only')
  const report = await drain({ inbox, registryFile: p.registryFile, now: at, dryRun: true })

  assert.equal(report.drained.length, 1)
  assert.equal(report.drained[0].duplicate, true, 'a dry run must read the board before predicting')
  assert.match(drainLine(report.drained[0], { tty: false }), /^already on board/)

  const doc = await p.board()
  assert.equal(doc.cards.length, 1, 'a dry run must not write the board')
  assert.equal(
    'captures/atlas/2026-08-21T19-40-00Z-111.md' in inbox.files,
    true,
    'a dry run must not move the capture',
  )
})

test('a dry run predicts would-drain for a genuinely new capture', async () => {
  const p = await project()
  const inbox = fakeInbox({
    files: { 'captures/atlas/2026-08-21T19-31-31Z-111.md': capture('brand new') },
  })
  const report = await drain({ inbox, registryFile: p.registryFile, now: at, dryRun: true })
  assert.equal(report.drained.length, 1)
  assert.notEqual(report.drained[0].duplicate, true)
  assert.match(drainLine(report.drained[0], { tty: false }), /^would drain/)
})
