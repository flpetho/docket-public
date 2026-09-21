/**
 * Renders the committed board to a static site for Vercel.
 *
 * WHY A DEPLOY AT ALL. `docket snapshot` already produces a file, and a file is
 * enough when a session is open to hand it over. A URL is what you want when no
 * session is open — you are in a browser, on a plane, and you just want to look.
 * That is the whole difference, and it is worth one static host.
 *
 * WHAT THIS IS NOT. It is not a build step for the board. `CLAUDE.md` forbids
 * one, and that rule stands: `board/ui/` is still native ES modules served
 * as-is, with nothing between the owner and the code. This renders a *separate,
 * read-only artifact* for a *separate* deployment, and deleting this directory
 * would leave the board exactly as it is. If that ever stops being true, the
 * rule has been broken and this file is the place it happened.
 *
 * WHY STATIC RATHER THAN A FUNCTION. A function reading GitHub at request time
 * would be fresher by the width of one deploy, and would need a token with read
 * access to this repo sitting in an environment variable. Vercel rebuilds on
 * push anyway, and a push is the only way a board reaches GitHub at all — so
 * the function buys nothing and costs a credential. Static wins.
 *
 * The output is as fresh as the repo and no fresher, which is why the page says
 * so in its own header.
 *
 * ⚠️ THIS PUBLISHES A BOARD. Everything on it — card text, every note, whatever
 * anyone pasted into a card — is rendered verbatim into a page anyone with the
 * URL can read. Snapshot rendering deliberately does NOT pass through the
 * redaction boundary that every CLI line passes through, because a board is
 * content rather than a log line, and half-redacted content is worse than
 * either.
 *
 * So this refuses to guess which board it is publishing. There is no default
 * path: pass `--board`, or set DOCKET_WEB_BOARD, and the build prints what it
 * is about to publish before it writes anything. An earlier version read the
 * repo's own committed board with no flag at all, which meant a fork's first
 * deploy published whatever that board happened to say.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderSnapshot } from '../board/src/snapshot.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const out = join(here, 'public')

const read = async (path) => JSON.parse(await readFile(join(repo, path), 'utf8'))

/** Inlined so the page renders correctly offline once loaded. */
const b64 = async (path) =>
  readFile(join(repo, path)).then((buffer) => buffer.toString('base64'), () => null)

/** `--flag value` or `--flag=value`, the same shape the CLI accepts. */
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : null
}

// No default, on purpose. See the warning above.
const boardArg = flag('board') ?? process.env.DOCKET_WEB_BOARD
if (!boardArg) {
  console.error(
    [
      'Refusing to guess which board to publish.',
      '',
      'This build renders a board into a page anyone with the URL can read,',
      'including every note on every card, unredacted.',
      '',
      '  node web/build.mjs --board /path/to/project/.docket/board.json',
      '',
      'or set DOCKET_WEB_BOARD. On Vercel, set it as an environment variable',
      'and keep Deployment Protection ON for this project.',
    ].join('\n'),
  )
  process.exit(1)
}

const boardPath = boardArg
const configPath = join(dirname(boardPath), 'config.json')
const readAbs = async (path) => JSON.parse(await readFile(path, 'utf8'))
const board = await readAbs(boardPath)
const config = await readAbs(configPath).catch(() => ({ name: 'Docket', accent: '#ff5227', columns: [], tags: {} }))

// Say what is about to be published, before publishing it. A count and a rev
// are enough to notice "that is not the board I meant" while it is still cheap.
const noteCount = board.cards.reduce((sum, card) => sum + (card.notes?.length ?? 0), 0)
console.log(
  `publishing ${board.cards.length} cards and ${noteCount} notes from ${boardPath} (rev ${board.rev}) — unredacted`,
)

const [sans, mono] = await Promise.all([
  b64('board/ui/fonts/geist-latin.woff2'),
  b64('board/ui/fonts/geist-mono-latin.woff2'),
])

// Vercel exposes the commit it is building. Falling back rather than failing:
// a snapshot that cannot name its commit is still worth serving, and it still
// prints the board rev and the render time either way.
const commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || null

const html = renderSnapshot({
  board,
  config,
  meta: { now: new Date(), commit, fonts: { sans, mono } },
})

await mkdir(out, { recursive: true })
await writeFile(join(out, 'index.html'), html)

console.log(`rendered ${board.cards.length} cards, rev ${board.rev}${commit ? `, ${commit}` : ''}`)
