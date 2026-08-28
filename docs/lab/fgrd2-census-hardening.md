# FGRD2 — the window-state census rebuilt on addressed queries (issue #629), and a 3.23 → 3.23.1 AX census

**Version stamp:** TWO arms, one campaign, run back to back on 2026-08-27.

| arm | VM | Things | build | golden |
|---|---|---|---|---|
| **A** (the new build) | `fgrd2-3231` | **3.23.1** | **32301002** (direct channel) | `things-lab-golden-v4` clone, `/Applications/Things3.app` swapped in place |
| **B** (no-regression) | `fgrd2-323` | **3.23** | **32300036** | plain `things-lab-golden-v4` clone |

Both: macOS **15.7.7** · `Meta.databaseVersion` **27** · guest clock pinned **2026-07-05 12:00** and never rolled (trial wall 2026-07-18) · airgapped · fixtures fully synthetic (`FGRD2-*`) · both lab escapes exported (`THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1`) · production CLI built from this branch and shipped into each guest (`dist/` + node + commander) · **beep sentinel default-on: 0 beeps on each arm** · both clones destroyed on teardown. The golden was never booted. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-fgrd2.sh`](../../lab/scripts/research-fgrd2.sh) (`setup` / `ship` / `probe` / `hang` / `axdump` / `wedge` / `cells` / `teardown`; `SWAP=1` performs the in-place 3.23.1 swap).

**The 3.23.1 installer is banked** at `/Volumes/Workspace/things-releases/Things3-3.23.1-32301002.zip` (sha256 `94ccc20f3b0f2700eb227c1a17f5c32e3f6b4811c1b5cc66631feb0bad028a1c`), per the [update runbook](things-update-runbook.md) step 2 — the download URL is unversioned and old builds vanish. The maintainer's host runs the **MAS** build **32301502**; the direct channel serves **32301002**. Same marketing version, same channel offset as 3.23 (036 direct / 536 MAS).

---

## 0. What was under test

Field incident (issue [#629](https://github.com/mikegreiling/things-api/issues/629), things 0.19.2 on Things 3.23.1 / macOS 15.4.1, helpers healthy): `todo add-repeating` and `todo make-repeating` both stalled at the FIRST keystroke-class step under #627's guards. Every element-addressed transport before it reported `ok:true` — inside the very sheet the inspection could not describe. Then ~15 s per inspection, ~56 s total, `verify-failed:ui-unreachable`, nothing typed. The cleanup could not identify the sheet either (same inspection), so it left the sheet standing; while it stood the disposable clone could not be trashed (`-1728`, the sheet-empties-collections law, [MODALX1 §2.1](modalx1-open-sheet-matrix.md)) and Things Cloud sync was held ([oddities §24](../things-app-oddities.md)). `things ui-state` returned `state: null` throughout, and worked immediately before the drive and immediately after a manual Cancel.

---

## 1. The query-shape diagnosis, from the code

One script in the whole ui vector leaves the addressed style, and it is the one that stalled.

| script | shape | in the field log |
|---|---|---|
| every recipe step (`ui-recipes.ts`) | `tell process "Things3" to … sheet 1 of (first window whose subrole is "AXStandardWindow")` — **addressed** | `ok:true`, repeatedly, inside the sheet |
| `axCancelDialogScript`, `axSheetOpenScript`, `axResolveScript`, … | `SE = tell application "System Events" to tell process "Things3"` — **addressed** | (not reached) |
| **`axUiStateScript` (the census)** | opens with `set fp to first application process whose frontmost is true` (the whole process table enumerated) and then `set fe to value of attribute "AXFocusedUIElement" of fp` (a **system-wide focused-element resolution**), neither addressed at anything | **stalled** |

Two further properties made one stall into a 56-second one that stranded the sheet:

- **No Apple-event budget anywhere.** osascript's default Apple-event timeout is two minutes, so a System Events call that does not come back is bounded only by the caller's own 15 s process deadline (`STEP_TIMEOUT_MS`). That is the ~15 s the field measured, per inspection.
- **The cleanup ladder's first move was to run the same census again.** `clearDialog` read the census (15 s), got `null`, therefore treated the screen as unreadable, skipped the Cancel rung *because it could not confirm what was open*, and fell through to the AX-blind close+reopen — which read the census once more (15 s). Three inspections, ~56 s, nothing learned, and the sheet still up.

**Diagnosis:** the offending construct is the census's unaddressed opening pair, and the amplifier is that the census sits on the critical path of BOTH the guard and the recovery from the guard.

---

## 2. What the lab could and could not reproduce — the honest negatives

The stall itself **does not reproduce headless on 3.23.1**. Every candidate was timed individually against a standing Repeat sheet (`probe` and `hang` cells; median of the readings, guest-side, `osascript` process time):

| construct | small tree, no sheet | small tree, **sheet open** | big tree, no sheet | big tree, **sheet open** |
|---|---|---|---|---|
| `count of application processes` (30–32 processes) | 192 ms | 52 ms | 53 ms | 51 ms |
| **A** `name of first application process whose frontmost is true` | 61 | 54 | 56 | 53 |
| **B** `value of attribute "AXFocusedUIElement" of fp` (ref only) | 85 | 187 | 67 | 173 |
| **B2** …+ `role of fe` (system-wide) | 72 | **180** | 71 | **175** |
| **B3** the same, addressed at `process "Things3"` | 67 | **169** | 64 | **180** |
| **F** `frontmost of process "Things3"` (addressed) | 47 | 52 | 51 | 47 |
| **C** `exists sheet 1 of (first window whose subrole is "AXStandardWindow")` | 52 | 53 | 54 | 53 |
| **E** `windows whose subrole is "AXUnknown" and size is not {40, 40}` | 51 | 54 | 54 | 57 |
| **D** the sheet's control census (5 counts) | — | 96 | — | 101 |
| **G** `value of pop up button 1 of <sheet>` (a working drive step) | — | 59 | — | 60 |
| `things ui-state` end to end (incl. ssh) | 402 | 593 | 426 | 604 |

"Big tree" is **1,227 AX rows** in the content table (1,200 synthetic to-dos seeded into Anytime, plus the golden's own).

Three hypotheses formed from the code, and **all three were refuted by measurement**:

1. **Tree size.** A 1,227-row table moves nothing. The focused-element resolution costs the same 175 ms with 35 rows and with 1,227.
2. **An unresponsive process in the table.** `SIGSTOP` on a running GUI application (TextEdit) and re-run: the enumeration stayed at 61 ms, unchanged across a control / frozen / frozen-again / resumed sequence. System Events reads `frontmost` from the process list, not by an Accessibility round-trip per process, so one wedged app does not stall it.
3. **The app version.** 3.23.1 behaves identically to 3.23 on every construct — see §4.

**So the trigger lives on the field host, not in the app version and not in the AX tree size.** What that host has and this clone cannot: a real display session, the MAS build (32301502), a process/window population several times larger, and the deputy transport. This campaign does not identify which. What it does establish is the *class*: the only slow construct anywhere in the census is **B/B2/B3 — the focused-element resolution, measured at ~3.5× every addressed read in this vector even on a bare clone** — and it is decoration, while everything the guard actually decides on is addressed and costs ~50 ms.

The fix is therefore **structural rather than targeted**, which is also what makes it safe: the unaddressed constructs come off the decision path, every read gets a budget, and a read that does not answer routes to a recovery that does not depend on it. That closes the failure whatever the trigger turns out to be.

### 2.1 The failure MODE, reproduced deterministically (cell `wedge`)

What the lab *can* stage is an inspection that will not answer: `SIGSTOP` on the **System Events** process itself, with the Repeat sheet standing. One `things ui-state`, timed, then `SIGCONT`.

```
0.19.2 (shipped)        elapsed_ms=15143
                        state: null
                        detail: "the window and focus state could not be read — Things may have
                                 stopped answering, or a system dialog is covering the screen"

this branch             elapsed_ms=2201   (3.23.1)   ·   elapsed_ms=2187   (3.23)
                        state: { thingsRunning:false, sheetKind:"none", …,
                                 stalledProbes:["running"], failedProbes:[] }
                        detail: "nothing about the screen could be established — did not answer in
                                 time: whether Things is running"
                        remediation: ["one or more of the screen reads did not answer; check that
                                       Things is responding, then run this again"]
```

The 0.19.2 line is the field report's `ui-state` observation **verbatim** — the same sentence, the same `state: null`, the same ~15 s. That is the mode closed here: **15.1 s → 2.2 s, and a null replaced by a named, actionable partial verdict.** Thawed, both arms return the full census in ~250 ms.

---

## 3. The certification set — both builds, identical results

Run on each arm from the production CLI built from this branch. `F` is the exact command shape the field incident died on.

| cell | what | 3.23.1 (32301002) | 3.23 (32300036) |
|---|---|---|---|
| **F1** | `todo add-repeating <synthetic> --when 2026-07-10 --frequency monthly --interval 1 --after-completion --dangerously-drive-gui` | **exit 0**, `vector: ui`, *"the series repeats every month after each occurrence is completed"*; 1 template row, **1 total row** (no leaked clone); census after: no dialog | **exit 0**, identical |
| **U3** | `ui-state`, Repeat sheet open, Things frontmost | `sheetKind: repeat` (`attached`, `cb:2 pu:1 bt:2 gp:1 tf:0`, depth 1), `focusOwner: Things3 · AXPopUpButton`, `stalledProbes: []` | identical |
| **U4** | the same sheet, **Finder** frontmost | `sheetKind: repeat`, `thingsFrontmost: false`, `focusOwner: Finder · AXGroup` — the sheet is still named | identical |
| **U1** | `ui-state`, nothing open | `sheetKind: none`, `focusOwner: Things3 · AXTable` | identical |
| **G1** | focus theft mid-drive (Finder activated the instant the dialog appears, closed loop on its existence) | refused at `interval = 3`: *"Finder is frontmost and keyboard focus is on a AXGroup … nothing was sent"*; **nothing typed**; target not repeating; **1 row** (no leaked clone); *"the repeat dialog was closed with its own Cancel button, confirmed closed"* | identical |
| **S1** | the stranded-sheet recovery: the same abort, focus never returned | **sheets standing after cleanup: 0** (zero manual action); the disposable clone trashed (1 live row, 1 trashed); target not repeating | identical |
| — | beep sentinel | **0** | **0** |

`S1` is the field's residue closed at both ends: the sheet goes (so the app's scripting object model is released and Things Cloud sync is not held), and the composite's disposable copy is trashed **after** the dismissal, which is the ordering the sheet-empties-collections law requires.

---

## 4. The 3.23 → 3.23.1 census diff — the golden-v5 seed

Dumped from the live tree on both arms (`axdump`) and diffed. **The two files are byte-identical except for the version line.**

```
-Things 3.23 (32300036)
+Things 3.23.1 (32301002)
 macOS 15.7.7
 databaseVersion 27
 sdef 1b6752334207f68cdcb7e71dfc34a21407095bd239afe5df6b3cdd8e2c70cde0
 LSMinimumSystemVersion 13.3
```

| surface | 3.23 | 3.23.1 |
|---|---|---|
| `Meta.databaseVersion` | 27 | **27** (the in-place swap ran a warm-up launch; no migration) |
| `Things.sdef` sha256 | `1b675233…` | **identical** — zero new scripting surface, unchanged since 3.22.11 |
| `LSMinimumSystemVersion` | 13.3 | 13.3 |
| `Items` menu, item names | `When… · Move… · Tags… · Deadline… · Complete · Shortcuts · Repeat… · Get Info · Convert to Project… · Remove From Project/Area · Remove From Contact · Show in Area · Share… · Log Completed` | **identical, same order** |
| top-level windows | `AXUnknown` (the 40×40 utility window) + `AXStandardWindow` | identical |
| Repeat sheet | `AXSheet` 545×233 → `AXCheckBox` "Add reminders" · `AXCheckBox` "Add deadlines" · `AXGroup` (`AXPopUpButton`, `AXStaticText` "after previous item is checked off.", `AXTextField`) · `AXStaticText` "Repeat" · `AXPopUpButton` · `AXButton` OK · `AXButton` Cancel · `AXImage` | **identical, element for element, size for size** |
| control census (`ui-state`) | `cb:2 pu:1 bt:2 gp:1 tf:0` | identical |
| focused element on open | `AXPopUpButton` | identical |
| dialog shape probe | `next-popup` | identical (F1 drove the same recipe to `exit 0` on both) |
| every timing in §2 | — | within noise of 3.23 |

**Recommendation for the golden-v5 decision (the maintainer's ruling, not this campaign's):** on every surface this project addresses, 3.23.1 is indistinguishable from 3.23. That is an argument for the cheap [DRIFT-1 in-place swap](drift-runbook.md) path rather than a fresh mint — and it is also an argument that **neither** #629 nor its predecessor was actually caused by the version bump, which weakens the "second 3.23.1-specific surprise" framing that opened the queue item. Two field incidents on 3.23.1 whose lab arms both come back version-identical point at the field HOST (display session, MAS build, process population, deputy transport), not at the app.

Caveat on the swap: this clone runs the **direct-channel** 32301002, not the maintainer's MAS 32301502. The channel offset has never carried a behavioral difference (3.23: 036 vs 536, `sdefIdenticalToMas: true`), but it has not been proven for 3.23.1 either.

---

## 5. What this campaign does NOT establish

- **The field trigger.** Three mechanisms were tested and refuted (§2); none of the remaining candidates — a real display session, MAS 32301502, a large process/window population, the deputy transport — can be staged on a headless airgapped clone. The stall is closed by construction, not explained.
- **The deputy path.** Both arms run the lab escapes, i.e. `osascript` direct. The field ran every hop through the deputy. Nothing here exercises the census over that transport.
- **The pointer fallback for Cancel.** The AXPress rung cleared the dialog on every live cell, so the CGEvent-at-AX-frame fallback below it is unit-covered only (`test/engine/write-ui-vector.test.ts`) — the same posture #620 took for the `inspectable: false` branch.
- **Anything about 3.23.1 beyond the surfaces in §4.** This was a targeted census, not a recertification: `npm run lab:regress` against a 3.23.1 golden is the [update runbook](things-update-runbook.md) step 10 and remains queued.

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 SWAP=1 lab/scripts/research-fgrd2.sh setup
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 lab/scripts/research-fgrd2.sh ship
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 lab/scripts/research-fgrd2.sh probe   # §2 timings
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 lab/scripts/research-fgrd2.sh hang    # §2 frozen-process control
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 lab/scripts/research-fgrd2.sh wedge   # §2.1
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 lab/scripts/research-fgrd2.sh cells   # §3
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 lab/scripts/research-fgrd2.sh axdump  # §4
TART_HOME=/Volumes/Workspace/tart VM=fgrd2-3231 lab/scripts/research-fgrd2.sh teardown

TART_HOME=/Volumes/Workspace/tart VM=fgrd2-323 lab/scripts/research-fgrd2.sh setup    # arm B, no SWAP
```

Artifacts (gitignored): `lab/artifacts/fgrd2-3231/` and `lab/artifacts/fgrd2-323/` — `report.txt` (the full transcript), `axcensus.txt` (§4), per-cell JSON.
