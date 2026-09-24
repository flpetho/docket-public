import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../../board/src/config.js'
import { normalizeCard } from '../../board/src/card.js'
import { addProject } from '../../board/src/registry.js'
import { createTools, presentCard, resolveProject } from '../src/tools.js'

const at = () => new Date('2026-08-21T12:00:00.000Z')

/** A registry with one initialised project holding one card. */
async function sandbox({ cards = [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'docket-mcp-home-'))
  // realpath up front: the registry canonicalises, so the test's expectations must too.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'my-project-')))
  const registryFile = join(home, 'projects.json')
  await mkdir(join(root, '.docket'), { recursive: true })
  await writeFile(
    join(root, '.docket', 'config.json'),
    `${JSON.stringify(defaultConfig('My Project'), null, 2)}\n`,
  )
  await writeFile(
    join(root, '.docket', 'board.json'),
    `${JSON.stringify({ rev: 3, updatedAt: '2026-08-21T00:00:00.000Z', cards }, null, 2)}\n`,
  )
  await addProject(registryFile, { path: root, name: 'My Project', now: at })
  return {
    root,
    registryFile,
    tools: createTools({ registryFile, cwd: root }),
    board: async () => JSON.parse(await readFile(join(root, '.docket', 'board.json'), 'utf8')),
  }
}

const card = (over = {}) => ({
  id: 'c1',
  title: 'A card',
  detail: 'some detail',
  tags: ['strategy'],
  column: 'inbox',
  flag: false,
  notes: [],
  origin: 'chunk 1',
  createdBy: 'owner',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  columnSince: '2026-08-20T00:00:00.000Z',
  attachments: [],
  ...over,
})

// ---- project resolution --------------------------------------------------

test('resolves the project by walking up from cwd', async () => {
  const s = await sandbox()
  const deep = join(s.root, 'a', 'b')
  await mkdir(deep, { recursive: true })
  const found = await resolveProject({ cwd: deep, registryFile: s.registryFile })
  assert.equal(found.root, s.root)
  assert.equal(found.slug, 'my-project')
})

test('an explicit slug wins over cwd', async () => {
  const s = await sandbox()
  const found = await resolveProject({
    project: 'my-project',
    cwd: tmpdir(),
    registryFile: s.registryFile,
  })
  assert.equal(found.root, s.root)
})

test('an unknown slug lists what is known instead of failing blankly', async () => {
  const s = await sandbox()
  await assert.rejects(
    () => resolveProject({ project: 'nope', cwd: s.root, registryFile: s.registryFile }),
    (error) => {
      assert.match(error.message, /unknown project "nope"/)
      assert.match(error.message, /my-project/)
      return true
    },
  )
})

test('a directory with no board says so plainly and suggests docket init', async () => {
  const s = await sandbox()
  await assert.rejects(
    () => resolveProject({ cwd: tmpdir(), registryFile: s.registryFile }),
    (error) => {
      assert.match(error.message, /no Docket board here/)
      assert.match(error.message, /docket init/)
      return true
    },
  )
})

// ---- read ----------------------------------------------------------------

test('board returns cards, counts and the rev', async () => {
  const s = await sandbox({ cards: [card(), card({ id: 'c2', column: 'done' })] })
  const result = await s.tools.board()
  assert.equal(result.project, 'my-project')
  assert.equal(result.rev, 3)
  assert.equal(result.total, 2)
  assert.deepEqual(result.counts, { inbox: 1, done: 1 })
  assert.equal(result.cards.length, 2)
})

test('board filters by column and by tag', async () => {
  const s = await sandbox({
    cards: [card(), card({ id: 'c2', column: 'done', tags: ['tooling'] })],
  })
  assert.equal((await s.tools.board({ column: 'done' })).cards.length, 1)
  assert.equal((await s.tools.board({ tag: 'strategy' })).cards[0].id, 'c1')
  assert.equal((await s.tools.board({ tag: 'absent' })).cards.length, 0)
})

test('an attachment is presented with an absolute path Claude can read', async () => {
  const s = await sandbox({
    cards: [card({ attachments: [{ file: 'a3f9c21e08b4.png', kind: 'image/png' }] })],
  })
  const [only] = (await s.tools.board()).cards
  assert.equal(only.attachments[0].path, join(s.root, '.docket', 'attachments', 'a3f9c21e08b4.png'))
  assert.equal(only.attachments[0].kind, 'image/png')
})

test('projects lists every registered board with its card count', async () => {
  const s = await sandbox({ cards: [card()] })
  const { projects } = await s.tools.projects()
  assert.equal(projects.length, 1)
  assert.equal(projects[0].slug, 'my-project')
  assert.equal(projects[0].cards, 1)
  assert.equal(projects[0].boardMissing, false)
  assert.ok(projects[0].columns.includes('loop'))
})

// ---- write ---------------------------------------------------------------

test('add creates a card authored by claude and bumps the rev', async () => {
  const s = await sandbox()
  const result = await s.tools.add({ title: 'From Claude', detail: 'x', tags: ['tooling'] })
  assert.equal(result.rev, 4)

  const doc = await s.board()
  const added = doc.cards.find((c) => c.id === result.id)
  assert.equal(added.title, 'From Claude')
  assert.equal(added.createdBy, 'claude')
  assert.deepEqual(added.tags, ['tooling'])
  assert.equal(added.column, 'inbox', 'defaults to the first column')
})

test('add can carry an opening note, authored by claude', async () => {
  const s = await sandbox()
  const { id } = await s.tools.add({ title: 'T', note: 'why this exists' })
  const doc = await s.board()
  const added = doc.cards.find((c) => c.id === id)
  assert.equal(added.notes.length, 1)
  assert.equal(added.notes[0].author, 'claude')
  assert.equal(added.notes[0].text, 'why this exists')
})

test('add refuses an unknown column and writes nothing', async () => {
  const s = await sandbox()
  await assert.rejects(() => s.tools.add({ title: 'T', column: 'nowhere' }), /unknown column/)
  assert.equal((await s.board()).cards.length, 0)
})

test('add requires a title', async () => {
  const s = await sandbox()
  await assert.rejects(() => s.tools.add({ title: '   ' }), /title is required/)
})

test('update changes fields and reports the move', async () => {
  const s = await sandbox({ cards: [card()] })
  const result = await s.tools.update({ id: 'c1', column: 'review', flag: true })
  assert.equal(result.movedFrom, 'inbox')
  assert.equal(result.column, 'review')

  const [only] = (await s.board()).cards
  assert.equal(only.column, 'review')
  assert.equal(only.flag, true)
  assert.notEqual(only.columnSince, '2026-08-20T00:00:00.000Z', 'the column clock restarts')
})

test('an update that does not change column leaves columnSince alone', async () => {
  const s = await sandbox({ cards: [card()] })
  const result = await s.tools.update({ id: 'c1', title: 'Renamed' })
  assert.equal(result.movedFrom, null)
  const [only] = (await s.board()).cards
  assert.equal(only.columnSince, '2026-08-20T00:00:00.000Z')
})

test('update refuses an unknown card and an unknown column', async () => {
  const s = await sandbox({ cards: [card()] })
  await assert.rejects(() => s.tools.update({ id: 'nope', title: 'x' }), /no card "nope"/)
  await assert.rejects(() => s.tools.update({ id: 'c1', column: 'nowhere' }), /unknown column/)
})

test('note appends to the thread without touching what is there', async () => {
  const s = await sandbox({
    cards: [card({ notes: [{ author: 'owner', at: '2026-08-20T00:00:00.000Z', text: 'mine' }] })],
  })
  await s.tools.note({ id: 'c1', text: 'merged 4a1b2c3, tests green' })

  const [only] = (await s.board()).cards
  assert.equal(only.notes.length, 2)
  assert.equal(only.notes[0].text, 'mine', "the owner's note is untouched")
  assert.equal(only.notes[1].author, 'claude')
  assert.equal(only.notes[1].text, 'merged 4a1b2c3, tests green')
})

test('note requires text', async () => {
  const s = await sandbox({ cards: [card()] })
  await assert.rejects(() => s.tools.note({ id: 'c1', text: '  ' }), /text is required/)
})

test('remove deletes the card and reports what it was', async () => {
  const s = await sandbox({ cards: [card(), card({ id: 'c2' })] })
  const result = await s.tools.remove({ id: 'c1' })
  assert.equal(result.title, 'A card')
  assert.deepEqual(
    (await s.board()).cards.map((c) => c.id),
    ['c2'],
  )
})

test('a write recovers when the board changed underneath it', async () => {
  const s = await sandbox({ cards: [card()] })
  // Simulate the browser writing between our read and our write: bump the rev
  // once, mid-flight, by patching readBoard's file just before the first write.
  const boardFile = join(s.root, '.docket', 'board.json')
  const original = JSON.parse(await readFile(boardFile, 'utf8'))
  await writeFile(boardFile, `${JSON.stringify({ ...original, rev: 99 }, null, 2)}\n`)

  const result = await s.tools.note({ id: 'c1', text: 'still lands' })
  assert.equal(result.rev, 100)
  assert.equal((await s.board()).cards[0].notes[0].text, 'still lands')
})

test('every card order is preserved through a write', async () => {
  const ids = ['a', 'b', 'c', 'd']
  const s = await sandbox({ cards: ids.map((id) => card({ id })) })
  await s.tools.note({ id: 'c', text: 'x' })
  assert.deepEqual(
    (await s.board()).cards.map((c) => c.id),
    ids,
  )
})

test('a Loop card reports its brief so the pre-flight pass is mechanical', async () => {
  const detail = [
    'Objective: hover feedback on cards',
    'Acceptance: the border reaches --hair-lit within 120ms',
    'Verify with: npm test',
  ].join('\n')
  const s = await sandbox({ cards: [card({ column: 'loop', detail })] })
  const [only] = (await s.tools.board()).cards
  assert.equal(only.brief.complete, true)
  assert.deepEqual(only.brief.missing, [])
  assert.equal(only.brief.verifyWith, 'npm test')
})

test('a Loop card with no acceptance criteria says exactly what is missing', async () => {
  const s = await sandbox({
    cards: [card({ column: 'loop', detail: 'Small motion on the cards.' })],
  })
  const [only] = (await s.tools.board()).cards
  assert.equal(only.brief.complete, false)
  assert.deepEqual(only.brief.missing, ['Acceptance', 'Verify with'])
})

test('cards outside Loop carry no brief, so the field means something', async () => {
  const s = await sandbox({ cards: [card({ column: 'inbox' })] })
  const [only] = (await s.tools.board()).cards
  assert.equal(only.brief, undefined)
})

// ---- time: presented with a total, never written by a tool (spec 2026-09-14) ----

test('the board tool presents time with a total, and update preserves the sessions', async () => {
  const time = {
    running: null,
    sessions: [{ start: '2026-08-20T09:00:00.000Z', stop: '2026-08-20T10:30:00.000Z', note: 'wrote the spec' }],
  }
  const s = await sandbox({ cards: [card({ time })] })
  const shown = (await s.tools.board({})).cards[0]
  assert.deepEqual(shown.time, { running: null, total: '1h 30m', sessions: time.sessions })

  await s.tools.update({ id: 'c1', title: 'Renamed' })
  assert.deepEqual((await s.board()).cards[0].time, time, 'an update through the bridge keeps the log')
})

test('a card from before the timer presents an empty time', async () => {
  const s = await sandbox({ cards: [card()] })
  const shown = (await s.tools.board({})).cards[0]
  assert.deepEqual(shown.time, { running: null, total: '<1m', sessions: [] })
})

// ---- origin: the provenance line, presented as the dedicated space it always was (spec 2026-09-16) ----

test('add records a short provenance line in origin, and the board tool hands it back', async () => {
  const s = await sandbox()
  const origin = 'trello · a1b2c3d4 · https://trello.com/c/a1b2c3d4'
  const { id } = await s.tools.add({ title: 'Imported', origin })
  const doc = await s.board()
  assert.equal(doc.cards.find((c) => c.id === id).origin, origin)
  assert.equal((await s.tools.board({})).cards.find((c) => c.id === id).origin, origin)
})

test('add without origin leaves it empty, as every capture path does', async () => {
  const s = await sandbox()
  const { id } = await s.tools.add({ title: 'Plain' })
  assert.equal((await s.board()).cards.find((c) => c.id === id).origin, '')
})

// ---- editedAt across the bridge (spec: note edit) ----

test('a note keeps its editedAt across the bridge', () => {
  // presentCard rebuilds each note field by field, so a new field is dropped
  // silently unless it is named here. Claude reading a stale note text would
  // then contradict the board the owner is looking at.
  const card = normalizeCard({
    id: 'c1',
    notes: [{ author: 'owner', at: '2026-09-23T10:00:00.000Z', text: 'corrected', editedAt: '2026-09-23T12:00:00.000Z' }],
  })
  const [note] = presentCard(card, '/tmp').notes
  assert.equal(note.editedAt, '2026-09-23T12:00:00.000Z')
  assert.equal(note.text, 'corrected')
})

test('an unedited note carries no editedAt key at all', () => {
  const card = normalizeCard({ id: 'c1', notes: [{ author: 'owner', at: '2026-09-23T10:00:00.000Z', text: 'plain' }] })
  const [note] = presentCard(card, '/tmp').notes
  assert.ok(!('editedAt' in note), 'absent, not null — the two mean different things')
})

// ---- todos across the bridge (spec: note-edit-and-todos) -------------------

test('a card reports its todos across the bridge', () => {
  const card = normalizeCard({
    id: 'c1',
    todos: [{ id: 't1', text: 'read the spec', done: true, doneBy: 'claude', doneAt: '2026-09-23T10:00:00.000Z' }],
  })
  assert.deepEqual(presentCard(card, '/tmp').todos, [
    { id: 't1', text: 'read the spec', done: true, doneBy: 'claude', doneAt: '2026-09-23T10:00:00.000Z' },
  ])
})

test('a card with no todos reports an empty list, not undefined', () => {
  assert.deepEqual(presentCard(normalizeCard({ id: 'c1' }), '/tmp').todos, [])
})

// ---- docket_todo ----------------------------------------------------------

const withTodos = (todos) => card({ todos })

test('the bridge adds a todo and hands back its id', async () => {
  const s = await sandbox({ cards: [withTodos([])] })
  const result = await s.tools.todo({ id: 'c1', action: 'add', text: 'screenshot at 390px' })
  assert.match(result.todoId, /^todo-/)
  const [saved] = (await s.board()).cards[0].todos
  assert.equal(saved.text, 'screenshot at 390px')
  assert.equal(saved.done, false)
  assert.equal(saved.doneBy, null)
})

test('ticking through the bridge records claude, not owner', async () => {
  // The one attribution on this board that can be honest: AUTHOR is a constant,
  // so a box Claude ticked says so and the owner can tell which steps the agent
  // claims from which they did themselves.
  const s = await sandbox({ cards: [withTodos([{ id: 't1', text: 'x', done: false, doneBy: null, doneAt: null }])] })
  await s.tools.todo({ id: 'c1', todoId: 't1', action: 'tick' })
  const [saved] = (await s.board()).cards[0].todos
  assert.equal(saved.done, true)
  assert.equal(saved.doneBy, 'claude')
  assert.ok(saved.doneAt, 'and when')
})

test('unticking through the bridge clears claude\'s claim', async () => {
  const s = await sandbox({
    cards: [withTodos([{ id: 't1', text: 'x', done: true, doneBy: 'claude', doneAt: '2026-09-23T10:00:00.000Z' }])],
  })
  await s.tools.todo({ id: 'c1', todoId: 't1', action: 'untick' })
  const [saved] = (await s.board()).cards[0].todos
  assert.equal(saved.done, false)
  assert.equal(saved.doneBy, null)
  assert.equal(saved.doneAt, null)
})

test('THE REFUSAL: the bridge will not remove a todo, and the board is untouched', async () => {
  // Claude may work the list, not decide what is on it. Deleting a step the
  // owner wrote has no good failure story — the same instinct as never moving
  // a card into Loop on your own behalf.
  const todos = [{ id: 't1', text: 'do not delete me', done: false, doneBy: null, doneAt: null }]
  const s = await sandbox({ cards: [withTodos(todos)] })
  const before = await s.board()
  await assert.rejects(() => s.tools.todo({ id: 'c1', todoId: 't1', action: 'remove' }), /owner/i)
  assert.deepEqual(await s.board(), before, 'nothing was written, not even a rev bump')
})

test('an unknown action is refused rather than guessed at', async () => {
  const s = await sandbox({ cards: [withTodos([])] })
  await assert.rejects(() => s.tools.todo({ id: 'c1', action: 'finish' }), /add, tick, untick/)
})

test('ticking a todo that is not there fails loudly', async () => {
  const s = await sandbox({ cards: [withTodos([])] })
  await assert.rejects(() => s.tools.todo({ id: 'c1', todoId: 'never', action: 'tick' }), /no todo "never"/)
})

test('adding an empty todo is refused', async () => {
  const s = await sandbox({ cards: [withTodos([])] })
  await assert.rejects(() => s.tools.todo({ id: 'c1', action: 'add', text: '   ' }), /text/)
})

test('a todo on a card that is not there fails loudly', async () => {
  const s = await sandbox({ cards: [withTodos([])] })
  await assert.rejects(() => s.tools.todo({ id: 'nope', action: 'add', text: 'x' }), /no card "nope"/)
})

test('THE RAW CARD: a card that predates this field has no todos key at all, and the bridge still works', async () => {
  // readBoard never normalises — only a write does (board/src/store.js) — so
  // every card on every real board today reaches this tool exactly like this:
  // `card()` here carries no `todos` key, not an empty array, because that is
  // what sandbox() writes straight to disk with no normalisation in between.
  // Every other test in this file builds cards through withTodos([...]), which
  // already supplies an array — none of them would have caught this. Found by
  // hand against a real board before this test existed: the bridge
  // threw "a todo needs text" on a card whose text was perfectly fine, because
  // `card.todos` was undefined and addTodo correctly refused it.
  const s = await sandbox({ cards: [card()] })
  const result = await s.tools.todo({ id: 'c1', action: 'add', text: 'first todo on a legacy card' })
  assert.match(result.todoId, /^todo-/)
  const [saved] = (await s.board()).cards[0].todos
  assert.equal(saved.text, 'first todo on a legacy card')
})
