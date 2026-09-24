# The Docket protocol, for a project that uses it

Copy this file into a project you have adopted with `docket init`, as its `CLAUDE.md` or
appended to the one already there. It is written to be pasted, and it is addressed to the
coding agent rather than to you.

Everything below is the working agreement. It is not a description of the tool; the tool is
seven MCP tools that are already available. This is what they mean.

---

## The board is shared state, not a report

This project has a board at `.docket/board.json`. The owner opens it in a browser and drags
cards. You read and write the same file through `docket_board`, `docket_add`,
`docket_update`, `docket_note`, `docket_delete` and `docket_projects`.

It is one document that two parties annotate. It is **not** a place to file status updates
for a human to read later, and not a second backlog that drifts from the real one.

Practical consequences:

- **Read the board before proposing work.** The answer to "what should I do next" is on it.
- **Write back what you verified**, not what you intend. A note saying a thing works, when
  no one ran it, is worse than no note.
- **The file is authoritative.** Not your memory of it, and not a summary from earlier in
  the session. Re-read it if time has passed.

## The columns

`Inbox · Waiting on you · Up next · In progress · Loop · In review · Done`

Two have rules rather than meanings:

- **Waiting on you** is where anything needing the owner's judgment goes. Moving a card
  there with a clear question is always a correct action, and usually better than guessing.
- **Loop** is the unattended queue. See below. It is the only column that authorizes
  anything.

## Loop: the one authorization

**The owner putting a card into Loop is what authorizes you to work it unattended.** There
are exactly two ways they can do that: dragging an existing card in, or pressing `[+]` on
the column and then committing the draft with **Add card**. Nothing else grants it.

**Never move a card into Loop yourself** — not to queue your own idea, not to re-file
something that failed. The column you would be writing into *is* the authorization, so
writing into it is not a way to earn it.

### Before working anything, triage the whole column

Ten minutes of triage is the cheapest insurance available. The failure that costs a night is
not a thin card; it is working a thin card confidently for four hours and building the wrong
thing.

`docket_board` reports a `brief` on every Loop card, so this is mechanical:

- `brief.complete === false` → **move it to Waiting on you now**, with a note naming what is
  missing. `brief.missing` says which headings. Do not start it.
- **Apply the stub test to every clause:** *could a stub pass this?* "Build a calculator,
  verified by 7×8×9" gets you a bare multiplier, because a bare multiplier passes. A clause
  a stub could satisfy is a thin clause. Say so and escalate, even when you are confident
  you know what was meant.
- A card needing the owner's taste or a product ruling is not a Loop card even with a
  perfect brief. Escalate it and say why.

Escalating three of five cards and finishing two properly is a good night. Finishing five
wrongly is not.

### The contract

Two headings are required, and the reasons are not bureaucratic:

| Heading | Why |
|---|---|
| `Acceptance` | Without it there is no way to know when to stop |
| `Verify with` | Without it, "done" is a guess |

`Objective`, `Must not break`, `Pointers` and `If blocked` are optional. Keep `Pointers` a
map, never a design: if it starts reading like an implementation, the card has stopped being
tight on the outcome and loose on the route.

### While working

| Rule | Why |
|---|---|
| **Work on a branch. Never the default branch** | The run ends at review-requested: push the branch, open a PR with the verdict attached, never merge |
| **One card at a time, top of the column down** | The order is the owner's priority. Do not cherry-pick the easy one |
| **Three strikes, then stop** | Fail the same card three times and it goes to Waiting on you with what you tried. Six hours re-running one broken approach is the failure mode to design against |
| **Ambiguity escalates, never guesses** | A wrong guess at 2am costs more than a morning's wait |
| **Re-read the card's notes between steps** | The owner can steer a running task by adding a note. A corrective sentence is cheap; a killed run wastes the night |
| **A blocker escalates and stops** | An expired credential at 1am is a real event. Note it, move on, do not thrash. Silence is not a terminal state |
| **Every card gets a note before you leave it** | What you did, what you did not, what you would want decided. Lead with one sentence someone can triage from on a phone, then a blank line, then the rest — the board shows only the first paragraph until asked |

## Never grade your own work

When a card's work is done, spawn the **`docket-verifier`** subagent and let it rule. It has
fresh context, no edit tools, re-runs the `Verify with` command itself, checks each
`Acceptance` clause independently, and writes a `VERDICT: meets | fails` note to the card.

- **meets** → it moves the card to *In review*.
- **fails** → the card stays in Loop with what would change the verdict.

This is not ceremony. An agent that both builds and judges will report its own work as done,
confidently, and be wrong. In an unattended run there is nobody to notice. Separate context,
separate incentives, adversarial by construction.

Spend on the gate rather than the worker. A cheap builder with a rigorous judge beats the
reverse; a weak judge is the false economy, because it rubber-stamps work that only looks
finished.

**The verdict is still not approval. The owner merges. Always.**

## Attachments and living people

Cards can carry pasted screenshots, and the point of them is that you can see what the owner
sees. **Reading an attachment is a model prompt.** A screenshot of someone's family tree,
medical record or private correspondence will often show real people who did not consent to
that.

Not a prohibition — it is the owner's machine and their decision to paste. But it is a
decision, so: **do not reflexively read every attachment on every card.** Read one when the
work actually needs it, and say that you are doing so.

## What this file does not need to repeat

The project's own `CLAUDE.md`, its git history, its test suites and its README. Read those
anyway. This file exists for what is *not* derivable from them.
