#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'

import { columnKeys, defaultConfig, readConfig } from '../src/config.js'
import { createInbox } from '../../bot/src/inbox.js'
import { createDaemon } from '../src/daemon.js'
import { orphanedCards } from '../src/card.js'
import { listAttachmentFiles, orphanedAttachments, removeAttachment } from '../src/attachments.js'
import { drain, drainLine, firstLine } from '../src/drain.js'
import { advanceWatermark, boardNews, firstRun, markFor, summarise } from '../src/news.js'
import { paletteForTracks, toDocket } from '../src/migrate.js'
import { findProjectRoot, addProject, readRegistry } from '../src/registry.js'
import { renderSnapshot } from '../src/snapshot.js'
import {
  describeState,
  domainTarget,
  install as installService,
  logPath,
  plistPath,
  serviceState,
  serviceTarget,
  uninstall as uninstallService,
  DRAIN_INTERVAL_SECONDS,
  describeDrainState,
  describePushState,
  drainLogPath,
  drainPlistPath,
  installPush,
  PUSH_INTERVAL_SECONDS,
  pushLogPath,
  pushPlistPath,
  pushStatusPath,
  pushTarget,
  uninstallPush,
  drainState,
  drainStatusPath,
  drainTarget,
  installDrain,
  redactSecrets,
  safeError,
  uninstallDrain,
} from '../src/service.js'
import { readBoard } from '../src/store.js'

const USAGE = `usage:
  docket init [--name <name>] [--from-tracker <tracker-board.json>]
  docket doctor [--port <port>]
  docket prune
  docket push
  docket install-push [--every 300]
  docket serve [--port <port>]
  docket drain [--dry-run] [--repo <owner/name>]
  docket forget <slug>
  docket install [--port <port>]
  docket uninstall
  docket install-drain [--every <seconds>]
  docket uninstall-drain
  docket news [--peek]
  docket snapshot [--out <file>]`

const flag = (argv, name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1] ?? null
}

const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`)

async function init(argv, { cwd, registryFile, now, log }) {
  const name = flag(argv, '--name') ?? basename(cwd)
  const fromTracker = flag(argv, '--from-tracker')
  const dir = join(cwd, '.docket')
  const boardFile = join(dir, 'board.json')
  const configFile = join(dir, 'config.json')

  let board = { rev: 0, updatedAt: now().toISOString(), cards: [] }
  let palette = {}
  if (fromTracker) {
    let raw
    try {
      raw = await readFile(fromTracker, 'utf8')
    } catch {
      log(`cannot read ${fromTracker}`)
      return 1
    }
    const tracker = JSON.parse(raw)
    board = toDocket(tracker)
    palette = paletteForTracks(tracker)
    const notes = board.cards.reduce((sum, c) => sum + c.notes.length, 0)
    log(`migrated ${board.cards.length} cards and ${notes} notes from ${fromTracker}`)
  }

  await mkdir(dir, { recursive: true })
  const existing = await readBoard(boardFile).catch(() => null)
  if (existing) {
    log(`${boardFile} already exists — leaving it alone`)
  } else {
    await writeJson(boardFile, board)
    log(`wrote ${boardFile}`)
  }

  let config = null
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'))
  } catch {
    config = null
  }
  if (!config) {
    const fresh = defaultConfig(name)
    fresh.tags = palette
    await writeJson(configFile, fresh)
    log(
      Object.keys(palette).length
        ? `wrote ${configFile} with ${Object.keys(palette).length} declared tag colours`
        : `wrote ${configFile}`,
    )
  }

  const entry = await addProject(registryFile, { path: cwd, name, now })
  log(`registered ${entry.name} as ${entry.slug}`)
  return 0
}

async function inboxClient(override) {
  const token =
    process.env.GITHUB_TOKEN ??
    (await import('node:child_process'))
      .execSync('gh auth token', { encoding: 'utf8' })
      .trim()
  // No default: this used to fall back to the author's own inbox repo, so an
  // unset INBOX_REPO drained from a stranger's captures rather than saying so.
  const repo = override ?? process.env.INBOX_REPO
  if (!repo) {
    throw new Error('no inbox repo — pass --repo <owner/name> or set INBOX_REPO')
  }
  return createInbox({ token, repo })
}

async function doctor(argv, { registryFile, log, inboxClient }) {
  const registry = await readRegistry(registryFile)
  if (!registry.projects.length) {
    log('no projects registered — run docket init in a project')
    return 0
  }
  for (const entry of registry.projects) {
    const doc = await readBoard(join(entry.path, '.docket', 'board.json')).catch(() => null)
    log(
      doc
        ? `${entry.slug}  ${entry.name}  ${doc.cards.length} cards  rev ${doc.rev}  ${entry.path}`
        : `${entry.slug}  ${entry.name}  board MISSING at ${entry.path}`,
    )
    // A card whose column is absent from the config is invisible in the UI and
    // unwritable by the store. Zero is silent.
    const config = doc && (await readConfig(join(entry.path, '.docket', 'config.json')).catch(() => null))
    if (config) {
      for (const card of orphanedCards(doc.cards, columnKeys(config))) {
        log(`  ⚠ ${card.id} sits in "${card.column}" — not in config, invisible in the UI`)
      }
    }
    // Blobs nothing points at. Reported here, removed only by an explicit
    // `docket prune` — deleting the owner's pasted images as a side effect of
    // a health check is not acceptable. Zero is silent.
    if (doc) {
      const orphans = orphanedAttachments(await listAttachmentFiles(entry.path), doc.cards)
      if (orphans.length) {
        log(`  ⚠ ${orphans.length} attachment file${orphans.length === 1 ? '' : 's'} referenced by nothing — docket prune removes them`)
      }
    }
  }

  // Loaded is not the same as working. A plist pointing at a node binary that
  // has moved is loaded, launchd tried it, the process exited, and launchd gave
  // up — the board is dead and nothing else here would say so.
  const home = process.env.HOME ?? process.cwd()
  // Asked, not assumed: this was hardcoded, so `docket install --port 8888`
  // produced a board that worked and a doctor that called it dead.
  const port = Number(flag(argv, '--port') ?? 7777)
  const state = await serviceHealth({ home, uid: process.getuid(), port, effects: serviceEffects() })
  log('')
  log(describeState(state, { port, log: logPath(home) }))
  // A broken serve daemon is obvious the moment you open the board. A drain that
  // stopped firing looks exactly like nobody having sent anything, which is why
  // it gets its own line and why 'stale' is a failure state.
  const drainHealthNow = await drainHealth({ home, uid: process.getuid(), effects: serviceEffects() })
  const pushHealthNow = await pushHealth({ home, uid: process.getuid(), effects: serviceEffects() })
  if (pushHealthNow.state !== 'absent') {
    log(
      describePushState(pushHealthNow.state, {
        status: pushHealthNow.status,
        log: pushLogPath(home),
        now: Date.now(),
      }),
    )
  }
  log(
    describeDrainState(drainHealthNow.state, {
      status: drainHealthNow.status,
      log: drainLogPath(home),
      now: Date.now(),
    }),
  )

  // Which Telegram bucket reaches which board. A bucket maps to a project by
  // matching slug, so a mismatch is invisible until something fails to drain.
  try {
    const inbox = await inboxClient()
    const buckets = await inbox.readBuckets()
    const slugs = new Set(registry.projects.map((p) => p.slug))
    log('')
    log('telegram bucket → board')
    for (const bucket of buckets) {
      const waiting = (await inbox.listDir(`captures/${bucket}`)).length
      const pending = waiting ? `  ${waiting} waiting` : ''
      log(
        slugs.has(bucket)
          ? `  ${bucket} → ${bucket}${pending}`
          : `  ${bucket} → (no board; captures stay in the repo)${pending}`,
      )
    }
  } catch (error) {
    log(`\ncould not read buckets: ${safeError(error.message)}`)
  }
  return 0
}

/**
 * Removes attachment files no card references, across every registered
 * project. Its own command on purpose: the owner typing it IS the asking.
 * Reads boards, never writes one; deletes go through attachments.js alone.
 */
async function pruneCommand({ registryFile, log }) {
  const registry = await readRegistry(registryFile)
  let removed = 0
  for (const entry of registry.projects) {
    const doc = await readBoard(join(entry.path, '.docket', 'board.json')).catch(() => null)
    if (!doc) continue
    const orphans = orphanedAttachments(await listAttachmentFiles(entry.path), doc.cards)
    for (const file of orphans) {
      if (await removeAttachment(entry.path, file)) {
        removed += 1
        log(`${entry.slug}  removed ${file}`)
      }
    }
  }
  log(removed ? `${removed} file${removed === 1 ? '' : 's'} removed` : 'nothing to prune — every attachment is referenced')
  return 0
}

async function drainCommand(argv, { registryFile, log, inboxClient }) {
  // `--repo` was in the usage text from the first version and never read.
  const repoOverride = flag(argv, '--repo')
  const dryRun = argv.includes('--dry-run')
  const home = process.env.HOME ?? process.cwd()
  // A dry run must never record a success — it did not do anything.
  const record = (patch) => (dryRun ? Promise.resolve() : drainStatus.write(home, patch))
  const failed = async (error, prefix) => {
    const reason = safeError(error.message)
    await record({ lastFailureAt: new Date().toISOString(), lastError: reason })
    log(`${prefix}: ${reason}`)
    return 1
  }

  let inbox
  try {
    inbox = await inboxClient(repoOverride)
  } catch (error) {
    return failed(error, 'cannot reach the inbox repo')
  }

  let report
  try {
    report = await drain({ inbox, registryFile, dryRun })
  } catch (error) {
    return failed(error, 'drain failed')
  }
  for (const item of report.drained) {
    log(drainLine(item, { tty: Boolean(process.stdout.isTTY) }))
  }
  for (const item of report.unmapped) {
    log(`no board for bucket "${item.bucket}" — ${item.count} capture(s) left in the repo`)
  }
  for (const item of report.skipped) {
    log(`skipped  ${item.bucket}/${item.file ?? ''}  ${item.reason}`)
  }
  if (!report.drained.length && !report.unmapped.length && !report.skipped.length) {
    log('nothing waiting in the inbox')
  }
  // Counts only. A card title is the owner's content and does not belong in a
  // file whose whole purpose is to be readable by a health check.
  await record({
    lastSuccessAt: new Date().toISOString(),
    lastError: null,
    drained: report.drained.length,
    unmapped: report.unmapped.length,
    skipped: report.skipped.length,
  })
  return 0
}

/** Unregisters a project. Never touches its .docket directory — only the registry. */
async function forget(argv, { registryFile, log }) {
  const slug = argv[1]
  if (!slug) {
    log('usage: docket forget <slug>')
    return 1
  }
  const registry = await readRegistry(registryFile)
  const entry = registry.projects.find((p) => p.slug === slug)
  if (!entry) {
    log(`no project "${slug}". Known: ${registry.projects.map((p) => p.slug).join(', ') || 'none'}`)
    return 1
  }
  registry.projects = registry.projects.filter((p) => p.slug !== slug)
  await writeJson(registryFile, registry)
  log(`forgot ${slug}. Its board is untouched at ${entry.path}/.docket/`)
  return 0
}

async function serve(argv, { registryFile, log }) {
  const port = Number(flag(argv, '--port') ?? 7777)
  const daemon = createDaemon({ registryFile })
  const actual = await daemon.listen(port)
  log(`docket  http://localhost:${actual}`)
  return new Promise(() => {}) // run until killed
}

// ---- the launchd service ------------------------------------------------

/**
 * The real effects behind service.js. Kept here rather than there so the module
 * stays testable without launchctl, a socket, or a filesystem.
 */
const serviceEffects = () => ({
  probePort: (port) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      const done = (held) => {
        socket.destroy()
        resolve(held)
      }
      socket.setTimeout(700)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  mkdirAt: (dir) => mkdir(dir, { recursive: true }),
  writeFileAt: (path, body) => writeFile(path, body),
  unlinkAt: (path) => unlink(path),
  exists: (path) => readFile(path).then(() => true).catch(() => false),
  run: (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }))
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    }),
})

/** Loaded is a launchctl question; answering is an HTTP one. They differ, and that matters. */
async function serviceHealth({ home, uid, port, effects }) {
  const plistExists = await effects.exists(plistPath(home))
  const printed = await effects.run('launchctl', ['print', serviceTarget(uid)])
  const loaded = printed.code === 0
  let answering = false
  if (loaded) {
    answering = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      signal: AbortSignal.timeout(1500),
    })
      .then((response) => response.ok)
      .catch(() => false)
  }
  return serviceState({ plistExists, loaded, answering })
}

async function installCommand(argv, { log }) {
  const port = Number(flag(argv, '--port') ?? 7777)
  const home = process.env.HOME ?? process.cwd()
  const effects = serviceEffects()
  const result = await installService({
    home,
    uid: process.getuid(),
    // process.execPath is the absolute path of the node running this, which is the
    // only honest answer available: launchd has no PATH to resolve "node" against.
    nodePath: process.execPath,
    scriptPath: fileURLToPath(new URL('./docket.js', import.meta.url)),
    port,
    effects,
  })
  if (!result.ok) {
    log(result.reason)
    return 1
  }
  log(`wrote ${result.plist}`)
  log(`logging to ${result.log}`)
  // A freshly bootstrapped agent takes a moment to bind, so reporting the state
  // immediately would print 'NOT answering' about a service that is fine. Wait
  // for the real answer rather than making the owner run doctor to get it.
  let state = 'unloaded'
  for (let attempt = 0; attempt < 20; attempt++) {
    state = await serviceHealth({ home, uid: process.getuid(), port, effects })
    if (state === 'healthy') break
    await effects.sleep(250)
  }
  log(describeState(state, { port, log: logPath(home) }))
  return state === 'healthy' ? 0 : 1
}

async function uninstallCommand({ log }) {
  const home = process.env.HOME ?? process.cwd()
  const result = await uninstallService({ home, uid: process.getuid(), effects: serviceEffects() })
  if (result.stillThere) {
    log(`could not remove ${result.plist}`)
    return 1
  }
  log(
    result.had
      ? `unloaded ${domainTarget(process.getuid())} and removed ${result.plist}`
      : 'no service was installed. Nothing to remove.',
  )
  log(`the log at ${logPath(home)} is left alone, and no board was touched.`)
  return 0
}

// ---- the drain timer ----------------------------------------------------

export const drainStatus = {
  read: async (home) =>
    readFile(drainStatusPath(home), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
  /**
   * Counts and timestamps only. Never a card title — that is the owner's
   * content. And never a raw error: every string in the patch passes the
   * redactor HERE, so a call site that forgets safeError cannot produce an
   * unredacted file — a gate found exactly that mutation surviving every
   * test on 2026-08-23. The 300 cut stays the call site's job; that
   * difference is what lets a test catch a site that stops cutting.
   */
  write: async (home, patch) => {
    const previous = (await drainStatus.read(home)) ?? {}
    const safe = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [
        key,
        typeof value === 'string' ? redactSecrets(value) : value,
      ]),
    )
    await mkdir(`${home}/.docket`, { recursive: true })
    await writeJson(drainStatusPath(home), { ...previous, ...safe })
  },
}

export const pushStatus = {
  read: async (home) =>
    readFile(pushStatusPath(home), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
  /** Same contract as drainStatus.write: every string passes the redactor here. */
  write: async (home, patch) => {
    const previous = (await pushStatus.read(home)) ?? {}
    const safe = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [
        key,
        typeof value === 'string' ? redactSecrets(value) : value,
      ]),
    )
    await mkdir(`${home}/.docket`, { recursive: true })
    await writeJson(pushStatusPath(home), { ...previous, ...safe })
  },
}

/**
 * The board reaching git on its own. Acts on the project containing cwd, and
 * ONLY when it is on main — the owner's ruling — so a checked-out feature
 * branch turns the timer into a deliberate skip, never a stray commit. Only
 * .docket/board.json is ever committed: git commit with a pathspec takes the
 * working-tree content of that path and leaves everything else, staged or
 * not, exactly alone.
 */
async function pushCommand({ cwd, log, git }) {
  const home = process.env.HOME ?? process.cwd()
  const root = await findProjectRoot(cwd)
  if (!root) {
    log('not inside a docket project')
    return 1
  }
  const runGit = git ?? (async (args) => {
    const child = spawn('git', args, { cwd: root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    return new Promise((resolve) => {
      child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }))
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  })
  const ok = async () => {
    await pushStatus.write(home, { lastSuccessAt: new Date().toISOString(), lastError: null })
    return 0
  }
  const failed = async (reason) => {
    await pushStatus.write(home, {
      lastFailureAt: new Date().toISOString(),
      lastError: safeError(reason),
    })
    log(`push failed: ${safeError(reason)}`)
    return 1
  }

  // The timer ships the repo's DEFAULT branch, whatever it is named. It used
  // to require the literal name `main`, so a repo on `master` or `trunk`
  // reported "skipped" on every tick forever and never said why.
  //
  // Three questions, each its own command so the answers cannot be confused:
  // which branch is checked out, which remote to push to, and which branch that
  // remote considers its default. The guard is still "only the default branch" —
  // a feature branch is the owner's to push, deliberately, never a timer's.
  const current = (await runGit(['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
  const remote = (await runGit(['remote', 'show'])).stdout.trim().split('\n')[0]?.trim() ?? ''
  if (!remote) {
    log('no git remote — skipped, the timer has nowhere to push')
    return ok()
  }
  // Gated on the exit code, not on emptiness: `rev-parse --abbrev-ref` ECHOES
  // its argument back when the ref does not resolve, so an unset origin/HEAD
  // produced the branch name "HEAD" and every push was skipped. `git remote add`
  // plus `push -u` never writes origin/HEAD — only a clone does — so the unset
  // case is the common one, not the exotic one.
  const head = await runGit(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])
  const remoteHead = head.code === 0 ? head.stdout.trim().replace(`${remote}/`, '') : ''
  const fallback = await runGit(['config', '--get', 'init.defaultBranch'])
  const preferred = remoteHead || (fallback.code === 0 ? fallback.stdout.trim() : '') || 'main'
  if (!current || current !== preferred) {
    log(`on ${current || 'a detached HEAD'} — skipped, the timer only ships ${preferred}`)
    return ok()
  }

  const dirty = await runGit(['status', '--porcelain', '--', '.docket/board.json'])
  if (dirty.stdout.trim()) {
    const doc = await readBoard(join(root, '.docket', 'board.json')).catch(() => null)
    const commit = await runGit([
      'commit',
      '-m',
      `chore(board): rev ${doc?.rev ?? '?'} — the push timer`,
      '--',
      '.docket/board.json',
    ])
    if (commit.code !== 0) return failed(`commit: ${commit.stderr.trim() || commit.code}`)
    log(`committed board rev ${doc?.rev ?? '?'}`)
  }

  // The push gates on the board being the REASON to push. Counting ahead
  // commits is not enough — a gate proved that version live, shipping an
  // unfinished code commit off a clean board. A history that touches anything
  // beyond the board is the owner's to push, deliberately, never a timer's.
  const aheadFiles = await runGit(['log', `${remote}/${current}..HEAD`, '--name-only', '--format='])
  const files = [...new Set(aheadFiles.stdout.split('\n').map((line) => line.trim()).filter(Boolean))]
  if (files.length === 0) {
    log('nothing to push')
    return ok()
  }
  const foreign = files.filter((file) => file !== '.docket/board.json')
  if (foreign.length) {
    log(`ahead commits touch more than the board (${foreign.join(', ')}) — skipped, those are yours to push`)
    return ok()
  }

  let pushed = await runGit(['push', remote, current])
  if (pushed.code !== 0) {
    // The remote moved — a merged PR, a cloud write. Rebase is only safe over
    // a clean tree, and git refuses it over unstaged tracked changes anyway —
    // so say the real reason instead of attempting a doomed recovery.
    const localEdits = await runGit(['status', '--porcelain', '--untracked-files=no'])
    if (localEdits.stdout.trim()) {
      return failed('remote moved while local edits exist — push or stash them and the next tick clears')
    }
    const rebase = await runGit(['pull', '--rebase', remote, current])
    if (rebase.code !== 0) {
      await runGit(['rebase', '--abort'])
      return failed(`rebase: ${rebase.stderr.trim() || rebase.code}`)
    }
    pushed = await runGit(['push', remote, current])
    if (pushed.code !== 0) return failed(`push: ${pushed.stderr.trim() || pushed.code}`)
  }
  log('pushed')
  return ok()
}

async function pushHealth({ home, uid, effects }) {
  const plistExists = await effects.exists(pushPlistPath(home))
  const printed = await effects.run('launchctl', ['print', pushTarget(uid)])
  const status = await pushStatus.read(home)
  const state = drainState({
    plistExists,
    loaded: printed.code === 0,
    status,
    intervalSeconds: PUSH_INTERVAL_SECONDS,
    now: Date.now(),
  })
  return { state, status }
}

async function installPushCommand(argv, { cwd, log }) {
  const home = process.env.HOME ?? process.cwd()
  const root = await findProjectRoot(cwd)
  if (!root) {
    log('not inside a docket project — run this from the repo whose board should push')
    return 1
  }
  const intervalSeconds = Number(flag(argv, '--every') ?? PUSH_INTERVAL_SECONDS)
  const result = await installPush({
    home,
    uid: process.getuid(),
    nodePath: process.execPath,
    scriptPath: fileURLToPath(new URL('./docket.js', import.meta.url)),
    repoDir: root,
    intervalSeconds,
    effects: serviceEffects(),
  })
  if (!result.ok) {
    log(result.reason)
    return 1
  }
  log(`wrote ${result.plist}`)
  log(`every ${intervalSeconds}s · pushing ${root} · logging to ${result.log}`)
  return 0
}

async function uninstallPushCommand({ log }) {
  const home = process.env.HOME ?? process.cwd()
  const result = await uninstallPush({ home, uid: process.getuid(), effects: serviceEffects() })
  log(result.had ? `removed ${result.plist}` : 'no push timer was installed')
  return 0
}

/** gh's directory, so the plist's PATH can find it. The credential stays gh's business. */
async function resolveGhDir(effects) {
  const found = await effects.run('/usr/bin/which', ['gh'])
  const path = found.stdout.trim().split('\n')[0]
  if (found.code !== 0 || !path) return null
  return path.replace(/\/[^/]+$/, '')
}

async function drainHealth({ home, uid, effects }) {
  const plistExists = await effects.exists(drainPlistPath(home))
  const printed = await effects.run('launchctl', ['print', drainTarget(uid)])
  const status = await drainStatus.read(home)
  const state = drainState({
    plistExists,
    loaded: printed.code === 0,
    status,
    now: Date.now(),
  })
  return { state, status }
}

async function installDrainCommand(argv, { log }) {
  const home = process.env.HOME ?? process.cwd()
  const intervalSeconds = Number(flag(argv, '--every') ?? DRAIN_INTERVAL_SECONDS)
  const effects = serviceEffects()
  const ghDir = await resolveGhDir(effects)
  if (!ghDir) {
    log('cannot find gh on PATH. The drain reads its GitHub token with `gh auth token`,')
    log('so gh has to exist. Install it, or run `gh auth login`, then try again.')
    return 1
  }
  const result = await installDrain({
    home,
    uid: process.getuid(),
    nodePath: process.execPath,
    scriptPath: fileURLToPath(new URL('./docket.js', import.meta.url)),
    ghDir,
    intervalSeconds,
    effects,
  })
  if (!result.ok) {
    log(result.reason)
    return 1
  }
  log(`wrote ${result.plist}`)
  log(`every ${intervalSeconds}s · logging to ${result.log} · gh from ${ghDir}`)
  // RunAtLoad means it drains immediately; wait for the first result rather than
  // reporting "never ran" about a job that is about to run.
  let health = await drainHealth({ home, uid: process.getuid(), effects })
  for (let attempt = 0; attempt < 24 && health.state === 'never-ran'; attempt++) {
    await effects.sleep(500)
    health = await drainHealth({ home, uid: process.getuid(), effects })
  }
  log(describeDrainState(health.state, { status: health.status, log: drainLogPath(home), now: Date.now() }))
  return health.state === 'healthy' ? 0 : 1
}

async function uninstallDrainCommand({ log }) {
  const home = process.env.HOME ?? process.cwd()
  const result = await uninstallDrain({ home, uid: process.getuid(), effects: serviceEffects() })
  if (result.stillThere) {
    log(`could not remove ${result.plist}`)
    return 1
  }
  log(result.had ? `unscheduled the drain and removed ${result.plist}` : 'the drain was not scheduled.')
  log('captures already on a board stay there, and nothing in the inbox was touched.')
  return 0
}

// ---- what the owner has said --------------------------------------------

const newsWatermarkPath = (home) => `${home}/.docket/news-watermark.json`

/**
 * Reports owner notes and drained captures newer than the watermark, then moves
 * the watermark to now.
 *
 * --peek reports without advancing. Not a convenience: the exactly-once property
 * means a run consumes what it shows, so without a way to look without consuming,
 * every mistake is unrecoverable.
 */
async function newsCommand(argv, { registryFile, log }) {
  const peek = argv.includes('--peek')
  const home = process.env.HOME ?? process.cwd()
  const markPath = newsWatermarkPath(home)
  // Captured BEFORE reading, so anything written during the scan is newer than
  // the new mark and gets reported next time rather than skipped.
  const readAt = new Date().toISOString()

  const watermark = await readFile(markPath, 'utf8')
    .then(JSON.parse)
    .catch(() => ({}))

  const registry = await readRegistry(registryFile)
  const results = []
  const firstRunProjects = []

  for (const entry of registry.projects) {
    const doc = await readBoard(join(entry.path, '.docket', 'board.json')).catch(() => null)
    if (!doc) continue
    const since = markFor(watermark, entry.slug)
    if (since === null) firstRunProjects.push(entry.slug)
    results.push(boardNews({ slug: entry.slug, doc, since }))
  }

  const items = summarise(results)

  if (firstRunProjects.length) {
    log(`no watermark yet for ${firstRunProjects.join(', ')} — ${firstRun.reason}`)
    log('(a note written through the browser is recorded as "owner" whoever typed it,')
    log(' so an agent driving the UI is indistinguishable from the owner here.)')
  }

  for (const item of items) {
    const where = `${item.project}/${item.cardId} [${item.column}]`
    if (item.kind === 'capture') {
      log(`capture  ${item.at}  ${where}`)
      log(`         ${item.cardTitle}`)
      if (item.detail?.trim()) log(`         ${firstLine(item.detail)}`)
    } else {
      log(`note     ${item.at}  ${where}`)
      log(`         on: ${item.cardTitle}`)
      for (const line of String(item.text).split('\n')) log(`         ${line}`)
    }
  }

  if (!items.length && !firstRunProjects.length) log('nothing new')

  if (!peek) {
    let next = watermark
    for (const entry of registry.projects) next = advanceWatermark(next, entry.slug, readAt)
    await mkdir(`${home}/.docket`, { recursive: true })
    await writeJson(markPath, next)
  } else if (items.length) {
    log('')
    log('--peek: the watermark was NOT advanced, so this will report again.')
  }
  return 0
}

/**
 * The board as one read-only HTML file, for a phone that cannot reach the daemon.
 *
 * Works on the project in `cwd`, like `init`, because a snapshot is of a board
 * rather than of the registry — and because the case this exists for is a cloud
 * session that has cloned exactly one repo and has no registry at all.
 *
 * The commit is read but never required: a snapshot of a dirty tree is still a
 * useful snapshot, it just cannot name where it came from.
 */
async function snapshotCommand(argv, { cwd, now, log }) {
  const dir = join(cwd, '.docket')
  const boardFile = join(dir, 'board.json')

  let board
  try {
    board = await readBoard(boardFile)
  } catch (error) {
    log(`cannot read ${boardFile}: ${safeError(error.message)}`)
    return 1
  }
  // readBoard returns null for a missing file rather than throwing, so this is
  // the check that matters: without it a directory with no board renders a
  // perfectly convincing snapshot of nothing.
  if (!board) {
    log(`no board at ${boardFile}`)
    log('run docket init here first, or cd to a project that has a board')
    return 1
  }
  const config = await readConfig(join(dir, 'config.json'))
  if (!config) {
    log(`no config.json beside ${boardFile} — cannot name the columns`)
    return 1
  }

  // Inlined so the file opens with the right face offline, which is the actual
  // situation this is for. Missing fonts degrade to the system stack rather than
  // failing: a snapshot in Helvetica beats no snapshot.
  const fontDir = join(fileURLToPath(new URL('../ui/fonts/', import.meta.url)))
  const font = async (name) =>
    readFile(join(fontDir, name)).then((buffer) => buffer.toString('base64'), () => null)
  const [sans, mono] = await Promise.all([font('geist-latin.woff2'), font('geist-mono-latin.woff2')])

  const commit = await new Promise((resolve) => {
    const git = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    git.stdout.on('data', (chunk) => (out += chunk))
    git.on('error', () => resolve(null))
    git.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null))
  })

  const html = renderSnapshot({
    board,
    config,
    meta: { now: now(), commit, fonts: { sans, mono } },
  })

  const out = flag(argv, '--out') ?? join(dir, 'snapshot.html')
  await mkdir(dirname(out), { recursive: true })
  // Never through the log boundary: redactSecrets rewrites lines, and rewriting
  // a rendered document would corrupt the owner's own card text.
  await writeFile(out, html)
  log(`wrote ${out}  ${board.cards.length} cards  rev ${board.rev}${commit ? `  ${commit}` : ''}`)
  log('read-only — open it on the phone; the board on the Mac stays the only copy')
  return 0
}

export async function runCli(argv, options) {
  const { cwd, registryFile, now = () => new Date(), log = console.log } = options
  // THE redaction boundary. Every line any command prints passes the rules
  // here, so the third place somebody logs an error is protected by default —
  // two hand-placed safeError calls were how the last leak got missed. Rules
  // only, no 300-character cut: news prints whole notes and must stay whole.
  const safeLog = (line) => log(redactSecrets(line))
  const context = {
    cwd,
    registryFile,
    now,
    log: safeLog,
    inboxClient: options.inboxClient ?? inboxClient,
  }
  const [command] = argv
  // Awaited so a rejection lands in the catch below rather than escaping to a
  // caller that would print it raw.
  try {
    if (command === 'init') return await init(argv, context)
    if (command === 'doctor') return await doctor(argv, context)
    if (command === 'serve') return await serve(argv, context)
    if (command === 'drain') return await drainCommand(argv, context)
    if (command === 'prune') return await pruneCommand(context)
    if (command === 'push') return await pushCommand({ ...context, git: options.git })
    if (command === 'install-push') return await installPushCommand(argv, context)
    if (command === 'uninstall-push') return await uninstallPushCommand(context)
    if (command === 'forget') return await forget(argv, context)
    if (command === 'install') return await installCommand(argv, context)
    if (command === 'uninstall') return await uninstallCommand(context)
    if (command === 'install-drain') return await installDrainCommand(argv, context)
    if (command === 'uninstall-drain') return await uninstallDrainCommand(context)
    if (command === 'news') return await newsCommand(argv, context)
    if (command === 'snapshot') return await snapshotCommand(argv, context)
    safeLog(USAGE)
    return 1
  } catch (error) {
    // The stack is the useful part and the boundary above redacts it.
    safeLog(`unexpected failure: ${error?.stack ?? error}`)
    return 1
  }
}

// Only run when invoked directly, so importing this in a test does nothing.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const home = process.env.HOME ?? process.cwd()
  runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    registryFile: join(home, '.docket', 'projects.json'),
  }).then((code) => process.exit(code))
}
