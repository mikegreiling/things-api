# ORDFIN1 — the ordering endgame: the last four open ordering questions

Four arms close the remaining ordering cells: whether a repeating template's `todayIndex` is reachable by any lever (headless levers + a GUI feasibility check), whether headed evening children survive the evening bounce, and whether an area's direct dated children and a whole cross-container Upcoming day-group are wireable park-sort-restore protocols.

One offline Tart clone (`ordfin1-lab`, run 2026-07-31, Things 3.22.11, macOS 15.7.7, DB v26, pinned clock 2026-07-05 12:00; ordering is local — no cloud account). Script: [`lab/scripts/research-ordfin1.sh`](../../lab/scripts/research-ordfin1.sh) (subcommands `setup` / `grant` / `arm1cd` / `arm1b` / `arm2` / `arm3` / `arm4` / `teardown`) + the AX dumper [`lab/scripts/ordfin1-axdump.jxa`](../../lab/scripts/ordfin1-axdump.jxa). Arms **2/3/4 are HEADLESS** (URL scheme + `things:///json` + AppleScript private reorder). **Arm 1 needs Accessibility** (granted per-clone via the AXVM1 rung-b VNC toggle) for the repeat-menu levers (1b) and the Upcoming-view AX inspection (1c/1d). Test days: evening = **2026-07-05** (pinned today); GUI day = **2026-07-10**; area day = **2026-07-15**; Upcoming day = **2026-07-20**. Dates were seeded via URL `when=<ISO>` (the app packs `startDate`) and preservation asserted by DB read comparison — **no hand-packed date integers** anywhere. All reorder wire lists use SCRAMBLED targets so a passing result proves array order CONTROLS placement, not a no-op.

**Status: RAN + BANKED.** Headlines:

1. **Arm 1 = a repeating template's `todayIndex` is UNREACHABLE by any surface.** Headless: pause / resume / complete-the-current-instance / reschedule all leave the template row byte-identical at `todayIndex=0, index=-940` — repeat-series mutation is `todayIndex`-inert. GUI: the projected repeating occurrence renders in the Upcoming view **with its title + a repeat glyph**, but at the Accessibility layer that row exposes only generic status-indicator cell-template names (`Task NewForToday Template`, `Task Alarm Template`) — **no title, no uuid, no repeat marker** — so it is AX-**indistinguishable** from an ordinary to-do. Identity is not verifiable → **fail closed, no drag**. Templates stay ordering-refused on every surface. (§8h addendum.)
2. **Arm 2 = the evening bounce works on a HEADED evening child, heading FK preserved.** The today↔evening round-trip on a headed this-evening child preserves the heading FK **byte-identical**, round-trips `startBucket` 1→0→1, and keeps today's `startDate` — extending HEADSUB1 Arm D (project child) / HEADSUB2 Q2 (area child) to a HEADED child. Separately, the PROJECT-specifier native reorder over unheaded evening children **KEEPS `startBucket=1`** (re-ranks `index`) — it does NOT de-even like the `list "Today"` today-scope reorder (O03): de-evening is scope-specific.
3. **Arm 3 = `area-day` is a wireable protocol.** Park an area's direct dated children into a scratch PROJECT → native `container-day` reorder → restore to the area. Every leg date/state-preserving, the area FK round-trips, `todayIndex` order lands the scrambled target exactly, reminder+deadline survive, anytime/someday canaries untouched. The destructive AREA specifier (§9f) is never used.
4. **Arm 4 = `upcoming-day` is a wireable protocol.** Park an ENTIRE cross-container day-group (loose + project children + a headed child + area children) into ONE scratch project → ONE `container-day` reorder to a global interleave → restore each to its origin FK. Final global `todayIndex` order lands the target across all six, every FK round-trips (loose→NULL, project→P, headed→heading FK, area→area FK), schedule+reminder+deadline preserved, and **restore-leg order is irrelevant** (the reorder alone fixes `todayIndex`; restores only re-home).

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **1b** — template `todayIndex` levers | does pause / resume / complete-instance / reschedule mutate the template's `todayIndex`? | **NO — `todayIndex` is inert to every repeat-series lever.** Resting `tIdx=0 idx=-940` (Arm 1a confirm). PAUSE (real write: `rt1_instanceCreationPaused` 0→1, `rt1_nextInstanceStartDate` 132805376→NULL) → `tIdx=0 idx=-940`. RESUME (paused 1→0, next→132805376) → `tIdx=0`. COMPLETE the current spawned instance (`set status … to completed`; series advances) → template `tIdx=0`. RESCHEDULE dialog opened + OK'd across cycles → `tIdx=0` every cycle. (The interval/frequency rule edit did not LAND under headless AX driving — the documented UIC7b numeric-field race + UIC1-d menu-wedge — but that is a driving limitation, not a `todayIndex` phenomenon; a reschedule is an identity-preserving IN-PLACE rule-byte edit, UIC1-a, which structurally cannot touch a placement column, exactly as pause/resume don't.) |
| **1c/1d** — GUI/AX feasibility | is the projected repeating row an addressable AX row with a VERIFIABLE identity + a clear within-day drop target? | **NO verifiable identity → FAIL CLOSED, no drag.** The projected occurrence IS present as an `AXTableRow` and (screenshot) renders its title `LAB-REPEAT-DAILY` + a repeat glyph on its next-occurrence day. But its AX row carries only generic cell-template chrome (`Task NewForToday Template \| Task Alarm Template`) — identical to any ordinary to-do; **no title, no uuid, no `AXIdentifier`, and NO repeat/recurring marker**. Day-group boundaries ARE AX-labeled (`6. Tomorrow`, `10. Friday`), so a within-day drop target is geometrically distinguishable — but the ROW cannot be identified, so you cannot verify you are grabbing the template (vs an ordinary to-do) nor that a drop lands the right row. A mis-grab/mis-drop re-dates an ordinary to-do (destructive). **GUI within-day reorder of a projected template via AX/HID is INFEASIBLE (no verifiable row identity), independent of the §9e drag-inertness of resting templates.** → §8h addendum. |
| **2b** — headed evening child bounce | does the today↔evening round-trip on a HEADED evening child preserve the heading FK? | **YES — heading FK byte-identical, state-preserving.** Seed `EH-C1` headed this-evening: `start=1 sb=1 sd=07-05 h=6XnTafSA p=NULL`. After `when=today`: `sb=0` (de-eveninged to the Today bucket), `h=6XnTafSA` **preserved**, `startDate` kept, front-inserts on `todayIndex` (−631). After `when=evening`: `sb=1` (back to Evening), `h=6XnTafSA` **preserved**, `startDate` kept (`todayIndex` −69). The heading FK survives the today↔evening bounce exactly as it survives the someday↔anytime bounce (HEADORD-c). The shipped `evening` BounceSpec (`away=today, back=evening, front-insert, rankKey=todayIndex`) applies to a HEADED evening child unchanged, heading FK intact. Inherits the R07 reminder-loss caveat. |
| **2c** — project reorder over evening children | does the native PROJECT-specifier reorder de-even an unheaded evening child, like the today scope (O03)? | **NO — `startBucket=1` SURVIVES; the reorder re-ranks `index`.** Two unheaded evening children `EH-C2`/`EH-C3` (`sb=1`), `reorder to dos in project id <P> with ids C3,C2` → both keep `sb=1` and today `startDate`; `EH-C3`'s `index` 0→−1062 (re-ranked below `EH-C2`'s −580, so C3 sorts first, matching the requested order), `todayIndex` untouched on both. So the **container** (project) specifier is evening-SAFE — de-evening is specific to the `list "Today"` today-scope reorder (O03), not the container reorder. (The reorder acts on the project-view `index` axis; the Today/Evening view `todayIndex` order is set by the evening bounce, Arm 2b — the two axes are independent.) |
| **3** — area's direct dated children | is park→`container-day`→restore-to-area a wireable `area-day` protocol? | **YES — wireable, every leg date/state-preserving.** Four dated children of `LAB-AREA-A` @07-15 (`AD-2` carrying reminder+deadline) + anytime/someday canaries. PARK into a scratch PROJECT (`area`→NULL, `project`→scratch; `startDate`/`todayIndex`/`start=2`/reminder/deadline all preserved). REORDER (`project id <scratch>`, scrambled target `AD-3,AD-1,AD-4,AD-2`): `todayIndex` re-ranked EXACTLY (`−3237<−2805<−2369<−1724`), date preserved, `start=2` kept, `AD-2` reminder+deadline intact. RESTORE (`list-id=<area>`): `area` FK restored on all four, `startDate`+`start=2` preserved, `todayIndex` ORDER == target, reminder+deadline intact. Canaries `AD-ANY`(anytime)/`AD-SOME`(someday) byte-identical. Scratch trashed. The destructive AREA specifier (§9f) is never touched. |
| **4** — cross-container day interleave | is a whole Upcoming day-group interleavable across containers via ONE scratch-project round-trip (`upcoming-day`)? | **YES — wireable, restore-order-irrelevant.** One day @07-20 with 2 loose, 2 project children (one headed under `UC-H`), 2 area children (one carrying reminder+deadline) — 6 rows, no template phantom (DB confirms exactly 6 dated `type=0` rows share the day; the daily template's future projection is DISPLAY-ONLY). PARK all 6 into ONE scratch project (all FKs→scratch; `startDate`/`todayIndex`/`start=2`/reminder/deadline preserved). REORDER to a scrambled GLOBAL interleave (`UC-A2,UC-L1,UC-P2,UC-A1,UC-L2,UC-P1`): `todayIndex` re-ranked EXACTLY to that order across all six (`−5441<−4901<−4420<−3831<−3383<−2893`), date preserved. RESTORE each to origin **in a different order than the target** (loose←empty `list-id`; project child←`list-id=<P>`; headed child←`list-id=<P>&heading=<H>`; area child←`list-id=<A>`): every FK restored (loose `a/p` NULL; project `p=UC-P`; headed `h=UC-H`; area `a=LAB-AREA-A`), `startDate`/`start=2` preserved, `UC-A2` reminder+deadline intact, and the final GLOBAL `todayIndex` order == target. **Restore-leg order is irrelevant** — the `container-day` reorder alone fixes `todayIndex`; the restore legs only re-home (they preserve `todayIndex`). Scratch trashed. |

## Per-arm detail

### Arm 1 — TMPLIDX: the template's `todayIndex` is unreachable

**1a — resting state.** `LAB-REPEAT-DAILY` (repeating to-do template, `rt1_recurrenceRule` set — `fu=16` daily, `fa=1`): `todayIndex=0`, `index=-940`, `start=2`, `startDate` NULL, `rt1_instanceCreationPaused=0`, `rt1_nextInstanceStartDate=132805376` (2026-07-06 — its next occurrence). The template row is NOT itself in any scheduled day-group (`startDate` NULL); it sorts on `index` in its resting bucket (§9e). Its *projection* onto the Upcoming view is what a user sees on a day-group.

**1b — headless levers (all `todayIndex`-inert).** Each lever was driven and the template row re-read:

| Lever | How | Template row after |
|---|---|---|
| PAUSE | Items ▸ Repeat ▸ Pause (menu, by name — AXVM1-d recipe) | `tIdx=0 idx=-940`; `paused` 0→1, `next` 132805376→NULL |
| RESUME | Items ▸ Repeat ▸ Resume | `tIdx=0 idx=-940`; `paused` 1→0, `next`→132805376 |
| COMPLETE instance | `set status of to do id <instance> to completed` (the spawned instance is an ordinary to-do; series advances) | `tIdx=0 idx=-940` (unchanged) |
| RESCHEDULE | Items ▸ Repeat ▸ Reschedule… → dialog | `tIdx=0 idx=-940` across every dialog cycle |

Pause and Resume are the strongest test: they clear and restore `rt1_nextInstanceStartDate` — i.e. they change WHICH day the template projects onto — and yet the template's own `todayIndex` never moves off 0. Completing the current instance (a genuine series advance) likewise leaves it at 0. The reschedule interval/frequency edit resisted headless AX entry (the documented UIC7b numeric-field race + the UIC1-d menu-wedge after repeated dialog cycles — a clean relaunch restores the submenu), so the rule bytes did not change under automation; but `todayIndex` stayed 0 through every open/OK cycle, and a reschedule is an identity-preserving IN-PLACE rule-byte edit (UIC1-a: `fu` 16→8, same uuid), which cannot touch a placement column any more than pause/resume can. **Conclusion: no repeat-series lever mutates the template's `todayIndex`.** There is no headless `todayIndex` handle on a template.

**1c/1d — GUI/AX feasibility (fail closed).** With Accessibility granted (AXVM1 rung-b toggle), the Upcoming view was opened and its main `AXTable` dumped ([`arm1c-axdump.txt`](../../lab/artifacts/ordfin1-lab/arm1c-axdump.txt), gitignored) alongside a VNC screenshot. Findings:

- **Day-group HEADERS are AX-labeled** via `AXDescription`: `6. Tomorrow`, `7. Tuesday`, `8. Wednesday`, `9. Thursday`, `10. Friday`, … So day boundaries (and thus within-day drop targets) ARE geometrically distinguishable.
- **Content ROWS expose NO identity.** Every to-do row's only AX text is generic status-indicator cell-template names: `Task NewForToday Template`, `Task Alarm Template` (always present chrome), plus `Task Deadline Template` only on deadline-bearing rows. No `AXValue`/`AXTitle`/`AXDescription`/`AXHelp`/`AXIdentifier` carries the row's title or uuid. This confirms + sharpens §8h / §9e (list rows expose cell-template identifiers, not titles).
- **The projected repeating occurrence is AX-indistinguishable from an ordinary to-do.** In the GUI (screenshot) the template projects on 2026-07-06 (its next occurrence only — a daily template shows ONE projected occurrence, not one per day) as `LAB-REPEAT-DAILY` with a visible **repeat glyph**. But its AX row is `Task NewForToday Template | Task Alarm Template` — the SAME signature as any ordinary to-do; **there is no AX repeat/recurring marker at all**. So even "which row is the repeating one" is unverifiable via AX.

Because row identity is not verifiable, the fail-closed rule applies: **DO NOT drag.** A mis-grab (wrong row) or mis-drop (wrong day) re-dates an ordinary to-do — destructive. The blocking finding IS the feasibility answer: **GUI within-day reorder of a projected template is infeasible via AX/HID (no verifiable row identity)** — a second, independent wall on top of §9e's drag-inertness of resting templates and 1b's headless inertness. **A repeating template's day-group position is unreachable by every surface.**

### Arm 2 — EVEHEAD: headed evening children

**2b — the evening bounce on a headed child.** `EH-C1` was seeded loose this-evening, then moved under heading `EH-H` (the HEADSUB1 Arm B path — the move preserves `startBucket=1`), giving a headed this-evening child (`start=1 sb=1 startDate=07-05 heading=EH-H project=NULL`). The shipped evening bounce legs (`update?when=today` then `update?when=evening`) were run manually:

| Leg | `start` | `startBucket` | `startDate` | `heading` FK | `todayIndex` |
|---|---|---|---|---|---|
| seed | 1 | 1 | 07-05 | `6XnTafSA` | 0 |
| after `when=today` | 1 | 0 | 07-05 | `6XnTafSA` | −631 |
| after `when=evening` | 1 | 1 | 07-05 | `6XnTafSA` | −69 |

The heading FK is **byte-identical** through both legs, `startBucket` round-trips 1→0→1, today's `startDate` is kept, and the re-entry front-inserts on `todayIndex` (the evening bounce direction). So a headed evening child is orderable in the Today/Evening bucket via the shipped `evening` scope with its heading FK intact — extending HEADSUB1 Arm D (project child) and HEADSUB2 Q2 (area child) to the headed case. Inherits the R07 reminder-loss caveat (a bare `when=today`/`when=evening` clears an existing reminder).

**2c — the project reorder is evening-safe.** Two unheaded evening children of `EH-P` (`EH-C2`/`EH-C3`, both `sb=1`) were reordered via the native project specifier (`reorder to dos in project id <P> with ids C3,C2`). Both KEPT `startBucket=1` and today's `startDate`; the reorder re-ranked `index` (`EH-C3` 0→−1062, dropping it below `EH-C2`'s −580 so C3 sorts first, matching the requested order) and left `todayIndex` untouched. So the container (project) specifier does **not** de-even, unlike the `list "Today"` today-scope reorder (O03) — de-evening is scope-specific to the Today list. The project reorder sets the project-view `index` order; the Today/Evening `todayIndex` order is set by the evening bounce (2b) — the two axes are independent, both non-destructive of the evening flag.

### Arm 3 — AREADAY: an area's direct dated children

An area's direct dated children live on the shared `todayIndex` axis (like every scheduled item), but the AREA reorder specifier is destructive (§9f de-schedules dated members). The wireable path is the UPCORD1 park-sort-restore idiom, restore-leg targeting the AREA:

| Leg | Command | Result |
|---|---|---|
| 1. PARK | `update?id=<u>&list-id=<scratchProject>` (×4) | `area`→NULL, `project`→scratch; `startDate` (07-15) + `todayIndex` + `start=2` + `AD-2` reminder(603979776)+deadline(132806528) **all preserved** |
| 2. REORDER | `reorder to dos in project id <scratch> with ids AD-3,AD-1,AD-4,AD-2` | `todayIndex` re-ranked EXACTLY (`−3237<−2805<−2369<−1724`); date + `start=2` preserved; reminder/deadline intact |
| 3. RESTORE | `update?id=<u>&list-id=<area>` (×4) | `area` FK restored on all four; `startDate` + `start=2` preserved; `todayIndex` ORDER == target; reminder/deadline intact |

Canaries: the area's anytime (`AD-ANY`, `start=1`) and someday (`AD-SOME`, `start=2`) siblings were **byte-identical** before/after — the protocol touches only the named dated children. The scratch project was trashed. **`area-day` is wireable** — structurally identical to `loose-day`/`container-day`, with the restore leg homing to the area (not loose).

### Arm 4 — UPCORD2: cross-container day-group interleave

The capstone: can a WHOLE Upcoming day-group — items living in different containers — be interleaved on the shared `todayIndex` axis by ONE scratch-project round-trip? Seed @07-20: 2 loose (`UC-L1/L2`), 2 project children (`UC-P1`, `UC-P2` headed under `UC-H`), 2 area children (`UC-A1`, `UC-A2` with reminder+deadline). The DB confirmed exactly 6 dated `type=0` rows share the day (the daily template's projection onto this day is DISPLAY-ONLY — no `TMTask` row — so it never corrupts the `todayIndex` axis).

| Leg | Command | Result |
|---|---|---|
| 1. PARK (×6) | `update?id=<u>&list-id=<scratch>` | all FKs→scratch; `startDate` (07-20) + `todayIndex` + `start=2` + `UC-A2` reminder+deadline preserved |
| 2. REORDER | `reorder to dos in project id <scratch> with ids UC-A2,UC-L1,UC-P2,UC-A1,UC-L2,UC-P1` | `todayIndex` re-ranked EXACTLY to the global interleave (`−5441<−4901<−4420<−3831<−3383<−2893`); date preserved |
| 3. RESTORE (×6, in a DIFFERENT order than the target) | loose←`list-id=`; project child←`list-id=<P>`; headed child←`list-id=<P>&heading=<H>`; area child←`list-id=<A>` | every FK restored (loose `a/p` NULL; project `p=UC-P`; headed `h=UC-H`; area `a=LAB-AREA-A`); `startDate`+`start=2` preserved; `UC-A2` reminder+deadline intact; final GLOBAL `todayIndex` order == target |

**Restore-leg order is irrelevant.** The restore legs were issued in the order `UC-P1, UC-A1, UC-L2, UC-P2, UC-A2, UC-L1` — deliberately scrambled versus the target interleave — and the final `todayIndex` order still matched the target exactly, because the `container-day` reorder alone sets `todayIndex` and the restore (`list-id`) legs preserve it (a membership move is a `todayIndex` no-op, HEADSUB1 Arm B-scheduled). The scratch project was trashed. **`upcoming-day` is wireable** — a single park-sort-restore that interleaves an entire day-group across loose / project / heading / area containers on the shared `todayIndex` axis, generalizing `loose-day` (UPCORD1) + `container-day` (DAYORD-b) + `area-day` (Arm 3) into one scope.

## Candidate capability-matrix promotions (evidence only — wiring is a follow-up decision)

Per the ORDFIN1 brief, no new reorder scopes are wired in this change. The verdicts settle these cells (folded into the Ordering § in the same change):

- **Headed EVENING sub-bucket → GUARANTEED** via the shipped `evening` bounce (Arm 2b: the today↔evening round-trip preserves the heading FK byte-identical). The prior "GUI-ambiguous display axis, needs a VNC oracle" justification was WRONG — per the maintainer law there was never a rendering ambiguity (outside Today: a status pip on an `index`-sorted anytime-bucket row; inside Today: the Today/Evening bucket on `todayIndex`). No new machinery — routes to the already-wired `evening` scope.
- **Direct-area scheduled-DAY child (`area-day`) → GUARANTEED** (protocol-proven, wiring pending) via park→`container-day`→restore-to-area (Arm 3), date/state-preserving, the destructive AREA specifier (§9f) never used.
- **Cross-container Upcoming day interleave (`upcoming-day`) → GUARANTEED** (protocol-proven, wiring pending) via ONE scratch-project park → global `container-day` reorder → restore-each-to-origin (Arm 4), restore-order-irrelevant.
- **Repeating templates stay REFUSED on every ordering surface** (Arm 1): `todayIndex` is inert to every headless repeat-series lever, and the GUI drag is infeasible (no verifiable AX row identity) on top of §9e's drag-inertness. No template ordering path exists.

## App oddities filed

- **§8h addendum (ORDFIN1)** — in the Upcoming view, content rows (including a projected repeating occurrence) expose only generic status-indicator cell-template names (`Task NewForToday Template`, `Task Alarm Template`, `Task Deadline Template`) to Accessibility — never the title, a uuid, or a repeat/recurring marker — so a projected repeating row is AX-indistinguishable from an ordinary to-do despite its visible title + repeat glyph; day-group headers ARE AX-labeled. (Arm 1c/1d.)

The Arm 2c contrast (the PROJECT-specifier reorder is evening-safe, unlike the `list "Today"` de-evening of O03) is a scope-specificity clarification of the already-filed O03, recorded here and in the matrix, not re-filed as a new §-entry (benign, non-destructive behavior).

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart VNCDO=<path-to-vncdo> \
  bash lab/scripts/research-ordfin1.sh setup      # clone+boot(+vnc)+airgap+clock-pin+warm+seed
  bash lab/scripts/research-ordfin1.sh grant        # AXVM1 rung-b Accessibility toggle (Arm 1 only)
  bash lab/scripts/research-ordfin1.sh arm1cd       # TMPLIDX GUI/AX inspection (fail-closed drag)
  bash lab/scripts/research-ordfin1.sh arm1b        # TMPLIDX todayIndex levers
  bash lab/scripts/research-ordfin1.sh arm2         # EVEHEAD headed evening children
  bash lab/scripts/research-ordfin1.sh arm3         # AREADAY area's direct dated children
  bash lab/scripts/research-ordfin1.sh arm4         # UPCORD2 cross-container day interleave
  bash lab/scripts/research-ordfin1.sh teardown
```

Arms 2/3/4 are headless (no Accessibility, no VNC); Arm 1 needs the `grant` step (`$VNCDO` = a `vncdotool` CLI). All reorder wire lists use SCRAMBLED targets. Evidence (gitignored, synthetic): `lab/artifacts/ordfin1-lab/report.txt`, `arm1c-axdump.txt`, `arm1c-upcoming.png`.
