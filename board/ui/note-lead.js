/**
 * The first paragraph of a note is its summary, by convention (decision log,
 * 2026-09-11). The live panel and the snapshot both import this, so the two
 * cannot cut a note in different places — the same reason brief.js and
 * verdict.js are shared.
 *
 * `lead` is everything before the first blank line, `rest` everything after,
 * both trimmed. No blank line: the note is all lead, and the renderers show it
 * whole with nothing to open.
 */
export function splitNote(text) {
  const whole = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  const match = /\n[ \t]*\n/.exec(whole)
  if (!match) return { lead: whole, rest: '' }
  return {
    lead: whole.slice(0, match.index).trim(),
    rest: whole.slice(match.index + match[0].length).trim(),
  }
}
