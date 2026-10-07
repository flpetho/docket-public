/**
 * Everything that touches the network. The board file is the authority, so this
 * module never holds an opinion about state — it fetches, it pushes, and it
 * reports what the server said.
 *
 * Offline is read-only, deliberately. The predecessor let browsers hold
 * authoritative state and stale copies kept healing junk back into the shared
 * file; there is no offline write path here for that reason.
 */

const PUSH_DEBOUNCE_MS = 400
const SAFETY_POLL_MS = 60_000
/** Bounded, so a board changing under a slow client cannot spin forever. */
const MAX_CONFLICT_REPLAYS = 3

/**
 * Undo a mutator that changed something and then gave up.
 *
 * `false` means "the thing I wanted is gone", but a mutator is free to
 * discover that halfway through. Without this, the abandoned change stays in
 * the array and the next successful push carries it to the server — an edit
 * reported lost arriving anyway, attached to an unrelated save.
 *
 * Restores IN PLACE: `doc.cards` is held across renders and `replayOnto` is
 * handed the caller's array, so neither may be rebound.
 */
const restoreInto = (cards, snapshot) => {
  cards.length = 0
  cards.push(...snapshot)
}

/**
 * Re-applies edits onto cards that arrived while they were in flight.
 *
 * Pure, so the part that decides whether the owner's edit survived is testable
 * without a network or a DOM. A mutation returns false to say it could not
 * apply — the card it wanted is gone — and that is the only case where an edit
 * is genuinely lost rather than merely delayed.
 */
export function replayOnto(cards, mutations) {
  const lost = []
  for (const fn of mutations) {
    const snapshot = structuredClone(cards)
    if (fn(cards) === false) {
      restoreInto(cards, snapshot)
      lost.push(fn)
    }
  }
  return { applied: mutations.length - lost.length, lost }
}

export function createSync({ project, onDoc, onStatus, onUiVersion }) {
  let doc = null
  let pushTimer = null
  let events = null
  // The mutations, not the resulting array. A 409 needs to re-apply the EDIT
  // onto the server's newer cards; replaying a stale array would clobber them.
  // Each carries its own resolver, so a push answers for exactly the edits it
  // carried — an edit made while another push was in flight hears about ITS
  // push, never that one (the second review of card fzuf, 2026-10-06).
  let pending = []
  // The cards as the server last confirmed them: what it sent us, or what it
  // accepted from us. A push that fails returns the board to this, so an edit
  // reported lost is not left on screen to ride along with the next save.
  let confirmed = []
  // One push at a time. Two PUTs in flight could let the second carry an edit
  // the first then rolls back, and the save after that would delete it.
  let inFlight = false

  const settle = (entries, outcome) => {
    for (const entry of entries) entry.resolve(outcome)
  }
  const fns = (entries) => entries.map((entry) => entry.fn)

  const params = () => `?project=${encodeURIComponent(project)}`

  const adopt = (next) => {
    doc = next
    confirmed = structuredClone(next.cards ?? [])
    onDoc(doc)
  }

  /**
   * Undo what did not land. The board goes back to what the server confirmed,
   * then the edits still queued — made while the failed push was in flight —
   * are applied again, because they have not been tried yet and will push on
   * their own timer. One that can no longer apply (a note on the card that
   * just failed to be created) is answered lost here rather than pushed as a
   * no-op and reported saved.
   */
  const rollBack = () => {
    restoreInto(doc.cards, structuredClone(confirmed))
    const { lost } = replayOnto(doc.cards, fns(pending))
    settle(pending.filter((entry) => lost.includes(entry.fn)), 'lost')
    pending = pending.filter((entry) => !lost.includes(entry.fn))
    onDoc(doc)
  }

  /** The edits did not land: say so, put the board back, answer them. */
  const fail = (entries, message) => {
    rollBack()
    onStatus('offline', message)
    settle(entries, 'lost')
  }

  async function load() {
    try {
      const response = await fetch(`/api/board${params()}`)
      if (!response.ok) throw new Error(`GET ${response.status}`)
      adopt(await response.json())
      onStatus('live', `synced · rev ${doc.rev}`)
      return doc
    } catch {
      onStatus('offline', 'daemon unreachable — read only')
      return null
    }
  }

  const schedule = () => {
    clearTimeout(pushTimer)
    pushTimer = setTimeout(flush, PUSH_DEBOUNCE_MS)
  }

  async function flush() {
    pushTimer = null
    if (inFlight) return schedule()
    if (!pending.length) return
    inFlight = true
    try {
      await push()
    } finally {
      inFlight = false
    }
  }

  async function push(replaysLeft = MAX_CONFLICT_REPLAYS) {
    const attempted = pending
    pending = []
    // Cloned in the same tick as the body is serialised, so it is exactly
    // what the server will hold if it answers 200.
    const sentCards = structuredClone(doc.cards)
    let response
    try {
      response = await fetch(`/api/board${params()}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev: doc.rev, cards: doc.cards }),
      })
    } catch {
      // Offline stays read-only: no queue, no retry. But say plainly that the
      // edit did not land, rather than implying it did.
      return fail(attempted, 'save failed — daemon unreachable, your edit was NOT saved')
    }

    if (response.status === 409) {
      // The server is newer. Adopt its cards and REPLAY the edits onto them.
      // The previous version adopted and dropped them, which is how a note
      // typed while another session wrote the same board was lost outright.
      let server
      try {
        server = await response.json()
      } catch {
        return fail(attempted, 'save failed — the daemon sent an unreadable conflict, your edit was NOT saved')
      }
      // Anything that arrived during the await was applied to the array we are
      // about to discard, so it has to be replayed too.
      const toReplay = attempted.concat(pending)
      pending = []
      adopt(server)
      const { applied, lost } = replayOnto(doc.cards, fns(toReplay))
      onDoc(doc)
      settle(toReplay.filter((entry) => lost.includes(entry.fn)), 'lost')
      const surviving = toReplay.filter((entry) => !lost.includes(entry.fn))

      if (applied === 0) {
        // Every edit wanted a card that no longer exists. Nothing to retry.
        onStatus('offline', 'your last edit could not be saved — its card is gone')
        return
      }
      if (replaysLeft <= 0) {
        return fail(surviving, 'could not save — the board kept changing underneath')
      }
      if (lost.length) onStatus('saving', `${lost.length} edit(s) could not be replayed`)
      else onStatus('saving', `changed elsewhere — replaying your edit onto rev ${doc.rev}`)
      // Queue the replayed edits again, ahead of anything newer. Without
      // this the next push attempted nothing, so a SECOND conflict in a row
      // had nothing to replay and dropped the edit as "its card is gone".
      pending = surviving.concat(pending)
      return push(replaysLeft - 1)
    }

    if (!response.ok) {
      return fail(attempted, `save failed — the daemon answered ${response.status}, your edit was NOT saved`)
    }
    // A 200 is a save, whether or not its body can be read: the server holds
    // the write, and calling it lost would invite the owner to apply it twice.
    confirmed = sentCards
    const body = await response.json().catch(() => null)
    if (typeof body?.rev === 'number') doc.rev = body.rev
    onStatus('live', `synced · rev ${doc.rev}`)
    settle(attempted, 'saved')
  }

  /**
   * Applies a mutation locally, re-renders, then pushes on a debounce.
   *
   * Returns a promise resolving to 'saved' or 'lost', so a caller that holds the
   * owner's text can put it back rather than letting it disappear.
   */
  function mutate(fn) {
    if (!doc) return Promise.resolve('lost')
    // Apply BEFORE queueing, and read the answer. `false` means the thing this
    // mutation wanted is gone, which no retry and no replay can fix — so it is
    // never queued and never pushed.
    //
    // The snapshot is what makes "never pushed" true. A mutator may change
    // something and only then discover it must give up; push() serialises the
    // whole cards array, so without restoring, that abandoned change would
    // travel to the server inside the next unrelated save.
    const snapshot = structuredClone(doc.cards)
    if (fn(doc.cards) === false) {
      restoreInto(doc.cards, snapshot)
      onStatus('offline', 'your last edit could not be saved — its card is gone')
      return Promise.resolve('lost')
    }
    const answer = new Promise((resolve) => pending.push({ fn, resolve }))
    onDoc(doc)
    onStatus('saving', 'saving…')
    schedule()
    return answer
  }

  function listen() {
    events?.close()
    events = new EventSource(`/api/events${params()}`)
    events.onmessage = (message) => {
      const payload = JSON.parse(message.data)
      // A version frame is not a board frame: it must never be dropped by the
      // push guard below, and it never touches the doc.
      if (payload.type === 'ui') return void onUiVersion?.(payload.version)
      if (pushTimer !== null || inFlight) return // a local edit is pushing or about to; don't race it
      if (payload.type !== 'board' || !doc || payload.rev <= doc.rev) return
      adopt(payload.doc)
      onStatus('live', `updated elsewhere · rev ${doc.rev}`)
    }
    // SSE drops happen; the browser reconnects on its own, and the poll below
    // is the belt to that braces.
    events.onerror = () => onStatus('offline', 'stream dropped — reconnecting')
  }

  function pollSafety() {
    setInterval(async () => {
      const busy = () => pushTimer !== null || inFlight || pending.length > 0
      if (busy()) return
      try {
        const response = await fetch(`/api/board${params()}`)
        if (!response.ok) return
        const server = await response.json()
        // Asked again after the await: an edit made meanwhile lives only in
        // this doc, and adopting now would discard it.
        if (busy()) return
        if (!doc || server.rev > doc.rev) {
          adopt(server)
          onStatus('live', `synced · rev ${doc.rev}`)
        } else {
          onStatus('live', `synced · rev ${doc.rev}`)
        }
      } catch {
        onStatus('offline', 'daemon unreachable — read only')
      }
    }, SAFETY_POLL_MS)
  }

  return {
    load,
    listen,
    pollSafety,
    mutate,
    get doc() {
      return doc
    },
  }
}

export async function loadProjects() {
  try {
    const response = await fetch('/api/projects')
    if (!response.ok) return []
    return (await response.json()).projects
  } catch {
    return []
  }
}
