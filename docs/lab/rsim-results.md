# RSIM — recurrence-creation mutation shapes

**Verdict (2026-07-18): the exact row-level shape of every recurrence-creation op is now characterized** — creation spawns EXACTLY ONE instance immediately (fixed) or reuses the source item as the instance (after-completion); completion schedules the next occurrence without materializing it. This unblocks the AGENTBENCH recurrence-simulator appliers and makes the tier-3 catalog decision evidence-capable (probe-backlog §C). Ran in ONE disposable `--vnc-experimental` clone `rsim-lab` of `things-lab-golden-v1` (golden untouched; all writes inside the clone), airgapped, clock pinned **2026-07-05 12:00**, Things **3.22.11 / macOS 15.7.7 / DB v26**, Accessibility granted via the AXVM1 rung-b VNC toggle, everything else over SSH. Ground truth = guest Things-DB row deltas (read-only SQLite; every recurrence column captured, the whole `rt1_recurrenceRule` plist decoded key-by-key) driven through the **production CLI** (`todo/project make-repeating`, `project create-repeating`, `todo reschedule-repeat`, `todo complete`). Branch `mg/rsim-probe`. Script: [`lab/scripts/research-rsim.sh`](../../lab/scripts/research-rsim.sh). Artifacts (gitignored): `lab/artifacts/rsim-lab/` (per-case `snaps/*.json` before/after snapshots, `drive-*.log`, `report.txt`, `diff_snaps.py`).

This COMPLEMENTS the ui-vector certification (UIC1/UIC5, oddities §8g) — those proved the ops *feasible* and DB-verified the template-is-created outcome; RSIM nails the FULL row shape: instance count, the template↔instance link fields, `startDate`/`deadline` derivation, and the after-completion spawn timing.

Packed-date decode used below: `132805248`=2026-07-05, `132805376`=2026-07-06, `132806144`=2026-07-12 (`y<<16 | m<<12 | d<<7`). Frequency codes (`fu`): 16=daily, 256=weekly, 8=monthly, 4=yearly. `ed=64092211200.0` = the ~year-4001 "forever" sentinel. `ts`=start offset in days (0 = deadline-less default, §8a).

## Executed verdicts (2026-07-18)

| Probe | Case | Instance spawned on create? | Result |
|---|---|---|---|
| **RSIM1** | `todo make-repeating` FIXED weekly | **YES — exactly 1**, dated at the current occurrence (today) | Original uuid **DELETED** (identity replacement). New template (`rt1_recurrenceRule` tp=0, fu=256, fa=1, of=[{wd:0}], ts=0; `start=2`, `startDate=NULL`, `deadline=NULL`; `icCount=1`, `nextInstanceStartDate=2026-07-12`). New instance (`rt1_repeatingTemplate`=template, rule=NULL, `startDate=2026-07-05`, `start=2`, `deadline=NULL`). |
| **RSIM2** | `todo make-repeating` AFTER-COMPLETION weekly | **YES — 1, but the SOURCE ITEM is reused as the instance** | Original uuid **PRESERVED** — relinked as the instance (`rt1_repeatingTemplate` NULL→template; its `startDate=2026-07-05`, `start=1` unchanged). New TEMPLATE only (tp=**1**, fu=256, fa=1, of=[{wd:0}], ts=0; `icCount=0`, `nextInstanceStartDate=NULL`, `afterCompletionReferenceDate=NULL`). **No fresh instance row created.** |
| **RSIM3** | `project create-repeating` FIXED weekly (from scratch) | **YES — exactly 1** | Two NEW `type=1` rows: template (identical rule shape to RSIM1, tp=0/fu=256; `icCount=1`, `nextInstanceStartDate=2026-07-12`) + instance (`rt1_repeatingTemplate`=template, `startDate=2026-07-05`). Nothing deleted (created from nothing). (The CLI exposes `create-repeating` for PROJECT only — there is no `todo create-repeating` verb.) |
| **RSIM4** | complete the RSIM2 after-completion instance | n/a (probes the next spawn) | Instance `status 0→3`. **Template stamped: `afterCompletionReferenceDate` := 2026-07-05 (the completion date), `nextInstanceStartDate` := 2026-07-12 (completion + interval).** **No new instance row materialized** — the next occurrence is FUTURE-dated (2026-07-12 > pinned 2026-07-05), so it stays pending until that date; a warm/maintenance relaunch did NOT spawn it. |
| **RSIM5** | `todo reschedule-repeat` the RSIM1 template weekly→daily/2 | n/a | **Identity preserved** (same template uuid). Rule rewritten IN PLACE: `fu 256→16` (weekly→daily), `of [{wd:0}]→[{dy:0}]`, anchor epochs (`ia`/`sr`) advanced, `ts`/`tp`/`ed` unchanged; `rt1_instanceCreationStartDate` advanced 2026-07-06→2026-07-12. **CAVEAT: the interval change did NOT apply** (requested 2, stayed `fa=1`); the shipped op correctly **FAILED CLOSED** (`verify-failed: observed interval=1 ≠ expected 2`, exit 3). See caveat below. |
| **RSIM6** | `project make-repeating` FIXED weekly (existing AREA project) | **YES — exactly 1** | Same shape as RSIM1 for `type=1`: original project **DELETED**, template + 1 instance created. **Area PRESERVED** (both template and instance keep the LAB-AREA-A uuid) while `start` normalizes to `2` (Someday) — matches UIC4. |

**Head answer — "does creation spawn an immediate instance?"** YES, exactly one, in every create path. For a **fixed** rule the source is destroyed and a fresh instance is minted at the current-occurrence `startDate` (= today on the pinned clock); for an **after-completion** rule the source item is kept and simply relinked as that single instance. No look-ahead batch of instances is pre-spawned — only the current occurrence exists until the schedule advances.

## The identity asymmetry (fixed vs. after-completion) — refines §8g

The established model (oddities §8g, UIC1) says "making a to-do repeat DESTROYS the original uuid." **That holds for FIXED rules (RSIM1/RSIM6: original deleted) but NOT for after-completion (RSIM2: original preserved, relinked as the instance).** Semantically coherent — an after-completion series' first occurrence *is* the item in front of you (nothing to schedule), so the app retains it; a fixed series' first occurrence is the next calendar slot, so the app mints it fresh and discards the arbitrary source. **Automation consequence:** a wrapper that assumes make-repeating always dangles the source uuid is wrong for after-completion — there the SAME uuid survives as the live instance. (The CLI returns the new TEMPLATE uuid in both cases via DB diff, so callers that use the returned uuid are fine either way.) Recorded as an §8g addendum in [things-app-oddities.md](../things-app-oddities.md).

## Derived RULES a simulator applier must reproduce

Row shapes below are the minimal delta; titles/notes/tags/area copy from the source. Template rows are `start=2` and invisible in list views; instances carry `rt1_recurrenceRule=NULL` and a junk `rt1_nextInstanceStartDate=69760` (an uninitialized sentinel on instances — ignore it; only the TEMPLATE's next-date drives generation).

**`make-repeating` / `create-repeating`, FIXED (`tp=0`) — to-do OR project:**
1. If a source item exists (make-repeating), **DELETE it** (identity replacement). create-repeating has no source.
2. **Create the TEMPLATE:** `rt1_recurrenceRule` = plist `{tp:0, fu:<freq>, fa:<interval>, of:<anchor>, ts:0, rc:0, ed:64092211200.0, rrv:4, ia:<anchorEpoch>, sr:<anchorEpoch>}`; `start=2`; `startDate=NULL`; `deadline=NULL` (deadline-less default, §8a — a deadlined variant sets the template `deadline` column to the 4001-01-01 sentinel and `ts=-N`); `rt1_instanceCreationCount=1`; `rt1_instanceCreationStartDate` and `rt1_nextInstanceStartDate` = the NEXT occurrence after today.
3. **Create ONE INSTANCE:** `rt1_repeatingTemplate`=template uuid; `rt1_recurrenceRule=NULL`; `startDate`=the CURRENT occurrence (= today when the schedule includes today); `start=2` (pending promotion to `start=1` by maintenance); `deadline=NULL`.

**`make-repeating`, AFTER-COMPLETION (`tp=1`):**
1. **KEEP the source item; relink it as the instance:** set its `rt1_repeatingTemplate` = new template uuid. Its `startDate`/`start` are unchanged (identity preserved).
2. **Create the TEMPLATE:** rule `{tp:1, fu:<cadence>, fa:<interval>, of:<anchor>, ts:0, …}`; `start=2`; `startDate=NULL`; `rt1_instanceCreationCount=0`; `rt1_nextInstanceStartDate=NULL`; `rt1_afterCompletionReferenceDate=NULL` (both unknown until a completion).
3. **Do NOT create a fresh instance** — the reused source item is the sole first instance.

**Complete an AFTER-COMPLETION instance:**
1. Instance: `status 0→3` (+ `stopDate`).
2. Template: `rt1_afterCompletionReferenceDate` := the completion date; `rt1_nextInstanceStartDate` := completion date + interval (weekly/1 → +7 days).
3. **Do NOT materialize the next instance now** — it spawns only when `rt1_nextInstanceStartDate` arrives (a future-dated, pending occurrence). On a pinned clock earlier than that date, no new row appears.

**`reschedule-repeat`, FIXED:**
1. **Identity preserved** — same template uuid.
2. Rewrite `rt1_recurrenceRule` in place: swap `fu` to the new frequency code, swap `of` to the new anchor, advance the `ia`/`sr` anchor epochs to the new next occurrence; keep `tp`, `ts`, `ed`.
3. Advance `rt1_instanceCreationStartDate` to the new next occurrence.
4. The simulator models this as an in-place rule REPLACE (unit + interval + anchors); see the interval caveat.

## Caveat — reschedule interval-field did not apply (RSIM5, follow-up wanted)

The `reschedule-repeat weekly→daily interval 2` drive changed the UNIT (fu 256→16, DB-verified) with identity preserved, but the INTERVAL stayed `fa=1` instead of becoming 2, and the shipped op **fail-closed** on its own verify (`observed interval=1 ≠ expected 2`, exit 3 — the fail-closed guard working exactly as designed). This is most likely a **ui-recipe** interval-entry gap on the reschedule path (the make-repeating path set interval=1 fine; UIC6 certified reschedule round-trips, so the regression is narrow), not a data-model fact — so it does NOT change the simulator applier (which just needs the target `{fu, fa}`). Flagged here for a targeted follow-up probe (drive reschedule with an interval strictly ≠ the prior interval and inspect the dialog's interval field state). Not filed as an app bug (recipe-vs-app unresolved).

## Reproduction notes

- One clone, ~15 min end to end. VM lifecycle, the AXVM1 Accessibility grant (VNC toggle at the golden's 2048×1536 framebuffer), and the guest e2e bundle ship mirror `research-rem1.sh`. Two environment gotchas this campaign hit and the script now guards: (1) the git **worktree** must be `npm ci`'d before the build (its `node_modules` is not shared with the primary checkout); (2) a detached run must select a **self-contained** node — the asdf/.tool-versions node links no `/opt/homebrew` dylibs, whereas a homebrew node does and dyld-fails when shipped into the guest. The script resolves the pinned version from the MAIN worktree's `.tool-versions` (the worktree copy is gitignored) and rejects any node with `/opt/homebrew` deps.
- The host `macOS 2-VM limit`: orphaned `com.apple.Virtualization.VirtualMachine` XPC processes from a killed run hold the limit and make the next `tart run` fail with "The number of VMs exceeds the system limit" (guest never boots, the ssh wait hangs). Recovery = `pgrep -fl com.apple.Virtualization.VirtualMachine`, kill the orphans, re-clone.
- The template is the row with `rt1_recurrenceRule IS NOT NULL`; its spawned instances are `rt1_repeatingTemplate = <template uuid>`. Templates live in `start=2` (why list views never show them).

---

# RSIM-P — repeating-PROJECT children semantics

**Verdict (2026-07-18): making a project repeat DEEP-DUPLICATES its entire child subtree.** RSIM characterized the template+instance pair for a repeating project (RSIM3/RSIM6) but said nothing about the CHILDREN. RSIM-P closes that: a `project make-repeating` (fixed OR after-completion) HARD-DELETES the source project **and every descendant** (headings + to-dos + their tags + their checklist items) and mints **two independent copies** of the whole subtree — one hanging off the hidden **template** project, one off the **instance** project. Copies are fresh uuids; TMTaskTag and TMChecklistItem rows are duplicated per copy. Template-side children are **completely plain rows** (`rt1_recurrenceRule=NULL`, `rt1_repeatingTemplate=NULL`, `start=1`) — their ONLY tie to templatehood is their `project`/`heading` pointer chain to the template project. This DIRECTLY CONTRADICTS the shipped simulator (`applyMakeRepeatingFixed`/`applyMakeRepeatingAfterCompletion` ignore children entirely) — see the SIMFID divergences below. Also settled: completing an instance project cascades completion through the duplicated subtree (**including the heading row**) without a re-spawn on a pinned-past clock; the CLI's `todo move` treats a template project as an ordinary container (moves in/out succeed clean, no guard, no residue); and `things show` marks the PROJECT's template/instance status but leaves every CHILD's `repeating` block empty.

Same rig as RSIM: ONE disposable `--vnc-experimental` clone `rsim-p-lab` of `things-lab-golden-v1` (golden untouched), airgapped, clock pinned **2026-07-05 12:00**, Things **3.22.11 / macOS 15.7.7 / DB v26**, Accessibility via the AXVM1 rung-b VNC toggle, driven through the **production CLI** shipped as the guest e2e bundle. Branch `mg/rsim-p`. Script: [`lab/scripts/research-rsim-p.sh`](../../lab/scripts/research-rsim-p.sh). Snapshot differ widened to **TMTask + TMTaskTag + TMChecklistItem** (+ a TMArea name map); a `kids.py` guest helper dumps a project's full containment subtree. Fixtures fully synthetic. Artifacts (gitignored): `lab/artifacts/rsim-p-lab/` (`report.txt`, `run.log`, `snaps/*.json`, `show/*.json`, `diff_snaps.py`).

## Executed verdicts (2026-07-18)

| Probe | Case | Verdict |
|---|---|---|
| **P1** | fixed `project make-repeating` on **Proj Alpha** (area *Zone A*, heading *Phase 1*, *Task A1* = tag+notes+2 checklist under the heading, *Task A2* direct) | **Children DUPLICATED, deep + symmetric.** 4 source rows DELETED; **8 INSERTED** = two identical 4-row subtrees. TMTaskTag 1→2 (both Task A1 copies re-tagged), TMChecklistItem 2→4 (2 per copy). Template-side & instance-side children are **plain** (`tmpl=NULL`, `rule=NULL`, `start=1`); the containment invariant is preserved (headed child `project=NULL heading=<h>`, direct child `project=<p> heading=NULL`). Only the two PROJECT rows differ: template = `start=2 startDate=NULL rule(tp=0,fu=256,fa=1,of=[{wd:0}],ts=0,ed=∞) icCount=1 next=2026-07-12`; instance = `start=2 startDate=2026-07-05 tmpl=<template> rule=NULL`. Area *Zone A* kept on both projects. Warm/maintenance delta = 0. |
| **P2** | complete the **instance** project (`project complete --children auto-complete`) | **Succeeds via `url-scheme` (tier 1) — no repeating guard** (the instance is a plain project row with a `tmpl` pointer; only the TEMPLATE is guarded). Cascades `status 0→3` to both child to-dos **and the heading row** (type=2), and to the project (`start 2→1`, `status 0→3`). **No re-duplication, no spawn** — immediate AND post-warm deltas both 0 INSERT. The fixed next occurrence is 2026-07-12 (future > pinned 2026-07-05), so it stays pending (RSIM4 timing law); the template row is untouched and still holds the rule, so the series lives on. |
| **P3** | escape hatch: move a **template-side child** OUT to a plain project; move a plain to-do INTO the template project | **Both succeed via `url-scheme` (tier 1), clean, no guard, no residue.** Forward: *Task A2* `project: <template> → Plain Proj` — the moved row is an ordinary plain to-do (`start=1`, no `start=2` residue, no dangling markers). Reverse: *Loose T1* `project: Plain Proj → <template>` — it lands as a plain child of the template subtree (and would therefore be copied into future instances). The CLI's `todo.move` has **no awareness** that a container is a repeating template. |
| **P4** | after-completion `project make-repeating` on **Beta Proj** (2 direct children) | **SURPRISE — the after-completion PROJECT does NOT preserve the source** (unlike the after-completion TO-DO, RSIM2). 3 source rows DELETED; **6 INSERTED** = template + instance, each with a full child copy. Template = `tp=1 start=2 startDate=NULL icCount=1 next=NULL` (after-completion shape); instance = `start=2 startDate=2026-07-05 tmpl=<template>`. **Child-marker asymmetry vs P1:** template-side children are plain (`tmpl=NULL`), but each **instance-side child carries `rt1_repeatingTemplate` = its corresponding template-side child** (Task B1→template-B1, Task B2→template-B2) — a per-child template↔instance link that the FIXED case does NOT create. Warm delta = 0 (links persist). |
| **P5** | `things show --json` on template project, instance project, template-side child, instance-side child | Template project `repeating` = `{isTemplate:true, isInstance:false, templateUuid:null, nextOccurrence:"2026-07-12", paused:false, deadlined:false}`; instance project = `{isTemplate:false, isInstance:true, templateUuid:"<template>"}`. **Every CHILD — on both sides — projects `{isTemplate:false, isInstance:false, templateUuid:null}`**: `show` gives NO signal that a to-do belongs to a template or instance project. (A `project show` on the template DOES list its children in the normal `active`/`headings` sections, so the child set is reachable — but each child looks like a plain to-do.) Raw JSON in `lab/artifacts/rsim-p-lab/show/`. |

## Row-level evidence (P1, fixed — the canonical shape)

Pre-state (`kids.py`): `Proj Alpha[KBAJ…]` → heading `Phase 1[SiZ…]` → `Task A1[E13…]` (tags=1, chk=2) ; direct `Task A2[AhV…]`.

`project make-repeating <Proj Alpha> --frequency weekly --interval 1 --dangerously-drive-gui` (vector=**ui**, tier 3, 9 AX steps, `observed.repeating.isTemplate=true`, exit 0). Delta **INSERTED 8 / DELETED 4 / CHANGED 0**:

```
- DELETE  Proj Alpha[KBAJ…] (type=1)  Phase 1[SiZ…] (type=2)  Task A1[E13…]  Task A2[AhV…]
+ TEMPLATE  Proj Alpha[4juaNJQm]  type=1 start=2 startDate=NULL area=Zone A
            rule(628B){tp=0, fu=256, fa=1, of=[{wd:0}], ts=0, rc=0, ed=64092211200.0, rrv=4, ia=sr=1783209600.0}
            icCount=1 nextInstanceStartDate=2026-07-12   (tmpl=NULL)
    +  Phase 1[B9Y1…]   type=2 start=1 project=4juaNJQm  (plain)
    +    Task A1[2tAy…] type=0 start=1 heading=B9Y1 project=NULL  tag=AlphaTag  chk=[Sub 1, Sub 2]  (tmpl=NULL)
    +  Task A2[AyMC…]   type=0 start=1 project=4juaNJQm  (plain)
+ INSTANCE  Proj Alpha[K6bMGc88]  type=1 start=2 startDate=2026-07-05 area=Zone A tmpl=4juaNJQm rule=NULL
    +  Phase 1[CqTs…]   type=2 start=1 project=K6bMGc88  (plain)
    +    Task A1[9kCA…] type=0 start=1 heading=CqTs project=NULL  tag=AlphaTag  chk=[Sub 1, Sub 2]  (tmpl=NULL)
    +  Task A2[TSoz…]   type=0 start=1 project=K6bMGc88  (plain)
  TMTaskTag  +2 (Task A1 both copies ← AlphaTag)  −1 (old Task A1)
  TMChecklistItem  +4 (Sub 1/Sub 2 × both copies)  −2 (old Task A1)
```

The **instance child set exactly mirrors the template's** — same structure, same tag, same two checklist items — differing only in the two PROJECT rows' recurrence columns. Nothing distinguishes a template-side child from an instance-side child in the FIXED case except which project it points at.

## Derived RULES a simulator applier must reproduce (extends the RSIM appliers)

**`make-repeating` on a PROJECT that has children — BOTH fixed and after-completion:**
1. **Recursively HARD-DELETE the source subtree** (the project row, all its headings, all direct + headed to-dos, and those to-dos' TMTaskTag + TMChecklistItem rows). The source project uuid and every descendant uuid are gone.
2. **Mint the template project** (RSIM3/RSIM6 shape) **and a full plain copy of the subtree beneath it** — new uuids for every heading/to-do; copy notes/tags/checklist; preserve the containment invariant (headed to-do `project=NULL heading=<newHeading>`; direct to-do `project=<templateProject>`); children are `start=1`, `rt1_recurrenceRule=NULL`.
3. **Mint the instance project** (`rt1_repeatingTemplate=<template>`, `startDate`=current occurrence for fixed / source `startDate` for after-completion) **and a second full copy of the subtree beneath it**.
4. **FIXED:** instance-side children are plain (`rt1_repeatingTemplate=NULL`). **AFTER-COMPLETION:** each instance-side child sets `rt1_repeatingTemplate` = its corresponding **template-side child** (per-child mirror of the project link).
5. The **after-completion PROJECT deletes its source** (contrast the after-completion TO-DO, RSIM2, which preserves it). So the type=1 after-completion path is NOT the type=0 after-completion path.

**Complete an INSTANCE project:** cascade `status 0→3` to every open descendant to-do **and every heading row** (type=2); set the project `start→1`, `status→3`. Do NOT spawn or re-duplicate; the next occurrence materializes only when its date arrives (future-dated → nothing on a pinned-past clock).

## SIMFID divergences — flagged for the fidelity suite (`src/write/vectors/simulator.ts`)

These make-repeating-on-a-project-with-children cases are **wrong in the shipped simulator today** (the appliers were written from RSIM's childless to-do/project evidence):

1. **`applyMakeRepeatingFixed` (project): children are ignored → orphaned.** It deletes the source project row + its own TMTaskTag and creates template+instance, but never touches the source's child rows. In the sim DB those children survive pointing at the deleted project uuid (orphans), and NO template-side or instance-side child copies exist. Reality deletes them and produces two full duplicate subtrees (incl. duplicated TMChecklistItem/TMTaskTag). **Fix:** the type=1 fixed applier must recurse-delete the source subtree and duplicate it under both new projects.
2. **`applyMakeRepeatingAfterCompletion` (project): doubly wrong.** (a) It PRESERVES + relinks the source as the instance and mints no fresh instance — correct for a to-do (RSIM2), WRONG for a project (P4 deletes the source and mints both template and instance). (b) It ignores children — reality duplicates them under both projects AND sets each instance-side child's `rt1_repeatingTemplate` to its template-side sibling. **Fix:** split the after-completion applier by type — type=1 follows the fixed delete+duplicate shape (with a `tp=1` rule and no next/reference dates) plus the per-child instance→template links.
3. **`project.complete`: heading row status not cascaded.** The sim cascades only `type=0` children (`WHERE type = 0 …`); reality also flips the containing **heading (type=2)** row `status 0→3` (P2). Minor, but a normalized-delta mismatch SIMFID will catch. (The sim also does not model the instance project's `start 2→1` on completion.)

None of the RSIM1–RSIM6 to-do/childless-project verdicts are contradicted — the divergences are strictly about **project children**, which RSIM never exercised.

## Design input — marking "this to-do belongs to a template project" (P5)

The pending question (probe-backlog): should `show` surface that a to-do lives under a repeating template? Evidence: today it does not. A template-side child (e.g. the moved-in *Loose T1*, or *Task A1* under *Phase 1*) renders with `repeating:{isTemplate:false,isInstance:false,templateUuid:null}` and a normal `project:{…}` block — indistinguishable from a plain to-do, even though it is a **latent copy that regenerates on every occurrence**. Editing/completing/moving such a child (P3 shows moves are unguarded) silently changes what future instances will contain. If a marker is added, note the FIXED-vs-after-completion asymmetry: instance-side children of an after-completion project already carry `rt1_repeatingTemplate` (so `isInstance` could be derived), but template-side children (both cases) and fixed instance-side children carry NO column marker — the only signal is the project pointer's template/instance status, which the projection would have to resolve by a parent lookup.

## Reproduction notes (RSIM-P)

- One clone, ~12 min end to end; same lifecycle/toolchain guards as RSIM (self-contained node, worktree `npm ci`, VM-limit orphan recovery). Fixture built through the shipped CLI: `area add` (applescript), a `things:///json` add-project payload for the project+heading (headings only mint inside a new-project payload — golden-seed lesson), then `todo add --project --heading --tags --create-tags --checklist-item …` — one URL-scheme call landed the tag + 2 checklist items + heading placement cleanly.
- `project make-repeating` is a **ui-vector** op needing `--dangerously-drive-gui` (+ `ui-enabled` config), NOT the `--allow-disruptive` the original brief named — `--allow-disruptive` alone caps disruption at tier 2 and would refuse the tier-3 GUI drive.
- **Boundary not closed here:** whether the app RE-duplicates the subtree when the NEXT fixed occurrence spawns (2026-07-12) is not observable on a pinned-past clock (RSIM4 timing law); the template retains the full child subtree, so a copy is the strong inference. A follow-up that advances the guest clock past the next occurrence would confirm it (and would show whether the after-completion child→child links propagate to the next instance).
