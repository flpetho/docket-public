/**
 * The card detail modal — centred, as the owner prefers. The improvement over
 * the predecessor is what is inside it: every textarea grows with its content
 * (the old fixed 56px box held notes up to 510 characters), and notes are an
 * authored thread rather than one field two people overwrite.
 */

import { linkify, relativeAge, tagColor } from './render.js'
import { BRIEF_FIELDS, LOOP_COLUMN, joinBrief, parseBrief, splitBrief } from './brief.js'
import { splitNote } from './note-lead.js'
import {
  formatBudget,
  formatDuration,
  formatSession,
  formatSessionParts,
  localIso,
  localParts,
  spanFromDuration,
  totalMs,
  validSpan,
} from './time.js'
import { PHONE_QUERY } from './phone.js'

/** Grows a textarea to fit its content. Five lines, and it works everywhere. */
export function autoGrow(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

/**
 * What dismissing the modal right now would throw away.
 *
 * Pure and exported so the draft-versus-committed decision has coverage. The
 * first version of this shipped as a closure with no test, and a gate pointed out
 * that the whole distinction was therefore unverified — which is how three
 * handlers that still wrote to the board from a draft got through.
 *
 * A draft counts as dirty only if the owner CHANGED something: the work column
 * pre-fills the contract skeleton, so comparing against the detail as opened is
 * what stops an untouched draft asking a pointless question.
 */
export function unsavedParts({ draft, draftDetailAtOpen, noteText }) {
  const bits = []
  if (draft && (String(draft.title ?? '').trim() || draft.detail !== draftDetailAtOpen)) {
    bits.push('this card')
  }
  if (String(noteText ?? '').trim()) bits.push('a note')
  return bits
}

export function createModal({ elements, config, project, onChange, onAddNote, onCreate, onDelete, onNotice, onMoveBoard, onTimer, onDeleteNote }) {
  const attachmentUrl = (file) =>
    `/api/attachment?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`
  let openId = null
  let current = null
  // An uncommitted card. In MEMORY ONLY — never a board file and never
  // localStorage, because the browser is not authoritative and a draft is not
  // board state. It is lost on reload, and that is the honest trade.
  let draft = null
  let draftDetailAtOpen = ''

  for (const field of [elements.title, elements.detail, elements.newNote]) {
    field.addEventListener('input', () => autoGrow(field))
  }

  // The Loop Contract as six fields — a form over the detail text. splitBrief
  // reads the prose and the six values out of card.detail; joinBrief writes them
  // back, so the parser, the verifier, the pre-flight report and the snapshot
  // keep reading ONE combined text. Detail shows only the prose. On every card,
  // collapsed unless the card is in Loop or already has contract content.
  // Spec: docs/specs/2026-09-16-panel-refinements-design.md
  const fieldInputs = new Map()
  let contractCardId = null
  const currentValues = () => Object.fromEntries([...fieldInputs].map(([key, input]) => [key, input.value]))
  const paintContractStatus = (detail) => {
    if (!elements.contractStatus) return
    const { values, missing } = parseBrief(detail)
    const any = Object.values(values).some(Boolean)
    elements.contractStatus.textContent = !any ? '· empty' : missing.length ? `· needs ${missing.join(' + ')}` : '· complete'
  }
  const buildContract = () => {
    const root = elements.contract
    if (!root) return
    const summary = document.createElement('summary')
    summary.className = 'micro'
    const title = document.createElement('span')
    title.textContent = 'Loop Contract'
    const status = document.createElement('span')
    status.className = 'contract-status'
    summary.append(title, status)
    elements.contractStatus = status
    root.replaceChildren(summary)
    for (const field of BRIEF_FIELDS) {
      const blockEl = document.createElement('div')
      blockEl.className = 'contract-block'
      const head = document.createElement('div')
      head.className = 'contract-head'
      const label = document.createElement('label')
      label.className = field.required ? 'micro req' : 'micro'
      label.textContent = field.required ? `${field.label} · required` : field.label
      label.htmlFor = `f-contract-${field.key}`
      const info = document.createElement('button')
      info.type = 'button'
      info.className = 'info-toggle'
      info.textContent = 'i'
      info.setAttribute('aria-label', `About ${field.label}`)
      info.setAttribute('aria-expanded', 'false')
      head.append(label, info)
      const input = document.createElement('textarea')
      input.id = `f-contract-${field.key}`
      input.className = 'contract-field grow'
      input.rows = 1
      input.placeholder = field.hint
      input.dataset.key = field.key
      const more = document.createElement('div')
      more.className = 'field-info'
      more.hidden = true
      const example = document.createElement('pre')
      example.className = field.weak ? 'guide-example guide-strong' : 'guide-example'
      example.textContent = field.example
      if (field.weak) {
        const weak = document.createElement('s')
        weak.className = 'guide-weak'
        weak.textContent = field.weak
        const why = document.createElement('div')
        why.className = 'guide-why'
        why.textContent = field.why
        more.append(weak, example, why)
      } else {
        more.append(example)
      }
      info.addEventListener('click', () => {
        more.hidden = !more.hidden
        info.setAttribute('aria-expanded', String(!more.hidden))
      })
      input.addEventListener('input', () => {
        autoGrow(input)
        const detail = joinBrief(elements.detail.value, currentValues())
        applyEdit((card) => {
          card.detail = detail
        })
        paintContractStatus(detail)
      })
      fieldInputs.set(field.key, input)
      blockEl.append(head, input, more)
      root.append(blockEl)
    }
  }
  const paintContract = (card) => {
    if (!elements.contract) return
    const { prose, values } = splitBrief(card.detail)
    elements.detail.value = prose
    for (const [key, input] of fieldInputs) {
      input.value = values[key] ?? ''
      autoGrow(input)
    }
    paintContractStatus(card.detail)
    // Open on arrival for a Loop card or any card with contract content; the
    // owner's own toggle stands for as long as this card is open.
    if (contractCardId === card.id) return
    contractCardId = card.id
    elements.contract.open = card.column === LOOP_COLUMN || Object.values(values).some(Boolean)
  }
  buildContract()

  const renderTags = () => {
    elements.tagChips.textContent = ''
    for (const tag of current.tags) {
      const pill = document.createElement('span')
      pill.className = 'tag-pill'
      pill.style.color = tagColor(tag, config.tags)
      pill.append(document.createTextNode(tag))
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '×'
      remove.title = `Remove ${tag}`
      remove.addEventListener('click', () => {
        applyEdit((card) => {
          card.tags = card.tags.filter((t) => t !== tag)
        })
        // A draft has no board round trip to repaint it.
        if (draft) renderTags()
      })
      pill.append(remove)
      elements.tagChips.append(pill)
    }
  }

  const renderNotes = () => {
    elements.notes.textContent = ''
    if (!current.notes.length) {
      const empty = document.createElement('div')
      empty.className = 'micro dim'
      empty.textContent = 'no notes yet'
      elements.notes.append(empty)
      return
    }
    let index = -1
    for (const note of current.notes) {
      index += 1
      const noteIndex = index
      const wrapper = document.createElement('div')
      wrapper.className = 'note'
      const head = document.createElement('div')
      head.className = 'note-head'
      const author = document.createElement('span')
      author.className = 'micro'
      author.textContent = note.author
      author.style.color = note.author === 'claude' ? 'var(--accent)' : 'var(--muted)'
      const when = document.createElement('span')
      when.className = 'micro dim'
      when.textContent = relativeAge(note.at)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'micro note-remove'
      remove.textContent = 'remove'
      remove.addEventListener('click', () => {
        if (!confirm(`Remove this note by ${note.author}, ${relativeAge(note.at)}?`)) return
        onDeleteNote?.(openId, noteIndex)
      })
      head.append(author, when, remove)
      // The first paragraph shows; the rest opens on demand. Native <details>:
      // no state to keep, keyboard-accessible for free, and the snapshot does
      // exactly the same with the same splitNote. Spec: docs/specs/2026-09-11-note-tldr-design.md
      const { lead, rest } = splitNote(note.text)
      const body = document.createElement('div')
      body.className = 'note-text'
      body.append(linkify(lead))
      wrapper.append(head, body)
      if (rest) {
        const more = document.createElement('details')
        more.className = 'note-more'
        const summary = document.createElement('summary')
        summary.className = 'micro'
        const closed = document.createElement('span')
        closed.className = 'when-closed'
        closed.textContent = 'more'
        const opened = document.createElement('span')
        opened.className = 'when-open'
        opened.textContent = 'less'
        summary.append(closed, opened)
        const restText = document.createElement('div')
        restText.className = 'note-text'
        restText.append(linkify(rest))
        more.append(summary, restText)
        wrapper.append(more)
      }
      elements.notes.append(wrapper)
    }
  }

  // Time worked. The head ticks once a second while a timer runs and the panel
  // is open; the rows are the sessions, newest first, each with its description
  // field. Rebuilding the rows under a field being typed into would destroy the
  // caret, so while one has focus only the head repaints.
  let tick = null
  let focusNewestSession = false
  const stopTick = () => {
    clearInterval(tick)
    tick = null
  }
  const renderTime = () => {
    if (!elements.timeLog) return
    const time = current?.time ?? { running: null, sessions: [] }
    const paintHead = () => {
      const now = Date.now()
      const budget = formatBudget(current ?? {}, now)
      elements.timeTotal.textContent = budget ? budget.text : formatDuration(totalMs(time, now))
      elements.timeTotal.classList.toggle('over', Boolean(budget?.over))
      elements.timeToggle.textContent = time.running
        ? `Stop · ${formatDuration(Math.max(0, now - Date.parse(time.running)), { seconds: true })}`
        : 'Start'
      elements.timeToggle.classList.toggle('running', Boolean(time.running))
    }
    paintHead()
    stopTick()
    if (time.running) tick = setInterval(paintHead, 1000)
    const active = document.activeElement
    if (active?.classList?.contains('session-note') && elements.timeLog.contains(active)) return
    elements.timeLog.textContent = ''
    const sessions = time.sessions ?? []
    // Two lines a log can be scanned by: day and clock on top with the duration
    // right-aligned in tabular figures, the description beneath, wrapping. The
    // eye runs down the right edge for time and down the left for what was done.
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      const session = sessions[index]
      const parts = formatSessionParts(session)
      const row = document.createElement('div')
      row.className = 'session'
      const top = document.createElement('div')
      top.className = 'session-top'
      const when = document.createElement('span')
      when.className = 'micro dim session-when'
      when.textContent = `${parts.day} · ${parts.clock}`
      const duration = document.createElement('span')
      duration.className = 'session-duration'
      duration.textContent = parts.duration
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'micro session-remove'
      remove.textContent = 'remove'
      remove.addEventListener('click', () => {
        if (!confirm(`Remove this session? ${formatSession(session)}`)) return
        onTimer?.(openId, { type: 'delete', index })
      })
      top.append(when, duration, remove)
      const note = document.createElement('textarea')
      note.rows = 1
      note.className = 'session-note grow'
      note.placeholder = 'what was done'
      note.value = session.note ?? ''
      note.addEventListener('input', () => autoGrow(note))
      note.addEventListener('change', () => onTimer?.(openId, { type: 'note', index, text: note.value }))
      row.append(top, note)
      elements.timeLog.append(row)
      autoGrow(note)
      if (focusNewestSession && index === sessions.length - 1) {
        focusNewestSession = false
        queueMicrotask(() => note.focus())
      }
    }
    if (sessions.length) {
      // The column adds up visually. Sessions only — the head also counts a
      // running span, so the two agree whenever nothing is running.
      const foot = document.createElement('div')
      foot.className = 'session-foot'
      const label = document.createElement('span')
      label.className = 'micro dim'
      label.textContent = `${sessions.length} session${sessions.length > 1 ? 's' : ''} · total`
      const sum = document.createElement('span')
      sum.className = 'session-duration'
      sum.textContent = formatDuration(totalMs({ running: null, sessions }, Date.now()))
      foot.append(label, sum)
      elements.timeLog.append(foot)
    }
  }

  // Add time: a session that was not clocked. The form thinks in a local date
  // and clock; minutes and stop are linked both ways, so a person who knows
  // "a 45-minute call" and a person who knows "from 2 to 3" both type what
  // they know, and the card still stores honest instants. One rule, validSpan,
  // is shared with addSession so the panel cannot accept what the model refuses.
  const timeForm = elements.timeForm
  const formInstants = () => ({
    start: localIso(elements.addDate?.value, elements.addStart?.value),
    stop: localIso(elements.addDate?.value, elements.addStop?.value),
  })
  const syncMinutesFromClocks = () => {
    const { start, stop } = formInstants()
    const minutes = start && stop ? Math.round((Date.parse(stop) - Date.parse(start)) / 60e3) : NaN
    elements.addMinutes.value = minutes > 0 ? String(minutes) : ''
  }
  const openTimeForm = () => {
    if (!timeForm) return
    const now = Date.now()
    const stopParts = localParts(new Date(now).toISOString())
    const startParts = localParts(new Date(now - 3600e3).toISOString())
    elements.addDate.value = stopParts.date
    // An hour ago across midnight would put start after stop on one date; start the day instead.
    elements.addStart.value = startParts.date === stopParts.date ? startParts.clock : '00:00'
    elements.addStop.value = stopParts.clock
    elements.addNote.value = ''
    elements.addError.textContent = ''
    syncMinutesFromClocks()
    timeForm.hidden = false
    elements.addNote.focus()
  }
  const closeTimeForm = () => {
    if (timeForm) timeForm.hidden = true
  }
  elements.timeAdd?.addEventListener('click', () => {
    if (!openId || draft) return
    if (timeForm.hidden) openTimeForm()
    else closeTimeForm()
  })
  elements.addCancel?.addEventListener('click', closeTimeForm)
  for (const el of [elements.addDate, elements.addStart, elements.addStop]) el?.addEventListener('input', syncMinutesFromClocks)
  elements.addMinutes?.addEventListener('input', () => {
    const { start } = formInstants()
    const stop = spanFromDuration(start, Number(elements.addMinutes.value))
    if (!stop) return
    const parts = localParts(stop)
    if (parts.date !== elements.addDate.value) {
      elements.addError.textContent = 'that many minutes would end on the next day'
      return
    }
    elements.addError.textContent = ''
    elements.addStop.value = parts.clock
  })
  timeForm?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!openId || draft) return
    const { start, stop } = formInstants()
    const problem = !start || !stop ? 'the date or a time is not valid' : validSpan(start, stop)
    if (problem) {
      elements.addError.textContent = problem
      return
    }
    const outcome = await onTimer?.(openId, { type: 'add', start, stop, note: elements.addNote.value })
    if (outcome === 'lost') {
      elements.addError.textContent = 'could not save — nothing was written'
      return
    }
    closeTimeForm()
  })
  elements.timeToggle?.addEventListener('click', () => {
    if (!openId || draft) return
    const running = Boolean(current?.time?.running)
    // Stop focuses the new row's description so the words can follow the press.
    if (running) focusNewestSession = true
    onTimer?.(openId, { type: running ? 'stop' : 'start' })
  })

  const renderAttachments = () => {
    elements.attachments.textContent = ''
    for (const attachment of current.attachments ?? []) {
      const wrapper = document.createElement('figure')
      wrapper.className = 'attachment'
      if (attachment.kind.startsWith('image/')) {
        const image = document.createElement('img')
        image.src = attachmentUrl(attachment.file)
        image.alt = attachment.file
        // No loading='lazy': the modal starts hidden, and a lazy image in an
        // off-screen container can be deferred indefinitely by the browser.
        wrapper.append(image)
      } else {
        const link = document.createElement('a')
        link.href = attachmentUrl(attachment.file)
        link.target = '_blank'
        link.rel = 'noreferrer'
        link.className = 'micro'
        link.textContent = attachment.file
        wrapper.append(link)
      }
      const caption = document.createElement('figcaption')
      caption.className = 'micro dim'
      caption.textContent = `${attachment.addedBy ?? 'owner'} · ${relativeAge(attachment.addedAt)}`
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'micro'
      remove.textContent = 'remove'
      remove.addEventListener('click', () => {
        applyEdit((card) => {
          card.attachments = card.attachments.filter((a) => a.file !== attachment.file)
        })
        if (draft) renderAttachments()
      })
      caption.append(remove)
      wrapper.append(caption)
      elements.attachments.append(wrapper)
    }
  }

  /** POSTs raw bytes; the daemon hashes them and hands back a reference. */
  const upload = async (blob) => {
    if (draft) {
      elements.dropHint.textContent = 'add the card first — an attachment needs a card'
      return
    }
    if (!openId) return
    elements.dropHint.textContent = 'uploading…'
    try {
      const response = await fetch(`/api/attachment?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'application/octet-stream' },
        body: blob,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        elements.dropHint.textContent = body.error ?? `upload failed (${response.status})`
        return
      }
      const { file, kind } = await response.json()
      elements.dropHint.textContent = 'paste or drop an image'
      // Through the same seam as every other edit, so 'no draft interaction
      // reaches the board' is one line to check rather than four to audit.
      applyEdit((card) => {
        if (!Array.isArray(card.attachments)) card.attachments = []
        if (card.attachments.some((a) => a.file === file)) return
        card.attachments.push({
          file,
          kind,
          addedBy: 'owner',
          addedAt: new Date().toISOString(),
        })
      })
    } catch {
      elements.dropHint.textContent = 'upload failed — daemon unreachable'
    }
  }

  // Paste is the path that matters: a screenshot goes straight from ⌘⇧4 to a card.
  elements.panel.addEventListener('paste', (event) => {
    const items = [...(event.clipboardData?.items ?? [])]
    const file = items.find((item) => item.kind === 'file')?.getAsFile()
    if (!file) return
    event.preventDefault()
    upload(file)
  })
  elements.panel.addEventListener('dragover', (event) => {
    event.preventDefault()
    elements.panel.classList.add('dropping')
  })
  elements.panel.addEventListener('dragleave', () => elements.panel.classList.remove('dropping'))
  elements.panel.addEventListener('drop', (event) => {
    event.preventDefault()
    elements.panel.classList.remove('dropping')
    for (const file of event.dataTransfer?.files ?? []) upload(file)
  })

  const paint = (card) => {
    current = card
    elements.title.value = card.title
    elements.column.value = card.column
    if (elements.board) elements.board.value = project
    elements.flag.checked = card.flag
    if (elements.estimate) elements.estimate.value = card.estimateMinutes ?? ''
    if (elements.due) elements.due.value = card.due ?? ''
    // Source: the provenance line in full, links clickable, then who added the
    // card. Its own row now — a 62-character Trello origin used to wrap inside
    // the Notes header, and the field was never presented as the space it is.
    const by = document.createElement('span')
    by.className = 'dim'
    by.textContent = card.origin ? ` · added by ${card.createdBy}` : `added by ${card.createdBy}`
    elements.origin.replaceChildren(card.origin ? linkify(card.origin) : '', by)
    renderTags()
    renderAttachments()
    renderNotes()
    renderTime()
    paintContract(card)
    for (const field of [elements.title, elements.detail, elements.newNote]) autoGrow(field)
  }

  /**
   * A draft is edited in place and reaches nothing; a committed card goes
   * through onChange and saves as it always has. No repaint on the draft path —
   * the field being typed into already shows the value, and repainting would
   * fight the caret.
   */
  const applyEdit = (fn) => {
    if (draft) return void fn(draft)
    onChange(openId, fn)
  }

  elements.title.addEventListener('input', () =>
    applyEdit((card) => {
      card.title = elements.title.value
    }),
  )
  elements.detail.addEventListener('input', () => {
    // Detail is the prose; the six fields hold the rest. Both write ONE detail.
    const detail = joinBrief(elements.detail.value, currentValues())
    applyEdit((card) => {
      card.detail = detail
    })
    paintContractStatus(detail)
  })
  elements.column.addEventListener('change', () => {
    applyEdit((card) => {
      card.column = elements.column.value
    })
    if (elements.column.value === LOOP_COLUMN && elements.contract) elements.contract.open = true
  })
  elements.flag.addEventListener('change', () =>
    applyEdit((card) => {
      card.flag = elements.flag.checked
    }),
  )
  // Estimate and due: optional, panel only, never on the face (decision log 2026-09-17).
  elements.estimate?.addEventListener('change', () =>
    applyEdit((card) => {
      const raw = elements.estimate.value.trim()
      card.estimateMinutes = raw === '' ? null : Math.max(0, Math.round(Number(raw)))
    }),
  )
  elements.due?.addEventListener('change', () =>
    applyEdit((card) => {
      card.due = elements.due.value || null
    }),
  )
  elements.tagInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const tag = elements.tagInput.value.trim().toLowerCase()
    if (!tag) return
    elements.tagInput.value = ''
    applyEdit((card) => {
      if (!card.tags.includes(tag)) card.tags.push(tag)
    })
    if (draft) renderTags()
  })
  // One commit path, reachable two ways. ⌘↵ was the only way in, and an iOS
  // software keyboard cannot produce ⌘ or Ctrl — so on a phone the note field
  // was a dead end, which breaks the protocol's 'every card gets a note' at
  // exactly the moment the owner is most likely to be holding a phone.
  const commitNote = async () => {
    const text = elements.newNote.value.trim()
    if (!text) return
    if (draft) {
      // Nothing to attach a note to yet. Say so rather than losing it.
      onNotice?.('add the card first — a note needs a card to live on')
      return
    }
    const target = openId
    elements.newNote.value = ''
    autoGrow(elements.newNote)
    const outcome = await onAddNote(target, text)
    // If it never reached the board, put it back. The owner typed it; losing it
    // quietly is the bug this whole card exists to end.
    if (outcome === 'lost' && openId === target) {
      elements.newNote.value = text
      autoGrow(elements.newNote)
    }
  }
  elements.newNote.addEventListener('keydown', (event) => {
    // Plain Enter stays a newline on every viewport. A note is often several
    // lines, and taking Enter away on a phone would trade one dead end for
    // another.
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    commitNote()
  })
  elements.noteAdd?.addEventListener('click', commitNote)
  // The hint has to be true on the device reading it: '⌘↵' is an instruction a
  // phone cannot follow.
  elements.newNote.placeholder = matchMedia(PHONE_QUERY).matches
    ? 'Add a note, then tap Add note'
    : 'Add a note — ⌘↵'
  elements.deleteButton.addEventListener('click', () => {
    if (!openId) return
    if (!confirm(`Delete "${current.title}"? Its notes go with it.`)) return
    const id = openId
    close()
    onDelete(id)
  })

  /** 'Add card' while a draft is open, 'Close' once there is a card to close. */
  const paintFoot = () => {
    if (!elements.commit) return
    elements.commit.textContent = draft ? 'Add card' : 'Close'
    elements.commit.classList.toggle('primary', Boolean(draft))
    if (elements.deleteButton) elements.deleteButton.hidden = Boolean(draft)
    // A draft is not on any board; there is nothing to move.
    if (elements.boardWrap) elements.boardWrap.hidden = Boolean(draft)
    // Nor timed: a draft is not on the board.
    if (elements.timeWrap) elements.timeWrap.hidden = Boolean(draft)
    if (elements.timeLog) elements.timeLog.hidden = Boolean(draft)
    if (elements.timeForm && draft) elements.timeForm.hidden = true
  }

  /** What would be thrown away by dismissing right now. */
  const unsaved = () => unsavedParts({ draft, draftDetailAtOpen, noteText: elements.newNote.value })

  // Board, beside Column: pick another board and the card goes to its Inbox.
  // No confirm — a move is reversible with the same control on the other
  // board, and Column asks nothing either — except when a typed note would
  // otherwise be lost with the card that just left this board.
  elements.board?.addEventListener('change', async () => {
    const to = elements.board.value
    if (!openId || draft || to === project) return
    const pending = unsaved()
    if (pending.length && !confirm(`Discard ${pending.join(' and ')} and move the card?`)) {
      elements.board.value = project
      return
    }
    const outcome = await onMoveBoard?.(openId, to)
    if (outcome?.ok) return void close({ force: true })
    elements.board.value = project // the move did not happen; say so where it was asked
  })

  function open(card) {
    const switching = openId !== card.id
    draft = null
    draftDetailAtOpen = ''
    openId = card.id
    // The note box is ONE textarea shared by every card. Not clearing it here is
    // how a draft followed the owner from card to card and the same text landed
    // on each one.
    if (switching) {
      elements.newNote.value = ''
      autoGrow(elements.newNote)
    }
    // Unhide *before* painting: autoGrow reads scrollHeight, and a hidden
    // element reports zero, which collapsed every field to a single line.
    elements.overlay.hidden = false
    paint(card)
    paintFoot()
  }

  /**
   * Opens a card that does not exist yet. Nothing is written until 'Add card'.
   *
   * [+] used to create the card immediately, which in the work column meant the
   * authorization to start unattended work was produced by opening a form.
   */
  function openDraft(card) {
    draft = card
    draftDetailAtOpen = card.detail
    openId = card.id
    elements.newNote.value = ''
    elements.overlay.hidden = false
    paint(card)
    paintFoot()
    elements.title.focus()
  }

  async function commitDraft() {
    const card = draft
    if (!card) return
    draft = null
    paintFoot()
    const outcome = await onCreate(card)
    if (outcome === 'lost') {
      // Put the owner back where they were rather than pretending it worked.
      draft = card
      paintFoot()
      onNotice?.('could not add the card — nothing was saved')
      return
    }
    openId = card.id
  }

  function refresh(card) {
    if (!card || card.id !== openId) return
    const active = document.activeElement
    // Repainting while someone is typing would fight the caret; the field
    // already holds the newest value.
    if (
      active === elements.title ||
      active === elements.detail ||
      active === elements.newNote ||
      active?.classList?.contains('contract-field') ||
      active?.closest?.('#f-time-form')
    ) {
      current = card
      paintContractStatus(card.detail)
      renderTags()
      renderAttachments()
      renderNotes()
      renderTime()
      return
    }
    paint(card)
  }

  function close({ force = false } = {}) {
    const pending = unsaved()
    if (!force && pending.length && !confirm(`Discard ${pending.join(' and ')}?`)) return
    draft = null
    draftDetailAtOpen = ''
    openId = null
    current = null
    contractCardId = null
    if (elements.timeForm) elements.timeForm.hidden = true
    stopTick()
    elements.newNote.value = ''
    elements.overlay.hidden = true
  }

  elements.commit?.addEventListener('click', () => (draft ? commitDraft() : close()))

  return {
    open,
    openDraft,
    close,
    refresh,
    get openId() { return openId },
    get isDraft() { return draft !== null },
  }
}
