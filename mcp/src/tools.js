import { join } from 'node:path'

import { normalizeCard } from '../../board/src/card.js'
import { columnKeys, readConfig } from '../../board/src/config.js'
import { canonical, findProjectRoot, readRegistry } from '../../board/src/registry.js'
import { readBoard, writeBoard } from '../../board/src/store.js'
import { LOOP_COLUMN, parseBrief } from '../../board/ui/brief.js'
import { formatDuration, totalMs } from '../../board/ui/time.js'
// removeTodo is deliberately NOT imported: the bridge has no code path that
// could call it. That is the refusal, enforced by absence rather than by a
// check that could be edited away.
import { addTodo, newTodoId, setDone } from '../../board/ui/todos.js'

/**
 * The seven board tools, as pure functions over the store.
 *
 * Deliberately free of the MCP SDK and of zod: `server.js` is the only file that
 * knows about the protocol, so this logic is testable with zero dependencies and
 * survives an SDK churn untouched.
 *
 * Writes go **straight to the board file**, not through the daemon's HTTP API.
 * That means the tools work with nothing else running — Claude can triage at 2am
 * — and when a browser is open, the daemon's watcher sees the write and pushes
 * it over SSE within ~100ms. This is the payoff of the two-process split.
 */

export const AUTHOR = 'claude'

const boardFileFor = (root) => join(root, '.docket', 'board.json')
const configFileFor = (root) => join(root, '.docket', 'config.json')

/**
 * Resolves a project to its **canonical** root directory. An explicit slug goes
 * through the registry; otherwise walk up from cwd, which is the project Claude
 * Code was launched in.
 *
 * Canonical on both sides matters: the registry stores realpaths, and a cwd
 * inside a symlinked directory would otherwise never match its own entry.
 */
export async function resolveProject({ project, cwd, registryFile }) {
  if (project) {
    const registry = await readRegistry(registryFile)
    const entry = registry.projects.find((p) => p.slug === project)
    if (!entry) {
      const known = registry.projects.map((p) => p.slug).join(', ') || 'none registered'
      throw new Error(`unknown project "${project}". Known: ${known}`)
    }
    return { root: entry.path, slug: entry.slug, name: entry.name }
  }

  const root = await findProjectRoot(await canonical(cwd))
  if (!root) {
    throw new Error(
      `no Docket board here. ${cwd} is not inside a project with .docket/board.json — ` +
        'run `docket init` in the project, or pass an explicit project slug.',
    )
  }
  const registry = await readRegistry(registryFile)
  const entry = registry.projects.find((p) => p.path === root)
  return { root, slug: entry?.slug ?? null, name: entry?.name ?? root.split('/').pop() }
}

/** Read-modify-write with one retry, since the browser may write between our read and write. */
async function mutate({ root, apply }) {
  const config = await readConfig(configFileFor(root))
  if (!config) throw new Error(`${root} has no .docket/config.json — run \`docket init\``)
  const keys = columnKeys(config)

  for (let attempt = 1; attempt <= 2; attempt++) {
    const doc = (await readBoard(boardFileFor(root))) ?? { rev: 0, cards: [] }
    const outcome = apply(doc.cards, keys)
    const result = await writeBoard(
      boardFileFor(root),
      { rev: doc.rev, cards: doc.cards },
      { columnKeys: keys },
    )
    if (result.ok) return { rev: result.rev, ...outcome }
    if (result.conflict && attempt === 1) continue
    if (result.conflict) throw new Error('the board changed twice while writing; try again')
    throw new Error(`invalid board: ${result.errors.join('; ')}`)
  }
}

const stamp = () => new Date().toISOString()

/**
 * The shape a card takes in a tool result. Attachments carry an absolute path so
 * Claude can read the image directly — but see CLAUDE.md: reading one is a model
 * prompt, and a family-tree screenshot may show living relatives.
 */
function briefFor(detail) {
  const { values, missing, complete } = parseBrief(detail)
  return { complete, missing, ...values }
}

export function presentCard(card, root) {
  return {
    id: card.id,
    title: card.title,
    detail: card.detail,
    tags: card.tags,
    column: card.column,
    flag: card.flag,
    origin: card.origin,
    createdBy: card.createdBy,
    columnSince: card.columnSince || null,
    // Time worked, READ-ONLY through this bridge: the log is the owner's record
    // of the owner's hours. Claude reads it — the metrics conversation needs
    // effort next to cycle time — and no tool here starts, stops or edits it.
    time: {
      running: card.time?.running ?? null,
      total: formatDuration(totalMs(card.time)),
      sessions: card.time?.sessions ?? [],
    },
    // editedAt only when there is one: absent and null mean different things,
    // and this map drops any field it does not name.
    notes: card.notes.map((n) => ({
      author: n.author,
      at: n.at,
      text: n.text,
      ...(n.editedAt ? { editedAt: n.editedAt } : {}),
    })),
    // Loop cards report their brief, so the pre-flight pass is mechanical:
    // a card with nothing checkable under "Done when" gets escalated before any
    // work starts, rather than guessed at for four hours.
    ...(card.column === LOOP_COLUMN ? { brief: briefFor(card.detail) } : {}),
    // Subtasks, READ-WRITE through this bridge, unlike time. The board is
    // shared state: the owner writes the list, and Claude works it.
    todos: (card.todos ?? []).map((t) => ({
      id: t.id,
      text: t.text,
      done: t.done === true,
      doneBy: t.doneBy ?? null,
      doneAt: t.doneAt ?? null,
    })),
    attachments: (card.attachments ?? []).map((a) => ({
      file: a.file,
      kind: a.kind,
      addedBy: a.addedBy ?? 'owner',
      path: join(root, '.docket', 'attachments', a.file),
    })),
  }
}

export function createTools({ registryFile, cwd }) {
  const where = (project) => resolveProject({ project, cwd, registryFile })

  return {
    async projects() {
      const registry = await readRegistry(registryFile)
      const out = []
      for (const entry of registry.projects) {
        const doc = await readBoard(boardFileFor(entry.path)).catch(() => null)
        const config = await readConfig(configFileFor(entry.path)).catch(() => null)
        out.push({
          slug: entry.slug,
          name: entry.name,
          path: entry.path,
          cards: doc?.cards.length ?? 0,
          rev: doc?.rev ?? 0,
          columns: config?.columns.map((c) => c.key) ?? [],
          boardMissing: doc === null,
        })
      }
      return { projects: out }
    },

    async board({ project, column, tag } = {}) {
      const { root, slug, name } = await where(project)
      const doc = await readBoard(boardFileFor(root))
      if (!doc) throw new Error(`${root} has no board — run \`docket init\``)

      let cards = doc.cards
      if (column) cards = cards.filter((c) => c.column === column)
      if (tag) cards = cards.filter((c) => c.tags.includes(tag))

      const counts = {}
      for (const card of doc.cards) counts[card.column] = (counts[card.column] ?? 0) + 1

      return {
        project: slug,
        name,
        rev: doc.rev,
        total: doc.cards.length,
        counts,
        cards: cards.map((c) => presentCard(c, root)),
      }
    },

    async add({ project, title, detail, tags, column, note, origin } = {}) {
      if (!title || !String(title).trim()) throw new Error('title is required')
      const { root, slug } = await where(project)
      const id = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const at = stamp()

      const outcome = await mutate({
        root,
        apply: (cards, keys) => {
          const target = column ?? keys[0]
          if (!keys.includes(target)) {
            throw new Error(`unknown column "${target}". Columns: ${keys.join(', ')}`)
          }
          cards.unshift(
            normalizeCard({
              id,
              title: String(title),
              detail: detail ? String(detail) : '',
              tags: Array.isArray(tags) ? tags : [],
              column: target,
              // Provenance, kept short: channel · id · date · link. The panel's
              // Source row and the card face show it; a note is not the place.
              origin: origin ? String(origin) : '',
              notes: note ? [{ author: AUTHOR, at, text: String(note) }] : [],
              createdBy: AUTHOR,
              createdAt: at,
              updatedAt: at,
              columnSince: at,
            }),
          )
          return { id, column: target }
        },
      })
      return { project: slug, ...outcome }
    },

    async update({ project, id, title, detail, tags, column, flag } = {}) {
      if (!id) throw new Error('id is required')
      const { root, slug } = await where(project)

      const outcome = await mutate({
        root,
        apply: (cards, keys) => {
          const card = cards.find((c) => c.id === id)
          if (!card) throw new Error(`no card "${id}" on this board`)
          if (column !== undefined && !keys.includes(column)) {
            throw new Error(`unknown column "${column}". Columns: ${keys.join(', ')}`)
          }
          const before = card.column
          if (title !== undefined) card.title = String(title)
          if (detail !== undefined) card.detail = String(detail)
          if (tags !== undefined) card.tags = tags.map(String)
          if (column !== undefined) card.column = column
          if (flag !== undefined) card.flag = flag === true
          card.updatedAt = stamp()
          if (card.column !== before) card.columnSince = stamp()
          return { id, column: card.column, movedFrom: card.column === before ? null : before }
        },
      })
      return { project: slug, ...outcome }
    },

    async note({ project, id, text } = {}) {
      if (!id) throw new Error('id is required')
      if (!text || !String(text).trim()) throw new Error('text is required')
      const { root, slug } = await where(project)

      const outcome = await mutate({
        root,
        apply: (cards) => {
          const card = cards.find((c) => c.id === id)
          if (!card) throw new Error(`no card "${id}" on this board`)
          card.notes.push({ author: AUTHOR, at: stamp(), text: String(text) })
          card.updatedAt = stamp()
          return { id, notes: card.notes.length }
        },
      })
      return { project: slug, ...outcome }
    },

    /**
     * Work the checklist on a card.
     *
     * add / tick / untick only. REMOVE IS REFUSED: Claude may work the list,
     * not decide what is on it. Deleting a step the owner wrote is the one
     * operation here with no good failure story, and the refusal is the same
     * instinct as never moving a card into Loop on your own behalf.
     */
    async todo({ project, id, todoId, text, action } = {}) {
      if (!id) throw new Error('id is required')
      if (action === 'remove') {
        throw new Error('removing a todo is the owner\'s call — tick, untick or add, or say what should go')
      }
      if (!['add', 'tick', 'untick'].includes(action)) {
        throw new Error('action must be one of add, tick, untick')
      }
      const { root, slug } = await where(project)

      const outcome = await mutate({
        root,
        apply: (cards) => {
          const card = cards.find((c) => c.id === id)
          if (!card) throw new Error(`no card "${id}" on this board`)
          // readBoard never normalises (only a write does), so a card that
          // predates this field arrives here with no todos key at all — same
          // lazy-init idiom as time.js's `if (!card.time) card.time =
          // emptyTime()`, applied at the one write path that needs it.
          if (!Array.isArray(card.todos)) card.todos = []
          if (action === 'add') {
            const newId = newTodoId()
            if (!addTodo(card.todos, { id: newId, text: String(text ?? '') })) {
              throw new Error('a todo needs text')
            }
            card.updatedAt = stamp()
            return { id, todoId: newId, todos: card.todos.length }
          }
          if (!todoId) throw new Error('todoId is required to tick or untick')
          if (!setDone(card.todos, todoId, action === 'tick', { by: AUTHOR, at: stamp() })) {
            throw new Error(`no todo "${todoId}" on this card, or it was already ${action}ed`)
          }
          card.updatedAt = stamp()
          return { id, todoId, done: action === 'tick' }
        },
      })
      return { project: slug, ...outcome }
    },

    async remove({ project, id } = {}) {
      if (!id) throw new Error('id is required')
      const { root, slug } = await where(project)

      const outcome = await mutate({
        root,
        apply: (cards) => {
          const index = cards.findIndex((c) => c.id === id)
          if (index === -1) throw new Error(`no card "${id}" on this board`)
          const [card] = cards.splice(index, 1)
          return { id, title: card.title }
        },
      })
      return { project: slug, ...outcome }
    },
  }
}
