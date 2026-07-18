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
