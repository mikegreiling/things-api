# UMDZ1 — what the app's own ⌘Z does to `userModificationDate`

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · one airgapped clone, guest clock pinned **2026-07-05 12:00** and **never rolled** (nothing here needs a clock advance, so [the trial wall](harness.md) is not in play) · AXVM1 accessibility grant baked. Campaign run 2026-08-28, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-umdz1.sh`](../../lab/scripts/research-umdz1.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone, `FIXTAG=<n>` suffixes the fixture titles so a retry on the same clone cannot collide). Fixtures fully synthetic (`UMDZ1-*`). Artifacts: `lab/artifacts/umdz1-lab/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, AX dumps in `ax/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field. "No field changed on any surviving row" means all 41 columns compared, not a spot check. Each cell additionally prints the `umd` triple the verdict rests on — before the edit, after the edit, after the undo — beside the guest wall clock, and the fixture is **aged 25 s either side of the edit** so RESTORED (`umd_after_undo == umd_before`) and RE-STAMPED (`umd_after_undo ≈ now`) can never be confused for one another.

## Why this was asked

`--preserve-modified` (shipped 2026-08-13) captures a row's pre-write `umd`, performs the write, and restores the captured value — keeping a bulk edit off the `changes`/watch timeline. Its **undo** half restores those captured values after the inverse legs land. That half was ratified on design grounds ([decisions](../design/decisions.md), 2026-08-13) but had never been checked against the app: if the app's own undo *re-stamps* `umd`, then our restoring undo is the odd one out, and the maintainer's standing instruction is to **base the implementation on the app's own behavior**.

[REPX3 §4.2](repx3-chooser-residuals.md) had seen a `umd` rewind once, but on the wrong subject to settle it: the row was a repeat **template**, the gesture was `Update Rule`, and the cell was about cursor columns. This campaign isolates `umd` on **ordinary to-dos** across three edit classes, plus the prerequisite nobody had measured either — whether a write *we* ship is even in the app's undo stack.

---

## 0. Headline

1. **⌘Z RESTORES `userModificationDate` — to the microsecond, not to the second.** On a completion (§2) and on a move-to-trash (§3) the undo returns `umd` to *exactly* its pre-edit value, the full stored float. Both are durable across a relaunch, and both net to *no field changed on any surviving row* against the pre-gesture snapshot. **The app models an undo as a restoration of the record, not as a fresh compensating edit** — which is precisely what our symmetric restore does, so the shipped behavior is confirmed as native parity.
2. **The one measured divergence is resolution, and it is on the safe side.** The app restores the sub-second fraction; our AppleScript `set modification date` restore lands on `floor(preUmd)` (the AS `date` type has no sub-second — the documented 1-second floor). Ours is therefore always **≤** the app's, which is the safe direction for a `changes --since` query: a restored row never re-surfaces.
3. **Our writes are NOT in the app's undo stack** (§1). A URL-scheme `update` on a to-do, dispatched while Things is frontmost, bumps `umd` and changes the title — and `Edit ▸ Undo` stays **disabled**, with ⌘Z inert across all 41 columns. So the app's undo can never *be* our undo; native parity has to be **mirrored**, which is what the code does.
4. **Not everything the app does is undoable, and the split is not where you would guess.** A completion and a trash are undoable; a **title rename is not**, once the row is closed (§4). The rename is not even *written* until the card closes — while the card is open the DB still holds the old title and ⌘Z is the text editor's own undo, discarding the buffer (§5). Recorded as [oddities §28](../things-app-oddities.md).

---

## 1. Cell U0 — is a write we ship in the app's undo stack?

The control matters here: the app was quit and relaunched first, so the undo stack is empty and the pre-gesture menu read is a known negative.

```
Edit menu (fresh launch, before any gesture — the negative control):
  Undo  enabled=false
  Redo  enabled=false

things:///update?id=6UrBP8W9…&title=UMDZ1-U0B-URL-EDITED

  CHANGED 6UrBP8W9.title:                UMDZ1-U0B-URL -> UMDZ1-U0B-URL-EDITED
  CHANGED 6UrBP8W9.userModificationDate: 1783253043.277886 -> 1783253073.918445

Edit menu (after the URL-scheme update):
  Undo  enabled=false                    <- the write registered NOTHING

⌘Z:  (no field changed on any surviving row)
     (rows in both: 1; fields compared: 41)
```

> **A URL-scheme write lands in the database and leaves no undo entry behind.** The app's undo tracks the app's *own* gestures, not mutations arriving over the URL scheme.

This is the load-bearing negative for the design question. Delegating our undo to ⌘Z was never on the table anyway (headless, no keystroke surface, and it would undo whatever the *user* last did), but it also cannot work in principle: there is nothing there to undo. The measurement below is therefore a **behavioral target to mirror**, and that is exactly how the code uses it.

---

## 2. Cell U2 — a completion, then ⌘Z (the load-bearing cell)

Fixture created via the URL scheme, then the app quit and relaunched so the ageing is real elapsed time and nothing from the `add` is in the stack. Completion driven by a `CGEventPost` click at the row checkbox's AX frame ([REPX1](repx1-instance-semantics.md)'s live vector, with [CNCAC1](cncac1-after-completion-checkoff.md)'s off-screen guard).

```
gesture:  clicked Checkbox @354,207
  CHANGED EaD2Gert.status:               0 -> 3
  CHANGED EaD2Gert.stopDate:             None -> 1783253395.11078
  CHANGED EaD2Gert.userModificationDate: 1783253326.578821 -> 1783253395.111023

Edit menu (after the completion):
  Undo  enabled=true                     <- undoable, unlike the URL write

⌘Z:
  CHANGED EaD2Gert.status:               3 -> 0
  CHANGED EaD2Gert.stopDate:             1783253395.11078 -> None
  CHANGED EaD2Gert.userModificationDate: 1783253395.111023 -> 1783253326.578821

UMD TRIPLE  before=1783253326.578821  after-edit=1783253395.111023  after-undo=1783253326.578821
            the edit moved umd by +68.5s; the undo moved it by -68.5s
VERDICT: RESTORED — the undo rewound umd to its exact pre-edit value

relaunch: (no field changed on any surviving row)
NET vs the pre-gesture snapshot: (no field changed on any surviving row)
```

> **`1783253326.578821` goes out and `1783253326.578821` comes back.** Not `floor()` of it, not a value one second away — the stored float, digit for digit. An undo that merely *reversed the effect* would leave a fresh `umd` behind; this one restores the row.

The guest clock ran ~118 s past the pre-edit stamp by the time the post-undo read was taken, so a re-stamp would have been unmistakable.

---

## 3. Cell U3 — a move to trash, then ⌘Z

A second, structurally different edit class — and one whose forward direction our own `todo.delete` shares.

```
Items menu (for the record — the delete-class item is NOT here):
  When… | Move… | Tags… | Deadline… | Complete | Shortcuts | Repeat… | Get Info |
  Convert to Project… | Remove From Parent | Remove From Contact | Reveal in List |
  Share… | Log Completed
Edit ▸ delete-class item resolves to: 'Delete<TAB>true'

gesture:  Edit ▸ Delete
  CHANGED YSFQzJ6T.trashed:              0 -> 1
  CHANGED YSFQzJ6T.userModificationDate: 1783253900.707706 -> 1783253967.728970

Edit menu (after the trash):
  Undo  enabled=true

⌘Z:
  CHANGED YSFQzJ6T.trashed:              1 -> 0
  CHANGED YSFQzJ6T.userModificationDate: 1783253967.728970 -> 1783253900.707706

UMD TRIPLE  before=1783253900.707706  after-edit=1783253967.728970  after-undo=1783253900.707706
            the edit moved umd by +67.0s; the undo moved it by -67.0s
VERDICT: RESTORED — the undo rewound umd to its exact pre-edit value

relaunch: (no field changed on any surviving row)
NET vs the pre-gesture snapshot: (no field changed on any surviving row)
```

> Same law, second edit class, microsecond-exact again.

**Mechanics note for the next sitting:** move-to-trash is **`Edit ▸ Delete`**, not an Items-menu item. The first pass of this cell searched `Items` for a delete-class label, found none, fell back to a hard-coded `"Delete To-Do"`, and got `-1728 Can't get menu item` — a drive that did nothing while the cell's own arithmetic still printed a (vacuous) `RESTORED`. That near-miss is why the rewritten cell **enumerates the menu and prints the item it resolved**, and why the row delta is quoted above the verdict: the DB delta is the evidence, the verdict line is only its summary.

---

## 4. Cell U1 — a title rename is NOT undoable once the row closes

Driven the way a user does it: select the row, `Return` to open the card, ⌘A, type, `Escape` to close. Every input step is followed by a full AX dump diffed against the prior one (the harness AX-scrutiny law); the typing lands in the card's title `AXTextArea`:

```
[AX shape after ⌘A + type: 2 changed lines]
  < [26] role=AXTextArea | val=UMDZ1-U1B-TITLE   | FOCUSED | ACTIONS=AXShowMenu
  > [26] role=AXTextArea | val=UMDZ1-U1B-RENAMED | FOCUSED | ACTIONS=AXShowMenu
```

and the close commits it:

```
  CHANGED 9hLLdSgG.title:                UMDZ1-U1B-TITLE -> UMDZ1-U1B-RENAMED
  CHANGED 9hLLdSgG.userModificationDate: 1783253146.371502 -> 1783253225.0769858

Edit menu (after the rename):
  Undo  enabled=false                    <- nothing to undo

⌘Z:  (no field changed on any surviving row)
```

> **The app registers no undo entry for a committed field edit.** `Edit ▸ Undo` is disabled immediately after a rename the user just made, and ⌘Z is inert across all 41 columns.

---

## 5. Cell U1B — where the rename's undo actually lives, and when the write happens

The obvious objection to §4 is that closing the card might merely *discard* a text-editor-local undo stack. This cell separates the two by pressing ⌘Z with the card still open and the title editor still focused:

```
title in the DB while the card is open:  UMDZ1-U1BC-OPEN          <- the ORIGINAL
UMD [after typing, card still open] = 1783253772.379627           <- unmoved

Edit menu (card open, title edited):
  Undo  enabled=true                     <- the TEXT EDITOR's undo

⌘Z (card open):  27 changed AX lines; title in the DB after ⌘Z: UMDZ1-U1BC-OPEN

NET vs the pre-gesture state: (no field changed on any surviving row)
```

> **A field edit is not written until the card closes.** While the card is open the database still holds the old title and `umd` has not moved, so the enabled `Undo` is the standard text-editor undo operating on an in-memory buffer — not a document-level entry. Close the card and the write happens; from that instant it is un-undoable (§4).

So the split in §0.4 is real: the app's document undo covers **state changes** (complete, trash — and, per [REPX3 §4](repx3-chooser-residuals.md), rule edits and occurrence materialization) and does not cover **field edits**, which are committed at close and pass out of undo's reach. Filed as [oddities §28](../things-app-oddities.md).

---

## 6. What this settles for the shipped code

| question | answer |
|---|---|
| Does the app rewind `umd` on undo, or re-stamp it? | **Rewinds**, exactly, on every undoable class measured (§2, §3, plus [REPX3 §4.2](repx3-chooser-residuals.md) on a template rule edit). |
| Is our symmetric restore native parity? | **Yes** — it is the same behavior, at second rather than microsecond resolution, and always on the ≤ side. |
| Could we delegate to the app's ⌘Z instead? | **No** — our writes never enter the stack (§1). Mirroring is the only route. |
| Does a failed restore make an operation irreversible? | **No, and it must not** — the maintainer's ruling, now locked by `test/engine/write-undo.test.ts`: the restore is additive and best-effort; `planUndo` never reads `preModDates`. |

The 1-second floor is the only honest asymmetry and it was already disclosed in the surface copy; nothing in this campaign asks for a code change to the restore itself.

---

## 7. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-craft.md](../things-app-craft.md) | **new §2f** — undo restores the record, `userModificationDate` included, so an undone edit leaves no trace on the changes timeline (§2, §3) |
| [things-app-oddities.md](../things-app-oddities.md) | **new §27** — a committed field edit is not undoable, while a completion and a trash are (§4, §5) |
| [reference/timestamps.md](../reference/timestamps.md) | the `umd` bump-class table gains the app's own undo as a **restoring** writer, and the `--preserve-modified` row records the measured native parity |
| [design/decisions.md](../design/decisions.md) | the 2026-08-13 symmetric-umd ruling gains its evidence line: confirmed against the app, plus the classification invariant |
| `src/write/undo.ts`, `src/write/preserve-modified.ts`, `src/audit/schema.ts` | comments cite the measured law instead of describing the symmetric undo as "future" |

## 8. Open cells this campaign did NOT close

1. **A field edit that IS undoable.** Every undoable class measured here is structural. [REPX3 §4.2](repx3-chooser-residuals.md)'s `Update Rule` is the one field-shaped data point (a template's rule blob, `umd` rewound exactly), and it agrees — but a plain undoable *scalar* field edit was not found, because the app does not appear to offer one (§5).
2. **Undo across a sync boundary.** All of UMDZ1 is single-device. Whether a peer that has already merged the forward edit sees the rewound `umd` win the per-attribute merge is a SYNCX1-shaped question, and the answer very likely follows [SYNCX1](syncx1-exception-sync.md)'s measured `umd`-keyed arbitration — an undo that rewinds `umd` writes a *lower* value, which is the one direction that law says loses. Worth a cell before anyone relies on `--preserve-modified` undo being timeline-silent on a second device.
3. **Multi-row undo.** Only single-row gestures were driven; whether a bulk undo restores every touched row's `umd` or only the primary was not measured.
