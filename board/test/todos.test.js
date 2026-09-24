import { test } from 'node:test'
import assert from 'node:assert/strict'

import { addTodo, newTodoId, removeTodo, setDone, todoProgress } from '../ui/todos.js'

const AT = '2026-09-23T12:00:00.000Z'
const list = () => [
  { id: 't1', text: 'read the spec', done: false, doneBy: null, doneAt: null },
  { id: 't2', text: 'write the failing test', done: false, doneBy: null, doneAt: null },
  { id: 't3', text: 'make it pass', done: false, doneBy: null, doneAt: null },
]

// ---- ids ------------------------------------------------------------------

test('an id is stable, unique and shaped like the card ids', () => {
  const a = newTodoId(1758628800000, () => 0.123456)
  const b = newTodoId(1758628800001, () => 0.654321)
  assert.match(a, /^todo-[0-9a-z]+-[0-9a-z]+$/)
  assert.notEqual(a, b)
})

// ---- add ------------------------------------------------------------------

test('a todo is appended with done false and no claim on it', () => {
  const todos = list()
  assert.equal(addTodo(todos, { id: 't4', text: 'screenshot at 390px' }), true)
  assert.deepEqual(todos[3], { id: 't4', text: 'screenshot at 390px', done: false, doneBy: null, doneAt: null })
})

test('an empty todo is refused', () => {
  const todos = list()
  assert.equal(addTodo(todos, { id: 't4', text: '   ' }), false)
  assert.equal(todos.length, 3)
})

test('a duplicate id is refused rather than shadowing the original', () => {
  // Two todos with one id would make every later mutation ambiguous.
  const todos = list()
  assert.equal(addTodo(todos, { id: 't2', text: 'different text' }), false)
  assert.equal(todos.length, 3)
})

// ---- tick -----------------------------------------------------------------

test('ticking records who and when', () => {
  const todos = list()
  assert.equal(setDone(todos, 't2', true, { by: 'claude', at: AT }), true)
  assert.deepEqual(todos[1], { id: 't2', text: 'write the failing test', done: true, doneBy: 'claude', doneAt: AT })
})

test('unticking clears the claim rather than leaving a stale one', () => {
  const todos = list()
  setDone(todos, 't2', true, { by: 'claude', at: AT })
  assert.equal(setDone(todos, 't2', false, { by: 'owner', at: AT }), true)
  assert.deepEqual(todos[1], { id: 't2', text: 'write the failing test', done: false, doneBy: null, doneAt: null })
})

test('THE REPLAY CASE: a tick by id finds the right todo after an earlier one is deleted', () => {
  // The reason todos carry an id at all. The sync layer replays pending
  // mutations onto the server's cards after a 409; a position-addressed tick
  // replayed onto a list somebody deleted from ticks a different box, and the
  // board then records Claude completing a step it never touched.
  const todos = list()
  const key = 't3'
  removeTodo(todos, 't1')
  assert.equal(setDone(todos, key, true, { by: 'claude', at: AT }), true)
  assert.equal(todos.find((t) => t.id === 't3').done, true)
  assert.equal(todos.find((t) => t.id === 't2').done, false, 'the neighbour is untouched')
})

test('ticking a todo that is gone returns false and changes nothing', () => {
  const todos = list()
  assert.equal(setDone(todos, 'never', true, { by: 'owner', at: AT }), false)
  assert.deepEqual(todos, list())
})

test('ticking an already-ticked todo is a no-op, so it costs no rev', () => {
  const todos = list()
  setDone(todos, 't1', true, { by: 'owner', at: AT })
  assert.equal(setDone(todos, 't1', true, { by: 'claude', at: '2026-09-23T13:00:00.000Z' }), false)
  assert.equal(todos[0].doneBy, 'owner', 'the first claim stands')
})

// ---- remove ---------------------------------------------------------------

test('a todo is removed by id', () => {
  const todos = list()
  assert.equal(removeTodo(todos, 't2'), true)
  assert.deepEqual(todos.map((t) => t.id), ['t1', 't3'])
})

test('removing a todo that is gone returns false', () => {
  const todos = list()
  assert.equal(removeTodo(todos, 'never'), false)
  assert.equal(todos.length, 3)
})

// ---- progress -------------------------------------------------------------

test('progress counts done against total', () => {
  const todos = list()
  setDone(todos, 't1', true, { by: 'owner', at: AT })
  setDone(todos, 't2', true, { by: 'claude', at: AT })
  assert.deepEqual(todoProgress(todos), { done: 2, total: 3 })
})

test('progress on a card with no todos is zero of zero, never a crash', () => {
  assert.deepEqual(todoProgress([]), { done: 0, total: 0 })
  assert.deepEqual(todoProgress(undefined), { done: 0, total: 0 })
})

// ---- a card that predates this field ---------------------------------------
// readBoard (board/src/store.js) never normalises — only a write does — so a
// card that has not been saved since `todos` shipped reaches every mutator
// here with no `todos` key at all, not an empty array. That is `undefined`,
// not `[]`, and every mutator must refuse it the same quiet way rather than
// throwing: the callers (app.js's onTodo, mcp's todo tool) both lazily default
// it to `[]` themselves, and this is the contract they rely on to do that
// safely — a throw here would surface as a crash instead of a clean 'lost'.

test('every mutator refuses undefined todos rather than throwing', () => {
  assert.equal(addTodo(undefined, { id: 't1', text: 'x' }), false)
  assert.equal(setDone(undefined, 't1', true, { by: 'owner', at: AT }), false)
  assert.equal(removeTodo(undefined, 't1'), false)
})
