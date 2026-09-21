/**
 * The launchd agent that keeps the daemon up.
 *
 * Split so the interesting half is testable: everything that decides *what* the
 * service should be is a pure function here, and the two functions that actually
 * touch launchctl and the filesystem take their effects as arguments. board/ has
 * no dependencies and no launchctl in CI, so anything decidable without running
 * a command gets decided without running one.
 *
 * The plist hardcodes an absolute node path, deliberately. launchd has no shell
 * and no PATH worth trusting, so there is no honest alternative — see the
 * 2026-08-21 decision log. The cost is that an nvm upgrade moves node and the
 * agent silently stops working, which is why `describeState` treats "loaded" and
 * "answering" as different questions.
 */

export const SERVICE_LABEL = 'com.docket.serve'

export const plistPath = (home) => `${home}/Library/LaunchAgents/${SERVICE_LABEL}.plist`
export const logPath = (home) => `${home}/.docket/serve.log`
export const serviceTarget = (uid) => `gui/${uid}/${SERVICE_LABEL}`
export const domainTarget = (uid) => `gui/${uid}`

/** The five characters XML cannot carry raw. A path with an & in it is legal on macOS. */
const xml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/**
 * The agent definition.
 *
 * KeepAlive with SuccessfulExit false rather than plain true: the daemon running
 * until killed is the normal case, and a clean exit should not be restarted in a
 * tight loop. RunAtLoad so a login brings it up without a second command.
 */
export function plistXml({ nodePath, scriptPath, log, port }) {
  const args = [nodePath, scriptPath, 'serve', '--port', String(port)]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`
}

/**
 * Which of the four states the service is in.
 *
 * `loaded` and `answering` are asked separately on purpose. A plist pointing at a
 * node binary that has moved is loaded, launchd tried it, the process exited, and
 * launchd gave up — the board is dead and nothing says so. Treating a loaded job
 * as a healthy one is the specific failure this exists to make impossible.
 */
export function serviceState({ plistExists, loaded, answering }) {
  if (!plistExists) return 'absent'
  if (!loaded) return 'unloaded'
  if (!answering) return 'broken'
  return 'healthy'
}

const WORDS = {
  absent: 'not installed — run docket install',
  unloaded: 'plist present but not loaded — run docket install again',
  broken: 'loaded but NOT answering — check the node path in the plist and the log',
  healthy: 'loaded and answering',
}

/** One line for doctor. Names the log on any unhappy state, since that is the next step. */
export function describeState(state, { port, log } = {}) {
  const detail = state === 'healthy' ? ` on :${port}` : state === 'absent' ? '' : ` · ${log}`
  return `service  ${WORDS[state]}${detail}`
}

/**
 * Installs the agent. Every effect is injected.
 *
 * Refuses when the port is already held, rather than writing a plist whose job
 * can only ever fail to bind. `docket serve` started by hand is the usual cause,
 * and killing somebody else's process is not this command's business.
 */
export async function install({ home, uid, nodePath, scriptPath, port, effects }) {
  const { writeFileAt, mkdirAt, run, probePort, exists, sleep } = effects
  const plist = plistPath(home)
  const log = logPath(home)

  // Unload our own agent BEFORE asking whether the port is busy. Otherwise a
  // second install refuses because the first install is holding the port — the
  // port check cannot tell our process from a stranger's, so the only way to
  // make "busy" mean "somebody else" is to stop being the somebody first.
  const printed = await run('launchctl', ['print', serviceTarget(uid)]).catch(() => ({ code: 1 }))
  const wasLoaded = printed.code === 0
  if (wasLoaded) {
    await run('launchctl', ['bootout', serviceTarget(uid)]).catch(() => {})
    for (let attempt = 0; attempt < 20 && (await probePort(port)); attempt++) await sleep(150)
  }

  if (await probePort(port)) {
    return {
      ok: false,
      reason: `something is already listening on :${port}, and it is not this service. ` +
        'Stop it first — if it is a docket serve you started by hand, kill that, then install.',
    }
  }

  await mkdirAt(`${home}/.docket`)
  await mkdirAt(`${home}/Library/LaunchAgents`)
  await writeFileAt(plist, plistXml({ nodePath, scriptPath, log, port }))

  const boot = await run('launchctl', ['bootstrap', domainTarget(uid), plist])
  if (boot.code !== 0) {
    return { ok: false, reason: `launchctl bootstrap failed: ${boot.stderr.trim() || boot.code}` }
  }
  return { ok: true, plist, log, installed: await exists(plist) }
}

/** Removes the agent and its plist. Never touches a board, a registry, or the log's directory. */
export async function uninstall({ home, uid, effects }) {
  const { run, unlinkAt, exists } = effects
  const plist = plistPath(home)
  const had = await exists(plist)
  await run('launchctl', ['bootout', serviceTarget(uid)]).catch(() => {})
  if (had) await unlinkAt(plist)
  return { ok: true, had, plist, stillThere: await exists(plist) }
}

// ---- the drain timer ----------------------------------------------------
//
// A second agent, added additively rather than by generalising the one above —
// the serve agent was under verification when this was written, and churning a
// file somebody is judging is how a verdict stops meaning anything.
//
// Shaped differently on purpose. The serve agent is a long-running process kept
// alive; this one is a short command run on a timer. So: StartInterval instead of
// KeepAlive, and a status file instead of a port to probe, because "is it
// working" cannot be asked of a process that is supposed to be gone.

export const DRAIN_LABEL = 'com.docket.drain'
export const DRAIN_INTERVAL_SECONDS = 300

export const drainPlistPath = (home) => `${home}/Library/LaunchAgents/${DRAIN_LABEL}.plist`
export const drainLogPath = (home) => `${home}/.docket/drain.log`
export const drainStatusPath = (home) => `${home}/.docket/drain-status.json`
export const drainTarget = (uid) => `gui/${uid}/${DRAIN_LABEL}`

/**
 * The timer definition.
 *
 * PATH carries gh's directory because the drain reads its GitHub token via
 * `gh auth token`, which needs no shell but does need to be findable. That keeps
 * the credential where gh already manages it instead of copying it into a plist.
 * RunAtLoad so installing it drains immediately rather than after one interval.
 */
export function drainPlistXml({ nodePath, scriptPath, log, ghDir, intervalSeconds = DRAIN_INTERVAL_SECONDS }) {
  const args = [nodePath, scriptPath, 'drain']
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(DRAIN_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(`${ghDir}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${Number(intervalSeconds)}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`
}

/**
 * Which state the drain is in.
 *
 * `stale` is the state this whole card exists for. A broken serve daemon is
 * obvious the moment you open the board; a drain that stopped firing looks
 * exactly like nobody having sent anything. So a success that is too old counts
 * as a failure even when nothing errored — silence is not health.
 */
export function drainState({ plistExists, loaded, status, intervalSeconds = DRAIN_INTERVAL_SECONDS, now }) {
  if (!plistExists) return 'absent'
  if (!loaded) return 'unloaded'
  if (!status?.lastSuccessAt && !status?.lastFailureAt) return 'never-ran'

  const success = Date.parse(status.lastSuccessAt ?? '') || 0
  const failure = Date.parse(status.lastFailureAt ?? '') || 0
  if (failure > success) return 'failing'
  // Three missed intervals is a job that is not running, not a slow one.
  if (now - success > intervalSeconds * 3000) return 'stale'
  return 'healthy'
}

const AGO = (ms) => {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** One line for doctor. An unhappy state always names the reason or the log. */
export function describeDrainState(state, { status, log, now } = {}) {
  const head = 'drain    '
  if (state === 'absent') return `${head}not scheduled — run docket install-drain`
  if (state === 'unloaded') return `${head}plist present but not loaded — run docket install-drain again`
  if (state === 'never-ran') return `${head}scheduled but has never run — ${log}`
  if (state === 'failing') {
    const when = AGO(now - (Date.parse(status?.lastFailureAt ?? '') || now))
    return `${head}FAILING since ${when} — ${status?.lastError ?? 'no reason recorded'}`
  }
  if (state === 'stale') {
    const when = AGO(now - (Date.parse(status?.lastSuccessAt ?? '') || now))
    return `${head}STALE — last success ${when}, which is several intervals ago. ${log}`
  }
  return `${head}healthy — last drained ${AGO(now - (Date.parse(status?.lastSuccessAt ?? '') || now))}`
}

/** Installs the timer. No port to check: a timer job holds nothing. */
export async function installDrain({ home, uid, nodePath, scriptPath, ghDir, intervalSeconds, effects }) {
  const { writeFileAt, mkdirAt, run, exists } = effects
  const plist = drainPlistPath(home)
  const log = drainLogPath(home)

  await mkdirAt(`${home}/.docket`)
  await mkdirAt(`${home}/Library/LaunchAgents`)
  await writeFileAt(plist, drainPlistXml({ nodePath, scriptPath, log, ghDir, intervalSeconds }))

  // bootout first so a second install replaces rather than stacks. Failing here
  // is the normal first-install case.
  await run('launchctl', ['bootout', drainTarget(uid)]).catch(() => {})
  const boot = await run('launchctl', ['bootstrap', domainTarget(uid), plist])
  if (boot.code !== 0) {
    return { ok: false, reason: `launchctl bootstrap failed: ${boot.stderr.trim() || boot.code}` }
  }
  return { ok: true, plist, log, installed: await exists(plist) }
}

// ---- the push timer -------------------------------------------------------
// The missing half of the-board-at-a-URL: nothing pushed the Mac's board into
// git, so any URL served a frozen board. Same machinery as the drain — a
// launchd timer, a status file, a doctor line — pointed at git instead of
// GitHub's contents API. pushState IS drainState: the state machine over
// {plist, loaded, status} is identical, only the words differ.

export const PUSH_LABEL = 'com.docket.push'
export const PUSH_INTERVAL_SECONDS = 300
export const pushPlistPath = (home) => `${home}/Library/LaunchAgents/${PUSH_LABEL}.plist`
export const pushLogPath = (home) => `${home}/.docket/push.log`
export const pushStatusPath = (home) => `${home}/.docket/push-status.json`
export const pushTarget = (uid) => `gui/${uid}/${PUSH_LABEL}`

/**
 * The timer definition. WorkingDirectory pins WHICH repo pushes — the command
 * acts on the project containing its cwd, so the plist is the authorization
 * for exactly one repo. PATH is the system default: git and its osxkeychain
 * credential helper live in /usr/bin, and no other tool is needed.
 */
export function pushPlistXml({ nodePath, scriptPath, log, repoDir, intervalSeconds = PUSH_INTERVAL_SECONDS }) {
  const args = [nodePath, scriptPath, 'push']
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(PUSH_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key>
  <integer>${Number(intervalSeconds)}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`
}

/** One line for doctor. Absent stays silent there — the timer is opt-in. */
export function describePushState(state, { status, log, now } = {}) {
  const head = 'push     '
  if (state === 'absent') return `${head}not scheduled — run docket install-push`
  if (state === 'unloaded') return `${head}plist present but not loaded — run docket install-push again`
  if (state === 'never-ran') return `${head}scheduled but has never run — ${log}`
  if (state === 'failing') {
    const when = AGO(now - (Date.parse(status?.lastFailureAt ?? '') || now))
    return `${head}FAILING since ${when} — ${status?.lastError ?? 'no reason recorded'}`
  }
  if (state === 'stale') {
    const when = AGO(now - (Date.parse(status?.lastSuccessAt ?? '') || now))
    return `${head}STALE — last success ${when}, which is several intervals ago. ${log}`
  }
  return `${head}healthy — last pushed ${AGO(now - (Date.parse(status?.lastSuccessAt ?? '') || now))}`
}

export async function installPush({ home, uid, nodePath, scriptPath, repoDir, intervalSeconds, effects }) {
  const { writeFileAt, mkdirAt, run, exists } = effects
  const plist = pushPlistPath(home)
  const log = pushLogPath(home)
  await mkdirAt(`${home}/.docket`)
  await mkdirAt(`${home}/Library/LaunchAgents`)
  await writeFileAt(plist, pushPlistXml({ nodePath, scriptPath, log, repoDir, intervalSeconds }))
  await run('launchctl', ['bootout', pushTarget(uid)]).catch(() => {})
  const boot = await run('launchctl', ['bootstrap', domainTarget(uid), plist])
  if (boot.code !== 0) {
    return { ok: false, reason: `launchctl bootstrap failed: ${boot.stderr.trim() || boot.code}` }
  }
  return { ok: true, plist, log, installed: await exists(plist) }
}

/** Removes the push timer. Leaves the log, the status file, and the repo alone. */
export async function uninstallPush({ home, uid, effects }) {
  const { run, unlinkAt, exists } = effects
  const plist = pushPlistPath(home)
  const had = await exists(plist)
  await run('launchctl', ['bootout', pushTarget(uid)]).catch(() => {})
  if (had) await unlinkAt(plist)
  return { ok: true, had, plist, stillThere: await exists(plist) }
}

/** Removes the timer and its plist. Leaves the log, the status file, and every board. */
export async function uninstallDrain({ home, uid, effects }) {
  const { run, unlinkAt, exists } = effects
  const plist = drainPlistPath(home)
  const had = await exists(plist)
  await run('launchctl', ['bootout', drainTarget(uid)]).catch(() => {})
  if (had) await unlinkAt(plist)
  return { ok: true, had, plist, stillThere: await exists(plist) }
}

/**
 * Error text that is safe to write down.
 *
 * The drain records why it failed so `doctor` can say something useful, which
 * means an error message becomes a file on disk. CLAUDE.md's rule is absolute:
 * never log a secret, not in an error, not in a thrown string. This is the seam
 * where that could go wrong, so redaction happens here rather than at each call.
 */
export function redactSecrets(message) {
  return (
    String(message ?? '')
      // GitHub's own token shapes.
      .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]')
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted]')
      // A Telegram bot token: digits, colon, secret. No leading \b — the string
      // this appears in is usually `.../bot<id>:<secret>/method`, and t→8 is not
      // a word boundary, so \b silently declined to match the real case.
      .replace(/(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g, '[redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
      .replace(/\b[0-9a-f]{40}\b/gi, '[redacted]')
      // A bare JWT: three base64url segments, the first starting eyJ ('{"').
      // No key needed — the shape is the credential.
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
      // A PEM private-key block, body and all — INCLUDING a block a truncated
      // message never closes, which is why $ is an accepted terminator.
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
      // Basic credentials, no Authorization: prefix required. Case-insensitive
      // because RFC 7235 auth schemes are; the scheme keeps its case.
      .replace(/\b(basic)(\s+)[A-Za-z0-9+/=]{8,}/gi, '$1$2[redacted]')
      // An AWS access key id is recognisable bare by its prefix.
      .replace(/\bAKIA[A-Z0-9]{12,}/g, '[redacted]')
      // A JSON-quoted key: the delimiter rule below needs key-then-[:=], and in
      // JSON a quote sits between them. JSON is the wire format of every API on
      // this path, so this is the most predictable of the unpredicted shapes.
      // TWO rules, deliberately: folding unterminated tolerance into this one
      // silently weakened the terminated case (a value holding a raw newline
      // leaked its second half — a gate caught it side by side with main).
      .replace(
        // Terminated: a real JSON string, escapes included, newlines and all —
        // or an escaped quote would end the match early and publish the tail.
        /"(authorization|bearer|api[_-]?key|access[_-]?token|token|secret|password|passwd|session|cookie|auth|pat|credentials|key|sessionid)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
        '"$1": "[redacted]"',
      )
      .replace(
        // UNTERMINATED: truncation is normal on this path — safeError cuts at
        // 300 — so a value whose closing quote never arrived ends at a newline
        // or the end of the string, tolerating the lone backslash a cut
        // mid-escape leaves behind. Runs after the terminated rule, so it only
        // ever sees the leftovers.
        /"(authorization|bearer|api[_-]?key|access[_-]?token|token|secret|password|passwd|session|cookie|auth|pat|credentials|key|sessionid)"\s*:\s*"(?:[^"\\\n]|\\[^\n])*\\?(?=\n|$)/gi,
        '"$1": "[redacted]',
      )
      // A credential-ish key followed by a DELIMITER: redact the rest of the
      // line, not one \S+. `Authorization: Bearer <secret>` has two words after
      // the colon, so redacting a single token ate "Bearer" and published the
      // secret. `password`, `session` and `cookie` are keys too — a verifier
      // found all three published.
      .replace(
        /(authorization|bearer|api[_-]?key|access[_-]?token|token|secret|password|passwd|session|cookie|auth|pat|credentials|key|sessionid)(\s*[:=]\s*).*/gi,
        '$1$2[redacted]',
      )
      // The same keys followed only by SPACE. Here the VALUE is matched by shape
      // rather than the line being eaten from the keyword on, because
      // `token expired` and `invalid token format` are exactly the actionable
      // reasons `doctor` exists to show — redacting those would defeat the point
      // of recording a reason at all. Only a long credential-shaped run goes.
      .replace(
        /\b(authorization|bearer|api[_-]?key|access[_-]?token|token|secret|password|passwd|session|cookie|auth|pat|credentials|key|sessionid)(\s+)([A-Za-z0-9_\-.=+/]{16,})/gi,
        '$1$2[redacted]',
      )
      .replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/g, '$1[redacted]@')
  )
}

/** The rules plus the cut. For error strings; the log boundary uses the rules alone. */
export function safeError(message) {
  return redactSecrets(message).slice(0, 300)
}
