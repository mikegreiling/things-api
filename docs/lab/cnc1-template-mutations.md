# CNC1 — "Create Next Copy, then mutate the instance" as the universal template-mutation primitive

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · ONE airgapped clone, guest clock pinned **2026-07-05 12:00 (a Sunday)** and rolled 07-06 → 07-07 → 07-12 by the phase-2 cells · AXVM1 accessibility grant baked. Campaign run 2026-08-24, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-cnc1.sh`](../../lab/scripts/research-cnc1.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone). Fixtures fully synthetic (`CNC1-*`). Artifacts: `lab/artifacts/cnc1-lab/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, AX dumps in `ax/`, per-command CLI output in `log/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field. "No field changed on any surviving row" means all 41 columns of every row compared.

Predecessors: [rdlg2-323-recipe-cert.md](rdlg2-323-recipe-cert.md) §5.2 (what `Create Next Copy` does), [repx1-instance-semantics.md](repx1-instance-semantics.md) §3 (an instance re-date is a plain `when` write and consumes nothing), [repx2-exception-chooser.md](repx2-exception-chooser.md) and [repx3-chooser-residuals.md](repx3-chooser-residuals.md) (the Make Exception chooser this campaign is measured AGAINST).

**Result: 19 assertions, 0 failures.**

---

## 0. Headline

1. **`Create Next Copy` + an ordinary instance write IS `Make Exception`.** On a fixed WEEKLY rule the CNC template delta is *field for field, value for value* what REPX3 §1.2 measured for the chooser's `Make Exception` on the identically-built fixture — `icCount +1`, watermark → consumed slot + 1, cursor → the next RULE date, `todayIndexReferenceDate` → cursor, `userModificationDate` silent. Same on a fixed DAILY rule against REPX3 §2.1. The vacated slot then stays **silent** when the clock reaches it, against a control that spawns normally (§1).
2. **The composite's ONLY residual difference from the chooser is one column on one row:** the minted instance's `userModificationDate`, which the chooser leaves NULL and the second write stamps. Everything else — `startDate`, `todayIndexReferenceDate`, `status`, `start`, `creationDate` (gesture wall-clock in both), `rt1_repeatingTemplate`, `rt1_instanceCreationCount` — matches (§1.3).
3. **The composite inherits [oddities §17](../things-app-oddities.md) exactly, which is the design constraint, not a defect of ours.** Re-dating the minted instance onto the rule's OWN next slot leaves two live rows on that day when the clock arrives — the same double-book the sanctioned chooser path produces, for the same slot-keyed reason. A shipped op must refuse a target that is a live slot of the same rule (§2).
4. **A per-occurrence deadline is DERIVED onto the minted instance, and an instance-local deadline edit sticks without touching the rule** (§3). **A rule-level reminder is inherited verbatim, and an instance-local reminder edit lands** (§4).
5. **CNC on an AFTER-COMPLETION template does not refuse and does not crash — it DUPLICATES the current occurrence onto the same day.** There is no cursor to advance (`rt1_nextInstanceStartDate` is NULL by construction), so the app mints a second live instance dated the same day as the existing one and bumps `icCount` alone. One menu press, two identical live occurrences. New [oddities §18](../things-app-oddities.md) (§5).
6. **Status writes on the minted instance leave the template byte-unchanged, and the series continues on schedule — for CANCEL exactly as for COMPLETE.** Cancel was unmeasured anywhere before this campaign; it is `status 0→2` + `stopDate`, the same shape as completion, and the next rule date spawns normally in both arms (§6).
7. **`things undo` reverses the instance write PERFECTLY and cannot touch the mint.** Net of the undo against the post-CNC state is a single column: `userModificationDate`. The minted row and the advanced cursor stay — so a shipped composite is *half*-reversible and must say so (§7).
8. **The `THINGS_API_UI_DIRECT=1` escape works end to end, and the lab has a SECOND gate nobody had hit: the AppleScript WRITE vector.** A pure-ui op refuses cleanly (exit 4, naming `things helpers setup --gui`, nothing driven) without the escape and drives with it — the queued Article IV verification, closed. But the escape covers the ui vector ONLY: the Wave A write gate refuses the AppleScript vector in any guest shell, because an sshd-descended process has no bundle id. Every AppleScript-vector verb — `make-repeating` included — is now unreachable in the lab (§9).

---

## 1. Cell A — the equivalence, on a WEEKLY and a DAILY rule

### 1.1 Construction

Both arms are built the REPX2/REPX3 way — `things:///add?title=…&when=2026-07-05`, then `Items ▸ Repeat…` → frequency → OK — which is why they are directly comparable with REPX3's fixtures rather than merely analogous. (They are **not** built with `things todo make-repeating`; §9 explains why that verb no longer runs in a clone.)

`CNC1-A1-WEEKLY` lands the same shape REPX3's `REPX3-G1-WEEKLY` did:

```
tp=0 fu=256 fa=1 ts=0 rc=0 of=[{wd=0(Sun)}]   next = icStart = 2026-07-12   icCount = 1
```

### 1.2 The gesture, and the numbers side by side

`Items ▸ Repeat ▸ Create Next Copy` on the uuid-verified template:

```
INSERTED row 4v5go1XC2JbGZkTzSgp8d7
  status                    = 0                       <- born OPEN
  start                     = 2
  startDate                 = 2026-07-12              <- the CURSOR's own slot
  todayIndexReferenceDate   = 2026-07-12
  creationDate              = 1783252905.538014       <- 2026-07-05 12:01:45, the GESTURE
  leavesTombstone           = 1
  rt1_repeatingTemplate     = 7e6QKnphaRpj2CdrTcA2zY
  rt1_instanceCreationCount = 0

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-12 -> 2026-07-13   <- WATERMARK: slot + 1
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-12 -> 2026-07-19   <- CURSOR: the next RULE date
CHANGED template.todayIndexReferenceDate       : 2026-07-12 -> 2026-07-19
```

Set that template delta against REPX3 §1.2's `Make Exception` on the same fixture shape:

| template column | REPX3 `Make Exception` | CNC1 `Create Next Copy` |
|---|---|---|
| `rt1_instanceCreationCount` | 1 → 2 | **1 → 2** |
| `rt1_instanceCreationStartDate` | 2026-07-12 → 2026-07-13 | **2026-07-12 → 2026-07-13** |
| `rt1_nextInstanceStartDate` | 2026-07-12 → 2026-07-19 | **2026-07-12 → 2026-07-19** |
| `todayIndexReferenceDate` | 2026-07-12 → 2026-07-19 | **2026-07-12 → 2026-07-19** |
| `userModificationDate` | silent | **silent** |
| rule blob | byte-untouched | **byte-untouched** |

The same four fields with the same four values, and nothing else moves. This is not a surprise once REPX3 §1.3 is read — the chooser's exception was already shown to be "the ordinary spawn of that slot, performed early and dated elsewhere", and `Create Next Copy` is the ordinary spawn of that slot performed early. What CNC1 establishes is that the two are the same *bookkeeping event*, so the exception's semantics are reachable without the chooser.

### 1.3 The second write, and the only residual difference

`things todo update <minted> --when 2026-07-15` (URL-scheme vector, tier 0):

```
CHANGED 4v5go1XC.startDate               : 2026-07-12 -> 2026-07-15
CHANGED 4v5go1XC.todayIndexReferenceDate : 2026-07-12 -> 2026-07-15
CHANGED 4v5go1XC.userModificationDate    : None -> 1783252913.193044
(the template: byte-identical — cursor, watermark, count, rule blob all unmoved)
```

which is REPX1 §3.1's plain-instance-re-date delta exactly, as expected of a row the rule no longer has an opinion about.

End state versus the chooser's, column by column:

| minted row | `Make Exception` (REPX3 §1.2) | CNC + re-date |
|---|---|---|
| `startDate` | 2026-07-15 | 2026-07-15 |
| `todayIndexReferenceDate` | 2026-07-15 | 2026-07-15 |
| `status` / `start` | 0 / 2 | 0 / 2 |
| `creationDate` | the gesture instant | the gesture instant |
| `rt1_repeatingTemplate` | the template | the template |
| `rt1_instanceCreationCount` | 0 | 0 |
| **`userModificationDate`** | **NULL** | **stamped by the second write** |

> **One column, on one row.** The chooser performs one atomic act and never stamps a user edit; the composite performs two, and the second is an ordinary `when` write, which stamps. Sync-wise this is the *safer* direction — SYNCX1 measured that `umd` is the merge discriminator and that an unstamped clock spawn LOSES to a user edit — so the composite's occurrence wins a merge against a peer's spawn of the same slot at least as reliably as the chooser's does.

### 1.4 The vacated slot, against a live control

`CNC1-A1C-WEEKLY` is the same fixture with no gesture at all. Both arms rolled in the same clock advance to **2026-07-12**, the weekly rule's own slot:

| arm | delta | untrashed series rows dated 2026-07-12 |
|---|---|---|
| CNC + re-date | **(no field changed on any surviving row)** — 3 rows, 123 fields | **0** |
| control | a normal spawn (`icCount 1→2`, watermark → 07-13, cursor → 07-19) | **1** |

The composite consumes the slot exactly as the chooser does.

### 1.5 The DAILY arm

`CNC1-A2-DAILY` (cursor = watermark = 07-06, `icCount` 1). CNC:

```
CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-07
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
CHANGED template.todayIndexReferenceDate       : 2026-07-06 -> 2026-07-07
```

— which is REPX3 §2.1's `Make Exception` step-1 delta on a daily fixture, field for field. Minted row re-dated 07-06 → 07-09 with the §1.3 shape. Rolled to **2026-07-06**: the CNC arm is silent (the only movement in the whole series is `template.todayIndex −4167 → 3709`, the daily rank recompute) and holds **0** rows on 07-06; the `CNC1-A2C-DAILY` control spawns normally and holds **1**.

---

## 2. Cell B — the §17 hazard, inherited whole

`CNC1-B-SLOT`, a daily series. CNC mints the 07-06 occurrence and leaves the cursor on **07-07**. The minted instance is then re-dated **onto 07-07** — the slot the cursor is about to reach:

```
CHANGED WRxkMLz7.startDate               : 2026-07-06 -> 2026-07-07
CHANGED WRxkMLz7.todayIndex              : -6015 -> -6583
CHANGED WRxkMLz7.todayIndexReferenceDate : 2026-07-06 -> 2026-07-07
CHANGED WRxkMLz7.userModificationDate    : None -> 1783253047.497
(template byte-identical; cursor still 2026-07-07)

untrashed series rows dated 2026-07-07, before the clock arrives = 1
```

Clock → **2026-07-07**:

```
INSERTED row KpEHyKXk39zeCxX6FzHRnQ  startDate = 2026-07-07  creationDate = 1783382400.0 (occurrence midnight)
CHANGED template.rt1_instanceCreationCount     : 2 -> 3
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-08
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-08

untrashed series rows dated 2026-07-07 = 2     <- DOUBLE-BOOKED
```

Identical to REPX3 §3.2's chooser result, for REPX3 §3.3's reason: the reconciliation is **slot-keyed, not date-keyed**, and the 07-07 spawn is a *different slot's* occurrence carrying a different uuid. Nothing compares the two rows' `startDate`.

> **The refusal basis for a shipped op.** This is not a hazard the composite introduces and not one it can dodge by a different mechanism — the sanctioned GUI gesture does the same thing. It is therefore a *precondition* to enforce, and the ingredients are all in hand at op time: after CNC the template's `rt1_nextInstanceStartDate` is the next live slot, and the shipped occurrence derivation (`templateProjectionDay` / `occurrences.ts`, certified against a real 3.23 library by RDLG2 §6.1) enumerates the rule's upcoming dates. An exception-move whose target date is a slot the same rule still produces must refuse before the CNC, not after.

---

## 3. Cell C — the derived deadline carries, and an instance-local edit sticks

`CNC1-C-DL`: daily, `Add deadlines` ticked with **start 3 days earlier** — `tp=0 fu=16 fa=1 ts=-3 … tmplDeadline=4001-01-01` (the deadline-mode sentinel RDLG2c C7 recorded). CNC:

```
INSERTED row VEeKd3bZUL1djjYmQXjZM3
  startDate = 2026-07-06          <- the cursor's slot
  deadline  = 2026-07-09          <- DERIVED: start + 3, from the rule's ts = -3
  status = 0 ; rt1_instanceCreationCount = 0 ; creationDate = the gesture

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-07
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
```

So the minted occurrence is **fully formed**: the app applies the rule's offset at mint time rather than leaving the deadline for the clock spawn to fill in.

`things todo update <minted> --deadline 2026-07-16`:

```
CHANGED VEeKd3bZ.deadline             : 2026-07-09 -> 2026-07-16
CHANGED VEeKd3bZ.userModificationDate : None -> 1783253091.522
(the rule: ts = -3 and tmplDeadline = 4001-01-01 both UNCHANGED)
```

A per-occurrence deadline is editable on the instance without touching the series — the deadline half of the template-mutation problem is solved by the same composite.

---

## 4. Cell D — the rule reminder is inherited, and an instance-local reminder lands

`CNC1-D-REM`: daily with `Add reminders` ticked, accepting the dialog's own 12:00 default — the template carries `reminderTime = 805306368` (`h<<26 | m<<20`, i.e. 12:00). CNC mints an instance carrying **`reminderTime = 805306368`** verbatim, alongside the same four-field template delta as every other fixed arm.

`things todo update <minted> --when 2026-07-08 --reminder 14:30`:

```
CHANGED Pr8jLZix.reminderTime            : 805306368 -> 970981376        (12:00 -> 14:30)
CHANGED Pr8jLZix.startDate               : 2026-07-06 -> 2026-07-08
CHANGED Pr8jLZix.todayIndexReferenceDate : 2026-07-06 -> 2026-07-08
CHANGED Pr8jLZix.userModificationDate    : None -> 1783253133.564
(the rule's own reminderTime: UNCHANGED at 805306368)
```

Both halves land in one write, and the series keeps its own reminder for every future occurrence.

---

## 5. Cell E — CNC on an AFTER-COMPLETION rule duplicates TODAY (new oddity)

`CNC1-E-AC`: `Items ▸ Repeat… → after completion`, interval 2 — `tp=1 fu=256 fa=2 of=[]`, **`next = NULL`**, `icStart = 2026-07-06`, `icCount = 1`, with the seed instance live on 07-05. An after-completion series has no calendar, which is exactly why RDLG2 §6.1 found it in the no-projection-cache cohort.

The submenu is unchanged and the item is enabled:

```
Items ▸ Repeat = Edit Rule… · (sep) · Show Previous Copy · Create Next Copy · (sep) · Pause · Stop
```

The press neither refuses nor crashes (app ALIVE, crash reports 0 → 0, no sheet in the AX dump):

```
INSERTED row DVAcW6ChzgYmdJVRyqsjjJ
  status    = 0
  start     = 1
  startDate = 2026-07-05                <- TODAY — the day the existing instance already occupies
  todayIndexReferenceDate = 2026-07-05
  creationDate = 1783253174.817529      <- the gesture
  rt1_repeatingTemplate = K2cWkxNeKnFGxdH92fB9Qq
  rt1_instanceCreationCount = 0

CHANGED template.rt1_instanceCreationCount : 1 -> 2
(and NOTHING else on the template — no cursor to advance, no watermark move)
```

The series afterwards:

```
4an3Vvm7  startDate 2026-07-05  status 0    the original instance
K2cWkxNe  (template)
DVAcW6Ch  startDate 2026-07-05  status 0    the CNC mint — the SAME DAY
```

> **One sanctioned menu press, two identical live occurrences, immediately.** This is a fresh route into the [§13](../things-app-oddities.md)/[§17](../things-app-oddities.md) double-book class that needs no re-date, no clock roll and no preserve trigger — the gesture alone is sufficient, because "the next copy" is undefined for a rule whose next occurrence is a function of a completion that has not happened. Filed as [oddities §18](../things-app-oddities.md).

Rolled to 07-07, the template's watermark drifts 07-06 → 07-08 with no spawn — the dormant after-completion drift REPX1 (b) already records, unaffected by the mint.

**Consequence for scope:** an op built on CNC must refuse an after-completion template outright. It is the one rule shape where the primitive is not "materialize the pending occurrence" but "duplicate the current one".

---

## 6. Cell F — status on the minted instance, complete AND cancel

Both arms are a daily series, CNC, then the shipped status verb on the minted row (URL-scheme vector, tier 0).

**F1 — complete** (`things todo complete <minted>`):

```
CHANGED 4ErShdeZ.status               : 0 -> 3
CHANGED 4ErShdeZ.stopDate             : None -> 1783253225.404067
CHANGED 4ErShdeZ.userModificationDate : None -> 1783253225.404093
(the template: byte-identical — cursor still 07-07, icCount still 2)
```

**F2 — cancel** (`things todo cancel <minted>`), unmeasured on any surface before this campaign:

```
CHANGED SKrQN7qR.status               : 0 -> 2
CHANGED SKrQN7qR.stopDate             : None -> 1783253265.960432
CHANGED SKrQN7qR.userModificationDate : None -> 1783253265.960462
(the template: byte-identical — cursor still 07-07)
```

**Cancel is completion's shape with a different status code.** Three columns on one row, `stopDate` stamped exactly as for a completion, template untouched — so the Logbook renders a canceled occurrence on the right day the same way it renders a completed one, and no "canceled projection" special case exists.

RDLG2 §5.3's negative is re-confirmed on golden-v4 for both: an early status write on a future-dated instance does **not** advance the series.

Rolled to **2026-07-07**, both arms spawn normally:

| arm | delta at 07-07 | rows dated 07-07 |
|---|---|---|
| F1 (completed occurrence) | normal spawn, `icCount 2→3`, cursor + watermark → 07-08 | 1 |
| F2 (canceled occurrence) | normal spawn, `icCount 2→3`, cursor + watermark → 07-08 | 1 |

> **Cancelling an occurrence does not cancel the series.** The cadence continues at the next rule date, identically to the completed arm, with exactly one row per day — no double-book, no skip.

---

## 7. Cell G — `things undo` reverses half the composite, perfectly

`CNC1-G-UNDO`: daily, CNC, then `things todo update <minted> --when 2026-07-10`, then `things undo`.

The undo selects the instance write (the only leg that is a recorded op — the CNC is a raw menu press no shipped surface performed) and plans the exact inverse:

```
plan: todo.update { uuid: JuLA2FqB…, when: "2026-07-06" }  kind: invertible
      guardFields: [start, startDate, today, evening]
result: ok — observed startDate 2026-07-06
```

```
---- after `things undo` ----
CHANGED JuLA2FqB.startDate               : 2026-07-10 -> 2026-07-06
CHANGED JuLA2FqB.todayIndexReferenceDate : 2026-07-10 -> 2026-07-06
CHANGED JuLA2FqB.userModificationDate    : 1783253306.841 -> 1783253307.606

---- NET of the undo vs the POST-CNC state ----
CHANGED JuLA2FqB.userModificationDate : None -> 1783253307.606
(rows in both: 3; fields compared: 123)

rule after undo: next = icStart = 2026-07-07, icCount = 2   <- UNMOVED
```

> **The instance write is perfectly reversible; the mint is not reversible at all.** The undo restores the occurrence to the cursor's own slot date and leaves exactly one column moved (`umd`, which no inverse can rewind — REPX3 §4.3 wall 2). What it cannot do is un-mint the row or rewind `rt1_instanceCreationCount` / the two cursor columns: the app's own ⌘Z does all of that (REPX3 §4.1) and nothing we drive can. So after an undo the series holds a **materialized occurrence dated the consumed slot** — which is precisely the state a `Create Next Copy` alone produces, and is coherent, but is NOT the pre-gesture state.

A shipped composite is therefore **half-reversible and must disclose it**: undo restores the occurrence's date/status, the occurrence itself and the series' advance stand.

---

## 8. Cell H — the PROJECT arm: rig-blocked, as expected

A repeating project could not be reached. `things:///add-project` + `show?id=` selects the project (`id of selected to dos` returns its uuid — the SL1 oracle), but with a project shown the **`Items` menu has no `Repeat` item at all**:

```
Items = When… · Move… · Tags… · Deadline… · Complete · Shortcuts · Get Info ·
        Convert to Project… · Remove From Project/Area · Remove From Contact ·
        Show in Area · Log Completed
Items ▸ Repeat  ->  -1728 (Can't get menu item "Repeat" of menu "Items")
```

which is REPX1 §5.1's law seen from the project side: the repeat verbs live on the **to-do** `Items ▸ Repeat` submenu, and a project's repeat surface is the always-visible repeat BAR in the project header. Promoting the project to a repeater at all needs `project.make-repeating`, whose reveal is the repeat-bar popover HID click that [RDLG2 §7 cell 3](rdlg2-323-recipe-cert.md) left un-recertified on 3.23 — and which is additionally unreachable here because `project.make-repeating`'s composite legs are AppleScript (§9).

**Verdict: RIG-BLOCKED, best effort, no claim either way.** Whether `Create Next Copy` exists for a project template is untested; the to-do findings do not transfer, because the menu that carries the item does not exist for this selection.

---

## 9. Cell E0 — the UI-vector lab escape, and the write gate nobody had hit

This cell is the queued end-to-end verification of `THINGS_API_UI_DIRECT=1` ([permissions doctrine](../design/permissions-doctrine.md) Article IV, [harness](harness.md) §The UI-vector lab escape), which landed with no VM available.

### 9.1 The escape works, in both directions

Probed with `todo pause-repeat` — deliberately a **pure-ui** op (menu press only), so the only gate it can trip is Article IV's:

| run | result |
|---|---|
| `things todo pause-repeat <tmpl> --dangerously-drive-gui --json`, **no escape** | `blocked:environment`, **exit 4** — *"this operation drives the Things window, and GUI-driving is granted only to the helpers, and no helper is answering on this machine"*, remediation `things helpers setup --gui`. No dialog, no hang. `rt1_instanceCreationPaused` still 0 — **nothing was driven** |
| the same call **with `THINGS_API_UI_DIRECT=1`** | **exit 0**, one lab-certification warning, `rt1_instanceCreationPaused` **0 → 1** |
| `todo resume-repeat` with the escape | exit 0, back to 0 |

> **VERIFIED.** The escape restores ui-vector availability in a clone, the refusal without it is the fail-closed outcome the doctrine promises (a clean block naming the remediation, never a wedged VM), and `ui-enabled` is not bypassed — the clone still had to set it. The [up-next](../up-next.md) item is closed by this cell.

### 9.2 The escape covers the UI vector ONLY — and that now blocks the lab's AppleScript writes

The campaign's first two attempts built fixtures with `things todo make-repeating`, the way [RDLG2c](rdlg2-323-recipe-cert.md) §3 did. Every one failed, **with the escape set**:

```
{"code":"blocked:environment",
 "message":"this operation drives the Things app, and this process does not descend from
            an application bundle, so macOS has no identity to record app control against
            — the disposable clone (uuid …) was created but the original … could not be
            moved to the Trash, so it was NOT promoted; trash the clone and retry",
 "remediation":"run `things helpers setup` — app control then attaches to a helper …"}
EXIT=4
```

`things doctor` in the clone states it plainly:

```
── Permissions (per vector) ──
host app:    this terminal
  read         direct-fda       host Full Disk Access (this terminal)
  applescript  direct-unknown   none
  url-scheme   enabled          none needed
  shortcuts    installed        none needed
  ui           helpers-missing  none — helpers only (Article IV)
```

The cause is structural, not a misconfiguration: `writeCapability` (`src/capability.ts`) returns `direct-unknown` whenever `host.bundleId === null`, and an sshd-descended shell has no `__CFBundleIdentifier`. There is no `THINGS_API_*` escape on that path — `UI_DIRECT_ESCAPE_ENV` is consulted by `uiCapability` alone.

Measured consequences, all on this clone:

| vector | in-guest status |
|---|---|
| **url-scheme** | works — every `todo update` / `complete` / `cancel` in this campaign ran through it at tier 0 |
| **reads** | work — `direct-fda` |
| **ui** (with the escape) | works |
| **AppleScript** | **BLOCKED, unconditionally** |

So every verb whose vector is AppleScript, and every composite with an AppleScript leg — `make-repeating` and `add-repeating` (clone + trash), and by inspection the rest of the AppleScript catalogue — is unreachable from a lab clone as of Wave A (2026-08-24). This campaign worked around it by building fixtures with a URL add plus a direct AX Repeat-dialog drive, which is what REPX2/REPX3 always did.

> **This is a lab-capability regression, not an app finding, and it is undiscovered elsewhere.** `lab/guest/e2e-write-smoke.sh` exports `THINGS_API_UI_DIRECT=1` and nothing else; its 132-step write-layer run last passed **2026-08-22**, two days before the write gate landed. Every AppleScript step in that smoke should now block. Recorded in [up-next](../up-next.md) as the thing to settle before the next `lab:regress` — the honest options are a write-vector lab escape alongside the ui one, or teaching the guest bundle to present a bundle identity.

---

## 10. Verdict per cell

| cell | question | verdict |
|---|---|---|
| **A1/A2** | is CNC + instance-write equivalent to `Make Exception`? | **YES** — template delta identical on weekly AND daily; vacated slot silent against a live control; one residual column (`umd` on the minted row) |
| **B** | does the composite inherit the §17 double-book? | **YES** — 2 rows on the collision day, exactly as the chooser path. A shipped op must refuse same-rule-slot targets |
| **C** | does a derived deadline carry, and is it editable? | **YES** to both; the rule is untouched by the instance edit |
| **D** | is a rule reminder inherited, and is it editable? | **YES** to both; the rule keeps its own reminder |
| **E** | what does CNC do on an after-completion rule? | **MINTS A DUPLICATE OF TODAY** — no refusal, no crash, `icCount` bumped, no cursor to move. New oddity; must be refused by any op |
| **F1** | CNC → complete ≡ early check-off? | **YES** — template byte-unchanged (RDLG2 §5.3 re-confirmed on golden-v4); series continues at the next rule date |
| **F2** | CNC → cancel? | **CLEAN** — `status 0→2` + `stopDate`, template byte-unchanged, series continues, Logbook sane. First measurement anywhere |
| **G** | what does `things undo` reverse? | the **instance write, perfectly** (net = one `umd` column). The mint and the cursor advance are **not reversible** — disclosure required |
| **H** | is CNC reachable for a repeating PROJECT? | **RIG-BLOCKED** — a shown project has no `Items ▸ Repeat` menu at all; the project repeat surface is the header bar, whose 3.23 reveal is still the un-recertified HID cell |
| **E0** | does `THINGS_API_UI_DIRECT=1` work end to end? | **YES** — drives with it, clean exit-4 block without it, nothing driven, no hang. Plus: the **AppleScript write vector is separately gated and has no escape** (§9.2) |

---

## 11. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-oddities.md](../things-app-oddities.md) | **new §18** — `Create Next Copy` on an after-completion template duplicates the current occurrence onto the same day (§5) |
| [things-app-oddities.md](../things-app-oddities.md) §17 | dated pointer: the CNC + instance-re-date composite reaches the same double-book by the same slot-keyed mechanism (§2) |
| [capability-matrix.md](../capability-matrix.md) | the exception-move row resolves to the CNC-composite shape, with the cell verdicts as its evidence |
| [reference/novel-paths.md](../reference/novel-paths.md) | the CNC-plus-instance-write composite as the reachable exception primitive |
| [harness.md](harness.md) | the UI-escape section gains the measured write-vector boundary (§9.2) |
| [up-next.md](../up-next.md) | the `THINGS_API_UI_DIRECT` verification item is CLOSED (§9.1); a new item opens for the AppleScript write gate in the lab (§9.2) |

## 12. Open cells this campaign did NOT close

1. **The PROJECT arm** (§8) — blocked behind the same 3.23 repeat-bar reveal RDLG2 §7 cell 3 parked.
2. **The composite's SYNC behavior.** SYNCX1 cleared the chooser's exception across devices; the composite differs by one stamped `umd` on the minted row, which SYNCX1 measured to be the *winning* side of the merge arbitration — so the expectation is strictly safer than what SYNCX1 certified, but it is an inference, not a measurement. All of CNC1 is single-device.
3. **CNC on a PAUSED template.** The submenu carries `Resume` rather than `Pause` in that state; whether `Create Next Copy` is present, enabled, or inert on a paused series is untested.
4. **Whether the after-completion duplicate (§5) is dated TODAY or dated THE CURRENT OCCURRENCE.** The fixture's live instance sat on the pinned day, so the two hypotheses coincide. One cell with the instance re-dated off today would separate them.
