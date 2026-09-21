/**
 * The deployment's security posture, pinned.
 *
 * These are not cosmetic settings. The board is private content on a public
 * hostname, and the two things standing between those facts are Vercel
 * Authentication (a dashboard setting, which no test can see) and the headers in
 * vercel.json (which one can). A future edit that loosens the CSP or drops
 * noindex would be invisible in review and would not fail anything — so it fails
 * here instead.
 *
 * Verified live 2026-08-24: served with exactly these headers, an inline
 * <script> and an inline onerror both failed to execute while the DOM still
 * rendered, and the data:-URI fonts still loaded.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(await readFile(join(here, '..', 'vercel.json'), 'utf8'))

const headers = new Map(
  config.headers.flatMap((rule) => rule.headers.map((h) => [h.key.toLowerCase(), h.value])),
)

test('every route is covered, not just some prefix', () => {
  assert.equal(config.headers.length, 1)
  assert.equal(config.headers[0].source, '/(.*)')
})

/**
 * The CSP as a directive map, so assertions are about policy rather than about
 * substrings.
 *
 * The previous version of the test below matched `/script-src (?!'none')/`,
 * which requires the literal `script-src` followed by a space — so
 * `script-src-elem 'unsafe-inline'` slipped straight past it. That is not a
 * hypothetical evasion: `script-src-elem` takes precedence over `default-src`
 * for <script> elements, so the gate served this exact policy plus that one
 * directive, watched an inline script execute, and watched all six of these
 * tests still report green. A test whose whole purpose is to fail when the CSP
 * is loosened did not fail. Parse, then assert.
 */
const directives = new Map(
  (headers.get('content-security-policy') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/)
      return [name.toLowerCase(), values.join(' ')]
    }),
)

test('no directive can permit a script — checked per directive, not by substring', () => {
  assert.ok(directives.size > 0, 'a CSP is set')
  // The fallback, for any script directive that is absent.
  assert.equal(directives.get('default-src'), "'none'")
  // Every script directive that exists must be 'none' — including ones nobody
  // has invented yet, which is why this iterates rather than listing.
  const scriptDirectives = [...directives.keys()].filter((name) => name.startsWith('script-'))
  for (const name of scriptDirectives) {
    assert.equal(directives.get(name), "'none'", `${name} must be 'none'`)
  }
  // Pinned explicitly as well as by default-src: the three that browsers
  // actually consult for scripts should be present, so loosening one is a
  // visible edit to a line that says 'none' rather than an addition nobody
  // reads. web/README.md claims these by name.
  for (const name of ['script-src', 'script-src-elem', 'script-src-attr']) {
    assert.equal(directives.get(name), "'none'", `${name} is stated outright`)
  }
  const csp = headers.get('content-security-policy')
  // Case-insensitive: CSP keywords are case-insensitive per spec, so 'UNSAFE-EVAL'
  // slipped the earlier check.
  assert.ok(!/unsafe-eval/i.test(csp))
  assert.ok(!/unsafe-inline/i.test(csp.replace(/style-src[^;]*/i, '')), 'only style-src may be inline')
})

test('the non-script directives are pinned too — they are the second line of defence', () => {
  // A gate widened `img-src` to `*` and this suite stayed green, which matters:
  // `img-src data:` is what stops a beacon if `safeColor` ever regresses, and a
  // regression in the layer *behind* a guard is the one nobody notices. Same
  // reasoning for the three that exist to stop a page being reframed or
  // repointed. Fetching directives are absent by design — `default-src 'none'`
  // covers them — so this asserts they stay absent rather than allowing them.
  assert.equal(directives.get('img-src'), 'data:', 'only inlined images')
  assert.equal(directives.get('font-src'), 'data:', 'only inlined fonts')
  assert.equal(directives.get('base-uri'), "'none'")
  assert.equal(directives.get('form-action'), "'none'")
  assert.equal(directives.get('frame-ancestors'), "'none'")
  for (const permissive of ['connect-src', 'child-src', 'worker-src', 'object-src', 'media-src']) {
    assert.equal(
      directives.has(permissive),
      false,
      `${permissive} must stay absent so default-src 'none' governs it`,
    )
  }
})

test('the CSP still permits what the page genuinely needs', () => {
  // A CSP so tight the page renders blank is the other failure mode, and it is
  // silent: the fonts are data: URIs and the styles are one inline block.
  const csp = headers.get('content-security-policy')
  assert.ok(/style-src [^;]*'unsafe-inline'/.test(csp), 'the inline <style> block')
  assert.ok(/font-src [^;]*data:/.test(csp), 'the inlined woff2 fonts')
})

test('the board is not offered to crawlers or referrers', () => {
  assert.match(headers.get('x-robots-tag') ?? '', /noindex/)
  assert.equal(headers.get('referrer-policy'), 'no-referrer')
})

test('a private board is never cached by an intermediary', () => {
  assert.equal(headers.get('cache-control'), 'no-store')
})

test('the build writes where vercel.json says it will', async () => {
  // A mismatch here deploys an empty site with a green build, which is the
  // worst combination: nothing to notice.
  assert.equal(config.outputDirectory, 'public')
  const build = await readFile(join(here, '..', 'build.mjs'), 'utf8')
  assert.match(build, /'public'/)
})
