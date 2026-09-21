import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_COLUMNS,
  columnKeys,
  defaultConfig,
  readConfig,
  validateConfig,
} from '../src/config.js'

test('the defaults are atlas six, plus Loop for unattended work', () => {
  assert.deepEqual(
    DEFAULT_COLUMNS.map((c) => c.key),
    ['inbox', 'waiting', 'next', 'progress', 'loop', 'review', 'done'],
  )
  assert.equal(DEFAULT_COLUMNS.find((c) => c.key === 'waiting').name, 'Waiting on you')
  assert.equal(DEFAULT_COLUMNS.find((c) => c.key === 'loop').name, 'Loop')
})

test('defaultConfig carries the accent and an empty tag map', () => {
  const config = defaultConfig('Atlas')
  assert.equal(config.name, 'Atlas')
  assert.equal(config.accent, '#ff5227')
  assert.deepEqual(config.tags, {})
  assert.equal(config.columns.length, 7)
})

test('columnKeys extracts the keys in order', () => {
  assert.deepEqual(columnKeys(defaultConfig('X')), [
    'inbox',
    'waiting',
    'next',
    'progress',
    'loop',
    'review',
    'done',
  ])
})

test('readConfig returns null when absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docket-config-'))
  assert.equal(await readConfig(join(dir, 'config.json')), null)
})

test('readConfig reads what defaultConfig wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docket-config-'))
  const file = join(dir, 'config.json')
  await writeFile(file, `${JSON.stringify(defaultConfig('Mine'), null, 2)}\n`)
  assert.equal((await readConfig(file)).name, 'Mine')
})

test('validateConfig accepts the default and rejects a broken one', () => {
  assert.deepEqual(validateConfig(defaultConfig('X')), [])
  const errors = validateConfig({ name: 5, accent: 'red', columns: [], tags: [] })
  const joined = errors.join(' | ')
  assert.match(joined, /name/)
  assert.match(joined, /accent/)
  assert.match(joined, /columns/)
  assert.match(joined, /tags/)
})

test('validateConfig rejects duplicate column keys', () => {
  const config = defaultConfig('X')
  config.columns = [
    { key: 'inbox', name: 'Inbox' },
    { key: 'inbox', name: 'Again' },
  ]
  assert.match(validateConfig(config).join(' '), /duplicate/i)
})

test('no config this code ships carries a column keyed overnight — the rename is done', () => {
  // Clause 8 of the rename card: this is the regression pin. If the old key
  // ever creeps back into the defaults, every new board would resurrect it.
  const keys = defaultConfig('Any').columns.map((c) => c.key)
  assert.equal(keys.includes('overnight'), false)
  assert.equal(keys.includes('loop'), true)
})
