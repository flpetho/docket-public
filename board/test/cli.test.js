import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { drainStatus, pushStatus, runCli } from '../bin/docket.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/migration-board-rev233.json', import.meta.url))
const at = () => new Date('2026-08-21T12:00:00.000Z')

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'docket-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'my-project-'))
  const lines = []
  return {
    cwd,
    registryFile: join(home, 'projects.json'),
    lines,
    now: at,
    log: (line) => lines.push(String(line)),
    output: () => lines.join('\n'),
  }
}

test('init creates both files and registers the project', async () => {
  const s = await sandbox()
  const code = await runCli(['init'], s)
  assert.equal(code, 0)

  const board = JSON.parse(await readFile(join(s.cwd, '.docket', 'board.json'), 'utf8'))
  assert.equal(board.rev, 0)
  assert.deepEqual(board.cards, [])

  const config = JSON.parse(await readFile(join(s.cwd, '.docket', 'config.json'), 'utf8'))
  assert.equal(config.columns.length, 7)
  assert.equal(config.accent, '#ff5227')

  const registry = JSON.parse(await readFile(s.registryFile, 'utf8'))
  assert.equal(registry.projects.length, 1)
})

test('init --name sets the display name', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Atlas'], s)
  const config = JSON.parse(await readFile(join(s.cwd, '.docket', 'config.json'), 'utf8'))
  assert.equal(config.name, 'Atlas')
})

test('init never overwrites an existing board', async () => {
  const s = await sandbox()
  await runCli(['init'], s)
  await writeFile(
    join(s.cwd, '.docket', 'board.json'),
    `${JSON.stringify({ rev: 9, updatedAt: 'x', cards: [] }, null, 2)}\n`,
  )
  const code = await runCli(['init'], s)
  assert.equal(code, 0)
  const board = JSON.parse(await readFile(join(s.cwd, '.docket', 'board.json'), 'utf8'))
  assert.equal(board.rev, 9, 'an existing board must survive a second init')
  assert.match(s.output(), /already/i)
})

test('init --from-tracker migrates the real board', async () => {
  const s = await sandbox()
  const code = await runCli(['init', '--name', 'Atlas', '--from-tracker', FIXTURE], s)
  assert.equal(code, 0)

  const board = JSON.parse(await readFile(join(s.cwd, '.docket', 'board.json'), 'utf8'))
  assert.equal(board.rev, 233)
  assert.equal(board.cards.length, 53)
  assert.equal(board.cards.filter((c) => c.notes.length).length, 15)
  assert.equal(
    board.cards.reduce((sum, c) => sum + c.notes.reduce((s, n) => s + n.text.length, 0), 0),
    5811,
  )
  assert.match(s.output(), /53/)
})

test('init --from-tracker with a missing file fails loudly', async () => {
  const s = await sandbox()
  const code = await runCli(['init', '--from-tracker', '/nope/missing.json'], s)
  assert.equal(code, 1)
  assert.match(s.output(), /missing.json/)
})

test('doctor reports each registered project and its card count', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Atlas', '--from-tracker', FIXTURE], s)
  s.lines.length = 0
  const code = await runCli(['doctor'], s)
  assert.equal(code, 0)
  assert.match(s.output(), /Atlas/)
  assert.match(s.output(), /53 cards/)
})

test('doctor flags a registered project whose board has gone', async () => {
  const s = await sandbox()
  await runCli(['init'], s)
  const registry = JSON.parse(await readFile(s.registryFile, 'utf8'))
  registry.projects[0].path = '/gone/for/good'
  await writeFile(s.registryFile, `${JSON.stringify(registry, null, 2)}\n`)
  s.lines.length = 0
  await runCli(['doctor'], s)
  assert.match(s.output(), /missing/i)
})

test('an unknown command exits 1 with usage', async () => {
  const s = await sandbox()
  const code = await runCli(['wat'], s)
  assert.equal(code, 1)
  assert.match(s.output(), /usage/i)
})

test('forget unregisters a project without touching its board', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Temporary'], s)
  s.lines.length = 0

  const code = await runCli(['forget', 'temporary'], s)
  assert.equal(code, 0)
  assert.match(s.output(), /untouched/)
  assert.deepEqual(JSON.parse(await readFile(s.registryFile, 'utf8')).projects, [])
  // the board survives — forgetting is not deleting
  assert.ok(JSON.parse(await readFile(join(s.cwd, '.docket', 'board.json'), 'utf8')))
})

test('forget on an unknown slug lists what is known', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Kept'], s)
  s.lines.length = 0
  assert.equal(await runCli(['forget', 'nope'], s), 1)
  assert.match(s.output(), /kept/)
})

test('doctor reports a card whose column is absent from its config', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Orphanage'], s)
  // Written directly: writeBoard would refuse this card, which is exactly why
  // doctor has to notice it — the UI cannot show it and the store cannot save
  // around it.
  await writeFile(
    join(s.cwd, '.docket', 'board.json'),
    `${JSON.stringify(
      {
        rev: 1,
        updatedAt: 'x',
        cards: [
          {
            id: 'card-lost-1',
            title: 'stranded',
            detail: '',
            tags: [],
            column: 'overnight',
            flag: false,
            notes: [],
            origin: '',
            createdBy: 'owner',
            createdAt: 'x',
            updatedAt: 'x',
            columnSince: 'x',
            attachments: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  s.lines.length = 0
  await runCli(['doctor'], s)
  assert.match(s.output(), /card-lost-1/)
  assert.match(s.output(), /overnight/)
  assert.match(s.output(), /not in config|absent|orphan/i)
})

test('doctor says nothing about orphans when every card has its column', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Healthy', '--from-tracker', FIXTURE], s)
  s.lines.length = 0
  await runCli(['doctor'], s)
  assert.doesNotMatch(s.output(), /not in config|orphan/i)
})

test('doctor never prints a credential when the bucket read fails, and truncates the reason', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Leaky'], s)
  s.lines.length = 0
  const token = `ghp_${'A1b2C3d4'.repeat(4)}`
  const error = new Error(`token ${token} ${'e'.repeat(400)}`)
  const inboxClient = async () => ({
    readBuckets: async () => {
      throw error
    },
  })
  const code = await runCli(['doctor'], { ...s, inboxClient })
  assert.equal(code, 0)
  const line = s.lines.find((l) => l.includes('could not read buckets'))
  assert.ok(line, 'the failure must still print a reason')
  assert.ok(!line.includes(token), 'the credential must not reach the screen')
  assert.match(line, /\[redacted\]/)
  // The reason passed through safeError, not just the boundary: safeError cuts
  // at 300 characters, so a longer reason means the site reverted to raw.
  const reason = line.slice(line.indexOf('could not read buckets: ') + 'could not read buckets: '.length)
  assert.ok(reason.length <= 300, `the reason must be truncated by safeError, got ${reason.length}`)
})

test('a corrupt registry exits 1 through the catch instead of rejecting', async () => {
  const s = await sandbox()
  await writeFile(s.registryFile, 'not json at all')
  const code = await runCli(['doctor'], s)
  assert.equal(code, 1)
  assert.match(s.output(), /unexpected failure/)
})

test('an unexpected throw carrying a credential is caught and redacted', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Thrower'], s)
  s.lines.length = 0
  const token = `ghp_${'Zz9Yy8Xx'.repeat(5)}`
  // No command guards its clock, so a throwing one is a genuinely unexpected
  // failure — the class the top-level catch exists for.
  const code = await runCli(['init'], {
    ...s,
    now: () => {
      throw new Error(`refresh failed for token ${token}`)
    },
  })
  assert.equal(code, 1)
  assert.match(s.output(), /unexpected failure/)
  assert.ok(!s.output().includes(token), 'the credential must not surface through the catch')
  assert.match(s.output(), /\[redacted\]/)
})

test('a failing drain records a reason that is redacted and cut, never a credential', async () => {
  const s = await sandbox()
  const home = await mkdtemp(join(tmpdir(), 'docket-drain-status-'))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const token = `ghp_${'Qq7Ww6Ee'.repeat(4)}`
    const inboxClient = async () => {
      throw new Error(`token ${token} ${'e'.repeat(400)}`)
    }
    const code = await runCli(['drain'], { ...s, inboxClient })
    assert.equal(code, 1)
    const status = JSON.parse(await readFile(join(home, '.docket', 'drain-status.json'), 'utf8'))
    assert.ok(!status.lastError.includes(token), 'the file must never hold a credential')
    assert.match(status.lastError, /\[redacted\]/)
    // The cut is the call site's job (safeError); the write only redacts. A
    // recorded reason longer than 300 means the call site reverted to raw —
    // the exact mutation a gate found surviving every test on 2026-08-23.
    assert.ok(status.lastError.length <= 300, `expected a cut reason, got ${status.lastError.length}`)
    assert.ok(status.lastFailureAt, 'the failure must still be timestamped')
  } finally {
    process.env.HOME = realHome
  }
})

test('a failing drain records the actionable reason byte-for-byte', async () => {
  const s = await sandbox()
  const home = await mkdtemp(join(tmpdir(), 'docket-drain-status-'))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const inboxClient = async () => {
      throw new Error('token expired')
    }
    await runCli(['drain'], { ...s, inboxClient })
    const status = JSON.parse(await readFile(join(home, '.docket', 'drain-status.json'), 'utf8'))
    assert.equal(status.lastError, 'token expired', 'doctor reads this back — over-redaction defeats it')
  } finally {
    process.env.HOME = realHome
  }
})

test('drainStatus.write redacts whatever it is handed — the choke point, not the callers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'docket-status-write-'))
  const token = `ghp_${'Rr5Tt4Yy'.repeat(4)}`
  // A raw, unredacted message — what a call site that forgot safeError passes.
  await drainStatus.write(home, { lastError: `token ${token}`, lastFailureAt: 'x' })
  const status = JSON.parse(await readFile(join(home, '.docket', 'drain-status.json'), 'utf8'))
  assert.ok(!status.lastError.includes(token), 'the write itself must redact')
  assert.match(status.lastError, /\[redacted\]/)
  assert.equal(status.lastFailureAt, 'x', 'non-secret fields pass through untouched')
})

test('doctor counts attachment files referenced by nothing, and is silent when all are', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Atts'], s)
  const dir = join(s.cwd, '.docket', 'attachments')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'aaaaaaaaaaaa.png'), 'orphan-bytes')
  await writeFile(join(dir, 'bbbbbbbbbbbb.png'), 'kept-bytes')
  const board = {
    rev: 1,
    updatedAt: 'x',
    cards: [
      {
        id: 'card-ref-1', title: 'holder', detail: '', tags: [], column: 'inbox', flag: false,
        notes: [], origin: '', createdBy: 'owner', createdAt: 'x', updatedAt: 'x',
        columnSince: 'x', attachments: [{ file: 'bbbbbbbbbbbb.png', kind: 'image/png' }],
      },
    ],
  }
  await writeFile(join(s.cwd, '.docket', 'board.json'), `${JSON.stringify(board, null, 2)}\n`)
  s.lines.length = 0
  await runCli(['doctor'], { ...s, inboxClient: async () => ({ readBuckets: async () => [] }) })
  assert.match(s.output(), /1 attachment file/, 'the orphan must be counted')
  assert.doesNotMatch(s.output(), /bbbbbbbbbbbb/, 'a referenced file is nobody´s business')
})

test('prune deletes only what nothing references, and never touches the board', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Atts'], s)
  const dir = join(s.cwd, '.docket', 'attachments')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cccccccccccc.png'), 'orphan')
  await writeFile(join(dir, 'dddddddddddd.png'), 'shared-survivor')
  // The shared case, after the deletion: one remaining card still references
  // the file the deleted card also carried. Prune must not sweep it.
  const board = {
    rev: 4,
    updatedAt: 'x',
    cards: [
      {
        id: 'card-keeper', title: 'keeper', detail: '', tags: [], column: 'done', flag: false,
        notes: [], origin: '', createdBy: 'owner', createdAt: 'x', updatedAt: 'x',
        columnSince: 'x', attachments: [{ file: 'dddddddddddd.png', kind: 'image/png' }],
      },
    ],
  }
  await writeFile(join(s.cwd, '.docket', 'board.json'), `${JSON.stringify(board, null, 2)}\n`)
  s.lines.length = 0
  const code = await runCli(['prune'], s)
  assert.equal(code, 0)
  const left = await readdir(dir)
  assert.ok(!left.includes('cccccccccccc.png'), 'the orphan goes')
  assert.ok(left.includes('dddddddddddd.png'), 'the referenced file survives — a card in done counts')
  const after = JSON.parse(await readFile(join(s.cwd, '.docket', 'board.json'), 'utf8'))
  assert.equal(after.rev, 4, 'prune reads boards, it never writes one')
  assert.match(s.output(), /1 /, 'says what it removed')
})

test('prune leaves a project with an unreadable board entirely alone', async () => {
  // Unreadable is not the same as unreferenced. Treating a corrupt board as
  // "no cards" would wipe that project's attachments — the one path here with
  // destructive blast radius, resting on a single early continue.
  const s = await sandbox()
  await runCli(['init', '--name', 'Corrupt'], s)
  const dir = join(s.cwd, '.docket', 'attachments')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'abcdefabcdef.png'), 'bytes nothing can vouch for')
  await writeFile(join(s.cwd, '.docket', 'board.json'), 'not json {{{')
  s.lines.length = 0
  const code = await runCli(['prune'], s)
  assert.equal(code, 0)
  assert.deepEqual(await readdir(dir), ['abcdefabcdef.png'], 'an unvouchable file stays put')
})

test('prune judges each project by its own board — the same name can live in two', async () => {
  const s = await sandbox()
  await runCli(['init', '--name', 'Alpha'], s)
  const cwdBeta = await mkdtemp(join(tmpdir(), 'beta-project-'))
  await runCli(['init', '--name', 'Beta'], { ...s, cwd: cwdBeta })
  const file = 'eeeeeeeeeeee.png'
  for (const root of [s.cwd, cwdBeta]) {
    await mkdir(join(root, '.docket', 'attachments'), { recursive: true })
    await writeFile(join(root, '.docket', 'attachments', file), 'same bytes, same name')
  }
  const board = {
    rev: 1,
    updatedAt: 'x',
    cards: [
      {
        id: 'card-a', title: 'holder', detail: '', tags: [], column: 'inbox', flag: false,
        notes: [], origin: '', createdBy: 'owner', createdAt: 'x', updatedAt: 'x',
        columnSince: 'x', attachments: [{ file, kind: 'image/png' }],
      },
    ],
  }
  await writeFile(join(s.cwd, '.docket', 'board.json'), `${JSON.stringify(board, null, 2)}\n`)
  s.lines.length = 0
  await runCli(['prune'], s)
  assert.deepEqual(
    await readdir(join(s.cwd, '.docket', 'attachments')),
    [file],
    'referenced in Alpha: survives',
  )
  assert.deepEqual(
    await readdir(join(cwdBeta, '.docket', 'attachments')),
    [],
    'orphaned in Beta: goes, even though Alpha holds the same name',
  )
})

// ---------------------------------------------------------------------------
// docket push — the sequences, pinned with a scripted git.

/**
 * A repo that looks like an ordinary clone: one remote named origin whose
 * default branch is main. The timer asks these three things before it does
 * anything, and a test about rebasing should not have to restate them.
 * A test that IS about them overrides them, since the first match wins.
 */
const CLONE = [
  ['remote show', { stdout: 'origin\n' }],
  ['symbolic-ref --short refs/remotes/origin/HEAD', { stdout: 'origin/main\n' }],
]

function scriptedGit(script) {
  const calls = []
  return {
    calls,
    git: async (args) => {
      calls.push(args.join(' '))
      for (const [pattern, result] of [...script, ...CLONE]) {
        if (args.join(' ').startsWith(pattern)) {
          return { code: 0, stdout: '', stderr: '', ...(typeof result === 'function' ? result(calls) : result) }
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

async function pushSandbox() {
  const s = await sandbox()
  await runCli(['init', '--name', 'Pushy'], s)
  const home = await mkdtemp(join(tmpdir(), 'docket-push-home-'))
  const realHome = process.env.HOME
  process.env.HOME = home
  return {
    ...s,
    home,
    done: () => {
      process.env.HOME = realHome
    },
    status: async () =>
      JSON.parse(await readFile(join(home, '.docket', 'push-status.json'), 'utf8').catch(() => 'null')),
  }
}

test('push commits only the board, with the rev in the message, then pushes', async () => {
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref', { stdout: 'main\n' }],
      ['status --porcelain', { stdout: ' M .docket/board.json\n' }],
      ['log origin/main..HEAD', { stdout: '.docket/board.json\n' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    const commit = calls.find((c) => c.startsWith('commit'))
    assert.ok(commit, 'a dirty board must be committed')
    assert.match(commit, /-- \.docket\/board\.json$/, 'only the board file, ever')
    assert.match(commit, /rev 0/, 'the message carries the board rev — the git log is the event stream')
    assert.ok(calls.some((c) => c === 'push origin main'))
    assert.equal((await s.status()).lastError, null)
    assert.ok((await s.status()).lastSuccessAt)
  } finally {
    s.done()
  }
})

test('push with a clean board and nothing ahead does nothing, quietly', async () => {
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref', { stdout: 'main\n' }],
      ['status --porcelain', { stdout: '' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    assert.ok(!calls.some((c) => c.startsWith('commit') || c.startsWith('push')), 'no commit, no push')
    assert.ok((await s.status()).lastSuccessAt, 'a checked no-op is still a live timer')
  } finally {
    s.done()
  }
})

test('push refuses to act anywhere but the default branch', async () => {
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref --short HEAD', { stdout: 'feat/something\n' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    assert.ok(!calls.some((c) => c.startsWith('commit') || c.startsWith('push')))
    assert.match(s.output(), /skipped/i)
    assert.ok((await s.status()).lastSuccessAt, 'a deliberate skip is not a dead timer')
  } finally {
    s.done()
  }
})

test('an unset origin/HEAD does not name the default branch "HEAD"', async () => {
  // `git remote add` plus `push -u` never writes refs/remotes/origin/HEAD —
  // only a clone does — so this is the ordinary case, not the exotic one. The
  // first version of this asked `rev-parse --abbrev-ref`, which ECHOES its
  // argument when the ref does not resolve, so the default branch came back as
  // the literal string "HEAD" and every push was skipped forever.
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref --short HEAD', { stdout: 'main\n' }],
      ['symbolic-ref --short refs/remotes/origin/HEAD', { code: 1, stdout: '', stderr: 'fatal: ref not a symbolic ref\n' }],
      ['rev-parse --abbrev-ref origin/HEAD', { code: 128, stdout: 'origin/HEAD\n', stderr: 'fatal: ambiguous argument\n' }],
      ['config --get init.defaultBranch', { code: 1, stdout: '' }],
      ['status --porcelain', { stdout: ' M .docket/board.json\n' }],
      ['log origin/main..HEAD', { stdout: '.docket/board.json\n' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    assert.doesNotMatch(s.output(), /only ships HEAD/, 'the echoed ref must never become a branch name')
    assert.ok(calls.some((c) => c === 'push origin main'), `expected a push, got: ${calls.join(' | ')}`)
  } finally {
    s.done()
  }
})

test('the default branch is whatever the remote says, not the literal "main"', async () => {
  // The defect this replaced: a repo on trunk or master reported "skipped" on
  // every tick and never said why.
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref --short HEAD', { stdout: 'trunk\n' }],
      ['symbolic-ref --short refs/remotes/origin/HEAD', { stdout: 'origin/trunk\n' }],
      ['status --porcelain', { stdout: ' M .docket/board.json\n' }],
      ['log origin/trunk..HEAD', { stdout: '.docket/board.json\n' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    assert.ok(calls.some((c) => c === 'push origin trunk'), `expected a push to trunk, got: ${calls.join(' | ')}`)
  } finally {
    s.done()
  }
})

test('no remote means nowhere to push, and the timer says so', async () => {
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref --short HEAD', { stdout: 'main\n' }],
      ['remote show', { stdout: '\n' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    assert.match(s.output(), /no git remote/)
    assert.ok(!calls.some((c) => c.startsWith('push')), 'nothing is pushed without a remote')
  } finally {
    s.done()
  }
})

test('a clean board with unpushed CODE commits is skipped, never shipped', async () => {
  // The gate proved this live: rev-list alone pushes whatever is ahead, which
  // on a five-minute timer means shipping the owner's unfinished work. The
  // push gates on the board being the reason — a history that touches
  // anything else is the owner's to push.
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref', { stdout: 'main\n' }],
      ['status --porcelain', { stdout: '' }],
      ['log origin/main..HEAD', { stdout: 'src/a.js\n.docket/board.json\n' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    assert.ok(!calls.some((c) => c.startsWith('push')), 'those commits are the owner’s to ship')
    assert.match(s.output(), /skipped|yours to push/i)
    assert.ok((await s.status()).lastSuccessAt, 'a deliberate skip is a live timer')
  } finally {
    s.done()
  }
})

test('a rejected push rebases once and retries — when the tree is clean', async () => {
  const s = await pushSandbox()
  try {
    let pushes = 0
    const { calls, git } = scriptedGit([
      ['symbolic-ref', { stdout: 'main\n' }],
      ['status --porcelain --untracked-files=no', { stdout: '' }],
      ['status --porcelain', { stdout: '' }],
      ['log origin/main..HEAD', { stdout: '.docket/board.json\n' }],
      ['push origin main', () => ({ code: ++pushes === 1 ? 1 : 0, stderr: 'non-fast-forward' })],
      ['pull --rebase', { code: 0 }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 0)
    assert.equal(calls.filter((c) => c === 'push origin main').length, 2)
    assert.ok(calls.some((c) => c.startsWith('pull --rebase origin main')))
    assert.equal((await s.status()).lastError, null)
  } finally {
    s.done()
  }
})

test('a rejected push with local edits records why instead of attempting a doomed rebase', async () => {
  // git refuses to pull --rebase over unstaged tracked changes, so trying is
  // noise. Say the real reason; the owner's next push clears it.
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref', { stdout: 'main\n' }],
      ['status --porcelain --untracked-files=no', { stdout: ' M src/x.js\n' }],
      ['status --porcelain', { stdout: '' }],
      ['log origin/main..HEAD', { stdout: '.docket/board.json\n' }],
      ['push origin main', { code: 1, stderr: 'non-fast-forward' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 1)
    assert.ok(!calls.some((c) => c.startsWith('pull --rebase')), 'a doomed rebase is never attempted')
    const status = await s.status()
    assert.ok(status.lastFailureAt)
    assert.match(status.lastError, /local edits/i)
  } finally {
    s.done()
  }
})

test('the push status file redacts what it is handed, like every status file', async () => {
  const s = await pushSandbox()
  try {
    const token = `ghp_${'Kk3Jj2Hh'.repeat(4)}`
    const { git } = scriptedGit([
      ['symbolic-ref', { stdout: 'main\n' }],
      ['status --porcelain --untracked-files=no', { stdout: '' }],
      ['status --porcelain', { stdout: '' }],
      ['log origin/main..HEAD', { stdout: '.docket/board.json\n' }],
      ['push origin main', { code: 1, stderr: `remote: token ${token} rejected` }],
      ['pull --rebase', { code: 1, stderr: `fatal: auth ${token}` }],
    ])
    await runCli(['push'], { ...s, git })
    const status = await s.status()
    assert.ok(status.lastError, 'a reason is recorded')
    assert.ok(!JSON.stringify(status).includes(token), 'the status file never holds a credential')
  } finally {
    s.done()
  }
})

test('pushStatus.write redacts whatever it is handed — the choke point, not the callers', async () => {
  // The drain's status card taught this exact lesson: call-site safeError
  // masks a write that stops redacting, so the choke point needs its own pin.
  const home = await mkdtemp(join(tmpdir(), 'docket-push-status-'))
  const token = `ghp_${'Vv1Uu0Tt'.repeat(4)}`
  await pushStatus.write(home, { lastError: `raw ${token}`, lastFailureAt: 'x' })
  const status = JSON.parse(await readFile(join(home, '.docket', 'push-status.json'), 'utf8'))
  assert.ok(!status.lastError.includes(token), 'the write itself must redact')
  assert.match(status.lastError, /\[redacted\]/)
})

test('doctor stays silent about the push timer when it is not installed', async () => {
  const s = await pushSandbox()
  try {
    s.lines.length = 0
    await runCli(['doctor'], { ...s, inboxClient: async () => ({ readBuckets: async () => [] }) })
    assert.doesNotMatch(s.output(), /^push /m, 'the timer is opt-in — absent is silent')
  } finally {
    s.done()
  }
})

test('an unrebaseable push aborts the rebase and records why', async () => {
  const s = await pushSandbox()
  try {
    const { calls, git } = scriptedGit([
      ['symbolic-ref', { stdout: 'main\n' }],
      ['status --porcelain', { stdout: '' }],
      ['log origin/main..HEAD', { stdout: '.docket/board.json\n' }],
      ['push origin main', { code: 1, stderr: 'non-fast-forward' }],
      ['pull --rebase', { code: 1, stderr: 'CONFLICT: board.json' }],
    ])
    const code = await runCli(['push'], { ...s, git })
    assert.equal(code, 1)
    assert.ok(calls.some((c) => c === 'rebase --abort'), 'never leave a timer-owned repo mid-rebase')
    const status = await s.status()
    assert.ok(status.lastFailureAt)
    assert.match(status.lastError, /CONFLICT/)
    assert.equal(calls.filter((c) => c === 'push origin main').length, 1, 'no blind second push')
  } finally {
    s.done()
  }
})

test('push against REAL git: ships a board-only history, refuses a mixed one', async () => {
  // The scripted fakes above pin sequences; this pins git itself. The original
  // defect — shipping an unpushed code commit off a clean board — survived
  // every scripted test and was caught live by a gate. Never again scriptless.
  const { execFileSync } = await import('node:child_process')
  const origin = await mkdtemp(join(tmpdir(), 'docket-origin-'))
  const work = await mkdtemp(join(tmpdir(), 'docket-work-'))
  const g = (args, cwd = work) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  g(['init', '--bare', '-b', 'main'], origin)
  g(['init', '-b', 'main'])
  g(['config', 'user.email', 'test@test'])
  g(['config', 'user.name', 'test'])
  g(['remote', 'add', 'origin', origin])

  const s = await sandbox()
  await runCli(['init', '--name', 'RealGit'], { ...s, cwd: work })
  g(['add', '-A'])
  g(['commit', '-m', 'initial'])
  g(['push', '-u', 'origin', 'main'])

  const home = await mkdtemp(join(tmpdir(), 'docket-realgit-home-'))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    // A board change ships, alone, with the rev in the message.
    const board = JSON.parse(await readFile(join(work, '.docket', 'board.json'), 'utf8'))
    board.rev = 7
    await writeFile(join(work, '.docket', 'board.json'), `${JSON.stringify(board, null, 2)}\n`)
    let code = await runCli(['push'], { ...s, cwd: work })
    assert.equal(code, 0)
    assert.match(g(['log', '-1', '--format=%s'], origin), /chore\(board\): rev 7/)

    // A mixed history never ships: clean board, one unpushed code commit.
    await writeFile(join(work, 'wip.js'), 'unfinished\n')
    g(['add', 'wip.js'])
    g(['commit', '-m', 'wip: do not ship'])
    s.lines.length = 0
    code = await runCli(['push'], { ...s, cwd: work })
    assert.equal(code, 0)
    assert.match(s.output(), /yours to push/)
    assert.doesNotMatch(g(['log', '--format=%s'], origin), /wip: do not ship/, 'the owner’s commit stayed home')
  } finally {
    process.env.HOME = realHome
  }
})
