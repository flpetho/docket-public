import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

import { normalizeCard, validateCard } from './card.js'

/**
 * The board file is the single authority. This is the only module that writes
 * it — same single-bridge rule the bot's inbox client follows.
 *
 * A missing file is `null` (a project that has not been initialised). Corrupt
 * JSON throws: pretending an unreadable board is an empty one would let the
 * next write replace real work with nothing.
 */
export async function readBoard(boardFile) {
  let raw
  try {
    raw = await readFile(boardFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`board.json at ${boardFile} is not valid JSON: ${error.message}`)
  }
}

export async function writeBoard(boardFile, { rev, cards }, { columnKeys, now = () => new Date() }) {
  if (!Number.isInteger(rev) || rev < 0) {
    return { ok: false, errors: ['rev must be a non-negative integer'] }
  }
  if (!Array.isArray(cards)) {
    return { ok: false, errors: ['cards must be an array'] }
  }

  const normalized = cards.map(normalizeCard)
  const errors = []
  normalized.forEach((card, index) => {
    for (const error of validateCard(card, columnKeys)) {
      errors.push(`card ${index} (${card.id || 'no id'}): ${error}`)
    }
  })
  if (errors.length) return { ok: false, errors }

  const stored = await readBoard(boardFile)
  const storedRev = stored?.rev ?? 0
  if (rev !== storedRev) return { ok: false, conflict: true, doc: stored }

  const next = { rev: rev + 1, updatedAt: now().toISOString(), cards: normalized }
  const temp = `${boardFile}.tmp-${process.pid}`
  try {
    // Temp-then-rename: rename is atomic within a filesystem, so a reader sees
    // either the whole old board or the whole new one, never a truncated file.
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`)
    await rename(temp, boardFile)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { ok: true, rev: next.rev }
}
