import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addProject, canonical, findProjectRoot, readRegistry, slugify } from '../src/registry.js'

const tempDir = () => mkdtemp(join(tmpdir(), 'docket-reg-'))
const at = () => new Date('2026-08-21T12:00:00.000Z')

test('slugify lowercases and collapses punctuation', () => {
  assert.equal(slugify('Atlas'), 'atlas')
  assert.equal(slugify('My Project!'), 'my-project')
  assert.equal(slugify('a__b--c'), 'a-b-c')
  assert.equal(slugify('--trim--'), 'trim')
})

test('readRegistry returns an empty list when absent', async () => {
  assert.deepEqual(await readRegistry(join(await tempDir(), 'projects.json')), { projects: [] })
})

test('addProject records slug, path, name and timestamp', async () => {
  const file = join(await tempDir(), 'projects.json')
  const entry = await addProject(file, { path: '/x/atlas', name: 'Atlas', now: at })
  assert.deepEqual(entry, {
    slug: 'atlas',
    path: '/x/atlas',
    name: 'Atlas',
    addedAt: '2026-08-21T12:00:00.000Z',
  })
  assert.equal((await readRegistry(file)).projects.length, 1)
})

test('a colliding slug gets a numeric suffix', async () => {
  const file = join(await tempDir(), 'projects.json')
  await addProject(file, { path: '/a/board', name: 'Board', now: at })
  const second = await addProject(file, { path: '/b/board', name: 'Board', now: at })
  assert.equal(second.slug, 'board-2')
  const third = await addProject(file, { path: '/c/board', name: 'Board', now: at })
  assert.equal(third.slug, 'board-3')
})

test('re-adding the same path is idempotent and keeps the original slug', async () => {
  const file = join(await tempDir(), 'projects.json')
  const first = await addProject(file, { path: '/a/board', name: 'Board', now: at })
  const again = await addProject(file, { path: '/a/board', name: 'Renamed', now: at })
  assert.equal(again.slug, first.slug)
  assert.equal((await readRegistry(file)).projects.length, 1)
})

test('findProjectRoot walks up to the directory holding .docket/board.json', async () => {
  const root = await tempDir()
  await mkdir(join(root, '.docket'), { recursive: true })
  await writeFile(join(root, '.docket', 'board.json'), '{"rev":0,"cards":[]}')
  const deep = join(root, 'a', 'b', 'c')
  await mkdir(deep, { recursive: true })
  assert.equal(await findProjectRoot(deep), root)
})

test('findProjectRoot returns null outside any project', async () => {
  assert.equal(await findProjectRoot(await tempDir()), null)
})

test('addProject canonicalises the path so a symlinked directory still matches', async () => {
  const file = join(await tempDir(), 'projects.json')
  // /tmp is a symlink to /private/tmp on macOS: the same directory by two names.
  const real = await mkdtemp(join(tmpdir(), 'docket-canon-'))
  const entry = await addProject(file, { path: real, name: 'Canon', now: at })
  const stored = (await readRegistry(file)).projects[0].path
  assert.equal(stored, await realpath(real))
  assert.equal(entry.path, stored)
})

test('canonical leaves a non-existent path alone rather than throwing', async () => {
  assert.equal(await canonical('/definitely/not/here'), '/definitely/not/here')
})
