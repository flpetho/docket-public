/**
 * Screenshot the running board over CDP.
 *
 * `--virtual-time-budget` cannot be used here: the board holds an open
 * EventSource, so the virtual clock never settles and Chrome hangs forever.
 * Instead this drives real headless Chrome and polls for a *rendered condition*
 * — the same lesson atlas's scripts/ui-check/cdp.mjs records about fixed
 * sleeps producing false results.
 *
 *   node scripts/shot.mjs <url> <out.png> [width] [height]
 */

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

// Overridable for the same reason probe.mjs is: no /Applications in the cloud.
const CHROME = process.env.DOCKET_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333

const [url, out, width = '1600', height = '1000'] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [width] [height]')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Opt-in extra flags — see the note in probe.mjs. `--no-sandbox` is why. */
const EXTRA = (process.env.DOCKET_CHROME_FLAGS ?? '').split(' ').filter(Boolean)

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    ...EXTRA,
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/docket-shot-${process.pid}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let socket
let nextId = 1
const pending = new Map()

const send = (method, params = {}) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function targetUrl() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* chrome still starting */
    }
    await sleep(150)
  }
  throw new Error('chrome never exposed a page target')
}

try {
  socket = new WebSocket(await targetUrl())
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url })

  // Poll for cards rather than sleeping: the board renders after two fetches,
  // and a fixed wait is either flaky or slow.
  let cards = 0
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await send('Runtime.evaluate', {
      expression: 'document.querySelectorAll(".card").length',
      returnByValue: true,
    })
    cards = result.result.value ?? 0
    if (cards > 0) break
    await sleep(200)
  }
  if (!cards) {
    const errors = await send('Runtime.evaluate', {
      expression: 'document.getElementById("status")?.textContent ?? "(no status)"',
      returnByValue: true,
    })
    throw new Error(`no cards rendered — status says: ${errors.result.value}`)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(out, Buffer.from(shot.data, 'base64'))
  console.log(`${cards} cards rendered → ${out}`)
} finally {
  socket?.close()
  chrome.kill('SIGKILL')
}
