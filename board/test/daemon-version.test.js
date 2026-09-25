import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../src/config.js'
import { createDaemon } from '../src/daemon.js'
import { addProject } from '../src/registry.js'

// The daemon knows the UI version and says it: on /api/version, as the first
// frame of every event stream, and again to every open stream when the files
// under its uiDir change. Injected uiDir, so these tests never touch board/ui.

const at = () => new Date('2026-09-16T12:00:00.000Z')

async function harness(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'docket-home-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'docket-proj-'))
  const uiDir = await mkdtemp(join(tmpdir(), 'docket-ui-'))
  const registryFile = join(home, 'projects.json')
  await mkdir(join(projectRoot, '.docket'), { recursive: true })
  await writeFile(join(projectRoot, '.docket', 'config.json'), `${JSON.stringify(defaultConfig('Test Project'), null, 2)}\n`)
  await writeFile(join(projectRoot, '.docket', 'board.json'), `${JSON.stringify({ rev: 1, updatedAt: at().toISOString(), cards: [] }, null, 2)}\n`)
  await addProject(registryFile, { path: projectRoot, name: 'Test Project', now: at })
  await writeFile(join(uiDir, 'index.html'), '<main></main>')
  await writeFile(join(uiDir, 'style.css'), 'body{margin:0}')
  const daemon = createDaemon({ registryFile, now: at, uiDir, ...options })
  const port = await daemon.listen(0)
  return { uiDir, url: (path) => `http://127.0.0.1:${port}${path}`, close: () => daemon.close() }
}

/**
 * ONE reader per stream, held for the test's whole life. Cancelling a reader
 * releases and closes the body, so a second wait on the same response would
 * fail on a locked or finished stream — which is why daemon-events.test.js
 * uses its helper once per response. These tests need two frames from one
 * stream, so the reader lives on the returned object and is closed once.
 */
function tail(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pending = []
  const drain = () => {
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (line) pending.push(JSON.parse(line.slice(6)))
    }
  }
  return {
    async until(match, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const index = pending.findIndex(match)
        if (index !== -1) return pending.splice(index, 1)[0]
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('no matching SSE event before timeout')
        let timer
        const expiry = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('read timeout')), remaining)
        })
        let chunk
        try {
          chunk = await Promise.race([reader.read(), expiry])
        } catch {
          throw new Error('no matching SSE event before timeout')
        } finally {
          clearTimeout(timer)
        }
        if (chunk.done) throw new Error('no matching SSE event before timeout')
        buffer += decoder.decode(chunk.value, { stream: true })
        drain()
      }
    },
    close() {
      reader.cancel().catch(() => {})
    },
  }
}

test('/api/version and the first stream frame agree on the stamp', async () => {
  const h = await harness()
  try {
    const { version } = await (await fetch(h.url('/api/version'))).json()
    assert.match(version, /^[0-9a-f]{12}$/)
    const stream = tail(await fetch(h.url('/api/events?project=test-project')))
    try {
      const frame = await stream.until((p) => p.type === 'ui')
      assert.equal(frame.version, version)
    } finally {
      stream.close()
    }
  } finally {
    await h.close()
  }
})

test('a changed byte under uiDir reaches an open stream as a new ui frame', async () => {
  const h = await harness()
  try {
    const { version: before } = await (await fetch(h.url('/api/version'))).json()
    const stream = tail(await fetch(h.url('/api/events?project=test-project')))
    try {
      await stream.until((p) => p.type === 'ui')
      await writeFile(join(h.uiDir, 'style.css'), 'body{margin:1px}')
      const frame = await stream.until((p) => p.type === 'ui' && p.version !== before)
      assert.notEqual(frame.version, before)
      const { version: after } = await (await fetch(h.url('/api/version'))).json()
      assert.equal(after, frame.version, 'the route and the frame agree afterwards too')
    } finally {
      stream.close()
    }
  } finally {
    await h.close()
  }
})

test('a touch that changes no byte sends no new frame', async () => {
  const h = await harness()
  try {
    const stream = tail(await fetch(h.url('/api/events?project=test-project')))
    try {
      const first = await stream.until((p) => p.type === 'ui')
      await writeFile(join(h.uiDir, 'style.css'), 'body{margin:0}')
      await assert.rejects(
        stream.until((p) => p.type === 'ui' && p.version !== first.version, 1200),
        /no matching SSE event/,
      )
    } finally {
      stream.close()
    }
  } finally {
    await h.close()
  }
})

// The watcher is one signal, and on 2026-09-18 it was measured missing a change
// 1 run in 8 with nothing to recover it. These inject the miss — a watcher that
// never fires — instead of waiting for the OS to drop an event.
const deafWatch = () => ({ on() {}, close() {} })

test('a missed watcher event still reaches /api/version', async () => {
  const h = await harness({ watchUi: deafWatch })
  try {
    const { version: before } = await (await fetch(h.url('/api/version'))).json()
    await writeFile(join(h.uiDir, 'style.css'), 'body{margin:1px}')
    const { version: after } = await (await fetch(h.url('/api/version'))).json()
    assert.notEqual(after, before)
  } finally {
    await h.close()
  }
})

test('a missed watcher event still reaches the first frame of a new stream', async () => {
  const h = await harness({ watchUi: deafWatch })
  try {
    const { version: before } = await (await fetch(h.url('/api/version'))).json()
    await writeFile(join(h.uiDir, 'style.css'), 'body{margin:1px}')
    const stream = tail(await fetch(h.url('/api/events?project=test-project')))
    try {
      const frame = await stream.until((p) => p.type === 'ui')
      assert.notEqual(frame.version, before)
    } finally {
      stream.close()
    }
  } finally {
    await h.close()
  }
})

test('a missed watcher event reaches an already-open stream on the periodic re-check', async () => {
  const h = await harness({ watchUi: deafWatch, uiRecheckMs: 150 })
  try {
    const stream = tail(await fetch(h.url('/api/events?project=test-project')))
    try {
      const first = await stream.until((p) => p.type === 'ui')
      await writeFile(join(h.uiDir, 'style.css'), 'body{margin:1px}')
      const frame = await stream.until((p) => p.type === 'ui' && p.version !== first.version, 2000)
      assert.notEqual(frame.version, first.version)
    } finally {
      stream.close()
    }
  } finally {
    await h.close()
  }
})

test('the periodic re-check compares content, so a touch still sends nothing', async () => {
  const h = await harness({ watchUi: deafWatch, uiRecheckMs: 100 })
  try {
    const stream = tail(await fetch(h.url('/api/events?project=test-project')))
    try {
      const first = await stream.until((p) => p.type === 'ui')
      await writeFile(join(h.uiDir, 'style.css'), 'body{margin:0}')
      await assert.rejects(
        stream.until((p) => p.type === 'ui', 800),
        /no matching SSE event/,
        'not even a repeat of the same stamp',
      )
      assert.ok(first.version)
    } finally {
      stream.close()
    }
  } finally {
    await h.close()
  }
})
