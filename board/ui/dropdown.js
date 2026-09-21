/**
 * A dropdown drawn in the board's own language.
 *
 * Replaces every native `<select>` in the interface. The native control cannot
 * be styled past its own chrome on any platform, so one styled control and one
 * OS control sitting a click apart is the specific thing this removes.
 *
 * The pattern is the aria-activedescendant combobox rather than a roving
 * tabindex: focus never leaves the trigger, so Escape, Tab, and outside-click
 * all have one obvious place to be handled, and the modal's own Escape handler
 * cannot fire while a list is open inside it.
 *
 * The two pure functions are exported and tested on their own. board/ has no
 * DOM test harness and adding one would mean adding a dependency, so the rule
 * here is: anything decidable without a document gets decided without one.
 */

/** Which option the highlight moves to. Wraps, because a list that stops feels broken. */
export function nextIndex(index, key, count) {
  if (count <= 0) return -1
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return index
}

/**
 * What a keypress means, given whether the list is open.
 *
 * Four outcomes, and the distinction between two of them is the whole point:
 * 'cancel' closes AND swallows (Escape must not reach the modal behind it), while
 * 'passthrough' closes and lets the key continue (Tab needs its focus move, and
 * '/' and 'n' belong to the board). Returning null while open — the first
 * version's behaviour — propagated correctly and left the list hanging open with
 * focus somewhere else.
 */
export function actionFor(key, isOpen) {
  if (!isOpen) {
    if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') return 'open'
    return null
  }
  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') return 'move'
  if (key === 'Enter' || key === ' ') return 'commit'
  // Escape is the one key that must NOT propagate: the document handler would
  // close the whole modal this list may be sitting inside.
  if (key === 'Escape') return 'cancel'
  // Everything else, while open — Tab, '/', 'n', any letter: close the list and
  // let the key continue on its way. The first version returned null here, which
  // propagated correctly and left the list hanging open with focus elsewhere.
  // Closing and not swallowing were never in conflict.
  return 'passthrough'
}

/**
 * The keydown contract, pure over an event-shaped object and a set of hooks.
 *
 * The load-bearing part is ORDER: passthrough returns BEFORE preventDefault and
 * stopPropagation ever run. Tab needs its focus move, '/' and 'n' belong to the
 * board — swallowing them is the regression the ddfix card was written about,
 * and dropdown.test.js pins this position with a spied event.
 */
export function handleTriggerKey(event, ui) {
  const action = actionFor(event.key, ui.isOpen())
  if (!action) return // closed, and not a key that opens it: nothing to do

  // Close, but do not swallow. Either way an open list must not survive the
  // keypress.
  if (action === 'passthrough') return ui.close()

  // The rest are claimed, so they must not also reach the document handler —
  // Escape there closes the entire modal this may be sitting inside.
  event.preventDefault()
  event.stopPropagation()
  if (action === 'open') return ui.show()
  if (action === 'cancel') return ui.cancel()
  if (action === 'move') return ui.move(event.key)
  if (action === 'commit') return ui.commit()
}

/** The one open list, if any. Two open at once is always a bug, never a feature. */
let openInstance = null

/**
 * Builds the control inside `host` and returns `host`, with a `value` property
 * and a `change` event so a caller reads and writes it exactly as it read and
 * wrote the `<select>` this replaces.
 */
export function createDropdown(host, { label = '', labelElement = null, options = [], value = null } = {}) {
  const base = host.id || `dd-${Math.random().toString(36).slice(2, 8)}`
  let current = value
  let items = []
  let highlighted = -1
  let open = false

  host.classList.add('dd')

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'dd-trigger'
  trigger.setAttribute('role', 'combobox')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-controls', `${base}-list`)
  if (label) trigger.setAttribute('aria-label', label)

  const list = document.createElement('ul')
  list.className = 'dd-list'
  list.id = `${base}-list`
  list.setAttribute('role', 'listbox')
  if (label) list.setAttribute('aria-label', label)
  list.hidden = true

  host.replaceChildren(trigger, list)

  const selectedIndex = () => items.findIndex((o) => o.value === current)

  const paintTrigger = () => {
    const chosen = items[selectedIndex()]
    trigger.textContent = chosen ? chosen.label : ''
  }

  const paintList = () => {
    list.replaceChildren(
      ...items.map((option, index) => {
        const li = document.createElement('li')
        li.className = 'dd-option'
        li.id = `${base}-opt-${index}`
        li.setAttribute('role', 'option')
        li.setAttribute('aria-selected', String(option.value === current))
        li.textContent = option.label
        if (index === highlighted) li.dataset.active = 'true'
        return li
      }),
    )
    const active = items[highlighted]
    if (open && active) trigger.setAttribute('aria-activedescendant', `${base}-opt-${highlighted}`)
    else trigger.removeAttribute('aria-activedescendant')
  }

  const close = ({ focus = false } = {}) => {
    if (!open) return
    open = false
    highlighted = -1
    list.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    if (openInstance === api) openInstance = null
    paintList()
    if (focus) trigger.focus()
  }

  const show = () => {
    if (open) return
    openInstance?.close()
    open = true
    highlighted = Math.max(0, selectedIndex())
    list.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    openInstance = api
    paintList()
  }

  /** Commits `next` and notifies. Choosing what is already chosen is a no-op. */
  const commit = (next) => {
    close({ focus: true })
    if (next === undefined || next === current) return
    current = next
    paintTrigger()
    paintList()
    host.dispatchEvent(new Event('change', { bubbles: true }))
  }

  trigger.addEventListener('click', () => (open ? close({ focus: true }) : show()))

  trigger.addEventListener('keydown', (event) =>
    handleTriggerKey(event, {
      isOpen: () => open,
      close,
      show,
      cancel: () => close({ focus: true }),
      move: (key) => {
        highlighted = nextIndex(highlighted, key, items.length)
        paintList()
      },
      commit: () => commit(items[highlighted]?.value),
    }),
  )

  list.addEventListener('click', (event) => {
    const li = event.target.closest('.dd-option')
    if (!li) return
    commit(items[[...list.children].indexOf(li)]?.value)
  })

  // A <label for> cannot target a div, so the visible label lost the
  // click-to-focus its three siblings in the modal still have. Restored by hand
  // rather than by markup, because there is no markup that does it.
  labelElement?.addEventListener('click', () => trigger.focus())
  if (labelElement) labelElement.style.cursor = 'default'

  const onOutside = (event) => {
    if (!open || host.contains(event.target)) return
    close()
  }
  document.addEventListener('pointerdown', onOutside)

  const api = {
    close,
    setOptions(next) {
      items = next.map((o) => ({ value: o.value, label: o.label }))
      paintTrigger()
      paintList()
    },
  }

  Object.defineProperty(host, 'value', {
    configurable: true,
    get: () => current,
    set: (next) => {
      current = next
      paintTrigger()
      paintList()
    },
  })

  host.setOptions = api.setOptions
  api.setOptions(options)
  return host
}
