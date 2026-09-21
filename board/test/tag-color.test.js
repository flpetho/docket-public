import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { tagColor as fromCard } from '../src/card.js'
import { paletteForTracks } from '../src/migrate.js'
import { tagColor, tagHue } from '../ui/tag-color.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/migration-board-rev233.json', import.meta.url))

test('the server re-exports the same function the browser imports', () => {
  assert.equal(fromCard, tagColor)
})

test('a declared colour always wins over the hash', () => {
  assert.equal(tagColor('strategy', { strategy: '#123456' }), '#123456')
})

test('auto colours are deterministic', () => {
  assert.equal(tagColor('demo-polish'), tagColor('demo-polish'))
})

test('no auto hue lands in the accent range, so accent keeps its meaning', () => {
  const tags = [
    'demo-polish',
    'discovery-depth',
    'research-desk',
    'onboarding',
    'multi-user',
    'strategy',
    'tooling',
    'decision',
    'bug',
    'blocked',
    'chore',
    'spike',
  ]
  for (const tag of tags) {
    const hue = tagHue(tag)
    assert.ok(hue >= 45 && hue < 340, `${tag} hashed to hue ${hue}, inside the accent band`)
  }
})

test('the migration palette gives every track a distinct, well-spread hue', () => {
  const tracker = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const palette = paletteForTracks(tracker)
  assert.equal(Object.keys(palette).length, 7)
  assert.equal(new Set(Object.values(palette)).size, 7)

  const hues = Object.values(palette).map((c) => Number(/hsl\((\d+)/.exec(c)[1]))
  hues.sort((a, b) => a - b)
  for (const hue of hues) assert.ok(hue >= 45 && hue < 340, `hue ${hue} is in the accent band`)
  // Evenly spread means every neighbour is comfortably apart, which the hash
  // could not guarantee: three tracks hashed within 8 degrees of each other.
  for (let i = 1; i < hues.length; i++) {
    assert.ok(hues[i] - hues[i - 1] >= 30, `hues ${hues[i - 1]} and ${hues[i]} are too close`)
  }
})

test('the palette is stable across runs', () => {
  const tracker = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  assert.deepEqual(paletteForTracks(tracker), paletteForTracks(tracker))
})
