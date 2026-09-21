import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'

export const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** realpath where possible; a path that does not exist yet is returned as given. */
export const canonical = async (path) => realpath(path).catch(() => path)

export async function readRegistry(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { projects: [] }
    throw error
  }
}

/**
 * Idempotent by path: re-adding a known project keeps its original slug.
 *
 * Paths are canonicalised. macOS hands out /var/folders/... from mkdtemp while a
 * process's cwd resolves to /private/var/folders/..., and any symlinked project
 * directory has the same problem — an uncanonicalised compare silently fails to
 * find a registered project.
 */
export async function addProject(file, { path: given, name, now = () => new Date() }) {
  const path = await canonical(given)
  const registry = await readRegistry(file)
  const existing = registry.projects.find((p) => p.path === path)
  if (existing) return existing

  const base = slugify(name)
  const taken = new Set(registry.projects.map((p) => p.slug))
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`

  const entry = { slug, path, name, addedAt: now().toISOString() }
  registry.projects.push(entry)

  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`)
  await rename(temp, file)
  return entry
}

/** Walks up from a directory looking for `.docket/board.json`. */
export async function findProjectRoot(startDir) {
  let dir = startDir
  const { root } = parse(startDir)
  for (;;) {
    try {
      await access(join(dir, '.docket', 'board.json'))
      return dir
    } catch {
      if (dir === root) return null
      dir = dirname(dir)
    }
  }
}
