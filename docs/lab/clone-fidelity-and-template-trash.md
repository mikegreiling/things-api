# CLONE — clone-fidelity matrix + minted-clone promote-fate + template-trash semantics

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00.** Ran in ONE disposable clone `clone-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v2 already carries the baked **L3-accessibility** grant (`auth_value=2`), so the ui-vector (native promote / make-repeating) drove via System Events over SSH with **no VNC step**. Ground truth = guest Things-DB row deltas (read-only SQLite; every recurrence + content column captured) driven through the **production CLI** (guest e2e bundle: node + dist + commander). Branch `mg/clone-probes`. Script: [`lab/scripts/research-clone.sh`](../../lab/scripts/research-clone.sh). Artifacts (gitignored): `lab/artifacts/clone-lab/` (`report.txt`, per-case `snaps/*.json`, `drive-*.log`).

This campaign gathers the evidence gating the ratified **promote-via-clone** direction — reimplementing promote-to-repeating as `clone(X) → native-promote(the pristine clone) → trash(X)` (recoverable, deterministic) plus first-class `todo clone` / `project clone`. **No implementation, no doctrine here — evidence only.**

> **Decoder caveat (read before trusting any timestamp in the raw report).** This campaign's ad-hoc `report.txt`/`fidcmp.py`/`diff_snaps.py` decoders apply the Cocoa-2001 offset (`+978307200`) to `creationDate`/`stopDate`/`userModificationDate`, but those columns are **unix-epoch seconds** in schema v26 (shipped [`src/model/dates.ts`](../../src/model/dates.ts) `decodeEpochReal` = "Unix seconds"). So every `creationDate`/`stopDate` **label** in the raw report reads ~31 years high (e.g. `2057-07-05` = the real `2026-07-05`). The **raw integer values are authoritative** and are what every verdict below rests on (e.g. `stopDate=1783087200` = `2026-07-03T14:00Z`, `creationDate=1781514000` = `2026-06-15T09:00Z`). Packed-date columns (`startDate`/`deadline`/`nextInstanceStartDate`, `y<<16|m<<12|d<<7`) decode correctly. This is a harness-decoder artifact ONLY; it did not touch any create/verify path.

---

## Worklist A — clone-fidelity matrix

**Question:** which source fields can be faithfully reproduced onto a fresh item using ONLY official write surfaces (`things:///json` import / URL scheme / AppleScript / existing CLI)? Method: mint a SOURCE carrying the field, mint a CLONE reproducing it through the best-fidelity surface, byte/structure-diff the rows allowing only the expected deltas (uuid, `index`, `todayIndex`, `userModificationDate`, and `creationDate` when not backdated). Each pair uses distinct titles (so both resolve by unique name), so `title` — and, for children in parallel containers, the `project` FK — always show as *expected* DIFFs; the fidelity signal is every OTHER content column matching.

| # | Field / source shape | Surface used for the clone | Verdict | Evidence |
|---|---|---|---|---|
| A1 | title · notes · tags(×2) · deadline · when=today · **reminder 09:30** | `todo add --notes --tags --deadline --when today --reminder` | **CLONABLE** | all content cols + tag set match (`reminderTime`, `deadline`, `startBucket`, `start`, `startDate` identical) |
| A1b | when=**evening** (`startBucket=1`) | `todo add --when evening` | **CLONABLE** | `startBucket=1`/`start`/`startDate` match |
| A1c | when=**someday** | `todo add --when someday` | **CLONABLE** | `start=someday` matches |
| A2 | checklist items (a,b,c) with **b completed** | `todo add --checklist-item …` (birth) | **CLONABLE-WITH-CAVEAT** | items born ALL-OPEN (`[('a',0),('b',0),('c',0)]` vs source `('b',3)`) — the **completed state is NOT birthable**; a follow-up `todo checklist --check b` reproduces it exactly (post-check → MATCH). No atomic-birth surface for a pre-checked item. |
| A3 | **backdated `creationDate`** | `todo add --created-at <iso>` | **CLONABLE** (minute resolution) | A3's own cell was contaminated by a harness ISO-derivation bug (passed a `2057` date → `verify-failed:mismatch`); **independently proven by B1/B3**, whose `--created-at 2026-06-15T09:00` landed `creationDate=1781514000` = exactly `2026-06-15T09:00Z`. Caveat: ISO input resolves to the minute; sub-second `creationDate` precision is lost. |
| A4 | project: headings + child-under-heading + area + notes + deadline | `things:///json` import | **CLONABLE** | project row content + heading + child structure reproduce identically. Note: a child spec with no `heading` placed AFTER a heading in the json item list **inherits the preceding heading** (both source and clone put "CL-A4-direct" under CL-H1) — to reproduce a true project-root child alongside a headed one, order the root child BEFORE any heading. |
| A5 | project: open + **completed(`--completed-at`)** + **canceled** children | json import → `todo complete --completed-at` / `todo cancel --completed-at` | **CLONABLE-WITH-CAVEAT** | each terminal child reproduces `status` + `stopDate` **exactly** (done `status=3 stopDate=1783087200`=2026-07-03T14:00; cancel `status=2 stopDate=1783173600`=2026-07-04T14:00). Caveat: a MIXED project (open + logged children) can NOT be born via one atomic import (§5b reopen), so logged children need post-creation `complete`/`cancel --completed-at` legs. |
| A6 | **SPECIAL: project with a live nested repeating to-do (template)** | json import (best-effort) | **UNCLONABLE (faithfully)** | make-repeating on the nested child replaced its uuid and left a `rt1_recurrenceRule` **template** row + an instance inside the project. json import cannot carry `rt1_recurrenceRule` (a private plist, settable only via the make-repeating GUI, which mints a NEW series identity + spawns an instance). Best-effort clone = a single **plain** to-do (`rule=0 tmpl=None`) — recurrence LOST. |
| A7 | **SPECIAL: logged source item** (born-logged) | `todo add --completed-at` | **CLONABLE** | atomic born-logged; `status=completed`, `stopDate` + `creationDate` reproduce exactly (src=clone). |
| A8 | **SPECIAL: source in the Trash** | `todo add` → `todo delete` | **CLONABLE-WITH-CAVEAT** | no born-trashed surface; content reproduces then `todo delete` sets `trashed=1` (both match). |

**Clonable-field summary (to-do):** title, notes, tags, deadline, all `when` stages (today/evening/someday/date), reminder time, checklist item titles, `creationDate` (via `--created-at`, minute res), completed/canceled terminal state (via `--completed-at`), trashed state (via post-`delete`). **Project adds:** headings, children (headed + root), area membership, logged/canceled children. **Requires-a-follow-up-leg (CLONABLE-WITH-CAVEAT):** a pre-checked checklist item, logged children in a mixed project, a trashed clone. **UNCLONABLE:** a nested repeating template (`rt1_recurrenceRule`) inside a project — the one field a `project clone` must **refuse or best-effort-flag**, naming "source subtree contains a repeating template; its recurrence rule cannot be reproduced on any official write surface."

---

## Worklist B — promote fate on MINTED (backdated) clone-shaped rows

**Question:** do the RSIM source-fate laws hold unchanged on rows WE minted with a backdated `creationDate` (`--created-at 2026-06-15T09:00`), i.e. does backdating/cloning perturb the fate axis? And does the shipped template-uuid discovery bind after each native promote (`make-repeating --dangerously-drive-gui`)?

| Case | Minted subject (backdated) | Expected (RSIM) | Observed source fate | Template bound? |
|---|---|---|---|---|
| B1 | bare to-do | DELETE (RSIM1) | **DELETED** (`exists=0`) | returned `templateUuid` == the live `rt1_recurrenceRule` row ✓ |
| B2 | deadline-carrying to-do | PRESERVE (RSIM-T) | **PRESERVED-as-instance** (`exists=1`, `rt1_repeatingTemplate` set to the new template) | ✓ |
| B3 | project, plain OPEN children | DELETE (RSIM-R) | **DELETED** (`exists=0`) | ✓ |
| B4 | project, all-TERMINAL children (1 completed + 1 canceled) | PRESERVE (RSIM-U) | **PRESERVED-as-instance** (`exists=1`, relinked) | ✓ |

**Verdict: the RSIM-R / RSIM-T / RSIM-U / RSIM1 source-fate laws hold BYTE-FOR-BYTE on minted, backdated rows — backdating and cloning do NOT perturb the fate axis** (fate keys on deadline / open-child-presence, not on creation date or provenance), and the shipped `repeating` block (`templateUuid`/`instanceUuid`/`replacedUuid`) binds correctly after every drive. This is the green light for the compound op: promoting a *pristine backdated clone* behaves exactly as promoting a naturally-created item. Re-confirms RSIM-R/T/U under golden-v2 / 3.22.12 on minted rows (rsim-results.md is the immutable original evidence; this is a fresh confirmation, not an amendment).

---

## Worklist C — trash-a-repeating-template semantics (the undo story for clone-promote-trash)

**Question:** with minted templates (fixed AND after-completion; to-do AND project), what happens to the rule / current instance / series when the TEMPLATE is trashed via each official surface; do existing guards refuse; is a trashed template restorable; and what happens when only the INSTANCE is trashed?

### C1–C4 — trashing the TEMPLATE

| Case | Kind / mode | Shipped `delete` on the template | App-level fate (where it landed) | Restore |
|---|---|---|---|---|
| C1 | to-do / fixed | **REFUSED** `blocked:H-REPEAT-SCHEDULE` (zero delta) | — (guard blocked) | `restore` refused `H-UNKNOWN-DESTINATION` (not trashed) |
| C2 | to-do / after-completion | **REFUSED** `blocked:H-REPEAT-SCHEDULE` (zero delta) | — (guard blocked) | — |
| C3 | project / fixed | **SUCCEEDED** (`project.delete` → AS delete; guard did NOT fire) | template `trashed 0→1`; `rt1_recurrenceRule` **RETAINED**; `rt1_nextInstanceStartDate` **CLEARED** (2026-07-12 → None); the live **instance left ORPHANED** (`trashed=0`, `rt1_repeatingTemplate` FK still dangling to the trashed template — NOT cascade-trashed) | **FAILED** `verify-failed:silent-noop` — `project restore` (AS `move … to Inbox`) errors **301 "Cannot move to-do"** on a trashed template-project; template stays trashed |
| C4 | project / after-completion | **SUCCEEDED** (guard did NOT fire) | template `trashed 0→1`; rule RETAINED; (`next` already None for AC); instance ORPHANED, live | **FAILED** 301, same as C3 |

**Two decision-shaping findings:**

1. **Guard kind-asymmetry (things-api coverage gap).** The `H-REPEAT-SCHEDULE` guard — whose own message says "status/move/**delete** on templates are unvalidated" — fires for `todo.delete` on a template (C1/C2 refused, fail-closed) but is **absent from `project.delete`** (C3/C4 sailed through and trashed the project template). So through the shipped CLI, a to-do template is delete-protected while a **project template is freely trashable** into a broken state. This is a guard-coverage gap, not app behavior — the undo design must decide whether to (a) extend the guard to `project.delete` and route series-removal through a dedicated validated primitive, or (b) deliberately open a guarded template-trash path. (Recorded in up-next; no fix in this evidence-only campaign.)

2. **Trashing a project template breaks the series and is NOT round-trippable via the shipped surfaces.** It clears the fixed template's next-instance cursor, leaves the current occurrence orphaned-but-live (a dangling `rt1_repeatingTemplate` FK the reader still counts as a live instance), and cannot be un-trashed by `project restore` (AS move-to-Inbox → **error 301**). This extends the known template move-trap (oddities §8k / §RSIM-P S-R3, where move-to-Anytime and template-CHILD un-trash both 301) to the **trashed-template-project row itself**. So "remove the minted series" for the undo of clone-promote-trash cannot be a naive `delete` — it needs to trash the template AND its instance together and cannot rely on `restore` to reverse it.

The **to-do-template raw-app trash fate remains unprobed** (the shipped guard blocked it, and the single-clone budget precluded a raw-AS bypass mid-run) — a documented residual; the project-template behavior (C3/C4) is the representative pattern.

### C5 — trashing ONLY the INSTANCE (fixed to-do series)

`todo delete <instance>` **SUCCEEDED** (instances carry no template guard): instance `trashed 0→1` **and `start 2→1`** (trash de-schedules — the current-occurrence Today/scheduled bucket collapses to anytime), while the **template is UNTOUCHED** (`trashed=0`, `rt1_recurrenceRule` intact, `rt1_instanceCreationCount=1`, cursor intact). `Show-Latest live instances` for the template → **0** (the occurrence leaves the live/read set). So for a **fixed** series, trashing the instance is the clean, template-preserving operation: the series survives to spawn the next occurrence on schedule, and the removed occurrence sits recoverable in Trash. (Contrast the known after-completion behavior, oddities §RSIM-S / sl2 Q2: trashing an AC *instance* is treated as a **completion** and self-advances the series — a fixed-instance trash does NOT advance.)

**Undo-story conclusion (evidence, not doctrine):** the `trash(X)` leg of clone-promote-trash trashes a **plain** original (unguarded, restorable — clean). Its inverse `restore(X)` is clean for a plain row. Removing the minted series (the other half of undo) is the hard part: it must trash **both** the minted template and its instance, is **guard-blocked for to-do templates** and **guard-open-but-lossy for project templates** (orphaned instance, cleared cursor, non-restorable). This argues for a **dedicated, validated series-removal primitive** rather than reusing generic `delete`/`restore`, and for reconciling the `H-REPEAT-SCHEDULE` guard across kinds.
