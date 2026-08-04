# TDRAG — the AX-dependent ordering residuals (template drag, forecast drag, headless template todayIndex, reschedule-bounce, ORD-18, the §6 .ips)

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS Sequoia · DB schema v26 · guest clock pinned **2026-07-05 12:00**. Campaign **2026-08-03**, disposable offline Tart clones of `things-lab-golden-v2` (two clones across the sitting; ordering is local — no cloud account). GUI input synthesized via **vncdotool** against the `--vnc-experimental` framebuffer (2048×1536, single-client) — the AXVM1 L3-accessibility layer baked into golden-v2 (#388) grants `sshd-keygen-wrapper` `auth_value=2`, so System-Events by-name menu driving AND VNC PostEvent HID both land. Script: [`lab/scripts/research-tdrag.sh`](../../lab/scripts/research-tdrag.sh). Evidence (gitignored, synthetic): `lab/artifacts/tdrag-lab/{report.txt,report-run1-drags.txt,report-run2-clean.txt,snap-*.txt,screens/*.png,screens/Things3-*.ips}`.

> **⚠ FORWARD-POINTER (2026-08-04) — two sub-findings below are SUPERSEDED; this evidence body is left intact per the immutable-snapshot policy.** A later wire-syntax audit ([tmplsort-template-protocol.md](tmplsort-template-protocol.md)) found that the multi-id reorder probes in `research-tdrag.sh` used AppleScript LIST literals (`with ids {"a","b","c"}`) where the shipped op sends comma-joined TEXT (`with ids "a,b,c"`); a multi-item list literal throws `-1700` at the AppleEvent parameter boundary (the app never runs) and the harness swallowed the error, so those calls were REJECTED, not app no-ops. Corrections: **(TDRAG-3-2 / §3-2)** "a mixed wire `{SA, template, SB}` is a full no-op; the writer is front-insert-ONLY" is **FALSE** — a VALID comma-text multi-id wire re-ranks the template as a first-class member (`list "Tomorrow"` lands the exact sent order with the template at an arbitrary mid-slot). **(TDRAG-5 / §ORD-18 provenance)** the distinct `index` was NOT "given by a native reorder" (that call `-1700`-errored); it came from anytime-in-project creation + a valid reorder — the ORD-18 *conclusion* (bounce is `index`-byte-isolated) is re-verified and stands. Single-id list-literal findings here (TDRAG-3-1, TDRAG-3-3 reparent, TDRAG-1/2/4/6) are UNAFFECTED (a single-item list coerces cleanly). See [tmplsort-template-protocol.md](tmplsort-template-protocol.md) §the coercion law / §TMPLSORT-3 corrected.

This is the follow-up the AXVM1 layer was built to unblock — the parked residuals flagged across DLBNC (1abc), TMPLDL (1f), ORDFIN1 (TMPLIDX), the assumption register (ORD-18), and the §6 crash catalog. Every arm that TMPLDL/DLBNC/ORDFIN1 could only *infer* (synthetic HID was gated on the v1 host) is now driven for real.

**Status: RAN + BANKED.**

## Headlines

1. **TDRAG-1 — a template projection drag writes the TEMPLATE ROW's `todayIndex` and NOTHING else** (full-DB before/after diff = ONE row, ONE byte). Dropped at the top it front-inserts at the block `todayIndex` min; dropped mid-block it lands an **interpolated** value between the two neighbours. `rt1_recurrenceRule`, `todayIndexReferenceDate`, `index`, `start`, `startDate`, and — notably — `userModificationDate` are **all byte-identical**; no other row or table changes. It **persists**: after quit+relaunch the byte survives and the block re-renders in the dragged order. This formalises + reconciles the maintainer's prod observation (the sign/magnitude just track the local block's coordinate space — a negative-valued lab block yields negative front-insert/interpolated values where the maintainer's positive-valued prod block yielded the +5.8M values).
2. **TDRAG-3 — TMPLIDX is OVERTURNED for one surface: `_private_experimental_ reorder to dos in list "Upcoming" with ids {<template>}` cleanly WRITES the template's `todayIndex`** (front-insert, `rt1`/`start`/`startDate`/`tiRef`/`index`/`umd` byte-identical, no reparent, no crash, no instance contamination). It is **front-insert-ONLY** (a mixed wire `{SA, template, SB}` is a full no-op — no arbitrary positioning), and the **`project id` specifier is a REPARENT HAZARD** (it moves the template into the project, `project` NULL→P + `umd` bump, `todayIndex` untouched). → template-cell **PROTOCOL CANDIDATE** (front-insert primitive), characterised per novel-paths, NOT wired.
3. **TDRAG-4 — the reschedule-bounce mechanism (TMPLDL-1f) DOES NOT EXIST.** With AX fully working, `Items ▸ When…` on a repeating template opens the **repeat popover** (Daily / occurrence-date list / Pause / Stop / Show Latest), not a date picker — there is **no per-occurrence reschedule surface** for a template, so the hypothesised D→D+1→D front-insert "bounce" is unrealisable. TMPLDL-1f resolves from "blocked-by-VM-input-gating" to "mechanism absent".
4. **TDRAG-2 — the forecast within-block drag is `todayIndex`-only (no `startDate` stamp), byte-faithful to the wired deadline-cycle** (DLBNC-1b closed by direct byte-capture). The **between-block** drag (DLBNC-1c) is a **reschedule**: it stamps `startDate` = the destination day + updates `tiRef`, KEEPS the deadline unchanged, and bumps `umd` — the row converts from deadline-forecast to scheduled(+deadline).
5. **TDRAG-5 — ORD-18 RESOLVED (byte-level, not just presentation-scoped):** a scheduled row CAN carry a distinct `index` (scheduling an already-`index`-ranked anytime row PRESERVES it), and the dated `day` bounce leaves that `index` byte **identical** (`todayIndex` front-inserts, `index` untouched). The register's evidence-gap is closed.
6. **TDRAG-6 — the §6 `.ips` is CAPTURED.** AppleScript `schedule` on a heading kills the app with **`EXC_BREAKPOINT` / `SIGTRAP`** (Trace/BPT trap: 5); the heading row is byte-identical after relaunch (no corruption). The long-wanted crash report for the Cultured Code bug catalog is banked.
7. **Cross-cutting oddity — a native/GUI `todayIndex` re-rank is `userModificationDate`-SILENT.** Both the GUI drag (TDRAG-1/2) and the private `list "Upcoming"` reorder (TDRAG-3) write `todayIndex`/`index` WITHOUT bumping `umd`, where every URL field-write (`when=`, `deadline=`) bumps it and the containment reparent (project-id reorder) bumps it. Placement re-ranks are silent; field/membership writes are not.

## The vncdotool drag recipe (load-bearing mechanics)

Upcoming content rows are **not** AX-addressable by title (ORDFIN1 §8h — they expose only generic cell-template chrome), so rows are identified **visually from a framebuffer capture** (`vncdo capture`, 2048×1536; coordinate map is 1:1 with `vncdo move`) and dragged by coordinate. The working gesture is ONE vncdo session:

```
move sx sy · mousedown 1 · move sx sy-12 · move tx mid · move tx ty-3 · move tx ty · mouseup 1 · capture <flush.png>
```

Two mechanics were essential and are recorded so the next sitting doesn't rediscover them:
- **Do NOT use vncdo's `drag` command.** On this host (Python 3.14 / Twisted) `drag` triggers an early reactor-stop that drops the trailing `mouseup`, leaving the row *lifted but never committed* (it snaps back on the next stray event, and the app goes briefly unresponsive, AppleEvent −1712). Explicit `move` waypoints with the button held (`mousedown 1` sets the mask; each `move` re-sends it) produce a real drag gesture the session survives.
- **End the session with a `capture`** (a server round-trip that flushes + confirms the release) — never let `mouseup` be the final network write.

A drag drop-target near the window's bottom edge auto-scrolls, so the exact landing row can differ from the aim (observed in TDRAG-2); the **write-SET** is unaffected (it is always `todayIndex`-only) so the characterisation stands regardless.

## TDRAG-1 — template projection drag: full write-set + persistence

**Fixtures:** golden-baked `LAB-REPEAT-DAILY` (`W3PZB9e7…`, daily to-do template, resting `tIdx=0 idx=-940 tiRef=132805376` = its 07-06 projection day, `rt1` ruleLen 627, `umd=1783253090`) + four loose scheduled to-dos `TB1..TB4` on 07-06 (block `TB4 -1776 < TB3 -1441 < TB2 -1005 < TB1 -638`, template rests LAST at `tIdx=0`).

| Probe | Drag | Result |
|---|---|---|
| **1a — drop at TOP** | template (block bottom) → above TB4 | `todayIndex` **0 → −2149** (front-insert, below TB4 −1776). **Full-DB diff = ONE row, ONE byte:** only `W3PZB9e7….todayIndex` changed; `idx=-940`, `tiRef=132805376`, `start=2`, `startDate=NULL`, `rt1` (ruleLen 627, hex), `rtn=132805376`, and **`umd=1783253090` UNCHANGED**; no other row, no other table (`counts` identical). |
| **1b — persistence** | quit Things + relaunch | `todayIndex=-2149` **byte-identical** after relaunch; the "6 Tomorrow" block re-renders **template-first**, settled/deselected (screenshot `arm1-persisted.png`). The app re-reads the persisted byte → the drag PERSISTS to DB. |
| **1c — drop MID-block** | template (top) → between TB2 and TB1 | `todayIndex` **−2149 → −866**, an **interpolated** slot between TB2 (−1005) and TB1 (−638) — block order `TB4 < TB3 < TB2 < LAB-REPEAT-DAILY < TB1`. Again `umd` unchanged, `rt1`/`index`/`tiRef`/`start`/`startDate` byte-identical. |

**Verdict — TDRAG-1:** a template projection drag **lazy-assigns + persists the template row's `todayIndex`**, and the write-set is **`todayIndex` alone** (interpolated at the drop slot; front-insert at the block min when dropped at the top). It is `umd`-silent, `rt1`-safe, containment-safe, and re-read on relaunch. This closes the maintainer's persistence question and the DLBNC-1abc "direct byte-capture of the drag" residual for templates. The negative lab values vs the maintainer's +5.8M prod values are the SAME mechanism in different block coordinate spaces.

## TDRAG-2 — forecast-row drag: within-block (DLBNC-1b) + between-block (DLBNC-1c)

**Fixtures:** `FB1..FB4` someday+deadline-07-08 to-dos in `LAB-AREA-A` (block `FB4 −2211 < FB3 −1649 < FB2 −1058 < FB1 −513`, `deadline=132805632`, `startDate=NULL`, distinct `index` 0/−661/−1281/−1634); `XB1` a 07-09 forecast row (a second block).

| Probe | Drag | Result |
|---|---|---|
| **2a — within-block (DLBNC-1b)** | a forecast row within the 07-08 block | **`todayIndex`-ONLY.** Full-DB diff = ONE row, ONE byte: `todayIndex −1649 → −2806`; `startDate` stays **NULL** (no schedule stamp), `deadline=132805632` preserved, `tiRef=132805632` preserved, `index=-1281` preserved, `start=2` preserved, **`umd` UNCHANGED**. The GUI drag is byte-faithfully the shape the wired **deadline-cycle** reproduces (DLBNC-3) — the inference in DLBNC-1b is now a direct byte-capture. |
| **2b — between-block (DLBNC-1c)** | that forecast row (07-08) UP into the 07-06 scheduled-day block | **RESCHEDULE, not a deadline move.** `startDate` **NULL → 132805376** (07-06 stamped), `tiRef 132805632 → 132805376`, **`deadline=132805632` UNCHANGED**, `todayIndex → −1217` (a slot in the 07-06 block), `start=2`/`startBucket=0`/`index` unchanged, **`umd` BUMPED**. The row leaves the deadline-forecast cohort and becomes a **scheduled row on the destination day that still carries its original deadline**. |

**Verdict — TDRAG-2:** the within-block forecast drag is a pure `todayIndex` re-rank (certifies the deadline-cycle's faithfulness — no hidden `startDate`). The between-block drag is a **reschedule** (destination-day `startDate` stamp + `tiRef` update, deadline retained, `umd` bumped), NOT a deadline reassignment. Dragging a forecast row to another day schedules it for that day; the deadline is orthogonal and stays put.

## TDRAG-3 — TMPLIDX revisit: is the template `todayIndex` headlessly writable?

ORDFIN1 concluded a repeating template's `todayIndex` is "unreachable by every surface" — but it tested only the *repeat-series* levers (pause/resume/complete/reschedule) and a fail-closed GUI drag. TMPLDL then extended TMPLIDX to the `deadline=` surface. This arm tests the surface neither touched: the **private reorder specifiers with the template id in the wire**. Clean re-probe on a **pristine** template (a first run contaminated the template via the project-id reparent, so a fresh clone re-ran the load-bearing probes):

| Probe | Wire | Result |
|---|---|---|
| **3-1 — `list "Upcoming"` single** | `reorder to dos in list "Upcoming" with ids {template}` | **WRITES `todayIndex`: 0 → −1442** (front-insert, below SB −937). `rt1` (ruleLen 627, hex), `start=2`, `startDate=NULL`, `tiRef=132805376`, `index=-940`, **`umd` UNCHANGED**, `project=NULL` (no reparent), no crash. A **clean headless `todayIndex` writer** for a template. |
| **3-2 — `list "Upcoming"` mixed** | `… with ids {SA, template, SB}` | **FULL NO-OP** — template stays −1442, SA/SB unchanged. The multi-element wire including a template does NOT position it to an arbitrary slot; the writer is **front-insert-ONLY**. |
| **3-3 — `project id`** | `reorder to dos in project id <P> with ids {template}` | **REPARENT HAZARD** — `project` NULL → `933TCvzM…` (template moved INTO the project), `umd` bumped, `todayIndex` untouched (−1442), `rt1` byte-identical. A containment write, not a placement write. (Confirmed visually: the template renders as a project child with a "Mon" badge.) |
| **3-4 — instance contamination** | complete the current instance → advance the daily series | new spawned instance `QKbe1HaA…` rests at **`tIdx=0`** (clean) — the template `todayIndex` write does NOT contaminate future spawns (TMPLDL-1d check, satisfied). |
| **3-5 — other scopes** | `list "Today"`, `list "Tomorrow"` single-template wires | **no-op** on the template (not a Today member; the Tomorrow wire is idempotent once the template is already frontmost). |

**Verdict — TDRAG-3:** TMPLIDX's "unreachable by every surface" is **FALSE** — `_private_experimental_ reorder to dos in list "Upcoming" with ids {<template>}` is a clean, `umd`-silent, `rt1`-safe, containment-safe **front-insert writer** of a template's `todayIndex`. It is a **template-cell PROTOCOL CANDIDATE**, characterised (front-insert primitive; a reverse-target dispatch of one front-insert per row is the plausible full-sort protocol, as with the deadline-cycle — NOT proven end-to-end here, flagged). It is NOT wired (maintainer-ratification follow-up). The **`project id` specifier is a template REPARENT HAZARD** and must never carry a template id. Note the GUI drag (TDRAG-1) reaches the same byte; the two surfaces agree.

## TDRAG-4 — reschedule-bounce (TMPLDL-1f): the mechanism does not exist

With AX fully granted, `Items ▸ When…` was driven by name on a repeating template. It opens the **repeat popover** — `Daily` / a read-only occurrence-date list (`Jul 6, Jul 7, Jul 8, …`) / `Pause` / `Stop` / `Show Latest` (screenshot `arm4-when-popover.png`) — **not** a date picker. A typed date + Enter is inert (no field to receive it; zero DB delta). There is **no GUI surface to reschedule a single occurrence of a template to a different day**, so the hypothesised D→D+1→D front-insert "bounce" is unrealisable. Changing the *rule* (Change…/reschedule-repeat) moves ALL occurrences and is `todayIndex`-inert (ORDFIN1 Arm 1b), not a bounce.

**Verdict — TMPLDL-1f:** RESOLVED — **mechanism absent** (was "BLOCKED-BY-VM-INPUT-GATING"). A template has no per-occurrence reschedule surface; `When…` is the repeat editor. The template's Upcoming placement is movable only by the drag (TDRAG-1) or the private `list "Upcoming"` reorder (TDRAG-3), both of which write `todayIndex` directly rather than via any date bounce.

## TDRAG-5 — ORD-18: does a scheduled row's dated `day` bounce perturb its stored `index`?

The register flagged this as an evidence-gap (a scheduled row is not `index`-presented, so the invariant held only in its presentation-scoped reading; the byte-level claim was unproven).

- **Directly-scheduled rows rest at `index=0`** (created via `when=<date>`; three same-day rows all `index=0`) — the bounce trivially preserves `0→0`. To make the test rigorous a **distinct** non-zero `index` was needed.
- **A scheduled row CAN carry a distinct `index`:** three anytime rows in a project were given distinct `index` (`OE1 −105, OE2 −57, OE3 0`) by a native reorder, then **scheduled** (`when=07-06`) — scheduling **PRESERVED** the distinct `index` (`−105/−57/0` unchanged).
- **The dated `day` bounce is `index`-byte-isolated:** `update?when=07-09` then `when=07-06` on `OE2` (`index=-57`) → `todayIndex −4678 → −5479` (front-insert) while **`index=-57` byte-IDENTICAL** before/after.

**Verdict — ORD-18:** RESOLVED at the byte level — the scheduled-row dated `day` bounce rewrites `todayIndex` and leaves the stored `index` byte-identical, even when the row carries a distinct non-zero `index`. The axis-isolation invariant holds as a hard byte fact, not merely presentation-scoped. (The `when=` legs DO bump `umd`, as URL field-writes always do — contrast the placement re-ranks above.)

## TDRAG-6 — the §6 `.ips` crash capture

AppleScript `schedule to do id "<heading>" for ((current date) + 1 * days)` on heading `Alpha` (type=2): the process **died** (pid 645 → gone), the heading row was **byte-identical** after relaunch (no corruption), and this time DiagnosticReports **flushed** a crash report (`Things3-2026-07-05-120237.ips`, gitignored). Narrative excerpt for the Cultured Code report:

- **Exception:** `EXC_BREAKPOINT` / `SIGTRAP` — `codes 0x…0001, …`, `rawCodes [1, …]`.
- **Termination:** `SIGNAL` code 5, indicator **"Trace/BPT trap: 5"**, by `exc handler` (a Swift runtime trap).
- Same signature family as §1 (the URL `when=` on a repeating item) and the §7 C1–C5 schedule-class crashes — confirming §6 is one more **unguarded-precondition trap** in the schedule-class path (the AppleScript `schedule` guard that cleanly refuses a repeating to-do with error 302 is simply missing for `type=2` heading rows).

**Verdict — TDRAG-6:** the §6 crash is reproduced under 3.22.12 with a captured `.ips` (`EXC_BREAKPOINT/SIGTRAP`), closing the "a `.ips` capture is still wanted for the report" note in the crash catalog. No data corruption.

## App oddities filed

- **§9 (new sub-note) — a native/GUI `todayIndex`/`index` re-rank is `userModificationDate`-SILENT.** The GUI drag (TDRAG-1/2 within-block) and the private `list "Upcoming"`/`project id` reorder placement writes do NOT bump `userModificationDate`, where every URL field-write (`when=`, `deadline=`) does, and the containment reparent (project-id reorder) does. A watcher diffing on `umd` will MISS a pure placement re-rank.
- **§6 (addendum) — the `.ips` is captured** (EXC_BREAKPOINT/SIGTRAP), see above.
- **§9 (new) — the private `reorder to dos in project id <P>` REPARENTS a repeating TEMPLATE** whose id is in the wire (`project` NULL→P, `umd` bump), rather than positioning it — a silent containment hazard distinct from the O06 headed-child rip.
- **§8h/§9e context — TMPLIDX is surface-specific, not absolute:** the template `todayIndex` IS reachable (front-insert) via the private `list "Upcoming"` reorder and via the GUI drag; it is unreachable via the repeat-series levers, the `deadline=` surface, `list "Today"`/`list "Tomorrow"` reorder, and any per-occurrence reschedule (which does not exist).

## Reproduce

```sh
export VNCDO=/Volumes/Workspace/Projects/things-api/lab/vncvenv/bin/vncdo   # gitignored venv (host)
TART_HOME=/Volumes/Workspace/tart \
  bash lab/scripts/research-tdrag.sh setup        # clone golden-v2 + boot(--vnc-experimental) + airgap + clock-pin + warm
  bash lab/scripts/research-tdrag.sh caps          # de-risk: VNC capture + AX + HID smoke
  bash lab/scripts/research-tdrag.sh arm1-seed     # TDRAG-1 seed the 07-06 block
  bash lab/scripts/research-tdrag.sh snapshot arm1-before
  bash lab/scripts/research-tdrag.sh arm1-shot arm1-before      # read the PNG, pick coords
  bash lab/scripts/research-tdrag.sh arm1-drag <sx> <sy> <tx> <ty> <label>
  bash lab/scripts/research-tdrag.sh arm1-read after ; snapshot arm1-after ; (diff the snaps)
  bash lab/scripts/research-tdrag.sh arm1-persist  # quit+relaunch persistence
  bash lab/scripts/research-tdrag.sh arm2-seed     # TDRAG-2 forecast block (+ 2-shot/-drag/-read; between-block into 07-06)
  bash lab/scripts/research-tdrag.sh arm3b         # TDRAG-3 TMPLIDX clean re-probe (pristine template)
  bash lab/scripts/research-tdrag.sh arm4          # TDRAG-4 open Items>When... (repeat popover); arm4-drive "<date>"
  bash lab/scripts/research-tdrag.sh arm5 ; arm5b  # TDRAG-5 ORD-18 (headless)
  bash lab/scripts/research-tdrag.sh arm6          # TDRAG-6 §6 crash + .ips capture
  bash lab/scripts/research-tdrag.sh teardown
```

The drag arms are granular (seed → shot → drag → read → snapshot-diff) because rows are identified visually from the framebuffer capture and dropped by coordinate; the headless arms (arm3/arm3b/arm5/arm5b/arm6) run start-to-finish. A first clone ran the drag arms + arm3 (which contaminated the template); a second fresh clone ran arm3b/arm4/arm6. One `.ips` is captured under `screens/` (gitignored — never committed; prose/excerpts only).
