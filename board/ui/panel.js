/**
 * The card panel: its markup, its element map, and the wiring that turns both
 * into a live modal. ONE copy, mounted by whichever page needs it.
 *
 * It used to be 84 lines of markup inside index.html, which was fine while the
 * board was the only page with a modal. The time dashboard now opens a card
 * from its session log, and two hand-kept copies of 35 identified elements
 * would have drifted the way this project already refuses elsewhere —
 * tag-color.js and brief.js are shared with the server for the same reason.
 *
 * modal.js is untouched and still queries nothing: it is handed an element map
 * and callbacks. This module is what builds that map, so the ids live in one
 * place and a page cannot mis-spell one.
 */
import { createDropdown } from './dropdown.js'
import { createModal } from './modal.js'

/** The markup, verbatim as it stood in index.html. */
export const PANEL_HTML = `
<div id="overlay" hidden>
  <div id="panel" role="dialog" aria-modal="true" aria-labelledby="f-title">
    <p id="f-gone" class="gone-banner" role="alert" hidden>This card was deleted or moved to another board. Nothing here saves any more — copy what you need, then close.</p>
    <label class="micro" for="f-title">Title</label>
    <textarea id="f-title" rows="1" class="grow title-field"></textarea>

    <label class="micro" for="f-detail">Detail</label>
    <textarea id="f-detail" rows="1" class="grow"></textarea>
    <details id="f-contract" class="brief-guide contract"></details>

    <div class="panel-row">
      <div class="panel-col">
        <span class="micro" id="f-column-label">Column</span>
        <div id="f-column"></div>
      </div>
      <div class="panel-col" id="f-board-wrap">
        <span class="micro" id="f-board-label">Board</span>
        <div id="f-board"></div>
      </div>
      <label id="f-flag-wrap" class="flagwrap">
        <input type="checkbox" id="f-flag" />
        <span class="micro">Priority</span>
      </label>
    </div>
    <div class="panel-row tags-row">
      <div class="panel-col">
        <label class="micro" for="f-tags">Tags</label>
        <div id="f-tags-chips"></div>
        <input id="f-tags" type="text" list="tag-options" placeholder="Add a tag, Enter" />
        <datalist id="tag-options"></datalist>
      </div>
    </div>
    <div class="panel-row">
      <div class="panel-col">
        <label class="micro" for="f-estimate">Estimate</label>
        <input id="f-estimate" class="field-input" type="number" min="0" step="5" inputmode="numeric" placeholder="minutes" />
      </div>
      <div class="panel-col">
        <label class="micro" for="f-due">Due</label>
        <input id="f-due" class="field-input" type="date" />
      </div>
    </div>

    <div class="notes-head" id="f-time-wrap">
      <span class="micro">Time <span id="f-time-total" class="dim"></span></span>
      <span class="time-actions">
        <button id="f-time-add" class="micro" type="button">Add time</button>
        <button id="f-time-toggle" class="micro" type="button">Start</button>
      </span>
    </div>
    <form id="f-time-form" class="time-form" hidden>
      <label class="micro">Date <input id="f-add-date" type="date" required /></label>
      <label class="micro">Start <input id="f-add-start" type="time" required /></label>
      <label class="micro">Stop <input id="f-add-stop" type="time" required /></label>
      <label class="micro">Minutes <input id="f-add-minutes" type="number" min="1" step="1" inputmode="numeric" /></label>
      <label class="micro time-form-note">What was done <input id="f-add-note" type="text" placeholder="optional" /></label>
      <span class="time-form-foot">
        <button id="f-add-save" class="micro" type="submit">Save</button>
        <button id="f-add-cancel" class="micro" type="button">Cancel</button>
        <span id="f-add-error" class="micro warn" role="alert"></span>
      </span>
    </form>
    <div id="f-time-log"></div>

    <div class="notes-head">
      <span class="micro">Attachments</span>
      <span id="f-drop-hint" class="micro dim">paste or drop an image</span>
    </div>
    <div id="f-attachments"></div>

    <div class="notes-head">
      <span class="micro">Notes</span>
    </div>
    <div id="f-notes"></div>
    <textarea id="f-new-note" rows="1" class="grow"></textarea>
    <span class="note-compose-foot">
      <button id="f-note-add" class="micro" type="button">Save</button>
      <button id="f-note-cancel" class="micro" type="button">Cancel</button>
    </span>

    <div class="notes-head" id="f-todo-head">
      <span class="micro">Todos <span id="f-todo-count" class="dim"></span></span>
    </div>
    <div id="f-todos"></div>
    <input id="f-new-todo" type="text" class="field-input" placeholder="Add a todo…" />
    <span class="note-compose-foot">
      <button id="f-todo-add" class="micro" type="button">Add</button>
      <button id="f-todo-cancel" class="micro" type="button">Cancel</button>
    </span>

    <div class="notes-head">
      <span class="micro">Source</span>
    </div>
    <div id="f-origin" class="source-line"></div>

    <div class="foot">
      <button id="f-delete" class="danger micro">Delete card</button>
      <button id="f-close" class="micro">Close</button>
    </div>
  </div>
</div>`

/**
 * Put the panel in the document, once. Idempotent, so a second call on a page
 * that already has it is not an error and does not produce duplicate ids.
 */
export function injectPanel(parent, doc = document) {
  if (doc.getElementById('overlay')) return
  const holder = doc.createElement('div')
  holder.innerHTML = PANEL_HTML
  // Append the children, not the holder: an extra wrapper around #overlay
  // would sit inside the flex body and the CSS positions #overlay itself.
  ;(parent ?? doc.body).append(...holder.children)
}

/**
 * Every element modal.js asks for, by the ids in PANEL_HTML. Named here rather
 * than at each call site, which is what stops a page from wiring 34 of 35.
 */
export function panelElements(doc = document) {
  const byId = (id) => doc.getElementById(id)
  return {
    overlay: byId('overlay'),
    panel: byId('panel'),
    attachments: byId('f-attachments'),
    dropHint: byId('f-drop-hint'),
    title: byId('f-title'),
    detail: byId('f-detail'),
    contract: byId('f-contract'),
    column: byId('f-column'),
    board: byId('f-board'),
    boardWrap: byId('f-board-wrap'),
    timeWrap: byId('f-time-wrap'),
    timeTotal: byId('f-time-total'),
    timeToggle: byId('f-time-toggle'),
    timeLog: byId('f-time-log'),
    timeAdd: byId('f-time-add'),
    timeForm: byId('f-time-form'),
    addDate: byId('f-add-date'),
    addStart: byId('f-add-start'),
    addStop: byId('f-add-stop'),
    addMinutes: byId('f-add-minutes'),
    addNote: byId('f-add-note'),
    addSave: byId('f-add-save'),
    addCancel: byId('f-add-cancel'),
    addError: byId('f-add-error'),
    estimate: byId('f-estimate'),
    due: byId('f-due'),
    flag: byId('f-flag'),
    tagChips: byId('f-tags-chips'),
    tagInput: byId('f-tags'),
    notes: byId('f-notes'),
    newNote: byId('f-new-note'),
    noteAdd: byId('f-note-add'),
    noteCancel: byId('f-note-cancel'),
    todos: byId('f-todos'),
    todoHead: byId('f-todo-head'),
    todoCount: byId('f-todo-count'),
    newTodo: byId('f-new-todo'),
    todoAdd: byId('f-todo-add'),
    todoCancel: byId('f-todo-cancel'),
    origin: byId('f-origin'),
    deleteButton: byId('f-delete'),
    commit: byId('f-close'),
    gone: byId('f-gone'),
  }
}

/**
 * Inject the markup, build the two dropdowns, and return the modal. The order
 * matters and is the reason this is one function: the elements have to exist
 * before the dropdowns replace two of them, and both before createModal binds
 * its listeners.
 *
 * \`projects\` gives the Board dropdown its options; pass an empty array and the
 * control is still built, showing only this board — moving needs the list.
 */
export function mountPanel({ config, project, projects = [], ...handlers }) {
  injectPanel()
  createDropdown(document.getElementById('f-column'), {
    label: 'Column',
    labelElement: document.getElementById('f-column-label'),
    options: (config.columns ?? []).map((column) => ({ value: column.key, label: column.name })),
  })
  createDropdown(document.getElementById('f-board'), {
    label: 'Board',
    labelElement: document.getElementById('f-board-label'),
    options: projects.map((entry) => ({ value: entry.slug, label: entry.name })),
    value: project,
  })
  return createModal({ elements: panelElements(), config, project, ...handlers })
}
