import { readFile } from 'node:fs/promises'

/**
 * atlas's six columns, so migration moves no card, plus Loop — the queue
 * Claude works unattended. Dragging a card in IS the authorization; see the loop
 * protocol in CLAUDE.md. It starts empty, so it costs a board that never uses it
 * nothing.
 *
 * Named Loop rather than Overnight because the work is not nightly: this ran at
 * 11pm on 2026-08-21 and at 10am the next morning.
 */
export const DEFAULT_COLUMNS = [
  { key: 'inbox', name: 'Inbox' },
  { key: 'waiting', name: 'Waiting on you' },
  { key: 'next', name: 'Up next' },
  // In progress before Loop — the owner's ruling, 2026-09-17: the owner's own work
  // sits next to what is queued, and the unattended queue next to the review it
  // ends in. Every live board was reordered the same day.
  { key: 'progress', name: 'In progress' },
  { key: 'loop', name: 'Loop' },
  { key: 'review', name: 'In review' },
  { key: 'done', name: 'Done' },
]

export function defaultConfig(name) {
  return {
    name,
    accent: '#ff5227',
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    tags: {},
  }
}

export async function readConfig(configFile) {
  let raw
  try {
    raw = await readFile(configFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`config.json at ${configFile} is not valid JSON: ${error.message}`)
  }
}

export const columnKeys = (config) => config.columns.map((c) => c.key)

export function validateConfig(config) {
  const errors = []
  if (typeof config?.name !== 'string' || !config.name) {
    errors.push('name must be a non-empty string')
  }
  if (typeof config?.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(config.accent)) {
    errors.push('accent must be a #rrggbb hex colour')
  }
  if (!Array.isArray(config?.columns) || config.columns.length === 0) {
    errors.push('columns must be a non-empty array')
  } else {
    const keys = config.columns.map((c) => c?.key)
    if (keys.some((k) => typeof k !== 'string' || !k)) errors.push('every column needs a key')
    if (new Set(keys).size !== keys.length) errors.push('duplicate column keys')
    if (config.columns.some((c) => typeof c?.name !== 'string' || !c.name)) {
      errors.push('every column needs a name')
    }
  }
  if (typeof config?.tags !== 'object' || config.tags === null || Array.isArray(config.tags)) {
    errors.push('tags must be an object of tag → colour')
  }
  return errors
}
