import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SERVICE_LABEL,
  describeDrainState,
  drainPlistPath,
  drainPlistXml,
  describePushState,
  pushPlistXml,
  drainState,
  installDrain,
  safeError,
  uninstallDrain,
  describeState,
  domainTarget,
  install,
  logPath,
  plistPath,
  plistXml,
  serviceState,
  serviceTarget,
  uninstall,
  redactSecrets,
} from '../src/service.js'

const HOME = '/Users/someone'
const UID = 501

/** Records every effect instead of performing one. No launchctl, no disk, no network. */
function fakeEffects({ portBusy = false, files = new Set(), bootstrapCode = 0, loaded = false } = {}) {
  let held = portBusy
  const calls = []
  return {
    calls,
    files,
    effects: {
      probePort: async () => {
        calls.push(['probePort'])
        return held
      },
      sleep: async () => calls.push(['sleep']),
      mkdirAt: async (dir) => calls.push(['mkdirAt', dir]),
      writeFileAt: async (path, body) => {
        calls.push(['writeFileAt', path, body])
        files.add(path)
      },
      unlinkAt: async (path) => {
        calls.push(['unlinkAt', path])
        files.delete(path)
      },
      exists: async (path) => files.has(path),
      run: async (cmd, args) => {
        calls.push([cmd, ...args])
        // 'print' exits non-zero when nothing is loaded — that is how loadedness
        // is discovered, and it is not an error.
        if (args[0] === 'print') return { code: loaded ? 0 : 1, stdout: '', stderr: '' }
        // Booting our own agent out frees the port it was holding.
        if (args[0] === 'bootout') held = false
        return { code: args[0] === 'bootstrap' ? bootstrapCode : 0, stdout: '', stderr: '' }
      },
    },
  }
}

test('the paths are the ones launchd and the owner expect', () => {
  assert.equal(plistPath(HOME), '/Users/someone/Library/LaunchAgents/com.docket.serve.plist')
  assert.equal(logPath(HOME), '/Users/someone/.docket/serve.log')
  assert.equal(serviceTarget(UID), 'gui/501/com.docket.serve')
  assert.equal(domainTarget(UID), 'gui/501')
})

test('the plist carries an ABSOLUTE node path, not a bare command', () => {
  // launchd has no PATH worth trusting. A bare "node" here is the failure mode.
  const xml = plistXml({
    nodePath: '/Users/someone/.nvm/versions/node/v22.23.2/bin/node',
    scriptPath: '/repo/board/bin/docket.js',
    log: logPath(HOME),
    port: 7777,
  })
  assert.match(xml, /<string>\/Users\/someone\/\.nvm\/versions\/node\/v22\.23\.2\/bin\/node<\/string>/)
  assert.doesNotMatch(xml, /<string>node<\/string>/)
})

test('the plist is well-formed enough to load', () => {
  const xml = plistXml({ nodePath: '/n', scriptPath: '/s', log: '/l', port: 7777 })
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(xml, /<!DOCTYPE plist PUBLIC/)
  assert.match(xml, /<plist version="1\.0">/)
  assert.equal((xml.match(/<dict>/g) ?? []).length, (xml.match(/<\/dict>/g) ?? []).length)
  assert.equal((xml.match(/<array>/g) ?? []).length, (xml.match(/<\/array>/g) ?? []).length)
  assert.match(xml, new RegExp(`<string>${SERVICE_LABEL}</string>`))
})

test('the whole serve command line is in the plist, port included', () => {
  const xml = plistXml({ nodePath: '/n', scriptPath: '/s/docket.js', log: '/l', port: 7788 })
  const args = [...xml.matchAll(/^\s{4}<string>(.*)<\/string>$/gm)].map((m) => m[1])
  assert.deepEqual(args, ['/n', '/s/docket.js', 'serve', '--port', '7788'])
})

test('a path with XML-hostile characters does not produce a broken plist', () => {
  // "Music & Film" is a legal directory name on macOS.
  const xml = plistXml({
    nodePath: '/Users/a b/Music & Film/node',
    scriptPath: '/x/<y>/docket.js',
    log: "/l/o'g",
    port: 7777,
  })
  assert.match(xml, /Music &amp; Film/)
  assert.match(xml, /&lt;y&gt;/)
  assert.match(xml, /o&apos;g/)
  // No raw & survives — that is what makes a plist unparseable.
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/)
})

test('a clean exit is not restarted in a loop', () => {
  // KeepAlive: true would respawn a deliberately stopped daemon forever.
  const xml = plistXml({ nodePath: '/n', scriptPath: '/s', log: '/l', port: 7777 })
  assert.match(xml, /<key>SuccessfulExit<\/key>\s*<false\/>/)
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/)
})

test('stdout and stderr both go to the log, so a crash stack is not lost', () => {
  const xml = plistXml({ nodePath: '/n', scriptPath: '/s', log: '/home/.docket/serve.log', port: 1 })
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/home\/\.docket\/serve\.log<\/string>/)
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/home\/\.docket\/serve\.log<\/string>/)
})

test('loaded and answering are different questions', () => {
  // The whole point. An nvm upgrade moves node; launchd tries, the process exits,
  // launchd gives up, and the board is dead with nothing saying so.
  assert.equal(serviceState({ plistExists: false, loaded: false, answering: false }), 'absent')
  assert.equal(serviceState({ plistExists: true, loaded: false, answering: false }), 'unloaded')
  assert.equal(serviceState({ plistExists: true, loaded: true, answering: false }), 'broken')
  assert.equal(serviceState({ plistExists: true, loaded: true, answering: true }), 'healthy')
})

test('a loaded-but-dead service never reads as fine', () => {
  const line = describeState('broken', { port: 7777, log: '/h/.docket/serve.log' })
  assert.match(line, /NOT answering/)
  assert.match(line, /serve\.log/) // names the next place to look
  assert.doesNotMatch(describeState('healthy', { port: 7777 }), /NOT/)
  assert.match(describeState('absent'), /not installed/)
})

test('install refuses when the port is held, and writes nothing', async () => {
  const { calls, effects } = fakeEffects({ portBusy: true })
  const result = await install({
    home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', port: 7777, effects,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /already listening on :7777/)
  // What matters is not the call sequence but that nothing was left behind:
  // no plist on disk and no job loaded. A refusal that half-installs is worse
  // than one that fails outright.
  assert.ok(!calls.some((c) => c[0] === 'writeFileAt'), 'nothing written')
  assert.ok(!calls.some((c) => c[1] === 'bootstrap'), 'no job loaded')
  assert.ok(!calls.some((c) => c[0] === 'mkdirAt'), 'no directories created')
})

test('install writes the plist before loading it', async () => {
  // Ordering matters: bootstrap on a path that does not exist yet fails, and it
  // fails in a way that leaves launchd remembering a broken label.
  const { calls, effects } = fakeEffects()
  const result = await install({
    home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', port: 7777, effects,
  })
  assert.equal(result.ok, true)
  const wrote = calls.findIndex((c) => c[0] === 'writeFileAt')
  const bootstrapped = calls.findIndex((c) => c[1] === 'bootstrap')
  assert.ok(wrote !== -1 && bootstrapped !== -1)
  assert.ok(wrote < bootstrapped, 'the plist must exist before launchctl is asked to load it')
  assert.deepEqual(calls[bootstrapped], ['launchctl', 'bootstrap', 'gui/501', plistPath(HOME)])
})

test('installing twice leaves one job, not two, and still exits ok', async () => {
  // The trap: after the first install OUR OWN agent holds the port, so a naive
  // port check makes the second install refuse. It must unload itself first.
  const shared = fakeEffects({ loaded: true, portBusy: true })
  const args = { home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', port: 7777, effects: shared.effects }
  const second = await install(args)
  assert.equal(second.ok, true, second.reason)
  const verbs = shared.calls.filter((c) => c[0] === 'launchctl').map((c) => c[1])
  assert.deepEqual(verbs, ['print', 'bootout', 'bootstrap'])
})

test('a port held by something that is NOT this service still refuses', async () => {
  // Nothing loaded, yet the port is taken — that is somebody else's process, and
  // killing it is not this command's business.
  const shared = fakeEffects({ loaded: false, portBusy: true })
  const result = await install({
    home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', port: 7777, effects: shared.effects,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not this service/)
  assert.ok(!shared.calls.some((c) => c[1] === 'bootstrap'), 'no dead job left behind')
  assert.ok(!shared.calls.some((c) => c[0] === 'writeFileAt'), 'nothing written')
})

test('a failed bootstrap is reported, not swallowed', async () => {
  const { effects } = fakeEffects({ bootstrapCode: 5 })
  const result = await install({
    home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', port: 7777, effects,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /bootstrap failed/)
})

test('uninstall unloads the job and deletes the plist', async () => {
  const shared = fakeEffects()
  const args = { home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', port: 7777, effects: shared.effects }
  await install(args)
  const result = await uninstall({ home: HOME, uid: UID, effects: shared.effects })
  assert.equal(result.ok, true)
  assert.equal(result.had, true)
  assert.equal(result.stillThere, false)
  assert.ok(shared.calls.some((c) => c[1] === 'bootout'))
})

test('uninstall on a machine with no service is not an error', async () => {
  const { effects } = fakeEffects()
  const result = await uninstall({ home: HOME, uid: UID, effects })
  assert.equal(result.ok, true)
  assert.equal(result.had, false)
})

test('uninstall touches a service and nothing else', async () => {
  // The promise docket forget already makes: removing a mechanism never removes data.
  const shared = fakeEffects()
  await install({ home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', port: 7777, effects: shared.effects })
  shared.calls.length = 0
  await uninstall({ home: HOME, uid: UID, effects: shared.effects })
  const touched = shared.calls.filter((c) => c[0] === 'unlinkAt').map((c) => c[1])
  assert.deepEqual(touched, [plistPath(HOME)])
  assert.ok(!shared.calls.some((c) => String(c[1] ?? '').includes('board.json')))
  assert.ok(!shared.calls.some((c) => String(c[1] ?? '').includes('projects.json')))
  assert.ok(!shared.calls.some((c) => String(c[1] ?? '').includes('serve.log')))
})

// ---- the drain timer ----------------------------------------------------
//
// These exist because a verifier failed the drain card for their absence: six new
// functions shipped with one covered. The two it named as mattering most are the
// three-interval stale threshold, which clauses 4 and 5 rest on and which an edit
// could silently turn back into "healthy", and safeError, which shipped broken
// twice and was fixed by hand-testing with nothing pinning either fix.

const MIN = 60_000
const T0 = Date.parse('2026-08-22T12:00:00Z')
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString()

test('drainState covers every state, in the order the checks must happen', () => {
  const base = { intervalSeconds: 300, now: T0 }
  assert.equal(drainState({ ...base, plistExists: false, loaded: false, status: null }), 'absent')
  assert.equal(drainState({ ...base, plistExists: true, loaded: false, status: null }), 'unloaded')
  assert.equal(drainState({ ...base, plistExists: true, loaded: true, status: null }), 'never-ran')
  assert.equal(
    drainState({ ...base, plistExists: true, loaded: true, status: { lastSuccessAt: iso(-MIN) } }),
    'healthy',
  )
  // absent wins over everything: a missing plist is not a stale drain.
  assert.equal(
    drainState({ ...base, plistExists: false, loaded: true, status: { lastSuccessAt: iso(-MIN) } }),
    'absent',
  )
})

test('a newer failure beats an older success', () => {
  const state = drainState({
    plistExists: true,
    loaded: true,
    intervalSeconds: 300,
    now: T0,
    status: { lastSuccessAt: iso(-10 * MIN), lastFailureAt: iso(-MIN), lastError: 'boom' },
  })
  assert.equal(state, 'failing')
})

test('an older failure does not mask a newer success', () => {
  const state = drainState({
    plistExists: true,
    loaded: true,
    intervalSeconds: 300,
    now: T0,
    status: { lastSuccessAt: iso(-MIN), lastFailureAt: iso(-10 * MIN), lastError: 'boom' },
  })
  assert.equal(state, 'healthy')
})

test('the stale threshold is exactly three intervals, and silence is not health', () => {
  // The clause this pins: a success with NO error recorded, just too old. Without
  // it a drain that quietly stopped firing looks identical to nobody having sent
  // anything. An edit that widened this would pass every other test here.
  const at = (ageMs) =>
    drainState({
      plistExists: true,
      loaded: true,
      intervalSeconds: 300,
      now: T0,
      status: { lastSuccessAt: iso(-ageMs), lastError: null },
    })
  assert.equal(at(299 * 1000), 'healthy')
  assert.equal(at(900 * 1000 - 1000), 'healthy', 'just under three intervals is still healthy')
  assert.equal(at(900 * 1000 + 1000), 'stale', 'just over three intervals is stale')
  assert.equal(at(40 * MIN), 'stale')
  // And it scales with the interval rather than being a hardcoded 900s.
  assert.equal(
    drainState({
      plistExists: true, loaded: true, intervalSeconds: 60, now: T0,
      status: { lastSuccessAt: iso(-5 * MIN) },
    }),
    'stale',
  )
})

test('an unhappy drain line always says the reason or where to look', () => {
  const log = '/h/.docket/drain.log'
  const failing = describeDrainState('failing', {
    status: { lastFailureAt: iso(-MIN), lastError: 'github GET buckets.json → 401' },
    log,
    now: T0,
  })
  assert.match(failing, /FAILING/)
  assert.match(failing, /401/, 'the reason has to travel with the state')

  const stale = describeDrainState('stale', { status: { lastSuccessAt: iso(-40 * MIN) }, log, now: T0 })
  assert.match(stale, /STALE/)
  assert.match(stale, /drain\.log/)

  assert.match(describeDrainState('absent', { log, now: T0 }), /not scheduled/)
  assert.match(describeDrainState('never-ran', { log, now: T0 }), /drain\.log/)
  // Healthy is the only one that shouts nothing.
  const healthy = describeDrainState('healthy', { status: { lastSuccessAt: iso(-MIN) }, log, now: T0 })
  assert.doesNotMatch(healthy, /FAILING|STALE/)
})

test('a failing state with no recorded reason still says so rather than lying', () => {
  const line = describeDrainState('failing', { status: {}, log: '/l', now: T0 })
  assert.match(line, /FAILING/)
  assert.match(line, /no reason recorded/)
})

test('the drain plist is a timer, not a kept-alive process', () => {
  const xml = drainPlistXml({
    nodePath: '/n/node',
    scriptPath: '/s/docket.js',
    log: '/h/.docket/drain.log',
    ghDir: '/opt/homebrew/bin',
    intervalSeconds: 300,
  })
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.doesNotMatch(xml, /KeepAlive/, 'a timer job must not be respawned on exit')
  // Scoped to the <array>: the PATH value sits at the same indentation inside
  // EnvironmentVariables, so matching on indentation alone scoops it up too.
  const array = xml.match(/<array>([\s\S]*?)<\/array>/)[1]
  const args = [...array.matchAll(/<string>(.*)<\/string>/g)].map((m) => m[1])
  assert.deepEqual(args, ['/n/node', '/s/docket.js', 'drain'])
})

test("the plist's PATH carries gh, because that is where the credential stays", () => {
  // The alternative was copying a token into the plist. This is the line that
  // makes that unnecessary, so a regression here is a security regression.
  const xml = drainPlistXml({
    nodePath: '/n', scriptPath: '/s', log: '/l', ghDir: '/Users/x/homebrew/bin', intervalSeconds: 60,
  })
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/Users\/x\/homebrew\/bin:/)
  assert.doesNotMatch(xml, /gh[pousr]_|github_pat_/, 'no credential belongs in a plist')
})

test('installDrain writes the plist before loading it, and replaces rather than stacks', async () => {
  const shared = fakeEffects()
  const args = {
    home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', ghDir: '/g', intervalSeconds: 300,
    effects: shared.effects,
  }
  const first = await installDrain(args)
  assert.equal(first.ok, true)
  const wrote = shared.calls.findIndex((c) => c[0] === 'writeFileAt')
  const bootstrapped = shared.calls.findIndex((c) => c[1] === 'bootstrap')
  assert.ok(wrote !== -1 && wrote < bootstrapped)

  shared.calls.length = 0
  await installDrain(args)
  const verbs = shared.calls.filter((c) => c[0] === 'launchctl').map((c) => c[1])
  assert.deepEqual(verbs, ['bootout', 'bootstrap'], 'a second install replaces the first')
})

test('installDrain does not probe a port — a timer holds nothing', async () => {
  const shared = fakeEffects({ portBusy: true })
  const result = await installDrain({
    home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', ghDir: '/g', intervalSeconds: 300,
    effects: shared.effects,
  })
  assert.equal(result.ok, true, 'a busy port is irrelevant to a timer')
  assert.ok(!shared.calls.some((c) => c[0] === 'probePort'))
})

test('uninstallDrain removes the timer and its plist, and nothing else', async () => {
  const shared = fakeEffects()
  await installDrain({
    home: HOME, uid: UID, nodePath: '/n', scriptPath: '/s', ghDir: '/g', intervalSeconds: 300,
    effects: shared.effects,
  })
  shared.calls.length = 0
  const result = await uninstallDrain({ home: HOME, uid: UID, effects: shared.effects })
  assert.equal(result.ok, true)
  assert.equal(result.had, true)
  assert.equal(result.stillThere, false)
  const unlinked = shared.calls.filter((c) => c[0] === 'unlinkAt').map((c) => c[1])
  assert.deepEqual(unlinked, [drainPlistPath(HOME)])
  // The status file and the log are records, not mechanism.
  for (const kept of ['drain-status.json', 'drain.log', 'board.json', 'projects.json']) {
    assert.ok(!shared.calls.some((c) => String(c[1] ?? '').includes(kept)), kept)
  }
})

test('uninstallDrain on a machine with no timer is not an error', async () => {
  const { effects } = fakeEffects()
  const result = await uninstallDrain({ home: HOME, uid: UID, effects })
  assert.equal(result.ok, true)
  assert.equal(result.had, false)
})

// ---- safeError ----------------------------------------------------------

const SECRET = 'AbCdEf0123456789AbCdEf0123456789AbCd'

test('safeError redacts every shape it claims to', () => {
  const shapes = [
    `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 is invalid`,
    `github_pat_11ABCDE0000abcdefghij_ZZZZZZZZZZZZZZZZZZZZZZZZ rejected`,
    `POST https://api.telegram.org/bot1234567890:AAE${SECRET}/sendMessage 401`,
    `Authorization: Bearer sk-${SECRET}`,
    `fetch https://me:${SECRET}@host/x failed`,
    `object 0123456789abcdef0123456789abcdef01234567 not found`,
  ]
  for (const shape of shapes) {
    const out = safeError(shape)
    assert.doesNotMatch(out, /AbCdEf0123456789|ghp_[A-Z]|github_pat_1|0123456789abcdef/, shape)
    assert.match(out, /\[redacted\]/, shape)
  }
})

test('safeError catches a key separated from its value by a SPACE', () => {
  // A verifier found this hole: the regex demanded : or =, so this passed whole.
  for (const key of ['token', 'password', 'secret', 'api-key', 'access_token', 'session', 'cookie']) {
    const out = safeError(`authentication failed with ${key} ${SECRET}`)
    assert.doesNotMatch(out, new RegExp(SECRET), key)
  }
})

test('safeError still leaves an actionable reason behind', () => {
  // Over-redaction is its own failure: doctor exists to show WHY the drain broke,
  // and "[redacted]" is not a reason. These are the real messages on this path.
  for (const message of [
    'token expired',
    'invalid token format',
    'github GET buckets.json → 401',
    'Command failed: gh auth token',
    'ENOTFOUND api.github.com',
  ]) {
    assert.equal(safeError(message), message, message)
  }
})

test('a credential straddling the 300-character cut never leaks a fragment', () => {
  // The test this replaces padded with 400 x's, so the cut hid the secret
  // whether or not any redaction rule ran — strip every rule and it stayed
  // green. This one places the credential so it STRADDLES the cut at several
  // offsets: if redaction does not happen first, the slice keeps the head of
  // the secret and the assertion sees it.
  for (const pad of [250, 260, 270, 280, 292]) {
    const long = `${'x'.repeat(pad)} token ${SECRET}`
    const out = safeError(long)
    assert.ok(
      !out.includes(SECRET.slice(0, 8)),
      `a fragment of the secret survived the cut at pad ${pad}`,
    )
    assert.ok(out.length <= 300)
  }
})

test('safeError handles nothing at all', () => {
  for (const empty of [undefined, null, '', 0]) assert.equal(typeof safeError(empty), 'string')
})

// ---------------------------------------------------------------------------
// redactSecrets — the rules without the 300-character cut, so it can sit at
// the log boundary without truncating legitimate long lines.

test('redactSecrets redacts past the 300-character mark without cutting the line', () => {
  const secret = 'AbCdEf0123456789AbCdEf0123456789'
  const long = `${'x'.repeat(320)} token=${secret}`
  const out = redactSecrets(long)
  assert.ok(!out.includes(secret), 'a secret after the 300th character must still be redacted')
  assert.ok(out.length > 300, 'redaction must not truncate — the cut belongs to safeError alone')
})

test('redactSecrets keeps the actionable reasons byte-for-byte', () => {
  for (const reason of [
    'token expired',
    'invalid token format',
    'github GET buckets.json → 401',
    'Command failed: gh auth token',
    'ENOTFOUND api.github.com',
  ]) {
    assert.equal(redactSecrets(reason), reason)
  }
})

test('safeError is redactSecrets plus the 300-character cut', () => {
  const long = 'y'.repeat(400)
  assert.equal(safeError(long), redactSecrets(long).slice(0, 300))
  assert.equal(safeError(long).length, 300)
})

// ---------------------------------------------------------------------------
// The hardening rules (card-mt41mva4-tir6): shapes an UNPREDICTED message is
// most likely to carry. Every rule here is shape- or keyword-anchored — no
// entropy heuristics, per the card's If-blocked line. One test per rule, so
// removing a rule alone kills its test and nothing else.

test('a JSON-quoted credential key is redacted', () => {
  const out = redactSecrets(`request body was {"token":"${SECRET}","kind":"pat"}`)
  assert.ok(!out.includes(SECRET), 'JSON is the wire format of every API this project talks to')
  assert.match(out, /\[redacted\]/)
})

test('the newer key names are recognised with delimiters and spaces', () => {
  for (const key of ['auth', 'pat', 'credentials', 'key', 'sessionid']) {
    for (const shape of [`${key}=${SECRET}`, `${key}: ${SECRET}`, `${key} ${SECRET}`]) {
      const out = redactSecrets(`refresh failed: ${shape}`)
      assert.ok(!out.includes(SECRET), `${JSON.stringify(shape)} must be redacted`)
    }
  }
})

test('a bare JWT is redacted with no key anywhere near it', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const out = redactSecrets(`unexpected response: ${jwt}`)
  assert.ok(!out.includes('eyJzdWIi'), 'the payload segment must not survive')
  assert.match(out, /\[redacted\]/)
})

test('a PEM private-key block is redacted body and all, even truncated', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${SECRET}\nAbCd\n-----END RSA PRIVATE KEY-----`
  const whole = redactSecrets(`wrote: ${pem}`)
  assert.ok(!whole.includes(SECRET), 'the body must go, not only the header line')
  const truncated = redactSecrets(`wrote: -----BEGIN PRIVATE KEY-----\nMIIEow${SECRET}`)
  assert.ok(!truncated.includes(SECRET), 'a message cut mid-block must still lose the body')
})

test('Basic credentials are redacted without an Authorization prefix', () => {
  const out = redactSecrets('rejected: Basic YWxhZGRpbjpvcGVuc2VzYW1l')
  assert.ok(!out.includes('YWxhZGRpbjpv'))
  assert.match(out, /Basic \[redacted\]/)
})

test('an AWS access key id is redacted bare, and a secret behind a key', () => {
  const bare = redactSecrets('caller was AKIAIOSFODNN7EXAMPLE apparently')
  assert.ok(!bare.includes('AKIAIOSFODNN7EXAMPLE'))
  const secret40 = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY42'
  const behind = redactSecrets(`key ${secret40}`)
  assert.ok(!behind.includes(secret40))
})

test('the six actionable reasons still pass byte-for-byte — the balance clause', () => {
  for (const reason of [
    'token expired',
    'invalid token format',
    'github GET buckets.json → 401',
    'Command failed: gh auth token',
    'Command failed: gh auth token\nno oauth token found for github.com\n',
    'ENOTFOUND api.github.com',
  ]) {
    assert.equal(redactSecrets(reason), reason)
    assert.equal(safeError(reason), reason)
  }
})

// ---------------------------------------------------------------------------
// The leftovers card (card-mt659mf6-405h): pins and shapes the harden gate
// recorded after its verdict.

test('a bare sk- token with no key anywhere near it is redacted — the rule, pinned', () => {
  // The 2026-08-23 gate found this rule could be deleted with the suite green:
  // its only fixture rode behind the delimiter rule. This test exists so
  // removing the sk- rule alone fails something.
  const out = redactSecrets(`response body was sk-${SECRET} apparently`)
  assert.ok(!out.includes(`sk-${SECRET}`))
  assert.match(out, /\[redacted\]/)
})

test('basic credentials are redacted regardless of scheme case — RFC 7235 says schemes are', () => {
  const lower = redactSecrets('rejected: basic YWxhZGRpbjpvcGVuc2VzYW1l')
  assert.ok(!lower.includes('YWxhZGRpbjpv'))
  assert.match(lower, /basic \[redacted\]/, 'the scheme keeps its case; only the value goes')
})

test('a JSON value with an escaped quote loses its whole value, not just the head', () => {
  const out = redactSecrets(`{"token":"ab\\"${SECRET}"}`)
  assert.ok(!out.includes(SECRET), 'the tail after the escaped quote must not survive')
})

test('lowercase akia is NOT matched — decided, not defaulted', () => {
  // AWS access key ids are uppercase by spec: a lowercase 'akia…' cannot be a
  // real key id, so matching it would be pure false-positive surface against
  // ordinary words. The uppercase rule stands; this pins the boundary of it.
  // The fixture carries 17 word characters after 'akia' — past the rule's
  // {12,} floor — so making the rule case-insensitive genuinely fails here.
  // (The first fixture had seven, never reached the case check, and a gate
  // caught the comment claiming a pin that did not exist.)
  const benign = 'akiaikimasu12345678901 is not a credential'
  assert.equal(redactSecrets(benign), benign)
})

test('a JSON credential cut before its closing quote is still redacted', () => {
  // Truncation is normal on this path — safeError cuts at 300 — so an
  // unterminated value is just what a long JSON error looks like after
  // something upstream cut it. The value ends at the closing quote, a
  // newline, or the end of the string, whichever comes first: a JSON string
  // cannot legally contain a raw newline, so stopping there is principled.
  const cut = redactSecrets(`upstream said {"token":"${SECRET}`)
  assert.ok(!cut.includes(SECRET), 'the unterminated value must not survive')
  const beforeNewline = redactSecrets(`{"secret":"${SECRET}\nnext line stays`)
  assert.ok(!beforeNewline.includes(SECRET))
  assert.match(beforeNewline, /next line stays/, 'the redaction stops at the newline')
})

test('a terminated JSON value containing a raw newline is redacted whole — both halves', () => {
  // The first attempt at unterminated tolerance excluded \n from the value
  // class, which silently weakened THIS case: the match stopped at the
  // newline and the second half leaked, where main redacted it whole. The
  // gate caught it side by side. Terminated and unterminated are two rules
  // now, so tolerance for one cannot redefine the other.
  for (const sep of ['\n', '\r\n']) {
    const out = redactSecrets(`{"access_token":"${SECRET}${sep}${SECRET}"}`)
    assert.ok(!out.includes(SECRET), `a value split by ${JSON.stringify(sep)} must go whole`)
  }
})

test('a truncation landing on a lone backslash still redacts the value', () => {
  // Escape-heavy values make a trailing bare backslash a normal draw, not a
  // contrived one: nested JSON-in-JSON ends every inner quote with one.
  const out = redactSecrets(`upstream: {"credentials":"{\\"user\\":\\"root\\",\\"pass\\":\\"${SECRET}\\`)
  assert.ok(!out.includes(SECRET), 'the cut mid-escape must not leak the value')
})

// ---------------------------------------------------------------------------
// The push timer — the board reaching git on its own. Same state machine as
// the drain (pushState IS drainState); what is new is the plist shape and the
// doctor line.

test('the push plist is a timer that runs docket push inside the repo', () => {
  const xml = pushPlistXml({
    nodePath: '/n/node',
    scriptPath: '/s/docket.js',
    log: '/h/.docket/push.log',
    repoDir: '/repo/docket',
    intervalSeconds: 300,
  })
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.doesNotMatch(xml, /KeepAlive/)
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/repo\/docket<\/string>/)
  const array = xml.match(/<array>([\s\S]*?)<\/array>/)[1]
  const args = [...array.matchAll(/<string>(.*)<\/string>/g)].map((m) => m[1])
  assert.deepEqual(args, ['/n/node', '/s/docket.js', 'push'])
})

test('describePushState names the state, the reason, and the fix', () => {
  const now = Date.parse('2026-09-03T12:00:00Z')
  assert.match(describePushState('absent', { now }), /install-push/)
  assert.match(describePushState('unloaded', { now }), /install-push/)
  assert.match(
    describePushState('failing', { status: { lastFailureAt: '2026-09-03T11:58:00Z', lastError: 'rebase conflict' }, now }),
    /FAILING.*rebase conflict/,
  )
  assert.match(
    describePushState('healthy', { status: { lastSuccessAt: '2026-09-03T11:59:30Z' }, now }),
    /healthy/,
  )
})
