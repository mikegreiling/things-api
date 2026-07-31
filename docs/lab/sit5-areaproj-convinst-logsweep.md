# SIT5 — the area-direct day residual, the repeating-instance convert, the logbook×trash intersection, the future-project read

Sitting 5 closes the #342 residual (do area-DIRECT project rows join the `day` membership?), characterises the GUI **Convert-to-Project** transform on a live repeating INSTANCE (FK fate + Show Latest + our reader's sanity), confirms an SL2-adjacent logbook/trash read law, and pins the read-representation of future-scheduled PROJECT rows — four arms in ONE disposable clone:

- **AREAPROJDAY** — the #342 residual: SIT4 DAYBNC proved the dated `day` bounce for loose to-dos, headed children, and AREA-LESS project rows, but **area-direct project rows were excluded conservatively (unproven)**. Do they join day membership (front-insert at the global `todayIndex` min) with their area FK preserved?
- **CONVINST** — convert a repeating INSTANCE to a project via the GUI: FK fate (`rt1_repeatingTemplate` survives or clears?), uuid/type change, the template's Show Latest resolution, and whether our `repeating.latestInstance` / `instanceOf` derivation handles the converted row sanely (no crash, no lie).
- **LOGSWEEP** — the logbook-sweep × trashed intersection: which of completed-only / completed-then-trashed / trashed-then-completed lands in Logbook vs Trash, GUI vs raw flags vs our `things logbook`/`things trash` reads.
- **FUTPROJ** — the read-representation of future-scheduled PROJECT rows in Upcoming: GUI day-group rendering vs `things upcoming` / `things projects --show-later` wire output.

One offline Tart clone (`sit5-lab`, run 2026-07-31, Things **3.22.11**, macOS **15.7.7** Sequoia, DB schema **26**, pinned clock **2026-07-05 12:00**; ordering is local — no cloud account). Script: [`lab/scripts/research-sit5.sh`](../../lab/scripts/research-sit5.sh) (subcommands `setup` / `arm1` / `arm1c` / `arm3` / `arm3b` / `arm4` / `arm4-shot` / `arm2-grant` / `arm2rec` / `arm2menus` / `arm2convert` / `arm2read` / `arm2-showlatest` / `teardown`). Arms **1 / 3 / 4 are HEADLESS** (URL scheme + AppleScript). **CONVINST needs Accessibility** (granted per-clone via the AXVM1 rung-b VNC toggle) and drives the GUI convert through System-Events menu clicking + a VNC dialog confirm. Read-side CLI checks run on the **HOST** against a pulled copy of the guest DB (`node bin/things.js … --db <copy>` with `THINGS_NOW=2026-07-05T12:00:00` so the host wall-clock does not misclassify the future day). Test days: DAYBNC/FUTPROJ D = **2026-07-19** (+14d), D′ = **2026-07-20** (+15d, staging); LOGSWEEP/CONVINST operate on the pinned today **2026-07-05**. Dates seeded via URL `when=<ISO>` (the app packs `startDate`); every value read back raw from SQLite — **no hand-packed date integers** (`encodePackedDate` discipline). All bounce targets are SCRAMBLED so a passing final order proves the sequence CONTROLS placement.

**Status: RAN + BANKED.** Headlines:

1. **AREAPROJDAY = AREA-DIRECT project rows DO join the `day` membership — the #342 residual is resolved.** `update-project?when=<D>` works for an area'd project (spelling confirmed): it sets `start=2` + `startDate=D` and **preserves the area FK**. The dated bounce (`update-project?when=D′`→`when=D`) preserves the area FK through BOTH legs and re-enters at the day-D GLOBAL `todayIndex` min — **below every same-day row including the loose to-dos** (PA re-entered at −2082, below the seed min T3 −1725). A full scrambled 5-row bounce (PA mid-target) landed the exact target order **T2, PB, PA, T1, T3** TWICE (repeatable), area FK intact each pass. So the planner's day membership-predicate can be relaxed to include area-direct project rows: they front-insert on the one shared global day axis exactly like area-less project rows and to-dos, with no area-FK loss.
2. **CONVINST = GUI Convert-to-Project on an instance MINTS A NEW ROW and SEVERS the series — clean for our reader, no lie, no crash.** Items ▸ "Convert to Project…" (a confirm-dialog menu op) on the current instance: the **old instance uuid is DELETED** (0 rows), a **NEW project row is born** (new uuid, `type` 0→1, brand-new `creationDate` = the conversion wall-clock), inheriting the title + `startDate` (+ `start=1`, Today-member); the **`rt1_repeatingTemplate` FK is CLEARED**. The template and the sibling instances are **untouched** (rule intact, `nextInstanceStartDate` unchanged). Because the FK is gone, our `latestInstanceUuid` correctly resolves the template's **Show Latest to the newest REMAINING true instance** (not the converted project), `things <converted-uuid>` is a plain project-view (no `instanceOf`, no `repeating`), and `upcoming`/`today` do not crash. The one automation-relevant surprise: the new uuid + new creationDate mean any external reference to the pre-convert instance uuid dangles.
3. **LOGSWEEP = completed-not-trashed → Logbook only; completed-then-trashed AND trashed-then-completed → Trash only. Our reads match exactly.** With immediate sweep (`logInterval=0`), the terminal shape of both trash-vs-complete orderings is identical (`status=3`, `trashed=1`), and our `LIVE`(trashed=0) logbook gate + `trashed=1` trash view route both to Trash and the completed-only row to Logbook — byte-parity with the SL2 L1 GUI law, no divergence. A new AppleScript quirk fell out (headline 4).
4. **FUTPROJ = future-scheduled PROJECT rows render in the Upcoming day-group interleaved with to-dos by `todayIndex` — GUI and `things upcoming` agree byte-for-byte.** The GUI July-19 group and our wire output both order the mixed group **FPAL, T2, PB, PA, T1, T3** (area-less project FPAL/PB, area'd project PA showing its area "S5A", and to-dos, all on the one shared `todayIndex` axis). Zero divergence; `things projects --show-later` additionally lists all three future projects with `when=2026-07-19`, `stage=upcoming`.

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **AREAPROJDAY** — the #342 residual | do area-DIRECT project rows join the `day` membership (front-insert at the global `todayIndex` min) with the area FK preserved? | **YES.** `update-project?when=<D>` schedules an area'd project preserving the area FK; the dated bounce preserves it through both legs and front-inserts at the day-D GLOBAL min (below to-dos too, PA −2082 < T3 −1725); a scrambled 5-row bounce landed the exact order T2,PB,PA,T1,T3 ×2, area FK intact. The planner day-predicate can include area-direct project rows. |
| **CONVINST** — convert a repeating instance | FK fate, type/uuid change, Show Latest, our reader's sanity | **NEW ROW + FK SEVERED, reader clean.** Old instance uuid deleted; new project row (new uuid, type 0→1, new creationDate=conversion time) inherits title+startDate; `rt1_repeatingTemplate` CLEARED; template+siblings untouched. Our `latestInstance` → newest remaining instance (not the convert); `things <converted>` is a plain project (no `instanceOf`/`repeating`); `upcoming`/`today` no crash. No headless convert surface exists (menu-only). |
| **LOGSWEEP** — logbook × trashed | completed / completed-then-trashed / trashed-then-completed membership, GUI vs our reads | **completed-not-trashed → Logbook only; completed-then-trashed & trashed-then-completed → Trash only (identical terminal shape status=3/trashed=1). Our reads = exact parity.** `LIVE`(trashed=0) logbook gate + `trashed=1` trash view match the SL2 L1 GUI law; no read-layer fix needed. |
| **FUTPROJ** — future project read repr | GUI Upcoming day-group vs `things upcoming`/`projects --show-later` | **BYTE-PARITY.** Future-scheduled project rows (area-less + area-direct) render in the Upcoming day-group interleaved with to-dos by `todayIndex`; GUI and CLI both order FPAL,T2,PB,PA,T1,T3. `projects --show-later` lists them with `when`/`stage=upcoming`. No divergence. |

## Per-arm detail

### AREAPROJDAY — area-direct project rows in the `day` membership (D = 2026-07-19, D′ = 2026-07-20)

**(a) Seed + spelling confirm.** Area `S5A` (`NeMWkz4s`) created via AppleScript (URL cannot create areas). An **area-direct** project `PA` (`add-project?title=PA&area=S5A` → `a=NeMWkz4s`, unscheduled `st=1 sd=-`), then `update-project?id=PA&when=D`:

```
PA before schedule:  ty=1 st=1 sd=-         sb=0 a=NeMWkz4s
PA after when=D:     ty=1 st=2 sd=132807040 sb=0 a=NeMWkz4s   ← area FK KEPT, start=2, startDate=D set
```

So `update-project?when=<date>` on an area'd project **works and preserves the area FK** — the spelling is sound. Same-day group seeded: area-less project `PB` (`add-project?when=D`), loose to-dos `T1`/`T2` (`add?when=D`), and an area-direct to-do `T3` (`add?when=D&list=S5A` → `a=NeMWkz4s`). Seed `todayIndex` (most-negative = top; each new same-day add front-inserts below the group min):

| row | type | area | seed todayIndex |
|---|---|---|---|
| T3 | 0 (to-do) | S5A | −1725 |
| T2 | 0 (to-do) | — | −1308 |
| T1 | 0 (to-do) | — | −917 |
| PB | 1 (project) | — | −563 |
| PA | 1 (project) | S5A | 0 |

**(b) The dated bounce law on the area-direct project PA.** `update-project?when=D′` then `when=D`:

- on D′: `a=NeMWkz4s` PRESERVED, `sd=132807168` (D′), `start=2`.
- back on D: `a=NeMWkz4s` PRESERVED, `start=2`, `sd=132807040` (D) restored, `todayIndex` **−2082** — **below the day-D global min** (the seed top T3 −1725). FRONT-INSERT at the global day axis, below the loose to-dos, area FK intact through both legs.

**(c) Full scrambled 5-row bounce (PA mid-target), ×2.** Target cross-container order **T2, PB, PA, T1, T3** (PA in the middle); processed in REVERSE (T3, T1, PA, PB, T2), each item `when=D′` then `when=D` (to-dos via `update`, projects via `update-project`). Final raw `todayIndex` (merged, ascending):

| pass | position 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| **1** | T2 (−4806) | PB (−4237) | PA (−3760) | T1 (−3264) | T3 (−2649) |
| **2** | T2 (−7062) | PB (−6692) | PA (−6158) | T1 (−5684) | T3 (−5238) |

**EXACT match to the target both passes** — the scramble proves sequence controls placement. PA's area FK `NeMWkz4s` was intact after each pass. PB (area-less project) and PA (area-direct project) interleave with the to-dos on the one shared axis identically.

**(d) Verdict.** Area-direct project rows join the `day` membership: `update-project?when=<D>` preserves the area FK and the dated bounce front-inserts them at the global `todayIndex` min alongside to-dos and area-less project rows. **The SIT4 DAYBNC conservative exclusion of area-direct project rows is LIFTED** — the planner change is a single membership-predicate relaxation (area-direct project rows are now proven `day` members, no area-FK loss, no scratch machinery). Evidence only — NOT wired.

### CONVINST — convert a repeating instance to a project (pinned today 2026-07-05)

**(a) Template + instances.** The golden's `LAB-REPEAT-DAILY` daily template `W3PZB9e7` (`rt1_recurrenceRule` SET, `type=0`) with three spawned instances (`rt1_repeatingTemplate=W3PZB9e7`), the current = max `creationDate`:

| uuid | type | FK | rule | creationDate |
|---|---|---|---|---|
| 11NNVsNH | 0 | W3PZB9e7 | − | 1783036800 |
| **W3PZB9e7** (template) | 0 | − | SET | 1783055420 |
| RAAMrEWr | 0 | W3PZB9e7 | − | 1783123200 |
| **QKbe1HaA** (current instance) | 0 | W3PZB9e7 | − | 1783209600 |

**(b) The GUI convert recipe (no headless surface).** No URL/AppleScript/Shortcuts convert exists; the ONLY surface is **Items ▸ "Convert to Project…"** (AX menu enumeration — the item carries a Unicode ellipsis "…", i.e. it opens a confirm dialog). Recipe: `things:///show?id=<instance>` to select the row (it navigates to Today, where the current instance is a member), then AX `click menu item "Convert to Project…" of menu 1 of menu bar item "Items" of menu bar 1` (menu item is `enabled=true` with the instance selected) → a confirm dialog *"Convert to Project — Are you sure you want to convert this to-do into a project?"* `[Cancel | Convert]` → click **Convert** (VNC). Accessibility granted per the AXVM1 rung-b toggle. §7 crash-class caution honored: Things `pgrep` ALIVE before, after the menu click, and after the confirm — **no crash**.

**(c) Post-convert reads (the FK fate).**

```
BEFORE  QKbe1HaA ty=0 fk=W3PZB9e7 rule=-               (the current instance)
AFTER   <QKbe1HaA gone: 0 rows>                        (old uuid DELETED, not trashed)
AFTER   DT335Gso ty=1 fk=-        rule=- status=0 tr=0 (a NEW project row)
        DT335Gso: sd=132805248 (today, PRESERVED) start=1 (Today member) creationDate=1783253594 (= conversion wall-clock, NEW)
UNTOUCHED  11NNVsNH, RAAMrEWr (sibling instances), W3PZB9e7 (template: rule SET, nextInstanceStartDate=132805376)
```

So the convert is an **identity REPLACEMENT that SEVERS the series**: the instance row is destroyed, a fresh project row (new uuid, new `creationDate`, `type=1`) is minted with the title + `startDate` carried over and `rt1_repeatingTemplate` cleared. The template and its other instances are unaffected. The converted project appears in the GUI as a standalone sidebar project titled `LAB-REPEAT-DAILY`; the template's next occurrence still materialises in Upcoming (Jul 6, ↻).

**(d) Show Latest + our reader's sanity (the decider).**

- **DB-derived Show Latest** (our SL1 query `rt1_repeatingTemplate=<template> AND trashed=0 ORDER BY creationDate DESC LIMIT 1`) → **RAAMrEWr** (the newest REMAINING true instance). The converted project is EXCLUDED because its FK is cleared — even though its wall-clock `creationDate` is the largest number in the group, it is not counted (correct: it is no longer an instance).
- `things <template-uuid> --db` → `repeating.latestInstance = "RAAMrEWrJottFeYRBeJqHc"`, rule intact. **No lie** — Show Latest points at a real instance, not the converted project.
- `things <converted-uuid> --db` → `kind=project-view`, `type=project`, **no `instanceOf`, no `repeating`** — a plain project. **No lie** — the FK-clear means `mapRepeating`'s `isInstance = (templateUuid !== null)` is false.
- `things upcoming --db`, `things today --db` → exit 0. **No crash.**

**Verdict.** GUI Convert-to-Project on a repeating instance is a **new-uuid identity replacement that clears the `rt1_repeatingTemplate` FK and leaves the template + sibling instances intact**. This is the FRIENDLY outcome for the read layer: because the FK is severed, our reader treats the converted row as a plain project (no instance lie) and derives Show Latest from the newest remaining true instance — no code change needed. The only automation caveat: the pre-convert instance uuid is destroyed (external references dangle), and the new row's `creationDate` is the conversion instant, not an occurrence midnight. Evidence only.

### LOGSWEEP — logbook × trashed intersection (pinned today 2026-07-05)

**(a) Setup + sweep setting.** `TMSettings.logInterval = 0` (immediate sweep — a completed row is swept to the Logbook boundary at once). Three to-dos: `LG1`, `LG2` completed via `update?completed=true`; `LG3` left open then trashed. Then: trash `LG2` AFTER completion, and complete `LG3` AFTER trashing.

**(b) The AppleScript trash quirk (headline 4, filed in oddities §5n).** `delete to do id "<LG2>"` on the COMPLETED `LG2` **FAILED with −1728** *"Can't get to do id"* — even though `get name of to do id "<LG2>"` on the SAME specifier returns `"LG2"` fine. `delete` succeeded on the OPEN `LG3` (trashed it). The workaround: `move to do id "<LG2>" to list "Trash"` **succeeds** on the completed row (exit 0). So `delete` cannot target a completed/logged to-do, but `move … to list "Trash"` can. Terminal flags:

| row | shape | status | trashed | membership |
|---|---|---|---|---|
| LG1 | completed only | 3 | 0 | Logbook |
| LG2 | completed THEN trashed | 3 | 1 | Trash |
| LG3 | trashed THEN completed | 3 | 1 | Trash |

Both trash-vs-complete orderings converge on the SAME terminal shape (`status=3, trashed=1`).

**(c) GUI/DB/CLI parity.** Our host reads against the pulled DB:

```
things logbook --db  → LG* = [LG1]          (LIVE = trashed=0 gate excludes LG2/LG3)
things trash   --db  → LG* = [LG2, LG3]      (trashed=1 view; LG3 shown checked [✓])
```

Exact parity with the SL2 L1 GUI law (a trashed item leaves the Logbook and appears only in Trash; a completed-but-untrashed item stays in the Logbook). No row appears in both; no divergence; **no read-layer fix candidate** — our `logbookView` (`LIVE AND status IN (2,3) AND stopDate<=boundary`) and `trashView` (`trashed=1`) are mutually exclusive and correct. Evidence only.

### FUTPROJ — read-representation of future-scheduled project rows (D = 2026-07-19)

**(a) Seed.** An area-less future project `FPAL` (`add-project?when=D`, `tIdx −7642`) plus the ARM-1 area'd project `PA` (`a=S5A`, on D) and the remaining ARM-1 group (`PB`, `T1`, `T2`, `T3`, all on D). The day-D `todayIndex` order (ascending) is FPAL, T2, PB, PA, T1, T3.

**(b) CLI wire output.**

- `things upcoming --db` day-2026-07-19 group (emitted order): **FPAL (project), T2 (to-do), PB (project), PA (project, area=S5A), T1 (to-do), T3 (to-do, area=S5A)** — project rows carry `type: project`, `when: 2026-07-19`, `stage: upcoming`; area-direct rows carry their `area`. Both area-less and area-direct project rows are day-group members interleaved with the to-dos on `todayIndex`.
- `things projects --show-later --db`: `FPAL`, `PB`, `PA` each `{when: 2026-07-19, stage: upcoming}` (startDate surfaced as `when`, the JSON-honest field).

**(c) GUI comparison ([screens/arm4-day19-group.png](../../lab/artifacts/sit5-lab/screens/arm4-day19-group.png), gitignored).** The GUI Upcoming July-19 group renders, top-to-bottom: **FPAL, T2, PB, PA, T1, T3** — project rows shown with a progress ring + item-count "0" badge, and area'd rows (PA, T3) show the area name "S5A" as a subtitle; area-less project rows (FPAL, PB) show no subtitle. This is the **exact order** of `things upcoming`, position-for-position.

**Verdict.** Future-scheduled PROJECT rows — area-less AND area-direct — appear in the Upcoming day-group interleaved with to-dos, ordered by the shared `todayIndex` axis, and our `things upcoming` day-group placement matches the GUI byte-for-byte; `things projects --show-later` additionally lists them. No divergence to fix. Evidence only.

## App oddities filed

- **§5n (NEW): AppleScript `delete to do id <X>` fails −1728 on a COMPLETED to-do; `move … to list "Trash"` succeeds.** `delete` can only target OPEN to-dos — on a completed/logged row it raises *"Can't get to do id"* even though `get`/`set` on the same specifier resolve fine. The schedule-preserving trash path for a completed row is `move to do id <X> to list "Trash"`. Discovered in LOGSWEEP; filed in [things-app-oddities.md](../things-app-oddities.md).
- **CONVINST behavior (automation-relevant, not a bug): Convert-to-Project mints a NEW uuid + new `creationDate` and clears the `rt1_repeatingTemplate` FK, deleting the original instance row.** Filed as §8m — external references to the pre-convert uuid dangle; the converted project's `creationDate` is the conversion instant, not an occurrence midnight; the read layer stays correct precisely because the FK is severed.

AREAPROJDAY's area-FK preservation through the dated bounce and FUTPROJ's day-group parity CONFIRM existing behavior (SIT4 DAYBNC, the shared `todayIndex` day axis) and introduce no new quirk. LOGSWEEP CONFIRMS SL2 L1.

## Novel paths added

- **`move to do id <X> to list "Trash"` trashes a COMPLETED to-do that `delete` refuses** — the schedule-preserving headless trash path for a logged row (`delete` fails −1728 on completed to-dos). Filed in [reference/novel-paths.md](../reference/novel-paths.md).

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
VNCDO=/path/to/vncvenv/bin/vncdo \
  bash lab/scripts/research-sit5.sh setup        # clone+boot(--vnc-experimental)+airgap+clock-pin+warm-up+token
  bash lab/scripts/research-sit5.sh arm1          # AREAPROJDAY seed + area-direct dated-bounce law (headless)
  bash lab/scripts/research-sit5.sh arm1c         # AREAPROJDAY full scrambled 5-row bounce ×2 (headless)
  bash lab/scripts/research-sit5.sh arm3          # LOGSWEEP seed + GUI/DB/CLI membership (headless)
  bash lab/scripts/research-sit5.sh arm3b         # LOGSWEEP recheck after completed-then-trashed
  bash lab/scripts/research-sit5.sh arm4          # FUTPROJ future-project read repr (CLI)
  bash lab/scripts/research-sit5.sh arm4-shot     # FUTPROJ GUI Upcoming screenshot (needs $VNCDO)
  bash lab/scripts/research-sit5.sh arm2-grant    # AXVM1 rung-b Accessibility grant (needs $VNCDO)
  bash lab/scripts/research-sit5.sh arm2rec       # CONVINST record template + current instance
  bash lab/scripts/research-sit5.sh arm2menus     # CONVINST select instance + AX menu enumeration
  bash lab/scripts/research-sit5.sh arm2convert   # CONVINST perform Items ▸ Convert to Project… (AX + VNC confirm)
  bash lab/scripts/research-sit5.sh arm2read      # CONVINST post-convert DB reads + Show Latest + host CLI
  bash lab/scripts/research-sit5.sh teardown
```

Arms 1/3/4 are headless (no Accessibility, no VNC — `arm4-shot` is a screenshot-only extra); CONVINST needs the `arm2-grant` step (`$VNCDO` = a `vncdotool` CLI) and the VNC confirm-dialog click. The convert menu path is `Items ▸ "Convert to Project…"` (Unicode ellipsis). Evidence (gitignored, synthetic): `lab/artifacts/sit5-lab/report.txt`, `*.json`, `screens/`.
