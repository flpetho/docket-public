/**
 * The phone layout's column pager.
 *
 * The board installs as a PWA and its columns are fixed at 16.5rem (297px at the 18px root), which on a
 * 390px screen is a horizontal maze — so the phone half of this tool was the
 * capture bot and nothing else. Below the breakpoint each column takes the full
 * width and scroll-snaps, which gets the swipe for free from the browser rather
 * than from a gesture library.
 *
 * Swipe alone would leave no way to know where you are in a seven-column
 * sequence, so there is also a pager: a name, a position, and two buttons.
 *
 * THE BREAKPOINT LIVES HERE. style.css carries the same number in one media
 * query and a test asserts the two agree, so "one documented threshold" is
 * enforced rather than hoped for.
 */

export const PHONE_MAX = 640

export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`

/** Which column a scroll offset is resting on. */
export function columnAtScroll(scrollLeft, columnWidth, count) {
  if (!(columnWidth > 0) || count <= 0) return 0
  const index = Math.round(scrollLeft / columnWidth)
  return Math.min(count - 1, Math.max(0, index))
}

/**
 * Clamped, not wrapped. A board has a first column and a last one; arriving at
 * Done and landing back on Inbox would lose the reader's place in a sequence
 * whose whole point is order.
 */
export function stepIndex(index, delta, count) {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, index + delta))
}

/** `LOOP · 4 OF 7` — the name alone does not say where you are. */
export function positionLabel(name, index, count) {
  if (!count) return ''
  return `${name} · ${index + 1} of ${count}`
}

/**
 * Wires the pager to a board element. Returns a `refresh` so a repaint — the
 * board rebuilds its columns from scratch on every SSE update — can restate the
 * label without re-binding anything.
 */
export function createPager({ board, prev, next, label, columnNames }) {
  const columns = () => [...board.querySelectorAll('.column')]
  let index = 0

  const paint = () => {
    const all = columns()
    const names = columnNames()
    label.textContent = positionLabel(names[index] ?? '', index, all.length)
    prev.disabled = index <= 0
    next.disabled = index >= all.length - 1
  }

  const goTo = (target) => {
    const all = columns()
    index = stepIndex(target, 0, all.length)
    all[index]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
    paint()
  }

  prev.addEventListener('click', () => goTo(index - 1))
  next.addEventListener('click', () => goTo(index + 1))

  // Swiping is the other half of clause 2, so the label has to follow a scroll
  // the pager did not initiate. rAF-coalesced: a swipe fires scroll continuously.
  let queued = false
  board.addEventListener('scroll', () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const all = columns()
      const width = all[0]?.getBoundingClientRect().width ?? 0
      const at = columnAtScroll(board.scrollLeft, width, all.length)
      if (at === index) return
      index = at
      paint()
    })
  })

  paint()
  return { refresh: paint, get index() { return index } }
}
