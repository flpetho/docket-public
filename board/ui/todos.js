/**
 * Subtasks inside one card: adding, ticking, removing, counting.
 *
 * EVERYTHING IS ADDRESSED BY ID. A todo list is not append-only — both the
 * owner and Claude can delete from the middle — and the sync layer replays
 * pending mutations onto the server's cards after a 409. A position-addressed
 * tick replayed onto a list somebody else has deleted from ticks a different
 * box, and the board then records Claude completing a step it never touched.
 * That is evidence corruption in the one place the gate exists to prevent it,
 * so the id is not a convenience.
 *
 * Every function returns a boolean saying whether anything changed, which is
 * the answer sync.mutate reads to decide between 'saved' and 'lost'. A no-op
 * returns false on purpose: it costs no rev, and nothing is pushed.
 *
 * Pure and stamp-injected, so it is testable without a clock, and shared by the
 * panel, the face, the snapshot and the bridge.
 */

const find = (todos, id) => (Array.isArray(todos) ? todos.findIndex((t) => t?.id === id) : -1)

/** Shaped like the card ids in app.js and tools.js, so one idiom covers both. */
export const newTodoId = (now = Date.now(), rand = Math.random) =>
  `todo-${now.toString(36)}-${rand().toString(36).slice(2, 6)}`

/** Append one. Refuses an empty text and a duplicate id. */
export function addTodo(todos, { id, text } = {}) {
  if (!Array.isArray(todos)) return false
  const next = String(text ?? '').trim()
  if (!next || !id) return false
  // Two todos sharing an id would make every later mutation ambiguous, which
  // is the one failure this module cannot recover from.
  if (find(todos, id) !== -1) return false
  todos.push({ id, text: next, done: false, doneBy: null, doneAt: null })
  return true
}

/**
 * Tick or untick, recording who and when.
 *
 * Unticking CLEARS the claim. A box that is not done must not carry a record of
 * somebody having done it — that reads as evidence and would be false.
 */
export function setDone(todos, id, done, { by, at } = {}) {
  const index = find(todos, id)
  if (index === -1) return false
  const todo = todos[index]
  if (todo.done === done) return false
  todo.done = done === true
  todo.doneBy = todo.done ? (by ?? null) : null
  todo.doneAt = todo.done ? (at ?? null) : null
  return true
}

export function removeTodo(todos, id) {
  const index = find(todos, id)
  if (index === -1) return false
  todos.splice(index, 1)
  return true
}

/** Done against total, for the face chip and the panel head. */
export function todoProgress(todos) {
  const list = Array.isArray(todos) ? todos : []
  return { done: list.filter((todo) => todo?.done === true).length, total: list.length }
}
