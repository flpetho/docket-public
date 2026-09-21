/**
 * Evaluate an expression in the running board and print the result.
 *
 * Exists because judging rendered colour or geometry from a screenshot is
 * guesswork — atlas's ui-check records the same lesson. Assert what the
 * browser computed, not what the source implies.
 *
 *   node scripts/probe.mjs [--width <px>] <url> "<js expression returning JSON-able value>"
 *
 * `--width` exists because responsive geometry asserted at one width proves
 * almost nothing: a hardcoded gutter and a `clamp()` that happens to be at its
 * maximum are indistinguishable at 1600px. Measuring a second, narrower width
 * is what separates them.
 */

import { spawn } from 'node:child_process'

// The owner's Mac by default. Overridable because a cloud session has no
// /Applications and its Chromium lives elsewhere — without this, the one place
// that can check rendered geometry is unavailable exactly when working remotely.
const CHROME = process.env.DOCKET_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Per-process: a fixed port means two probes cannot run at once, and they do
// whenever a gate verifies while other work continues.
const PORT = 9300 + (process.pid % 600)
const DEFAULT_WIDTH = 1600
const HEIGHT = 1000

const argv = process.argv.slice(2)
const widthIndex = argv.indexOf('--width')
const width = widthIndex === -1 ? DEFAULT_WIDTH : Number(argv[widthIndex + 1])
if (widthIndex !== -1) argv.splice(widthIndex, 2)

const [url, expression] = argv
if (!url || !expression || !Number.isFinite(width) || width <= 0) {
  console.error('usage: node scripts/probe.mjs [--width <px>] <url> "<expression>"')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Extra flags, opt-in and empty by default.
 *
 * This exists for `--no-sandbox`, which a container running as root requires and
 * which must NOT be the default: it is a real reduction in Chrome's isolation,
 * and the Mac this normally runs on has no need of it. Opt in per environment
 * (`DOCKET_CHROME_FLAGS=--no-sandbox`) rather than paying for it everywhere.
 */
const EXTRA = (process.env.DOCKET_CHROME_FLAGS ?? '').split(' ').filter(Boolean)

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    ...EXTRA,
    `--window-size=${width},${HEIGHT}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/docket-probe-${process.pid}`,
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

try {
  let wsUrl = null
  for (let attempt = 0; attempt < 40 && !wsUrl; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
    } catch {
      /* still starting */
    }
    if (!wsUrl) await sleep(150)
  }
  if (!wsUrl) throw new Error('chrome never exposed a page target')

  socket = new WebSocket(wsUrl)
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
  // --window-size gets the window roughly right; this makes innerWidth exactly
  // the requested width, so a measured gutter can be compared against the width
  // that produced it without a scrollbar's worth of doubt.
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })

  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await send('Runtime.evaluate', {
      expression: 'document.querySelectorAll(".card").length > 0',
      returnByValue: true,
    })
    if (ready.result.value) break
    await sleep(200)
  }

  // The await must happen *inside* the page, before stringify: stringifying a
  // promise yields "{}", which reads as "the probe found nothing".
  const result = await send('Runtime.evaluate', {
    expression: `(async () => JSON.stringify(await (async () => { ${expression} })()))()`,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  console.log(JSON.stringify(JSON.parse(result.result.value), null, 2))
} finally {
  socket?.close()
  chrome.kill('SIGKILL')
}
