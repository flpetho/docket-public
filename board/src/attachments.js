import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Attachment bytes live on disk at `.docket/attachments/`, never in board.json —
 * that file is rewritten and diffed on every edit burst, and base64 in it would
 * be unusable in git.
 *
 * Filenames are content-addressed, so pasting the same screenshot twice stores
 * it once, and a filename can be validated by shape alone, which is what keeps
 * the serving route free of path traversal.
 */

const KINDS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
}

const EXTENSIONS = Object.fromEntries(Object.entries(KINDS).map(([kind, ext]) => [ext, kind]))

export const MAX_BYTES = 10 * 1024 * 1024

/** `a3f9c21e08b4.png` — 12 hex of sha256 plus a known extension, nothing else. */
const NAME = /^[0-9a-f]{12}\.[a-z0-9]{2,4}$/

export const attachmentsDir = (projectRoot) => join(projectRoot, '.docket', 'attachments')
export const isAttachmentName = (name) => typeof name === 'string' && NAME.test(name)
export const kindForName = (name) => EXTENSIONS[name.split('.').pop()] ?? null
export const supportedKinds = () => Object.keys(KINDS)

/**
 * Stores bytes and returns the reference a card carries. Idempotent: the same
 * bytes always produce the same name, so a repeat paste overwrites itself.
 */
export async function storeAttachment(projectRoot, { bytes, kind }) {
  const extension = KINDS[kind]
  if (!extension) return { ok: false, error: `unsupported type ${kind}` }
  if (!bytes.length) return { ok: false, error: 'empty body' }
  if (bytes.length > MAX_BYTES) {
    return { ok: false, error: `too large: ${bytes.length} bytes, max ${MAX_BYTES}` }
  }

  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const file = `${digest}.${extension}`
  const dir = attachmentsDir(projectRoot)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), bytes)
  return { ok: true, file, kind, bytes: bytes.length }
}

export async function readAttachment(projectRoot, file) {
  if (!isAttachmentName(file)) return null
  return readFile(join(attachmentsDir(projectRoot), file)).catch(() => null)
}

/** Every validly-named attachment on disk. An absent directory is simply empty. */
export async function listAttachmentFiles(projectRoot) {
  const entries = await readdir(attachmentsDir(projectRoot)).catch(() => [])
  return entries.filter(isAttachmentName)
}

/**
 * Files no card's attachments array points at. The array is the ONLY reference
 * site the system resolves — a filename in a note or a detail is prose, not a
 * link, and counting prose would have protected the very junk this sweep was
 * written to remove (the card describing the problem names the file). The
 * shared-file case (two cards, one blob, one card deleted) is safe because the
 * survivor's array still holds it. Pure; the caller owns all I/O.
 */
export function orphanedAttachments(files, cards) {
  const referenced = new Set()
  for (const card of cards) {
    for (const attachment of card.attachments ?? []) referenced.add(attachment.file)
  }
  return files.filter((file) => !referenced.has(file))
}

/**
 * Deletes one attachment, by valid name only. Deliberately the ONLY delete
 * path for these files, and never called by anything automatic — doctor
 * reports, the owner runs prune.
 */
export async function removeAttachment(projectRoot, file) {
  if (!isAttachmentName(file)) return false
  return unlink(join(attachmentsDir(projectRoot), file)).then(
    () => true,
    () => false,
  )
}
