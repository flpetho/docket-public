/**
 * The UI version stamp: a content hash of the files the browser loads from
 * board/ui. Content, not mtime, so a touch that changes nothing reloads
 * nothing. The daemon computes it, serves it, and broadcasts it when it
 * changes; a tab holding a different stamp reloads itself once it is safe to.
 * Spec: docs/specs/2026-09-16-ui-live-reload-design.md
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** What the browser fetches. Fonts and icons are immutable-cached and left out. */
const SERVED = new Set(['.html', '.js', '.css', '.webmanifest'])

/** Pure: `[{ name, bytes }]` in any order → twelve hex. */
export function versionOf(files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(file.name)
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** The stamp of a directory's served files, top level only. */
export async function readUiVersion(dir) {
  const names = (await readdir(dir)).filter((name) => SERVED.has(extname(name)))
  const files = await Promise.all(names.map(async (name) => ({ name, bytes: await readFile(join(dir, name)) })))
  return versionOf(files)
}
