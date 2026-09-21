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
    if (fn(cards) === false) lost.push(fn)
  }
  return { applied: mutations.length - lost.length, lost }
}

export function createSync({ project, onDoc, onStatus, onUiVersion }) {
  let doc = null
  let pushTimer = null
  let events = null
  // The mutations, not the resulting array. A 409 needs to re-apply the EDIT
  // onto the server's newer cards; replaying a stale array would clobber them.
  let pending = []
  let waiters = []

  const settle = (outcome) => {
    const resolvers = waiters
    waiters = []
    for (const resolve of resolvers) resolve(outcome)
  }

  const params = () => `?project=${encodeURIComponent(project)}`

  const adopt = (next) => {
    doc = next
    onDoc(doc)
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

  async function push(replaysLeft = MAX_CONFLICT_REPLAYS) {
    pushTimer = null
    const attempted = pending
    pending = []
    try {
      const response = await fetch(`/api/board${params()}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev: doc.rev, cards: doc.cards }),
      })

      if (response.status === 409) {
        // The server is newer. Adopt its cards and REPLAY the edits onto them.
        // The previous version adopted and dropped them, which is how a note
        // typed while another session wrote the same board was lost outright.
        const server = await response.json()
        // Anything that arrived during the await was applied to the array we are
        // about to discard, so it has to be replayed too.
        const toReplay = attempted.concat(pending)
        pending = []
        adopt(server)
        const { applied, lost } = replayOnto(doc.cards, toReplay)
        onDoc(doc)

        if (applied === 0) {
          // Every edit wanted a card that no longer exists. Nothing to retry.
          onStatus('offline', 'your last edit could not be saved — its card is gone')
          settle('lost')
          return
        }
        if (replaysLeft <= 0) {
          onStatus('offline', 'could not save — the board kept changing underneath')
          settle('lost')
          return
        }
        if (lost.length) onStatus('saving', `${lost.length} edit(s) could not be replayed`)
        else onStatus('saving', `changed elsewhere — replaying your edit onto rev ${doc.rev}`)
        return push(replaysLeft - 1)
      }

      if (!response.ok) throw new Error(`PUT ${response.status}`)
      doc.rev = (await response.json()).rev
      onStatus('live', `synced · rev ${doc.rev}`)
      settle('saved')
    } catch {
      // Offline stays read-only: no queue, no retry. But say plainly that the
      // edit did not land, rather than implying it did.
      onStatus('offline', 'save failed — daemon unreachable, your edit was NOT saved')
      settle('lost')
    }
  }

  /**
   * Applies a mutation locally, re-renders, then pushes on a debounce.
   *
   * Returns a promise resolving to 'saved' or 'lost', so a caller that holds the
   * owner's text can put it back rather than letting it disappear.
   */
  function mutate(fn) {
    if (!doc) return Promise.resolve('lost')
    pending.push(fn)
    fn(doc.cards)
    onDoc(doc)
    clearTimeout(pushTimer)
    onStatus('saving', 'saving…')
    pushTimer = setTimeout(() => push(), PUSH_DEBOUNCE_MS)
    return new Promise((resolve) => waiters.push(resolve))
  }

  function listen() {
    events?.close()
    events = new EventSource(`/api/events${params()}`)
    events.onmessage = (message) => {
      const payload = JSON.parse(message.data)
      // A version frame is not a board frame: it must never be dropped by the
      // push guard below, and it never touches the doc.
      if (payload.type === 'ui') return void onUiVersion?.(payload.version)
      if (pushTimer !== null) return // a local edit is about to push; don't race it
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
      if (pushTimer !== null) return
      try {
        const response = await fetch(`/api/board${params()}`)
        if (!response.ok) return
        const server = await response.json()
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
