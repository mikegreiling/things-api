# MODALX1 — the open-sheet interaction matrix

**Environment (version-stamped, immutable):** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS 15.7.7 · DB v27 · clock pinned **2026-07-05** and never rolled (trial wall 2026-07-18) · one disposable clone, airgapped · things-api at `1de3dbc` (0.19.1). Fixtures fully synthetic (`MODALX1-*`). Beep sentinel ON (report-only): **2 beeps for the whole run**, both attributable and both in M7 (§7). Driver: [`lab/scripts/research-modalx1.sh`](../../lab/scripts/research-modalx1.sh) (`setup` / `run` / `teardown`; `CELLS=…` selects).

## Why

Field report M1 (maintainer, 2026-08-27, things-api 0.19.1 / Things 3.23.1 / macOS 15.4.1 — [#620](https://github.com/mikegreiling/things-api/issues/620)): a `todo make-repeating` drive died mid-way and left its Repeat sheet standing. While it stood, **Things Cloud sync was gated entirely** (background writes synced fine without it; dismissal released the queued sync immediately), and the sheet **survived an aborted drive**. Separately, the same incident reported a "ghost clone" — *"AppleScript could not get that to-do ID"* while the database showed the row untrashed.

[VMQ1 §5](vmq1-probe-closeout.md) had already measured one consequence in-lab and recorded it as a broad law: *"an open modal blocks AS object-model mutations app-wide regardless of lock state."* Nobody had measured the breadth. This campaign does — and the breadth turns out to be much narrower and much stranger than the recorded law, in a way that **explains the ghost clone as a consequence of the stranded sheet rather than a second, separate mystery**.

## The sheet under test

Opened the REPX2/REPX3 way on a synthetic to-do: `things:///show?id=<uuid>` (verified by uuid) → activate → `Items ▸ Repeat…`. Full inventory, dumped on every open (`lab/artifacts/modalx1-lab/ax/*.txt`):

```
role=AXSheet @[239,250 545x233]
  AXCheckBox   Add reminders            val=0   id=_NS:135
  AXCheckBox   Add deadlines            val=0   id=_NS:129
  AXGroup      id=_NS:60
    AXPopUpButton  val=week             id=_NS:8
    AXStaticText   "after previous item is checked off."
    AXTextField    val=1                id=_NS:43
  AXStaticText "Repeat"                 id=_NS:120
  AXPopUpButton  val="after completion" id=_NS:29   FOCUSED
  AXButton     OK                       id=_NS:115
  AXButton     Cancel                   id=_NS:86
```

A **series'** sheet is a different, larger dialog reached by a different path — `Items ▸ Repeat ▸ Edit Rule…`, with the submenu offering `Edit Rule… · Create Next Copy · Pause · Stop`. The first M2b pass used the plain `Items ▸ Repeat…` path on a series, opened nothing, drove into an empty room and read as a clean success. **A sheet-opening helper must assert `SHEETS=1` before the cell is allowed to judge anything** — the CNCAC1/URLEN1 law in its setup form.

## 1. Positive controls (M0) — sheet CLOSED

Every vector this campaign judges was first shown to land, on the same clone in the same pass. **11/11 PASS, 0 beeps:** `things:///add`, `things:///update`, `things:///json`, AppleScript `make new to do` / `set notes` / `set status` / `delete`, an AppleScript read, the Shortcuts proxy `things-proxy-edit-title`, the `#606` chord `project move-heading`, and a `todo make-repeating` promote.

> **A defect found while building the control (unrelated to sheets, real, and shipped).** `todo make-repeating` on a to-do whose start date is **today** always refuses at the pre-commit audit: *"1 control(s) differ: Next (first occurrence) = 2026-07-05 (intended "2026-07-05", dialog shows "Today")"*. The Repeat dialog renders the first-occurrence date as the relative word **Today** whenever it equals the system date; the audit compares literally against the ISO string it typed. Isolated with a matched triple on one clone: `--when` = today → **exit 3, nothing committed**; `--when` = tomorrow (2026-07-08) → exit 0, lands; **undated** → exit 0, lands (the recipe drops the Next step entirely). Every prior repeat campaign happened to date its fixtures off the pinned clock, which is why this has never been seen. The failure direction is the correct one (refuse, commit nothing, restore the original) but the operation is unusable on the single most natural input. Not an app bug — an audit-comparison bug on our side. Tracked as a follow-up in the recommendation, §8.

## 2. The matrix — write vectors with the sheet standing (M1)

Taxonomy per the brief: **LANDS / ERRORS / PARKS / TIMES OUT.** Every cell was measured twice — with the sheet standing, and again after dismissal plus a 10 s settle, because [URLEN1](urlen1-url-enable.md) proved a refused command can *park* behind a sheet and fire on release.

| Vector | Command | With the sheet standing | After dismissal | Verdict |
|---|---|---|---|---|
| URL | `things:///add` | row appears in **~1 s**, exit 0 | — | **LANDS** |
| URL | `things:///update?notes=` | notes rewritten | — | **LANDS** |
| URL | `things:///json` batch add | row appears | — | **LANDS** |
| AppleScript | `make new to do` | `to do id …`, exit 0, 1 s | — | **LANDS** |
| AppleScript | `set notes of to do id X` | exit 0, 0 s | — | **LANDS** |
| AppleScript | `set status of to do id X to completed` | exit 0, 1 s, `status=3` | — | **LANDS** |
| AppleScript | `move to do id X to list "Trash"` | exit 0, `trashed=1` | — | **LANDS** |
| AppleScript | **`delete (to do id X)`** | **`-1728 Can't get to do id "…"`**, `trashed` stays 0 | did **not** park; the same call on the same row succeeds once dismissed | **ERRORS** |
| AppleScript | `delete (project id X)` | `-1728 Can't get project id "…"` | — | **ERRORS** |
| AppleScript | reads by id (`exists` / `name` / `status` / `count windows` / `version`) | all exit 0, correct values | — | **LANDS** |
| Shortcuts | `things-proxy-edit-title` | *"The action "Find Items" was interrupted because it didn't finish executing in time"*, exit 1 after **30 s** | title unchanged — did **not** park | **TIMES OUT** |
| ui (chord) | `project move-heading` (#606) | chord posted, swallowed, read-back catches it → clean abort | — | **BLOCKED, refused** (§4) |
| ui (dialog) | `todo reschedule-repeat` | preflight refuses | — | **REFUSED** (§3) |
| URL, scheme **disabled** | `things:///add` | parks in a stacked consent sheet | Escape **discards** it | **PARKS** (§7) |

Nothing parked in the enabled-URL arm: the post-dismissal re-measure found no extra rows, no delayed delete, no delayed rename.

### 2.1 What the sheet actually takes away (M1B) — the law, corrected

VMQ1's recorded law ("an open modal blocks AS object-model mutations app-wide") is **too broad and mis-attributed**. Matched probes either side of the sheet, on one clone in one pass:

| AppleScript expression | Control | Sheet standing | After dismissal |
|---|---|---|---|
| `count to dos` | 35 | **0** | 34 |
| `count projects` | 6 | **0** | 6 |
| `count (every to do)` | 35 | **0** | 34 |
| `get name of first to do` | `LAB-REPEAT-DAILY` | **`-1719` Can't get to do 1. Invalid index** | `LAB-REPEAT-DAILY` |
| `count areas` | 2 | 2 | 2 |
| `count to dos of list "Inbox"` | 12 | 12 | 11 |
| `count to dos of list "Today"` | 8 | 8 | 8 |
| `exists to do id X` | true | true | true |
| `get name / id / status of to do id X` | ok | ok | ok |
| `count windows` · `get version` | 1 · 3.23 | 1 · 3.23 | 1 · 3.23 |

**The law:** a standing modal sheet **empties Things' top-level scripting collections** — `to dos`, `projects`, `every to do` all report zero and positional access raises `-1719` — while **list-scoped collections (`to dos of list "…"`), `areas`, and every by-id access are untouched**. Nothing about *mutation* is blocked as such. Every mutation form that does not resolve its argument through a top-level collection lands normally: `make new to do`, `set notes`, `set status`, and even `move … to list "Trash"` (a trash, by any user's reckoning) all succeed with the sheet up.

Recorded as [oddities §25](../things-app-oddities.md). `delete` is the casualty because Things' `delete` handler re-resolves its object specifier against the app-level element list, which is empty. Hence the exact and otherwise inexplicable pairing: **`exists to do id X` → true, `get name of to do id X` → the title, `delete (to do id X)` → `-1728 Can't get to do id "X"`, and the database row sitting there untrashed the whole time.**

### 2.2 The #620 "ghost clone" is this, and nothing else (M1C)

Running the **shipped CLI** into that state reproduces the field symptom verbatim:

```
$ things todo delete ArP1RdwdPBiSs3XnHCw4ax          # a Repeat sheet is standing
VERIFY FAILED (silent-noop): transport failed (exit 1): 30:70: execution error:
Things3 got an error: Can’t get to do id "ArP1RdwdPBiSs3XnHCw4ax". (-1728)
— and a follow-up re-read found no landed change
EXIT=3
      DB trashed=0
```

`things todo complete` in the same breath returns `ok … (vector=url-scheme, tier=0, verified)` — it routes through the URL vector, which the sheet does not touch. Dismiss the sheet and the *same command on the same uuid* is `ok todo.delete … (vector=applescript, tier=0, verified)`.

**#620 lists the stranded sheet and the ghost clone as two separate open questions. They are one.** A row the database shows as open, that AppleScript insists does not exist, is the signature of a modal sheet standing somewhere on that Mac — and the release is immediate and complete the moment it is dismissed.

## 3. A second GUI drive while a sheet stands (M2)

The answer splits cleanly on whether the operation is **pure-ui** or a **composite**, and this is the most consequential result in the campaign.

**M2b — `todo reschedule-repeat` (pure-ui), driven at the very series whose Edit-Rule sheet is open.** Refuses correctly, with the right diagnosis:

```
ui preflight refused: element for "Items ▸ Repeat submenu" did not resolve
(menu item "Repeat" of menu "Items" of menu bar 1). A modal sheet or popover is
currently open in Things — most likely left over from an earlier drive that
aborted without dismissing it. An open sheet disables the menu bar, so the
Repeat menu path cannot resolve. Dismiss the open sheet in Things (Escape or
Cancel), then retry. Nothing was pressed.
```

Rule blob **byte-identical**, `userModificationDate` untouched, zero rows created, the standing sheet **not** hijacked and not dismissed, 0 beeps. This is `src/write/vectors/ui.ts`'s recipe canary missing the menu path and then consulting `sheetStillOpen()` for the explanation — over-caution in exactly the right direction.

**M2a — `todo make-repeating` on a *different* to-do (a composite).** Does **not** refuse. It gets partway through and leaves debris:

```
VERIFY FAILED (silent-noop): transport failed (exit 1): 30:70: execution error:
Things3 got an error: Can’t get to do id "WvGG3ZkfP992yhHPuaCrPp". (-1728)
— and a follow-up re-read found no landed change — the disposable clone
(uuid U649k2M9B7wyaTTAcEVH1J) was created but the original WvGG3ZkfP992yhHPuaCrPp
could not be moved to the Trash, so it was NOT promoted; trash the clone and retry
```

Zero mutation on the target **row** and on the sheet host (both PASS, field for field), the standing sheet survived untouched — but the assertion that failed is *"created no rows"*: **the composite leaked a disposable clone**, because its first leg is a URL-scheme create, and the URL vector is not gated by the sheet at all. The clone lands, the AppleScript trash-the-original leg then hits §2.1's `-1728`, and the operation aborts holding a row the user must clean up by hand.

That is the field incident's residue, reproduced: **a stranded sheet turns `make-repeating` into a clone generator.** The guard that saves `reschedule-repeat` lives inside the ui recipe, which a composite reaches only after its URL and AppleScript legs have already run.

## 4. Chord reorder with the sheet standing (M3)

`project move-heading MODALX1-HD-B --first --dangerously-drive-gui` (#606, the arrow-chord ui vector). The reveal and the content-table canary both **pass** — a sheet does not remove the project view from the tree — the chord is posted, and the **verified read-back catches that nothing moved**:

```
ui drive stopped at "reorder 1 heading(s) with the arrow chords" (⌘⌥↑ did not move
the heading — it is at position 3 of 3 and the app declined the chord …, or the row
selection was lost. The drive stopped rather than re-sending it).
```

Index map byte-identical before and after (`HD-C:-873, HD-A:-374, HD-B:-185`), exit 3, zero mutation, **0 beeps** — a chord posted at the process while a sheet stands is swallowed *silently*, unlike a System Events keystroke (§7). Verdict: **BLOCKED, and refused safely by the read-back, not by any sheet awareness.** The error copy offers two hypotheses (boundary row / lost selection) and never mentions a modal, so the operator is pointed away from the actual cause.

## 5. Reads (M4)

`things today`, `things show <uuid>` and `things doctor` all exit 0 in **≤1 s** with the sheet standing and return correct content — as expected, since every read is a direct SQLite read. No degradation, no timeout, no beeps.

**Doctor sees nothing.** `things doctor` output was grepped for `sheet|modal|dialog`: no match. It reports `app: installed (Things 3.23)`, `writes: enabled`, and under sync-health `foreground: the app was last frontmost 25s ago` and `cloud: no Things Cloud account attached` — nothing that would let a user, or us, notice that the app is wedged behind a modal. #620's read-only `ui-state` is not merged, so the only oracle available today is raw AX:

```
SHEETS=1
  SHEET 1 desc="" text="after previous item is checked off. | Repeat"
          buttons=[OK, Cancel] popups=["week", "after completion"]
FRONTMOST=Things3
  FOCUSED=[6] role=AXCell @[284,89 695x28]
```

Note the sheet carries **no `AXTitle` and no `AXDescription`** — semantic identification has to come from its controls and static text, which is exactly the shape `ui-state` will need. The URL-consent alert, by contrast, does carry `desc="alert"`.

## 6. Sheet stacking, and the menu bar (M7)

**Nothing inside the app can raise a second sheet.** With one standing:

- a second `Items ▸ Repeat…` → **`-1728 Can't get menu item "Repeat…" of menu "Items"`**. The menu bar is not merely *disabled*: its items are not enumerable at all (`ax menuenabled` reads `Can't get object`). Sheets remain at 1.
- `⌘⌫` (trash the selected row) → swallowed, sheets stay 1, **one alert beep**.
- `⌘⇧⌫` (Empty Trash, whose confirmation is itself a sheet) → swallowed, sheets stay 1, **one alert beep**.

**The URL scheme is the one path that gets through**, because it enters from outside the app's own event queue. With `uriSchemeEnabled` flipped off ([URLEN1](urlen1-url-enable.md)'s recipe) and the Repeat sheet standing, two dispatched `things:///add` URLs took the census from `SHEETS=1` → `2` → `3`.

They stack as **nested `AXSheet` children of the sheet below**, not as siblings on the window:

```
AXSheet @[239,250 545x233]                 <- the Repeat dialog
  … its controls …
  AXSheet desc=alert id=_NS:91             <- URL consent #1
    AXStaticText  Things URL Scheme
    AXButton      Cancel #action-button-2
    AXButton      Enable #action-button-1
    AXSheet desc=alert id=_NS:91           <- URL consent #2, inside #1
      …
```

A sheet census that walks the tree finds all three; a census that only looks at a window's *own* sheet finds one. **Dismissal is strictly LIFO** — Escape → 2, Escape → 1, Escape → 0, innermost first, the Repeat dialog last; a fourth Escape is a no-op. The parked URL adds did **not** land (no `MODALX1-m7-stack-*` rows survived), matching URLEN1: Escape/Cancel discards a held command.

## 7. Beeps

**2 for the entire run**, both in M7, three seconds apart, matching `⌘⌫` and `⌘⇧⌫` exactly. Every other cell was clean, including all five collision drives.

The discriminator is worth recording, because it bears directly on what a guard can detect: **a keyboard chord sent through System Events to a sheet-blocked app beeps; nothing else does.** Not the swallowed arrow chord posted at the process (M3, 0 beeps), not an Escape, not a URL, not an AppleScript command, not a timed-out Shortcuts run. A beep is therefore a *sufficient* but far from *necessary* signal that a gesture was declined.

## 8. User collisions with a live drive (M5)

The rig backgrounds a real `todo make-repeating --frequency daily --interval 3` drive and injects **one** keystroke at a chosen phase, both inside a single ssh invocation that `wait`s (no orphaned process, ever). The 12-step drive's phases: ~0–4 s reveal + select, ~4–8 s menu press and sheet, ~8–15 s field entry, then audit and OK.

| Cell | Injection | Drive outcome | What caught it | Residue |
|---|---|---|---|---|
| M5a-esc-early | `key code 53` @ 3 s | exit 3, stopped at `interval = 3` | next AX step: **`-1719` Can't get sheet 1 of window "Upcoming"** | clone leaked (reported); original restored from Trash; **no sheet stranded** |
| M5a-esc-sheet | `key code 53` @ 7 s | exit 3, stopped at `let the first-occurrence pop-up absorb the rule` | **`-1719` Can't get sheet 1 … AXStandardWindow** | same |
| M5a-esc-late | `key code 53` @ 12 s | **exit 0, landed correctly** | n/a — OK had already been pressed | none |
| M5b-char-sheet | `keystroke "7"` @ 7 s | exit 3, stopped at the pre-commit audit | **the audit**: *"1 control(s) differ: interval = 3 (intended "3", dialog shows "7")"* | same |
| M5b-char-late | `keystroke "7"` @ 12 s | **exit 0, landed correctly** | n/a — already committed | none |

Three findings.

1. **A user's Escape is caught deterministically by the very next element resolution**, and the signature is always `-1719 … Invalid index` on the sheet lookup. The drive fails closed, reports honestly, restores the original from the Trash, and — measured every time — **confirms its own cleanup**: *"The open sheet/popover was dismissed (Escape, confirmed gone)."* Sheet census after each abort: `SHEETS=0`.
2. **A stray character is caught by the pre-commit audit, and the drive refuses rather than retyping.** The closed loop reads the dialog back, sees `7` where it typed `3`, and commits nothing. That is the AX-drive-scrutiny doctrine's stated fail direction working on a live corruption, not a hypothetical one.
3. **The window in which a collision matters is narrow and closes at OK.** Once the commit keystroke has gone in, a late Escape or stray character is inert.

**An honest negative: the field's stranded sheet did NOT reproduce.** Across five collisions the drive's own abort path dismissed its sheet and verified the dismissal every time. The field stranding rode on the 1002 *"osascript is not allowed to send keystrokes"* failure — an identity/permission fault the lab escape cannot produce, since the clone's AXVM1 grant never revokes mid-drive. The stranding mechanism therefore remains #620's own to reproduce; what MODALX1 certifies is everything that *follows* from a sheet once it is standing, however it got there.

## 9. Sync-gating local signature (M6) — NOT certified, and why

The field law is recorded at [oddities §24](../things-app-oddities.md) (field-measured, two devices) — this cell was the attempt to reach it single-device, and it does not.

**`BSSyncronyMetadata` holds 0 rows on golden-v4** (confirmed by direct count; the table only populates when an account is attached — [headless-research](headless-research.md) §SYNC1). The field report's exact observable does not exist in this clone, and Things emits **no `com.culturedcode.*` os_log subsystem** ([headless-research](headless-research.md) §SYNC2), so there is no log-side substitute either. **Cell 6 does not corroborate the field law, and nothing here should be read as if it did.** The durable-account two-device cell stays queued.

Two adjacent facts were measured and are worth keeping, because they *bound* the field law rather than confirming it:

- **The local commit is NOT gated.** A `things:///add` dispatched with the sheet standing had its row in the database in **~1 s**, same as the control. Whatever the sheet gates is therefore strictly **downstream of the local commit** — which is consistent with the field observation that a write landed locally and simply did not go out.
- **The app's scripting object model IS gated** (§2.1) while its data layer stays fully live. So the sheet demonstrably freezes a class of app-level machinery without touching persistence. That is *the same shape* a gated sync-out queue would have — a suggestive parallel, and explicitly **not** evidence for it.

## 10. Recommendations

### Becomes a #620 guard requirement

1. **Move the sheet check to the front of the composite orchestrator, before any leg runs.** This is the campaign's headline. `sheetStillOpen()` exists in `src/write/vectors/ui.ts` and is reachable only (a) as a post-hoc diagnosis after the recipe canary misses and (b) in the abort cleanup. A composite (`src/write/promote-clone.ts`) runs a URL leg and an AppleScript leg *first*, so with a sheet standing it creates a disposable clone and then cannot trash the original — §3, reproduced. The pre-flight belongs where the composite starts, not inside the last leg.
2. **Teach the `-1728 Can't get <kind> id "…"` error its real meaning.** Any AppleScript-vector failure with that code, on a uuid the database shows present, should be reported as *"a modal sheet is open in Things — dismiss it and retry"*, not as a missing item. This single mapping resolves #620's ghost clone at the point of failure (§2.2).
3. **Same for the chord driver's read-back miss.** M3's copy blames a boundary row or a lost selection and never suspects a modal (§4). It should consult the same sheet probe before choosing its explanation.
4. **`ui-state` must census sheets by walking the tree, and identify them from their controls.** Nested stacking (§6) means a window's own `sheet 1` is not the whole story, and the Repeat sheet carries no `AXTitle`/`AXDescription` at all (§5) — semantic identification has to come from static text and button titles. It should also report the LIFO depth, since clearing a stack needs one Escape per level.
5. **Doctor should surface an open sheet.** Today it reports a perfectly healthy app while the app is wedged (§5). Given the field sync-gating report, an open-sheet row in doctor's sync-health section is the cheapest possible mitigation.
6. **Do not treat "no beep" as "no problem".** Only System Events keyboard chords beep (§7); swallowed process-posted chords, Escapes, URLs and AppleScript all fail silently. A beep sentinel is a useful alarm and a useless all-clear.

### Becomes a new refusal precondition

7. **"Refuse GUI drives when any sheet is open" — measured, and the answer is *partly already true*.** Pure-ui dialog ops (`reschedule-repeat`, and by construction every recipe whose canary needs the menu bar) already refuse cleanly with zero mutation and the correct remediation copy (§3) — that behavior is certified by this campaign and should be kept exactly as it is. Composites do **not**, and that is the gap to close (item 1). The chord recipes are a third case: their canary passes with a sheet up, so they need the precondition added explicitly rather than inherited.
8. **A refusal precondition is *not* needed for the URL, Shortcuts or read paths.** URL writes land normally, Shortcuts times out cleanly at 30 s without parking, and reads are unaffected (§2). Refusing them would cost availability for nothing.

### Unrelated follow-up opened by this campaign

9. **`todo make-repeating --when <today>` is broken** (§1): the pre-commit audit compares its typed ISO date against the dialog's relative rendering "Today" and refuses every time. Fix is in the audit's comparison (accept the app's relative rendering for the current date), not in the recipe. Fails safe, but the operation is unusable on its most natural input.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart lab/scripts/research-modalx1.sh setup
TART_HOME=/Volumes/Workspace/tart lab/scripts/research-modalx1.sh run
TART_HOME=/Volumes/Workspace/tart CELLS="M1B M1C" lab/scripts/research-modalx1.sh run
TART_HOME=/Volumes/Workspace/tart lab/scripts/research-modalx1.sh teardown
```

Artifacts (gitignored): `lab/artifacts/modalx1-lab/` — `report.txt` (the full transcript), `ax/*.txt` (sheet and window dumps per cell, including the three-deep stack).
