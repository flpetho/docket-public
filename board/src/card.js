import { tagColor } from '../ui/tag-color.js'

export const CARD_KEYS = [
  'id',
  'title',
  'detail',
  'tags',
  'column',
  'flag',
  'notes',
  'origin',
  'createdBy',
  'createdAt',
  'updatedAt',
  'columnSince',
  'estimateMinutes',
  'due',
  'attachments',
  'time',
  'todos',
]

const EPOCH = '1970-01-01T00:00:00.000Z'

/** Fills every key so downstream code never guards for undefined. */
export function normalizeCard(input) {
  const created = typeof input.createdAt === 'string' ? input.createdAt : EPOCH
  return {
    id: String(input.id ?? ''),
    title: String(input.title ?? ''),
    detail: typeof input.detail === 'string' ? input.detail : '',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    column: typeof input.column === 'string' ? input.column : 'inbox',
    flag: input.flag === true,
    notes: Array.isArray(input.notes) ? input.notes : [],
    origin: typeof input.origin === 'string' ? input.origin : '',
    createdBy: typeof input.createdBy === 'string' ? input.createdBy : 'owner',
    createdAt: created,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : created,
    // When this card entered its current column. `updatedAt` cannot answer
    // that question: editing a title bumps it, which is not a column move.
    columnSince: typeof input.columnSince === 'string' ? input.columnSince : created,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    // Time worked: a running start and the logged sessions. Totals are computed,
    // never stored. A card from before the field gets an empty one, so no board
    // migrates — the first write to each board adds it to every card, once.
    // The budget for this card and the day it is wanted. Optional, and absent
    // rather than zero when unset: "no estimate" and "estimated at nothing" are
    // different claims. Neither is ever rendered on the card face — that was the
    // condition on reversing the 2026-08-21 ruling that kept them out.
    estimateMinutes: typeof input.estimateMinutes === 'number' && Number.isFinite(input.estimateMinutes)
      ? input.estimateMinutes
      : null,
    due: typeof input.due === 'string' ? input.due : null,
    time: normalizeTime(input.time),
    // Subtasks inside one card, shared: the owner adds and ticks them in the
    // panel, and Claude ticks them through the bridge. Empty rather than absent
    // for a card written before the field, exactly as `time` did — so no board
    // migrates and the first write to each board adds it once.
    todos: Array.isArray(input.todos) ? input.todos : [],
  }
}

const normalizeTime = (time) => ({
  running: typeof time?.running === 'string' ? time.running : null,
  sessions: Array.isArray(time?.sessions) ? time.sessions : [],
})

export function validateCard(card, columnKeys) {
  const errors = []
  if (typeof card?.id !== 'string' || !card.id) errors.push('id must be a non-empty string')
  if (typeof card?.title !== 'string') errors.push('title must be a string')
  if (typeof card?.detail !== 'string') errors.push('detail must be a string')
  if (!Array.isArray(card?.tags) || card.tags.some((t) => typeof t !== 'string')) {
    errors.push('tags must be an array of strings')
  }
  if (typeof card?.column !== 'string' || !columnKeys.includes(card.column)) {
    errors.push(`column must be one of ${columnKeys.join(', ')}`)
  }
  if (typeof card?.flag !== 'boolean') errors.push('flag must be a boolean')
  if (!Array.isArray(card?.attachments)) {
    errors.push('attachments must be an array')
  } else {
    for (const attachment of card.attachments) {
      if (typeof attachment?.file !== 'string' || typeof attachment?.kind !== 'string') {
        errors.push('each attachment needs a string file and kind')
        break
      }
    }
  }
  if (typeof card?.columnSince !== 'string') errors.push('columnSince must be a string')
  if (!Array.isArray(card?.notes)) {
    errors.push('notes must be an array')
  } else {
    for (const note of card.notes) {
      if (
        typeof note?.author !== 'string' ||
        typeof note?.at !== 'string' ||
        typeof note?.text !== 'string'
      ) {
        errors.push('each note needs string author, at, and text')
        break
      }
    }
  }
  if (card?.estimateMinutes !== null) {
    const minutes = card?.estimateMinutes
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
      errors.push('estimateMinutes must be null or a non-negative number of minutes')
    }
  }
  if (card?.due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(card?.due ?? '')) {
    errors.push('due must be null or a YYYY-MM-DD date')
  }
  if (card?.time?.running !== null && typeof card?.time?.running !== 'string') {
    errors.push('time.running must be an ISO string or null')
  }
  if (!Array.isArray(card?.time?.sessions)) {
    errors.push('time.sessions must be an array')
  } else {
    for (const session of card.time.sessions) {
      if (typeof session?.start !== 'string' || typeof session?.stop !== 'string' || typeof session?.note !== 'string') {
        errors.push('each time session needs string start, stop, and note')
        break
      }
    }
  }
  if (!Array.isArray(card?.todos)) {
    errors.push('todos must be an array')
  } else {
    for (const todo of card.todos) {
      // The id is what makes a todo addressable across a 409 replay. A todo
      // without one is unreachable by every mutation and every tool.
      if (typeof todo?.id !== 'string' || !todo.id) {
        errors.push('each todo needs a non-empty string id')
        break
      }
      if (typeof todo?.text !== 'string' || typeof todo?.done !== 'boolean') {
        errors.push('each todo needs a string text and a boolean done')
        break
      }
    }
  }
  return errors
}

/**
 * Re-exported from the UI module so the browser and the server can never
 * disagree about what colour a tag is.
 */
export { tagColor }

/**
 * Cards whose column no config mentions. Such a card is invisible in the UI
 * and unwritable by the store — still in the file, reachable by nothing.
 * `doctor` reports these; nothing else would.
 */
export const orphanedCards = (cards, columnKeys) =>
  cards.filter((card) => !columnKeys.includes(card.column))
