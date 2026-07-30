# UPCORD1 — the last ordering gap: LOOSE items within a future Upcoming day-group

DAYORD-b ([reordgaps-results.md](reordgaps-results.md)) closed within-day ordering for a **container's** same-day scheduled children (the `project id`/`area id` specifier re-ranks `todayIndex` date-preservingly) but left **STANDALONE loose (container-less) items** on an arbitrary future Upcoming day **app-default**: `list "Upcoming"` re-dates them (§9g), date-shaped `list` specifiers don't exist (-1728), and only `list "Tomorrow"` reaches the next day. UPCORD1 hunts a deterministic protocol for loose items sharing one future day, ranked on the same `todayIndex` axis. Three arms, each a candidate primitive.

One offline Tart clone (`upcord1-lab`, run 2026-07-30, Things 3.22.11, pinned clock 2026-07-05 12:00; ordering is local — no cloud account). Test day **2026-07-10**. Script: [`lab/scripts/research-upcord1.sh`](../../lab/scripts/research-upcord1.sh) (subcommands `setup` / `probe` / `probeb2` / `probeb3` / `teardown`). **All arms HEADLESS** (URL scheme + AppleScript private reorder) — no Accessibility, no VNC. The one GUI-only question (Arm C1 template intermix) is BLOCKED on this host (no VNC) and left unprobed.

**Status: RAN + BANKED.** Headline: **Arm A (re-when-same-date) is a dead end** — a URL `when=<the same date>` update is a *complete no-op* (not even a `userModificationDate` bump); there is no same-date reindex primitive. **Arm B is the wireable protocol** — but ONLY through a **scratch PROJECT** (park → project container-day reorder → unpark), each leg fully date/state-preserving; the **AREA** variant is destructive (the area reorder de-schedules dated members, §9f extension). **Arm C: templates are re-parentable and series-stable, but the container-day reorder SKIPS them (§9e), and no re-when path exists** (URL `when=` crashes §1, AppleScript `schedule` refuses 302).

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **A — re-when-same-date reindex** | does URL `update when=<the SAME future date>` move a loose to-do within that day's `todayIndex`? | **NO — a COMPLETE NO-OP (index-inert), not even a `userModificationDate` bump.** Re-whening one of four loose 07-10 to-dos with `when=2026-07-10` left `todayIndex` unchanged and `userModificationDate` **byte-identical** (`1783252827.55126` before AND after) → the URL handler short-circuits when the target date equals the current date and performs **zero writes**. A full forward scrambled-target sequence of re-whens (all four, in target order) moved nothing. Side effects: none (the reminder `603979776` + deadline `132805888` on the reminder-carrying item were preserved trivially — nothing happened). **No same-date reindex primitive exists; not a viable protocol.** |
| **B — park-sort-unpark (PROJECT scratch)** | park loose→scratch project, run the shipped container-day reorder, unpark; does the `todayIndex` order survive? | **YES — deterministic, every leg date/state-preserving. THE wireable loose-day protocol.** (1) PARK via URL `update?list-id=<project>`: `project` set, `startDate` (07-10) + `todayIndex` + `start=2` all preserved. (2) REORDER via the shipped container-day compile `reorder to dos in project id <p> with ids <scrambled target>`: `todayIndex` re-ranked EXACTLY to the sent order (`CC-3 < CC-1 < CC-4 < CC-2`), `startDate` + `start=2` preserved (DAYORD-b date-preservation, now confirmed on parked-loose items). (3) UNPARK via URL `update?list-id=` (empty): `project` cleared, `startDate` + `todayIndex` order + `start=2` all preserved → the items return to LOOSE in the requested order. Reminder + deadline survive all three legs (CR-1: `rem=603979776`, `dl=132805888` intact end-to-end; order landed on target). Control: a bare `list-id=` on an already-loose item is a no-op. |
| **B — AREA scratch variant** | same, but park into an AREA | **DESTRUCTIVE — DEAD END.** Parking into an area is date-preserving, but the AREA-specifier container-day reorder **DE-SCHEDULES** every dated member: `start 2 → 1` AND `startDate → NULL` (yanked out of the Upcoming day-group into the area's Anytime section), while `area` stays intact and `index` re-ranks. This EXTENDS §9f (previously observed de-somedaying `start=2` members) to scheduled-day members — the area reorder collapses any non-anytime movee to plain anytime. Never use an area as the scratch container. |
| **B — loose scheduled PROJECT rows** | do area-less scheduled PROJECT rows sort on `todayIndex`, and are they day-reorderable? | **They carry `todayIndex` (so they DO sort in the day-group), but there is NO clean day-reorder surface.** Four area-less projects scheduled 07-10 carried `todayIndex` (−5812/−5230/−4766/−4387, `type=1`, `start=2`). Arm-A re-when-same-date on a project row (`update-project?when=2026-07-10`) is the SAME no-op. And a project row cannot be parked into a project (projects nest only in areas), while the area path is destructive — so loose scheduled PROJECT-row day order stays **app-default**. |
| **C — templates** | intermix law / re-parent / reorder stack-or-skip / series mutation / re-when | **Re-parentable + series-stable, but the reorder SKIPS them and no re-when path exists.** See per-arm detail. GUI intermix law (part 1) **UNPROBED** — needs VNC (blocked on this host) and templates are AX-title-invisible. |

## Per-arm detail

### Arm A — re-when-same-date reindex (the bounce-discovery pattern, applied in-day)

Seeded four area-less loose to-dos scheduled 2026-07-10 (AA-1..4; AA-2 additionally carrying a `09:00` reminder + a 07-10 deadline). New dated items **front-insert** on `todayIndex` (each `add` lands more negative: 0, −457, −964, −1566), giving order AA-4 < AA-3 < AA-2 < AA-1. All `start=2`, `index=0`, `area` NULL — confirming loose future-day items live on the `todayIndex` axis (`index` stays 0), exactly like container children.

Re-whening AA-2 with `when=2026-07-10` (its existing date) changed **nothing** — and crucially `userModificationDate` was byte-identical across the call, proving the app wrote **zero rows** (it is not a rewrite-to-same-value; it is a hard short-circuit on date equality). A full forward sequence of re-whens across all four, targeting a scrambled order, likewise moved nothing. So the URL `when=` update offers no in-day reindex: to move a dated item within its day you must change its date (which is the destructive `list "Upcoming"` re-date, §9g) — there is no same-date door. **Dead end.** (This is a clean negative, not a quirk to file: same-date idempotence is arguably correct; the only mild surprise is the absent `userModificationDate` bump.)

### Arm B — park-sort-unpark

The insight: the shipped **container-day** reorder (DAYORD-b, scope `container-day`) already re-ranks `todayIndex` date-preservingly for a **container's** children. If a loose dated item can be temporarily *made* a container child, reordered, and *un*-made, its day order is set — provided every leg preserves the schedule.

**AREA scratch (v1) — destructive.** Parking loose 07-10 items into an area via URL `list-id=<area>` preserved `start=2`/`startDate`/`todayIndex`. But the AREA container-day reorder then de-scheduled them (`start 2→1`, `startDate→NULL`) — the §9f de-somedaying generalizes to scheduled members. Dead end; poisons everything downstream.

**PROJECT scratch (v2) — clean, wireable.** Rerun on fresh loose items (CC-1..4 @07-10) with a scratch PROJECT:

| leg | command | result |
|---|---|---|
| 1. PARK | `update?id=<u>&list-id=<project>` (×N) | `project` set; `startDate` 07-10, `todayIndex`, `start=2` **all preserved** |
| 2. REORDER | `reorder to dos in project id <project> with ids CC-3,CC-1,CC-4,CC-2` | `todayIndex` re-ranked to EXACT sent order (−9958 < −9512 < −8934 < −8321); `startDate` + `start=2` preserved |
| 3. UNPARK | `update?id=<u>&list-id=` (empty) (×N) | `project` cleared → LOOSE again; `startDate` + `todayIndex` order + `start=2` **all preserved** |

Final loose state: `CC-3 < CC-1 < CC-4 < CC-2` on `todayIndex`, `startDate` = 07-10, `area`/`project` NULL — the requested (scrambled) order, achieved deterministically. A separate pass carried a **reminder + deadline** through all three legs intact (CR-1: `reminderTime=603979776`, `deadline=132805888` end-to-end; order landed on target). So the protocol is non-destructive of `start`, `startDate`, `todayIndex`, `reminderTime`, and `deadline`.

**The wireable protocol (loose future-day order):**
1. Create (or reuse) a scratch **PROJECT** (area-less is fine).
2. For each movee, PARK: `things:///update?id=<uuid>&list-id=<scratchProject>`.
3. REORDER: `_private_experimental_ reorder to dos in project id <scratchProject> with ids <uuid1,…,uuidN>` in **target order** (the private command re-ranks `todayIndex` ascending in the sent order; DAYORD-b).
4. For each movee, UNPARK: `things:///update?id=<uuid>&list-id=` (empty parameter).
5. Trash the scratch project.

Cost **2N + 1 dispatches** (N URL parks + 1 reorder + N URL unparks) plus the scratch-project create/trash. Non-atomic (like the shipped bounce protocols): a crash mid-run leaves items transiently parked in the scratch project with their schedule intact — recoverable, never destructive. The reorder leg is the ALREADY-SHIPPED `container-day` native command; the wrapper is just the park/unpark legs + scratch-project lifecycle.

### Arm C — templates

Golden `LAB-REPEAT-DAILY` (a repeating TO-DO template, `type=0`, `rt1_recurrenceRule` set, `startDate` NULL, `todayIndex=0`, `index=-940`). No clock advance anywhere (a parked template must not spawn an occurrence).

- **C1 (intermix law) — UNPROBED (no VNC).** The resting template row has `startDate` NULL and `todayIndex=0` — it is NOT itself in any scheduled day-group; it is ordered on `index` in its resting bucket (§9e). The GUI "intermix" is really about a template's *projected next occurrence*, which materializes as a spawned INSTANCE row (an ordinary to-do with its own `startDate`/`todayIndex`) — those sort among scheduled to-dos exactly like any dated to-do (Arm B applies). Reading the resting template's GUI position among a day-group needs screenshots (templates are AX-title-invisible, reordgaps), which needs VNC — blocked here. By-id fetch resolves (`get name of to do id <tmpl>` → `LAB-REPEAT-DAILY`), reconfirming §5e (list reads omit the template row; by-id works). The name surfaced 3× in a `list "Anytime"` read — spawned instances, not the template row.
- **C2/C3 (re-parent + series mutation) — CLEAN.** Re-parenting the template to an area via URL `list-id=<area>` WORKS (`area` set), and `rt1_recurrenceRule` is **byte-identical** before park / after re-parent / after unpark — the series does NOT mutate on a container move, and no occurrence spawned (no clock advance). `index`/`todayIndex`/`startDate` unchanged. Unpark via `list-id=` (empty) clears the area, `start=2` preserved, rule intact. **Templates are headlessly re-parentable, non-destructively.**
- **Container-day reorder — SKIPS the template (§9e data-layer confirm).** With the template placed FIRST in the reorder wire list alongside two ordinary dated area members, the template's `todayIndex`/`index` were **UNCHANGED** — the private command is a no-op on `rt1_recurrenceRule` rows (they are invisible to the addressed `to dos` set; TMPLORD-b). The ordinary movees WERE re-ranked (and, being reordered via the AREA specifier, were also de-scheduled per the §9f/UPCORD1 extension — an incidental reconfirmation).
- **C4 (re-when) — no path.** URL `update?when=` on a repeating template is the documented **§1 CRASH** (SIGTRAP) — NOT executed. AppleScript `schedule to do id <template>` returns the guarded **error 302** ("Cannot schedule to-do") — confirmed live. So there is no re-when reindex path for templates; day ordering of templates stays **app-default**.

## Candidate capability-matrix wording (for the orchestrator to wire — NOT changed here)

The Ordering §, "loose future day" placement class currently reads **APP-DEFAULT** (`list "Upcoming"` re-dates, §9g). UPCORD1 supplies a clean protocol; candidate flip:

- **Loose future-day order → GUARANTEED via the UPCORD1 park-sort-unpark protocol** (scratch-PROJECT park → `container-day` reorder → unpark; date/state-preserving; 2N+1 dispatches + scratch-project lifecycle). Suggested scope name `loose-day` (or route loose future-day movees through a park wrapper onto the existing `container-day` native command). Gate under the existing private-surface gate; the scratch-project create/trash is the only new machinery. Non-atomic, disclosed like the bounce protocols.
- **Refused / stays app-default:** the AREA scratch path (destructive, §9f extension — the planner must NEVER route loose-day ordering through an area); loose scheduled **PROJECT-row** day order (project rows carry `todayIndex` but cannot be parked in a project and the area path is destructive); repeating **templates** (reorder skips them §9e, no re-when path).

Feasibility cells intentionally left untouched in this change; the candidate wording is recorded here for the wiring change.

## App oddities filed / extended

- **§9f addendum (UPCORD1)** — the private `reorder to dos in area id …` de-schedules DATED members (`start 2→1`, `startDate→NULL`), not just someday members; the area reorder collapses any non-anytime movee to plain anytime. Reason the protocol uses a project scratch container. (Recorded in [things-app-oddities.md](../things-app-oddities.md) §9f.)
- Arm A's same-date `when=` no-op is documented here only (correct idempotence; the sole mild note is the absent `userModificationDate` bump) — not filed as a new §9 quirk, per the "file it only if index-ACTIVE" criterion (it was inert).

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-upcord1.sh setup      # clone+boot+airgap+clock-pin+seed
  bash lab/scripts/research-upcord1.sh probe        # Arm A · Arm B(v1 area, incl. §9f extension) · Arm C
  bash lab/scripts/research-upcord1.sh probeb2      # Arm B clean (PROJECT scratch) — the wireable protocol
  bash lab/scripts/research-upcord1.sh probeb3      # Arm B side effects — reminder+deadline through the protocol
  bash lab/scripts/research-upcord1.sh teardown
```

No Accessibility, no VNC — all arms headless URL/AppleScript. `probe` runs the AREA path first (which de-schedules its fixtures by design, mapping §9f); `probeb2`/`probeb3` use fresh fixtures + a PROJECT scratch to prove the clean protocol. The reorder wire lists use SCRAMBLED targets so a passing result proves array order CONTROLS placement, not a no-op. Evidence (gitignored, synthetic): `lab/artifacts/upcord1-lab/report.txt`.
