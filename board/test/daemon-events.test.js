import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../src/config.js'
import { createDaemon } from '../src/daemon.js'
import { addProject } from '../src/registry.js'

const at = () => new Date('2026-08-21T12:00:00.000Z')

async function harness() {
  const home = await mkdtemp(join(tmpdir(), 'docket-home-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'docket-proj-'))
  const registryFile = join(home, 'projects.json')
  const boardFile = join(projectRoot, '.docket', 'board.json')
  await mkdir(join(projectRoot, '.docket'), { recursive: true })
  await writeFile(
    join(projectRoot, '.docket', 'config.json'),
    `${JSON.stringify(defaultConfig('Test Project'), null, 2)}\n`,
  )
  await writeFile(
    boardFile,
    `${JSON.stringify({ rev: 1, updatedAt: '2026-08-21T00:00:00.000Z', cards: [] }, null, 2)}\n`,
  )
  await addProject(registryFile, { path: projectRoot, name: 'Test Project', now: at })

  const daemon = createDaemon({ registryFile, now: at })
  const port = await daemon.listen(0)
  return {
    boardFile,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => daemon.close(),
  }
}

/** Writes the board the way the store does — temp file then rename. */
async function writeOutOfBand(boardFile, doc) {
  const temp = `${boardFile}.tmp-external`
  await writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`)
  await rename(temp, boardFile)
}

/**
 * Reads SSE frames until one satisfies `match`, or the timeout expires.
 *
 * The deadline has to *race* each read rather than gate the loop: `read()`
 * blocks indefinitely when no data arrives, so a pre-loop deadline check hangs
 * forever in exactly the case this helper exists to assert — that nothing was
 * emitted. Cancelling the reader here also releases the stream, so callers must
 * not call `response.body.cancel()` afterwards; that throws "locked".
 */
async function waitForEvent(response, match, timeoutMs = 5000) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break

      let timer
      const expiry = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('read timeout')), remaining)
      })
      let chunk
      try {
        chunk = await Promise.race([reader.read(), expiry])
      } catch {
        break
      } finally {
        clearTimeout(timer)
      }

      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      for (const frame of buffer.split('\n\n')) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        const payload = JSON.parse(line.slice(6))
        if (match(payload)) return payload
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  throw new Error('no matching SSE event before timeout')
}

test('the stream opens with the right content type', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/events?project=test-project'))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    await response.body.cancel()
  } finally {
    await h.close()
  }
})

test('an out-of-band file write reaches an open stream', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/events?project=test-project'))
    // Claude editing the file directly, or a git pull landing.
    await writeOutOfBand(h.boardFile, {
      rev: 2,
      updatedAt: '2026-08-21T13:00:00.000Z',
      cards: [
        {
          id: 'from-claude',
          title: 'Written outside the browser',
          detail: '',
          tags: ['tooling'],
          column: 'inbox',
          flag: false,
          notes: [],
          origin: '',
          createdBy: 'claude',
          createdAt: '2026-08-21T13:00:00.000Z',
          updatedAt: '2026-08-21T13:00:00.000Z',
        },
      ],
    })
    const event = await waitForEvent(response, (p) => p.type === 'board' && p.rev === 2)
    assert.equal(event.doc.cards[0].id, 'from-claude')
  } finally {
    await h.close()
  }
})

test('a write with no rev change is not re-emitted', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/events?project=test-project'))
    const doc = { rev: 1, updatedAt: '2026-08-21T00:00:00.000Z', cards: [] }
    await writeOutOfBand(h.boardFile, doc)
    await writeOutOfBand(h.boardFile, doc)
    await assert.rejects(
      () => waitForEvent(response, (p) => p.rev === 1, 1200),
      /timeout/,
      'rev 1 was already the known state and must not be pushed',
    )
  } finally {
    await h.close()
  }
})

test('events for an unknown project are 404', async () => {
  const h = await harness()
  try {
    assert.equal((await fetch(h.url('/api/events?project=nope'))).status, 404)
  } finally {
    await h.close()
  }
})
