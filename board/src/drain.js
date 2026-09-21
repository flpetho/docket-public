import { join } from 'node:path'

import { normalizeCard } from './card.js'
import { columnKeys, readConfig } from './config.js'
import { readRegistry } from './registry.js'
import { readBoard, writeBoard } from './store.js'

/**
 * Carries captures from the inbox repo onto boards — the missing half of the
 * capture pipe. A note typed on a phone lands in `docket-inbox` within a second;
 * without this it sits there forever, which is exactly what happened on
 * 2026-08-21 and read to the owner as "the bot didn't work".
 *
 * A bucket maps to a project by **matching slug**. `captures/atlas/` drains
 * to the project registered as `atlas`. A bucket with no matching project
 * (`ideas`, `personal`) is left alone and reported, never dropped.
 *
 * The bucket comes from the **directory**, not the frontmatter: the bot moves a
 * file when you tap a button but does not rewrite its `bucket:` line, so the
 * path is the only trustworthy source.
 */

const CAPTURE_TAG = 'captured'

const boardFileFor = (root) => join(root, '.docket', 'board.json')
const configFileFor = (root) => join(root, '.docket', 'config.json')

/** Frontmatter plus body → the parts a card needs. */
export function parseCapture(content) {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(content)
  if (!match) return { at: null, text: content.trim() }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { at: meta.at ?? null, id: meta.id ?? null, text: match[2].trim() }
}

export function firstLine(text, max = 70) {
  const line = text.trim().split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * A capture becomes a card. `createdBy` is the **owner**, not Claude: it is their
 * thought, and getting this wrong would make every drained card show an unread
 * dot as though Claude had said something.
 */
export function captureToCard({ text, at, bucket, column, id, now }) {
  const title = firstLine(text)
  const stamp = at ?? now().toISOString()
  return normalizeCard({
    // `??` cannot be mixed with `||` unparenthesised — it is a syntax error, not
    // a precedence surprise.
    id: `capture-${id ?? (Date.parse(stamp) || Date.now())}`,
    title,
    // Only carry a detail when the title does not already say everything.
    detail: title === text.trim() ? '' : text,
    tags: [CAPTURE_TAG],
    column,
    origin: `telegram · ${stamp.slice(0, 10)}`,
    createdBy: 'owner',
    createdAt: stamp,
    updatedAt: stamp,
    columnSince: stamp,
  })
}

/**
 * Drains every bucket that has a matching project.
 *
 * `inbox` is the bot's GitHub Contents client (`bot/src/inbox.js`) — the same
 * single bridge that wrote the captures, so there is one implementation of
 * "talk to the inbox repo" rather than two.
 */
export async function drain({ inbox, registryFile, now = () => new Date(), dryRun = false }) {
  const buckets = await inbox.readBuckets()
  const registry = await readRegistry(registryFile)
  const report = { drained: [], skipped: [], unmapped: [] }

  for (const bucket of buckets) {
    const entries = await inbox.listDir(`captures/${bucket}`)
    if (!entries.length) continue

    const project = registry.projects.find((p) => p.slug === bucket)
    if (!project) {
      report.unmapped.push({ bucket, count: entries.length })
      continue
    }

    const config = await readConfig(configFileFor(project.path))
    if (!config) {
      report.skipped.push({ bucket, reason: 'project has no config.json' })
      continue
    }
    const keys = columnKeys(config)

    for (const entry of entries) {
      const file = await inbox.getFile(entry.path)
      if (!file) {
        report.skipped.push({ bucket, file: entry.name, reason: 'unreadable' })
        continue
      }
      const capture = parseCapture(file.content)
      if (!capture.text) {
        report.skipped.push({ bucket, file: entry.name, reason: 'empty capture' })
        continue
      }

      const card = captureToCard({ ...capture, bucket, column: keys[0], now })

      if (dryRun) {
        // A prediction is only trustworthy if it looks where the real run
        // would: a capture whose id is already on the board is a no-op there,
        // and saying "would drain" for it is a misprediction.
        const doc = (await readBoard(boardFileFor(project.path))) ?? { rev: 0, cards: [] }
        const duplicate = doc.cards.some((c) => c.id === card.id)
        report.drained.push({ bucket, project: project.slug, id: card.id, title: card.title, dryRun: true, duplicate })
        continue
      }

      // Rev-checked, with one retry: the browser may write between read and write.
      let written = null
      for (let attempt = 1; attempt <= 2 && !written; attempt++) {
        const doc = (await readBoard(boardFileFor(project.path))) ?? { rev: 0, cards: [] }
        if (doc.cards.some((c) => c.id === card.id)) {
          written = { duplicate: true }
          break
        }
        const result = await writeBoard(
          boardFileFor(project.path),
          { rev: doc.rev, cards: [card, ...doc.cards] },
          { columnKeys: keys, now },
        )
        if (result.ok) written = { rev: result.rev }
        else if (!result.conflict) {
          report.skipped.push({ bucket, file: entry.name, reason: result.errors.join('; ') })
          break
        }
      }
      if (!written) {
        report.skipped.push({ bucket, file: entry.name, reason: 'board kept changing' })
        continue
      }

      // Card first, then file. If the move fails the capture stays put and the
      // next drain sees it again — the id check above makes that a no-op rather
      // than a duplicate card.
      await inbox.move(entry.path, `filed/${bucket}/${entry.name}`, `filed ${entry.name}`)
      report.drained.push({
        bucket,
        project: project.slug,
        id: card.id,
        title: card.title,
        rev: written.rev ?? null,
        duplicate: written.duplicate === true,
      })
    }
  }

  return report
}

/**
 * One line about a drained capture, safe for where it is going.
 *
 * The title is the owner's private content. Printed to a terminal that is fine —
 * a human asked and is looking at it. Printed under launchd it is not: stdout
 * becomes ~/.docket/drain.log, a file that persists, and CLAUDE.md's rule is that
 * logs carry ids and paths only. Same code, same call, different destination —
 * which is exactly how a benign interactive print became a privacy leak the
 * moment the drain got a timer.
 *
 * So: a TTY gets the title, anything else gets the card id.
 */
export function drainLine(item, { tty }) {
  const verb = item.duplicate ? 'already on board' : item.dryRun ? 'would drain' : 'drained'
  const subject = tty ? item.title : (item.id ?? '(no id)')
  return `${verb}  ${item.project}  ${subject}`
}
