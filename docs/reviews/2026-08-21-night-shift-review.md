# Review — "The Night Shift", Phil McDonald, AI Builder Day 2026

**2026-08-21.** Source: `atlas/docs/phil-ai-builder-presentation.html`. A colleague's talk
on running agent fleets overnight. The owner asked what was worth taking. This records the
verdict on each idea, including the ones refused — a future session should not re-litigate
them, and should not assume everything in the talk was adopted.

## Adopted

| Idea | What it became here |
|---|---|
| **Contracts, not wishes or designs** — tight on the outcome, loose on the route | The Overnight brief became a contract: `Objective / Acceptance / Verify with / Must not break / Pointers / If blocked`. `board/ui/brief.js` |
| **Producer ≠ critic**, separate context, adversarial | `.claude/agents/docket-verifier.md`. The gap this closed was real and structural — see below |
| **Nothing advances on a claim** — the gate re-runs firsthand | The verifier runs the `Verify with` command itself and has no edit tools, so it cannot make the work pass |
| **"If a stub can pass your eval, your eval is the bug"** | The stub test is now an explicit pre-flight question and a prompt on the `Acceptance` heading |
| **Runs end at review-requested** | Upgraded from "branch, never push". A branch on disk is easy to ignore; a PR carrying the verdict is a morning artifact |
| **Barge in, don't kill** | Re-read the card's notes between steps. The note thread was already the channel — this cost one protocol line and no code |
| **Spend on the gate, not the worker** | Recorded in the protocol. A weak judge is the false economy: it rubber-stamps costume work |
| **No quotas** — "fix at least 20 things" invites padding | Folded into the contract guidance: state the end state, not a count |
| **Escalate and stop; silence is not terminal** | Already the rule, but his 1am example is *an expired credential*, which is a live failure mode here — the credentials this author's day-job tooling needs expire in normal use |
| **Deterministic-check density is the autonomy ceiling** | Recorded as a strength rather than a change. the author's largest project has 409 unit tests, 102 browser assertions and a typecheck, all runnable without a deploy; Docket has 127 + 30 + 55. His seven-weeks-lost-to-deploys failure is not the shape of these projects |

### Why the gate mattered most

Before this review the loop was: Claude builds, Claude runs the tests, Claude writes the note
saying it is done. Same context producing and grading — exactly the failure the talk names, and
which it reports four independent teams reached at the same conference.

It is not hypothetical. On 2026-08-21 Claude reported the modal's auto-grow as working when
every field was collapsed to 11px, and described the tag palette as muddy when the computed
styles said otherwise. Both were caught by *measuring* — an act separate from the one that
produced the claim. Overnight there is nobody to do that.

## Adapted rather than copied

- **"Stop reading code."** Adopted only with atlas's carve-out named. The talk gives one —
  auth, money, permissions, irreversible data — and atlas's version is specific: the
  living-persons guard, the evidence ledger, anything touching `/api/narrate` or
  `buildFactSheet`. Those get read by the owner every time. The default flips everywhere else.
- **`Where` and `Don't` headings.** The talk's critique of over-specifying the route applies to
  the first version of this project's own template: two of six headings were prescribing
  implementation. `Where` became `Pointers` (a map, explicitly not a design) and `Don't` became
  `Must not break` (an outcome, not a route).

## Refused, and why

- **Fleets and waves grouped by file ownership.** Solves parallel agents colliding on files.
  One operator working one card at a time does not have that problem, and importing the
  machinery would add coordination cost for no gain. Revisit only if cards ever run in parallel.
- **Agents acting as the owner, under the owner's name.** The talk is honest that this is a
  stopgap forced by tools that only understand human accounts. Docket does not need it: commits
  carry `Co-Authored-By`, which is honest provenance rather than impersonation.
- **The impossible deadline, throwing away your best work, the four dares.** Culture, not
  machinery. Nothing to build; noted and left to the owner.
- **A shared human+agent meeting workspace.** Depends on a team of twelve. The board plus the
  capture bot already carry the two-participant case.

## The scale caveat worth remembering

The talk describes twelve engineers, a shared agent workspace, and fleets running waves. Docket
serves one operator and one AI. Most of the value transferred anyway, because the transferable
part is **contracts and the gate** — verification discipline, not fleet management. Anything in
the talk that scales *throughput* by adding agents should be read with that mismatch in mind.
