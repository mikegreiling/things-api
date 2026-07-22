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

**Head answer — "does creation spawn an immediate instance?"** YES, exactly one, in every create path. For a **fixed** rule the source is destroyed and a fresh instance is minted at the current-occurrence `startDate` (= today on the pinned clock) — **[REFINED by §RSIM-R: "destroyed" is the default; a fixed project whose subtree holds a nested repeater instead PRESERVES the source as the instance]**; for an **after-completion** rule the source item is kept and simply relinked as that single instance. No look-ahead batch of instances is pre-spawned — only the current occurrence exists until the schedule advances.

## The identity asymmetry (fixed vs. after-completion) — refines §8g

The established model (oddities §8g, UIC1) says "making a to-do repeat DESTROYS the original uuid." **That holds for FIXED rules (RSIM1/RSIM6: original deleted) but NOT for after-completion (RSIM2: original preserved, relinked as the instance).** **[CORRECTED by §RSIM-R: the fixed/after-completion split is not the whole story — a fixed conversion ALSO preserves the source when it is a project whose subtree contains a nested repeater (the flatten path), and possibly for a content-rich to-do. The clean discriminator for projects is "subtree has a nested repeater," not the rule type; area and schedule are irrelevant.]** Semantically coherent — an after-completion series' first occurrence *is* the item in front of you (nothing to schedule), so the app retains it; a fixed series' first occurrence is the next calendar slot, so the app mints it fresh and discards the arbitrary source. **Automation consequence:** a wrapper that assumes make-repeating always dangles the source uuid is wrong for after-completion — there the SAME uuid survives as the live instance. (The CLI returns the new TEMPLATE uuid in both cases via DB diff, so callers that use the returned uuid are fine either way.) Recorded as an §8g addendum in [things-app-oddities.md](../things-app-oddities.md).

## Derived RULES a simulator applier must reproduce

Row shapes below are the minimal delta; titles/notes/tags/area copy from the source. Template rows are `start=2` and invisible in list views; instances carry `rt1_recurrenceRule=NULL` and a junk `rt1_nextInstanceStartDate=69760` (an uninitialized sentinel on instances — ignore it; only the TEMPLATE's next-date drives generation).

> **[CORRECTED by §RSIM-R, 2026-07-19]** Rule 1 below ("always DELETE the source") is the DEFAULT, but the source is PRESERVED (relinked as the instance) when the source is a **project whose subtree contains a nested repeater** (the flatten path), and may be preserved for a content-rich to-do. The DELETE verdicts here (RSIM1 bare to-do; RSIM6 area'd/plain-children project) are correct for their cases. See §RSIM-R for the full conditional law.

**`make-repeating` / `create-repeating`, FIXED (`tp=0`) — to-do OR project:**
1. If a source item exists (make-repeating), **DELETE it** (identity replacement) — *unless* the fixed-preserve condition holds (§RSIM-R: project-with-nested-repeater, or content-rich to-do), in which case the source is KEPT and relinked as the instance and only the template is minted fresh. create-repeating has no source.
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
| **P4** | after-completion `project make-repeating` on **Beta Proj** (2 direct children) | **SURPRISE — the after-completion PROJECT does NOT preserve the source** (unlike the after-completion TO-DO, RSIM2). 3 source rows DELETED; **6 INSERTED** = template + instance, each with a full child copy. Template = `tp=1 start=2 startDate=NULL icCount=1 next=NULL` (after-completion shape); instance = `start=2 startDate=2026-07-05 tmpl=<template>`. **Child-marker asymmetry vs P1:** template-side children are plain (`tmpl=NULL`), but each **instance-side child carries `rt1_repeatingTemplate` = its corresponding template-side child** (Task B1→template-B1, Task B2→template-B2) — a per-child template↔instance link that the FIXED case does NOT create. Warm delta = 0 (links persist). **[CORRECTED by §RSIM-R, 2026-07-19: these per-child links are a NON-REPRODUCIBLE anomaly. Re-running P4's exact config (R7) plus A5 and R8 all yielded PLAIN instance-side children (no per-child link) — 3/3. P4 is the lone linked observation; the app's per-child stamping is nondeterministic. The reproducible law is PLAIN instance children.]** |
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
4. **FIXED:** instance-side children are plain (`rt1_repeatingTemplate=NULL`). ~~**AFTER-COMPLETION:** each instance-side child sets `rt1_repeatingTemplate` = its corresponding **template-side child** (per-child mirror of the project link).~~ **[CORRECTED by §RSIM-R: after-completion instance-side children are ALSO PLAIN — P4's per-child links do not reproduce (A5/R7/R8 = 3/3 plain). Do not model them.]**
5. The **after-completion PROJECT deletes its source** (contrast the after-completion TO-DO, RSIM2, which preserves it). So the type=1 after-completion path is NOT the type=0 after-completion path. **[Confirmed by §RSIM-R: R7/R8 after-completion projects both deleted their source.]**

**Complete an INSTANCE project:** cascade `status 0→3` to every open descendant to-do **and every heading row** (type=2); set the project `start→1`, `status→3`. Do NOT spawn or re-duplicate; the next occurrence materializes only when its date arrives (future-dated → nothing on a pinned-past clock).

## SIMFID divergences — flagged for the fidelity suite (`src/write/vectors/simulator.ts`)

These make-repeating-on-a-project-with-children cases are **wrong in the shipped simulator today** (the appliers were written from RSIM's childless to-do/project evidence):

1. **`applyMakeRepeatingFixed` (project): children are ignored → orphaned.** It deletes the source project row + its own TMTaskTag and creates template+instance, but never touches the source's child rows. In the sim DB those children survive pointing at the deleted project uuid (orphans), and NO template-side or instance-side child copies exist. Reality deletes them and produces two full duplicate subtrees (incl. duplicated TMChecklistItem/TMTaskTag). **Fix:** the type=1 fixed applier must recurse-delete the source subtree and duplicate it under both new projects.
2. **`applyMakeRepeatingAfterCompletion` (project): doubly wrong.** (a) It PRESERVES + relinks the source as the instance and mints no fresh instance — correct for a to-do (RSIM2), WRONG for a project (P4 deletes the source and mints both template and instance). (b) It ignores children — reality duplicates them under both projects ~~AND sets each instance-side child's `rt1_repeatingTemplate` to its template-side sibling~~. **Fix:** split the after-completion applier by type — type=1 follows the fixed delete+duplicate shape (with a `tp=1` rule and no next/reference dates) ~~plus the per-child instance→template links~~ with instance-side children left PLAIN. **[CORRECTED by §RSIM-R: NO per-child instance→template links — P4's links do not reproduce (A5/R7/R8). The applier must leave instance-side children plain, i.e. pass `null` to the subtree-copy exactly as the fixed case does.]**
3. **`project.complete`: heading row status not cascaded.** The sim cascades only `type=0` children (`WHERE type = 0 …`); reality also flips the containing **heading (type=2)** row `status 0→3` (P2). Minor, but a normalized-delta mismatch SIMFID will catch. (The sim also does not model the instance project's `start 2→1` on completion.)

None of the RSIM1–RSIM6 to-do/childless-project verdicts are contradicted — the divergences are strictly about **project children**, which RSIM never exercised.

## Design input — marking "this to-do belongs to a template project" (P5)

The pending question (probe-backlog): should `show` surface that a to-do lives under a repeating template? Evidence: today it does not. A template-side child (e.g. the moved-in *Loose T1*, or *Task A1* under *Phase 1*) renders with `repeating:{isTemplate:false,isInstance:false,templateUuid:null}` and a normal `project:{…}` block — indistinguishable from a plain to-do, even though it is a **latent copy that regenerates on every occurrence**. Editing/completing/moving such a child (P3 shows moves are unguarded) silently changes what future instances will contain. If a marker is added, note the FIXED-vs-after-completion asymmetry: instance-side children of an after-completion project already carry `rt1_repeatingTemplate` (so `isInstance` could be derived), but template-side children (both cases) and fixed instance-side children carry NO column marker — the only signal is the project pointer's template/instance status, which the projection would have to resolve by a parent lookup.

## Reproduction notes (RSIM-P)

- One clone, ~12 min end to end; same lifecycle/toolchain guards as RSIM (self-contained node, worktree `npm ci`, VM-limit orphan recovery). Fixture built through the shipped CLI: `area add` (applescript), a `things:///json` add-project payload for the project+heading (headings only mint inside a new-project payload — golden-seed lesson), then `todo add --project --heading --tags --create-tags --checklist-item …` — one URL-scheme call landed the tag + 2 checklist items + heading placement cleanly.
- `project make-repeating` is a **ui-vector** op needing `--dangerously-drive-gui` (+ `ui-enabled` config), NOT the `--allow-disruptive` the original brief named — `--allow-disruptive` alone caps disruption at tier 2 and would refuse the tier-3 GUI drive.
- **Boundary not closed here:** whether the app RE-duplicates the subtree when the NEXT fixed occurrence spawns (2026-07-12) is not observable on a pinned-past clock (RSIM4 timing law); the template retains the full child subtree, so a copy is the strong inference. A follow-up that advances the guest clock past the next occurrence would confirm it (and would show whether the after-completion child→child links propagate to the next instance).

---

# RSIM-P2 — nested repeaters + uuid-discovery adversarial traps

**Verdict (2026-07-19): converting a project that contains a repeating to-do FLATTENS the nested repeater (its template row is hard-deleted, its rule is dropped, and both the ex-template and ex-instance survive only as PLAIN copies) — there is NO template-of-template and the instance project gets NO working nested repeater; AND the shipped uuid-discovery binds the new template correctly through a same-title gauntlet, but the discovery-hardening plan's "source-gone" assumption is FALSE on this build.** Two worklists in ONE disposable `--vnc-experimental` clone `rsim-p2-lab` of `things-lab-golden-v1` (golden untouched; airgapped; clock pinned **2026-07-05 12:00**; Things **3.22.11 / macOS 15.7.7 / DB v26**; Accessibility via the AXVM1 rung-b VNC toggle; driven through the **production CLI** shipped as the guest e2e bundle). Branch `mg/rsim-p2`, on **main @ 5084323** (RSIM/RSIM-P ran on the older `mg/rsim-p` @ b0d737f — relevant to the source-preservation divergence below). Script: [`lab/scripts/research-rsim-p2.sh`](../../lab/scripts/research-rsim-p2.sh). Same TMTask+TMTaskTag+TMChecklistItem differ as RSIM-P, plus `creationDate`/`userModificationDate` capture (for the time-bound analysis) and a per-child `rule?/tmpl` dump in `kids.py`. Fixtures fully synthetic. Artifacts (gitignored): `lab/artifacts/rsim-p2-lab/` (`report.txt`, `snaps/*.json`, `drive-*.log`, `diff_snaps.py`).

> **Two systematic contradictions of prior law — flagged for SIMFID (do not silently fold in):**
> 1. **Source PRESERVED-as-instance, not deleted.** Every FIXED conversion here — a to-do (**B3**) and three projects (**A1/A2/A3**) — KEPT the source row and relinked it as the instance (`rt1_repeatingTemplate` set in place), minting only the *template* fresh. RSIM1 and RSIM-P P1 documented the source **DELETED** with BOTH template and instance fresh. Systematic, not a one-off. The after-completion PROJECT (**A5**) DID delete its source (matches RSIM-P P4). Likely axis: **fixed conversions reuse the source as the current-occurrence instance; after-completion PROJECT conversions delete-and-recreate.** The RSIM/RSIM-P source-deletion reports may reflect the older build's recipe (b0d737f), a source scheduling-state dependence (RSIM1's source was `when=today`), or an area interaction (RSIM-P P1 was area'd; all RSIM-P2 cases are area-less). **A targeted reconciliation re-run is the right next step; not resolved here.** **[RESOLVED by §RSIM-R, 2026-07-19: the guessed axes are ALL WRONG. It is NOT build/recipe (same build+recipe throughout), NOT scheduling-state (a today-scheduled project R1 still deletes), and NOT area (an area'd R4 deletes, an area-less bare R3 deletes). The real axis: a fixed PROJECT conversion preserves the source IFF its subtree contains a NESTED REPEATER (A1/A2/A3 all did; the flatten path keeps the source) — plain-children/empty projects delete (S1/R1/R3/R4). The B3 to-do preserve is a separate content trigger (checklist EXCLUDED by S3; not isolated). "Fixed always preserves" was an over-generalization from samples that all had a nested repeater or rich content.]**
> 2. **After-completion instance-side CHILDREN carry NO per-child FK link (A5).** RSIM-P P4 reported each instance-side child's `rt1_repeatingTemplate` = its template-side sibling. In A5 (after-completion project WITH a heading) **every** instance-side child — the heading (type=2), the headed to-do, AND the direct to-do — is PLAIN (`rt1_repeatingTemplate=NULL`); only the project-level instance→template link exists. So the coordinator's A5 question — *do instance-side heading rows carry FK links?* — answers **NO, they stay plain (confirms the simulator's current choice)**, and the finding EXTENDS to to-do children too (contradicting P4). See A5 + the SIMFID subsection.

## Executed verdicts (2026-07-19)

| Probe | Case | Verdict |
|---|---|---|
| **A1** | nested **FIXED** repeater: project *Proj Nest* {*Task N1*, *Daily N2*→made fixed-daily-repeating in place} then `project make-repeating` weekly | **Nested repeater FLATTENED.** Pre-state confirmed: the `todo make-repeating` on *Daily N2* left BOTH the nested template (rule `fu=16`) and its instance as **direct children of the project** (project pointer = Proj Nest). Project conversion delta = **INSERT 5 / DELETE 1 / CHANGE 2**: the nested **template row is HARD-DELETED**; its instance is DEMOTED to plain (`rt1_repeatingTemplate` cleared → NULL); each project subtree ends with 1×*Task N1* + **2× plain *Daily N2*** (rule=NULL, tmpl=NULL) — no template-of-template, no working nested repeater, no `rt1_*` recurrence columns survive the copy. Source project **PRESERVED as the instance** (see contradiction #1); only the template project minted fresh. |
| **A2** | same but nested repeater is **AFTER-COMPLETION** (`tp=1`) | **Identical outcome to A1** — the conversion treats a fixed vs after-completion nested repeater the same: nested template (here `tp=1`) hard-deleted, instance demoted to plain, both subtrees hold plain copies. No difference. (Project conversion itself was fixed-weekly; source project preserved-as-instance again.) |
| **A3** | edge-state children: a **completed** child (`status=3`), a **trashed** child (`trashed=1`), and a child that is an **instance of an EXTERNAL repeating to-do** (template outside the project); then `project make-repeating` weekly | **INSERT 3 / DELETE 0 / CHANGE 2.** Source project PRESERVED-as-instance (keeps all 3 originals). The fresh TEMPLATE side got only **2** children: **completed child → copied but RE-OPENED** (`status 3→0`); **trashed child → NOT copied** (skipped); **external-instance child → copied as PLAIN with its external `rt1_repeatingTemplate` CLEARED to NULL**. The external template's instance set is **NOT polluted** — `WHERE rt1_repeatingTemplate=<extTemplate>` still returns exactly the one original (preserved on the instance side, pointer intact). |
| **A5** | **after-completion** project *Proj Head* {heading *Head H1* → *Headed T1*; direct *Direct T2*} → `project make-repeating --after-completion` weekly (coordinator addendum) | **INSERT 8 / DELETE 4** — source subtree fully deleted, template + instance both fresh (unlike A1–A3). Containment preserved on both sides (headed to-do `project=NULL heading=<h>`; direct `project=<proj>`). **Instance-side HEADING rows are PLAIN** (`rt1_repeatingTemplate=NULL`), and so are the instance-side headed AND direct to-dos — only the project row carries the instance→template link. **Confirms the simulator's "headings left plain"; contradicts RSIM-P P4's per-child to-do links (contradiction #2).** |
| **B1** | same-title **"Ditto"** gauntlet — standalone + in-project + an already-repeating (own template `fu=256`+instance, all titled *Ditto*); then make the STANDALONE one repeating (monthly) via the CLI | **Discovery binds CORRECTLY.** CLI returned template `LnJVuTmA…`; DB ground truth = the ONLY inserted row is that monthly (`fu=8`) template, source deleted, and it is distinct from the pre-existing weekly (`fu=256`) template `CfDdvj2N…`. No misbinding, no ambiguity error, despite 4 pre-existing same-title rows. The `sameTitleUuids` exclude-set + `isTemplate` assertion is sufficient here. (Monthly's first occurrence was future-dated → NO instance spawned at create; only the template appeared — source hard-deleted, unlike the preserve-as-instance fixed-weekly cases.) |
| **B2** | mid-write insertion: inject a same-title row unseen by the pre-read, mid-drive (×3) | **Race not reachable via a local add — the write FAILS CLOSED first.** All 3 tries returned `verify-failed:silent-noop` (exit 3): a concurrent `things:///add` fired during the GUI drive DISMISSED the open Repeat sheet (the driver aborts with Escape when the expected element vanishes), so `make-repeating` never landed and never bound to any row. The injected row is also PLAIN, which `isTemplate` would filter anyway. Realistic misbinding window (analytic): a same-title **TEMPLATE** row inserted between the pre-read and the post-write discovery poll (e.g. a Cloud-sync insert) — see Discovery-hardening constraints. |
| **B3** | source-fingerprint viability: rich to-do (notes + tag + deadline + 2-item checklist) → fixed weekly repeating | **INSERT 1 (template) / CHANGE 1 (source→instance).** Template INHERITS notes + tag + checklist (2 fresh TMChecklistItem rows) verbatim; template **does NOT carry the deadline** (template `deadline=NULL`). The source, PRESERVED as the instance, RETAINS its deadline (2026-08-15), notes, tag, checklist. So a source-fingerprint match can safely compare **notes + tags + checklist titles + container pointer**, but NOT deadline (asymmetric: on the template it is dropped). |
| **B4** | `rt1_repeatingTemplate` FK integrity across every minted template | **FK is exact and clean.** Each project template → exactly its **type=1** instance; each deleted nested template → empty; the B3 to-do template → exactly its one instance (the preserved source). A5's after-completion project template → ONLY the type=1 instance, **no child-link pollution** (A5 children have no links; and even P4-style child links point at *child*-templates, never the project template, so a project-template FK lookup can't return them). Disambiguation rule if ever needed: filter the FK by `type`. |
| **A4** | clock-advance past the next fixed occurrence (re-duplication?) | **IMPRACTICAL in this VM — reported, not chased (per brief).** Advancing the guest clock to 2026-07-20 (+15 days) destabilized the session: the next warm relaunch's AppleScript quit returned `User canceled (-128)` and the `/tmp` guest helpers had vanished (consistent with a reboot clearing `/tmp` after the large forward jump), so no post-advance snapshot could be taken. The RSIM-P open boundary (does the next occurrence re-duplicate the subtree / spawn a fresh nested repeater) **remains open.** A future attempt must re-pin the clock and RE-INSTALL the `/tmp` helpers after the post-advance relaunch (RSIM-P's reboot-clears-/tmp note), or advance in smaller steps. |

## Row-level evidence — A1 (the canonical nested-flatten shape)

Pre-conversion subtree of `Proj Nest[6JqrLqTN]` (plain project) after `todo make-repeating "Daily N2"` fixed-daily:
```
Task N1[KxGberbp]           plain
Daily N2[5rn993xv]  rule(fu=16,tp=0)   ← nested TEMPLATE, direct child of the project
Daily N2[TNh5pDiG]  tmpl=5rn993xv      ← nested instance,  direct child of the project
```
`project make-repeating "Proj Nest" --frequency weekly --interval 1 --dangerously-drive-gui` (vector=ui, tier 3, `observed.repeating.isTemplate=true`, exit 0). Delta **INSERT 5 / DELETE 1 / CHANGE 2**:
```
- DELETE Daily N2[5rn993xv]   the nested TEMPLATE (rule fu=16) — hard-deleted
~ CHANGE Proj Nest[6JqrLqTN]  start 1→2, startDate→2026-07-05, rt1_repeatingTemplate→[HEmYQj1W]   ← SOURCE becomes the INSTANCE
~ CHANGE Daily N2[TNh5pDiG]   rt1_repeatingTemplate 5rn993xv→NULL                                  ← nested instance DEMOTED to plain
+ INSERT Proj Nest[HEmYQj1W]  type=1 start=2 rule(fu=256,tp=0) icCount=1 next=2026-07-12           ← the TEMPLATE project (fresh)
+ INSERT Task N1[MVr7f5nd]    plain, project=[HEmYQj1W]     (template-side copy)
+ INSERT Daily N2[WkUDsD2M]   plain, project=[HEmYQj1W]     (template-side copy #1)
+ INSERT Daily N2[UT3cjnCy]   plain, project=[HEmYQj1W]     (template-side copy #2)
+ INSERT Daily N2[2YsL8zZh]   plain, project=[6JqrLqTN]     (instance-side fresh copy)
```
Both subtrees end **{Task N1, Daily N2, Daily N2}**, all plain (`rule=NULL, tmpl=NULL`). The nested repeater is gone: no rule survives, the FK is cleared, and each side just has two flat "Daily N2" to-dos (the ex-template's content re-materialized as a plain to-do beside the ex-instance).

## Derived RULES a simulator applier must reproduce (extends the RSIM-P appliers)

**`make-repeating` on a PROJECT whose subtree contains a nested repeating to-do (A1/A2 — fixed or after-completion nested):**
1. **Hard-delete the nested TEMPLATE row** (the child with `rt1_recurrenceRule != NULL`). Its rule is dropped entirely.
2. **Demote the nested INSTANCE to plain** (clear `rt1_repeatingTemplate → NULL`); it stays as an ordinary to-do.
3. **Duplicate BOTH ex-rows as PLAIN to-dos** into each project subtree (the ex-template becomes a plain to-do carrying its title/notes; the ex-instance likewise). No `rt1_*` recurrence column survives any copy. The resulting instance project has **no working nested repeater**.

**Edge-state children under a converting project (A3):** a **completed** child is duplicated to the template side but **re-opened** (`status 3→0`); a **trashed** child is **skipped** (not duplicated); a child that is an **instance of an external repeating to-do** is duplicated as a PLAIN to-do with its external `rt1_repeatingTemplate` **cleared to NULL** (the external template's instance set is never polluted).

**FIXED vs AFTER-COMPLETION project source handling on THIS build (see contradiction #1):** a FIXED conversion (A1/A2/A3, area-less) **PRESERVES the source project** row and relinks it as the instance (only the template minted fresh; the fresh duplicate subtree hangs off the template side, the originals stay on the instance side). An AFTER-COMPLETION conversion (A5) **DELETES the source subtree** and mints template + instance + two full copies. **This diverges from RSIM/RSIM-P and MUST be reconciled before the simulator's source-handling is trusted — flagged, not folded.**

## SIMFID divergences — flagged for the fidelity suite (`src/write/vectors/simulator.ts`)

Beyond the three RSIM-P divergences (still standing), RSIM-P2 adds:

1. **Source PRESERVED-as-instance for FIXED conversions (to-do AND project).** If the shipped `applyMakeRepeatingFixed` deletes the source and mints a fresh instance (RSIM1/RSIM-P shape), it is WRONG for this build's observed behavior (B3 to-do + A1/A2/A3 projects keep the source, relink as instance). **Action: reconcile with a targeted re-run of RSIM1 (fixed to-do) and RSIM-P P1 (fixed area'd project) on main before changing the applier** — the axis (build/recipe vs scheduling-state vs area) is not yet isolated. **[RESOLVED by §RSIM-R: the applier must delete-by-default and PRESERVE only when a fixed PROJECT's subtree contains a nested repeater (flatten path); area/schedule are irrelevant. Always-delete is correct for bare/plain-children projects and bare/checklist to-dos. See the §RSIM-R simulator verdict for the exact applier change.]**
2. **After-completion instance-side CHILDREN are PLAIN — no per-child FK link (A5 vs RSIM-P P4).** If the after-completion applier sets each instance-side child's `rt1_repeatingTemplate` to its template-side sibling (P4 rule), that is NOT reproduced here for headings OR to-dos. Headings-left-plain is confirmed; the to-do-link claim needs a P4 re-run to determine determinism.
3. **Nested repeaters must FLATTEN.** No simulator applier that recurses a project make-repeating should preserve a child's rule or FK — the app destroys the nested template and demotes/duplicates as plain (A1/A2). A "duplicate the subtree" applier that copies `rt1_recurrenceRule`/`rt1_repeatingTemplate` on children would diverge.
4. **Edge-state child handling (A3):** completed→reopened-copy, trashed→skipped, external-instance→plain-copy-with-cleared-FK. Any subtree-duplication applier must model these three.

## Discovery hardening constraints (B1–B4 distilled)

The exact rules a robust make-repeating discovery must follow, given the evidence:

- **The current mechanism is correct for the TEMPLATE (B1).** Discovery = `findCreated` (`title=? AND type=? AND creationDate>=? ORDER BY creationDate DESC LIMIT 25`, with the bound dropped to `0` because `excludeUuids` is present — `delta.ts:185`), minus `pre.sameTitleUuids` (ALL pre-existing `(title,type)` rows, trashed included — `pre-state.ts:372`), then the first candidate passing `repeating.isTemplate=true`. In the same-title gauntlet this bound the exactly-right new template. **Keep the exclude-set + `isTemplate` assertion; they are load-bearing.**
- **The time bound is trustworthy ONLY for the template, and only if restored.** Minted **template** rows carry a fresh write-time `creationDate` (B1/B3/A-cases: ~drive wall-clock, e.g. 2026-07-05 12:07 unix). So a `creationDate >= writeStart-ε` bound is SAFE for template discovery and would tighten today's unbounded-when-excluded scan. **But do NOT extend that bound to instance derivation:** instance rows are unreliable — for an after-completion PROJECT the freshly-minted instance subtree is **backdated to the occurrence-day MIDNIGHT** (`creationDate=1783209600` = 2026-07-05 00:00, the rule anchor), and for a preserved-source instance the `creationDate` is the *original* add time. Both fall outside a tight write-time window. **(Note: `creationDate` is stored as UNIX-epoch seconds here — `ctx.nowEpoch=1783253131`; the artifact differ's "2057" display is a spurious double-epoch offset, real dates are 2026-07-05.)**
- **DERIVE THE INSTANCE VIA THE FK, NEVER A TIME/TITLE HEURISTIC (B4).** `SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate=<template>` is exact in every case (to-do fixed, project fixed both, after-completion project). For a project template, filter `type=1` to get the instance project; child-level links (if any exist on other builds) point at *child* templates, never the project template, so they cannot appear in a project-template lookup.
- **DO NOT ADD A "SOURCE-GONE" ASSERTION (contradiction #1).** On this build the source is frequently PRESERVED and relinked as the instance (B3, A1/A2/A3) rather than deleted. A source-gone assertion would fail on exactly the common case. The robust invariant is instead: *after the op the source uuid is EITHER absent OR carries `rt1_repeatingTemplate=<newTemplate>`* (i.e. it became the instance). The FK lookup already covers the preserved case.
- **Fingerprint match may compare notes + tags + checklist titles + container pointer, but NOT deadline (B3).** The template drops the source's deadline (template `deadline=NULL`) while the instance keeps it — so deadline is asymmetric and unsafe to fingerprint on. Notes/tags/checklist copy verbatim to the template.
- **A same-title racer cannot misbind through a local channel (B2), but guard the sync case.** A concurrent local `things:///add` fails the drive closed (Escape-dismiss) rather than misbinding, and a plain racer is filtered by `isTemplate`. The only residual window is a same-title **template** appearing between pre-read and post-write discovery (Cloud sync); the restored `creationDate` time-bound above plus the exclude-set shrink but do not fully close it — a source-fingerprint tiebreak (notes/tags/container) would.

## Reproduction notes (RSIM-P2)

- One clone, ~20 min for A1–A5 + B1–B4 (10 GUI drives, each a warm relaunch + AX steps; every drive DB-verified, exit 0 except the deliberately-disrupted B2 and the impractical A4). Same lifecycle/toolchain guards as RSIM-P (self-contained node, worktree `npm ci`, AXVM1 rung-b grant, VM-limit orphan recovery). `make-repeating` is a **ui-vector** op → `--dangerously-drive-gui` + `ui-enabled` (NOT `--allow-disruptive`, which caps at tier 2).
- **A4 clock-advance is the known-hard part** — a +15-day forward jump wedged the relaunch (`-128` + `/tmp` cleared). Treat as the RSIM-P open boundary; it needs a helper re-install after the post-advance relaunch, or a Tart-native way to set the guest clock without a reboot.
- **The two prior-law contradictions (source-preservation; after-completion child links) are the highest-value follow-up** — a single small clone re-running RSIM1 (fixed to-do, `when=today` source), RSIM-P P1 (fixed area'd project), and RSIM-P P4 (after-completion 2-direct-child project) on main would isolate whether the axis is build/recipe, scheduling-state, or area — and let SIMFID trust the source-handling appliers.

---

# RSIM-R — RECONCILING fixed-mode source fate + after-completion child links

**Verdict (2026-07-19): both prior-law contradictions are REAL behavioral differences (NOT differ bugs, NOT build regressions — same Things 3.22.11 / same ui-recipe throughout), and both are now resolved to a single reproducible law each.**

- **C1 — fixed-mode source fate.** The RSIM-P2 hypothesis (source fate turns on **area** or **scheduling-state**) is **FALSIFIED**. The true axis for a **project** is whether its subtree contains a **nested repeating to-do**: a fixed `project make-repeating` **PRESERVES the source project (relinks it as the current-occurrence instance) IFF the subtree contains a nested repeater** (the app must FLATTEN it — RSIM-P2's core finding — and that flatten path keeps the source in place); with **no nested repeater** (empty, or plain children, or in an area, or scheduled today) it **DELETES the source and mints template + instance fresh** — the classic §8g identity replacement. Area and When are IRRELEVANT. Deterministic: 5/5 preserve (A1, A2, A3, R2-run S2, S2b) vs 6/6 delete (R1, R3, R4, R2-run S1, plus RSIM-P P1 & RSIM6 which had *plain* children). For a **to-do** (no subtree, so no nested repeater), a bare or checklist-only source DELETES (RSIM1, R5, R6, S3 = 4/4); the lone preserve (B3, a rich to-do with notes+tag+deadline+checklist) is a content trigger that is **not isolated** (checklist EXCLUDED by S3; **deadline** the leading candidate) — parked.
- **C2 — after-completion project instance-side child links.** RSIM-P P4's "each instance-side child carries `rt1_repeatingTemplate` → its template-side sibling" is a **NON-REPRODUCIBLE ANOMALY**. The reproducible law is that **all instance-side children (headings AND to-dos, headed or direct) are PLAIN — no per-child FK link**; only the project row carries the instance→template link. Confirmed A5 + R7 (P4's exact direct-children config, area-less, no heading) + R8 = 3/3 plain; P4 alone showed links. Heading-presence is NOT the axis (R7 had none and was still plain). The app's occurrence materialization is **nondeterministic** in this per-child stamping (the same class of nondeterminism the reconciliation exposed).

Two disposable `--vnc-experimental` clones of `things-lab-golden-v1` (golden untouched; airgapped; clock pinned **2026-07-05 12:00**; Things **3.22.11 / macOS 15.7.7 / DB v26**; Accessibility via the AXVM1 rung-b VNC toggle; driven through the **production CLI** shipped as the guest e2e bundle). Branch `mg/rsim-r`, on **main @ 8e2ff91**. Scripts: [`lab/scripts/research-rsim-r.sh`](../../lab/scripts/research-rsim-r.sh) (R1–R8: area/schedule cross-terms + C2) and [`lab/scripts/research-rsim-r2.sh`](../../lab/scripts/research-rsim-r2.sh) (S1–S3+S2b: substructure isolation). Same TMTask+TMTaskTag+TMChecklistItem differ. Every verdict was RE-DERIVED uuid-by-uuid from the RAW before/after snapshots (a `SOURCE-FATE` probe reports `[exists|rt1_repeatingTemplate|start|startDate]` for the source uuid), never trusting prior tooling. Fixtures fully synthetic. Artifacts (gitignored): `lab/artifacts/rsim-r-lab/` + `lab/artifacts/rsim-r2-lab/`.

## Phase-1 forensics (no VM): both contradictions are REAL, not differ bugs

Re-derived from the RAW snapshots of the prior campaigns, keyed uuid-by-uuid (host tool `scratchpad/forensic.py`):

- **RSIM-P P1** (fixed project, in AREA *Zone A*, source `start=1`/`startDate=NULL`): source project `KBAJ6zft` is **genuinely ABSENT** from the post snapshot; two fresh project rows (`4juaNJQm` template, `K6bMGc88` instance). Zero CHANGED rows → a real hard-DELETE, not a differ mislabel. **P1's DELETE verdict is honest.**
- **RSIM-P2 A1** (fixed project, area-less, source `start=1`/`startDate=NULL`, nested repeater present): source project `6JqrLqTN` is **genuinely PRESENT** in post as a CHANGED row (`start 1→2`, `startDate→2026-07-05`, `rt1_repeatingTemplate→HEmYQj1W`); only ONE new project row (the template). A2/A3 likewise preserved. **A1's PRESERVE verdict is honest.**
- So both raw datasets support their own documented claims — the contradiction is a genuine app-behavior difference. The confound: RSIM-P P1 was area'd + plain-children; every RSIM-P2 fixed *project* case (A1/A2/A3) was area-less + **nested-repeater** — area and nested-repeater were perfectly confounded across the two campaigns. App build, macOS, golden image, DB version, and the make-repeating ui-recipe (`reveal → select project row (AXSelectedRows) → Items ▸ Repeat… → weekly → OK`) are byte-identical across all campaigns (the only recipe variation is the reveal target — an area'd item is revealed in its area, an area-less one in Someday — which is a *consequence* of area membership, not an independent variable).
- **C2** likewise re-derived from raw: RSIM-P P4 instance children literally carry `rt1_repeatingTemplate` = a template-side sibling uuid (`8Sce5vZa.tmpl=HP4zWpRW`), and these persist across a warm relaunch (P4 `Bimm→Bwarm` delta = 0); RSIM-P2 A5 instance children are literally `NULL`. Both honest; the difference is real.

## Phase-2 VM matrix (two clones): the confounds broken

**Run 1 (`research-rsim-r.sh`, R1–R8) — area/schedule cross-terms + C2 replica.** Every source seeded BARE/EMPTY, `SOURCE-FATE` re-read from raw:

| Cell | source | area | When | fate |
|---|---|---|---|---|
| **R3** | project (empty) | area-less | anytime | **DELETE** |
| **R4** | project (empty) | **AREA** | anytime | **DELETE** |
| **R1** | project (empty) | area-less | **today** | **DELETE** |
| **R6** | to-do (bare) | area-less | inbox | **DELETE** |
| **R5** | to-do (bare) | area-less | **today** | **DELETE** |
| **R2** | to-do (bare) | **AREA** | anytime | **DELETE** |

All six BARE items DELETED **regardless of area or When** → area and schedule cannot be the axis. (Deletes match the canonical shape: source gone, fresh template `start=2`/rule/`icCount=1`/`next=2026-07-12` + fresh instance `tmpl=template`/`startDate=2026-07-05`, instance backdated to occurrence-midnight, e.g. R5 instance `creationDate=1783209600`.) The preserve cases (A1/A2/A3, B3) all had **substructure**, which R1–R8 lacked — so Run 1 falsified the wrong axis but couldn't isolate the real one.

- **C2 (R7, R8):** R7 = P4's exact config (after-completion project, **2 direct children, NO heading**, area-less) → **instance children PLAIN**. R8 (with a heading) → also PLAIN. Both DELETED their source (after-completion project always deletes). With A5 that is **3/3 plain**, so P4's links are the anomaly and heading-presence is not the axis.

**Run 2 (`research-rsim-r2.sh`, S1–S3 + S2b) — substructure isolation:**

| Cell | source | substructure | fate |
|---|---|---|---|
| **S1** | project | 2 PLAIN children | **DELETE** |
| **S2** | project | 1 NESTED-repeater child (A1 replica) | **PRESERVE** (source relinked, `tmpl` set) |
| **S2b** | project | 1 NESTED-repeater child (repeat of S2) | **PRESERVE** (determinism confirmed) |
| **S3** | to-do | 2-item checklist only | **DELETE** |

S1 vs S2 isolates it: **plain children DELETE, a nested repeater PRESERVES** — and S2b proves it deterministic. S2's row-level delta is identical to A1's flatten shape (source project CHANGED `start 1→2`/`startDate→2026-07-05`/`tmpl→template`; nested template hard-deleted; nested instance demoted to plain; only the template project minted fresh, with plain flattened copies). S3 shows a checklist alone does NOT preserve a to-do, so B3's preserve is due to notes/tag/**deadline**, not the checklist (not isolated).

## Derived RULES — reconciled (supersede the RSIM/RSIM-P/RSIM-P2 source-fate rules)

**Fixed `project make-repeating` — source fate:**
1. Read the subtree BEFORE mutating. **If any child carries `rt1_recurrenceRule != NULL` (a nested repeater):** PRESERVE the source project — set its `rt1_repeatingTemplate = <newTemplate>`, `start→2`, `startDate→currentOccurrence`; **flatten** the nested repeater in place (hard-delete the nested template row, clear the nested instance's `rt1_repeatingTemplate→NULL`); mint ONLY the fresh **template** project with a PLAIN copy of the (flattened) subtree beneath it. No separate instance project — the preserved source IS the instance. (A1/A2/A3/S2/S2b.)
2. **Otherwise (no nested repeater — empty, plain children, area'd, and/or scheduled):** DELETE the source subtree + source project and mint template + instance fresh, each with a plain copy of the subtree (RSIM-P P1 shape). Area and When are irrelevant. (P1/RSIM6/R1/R3/R4/S1.)

**Fixed `todo make-repeating` — source fate:** a bare or checklist-only to-do DELETES (RSIM1/R5/R6/S3); a content-rich to-do MAY preserve (B3) on a trigger that is not isolated (deadline the leading candidate). A robust consumer must not assume either.

**After-completion `project make-repeating`:** DELETES the source and mints template + instance (P4/A5/R7/R8), and **instance-side children (to-dos AND headings) are PLAIN — NO per-child `rt1_repeatingTemplate` link** (A5/R7/R8). P4's per-child links do not reproduce.

## SIMFID / simulator verdict (`src/write/vectors/simulator.ts`) — corrections to PR #232's appliers

1. **`applyMakeRepeatingFixed` — source-fate is CONDITIONAL, not always-delete.** The shipped applier always hard-deletes the source (lines ~849–851) and mints a fresh instance. **Correct for the no-nested-repeater case (the common one), WRONG for a project whose subtree contains a nested repeater.** For that case the applier must instead: (a) NOT delete the source project — keep it, set `rt1_repeatingTemplate=<template>`, `start=2`, `startDate=<currentOccurrence>` (it becomes the instance); (b) flatten the nested repeater (delete the child template row, null the child instance's FK); (c) mint ONLY the template project + a plain copy of the flattened subtree; skip the separate instance-project + instance-side copy. This subsumes the still-open RSIM-P2 SIMFID divergence #3 (nested repeaters must flatten) — the flatten and the source-preserve are the SAME branch.
2. **`applyMakeRepeatingAfterCompletionProject` — REMOVE the per-child instance→template links.** It currently passes the template-side map to `materializeSubtreeCopy` for the instance side (lines ~963–964, from RSIM-P P4), stamping each instance-side to-do's `rt1_repeatingTemplate`. **Known-wrong:** the reproducible behavior (A5/R7/R8) leaves instance-side children PLAIN. Pass `null` (as the fixed case does) so instance children stay plain. Everything else in that applier (delete source, mint template+instance, `tp=1`, `icCount=1`, instance `startDate`=source's) stands.
3. **To-do fixed source-preserve is a tolerance, not a modelled branch.** Given the trigger is unisolated and the app shows nondeterminism here, SIMFID should TOLERATE both source-fates for a content-rich to-do rather than assert one; the bench simulator may keep always-delete for to-dos (correct for bare/checklist bench items).

## Discovery-hardening verdict (deliverable 3)

- **"Source EITHER absent OR relinked as the instance" holds in EVERY reconciled case** (16+ observations): DELETE → source uuid absent; PRESERVE → source present with `rt1_repeatingTemplate=<newTemplate>`. The invariant is SOUND; the RSIM-P2 guidance to NOT add a "source-gone" assertion is confirmed — deriving the instance via `SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate=<template>` covers both fates.
- **The per-template `creationDate` time-bound SURVIVES.** Every minted TEMPLATE in Run 1 (7 of them) and Run 2 carries a fresh write-time `creationDate` (~drive wall-clock, 2026-07-05 12:01–12:04 unix), so `creationDate >= writeStart-ε` is safe for TEMPLATE discovery. It must NOT be extended to the instance: a freshly-minted instance is backdated to occurrence-midnight (R5 `1783209600`) and a preserved-source instance keeps its ORIGINAL add-time (S2's preserved source) — both outside a tight write window. Derive the instance via the FK, never a time/title heuristic.

## Reproduction notes (RSIM-R)

- Two clones, ~15–20 min each (Run 1: 8 GUI drives; Run 2: 7 GUI drives incl. the two nested-repeater seeds). Same lifecycle/toolchain guards as RSIM-P2 (self-contained node, worktree `npm ci`, AXVM1 rung-b grant, VM-limit orphan recovery). Both clones torn down on exit; no orphaned Virtualization procs.
- **Design lesson:** the first VM matrix tested the axis the prior write-up hypothesized (area × schedule) and it FALSIFIED cleanly (all bare items delete) without isolating the real axis — because every cell was bare. The substructure follow-up (Run 2) was needed. When a documented axis is a post-hoc fit over confounded samples, budget a control cell that varies the *suspected-irrelevant* dimension (here: substructure), not only the hypothesized one.

---

# RSIM-S — next-occurrence SPAWN semantics + Quick Find visibility of template children

**Verdict (2026-07-19): the parked next-occurrence re-duplication boundary is CLOSED — each new occurrence materializes a FULL fresh subtree copy, and that copy is always PRISTINE (open, unscheduled, undeadlined) over the template's NON-TRASHED children; a trashed template child is skipped; the per-child instance→template FK is caught NONDETERMINISTIC across consecutive spawns of one series (direct proof of the RSIM-R C2 nondeterminism); and Quick Find surfaces EVERYTHING — the hidden template project, template-side children, the instance project, and instance-side children — indistinguishably (no template/instance marker).** The clock problem is solved: **SMALL +1-day increments with a DAILY repeater (next occurrence = tomorrow) beat the +15-day wedge** — three consecutive advances (2026-07-06 → 07-07 → 07-08) ran clean, no reboot, `/tmp`-independent helpers intact (technique 1 worked first try; the +15-day jump that wedged RSIM-P2 A4 / RSIM-R was never needed). ONE disposable `--vnc-experimental` clone `rsim-s-lab` of `things-lab-golden-v1` (golden untouched; airgapped; clock pinned **2026-07-05 12:00**; Things **3.22.11 / macOS 15.7.7 / DB v26**; Accessibility via the AXVM1 rung-b VNC toggle; driven through the **production CLI** shipped as the guest e2e bundle). Branch `mg/rsim-s`, on **main @ 61e5b2d** (PR #236). Scripts: [`lab/scripts/research-rsim-s.sh`](../../lab/scripts/research-rsim-s.sh) (setup: clone → grant → bundle → seed daily-repeating project + child prep), [`lab/scripts/rsim-s-clock.sh`](../../lab/scripts/rsim-s-clock.sh) (the +1-day advance driver), [`lab/scripts/rsim-s-states.sh`](../../lab/scripts/rsim-s-states.sh) (edge-state children set while PLAIN, then convert + spawn), [`lab/scripts/rsim-s-quickfind.sh`](../../lab/scripts/rsim-s-quickfind.sh) (Q2 AX drive). Same TMTask+TMTaskTag+TMChecklistItem differ as RSIM-P2, with guest helpers relocated to `~/things-lab/helpers/` (persist a reboot, unlike `/tmp` — the RSIM-P2 A4 lesson). Fixtures fully synthetic. Artifacts (gitignored): `lab/artifacts/rsim-s-lab/` (`report.txt`, `snaps/*.json`, `ax/qf-*.txt` + `qf-*.png` screenshots, `drive-*.log`, `diff_snaps.py`). Packed dates: 07-05=132805248, 07-06=132805376, 07-07=132805504, 07-08=132805632.

## Setup — the spawn source

`things:///json` seeds a plain project **RS Daily** with a heading **RS Head** (a headed child **RS Headed**) plus seven direct children; `project make-repeating … --frequency daily --interval 1 --dangerously-drive-gui` converts it (vector=ui, tier 3, exit 0). The daily rule's next occurrence = **2026-07-06** (`icCount=1`, `next=icStart=132805376`, `rule{fu=16, of=[{dy:0}], tp=0, ts=0}`); the convert-time instance is dated **2026-07-05**. On this build the fixed conversion **DELETED** the source (`replacedUuid=78hPrfAa`, `childrenReplaced=9`) and minted a fresh template (`E6mQkcx3`) + fresh instance (`EsNwnDTz`) — matching RSIM-P P1 / RSIM-R's *default-delete* law (no nested repeater).

## Executed verdicts (2026-07-19)

| Probe | Question | Verdict |
|---|---|---|
| **S1a** | Is the next occurrence's spawn OBSERVABLE with a small clock jump? | **YES.** Quit Things, `sudo date` +1 day → 2026-07-06, warm relaunch + nudge (`things:///show?id=upcoming` then `?id=today`). Clean — **no `-128`, no reboot** (guest `uptime` continuous 8→9→10 min across three advances; `~/things-lab/helpers` intact throughout). The RSIM-P2 A4 / RSIM-R +15-day wedge is an artifact of the LARGE jump; **+1-day steps are safe.** |
| **S1b** | Does the new occurrence get a FRESH SUBTREE COPY? (parked re-duplication boundary) | **YES — full copy, confirmed 3× (07-06, 07-07, 07-08).** Each advance: **INSERTED 10 / DELETED 0 / CHANGED 3** — a new instance project (type=1, `start=2`, `startDate`=that day, `tmpl`=template, `rule=NULL`, `icCount=0`, `next=69760` junk sentinel — the RSIM instance shape exactly) + a fresh copy of every non-trashed template child (heading + headed to-do + the direct to-dos). Prior occurrences are **NOT** garbage-collected (07-05, 07-06, 07-07 instances all coexist — DELETED 0). (The 10th insert each cycle is the golden's own `LAB-REPEAT-DAILY` occurrence — corroborates that normal maintenance ran.) |
| **S1c** | Does the TEMPLATE subtree itself change at spawn? | **Only the template PROJECT row.** `rt1_instanceCreationCount` +1 (1→2→3) and `rt1_nextInstanceStartDate` / `rt1_instanceCreationStartDate` advance by the interval (+1 day). **Zero changes to any template-CHILD row** (the CHANGED-3 are always the three template PROJECT rows in the DB: RS Daily + the two golden repeaters). |
| **S1d** | Do spawned instance children carry `rt1_*` markers? (RSIM-R C2 nondeterminism) | **Per-child `rt1_repeatingTemplate` back-link is NONDETERMINISTIC — caught red-handed.** Across three consecutive spawns of the SAME series, a *different* subset of children lacked the link: spawn-07-06 → **RS Someday** plain (6/7 linked); spawn-07-07 → **RS Headed + RS Cancel** plain (5/7 linked); S2 spawn-07-08 → **all 6 linked** (6/6). Same template, same children, adjacent occurrences → the app's per-child stamping varies run to run. This **upgrades RSIM-R C2 from an inference** (A5-vs-P4 disagreement) **to a direct observation.** Headings are ALWAYS plain (never linked), consistent across all spawns. |
| **S2** | Which template-child STATES are copied / skipped / RESET at spawn? | **The occurrence is always PRISTINE over the non-trashed children.** Built a second daily repeater **RS2** whose children were given real states *while still a plain project* (settable there): completed, canceled, scheduled `2026-07-25`, deadline `2026-07-30`, someday. At **conversion** the template-side copies were ALL normalized to `status=0` / `startBucket=0` / `startDate=NULL` / `deadline=NULL`; at the **07-08 spawn** every occurrence child was likewise pristine (RS2 Done → OPEN, RS2 Sched → UNSCHEDULED, RS2 Deadline → NO deadline, RS2 Cancel → OPEN, RS2 Someday → normalized). So: **completed/canceled → RESET to open; scheduled `when`/someday → RESET (schedule dropped); deadline → RESET (dropped); trashed → SKIPPED (S1); plain → COPIED verbatim.** Per-occurrence child status/schedule is NOT inheritable from the template. |
| **S3 (trash)** | Is a TRASHED template child copied into the new occurrence? | **SKIPPED.** RS Daily's `RS Trash` child (trashed via `todo delete`, `trashed=1`) never appears in the 07-06 or 07-07 occurrence subtrees (each has exactly the 7 non-trashed children). Matches RSIM-P2 A3's conversion-time trashed→skipped, now confirmed at SPAWN. |
| **S4 (immutability)** | Can a template child be given completed/canceled/scheduled/deadline/someday states AFTER conversion? | **NO — template-side children are STATUS/SCHEDULE-IMMUTABLE (new quirk, oddities §8n).** `todo complete` / `todo cancel` / `todo update --when` / `--deadline` all **silent-no-op** (verify-failed, exit 3) via the CLI AND direct AppleScript (`set status … to completed`/`canceled` no-op; `schedule …` → error **302**; `move … to list "Someday"` → error **301**; `set due date …` no-op). Only **trash** (`todo delete`, AppleScript `delete`), **title/notes** (`todo update --title`, url-scheme tier 0), and **project-move** (P3) land. This is WHY S2 had to bake states in pre-conversion. It also qualifies RSIM-P's "template children are completely plain rows" — they LOOK plain in the DB but the app governs their status/schedule as template-owned. |
| **Q2** | Quick Find visibility of template-side children (AX drive) | **Everything is findable, nothing is marked.** With Accessibility granted, `Cmd-F` + typed title + an `entire contents` AX dump of the Quick Find popover: searching **"RS UNIQTMPL"** (a title that exists ONLY template-side, after renaming the template's RS Plain child) returns **one** ToDo result → **template-side children ARE surfaced**; "RS Headed" (both sides) returns **two** results (template + instance copy); **"RS Daily" returns two PROJECT results** → the **hidden template project (`start=2`, invisible in every list view) is Quick-Find-visible**. No result carries any template/instance signal — both projects render as "RS Daily", both child copies as their title under "RS Daily". AX dumps + screenshots in `lab/artifacts/rsim-s-lab/ax/`. |

## Row-level evidence — the canonical spawn (07-06, RS Daily)

Template `E6mQkcx3` (before): `icCount=1 next=132805376(07-06) icStart=132805376`. `settle` → `sudo date 070612002026` → `warm` + nudge → `settle`. Delta **INSERTED 10 / DELETED 0 / CHANGED 3**:

```
+ INSTANCE  RS Daily[4VZDcR7g]  type=1 start=2 startDate=2026-07-06 tmpl=E6mQkcx3 rule=NULL icCount=0 next=69760
    +  RS Head[PaeJQVu7]   type=2 project=4VZDcR7g  (plain — headings never linked)
    +    RS Headed[HEySU6Bn] type=0 heading=PaeJQVu7  tmpl=4fuKPCo1   ← per-child back-link PRESENT this spawn
    +  RS Done[Y38Px4wn]   tmpl=C4XLfJjM        RS Cancel[8mT1Jsps] tmpl=AcAbUPTS
    +  RS Someday[MbBBvW75] tmpl=NULL   ← back-link ABSENT this spawn (nondeterministic)
    +  RS Sched[Dvqs3XUN]  tmpl=92f9wqm4        RS Deadline[Q8dbST1t] tmpl=SW9AUFs2
    +  RS UNIQTMPL[Dbw5crWs] tmpl=HvoZUFpd  ← copies the LIVE template state (renamed from "RS Plain")
  (RS Trash — the trashed template child — is NOT copied)
~ CHANGE  RS Daily[E6mQkcx3] (template)  icCount 1→2  next/icStart 132805376(07-06)→132805504(07-07)
  (+ the golden LAB-REPEAT-DAILY template counter/date advance; + its new 07-06 occurrence = the 10th insert)
```

Every occurrence child is `start=1 startBucket=0 startDate=NULL deadline=NULL status=0` — PRISTINE. The spawn reads the **live** template (the renamed `RS UNIQTMPL` appears, not the pre-rename `RS Plain`), so editing a template child's title/notes DOES flow into future occurrences (unlike status/schedule, which the template normalizes away). A template-child rename does NOT propagate to already-materialized instances (the 07-05 instance kept "RS Plain").

## Derived RULES a simulator applier must reproduce (the next-occurrence SPAWN — extends the RSIM/RSIM-P conversion appliers)

**Materialize the next occurrence of a repeating PROJECT** (when `now >= template.rt1_nextInstanceStartDate`):
1. **Mint a new instance project** — RSIM instance shape: `type=1`, `start=2`, `startDate`=the occurrence date, `rt1_repeatingTemplate`=template, `rule=NULL`, `icCount=0`, junk `next=69760`. Do NOT delete or touch prior occurrences (they accumulate).
2. **Copy the template's NON-TRASHED child subtree** into it (headings + direct + headed to-dos; preserve the containment invariant), each child **PRISTINE**: `status=0`, `startBucket=0`, `startDate=NULL`, `deadline=NULL`, `rule=NULL`. **Skip any template child with `trashed=1`.** Titles/notes/tags/checklist copy verbatim from the template's CURRENT state.
3. **Per-child instance→template `rt1_repeatingTemplate` links are NONDETERMINISTIC — TOLERATE, do not assert** (some children get the back-link, some don't, varying per occurrence; headings never do). Reinforces the RSIM-R C2 SIMFID tolerance.
4. **Stamp the template PROJECT row only:** `rt1_instanceCreationCount += 1`; `rt1_nextInstanceStartDate` / `rt1_instanceCreationStartDate` += interval. Template-CHILD rows are untouched.

**Template-child mutation surface (S4):** a template-side child accepts **title/notes** edits and **trash** and **project-move**, but SILENTLY REJECTS status (complete/cancel) and schedule (`when`/someday/reschedule/deadline) changes on every surface. A simulator/wrapper that models `todo.complete`/`todo.update(when|deadline)` as landing on a template-project child would diverge — the app no-ops it (or errors 301/302 on AppleScript schedule/move-to-list).

## Implications

### (a) Simulator / SIMFID
- **The spawn is now a modellable applier**, closing RSIM-P's parked "does the next occurrence re-duplicate?" boundary (§RSIM-P Reproduction notes) with a definite **YES + full pristine copy + trashed-skip**. If the bench ever simulates a series across time (materializing occurrences), the applier above is the spec.
- **Per-child `rt1_repeatingTemplate` must be a SIMFID TOLERANCE at BOTH convert and spawn**, never an assertion. RSIM-S is the direct proof (consecutive spawns of one series disagree on the link set) behind RSIM-R's already-shipped "leave plain / tolerate" guidance — the applier should emit plain instance children and SIMFID should accept present-or-absent.
- **Occurrence children are always pristine** — any applier that carries a template child's status/schedule/deadline into an occurrence is wrong (the app strips them). Bench corpora that assert "the completed child stays completed in the next occurrence" would be wrong.
- **New residual for RSIM-R source-fate:** RS2 (fixed daily, area-less, direct children, **no nested repeater**, but two children carried completed/canceled status pre-conversion) **PRESERVED its source** (relinked as instance; CLI `replacedUuid=null childrenReplaced=0`), whereas RS Daily (same rule, plain children + heading, no nested repeater) **DELETED** its source. This is a COUNTEREXAMPLE to RSIM-R's "plain-children project always deletes (6/6)" law — the only structural difference is an edge-state (completed/canceled) child in RS2. **Flagged, not folded:** either a completed/canceled child in the subtree is a second source-PRESERVE trigger, or source-fate carries residual nondeterminism the RSIM-R matrix didn't surface. A targeted follow-up (fixed conversion of a plain project holding exactly one completed child, ×N) would isolate it.

### (b) The just-built container-marker + search surfaces
- **Quick Find keeps template children (and the hidden template project) FINDABLE and UNMARKED.** So **hiding template-side children from our search would DIVERGE from GUI behavior** — the app's own search shows them. GUI parity = keep them findable.
- But the GUI gives the user NO signal that a hit is a latent template copy (both projects read "RS Daily"; both child copies read identically). Our just-built **container-marker is therefore a strict improvement over GUI parity**: the recommendation is **findable-but-MARKED** — surface template-side children in search (parity) while tagging them with the template/instance container marker the GUI lacks, so an agent editing a search hit knows it is rewriting what every future occurrence will contain (the P3/S4 silent-rewrite footgun). Hiding them (GUI-divergent) is the weaker option; findable-but-unmarked (raw GUI parity) leaves the footgun open.
- Corollary: `start=2` (template) hides a row from LIST views but NOT from Quick Find — the "templates are invisible" rule (oddities §5e, list/AppleScript) does not extend to search, so any search projection must decide template visibility explicitly rather than inheriting the list-view filter.

## S-R addendum — trashed-child fate through conversion + RESTORE round-trips (coordinator add-on, 2026-07-19)

A dedicated second clone `rsim-sr-lab` ([`lab/scripts/research-rsim-sr.sh`](../../lab/scripts/research-rsim-sr.sh)); same rig, clock pinned 2026-07-05 (no advance needed).

| Probe | Case | Verdict |
|---|---|---|
| **S-R1** | project `SR Proj` {`SR Keep` plain, `SR Gone` trashed WHILE PLAIN} → fixed `project make-repeating` (a source-DELETE conversion — plain children, no nested repeater) | **The pre-trashed child is HARD-DELETED with the source subtree.** After conversion the source `SR Proj` is gone and **`SR Gone` exists NOWHERE** (`SELECT … WHERE title='SR Gone'` → empty; `things show` → `not-found`). It is neither copied to the template (trashed→skip, RSIM-P2 A3) NOR left dangling in Trash pointing at the dead source uuid. The CLI's own `childrenReplaced:1` counts only the live `SR Keep` — the trashed child is excluded from the replace set and destroyed. **No orphan, no dangling-pointer row.** (`SR Keep` copies to template + instance as normal.) |
| **S-R2** | restore `SR Gone` after conversion | **N/A — it did not survive** the source-DELETE conversion, so there is nothing to restore. (On a source-PRESERVE conversion the source subtree is kept, so a pre-trashed child would ride along on the preserved instance side and be restorable normally — not exercised here; inferable, flagged.) |
| **S-R3** | trash a TEMPLATE-side child (`SR Keep` under the template) AFTER conversion, then `todo restore` it | **Trashing lands; RESTORE FAILS — a one-way trap.** `todo delete` on the template-side child works (`trashed=1`, applescript). `todo restore` then **fails with `verify-failed:silent-noop` wrapping `Things3 got an error: Cannot move to-do (301)`** (exit 3) — our restore is implemented as move-to-Inbox, and the app forbids moving a template-side child to a built-in list (the same 301/302 wall as §8n/S4). The row is left `trashed=1`, `project=<template>`, `start=1` — a trashed template child that automation cannot un-trash (a GUI "Put Back" from Trash is the only remaining recovery, untested). |

**S-R implications:**
- **Restore-op guard/messaging (flag — no code changed; docs/lab-only):** `todo restore` on a template-side trashed child surfaces a raw wrapped AppleScript 301 as `verify-failed:silent-noop`, which reads like an unexplained no-op rather than a categorical refusal. A dedicated guard/message ("a trashed child of a repeating template can't be restored to the Inbox — the app forbids moving template children; use the app's Trash ▸ Put Back") would be clearer, mirroring the existing `assertRepeatRule` fail-closed pattern. This is the un-trash analog of the §8n status/schedule immutability.
- **Simulator conversion appliers:** on a source-DELETE conversion the recurse-delete must **include already-trashed children** (reality destroys them; they are not copied and not left dangling), while the copy step **skips** trashed children (RSIM-P2 A3). A sim applier that deletes only non-trashed source rows would leave a dangling trashed row the app does not — a SIMFID mismatch. This is consistent with RSIM-P's "recursively hard-delete the source subtree" (it must mean the WHOLE subtree, trashed rows included).
- **Corroborates the RS2 source-fate residual:** `SR Proj` (plain child + a trashed child, no nested repeater, **no live edge-state child**) DELETED its source — consistent with RSIM-R's delete-default. RS2 (which DID have a live completed+canceled child) preserved. So the parked "edge-state child as a second preserve-trigger" hypothesis survives this data point (a trashed child alone does not flip to preserve).

## Reproduction notes (RSIM-S)

- ONE clone, ~25 min end to end (setup + 3 GUI conversions + 3 clock advances + 3 Quick Find AX drives); a second small clone `rsim-sr-lab` (~8 min) for the S-R restore addendum. Same lifecycle/toolchain guards as RSIM-P2/RSIM-R (self-contained node, worktree `npm ci`, AXVM1 rung-b grant, VM-limit orphan recovery). Clone torn down on completion; no orphaned Virtualization procs; 7.8 GB free after.
- **The clock technique that worked (headline):** pin 2026-07-05, do ALL setup while pinned, then `settle` (clean AppleScript quit) → `sudo date MMDDhhmmYYYY` **+1 day** → `warm` (relaunch + `AXEnhancedUserInterface=false`) → `nudge` (open Upcoming then Today to prod maintenance) → `settle` → snapshot. Repeatable: 07-06, 07-07, 07-08 all spawned cleanly. **Do NOT jump multiple days at once** — that is the RSIM-P2 A4 / RSIM-R wedge (`-128` + reboot clearing `/tmp`).
- **Two robustness upgrades over RSIM-P2 that paid off:** (1) guest helpers in `~/things-lab/helpers/` not `/tmp` — survive any reboot from a clock jump; (2) an `alive`/`uptime` check after each advance to detect a reboot (none occurred). A transient `Permission denied` SSH auth-flap appeared once at the third advance and the `lab_ssh` 255-retry recovered it — NOT a wedge (uptime stayed continuous).
- **S4 discovery was load-bearing for the design:** the brief asked to prepare completed/canceled/someday/scheduled/deadline template children via the CLI, but the app blocks those states on template children — so S2 had to establish them on a plain project *before* conversion. The block is itself the answer to "is a completed template child skipped at spawn?" — you cannot make a template child completed in the first place; the occurrence is pristine by construction.

---

# RSIM-T — ISOLATING the to-do fixed-conversion content preserve-trigger

**Verdict (2026-07-22): a fixed `todo make-repeating` PRESERVES its source (relinks it in place as the instance) IFF the source to-do carries a DEADLINE — notes, a tag, and a checklist each fail to preserve.** This closes RSIM-R's parked to-do follow-up ("isolate the content preserve-trigger; deadline the leading candidate") and resolves RSIM-P2 B3 (a rich to-do — notes+tag+deadline+checklist — that preserved): the responsible axis is **deadline alone**. Four single-axis variants + a bare control, each seeded via the URL scheme then converted fixed-weekly through the **production CLI** (ui vector, tier 3), `SOURCE-FATE` re-read uuid-by-uuid from the raw before/after snapshots. ONE disposable clone `parked-probes-lab` of `things-lab-golden-v1` (golden untouched; airgapped; clock pinned **2026-07-05 12:00**; Things **3.22.11 / macOS 15.7.7 / DB v26**; **tart 2.34.0**; Accessibility via the AXVM1 rung-b grant). Branch `mg/parked-probes`, on **main @ 4802588**. Script: [`lab/scripts/research-parked.sh`](../../lab/scripts/research-parked.sh). Fixtures fully synthetic. Artifacts (gitignored): `lab/artifacts/parked-probes-lab/` (`report.txt`, `snaps/*.json`, `drive-t-*.log`, `diff_snaps.py`).

## Executed verdicts (2026-07-22)

| Cell | source content (else bare) | source fate | delta shape | CLI `repeating.replacedUuid` |
|---|---|---|---|---|
| **T-bare** | none | **DELETE** | INSERT 2 (template + instance) / DELETE 1 (source `Foqy4Pty`) | `Foqy4PtyoC2ctp22N5no4T` (source gone) |
| **T-deadline** | deadline 2026-08-01 | **PRESERVE** | INSERT 1 (template `9AP1LUkL`) / CHANGE (source `6D6YX7ZC` → instance) | **`null`** (source relinked) |
| **T-notes** | notes | **DELETE** | INSERT 2 / DELETE 1 (source `WYgAc5hM`) | `WYgAc5hMtMTt7G3RPJPmcb` |
| **T-tag** | 1 tag | **DELETE** | INSERT 2 / DELETE 1 (source `WLpmC6Uf`) | `WLpmC6UfRGstrZiDRaZNAZ` |
| **T-checklist** | 2-item checklist | **DELETE** | INSERT 2 / DELETE 1 (source `2sQ7Zu1T`) | `2sQ7Zu1TKepjXRW7LLBgZo` |

`SOURCE-FATE` line, deadline cell: `src=6D6YX7ZCd6hqLxy7ugUjYp [exists|tmpl|start|startDate|hasRule] = 1|9AP1LUkL853p7zjd5nBEBe|start=2|startDate=132805248|hasRule=0` — the source SURVIVES with `rt1_repeatingTemplate` set (it became the instance). Every other cell: `exists=0` (source hard-deleted, replaced by a fresh instance uuid). So **notes, tag, and checklist are each EXCLUDED** as triggers (T-checklist re-confirms RSIM-R S3); **deadline is the SINGLE isolated preserve axis**, cleanly 1/1 preserve vs 4/4 delete on the other axes.

## Row-level evidence — T-deadline (the lone preserve)

Seed `6D6YX7ZC` fixed-weekly convert delta **INSERT 1 / CHANGE 2**:
```
+ INSERT 9AP1LUkL853p7zjd5nBEBe  "PT-Deadline"  type=0 start=2 startDate=NULL deadline=NULL
    rule(628B){tp=0, fu=256, fa=1, of=[{wd:0}], ts=0, ed=64092211200.0, …}  icCount=1 next=2026-07-12   ← fresh TEMPLATE
~ CHANGE 6D6YX7ZCd6hqLxy7ugUjYp  "PT-Deadline"   ← SOURCE becomes the INSTANCE
    start 0→2 · startDate None→2026-07-05 · rt1_repeatingTemplate None→PT-Deadline[9AP1LUkL]
~ CHANGE BEDQ346J4z39cZMCFy1Zen  (prior T-bare instance — todayIndex churn only)
```
The template row carries `deadline=NULL` while the preserved source-instance RETAINS its deadline (`132808832` = 2026-08-01) — matching RSIM-P2 B3's asymmetry (**template drops the deadline; instance keeps it**), so a source-fingerprint must not compare deadline. The four DELETE cells are the canonical fixed shape: source gone, fresh template (`start=2`, rule, `icCount=1`, `next=2026-07-12`) + fresh instance (`tmpl=template`, `startDate=2026-07-05`).

## Reconciled to-do source-fate law (supersedes the "unisolated trigger" caveat in §RSIM-R)

A fixed `todo make-repeating`:
- **DELETES** the source (identity replacement, fresh template + instance) when the source is **bare, notes-only, tag-only, or checklist-only** (RSIM1/R5/R6/S3 + T-bare/T-notes/T-tag/T-checklist).
- **PRESERVES** the source (relinks it in place as the instance; mints only the template) when the source carries a **deadline** (RSIM-P2 B3, isolated here as T-deadline).

**SIMFID:** this makes the to-do source-fate a MODELLABLE branch, not merely a tolerance — `applyMakeRepeatingFixed` (to-do) may preserve-source iff the pre-read source has a non-NULL `deadline`, else delete. (The bench simulator's always-delete stays correct for bare/checklist bench items; the deadline branch is the added fidelity if repeat-with-deadline corpora are introduced.) Untested edge: a deadline COMBINED with a checklist/notes/tag — B3 (all four) preserved, consistent with deadline dominating; no cell here sets deadline alongside another axis, so "deadline overrides" is inferred, not proven.

---

# RSIM-U — a completed/canceled child is a SECOND project fixed-conversion preserve-trigger

**Verdict (2026-07-22): a fixed `project make-repeating` on a plain project (NO nested repeater) PRESERVES its source when the project's children are all in a TERMINAL state (completed and/or canceled) — an OPEN child instead DELETES it.** This resolves the RSIM-S RS2 residual (a plain project with a completed+canceled child that PRESERVED, flagged as either a second preserve-trigger or residual nondeterminism): it is a **real, deterministic second preserve-trigger**, not nondeterminism. Combined with RSIM-R C1 (nested-repeater preserve), a fixed project conversion now has **two** independent preserve conditions. Four plain area-less projects, each given a child-state set **while still plain** (the only time those states are settable — §8n / S4), then converted fixed-weekly through the production CLI; `SOURCE-FATE` re-read from raw. Same rig/clone as RSIM-T (`parked-probes-lab`, tart 2.34.0, `mg/parked-probes` on main @ 4802588, script [`lab/scripts/research-parked.sh`](../../lab/scripts/research-parked.sh)). Artifacts: `lab/artifacts/parked-probes-lab/` (`drive-u-*.log`, `snaps/`).

## Executed verdicts (2026-07-22)

| Cell | child state(s) (set while plain) | source fate | CLI `repeating` block | delta shape |
|---|---|---|---|---|
| **U-open** | 1 OPEN (`status=0`) | **DELETE** | `replacedUuid=XdesrnCf childrenReplaced=1` | INSERT 4 (template+child, instance+child) / DELETE 2 (source `XdesrnCf` + its child) |
| **U-comp** | 1 COMPLETED (`status=3`) | **PRESERVE** | `replacedUuid=null childrenReplaced=0` | INSERT 2 (template + fresh template-side child) / CHANGE (source `99GXBnQh` → instance) |
| **U-canc** | 1 CANCELED (`status=2`) | **PRESERVE** | `replacedUuid=null childrenReplaced=0` | INSERT 2 / CHANGE (source `CoQsW3cw` → instance) |
| **U-both** | 1 COMPLETED + 1 CANCELED | **PRESERVE** | `replacedUuid=null childrenReplaced=0` | INSERT 3 (template + 2 template-side children) / CHANGE (source `2xy7YMHt` → instance) |

`SOURCE-FATE`, U-open: `src=XdesrnCfXazNivWRv2sY2F … = 0|NULL|…` (source hard-deleted, fresh instance `5VTAzrgs` minted, its open child re-copied — `childrenReplaced=1`). U-comp/canc/both: `exists=1`, `rt1_repeatingTemplate=<newTemplate>`, `start=2`, `startDate=132805248` — the source PERSISTS as the instance (`childrenReplaced=0`, the terminal child rides along on the preserved instance side; the app mints only the template + a fresh open copy of the child on the template side).

## Row-level evidence — U-comp (the isolating pair vs U-open)

U-comp (completed child) delta **INSERT 2 / CHANGE 2**:
```
+ INSERT FtdV5THcQSz6pBK9RwUs5R  "PU-Comp"  type=1 start=2 rule(fu=256,tp=0) icCount=1 next=2026-07-12  ← TEMPLATE
+ INSERT KDuuYterPW5nAbvn4eqb9c  "PU-C-child"  project=PU-Comp[FtdV5THc]  (fresh template-side copy)
~ CHANGE 99GXBnQh7LW6YRohV6o14a  "PU-Comp"   start 1→2 · startDate None→2026-07-05 · rt1_repeatingTemplate None→PU-Comp[FtdV5THc]  ← SOURCE → INSTANCE
```
U-open (open child), by contrast, DELETES the source + its child and mints a **separate** instance project (`5VTAzrgs`) with its own child — the classic delete-remint. The ONLY structural difference across the four cells is the child's status, so status is the isolated axis.

## Reconciled project source-fate law (extends §RSIM-R C1)

A fixed `project make-repeating` **PRESERVES** the source project (relinks it in place as the instance; mints only the template) when EITHER:
1. the subtree contains a **nested repeating to-do** (flatten path — RSIM-R C1: A1/A2/A3/S2/S2b), OR
2. **every child is terminal-state** (completed/canceled) — no open child (RSIM-U: U-comp/U-canc/U-both; explains RSIM-S RS2).

Otherwise (empty; ≥1 open child; plain-open children ± heading; area'd; scheduled) it **DELETES** the source and mints template + instance fresh (RSIM-R: R1/R3/R4/S1/P1/RSIM6; RSIM-S RS Daily; U-open). Area and When remain irrelevant.

**Unisolated cell (flagged, not chased):** every RSIM-U preserve case had **zero** open children — so the axis proven is "an open child present → DELETE; all children terminal → PRESERVE." Whether a SINGLE terminal child *among open siblings* suffices to flip the fate is untested (a mixed open+terminal subtree). A 2-cell follow-up (one open + one completed child, vs two open children) would close it.

**SIMFID:** `applyMakeRepeatingFixed` (project) must preserve-source when the pre-read subtree has a nested repeater **OR** no open child (all children `status IN (2,3)`), else delete — extends §RSIM-R simulator verdict #1 (the nested-repeater-only preserve condition was incomplete).
