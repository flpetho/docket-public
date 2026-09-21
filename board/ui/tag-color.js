/**
 * One tag → one stable colour, imported by both the browser and the server so
 * a tag can never look like two different things.
 *
 * Hues in the accent's neighbourhood are excluded. The accent (#ff5227, hue ~13)
 * means priority and nothing else; when seven auto-coloured tags all landed in
 * the salmon range they read as accent-coloured and the signal was gone.
 */

const ACCENT_LOW = 340
const ACCENT_HIGH = 45
const SPAN = 360 - (ACCENT_HIGH + (360 - ACCENT_LOW)) // usable hue degrees

/** FNV-1a, so the same tag gets the same colour on every machine and reload. */
function hash(text) {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

export function tagHue(tag) {
  return (ACCENT_HIGH + (hash(tag) % SPAN)) % 360
}

export function tagColor(tag, declared = {}) {
  if (declared[tag]) return declared[tag]
  return `hsl(${tagHue(tag)} 42% 66%)`
}
