import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readUiVersion, versionOf } from '../src/version.js'

// The UI version stamp (spec 2026-09-16): content, not mtime, so a touch that
// changes nothing reloads nothing. Pure over the files the browser loads.

const files = () => [
  { name: 'index.html', bytes: Buffer.from('<main></main>') },
  { name: 'app.js', bytes: Buffer.from('export const x = 1') },
  { name: 'style.css', bytes: Buffer.from('body{margin:0}') },
]

test('the stamp is twelve hex characters and deterministic', () => {
  const a = versionOf(files())
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.equal(versionOf(files()), a)
})

test('the order the files arrive in does not change the stamp', () => {
  assert.equal(versionOf(files().reverse()), versionOf(files()))
})

test('one changed byte in any file changes the stamp; a renamed file does too', () => {
  const base = versionOf(files())
  const edited = files()
  edited[2].bytes = Buffer.from('body{margin:1px}')
  assert.notEqual(versionOf(edited), base)
  const renamed = files()
  renamed[1].name = 'main.js'
  assert.notEqual(versionOf(renamed), base)
})

test('readUiVersion hashes only what the browser loads, and sees a change on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docket-ui-'))
  await writeFile(join(dir, 'index.html'), '<main></main>')
  await writeFile(join(dir, 'app.js'), 'export const x = 1')
  await writeFile(join(dir, 'style.css'), 'body{margin:0}')
  await writeFile(join(dir, 'manifest.webmanifest'), '{}')
  await writeFile(join(dir, 'notes.md'), 'not served to anyone')
  const before = await readUiVersion(dir)
  assert.match(before, /^[0-9a-f]{12}$/)
  await writeFile(join(dir, 'notes.md'), 'still not served')
  assert.equal(await readUiVersion(dir), before, 'a file the browser never loads does not count')
  await writeFile(join(dir, 'style.css'), 'body{margin:1px}')
  assert.notEqual(await readUiVersion(dir), before)
})
