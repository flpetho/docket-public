import { createDropdown } from './dropdown.js'
import { mountPanel } from './panel.js'
import { addSession, deleteSession, setSessionNote, startTimer, stopTimer } from './time.js'
import { addTodo, removeTodo, setDone } from './todos.js'
import { createPager } from './phone.js'
import { renderBoard, renderTagFilter } from './render.js'
import { createSync, loadProjects } from './sync.js'
import { applyEdit } from './note-edit.js'

const boardRoot = document.getElementById('board')
const statusElement = document.getElementById('status')
const nameElement = document.getElementById('project-name')
const switchElement = document.getElementById('project-switch')
const searchElement = document.getElementById('search')
const tagFilterRoot = document.getElementById('tag-filter')

const filters = { tags: new Set(), query: '' }
let config = { columns: [], tags: {}, name: 'Docket', accent: '#ff5227' }
let sync = null
let modal = null

/** Per-browser view state, the one thing legitimately local. */
const seenKey = (slug) => `docket:lastSeen:${slug}`
const readLastSeen = (slug) => Number(localStorage.getItem(seenKey(slug)) ?? 0)
let lastSeen = 0

const setStatus = (kind, text) => {
  statusElement.className = `micro ${kind}`
  statusElement.textContent = text
  // Offline is read-only; the panel knows which of its controls that reaches.
  modal?.setOffline(kind === 'offline')
}

// The board reloads itself when its code changes — but only when nothing is at
// risk (spec 2026-09-16). The browser is never authoritative, so a reload can
// lose only an unsaved draft or a half-typed note; hence: never while a card is
// open. The stamp the tab started with is fetched at boot; a different one on
// the stream means the served code has moved on.
let uiVersion = null
let pendingReload = false
const reloadSoon = () => {
  notice('live', 'new version · reloading', 3000)
  setTimeout(() => location.reload(), 400)
}
const onUiVersion = (version) => {
  if (uiVersion === null) {
    uiVersion = version
    return
  }
  if (version === uiVersion || pendingReload) return
  if (modal && modal.openId !== null) {
    pendingReload = true
    notice('live', 'new version · reloading when you close this card', 120000)
    return
  }
  reloadSoon()
}

let holdUntil = 0
/**
 * A status that survives the next few stream frames. The frame that follows a
 * move says `updated elsewhere · rev N` within ~100ms and would erase
 * "moved to Ideas" before anyone read it.
 */
const notice = (kind, text, holdMs = 4000) => {
  holdUntil = Date.now() + holdMs
  setStatus(kind, text)
}

// Filters live in the hash so a reload keeps them and a view is linkable.
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1))
  filters.query = params.get('q') ?? ''
  filters.tags = new Set((params.get('tags') ?? '').split(',').filter(Boolean))
  searchElement.value = filters.query
}

function writeHash() {
  const params = new URLSearchParams()
  if (filters.query) params.set('q', filters.query)
  if (filters.tags.size) params.set('tags', [...filters.tags].join(','))
  const next = params.toString()
  history.replaceState(null, '', next ? `#${next}` : location.pathname)
}

const cardById = (id) => sync.doc?.cards.find((card) => card.id === id) ?? null
const stamp = () => new Date().toISOString()

const handlers = {
  onOpen: (id) => {
    const card = cardById(id)
    if (card) modal.open(card)
  },
  onDragStart: () => {},
  onDragEnd: () => {},
  onMove: (id, column, beforeId) => {
    sync.mutate((cards) => {
      const index = cards.findIndex((card) => card.id === id)
      if (index === -1) return
      const [card] = cards.splice(index, 1)
      if (card.column !== column) card.columnSince = stamp()
      // No skeleton is written into the detail any more: the Loop Contract
      // section on every card is the skeleton, and it opens itself on a Loop card.
      card.column = column
      card.updatedAt = stamp()
      const target = beforeId && beforeId !== id ? cards.findIndex((c) => c.id === beforeId) : -1
      if (target === -1) cards.push(card)
      else cards.splice(target, 0, card)
    })
  },
  onAdd: (column) => {
    const id = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    // A DRAFT. Nothing is written until the owner presses Add card — pressing [+]
    // on the work column used to create the authorization to start unattended
    // work, before a single character had been typed.
    modal.openDraft({
      id,
      title: '',
      detail: '',
      tags: [],
      column,
      flag: false,
      notes: [],
      origin: '',
      createdBy: 'owner',
      createdAt: stamp(),
      updatedAt: stamp(),
      columnSince: stamp(),
      attachments: [],
    })
  },
}

let pager = null

function paint(doc) {
  renderBoard(boardRoot, { doc, config, filters, lastSeen, handlers })
  // renderBoard rebuilds every column, so the pager restates its label against
  // the new elements rather than holding stale ones.
  pager?.refresh()
  renderTagFilter(tagFilterRoot, {
    doc,
    config,
    filters,
    onToggle: (tag) => {
      if (filters.tags.has(tag)) filters.tags.delete(tag)
      else filters.tags.add(tag)
      writeHash()
      paint(sync.doc)
    },
  })
  modal?.refresh(cardById(modal.openId))
}

async function boot() {
  const projects = await loadProjects()
  if (!projects.length) {
    setStatus('offline', 'no projects registered — run docket init')
    return
  }

  const requested = new URLSearchParams(location.search).get('project')
  const active = projects.find((p) => p.slug === requested) ?? projects[0]

  createDropdown(switchElement, {
    label: 'Project',
    options: projects.map((entry) => ({
      value: entry.slug,
      label: `${entry.name} · ${entry.cards}`,
    })),
    value: active.slug,
  })
  switchElement.addEventListener('change', () => {
    location.search = `?project=${encodeURIComponent(switchElement.value)}`
  })

  nameElement.textContent = active.name
  document.getElementById('dashboard-link').href = `/dashboard?project=${encodeURIComponent(active.slug)}`
  document.title = `${active.name} — Docket`

  const configResponse = await fetch(`/api/config?project=${encodeURIComponent(active.slug)}`)
  if (configResponse.ok) config = await configResponse.json()
  document.documentElement.style.setProperty('--accent', config.accent)

  pager = createPager({
    board: boardRoot,
    prev: document.getElementById('pn-prev'),
    next: document.getElementById('pn-next'),
    label: document.getElementById('pn-label'),
    columnNames: () => config.columns.map((column) => column.name),
  })

  lastSeen = readLastSeen(active.slug)
  readHash()

  sync = createSync({
    project: active.slug,
    onDoc: paint,
    onUiVersion,
    onStatus: (kind, text) => {
      if (Date.now() < holdUntil) return
      setStatus(kind, text)
    },
  })

  modal = mountPanel({
    config,
    project: active.slug,
    projects,
    onChange: (id, apply) => {
      if (!id) return
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return
        const before = card.column
        apply(card)
        card.updatedAt = stamp()
        if (card.column !== before) card.columnSince = stamp()
      })
    },
    onAddNote: (id, text) =>
      // Returns 'saved' or 'lost'. `false` from the mutation means the card is
      // gone, which is the one case a replay cannot rescue.
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return false
        card.notes.push({ author: 'owner', at: stamp(), text })
        card.updatedAt = stamp()
      }),
    onEditNote: (id, key, text) =>
      // Same contract as onAddNote: 'saved' or 'lost'. False from applyEdit
      // means the note is gone, the text is empty, or nothing changed — none
      // of which a replay can rescue, and all of which must put the owner's
      // text back rather than clearing the box.
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return false
        if (!applyEdit(card.notes, key, text, stamp())) return false
        card.updatedAt = stamp()
      }),
    onDeleteNote: (id, index) =>
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card || index < 0 || index >= card.notes.length) return false
        card.notes.splice(index, 1)
        card.updatedAt = stamp()
      }),
    onCreate: (card) =>
      sync.mutate((cards) => {
        cards.unshift(card)
      }),
    onNotice: (message) => notice('offline', message),
    // The timer. One running per board — startTimer stops any other card and
    // logs its session in the same write, so an hour is never counted twice.
    onTimer: (id, action) =>
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return false
        const now = stamp()
        if (action.type === 'start') {
          for (const stoppedId of startTimer(cards, id, now)) {
            const other = cards.find((c) => c.id === stoppedId)
            if (other) other.updatedAt = now
          }
        } else if (action.type === 'stop') stopTimer(card, now)
        else if (action.type === 'note') setSessionNote(card, action.index, action.text)
        else if (action.type === 'delete') deleteSession(card, action.index)
        // Manual entry: the same dispatcher, no second write path. addSession
        // orders by start and refuses an unreal span; the form checked first.
        else if (action.type === 'add') {
          if (!addSession(card, { start: action.start, stop: action.stop, note: action.note })) return false
        }
        card.updatedAt = now
      }),
    // One callback with an action tag, the shape onTimer already uses. Every
    // branch returns the operation's own boolean, so a todo that is gone
    // reports 'lost' rather than a silent no-op.
    onTodo: (id, action) =>
      sync.mutate((cards) => {
        const card = cards.find((c) => c.id === id)
        if (!card) return false
        // GET never normalises (only a write does — board/src/store.js), so a
        // card that predates this field arrives here with no `todos` key at
        // all. Same lazy-init idiom as time.js's `if (!card.time) card.time =
        // emptyTime()`: default it in place rather than making addTodo refuse
        // every legacy card until something else happens to touch it first.
        if (!Array.isArray(card.todos)) card.todos = []
        let changed = false
        if (action.type === 'add') changed = addTodo(card.todos, { id: action.id, text: action.text })
        else if (action.type === 'done') changed = setDone(card.todos, action.id, action.done, { by: 'owner', at: stamp() })
        else if (action.type === 'remove') changed = removeTodo(card.todos, action.id)
        if (!changed) return false
        card.updatedAt = stamp()
      }),
    onMoveBoard: async (id, to) => {
      const response = await fetch(`/api/move?project=${encodeURIComponent(active.slug)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, to }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        notice('offline', body.error ?? `move failed (${response.status})`)
        return { ok: false }
      }
      const name = projects.find((p) => p.slug === to)?.name ?? to
      notice('live', body.duplicate ? body.message : `moved to ${name}`, body.duplicate ? 12000 : 4000)
      // No local mutation: the daemon already rewrote this board, and the
      // stream frame carrying the new rev repaints it. The browser is a client.
      return { ok: true }
    },
    onDelete: (id) => {
      sync.mutate((cards) => {
        const index = cards.findIndex((card) => card.id === id)
        if (index !== -1) cards.splice(index, 1)
      })
    },
  })

  const doc = await sync.load()
  if (!doc) return
  // The stamp this tab runs: asked of the same daemon that just served its files.
  try {
    const { version } = await (await fetch('/api/version')).json()
    if (uiVersion === null) uiVersion = version
  } catch {
    /* an old daemon has no /api/version; then the first stream frame is adopted instead */
  }
  // A reload deferred for an open card happens the moment the panel closes.
  const overlayElement = document.getElementById('overlay')
  new MutationObserver(() => {
    if (pendingReload && overlayElement.hidden) reloadSoon()
  }).observe(overlayElement, { attributes: true, attributeFilter: ['hidden'] })
  sync.listen()
  sync.pollSafety()

  // Opening the board is the act of looking; everything is read from now on.
  const newest = doc.cards
    .flatMap((card) => card.notes)
    .reduce((max, note) => Math.max(max, Date.parse(note.at) || 0), 0)
  localStorage.setItem(seenKey(active.slug), String(Math.max(newest, Date.now())))

  // #f-close is owned by the modal: it is Add card while a draft is open.
  document.getElementById('overlay').addEventListener('click', (event) => {
    if (event.target.id === 'overlay') modal.close()
  })
  searchElement.addEventListener('input', () => {
    filters.query = searchElement.value
    writeHash()
    paint(sync.doc)
  })
  document.addEventListener('keydown', (event) => {
    if (modal.openId || event.metaKey || event.ctrlKey) return
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return
    if (event.key === '/') {
      event.preventDefault()
      searchElement.focus()
    }
    if (event.key === 'n') {
      event.preventDefault()
      handlers.onAdd(config.columns[0].key)
    }
  })
}

boot()
