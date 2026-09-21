/** `2026-08-21T15:04:12.345Z` → `2026-08-21T15-04-12Z-4823.md`. Colons are shell-hostile. */
export function captureFilename(iso, updateId) {
  const stamp = iso.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
  return `${stamp}-${updateId}.md`
}

export function capturePath(bucket, filename) {
  return `captures/${bucket}/${filename}`
}

export function captureBody({ updateId, bucket, at, text }) {
  return [
    '---',
    `id: ${updateId}`,
    `bucket: ${bucket}`,
    `at: ${at}`,
    'source: telegram',
    '---',
    '',
    text.trim(),
    '',
  ].join('\n')
}

export function parseCapture(content) {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(content)
  if (!match) return null
  const meta = {}
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return {
    id: Number(meta.id),
    bucket: meta.bucket,
    at: meta.at,
    source: meta.source,
    text: match[2].trim(),
  }
}

export function firstLine(text, max = 80) {
  const line = text.trim().split('\n')[0]
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
