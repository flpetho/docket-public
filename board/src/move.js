/**
 * Moving a card to another board.
 *
 * Two boards are two files in two repos, and nothing spans them in one write.
 * So a move is a create on the target THEN a delete on the source — the rule
 * the capture pipe lives by. A crash between the two duplicates a card; it
 * never loses one. Spec: docs/specs/2026-09-11-move-between-boards-design.md
 */
import { join } from 'node:path'

import { kindForName, readAttachment, storeAttachment } from './attachments.js'
import { readBoard, writeBoard } from './store.js'

/** The author of the trail note. A tool, so `docket news` never reads it as the owner. */
export const MOVER = 'docket'

const boardFileFor = (root) => join(root, '.docket', 'board.json')

/**
 * The card as it will land: the target's FIRST column whatever it left — the
 * owner's ruling, re-triage where it arrives, and since no board's first
 * column is Loop no move can land a card there — the column clock reset, and a
 * note naming where it came from, because the card's git history splits
 * across two repos at this moment and the note is the trail. Pure.
 */
export function planMove(card, { targetColumnKeys, sourceName, now = () => new Date() }) {
  const at = now().toISOString()
  return {
    ...card,
    column: targetColumnKeys[0],
    columnSince: at,
    updatedAt: at,
    notes: [...(card.notes ?? []), { author: MOVER, at, text: `moved from ${sourceName}` }],
  }
}

/**
 * The two writes. `source` and `target` are `{ root, name, columnKeys }`.
 * `store` and `files` are injected so a test can make one side fail and pin
 * the order — the house pattern. Never throws for a refusal: the result
 * carries the status the daemon sends, so the mapping lives in one place.
 *
 *   { ok: false, status: 400 | 404 | 409, error }
 *   { ok: true, duplicate: false, column, revTarget, revSource }
 *   { ok: true, duplicate: true,  column, revTarget, message }   ← the safe failure, reported
 */
export async function moveCard({
  id,
  source,
  target,
  now = () => new Date(),
  store = { readBoard, writeBoard },
  files = { readAttachment, storeAttachment },
  retries = 3,
}) {
  if (source.root === target.root) return { ok: false, status: 400, error: 'same board' }

  const sourceDoc = (await store.readBoard(boardFileFor(source.root))) ?? { rev: 0, cards: [] }
  const card = sourceDoc.cards.find((c) => c.id === id)
  if (!card) return { ok: false, status: 404, error: `no card ${id} on ${source.name}` }

  const targetDoc = (await store.readBoard(boardFileFor(target.root))) ?? { rev: 0, cards: [] }
  if (targetDoc.cards.some((c) => c.id === id)) {
    return { ok: false, status: 409, error: `a card with id ${id} is already on ${target.name}` }
  }

  // Blobs first. They are content-addressed, so a refused move leaves at most
  // an orphan on the target, which prune already handles. The other order
  // could leave a landed card pointing at blobs that never arrived.
  for (const attachment of card.attachments ?? []) {
    const bytes = await files.readAttachment(source.root, attachment.file)
    if (bytes) {
      await files.storeAttachment(target.root, { bytes, kind: attachment.kind ?? kindForName(attachment.file) })
    }
  }

  const landed = planMove(card, { targetColumnKeys: target.columnKeys, sourceName: source.name, now })
  const created = await store.writeBoard(
    boardFileFor(target.root),
    { rev: targetDoc.rev, cards: [landed, ...targetDoc.cards] },
    { columnKeys: target.columnKeys, now },
  )
  if (!created.ok) {
    return created.conflict
      ? { ok: false, status: 409, error: `${target.name} changed under the move — try again` }
      : { ok: false, status: 400, error: (created.errors ?? []).join('; ') }
  }

  // Now the delete, against a fresh read each time: the source can change
  // while the target was being written. Bounded, and running out of tries is
  // a DUPLICATE — the card on both boards, said out loud — never a loss.
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const fresh = (await store.readBoard(boardFileFor(source.root))) ?? { rev: 0, cards: [] }
    const remaining = fresh.cards.filter((c) => c.id !== id)
    if (remaining.length === fresh.cards.length) {
      // Somebody else already removed it. The move is complete.
      return { ok: true, duplicate: false, column: landed.column, revTarget: created.rev, revSource: fresh.rev }
    }
    const removed = await store.writeBoard(
      boardFileFor(source.root),
      { rev: fresh.rev, cards: remaining },
      { columnKeys: source.columnKeys, now },
    )
    if (removed.ok) {
      return { ok: true, duplicate: false, column: landed.column, revTarget: created.rev, revSource: removed.rev }
    }
    if (!removed.conflict) break
  }
  return {
    ok: true,
    duplicate: true,
    column: landed.column,
    revTarget: created.rev,
    message: `moved to ${target.name}, but the original is still on ${source.name} — it kept changing under the delete; remove it there by hand`,
  }
}
