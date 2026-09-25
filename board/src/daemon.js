import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isAttachmentName, kindForName, readAttachment, storeAttachment } from './attachments.js'
import { columnKeys, readConfig } from './config.js'
import { moveCard } from './move.js'
import { readRegistry } from './registry.js'
import { readBoard, writeBoard } from './store.js'
import { readUiVersion } from './version.js'

const boardFileFor = (root) => join(root, '.docket', 'board.json')
const configFileFor = (root) => join(root, '.docket', 'config.json')

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

const readJsonBody = (request) =>
  new Promise((resolve) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(null)
      }
    })
  })

/**
 * The daemon holds no state. Every read and write goes through the store, so
 * the board file stays the single authority and an out-of-band edit (Claude's,
 * or a git pull) is never overwritten by stale memory.
 */
export function createDaemon({ registryFile, now = () => new Date(), uiDir = UI_DIR, watchUi = watch, uiRecheckMs = 60_000 }) {
  // Injectable so the tests can point it at a temp directory and change a file there.
  const ui = uiDir.endsWith(sep) ? uiDir : uiDir + sep
  const send = (response, status, body) => {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }

  const project = async (slug) => {
    if (!slug) return null
    const registry = await readRegistry(registryFile)
    return registry.projects.find((p) => p.slug === slug) ?? null
  }

  // slug → { watcher, clients: Set<ServerResponse>, lastRev }
  const streams = new Map()

  // The UI version (spec 2026-09-16): a content hash of the files the browser
  // loads, computed at startup, re-read when they change, announced on
  // /api/version, as the first frame of every stream, and to every open stream
  // when it changes. A tab holding a stale stamp reloads itself once it is safe.
  // Same watcher idiom as the board files: the event is a hint, settle, re-read,
  // compare — so a touch that changes no byte announces nothing.
  //
  // The watcher is only the fast path. On 2026-09-18 it was measured missing a
  // change 1 run in 8, and a miss had no second chance: the stamp stayed stale
  // for the daemon's life. So the same re-read also runs whenever someone asks
  // (/api/version, a new stream) and on a slow interval, and a read that throws
  // simply leaves the next one to try. Every path compares content hashes, never
  // mtime, so none of them can announce a touch.
  let uiVersion = null
  const uiFrame = (version) => `data: ${JSON.stringify({ type: 'ui', version })}\n\n`
  // Serialised, so a slow read that started first can never land last and put
  // an older stamp back.
  let uiCheck = Promise.resolve()
  const recheckUi = () => {
    uiCheck = uiCheck.then(async () => {
      const next = await readUiVersion(ui).catch(() => null)
      if (!next || next === uiVersion) return
      const announce = uiVersion !== null
      uiVersion = next
      if (!announce) return
      for (const stream of streams.values()) {
        for (const client of stream.clients) client.write(uiFrame(next))
      }
    })
    return uiCheck
  }
  const currentVersion = async () => {
    await recheckUi()
    return uiVersion
  }
  recheckUi()
  let uiTimer = null
  const uiWatcher = watchUi(ui, () => {
    clearTimeout(uiTimer)
    uiTimer = setTimeout(recheckUi, 150)
  })
  uiWatcher.on('error', () => {})
  const uiInterval = setInterval(recheckUi, uiRecheckMs)
  uiInterval.unref()

  const startStream = (entry, response) => {
    let stream = streams.get(entry.slug)
    if (!stream) {
      stream = { watcher: null, clients: new Set(), lastRev: -1 }
      streams.set(entry.slug, stream)
    }
    stream.clients.add(response)

    if (!stream.watcher) {
      const file = boardFileFor(entry.path)
      let timer = null
      const settle = () => {
        clearTimeout(timer)
        // fs.watch on macOS both drops and duplicates events, so the event is a
        // hint: wait for the write to settle, then re-read and compare.
        timer = setTimeout(async () => {
          const doc = await readBoard(file).catch(() => null)
          if (!doc || doc.rev <= stream.lastRev) return
          stream.lastRev = doc.rev
          const frame = `data: ${JSON.stringify({ type: 'board', rev: doc.rev, doc })}\n\n`
          for (const client of stream.clients) client.write(frame)
        }, 100)
      }
      // Watch the directory, not the file: an atomic rename replaces the inode,
      // and a file watcher would be left pointing at the old one.
      stream.watcher = watch(join(entry.path, '.docket'), (_event, name) => {
        if (!name || name === 'board.json') settle()
      })
      stream.watcher.on('error', () => {})
    }

    response.on('close', () => {
      stream.clients.delete(response)
      if (stream.clients.size === 0) {
        stream.watcher?.close()
        streams.delete(entry.slug)
      }
    })
  }

  const server = createServer(async (request, response) => {
    let url
    try {
      url = new URL(request.url, 'http://localhost')
    } catch {
      return send(response, 400, { error: 'bad url' })
    }
    const slug = url.searchParams.get('project')

    try {
      if (url.pathname === '/api/projects' && request.method === 'GET') {
        const registry = await readRegistry(registryFile)
        const projects = []
        for (const entry of registry.projects) {
          const doc = await readBoard(boardFileFor(entry.path)).catch(() => null)
          projects.push({ ...entry, cards: doc?.cards.length ?? 0, rev: doc?.rev ?? 0 })
        }
        return send(response, 200, { projects })
      }

      if (url.pathname === '/api/board') {
        const entry = await project(slug)
        if (!entry) return send(response, 404, { error: `unknown project ${slug ?? '(none)'}` })

        if (request.method === 'GET') {
          const doc = await readBoard(boardFileFor(entry.path))
          return send(response, 200, doc ?? { rev: 0, cards: [] })
        }

        if (request.method === 'PUT') {
          const body = await readJsonBody(request)
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return send(response, 400, { error: 'expected { rev, cards }' })
          }
          const config = await readConfig(configFileFor(entry.path))
          if (!config) return send(response, 400, { error: 'project has no config.json' })

          const result = await writeBoard(
            boardFileFor(entry.path),
            { rev: body.rev, cards: body.cards },
            { columnKeys: columnKeys(config), now },
          )
          if (result.ok) return send(response, 200, { ok: true, rev: result.rev })
          if (result.conflict) return send(response, 409, result.doc ?? { rev: 0, cards: [] })
          return send(response, 400, { error: 'invalid board', errors: result.errors })
        }
      }

      if (url.pathname === '/api/move' && request.method === 'POST') {
        // A card to another board. Both writes happen here, create-then-delete,
        // so the order lives in one place and the browser stays a client. The
        // refusals and the duplicate-not-loss outcome are move.js's; this only
        // resolves the two projects and maps the result onto a status.
        const from = await project(slug)
        if (!from) return send(response, 404, { error: `unknown project ${slug ?? '(none)'}` })
        const body = await readJsonBody(request)
        if (!body || typeof body.id !== 'string' || typeof body.to !== 'string') {
          return send(response, 400, { error: 'expected { id, to }' })
        }
        if (body.to === from.slug) return send(response, 400, { error: 'same board' })
        const to = await project(body.to)
        if (!to) return send(response, 404, { error: `unknown project ${body.to}` })
        const [fromConfig, toConfig] = await Promise.all([
          readConfig(configFileFor(from.path)),
          readConfig(configFileFor(to.path)),
        ])
        if (!fromConfig || !toConfig) return send(response, 400, { error: 'project has no config.json' })
        const result = await moveCard({
          id: body.id,
          now,
          source: { root: from.path, name: from.name, columnKeys: columnKeys(fromConfig) },
          target: { root: to.path, name: to.name, columnKeys: columnKeys(toConfig) },
        })
        if (!result.ok) return send(response, result.status, { error: result.error })
        return send(response, 200, result)
      }

      if (url.pathname === '/api/version' && request.method === 'GET') {
        return send(response, 200, { version: await currentVersion() })
      }

      if (url.pathname === '/api/events' && request.method === 'GET') {
        const entry = await project(slug)
        if (!entry) return send(response, 404, { error: `unknown project ${slug ?? '(none)'}` })
        const doc = await readBoard(boardFileFor(entry.path)).catch(() => null)
        // Every await happens before the headers. Once they are out the client
        // can hang up and close() can run, and an await between here and
        // startStream would let startStream open a watcher after close() had
        // already swept — one nobody ever closes.
        const version = await currentVersion()
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        response.write(': connected\n\n')
        // The stamp first, so a tab that reconnects after a daemon restart learns
        // at once whether the code it runs is the code being served.
        response.write(uiFrame(version))
        startStream(entry, response)
        const stream = streams.get(entry.slug)
        if (doc && stream.lastRev < doc.rev) stream.lastRev = doc.rev
        return undefined
      }

      if (url.pathname === '/api/attachment') {
        const entry = await project(slug)
        if (!entry) return send(response, 404, { error: `unknown project ${slug ?? '(none)'}` })

        if (request.method === 'POST') {
          const chunks = []
          for await (const chunk of request) chunks.push(chunk)
          const result = await storeAttachment(entry.path, {
            bytes: Buffer.concat(chunks),
            kind: (request.headers['content-type'] ?? '').split(';')[0].trim(),
          })
          return result.ok
            ? send(response, 201, result)
            : send(response, 415, { error: result.error })
        }

        if (request.method === 'GET') {
          const file = url.searchParams.get('file')
          if (!isAttachmentName(file)) return send(response, 400, { error: 'bad attachment name' })
          const bytes = await readAttachment(entry.path, file)
          if (!bytes) return send(response, 404, { error: 'no such attachment' })
          response.writeHead(200, {
            'content-type': kindForName(file) ?? 'application/octet-stream',
            'content-length': bytes.length,
            'cache-control': 'public, max-age=31536000, immutable',
          })
          return response.end(bytes)
        }
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        const entry = await project(slug)
        if (!entry) return send(response, 404, { error: `unknown project ${slug ?? '(none)'}` })
        const config = await readConfig(configFileFor(entry.path))
        if (!config) return send(response, 404, { error: 'project has no config.json' })
        return send(response, 200, config)
      }

      // Static UI. `normalize` then a prefix check keeps `..` out of the tree.
      // HEAD is answered too: it costs one branch, and a HEAD that 404s while the
      // GET succeeds is the kind of inconsistency that sends you chasing ghosts.
      // The second page this daemon serves: one board's time, as a page. The
      // project is resolved first so an unknown slug is a 404, not a page that
      // fails on its first fetch. (spec 2026-09-17)
      if (url.pathname === '/dashboard' && request.method === 'GET') {
        const entry = await project(slug)
        if (!entry) return send(response, 404, { error: `unknown project ${slug ?? '(none)'}` })
        const body = await readFile(join(ui, 'dashboard.html')).catch(() => null)
        if (!body) return send(response, 404, { error: 'not found' })
        response.writeHead(200, { 'content-type': MIME['.html'], 'content-length': body.length, 'cache-control': 'no-cache' })
        return response.end(body)
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const requested = url.pathname === '/' ? '/index.html' : url.pathname
        const file = normalize(join(ui, requested))
        if (!file.startsWith(ui)) return send(response, 403, { error: 'forbidden' })
        const body = await readFile(file).catch(() => null)
        if (body) {
          response.writeHead(200, {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
            'content-length': body.length,
            'cache-control': extname(file) === '.woff2' ? 'public, max-age=31536000' : 'no-cache',
          })
          return response.end(request.method === 'HEAD' ? undefined : body)
        }
      }

      return send(response, 404, { error: 'not found' })
    } catch (error) {
      return send(response, 500, { error: error.message })
    }
  })

  return {
    listen: (port) =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port))
      }),
    close: () =>
      new Promise((resolve) => {
        clearTimeout(uiTimer)
        clearInterval(uiInterval)
        uiWatcher.close()
        for (const stream of streams.values()) {
          stream.watcher?.close()
          for (const client of stream.clients) client.end()
        }
        streams.clear()
        server.close(resolve)
      }),
  }
}
