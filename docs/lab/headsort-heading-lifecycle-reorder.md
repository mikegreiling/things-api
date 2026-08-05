# HEADSORT — heading-`index` reorder across the full lifecycle (open / archived-unswept / archived-swept)

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05 12:00**. Campaign **2026-08-05**, one disposable clone (`lab/artifacts/headsort-lab/`, gitignored — `report.txt` + `final.sqlite`), no crash (Things ALIVE throughout, no DiagnosticReports). Discovery — no assertions; **DB row deltas are ground truth**. Driver: [`lab/scripts/research-headsort.sh`](../../lab/scripts/research-headsort.sh) (subcommands `setup·base·loginterval·archive·unswept·swept·mixed·restore·dump`).

## The question

Can heading `index` be reordered across the WHOLE heading lifecycle — **open**, archived-**UNSWEPT** (completed, still in the project body), archived-**SWEPT** (completed, past the log-move boundary, collapsed into the Logbook toggle) — mutating **ONLY `index`**? Maintainer GUI ground truth to confirm (2026-08-05, from iOS/desktop experimentation): archived-unswept headings ARE drag-sortable in the body; swept headings retain their `index` and, restored, re-enter the body at the retained position; and it was OPEN whether the private reorder verb can reach swept-archived headings (not GUI-exposed) and whether a MIXED set (open + unswept + swept) reorders in one wire.

**Bottom line.** The private reorder verb re-ranks heading `index` into the exact sent order for **every** lifecycle state — open, unswept-archived, AND swept-archived — in a single comma-joined wire (a partial wire re-ranks only the named headings, clustering them at the front). Reachability is **sweep-agnostic**: a swept heading, invisible to GUI drag, is repositioned identically to an unswept one. BUT the re-rank mutates **only `index`** for OPEN headings (`userModificationDate`-silent); for **ARCHIVED headings of BOTH sweep states** the same re-rank **ALSO REOPENS the heading** — `status 3→0` + `stopDate→NULL` + a `umd` bump, **heading-only** (the heading's swept children stay resolved, byte-identical). **There is therefore NO index-only reorder of an archived heading via this verb: repositioning an archived heading un-archives it.** This is a new member of the §5o / §5b reopen family — and the FIRST that reopens WITHOUT adding an open child (the trigger is the index re-rank itself).

## The wire under test

The undocumented sdef command behind every native reorder scope (novel-paths #1; the engine gates it behind `allow-experimental` + the `sdefDeclaresPrivateReorder()` canary; probed here RAW):

```
tell application "Things3" to _private_experimental_ reorder to dos in project id "<PROJ>" with ids "h1,h2,h3"
```

The heading-in-a-project specifier is `project id "<uuid>"` (scf P1; the shipped `project.move-heading` compiles exactly this — [src/write/commands.ts](../../src/write/commands.ts):1760). **Wire-syntax law (re-honored):** the ids are ONE comma-joined STRING; a multi-item AppleScript LIST literal (`{"a","b"}`) throws −1700 at the AppleEvent boundary and the app never runs the command (TMPLSORT artifact). Every reorder in this campaign captured the guest-side `EXIT=<code>` (no `|| true`, no list literals), so a −1700 (wire-never-ran) is distinguishable from an app silent no-op. **All 5 accepted legs returned `EXIT=0`** — the wire ran every time; no −1700, no silent no-op.

## Manufacturing the three sweep states

There is **no per-row swept bit** — an item is SWEPT iff `status` closed AND `stopDate <= logBoundary`, where the boundary is `TMSettings.logInterval` + `manualLogDate` ([src/read/log-boundary.ts](../../src/read/log-boundary.ts); plog1/A28/LOGNOW). The golden default `logInterval=0` (Immediately) collapses the boundary to `now`, so every completion is swept at once. To hold a completed heading UNSWEPT we flipped **`logInterval=4` (Manually)** via the Settings "Move completed items to Logbook" popup, driven by **System Events AX** over SSH (golden-v2's baked L3-accessibility grant — no VNC needed; the popup is an unnamed `AXPopUpButton` in `window "General"` identified by its `value="Immediately"`, then 2×`key code 125` + `key code 36` = the Manually option; verified `logInterval 0→4`, `manualLogDate` stamped). With `logInterval=4` the boundary is `manualLogDate`, and an AppleScript `log completed now` advances `manualLogDate` to sweep the completions that precede it (LOGNOW).

Two synthetic projects in `LAB-AREA-A`, both built in one `things:///json` call (the HX0 heading-create path — real `type=2` rows), each heading carrying 2 children:

- **`HSORT-BASE`** — 4 OPEN headings `HB1..HB4` (control).
- **`HSORT-LIFE`** — 6 headings seeded interleaved `Lo1,Lu1,Ls1,Lo2,Lu2,Ls2`. Lifecycle built by: complete `Ls1,Ls2` → `log completed now` (advances `manualLogDate` past their `stopDate` ⇒ **Ls\* SWEPT**) → complete `Lu1,Lu2` AFTER the sweep (`stopDate` > boundary ⇒ **Lu\* UNSWEPT**) → `Lo1,Lo2` left **open**. A boundary cleanly separating swept from unswept was reproduced twice (`manualLogDate` 1783253023.55 then 1783253113.73, always between the Ls\* and Lu\* stopDates). **Archival preserves `index`** (each heading's `index` byte-identical through `status 0→3`), confirming the archive is a `status`+`stopDate` write only — the first pillar of the maintainer's index-retention claim.

## Probe-by-probe evidence

### H-BASE — reorder 4 OPEN headings (the control)

Wire `HB3,HB1,HB4,HB2` (project `HSORT-BASE`):

| heading | idx BEFORE | idx AFTER | status | stopDate | heading-FK | `umd` |
|---|---|---|---|---|---|---|
| HB3 | −197 | **−2205** | 0 (unch) | — | — | 1783252827.4283 (**byte-identical**) |
| HB1 | −593 | **−1739** | 0 | — | — | 1783252827.4266 (**identical**) |
| HB4 | 0 | **−1352** | 0 | — | — | 1783252827.4290 (**identical**) |
| HB2 | −347 | **−997** | 0 | — | — | 1783252827.4275 (**identical**) |

**Verdict (H-BASE):** `EXIT=0`; the sent order is honored EXACTLY (`HB3 < HB1 < HB4 < HB2`, the app re-spreads fresh negative `index` values). Mutation is **`index`-only** — `status`/`stopDate`/`trashed`/FKs untouched — and **`userModificationDate`-SILENT** on all four headings (native-reorder umd-silence, grndint). All 8 children byte-identical (heading FK, per-child `index`, `umd`). This is the open-heading baseline the archived legs are compared against.

### H-UNSWEPT — mixed wire OPEN + UNSWEPT-archived

State: `Lo1,Lo2` open; `Lu1,Lu2` unswept (`stopDate` 1783253026.16 / 1783253027.52 > boundary 1783253023.55); `Ls1,Ls2` swept (not in wire). Wire `Lu1,Lo1,Lu2,Lo2`:

| heading | class | idx AFTER | status B→A | stopDate B→A | `umd` |
|---|---|---|---|---|---|
| Lu1 | unswept | −2597 | **3 → 0** | **1783253026.16 → NULL** | bumped 1783253026.16 → **1783253044.53** |
| Lo1 | open | −1964 | 0 → 0 | — | **byte-identical** |
| Lu2 | unswept | −1440 | **3 → 0** | **1783253027.52 → NULL** | bumped → **1783253044.53** |
| Lo2 | open | −1104 | 0 → 0 | — | **byte-identical** |
| Ls1/Ls2 | swept (unaddressed) | −139 / 0 (unch) | 3 (unch) | unch | unch |

**Verdict (H-UNSWEPT):** `EXIT=0`; order honored exactly (`Lu1 < Lo1 < Lu2 < Lo2`). The wire is ACCEPTED — but it is **NOT index-only for the unswept members**: `Lu1`/`Lu2` are **REOPENED** (`status 3→0`, `stopDate→NULL`, `umd` bumped), while the open `Lo1`/`Lo2` are pure `index`-only + umd-silent. The reopen is **heading-only** — `Lu1`/`Lu2`'s children stay `status=3` (heading FK, `index`, `stopDate`, `umd` byte-identical), exactly the §5o / HEADARC un-archive byte delta. Un-addressed swept `Ls1`/`Ls2` are fully untouched (partial wire = named rows only; addressed rows front-cluster above them).

### H-SWEPT(a) — swept-ONLY wire

State (post-H-UNSWEPT): `Ls1,Ls2` still swept. Wire `Ls2,Ls1` (swap the two swept headings):

| heading | idx BEFORE | idx AFTER | status B→A | stopDate B→A | `umd` |
|---|---|---|---|---|---|
| Ls2 | 0 | **−3558** | **3 → 0** | **1783253021.69 → NULL** | bumped → 1783253081.82 |
| Ls1 | −139 | **−2993** | **3 → 0** | **1783253020.31 → NULL** | bumped → 1783253081.82 |

**Verdict (H-SWEPT-a):** `EXIT=0`; the swap is honored (`Ls2 < Ls1`, front-clustered above all others). **Swept-archived headings ARE reachable by the verb** — the class GUI drag never exposes is repositioned headlessly (a novel path). But — identically to the unswept case — the reorder **REOPENS** them (`status 3→0`, `stopDate→NULL`, `umd` bumped, heading-only, children resolved byte-identical). Reachability is sweep-agnostic; the reopen is sweep-agnostic.

### H-SWEPT(b) / MIXED — one wire moving every class

Reconstituted lifecycle (2nd archive; boundary 1783253113.73; `Ls*` swept, `Lu*` unswept, `Lo*` open). Full 6-id wire `Ls1,Lo2,Lu1,Ls2,Lo1,Lu2`:

| heading | class | idx AFTER | status B→A | `umd` |
|---|---|---|---|---|
| Ls1 | swept | −5824 | **3 → 0** | bumped → 1783253157.40 |
| Lo2 | open | −5303 | 0 → 0 | **byte-identical** |
| Lu1 | unswept | −4855 | **3 → 0** | bumped → 1783253157.40 |
| Ls2 | swept | −4232 | **3 → 0** | bumped → 1783253157.40 |
| Lo1 | open | −3732 | 0 → 0 | **byte-identical** |
| Lu2 | unswept | −3183 | **3 → 0** | bumped → 1783253157.40 |

**Verdict (MIXED):** `EXIT=0`; the sent order is honored **EXACTLY** (`Ls1 < Lo2 < Lu1 < Ls2 < Lo1 < Lu2`) with every class repositioned. All **four** archived members (both swept `Ls*` and unswept `Lu*`) **REOPEN** (`status 3→0`, `stopDate→NULL`, `umd` bump); the two open members are `index`-only + umd-silent. All **18 children** across the project are byte-identical (`status`, `stopDate`, `trashed`, heading FK, per-child `index`, `umd`). A mixed lifecycle set reorders in one wire — with the archived rows un-archived as the price of admission.

### H-RESTORE — a restored archived heading retains its `index`

The reorder itself already reopens an archived heading AT its moved `index` (H-UNSWEPT/SWEPT/MIXED leave e.g. `Ls1` open at −5824, its reordered slot — it re-enters the body at the NEW position, index NOT re-derived). This probe isolates the **pure unarchive** on `Lu2` (open at −3183): archive it (`status→3`, `index` stays **−3183**) then unarchive it (`set status to open`):

| step | idx | status | stopDate |
|---|---|---|---|
| pre-archive | −3183 | 0 | NULL |
| archived | **−3183** | 3 | 1783253213.22 |
| **unarchived (restored)** | **−3183** | 0 | NULL |

**Verdict (H-RESTORE):** the unarchive is **`index`-SILENT** — `Lu2` re-enters the body at its retained `index` (−3183 throughout), status 3→0 + stopDate→NULL only. Combined with the archive being index-silent (above) and the log-move sweep writing **no** task rows (plog1/A28/LOGNOW — "swept" is a pure view boundary), a **swept** heading's `index` is retained across the whole complete→sweep→restore cycle. This confirms the maintainer's ground truth: swept headings retain `index`; restoring re-enters at the retained position. *(Boundary note: `log completed now` advances `manualLogDate` only when there are pending completions to log — it stamps the boundary to ~the completion instant, not unconditionally to `now` — so on this isolated leg with the single completion the boundary did not advance and `Lu2` was technically unswept at restore. Immaterial to the `index`-retention law, which holds identically for both sweep states because the sweep mutates no rows.)*

### H-SIDEFX — the exact side-effect inventory (every accepted leg)

Across all five accepted reorder legs, the fields that changed were **exactly**: `index` (every wire member) and — **only for ARCHIVED members** — `status` (3→0), `stopDate` (→NULL), and `userModificationDate`. Everything else was byte-identical on every leg: open-heading `status`/`stopDate`/`umd`; **all children** (`status`, `stopDate`, `trashed`, heading FK, per-child `index`, `umd`); un-addressed headings; project rows. **No child `index` drift, no heading-FK drift (no §9k/O06 rip — headings are project-level rows, and their type=2 children follow silently).**

**`umd` bump count per leg = the number of ARCHIVED headings in the wire** (H-BASE 0, H-UNSWEPT 2, H-SWEPT-a 2, MIXED 4); open members and ALL children are umd-silent. **Watch-mode implication:** an OPEN-heading reorder is invisible to a `MAX(userModificationDate)` freshness watcher (umd-silent, like every native reorder); an ARCHIVED-heading reorder DOES bump `umd` (because it reopens), so it IS visible to such a watcher — a rare native-reorder path that is not umd-silent, precisely because it is not index-only.

### H-REFUSE — no class is refused

There was **no refusal** to characterize: every wire (open-only, mixed open+unswept, swept-only, full mixed) returned `EXIT=0` and mutated the DB. No −1700 (the wire always ran — comma-joined string honored), no silent no-op (every addressed row moved). The archived classes are **ACCEPTED, not refused** — the "cost" is the reopen side effect, not a rejection.

## Reconciled laws

1. **HEADSORT reachability + reopen law.** `_private_experimental_ reorder to dos in project id X with ids "…"` re-ranks heading `index` into the exact sent order for **every** lifecycle state — open, archived-unswept, archived-swept — in one comma-joined wire; a PARTIAL wire re-ranks only the named headings and front-clusters them above un-addressed ones. Mutation is **`index`-only + umd-silent for OPEN headings**; for **ARCHIVED headings (either sweep state)** the same re-rank ALSO **REOPENS** the heading (`status 3→0` + `stopDate→NULL` + `umd` bump, **heading-only** — swept children stay resolved byte-identical). **No index-only reorder of an archived heading exists via this verb.** Sweep state is immaterial to reachability and to the reopen (the sweep is a pure view-time boundary that writes no rows).

2. **Swept reachability (novel path).** Swept-archived headings — not exposed to GUI drag — are repositionable headlessly via the verb (H-SWEPT-a swap honored, MIXED). See [novel-paths](../reference/novel-paths.md).

3. **Reorder-reopen (app quirk — §5o family, new trigger).** The reorder verb is a FIFTH headless surface that reopens an archived heading, and the FIRST that reopens WITHOUT adding an open child — the index re-rank itself is the trigger. Byte-identical reopen to the AS un-archive / §5o move-in reopen. See [oddities §5o](../things-app-oddities.md).

4. **Restore index-silence.** `set status to open` (unarchive) is `index`-silent; archival is `index`-silent; the sweep writes no rows — so an archived heading (swept or not) restored re-enters the body at its retained `index`. Confirms the maintainer's ground truth.

5. **Children inert.** A heading reorder never touches its children — heading FK, child `index`, `status`, `umd` all byte-identical on every leg and every class.

## Bearing on the shipped surface (evidence-only — no code change here)

- The shipped **`project.move-heading`** (`things project move-heading`, ORD-1 native forward on the `project id` specifier) computes a full-heading `targetOrder` and assumes an `index`-only re-rank. That assumption holds **only while every heading in the project is OPEN.** If a project contains an archived heading and the op re-ranks the full list, HEADSORT shows the archived heading would be **silently un-archived** (heading-only reopen). A future wiring/guard decision (open-only heading reorder, or an acknowledged-reopen gate à la `acknowledgeProjectReopen`) is flagged for the reorder planner — not made here. Recorded as **ORD-12** in the [assumption register](../reference/assumption-register.md).
- Feeds the **read-shape doctrine re-audit** (`docs/design/read-shape-doctrine.md`, status REVERTED): a heading's lifecycle state and its `index` are orthogonal (archival preserves `index`; the verb couples reorder to reopen), which the read model of "headings catalog vs logged region" must account for.

## Per-probe verdict summary

| Probe | Wire | Verdict |
|---|---|---|
| **H-BASE** | 4 open headings, `HB3,HB1,HB4,HB2` | `EXIT=0`; exact order; **index-only, umd-SILENT**; children byte-identical — the control |
| **H-UNSWEPT** | open+unswept `Lu1,Lo1,Lu2,Lo2` | `EXIT=0`; exact order; open = index-only umd-silent; **unswept REOPENED** (3→0, stop→NULL, umd+), children resolved; swept unaddressed untouched |
| **H-SWEPT(a)** | swept-only `Ls2,Ls1` | `EXIT=0`; swap honored; **swept REACHABLE** (novel) but **REOPENED** heading-only; children byte-identical |
| **H-SWEPT(b)/MIXED** | all-class `Ls1,Lo2,Lu1,Ls2,Lo1,Lu2` | `EXIT=0`; **exact order**, every class moves; 4 archived REOPENED, 2 open index-only umd-silent; all 18 children byte-identical |
| **H-RESTORE** | unarchive `Lu2` | unarchive **index-SILENT** (idx −3183 retained); + sweep-writes-no-rows ⇒ swept headings restore in place |
| **H-SIDEFX** | (all legs) | mutated set = `index` (all members) + `status`/`stopDate`/`umd` (archived members ONLY); children + open members + project rows byte-identical; umd bumps = #archived-in-wire |
| **H-REFUSE** | (all legs) | no refusal — every class ACCEPTED (`EXIT=0`), no −1700, no silent no-op |

## Notes

- Teardown: clone `headsort-lab` stopped + deleted; only `things-lab-golden-v2` (stopped) remains. No stray `tart run`.
- `logInterval` was set to 4 (Manually) via System Events AX for the campaign; it lives in `TMSettings` and is irrelevant to the shipped surface (a boundary knob only).
