import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  await mkdir(join(projectRoot, '.docket'), { recursive: true })
  const config = defaultConfig('Test Project')
  config.tags = { strategy: 'hsl(256 42% 66%)' }
  await writeFile(join(projectRoot, '.docket', 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  await writeFile(
    join(projectRoot, '.docket', 'board.json'),
    `${JSON.stringify({ rev: 1, updatedAt: '2026-08-21T00:00:00.000Z', cards: [] }, null, 2)}\n`,
  )
  await addProject(registryFile, { path: projectRoot, name: 'Test Project', now: at })

  const daemon = createDaemon({ registryFile, now: at })
  const port = await daemon.listen(0)
  return { url: (path) => `http://127.0.0.1:${port}${path}`, close: () => daemon.close() }
}

test('GET /api/config returns the project config including declared tag colours', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/api/config?project=test-project'))
    assert.equal(response.status, 200)
    const config = await response.json()
    assert.equal(config.name, 'Test Project')
    assert.equal(config.columns.length, 7)
    assert.equal(config.tags.strategy, 'hsl(256 42% 66%)')
  } finally {
    await h.close()
  }
})

test('GET /api/config 404s for an unknown project', async () => {
  const h = await harness()
  try {
    assert.equal((await fetch(h.url('/api/config?project=nope'))).status, 404)
  } finally {
    await h.close()
  }
})

test('GET / serves the board html', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/'))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    const body = await response.text()
    assert.match(body, /<title>Docket<\/title>/)
    assert.match(body, /type="module" src="\/app\.js"/)
  } finally {
    await h.close()
  }
})

test('every module the html asks for is served with a javascript type', async () => {
  const h = await harness()
  try {
    for (const path of ['/app.js', '/render.js', '/modal.js', '/sync.js', '/tag-color.js']) {
      const response = await fetch(h.url(path))
      assert.equal(response.status, 200, `${path} was ${response.status}`)
      assert.match(response.headers.get('content-type'), /javascript/, path)
    }
  } finally {
    await h.close()
  }
})

test('css and the bundled font are served with correct types', async () => {
  const h = await harness()
  try {
    const css = await fetch(h.url('/style.css'))
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type'), /text\/css/)

    const font = await fetch(h.url('/fonts/geist-latin.woff2'))
    assert.equal(font.status, 200)
    assert.equal(font.headers.get('content-type'), 'font/woff2')
    assert.match(font.headers.get('cache-control'), /max-age=31536000/)
  } finally {
    await h.close()
  }
})

test('a path traversal attempt cannot escape the ui directory', async () => {
  const h = await harness()
  try {
    // encoded so fetch does not normalise it away before the server sees it
    const response = await fetch(h.url('/%2e%2e/src/store.js'))
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`)
  } finally {
    await h.close()
  }
})

test('an unknown file is still 404 json, not a hang', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/nope.js'))
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type'), /application\/json/)
  } finally {
    await h.close()
  }
})

test('the web manifest is served with the right type and a standalone display', async () => {
  const h = await harness()
  try {
    const response = await fetch(h.url('/manifest.webmanifest'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/manifest+json')
    const manifest = await response.json()
    // display:standalone is what removes the URL bar — the whole point of installing.
    assert.equal(manifest.display, 'standalone')
    assert.equal(manifest.name, 'Docket')
    assert.equal(manifest.start_url, '/')
    assert.equal(manifest.theme_color, '#0b0b0c')
    const sizes = manifest.icons.map((i) => i.sizes)
    assert.ok(sizes.includes('192x192'), 'Chrome requires a 192 icon to install')
    assert.ok(sizes.includes('512x512'), 'Chrome requires a 512 icon to install')
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'))
  } finally {
    await h.close()
  }
})

test('every icon the manifest names is actually served', async () => {
  const h = await harness()
  try {
    const manifest = await (await fetch(h.url('/manifest.webmanifest'))).json()
    for (const icon of manifest.icons) {
      const response = await fetch(h.url(icon.src))
      assert.equal(response.status, 200, `${icon.src} was ${response.status}`)
      assert.equal(response.headers.get('content-type'), 'image/png', icon.src)
    }
  } finally {
    await h.close()
  }
})

test('the html links the manifest, or nothing is installable', async () => {
  const h = await harness()
  try {
    const body = await (await fetch(h.url('/'))).text()
    assert.match(body, /<link rel="manifest" href="\/manifest\.webmanifest"/)
  } finally {
    await h.close()
  }
})

test('HEAD on a static file matches its GET, headers and all', async () => {
  const h = await harness()
  try {
    for (const path of ['/', '/style.css', '/icons/icon-192.png', '/manifest.webmanifest']) {
      const get = await fetch(h.url(path))
      const head = await fetch(h.url(path), { method: 'HEAD' })
      assert.equal(head.status, get.status, path)
      assert.equal(head.headers.get('content-type'), get.headers.get('content-type'), path)
      assert.equal(await head.text(), '', `${path} HEAD must carry no body`)
    }
  } finally {
    await h.close()
  }
})
