import { briefWarning } from './brief.js'
import { latestVerdict, verdictDate } from './verdict.js'
import { tagColor } from './tag-color.js'
import { formatDuration, totalMs } from './time.js'
import { todoProgress } from './todos.js'

export { tagColor }

/**
 * The board as DOM. No network, no mutation — it receives state and callbacks.
 *
 * The card face carries its own weight on purpose: tags, title, two clamped
 * lines of detail, and the latest note with its author and age. The predecessor
 * showed only a title and a track, which made a card with 300 characters of
 * substance in its detail look empty.
 */

export function relativeAge(iso, nowMs = Date.now()) {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.floor((nowMs - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`
}

/** How long a card has sat where it is. The signal a decision queue lives on. */
export function columnAge(iso, nowMs = Date.now()) {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const hours = Math.floor((nowMs - then) / 3_600_000)
  if (hours < 1) return 'just moved'
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`
}

/** A 1px-stroke glyph, so it sits in the hairline language rather than on it. */
export function imageIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('width', '9')
  svg.setAttribute('height', '9')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1')
  svg.setAttribute('aria-hidden', 'true')
  const frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  frame.setAttribute('x', '0.5')
  frame.setAttribute('y', '1.5')
  frame.setAttribute('width', '11')
  frame.setAttribute('height', '9')
  const hill = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  hill.setAttribute('d', 'M0.5 8.5 L4 5 L7 8 L9 6.5 L11.5 9')
  const sun = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  sun.setAttribute('cx', '8.5')
  sun.setAttribute('cy', '4')
  sun.setAttribute('r', '1')
  svg.append(frame, hill, sun)
  return svg
}

/**
 * What counts as a link, in one place.
 *
 * A factory rather than a constant because a `g` regex carries `lastIndex`, and
 * the static snapshot renderer walks it too — one shared stateful object read
 * from two places is a bug waiting for a coincidence. Exported so the snapshot
 * cannot drift into linkifying a different set of things than the live board.
 */
export const linkPattern = () =>
  /(https?:\/\/\S+)|(\b[0-9a-f]{7,40}\b)|(\b[\w.-]+\/[\w./-]+\.(?:md|ts|tsx|js|json|html|css)\b)/g

/** URLs, repo-relative paths and commit SHAs become links. */
export function linkify(text) {
  const fragment = document.createDocumentFragment()
  const pattern = linkPattern()
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) fragment.append(text.slice(last, match.index))
    const [value, url, sha] = match
    if (url) {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      anchor.textContent = url
      fragment.append(anchor)
    } else if (sha) {
      const code = document.createElement('code')
      code.textContent = sha
      fragment.append(code)
    } else {
      const code = document.createElement('code')
      code.textContent = value
      fragment.append(code)
    }
    last = match.index + value.length
  }
  if (last < text.length) fragment.append(text.slice(last))
  return fragment
}

function cardElement(card, { config, lastSeen, onOpen, onDragStart, onDragEnd }) {
  const element = document.createElement('article')
  element.className = `card${card.flag ? ' flagged' : ''}`
  element.draggable = true
  element.dataset.id = card.id

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  for (const tag of card.tags) {
    const span = document.createElement('span')
    span.className = 'card-tag'
    span.textContent = tag
    span.style.color = tagColor(tag, config.tags)
    meta.append(span)
  }

  const marks = document.createElement('div')
  marks.className = 'card-marks'
  // The gate's ruling, read from the note thread rather than stored twice.
  // Here rather than on its own row: after a night's run this is the thing the
  // eye should find first, and card-marks is where the eye already goes.
  const ruling = latestVerdict(card.notes)
  if (ruling) {
    const chip = document.createElement('span')
    chip.className = 'verdict'
    chip.dataset.verdict = ruling.verdict
    const stamp = verdictDate(ruling.at)
    chip.textContent = stamp ? `${ruling.word} · ${stamp}` : ruling.word
    chip.title = `the gate ruled ${ruling.verdict}`
    marks.append(chip)
  }
  // Unread means a note by somebody else, newer than this browser last looked.
  const foreign = card.notes.filter((note) => note.author !== 'owner')
  const newest = foreign.length ? Math.max(...foreign.map((n) => Date.parse(n.at) || 0)) : 0
  if (newest > lastSeen) {
    const dot = document.createElement('span')
    dot.className = 'unread-dot'
    dot.title = 'new note since you last looked'
    marks.append(dot)
  }
  if (card.flag) {
    const flame = document.createElement('span')
    flame.className = 'micro'
    flame.textContent = '!'
    marks.append(flame)
  }
  meta.append(marks)
  element.append(meta)

  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = card.title
  element.append(title)

  if (card.detail.trim()) {
    const detail = document.createElement('div')
    detail.className = 'card-detail'
    detail.textContent = card.detail
    element.append(detail)
  }

  // A thin contract, on its own row. Not in card-foot: 'needs Acceptance +
  // Verify with' plus the age and the note line overflows the 16.5rem column, and card-foot
  // does not wrap. Not in card-marks either — that zone is for glyphs.
  const warning = briefWarning(card.column, card.detail)
  if (warning) {
    const warn = document.createElement('div')
    warn.className = 'brief-warn micro'
    warn.dataset.brief = warning.missing.join(',')
    warn.textContent = warning.label
    warn.title = 'this card cannot be worked unattended until the contract is complete'
    element.append(warn)
  }

  const foot = document.createElement('div')
  foot.className = 'card-foot'

  if (card.attachments?.length) {
    const chip = document.createElement('span')
    chip.className = 'attach-chip'
    chip.title = `${card.attachments.length} attachment${card.attachments.length > 1 ? 's' : ''}`
    chip.append(imageIcon())
    if (card.attachments.length > 1) {
      const count = document.createElement('span')
      count.textContent = String(card.attachments.length)
      chip.append(count)
    }
    foot.append(chip)
  }

  // Time worked: the total, or 'running' in the accent while a timer runs —
  // the one card the owner is clocked into, visible from across the board.
  const worked = totalMs(card.time)
  if (card.time?.running || worked) {
    const chip = document.createElement('span')
    chip.className = card.time?.running ? 'time-chip running' : 'time-chip'
    chip.textContent = card.time?.running ? 'running' : formatDuration(worked)
    foot.append(chip)
  }

  // Progress inside a card, visible while scanning a column. Only when there
  // are todos: a chip reading 0/0 on every card would be noise.
  const progress = todoProgress(card.todos)
  if (progress.total) {
    const chip = document.createElement('span')
    chip.className = progress.done === progress.total ? 'todo-chip done' : 'todo-chip'
    chip.textContent = `${progress.done}/${progress.total}`
    chip.title = `${progress.done} of ${progress.total} todos done`
    foot.append(chip)
  }

  const age = columnAge(card.columnSince)
  if (age) {
    const span = document.createElement('span')
    span.textContent = age
    foot.append(span)
  }

  if (card.notes.length) {
    const latest = card.notes[card.notes.length - 1]
    const count = document.createElement('span')
    count.textContent = `${card.notes.length} note${card.notes.length > 1 ? 's' : ''} · ${latest.author} ${relativeAge(latest.at)}`
    foot.append(count)
  } else if (card.origin) {
    const origin = document.createElement('span')
    origin.className = 'origin'
    origin.title = card.origin
    origin.textContent = card.origin
    foot.append(origin)
  }
  if (foot.childElementCount) element.append(foot)

  element.addEventListener('click', () => onOpen(card.id))
  element.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', card.id)
    event.dataTransfer.effectAllowed = 'move'
    element.classList.add('dragging')
    onDragStart(card.id)
  })
  element.addEventListener('dragend', () => {
    element.classList.remove('dragging')
    onDragEnd()
  })
  return element
}

export function renderBoard(root, { doc, config, filters, lastSeen, handlers }) {
  root.textContent = ''
  const query = filters.query.trim().toLowerCase()

  const matches = (card) => {
    if (filters.tags.size && !card.tags.some((tag) => filters.tags.has(tag))) return false
    if (!query) return true
    const haystack = [card.title, card.detail, card.origin, ...card.notes.map((n) => n.text)]
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  }

  for (const column of config.columns) {
    const columnElement = document.createElement('section')
    // The key as a class so CSS can treat a terminal column differently.
    columnElement.className = `column col-${column.key}`

    const inColumn = doc.cards.filter((card) => card.column === column.key)
    const shown = inColumn.filter(matches)

    const head = document.createElement('div')
    head.className = 'column-head'
    const name = document.createElement('span')
    name.className = 'micro'
    name.textContent = column.name
    const count = document.createElement('span')
    count.className = 'micro count'
    count.textContent = shown.length === inColumn.length ? String(inColumn.length) : `${shown.length}/${inColumn.length}`
    const add = document.createElement('button')
    add.className = 'add'
    add.textContent = '+'
    add.title = `Add a card to ${column.name}`
    add.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onAdd(column.key)
    })
    head.append(name, count, add)
    columnElement.append(head)

    const list = document.createElement('div')
    list.className = 'cards'
    list.dataset.column = column.key
    for (const card of shown) {
      list.append(cardElement(card, { config, lastSeen, ...handlers }))
    }
    if (!shown.length) {
      const empty = document.createElement('div')
      empty.className = 'column-empty'
      empty.textContent = inColumn.length ? 'nothing matches' : 'empty'
      list.append(empty)
    }

    list.addEventListener('dragover', (event) => {
      event.preventDefault()
      list.classList.add('dragover')
    })
    list.addEventListener('dragleave', () => list.classList.remove('dragover'))
    list.addEventListener('drop', (event) => {
      event.preventDefault()
      list.classList.remove('dragover')
      const id = event.dataTransfer.getData('text/plain')
      const neighbour = event.target.closest?.('.card')
      handlers.onMove(id, column.key, neighbour?.dataset.id ?? null)
    })

    columnElement.append(list)
    root.append(columnElement)
  }
}

export function renderTagFilter(root, { doc, config, filters, onToggle }) {
  root.textContent = ''
  const counts = new Map()
  for (const card of doc.cards) {
    for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1])
  for (const [tag, count] of tags) {
    const button = document.createElement('button')
    button.className = 'tag-chip'
    button.type = 'button'
    button.setAttribute('aria-pressed', String(filters.tags.has(tag)))
    button.textContent = `${tag} ${count}`
    button.style.color = filters.tags.has(tag) ? tagColor(tag, config.tags) : ''
    button.addEventListener('click', () => onToggle(tag))
    root.append(button)
  }
}
