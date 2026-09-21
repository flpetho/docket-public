#!/usr/bin/env node
// Rename a column key on one project's board — config and cards together.
// Used for the overnight → loop rename of 2026-08-23, and kept because any
// clone that predates a rename needs the same one motion.
//
//   node board/scripts/rename-column.mjs <projectRoot> <from> <to> [--name <label>]
//
// Board first, then config: a crash in between leaves cards in the new key
// with the old config — doctor reports them as orphans and a re-run converges.
// The reverse order could strand cards in a column no config mentions with
// nothing left to move them.

import { rename as mv, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { renameColumn } from '../src/migrate.js'
import { readBoard, writeBoard } from '../src/store.js'
import { columnKeys, readConfig, validateConfig } from '../src/config.js'

const args = process.argv.slice(2)
const nameIx = args.indexOf('--name')
const name = nameIx === -1 ? undefined : args[nameIx + 1]
const [root, from, to] = args.filter((_, i) => i !== nameIx && i !== nameIx + 1)
if (!root || !from || !to) {
  console.error('usage: rename-column.mjs <projectRoot> <from> <to> [--name <label>]')
  process.exit(1)
}

const configFile = join(root, '.docket', 'config.json')
const boardFile = join(root, '.docket', 'board.json')
const config = await readConfig(configFile)
const doc = await readBoard(boardFile)
if (!config || !doc) {
  console.error(`${root}: missing config.json or board.json — not a docket project`)
  process.exit(1)
}

const next = renameColumn({ config, cards: doc.cards, from, to, name })
const errors = validateConfig(next.config)
if (errors.length) {
  console.error(`${root}: refusing — the renamed config would be invalid: ${errors.join('; ')}`)
  process.exit(1)
}

if (next.moved > 0) {
  const result = await writeBoard(
    boardFile,
    { rev: doc.rev, cards: next.cards },
    { columnKeys: columnKeys(next.config) },
  )
  if (!result.ok) {
    console.error(`${root}: board write refused: ${(result.errors ?? ['rev conflict']).join('; ')}`)
    process.exit(1)
  }
}

const configChanged =
  JSON.stringify(config.columns) !== JSON.stringify(next.config.columns)
if (configChanged) {
  const temp = `${configFile}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(next.config, null, 2)}\n`)
  await mv(temp, configFile)
}

console.log(
  `${root}: ${configChanged ? `column ${from} → ${to}` : `no column keyed ${from}`}, ${next.moved} card${next.moved === 1 ? '' : 's'} moved`,
)
