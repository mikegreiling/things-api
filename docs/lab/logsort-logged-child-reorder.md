# LOGSORT — direct-child TO-DO `index` reorder across the lifecycle (open / completed-unswept / canceled-unswept / completed-swept)

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05 12:00**. Campaign **2026-08-05**, one disposable clone (`lab/artifacts/logsort-lab/`, gitignored — `report.txt` + `final.sqlite`), no crash (Things ALIVE throughout, no DiagnosticReports). Discovery — no assertions; **DB row deltas are ground truth**. Driver: [`lab/scripts/research-logsort.sh`](../../lab/scripts/research-logsort.sh) (subcommands `setup·base·loginterval·archive·canceled·unswept·swept·rebuild·mixed·restore·headed·dump`). The direct-children **mirror of HEADSORT** ([headsort-heading-lifecycle-reorder.md](headsort-heading-lifecycle-reorder.md), #400) — same wire, same sweep machinery, same byte-diff discipline; the question is which HEADSORT heading laws carry over to logged to-dos and which diverge.

## The question

HEADSORT established that the private reorder verb re-ranks heading `index` into the exact sent order for EVERY heading lifecycle state, but that re-ranking an **archived** heading (unswept OR swept) also **REOPENS** it (sweep-agnostic reopen). Does that reopen-on-rerank law extend to logged **TO-DOS** — the direct children of a project (`heading=NULL`, `project=<proj>`)? Specifically: is a **completed** (`status=3`) or **canceled** (`status=2`) direct child reopened by the re-rank, or is a to-do reorder purely `index`-only? Does the sweep state matter? And what happens to a logged to-do that lives under a live heading?

**Bottom line.** For direct-child to-dos the reorder verb is **`index`-only + `userModificationDate`-SILENT for open AND for UNSWEPT resolved to-dos alike** — a completed-unswept or canceled-unswept child is re-ranked with **status/stopDate/umd byte-identical, NO reopen**. Only a **SWEPT** to-do is reopened by the re-rank (`status 3→0` + `stopDate→NULL` + `umd` bump), because repositioning it pulls it out of the Logbook region back into the live project body (a §5o-family move-in reopen). So the to-do reopen is **SWEEP-DEPENDENT** — the sharpest divergence from HEADSORT, where BOTH sweep states of an archived heading reopened (sweep-agnostic). `umd`-bump count per leg = the number of **SWEPT** members in the wire (not the number of resolved members). Canceled and completed behave identically. Restore/complete/sweep are all `index`-silent (a swept to-do restored re-enters the body at its retained `index`; a swept to-do re-ranked first re-enters at the NEW `index`). A logged to-do under a LIVE heading, re-ranked via the project-scope wire, is **reparented out of the heading** (the known O06/§9k rip — `heading→NULL`, `project→root`) AND, if swept, additionally reopened.

## The wire under test

The undocumented sdef command behind every native reorder scope (novel-paths #1; the engine gates it behind `allow-experimental` + the `sdefDeclaresPrivateReorder()` canary; probed here RAW). Direct-child to-dos live in the project's ONE `index` space, addressed by the SAME `project id` specifier the shipped `reorder --scope project` compiles ([src/write/commands.ts](../../src/write/commands.ts):1440):

```
tell application "Things3" to _private_experimental_ reorder to dos in project id "<PROJ>" with ids "t1,t2,t3"
```

**Wire-syntax law (re-honored):** the ids are ONE comma-joined STRING; a multi-item AppleScript LIST literal (`{"a","b"}`) throws −1700 at the AppleEvent boundary and the app never runs the command (TMPLSORT artifact). Every reorder in this campaign captured the guest-side `EXIT=<code>` (no `|| true`, no list literals), so a −1700 (wire-never-ran) is distinguishable from an app silent no-op. **All 8 accepted legs returned `EXIT=0`** — the wire ran every time; no −1700, no silent no-op.

## Manufacturing the four lifecycle states

There is **no per-row swept bit** — a to-do is SWEPT iff `status` is closed (completed `3` OR canceled `2`) AND `stopDate <= logBoundary`, where the boundary is `TMSettings.logInterval` + `manualLogDate` ([src/read/log-boundary.ts](../../src/read/log-boundary.ts); plog1/A28/LOGNOW). The golden default `logInterval=0` (Immediately) collapses the boundary to `now`, so every resolution is swept at once. To hold a resolved to-do UNSWEPT we flipped **`logInterval=4` (Manually)** via the Settings "Move completed items to Logbook" popup, driven by **System Events AX** over SSH (golden-v2's baked L3-accessibility grant — the popup is an unnamed `AXPopUpButton` in `window "General"` identified by `value="Immediately"`, then 2×`key code 125` + `key code 36` = the Manually option; verified `logInterval 0→4`, `manualLogDate` stamped 1783252834.58). With `logInterval=4` the boundary is `manualLogDate`, and an AppleScript `log completed now` advances `manualLogDate` to sweep the resolutions that precede it (LOGNOW).

Three synthetic projects in `LAB-AREA-A`, each built in one `things:///json` call:

- **`LSORT-BASE`** — 6 OPEN direct to-dos `T1..T6` (control).
- **`LSORT-LIFE`** — 8 direct to-dos seeded interleaved `To1,Tu1,Ts1,Tc1,Tcm1,To2,Tu2,Ts2`. Lifecycle built by: complete `Ts1,Ts2` → `log completed now` (advances `manualLogDate` 1783252888.86 past their `stopDate` ⇒ **Ts\* SWEPT**) → resolve `Tu1,Tu2,Tcm1` (complete) + `Tc1` (cancel) AFTER the sweep (`stopDate` > boundary ⇒ **UNSWEPT**) → `To1,To2` left **open**. A boundary cleanly separating swept from unswept was reproduced twice (`manualLogDate` 1783252888.86 then, for MIXED, 1783252971.93 — always between the Ts\* and Tu\* stopDates). **Resolution preserves `index`** (each to-do's `index` byte-identical through `status 0→3`/`0→2`), confirming the resolve is a `status`+`stopDate` write only.
- **`LSORT-HEADED`** — one LIVE heading `Hh` over three children `Th1,Th2,Th3` (for L-HEADED; `Th2` later completed + swept).

## Probe-by-probe evidence

### L-BASE — reorder 6 OPEN direct to-dos (the control)

Wire `T4,T1,T6,T2,T5,T3` (project `LSORT-BASE`):

| to-do | idx BEFORE | idx AFTER | status | `umd` |
|---|---|---|---|---|
| T4 | −60 | **−3226** | 0 | 1783252827.4925 (**byte-identical**) |
| T1 | −386 | **−2765** | 0 | 1783252827.4920 (**identical**) |
| T6 | 0 | **−2304** | 0 | 1783252827.4929 (**identical**) |
| T2 | −208 | **−1854** | 0 | 1783252827.4922 (**identical**) |
| T5 | −25 | **−1373** | 0 | 1783252827.4927 (**identical**) |
| T3 | −100 | **−765** | 0 | 1783252827.4923 (**identical**) |

**Verdict (L-BASE):** `EXIT=0`; the sent order is honored EXACTLY (`T4 < T1 < T6 < T2 < T5 < T3`, the app re-spreads fresh negative `index`). Mutation is **`index`-only** and **`userModificationDate`-SILENT** on all six — identical to the H-BASE open-heading baseline (native-reorder umd-silence, §9r/grndint). The open direct-child baseline the resolved legs are compared against.

### L-CANCELED — reorder a CANCELED + a COMPLETED (both unswept)

State (post-build): `Tc1` canceled-unswept (`status=2`, stop 1783252895.54 > boundary), `Tcm1` completed-unswept (`status=3`, stop 1783252894.17 > boundary). Wire `Tc1,Tcm1`:

| to-do | class | idx B→A | status B→A | stopDate | `umd` |
|---|---|---|---|---|---|
| Tc1 | canceled-unswept | −46 → **−1104** | **2 → 2** (unch) | unchanged | **byte-identical** |
| Tcm1 | completed-unswept | −28 → **−728** | **3 → 3** (unch) | unchanged | **byte-identical** |

**Verdict (L-CANCELED):** `EXIT=0`; order honored (`Tc1 < Tcm1`, front-clustered above the rest). The re-rank is **`index`-only + umd-SILENT for BOTH the canceled and the completed unswept member — NEITHER is reopened** (`status`, `stopDate`, `umd` all byte-identical). **This is the first divergence from HEADSORT** (where an unswept ARCHIVED heading reopens): an unswept resolved to-do — already struck-through in the live body — is repositioned within the body without crossing the Logbook boundary, so nothing reopens. Canceled (`status=2`) and completed (`status=3`) behave identically.

### L-UNSWEPT — mixed wire OPEN + COMPLETED-unswept

State: `To1,To2` open; `Tu1,Tu2` completed-unswept (stop 1783252891.46 / 1783252892.81 > boundary). Wire `Tu1,To1,Tu2,To2`:

| to-do | class | idx AFTER | status B→A | `umd` |
|---|---|---|---|---|
| Tu1 | completed-unswept | −3238 | **3 → 3** (unch) | **byte-identical** (1783252891.4552) |
| To1 | open | −2650 | 0 → 0 | **byte-identical** |
| Tu2 | completed-unswept | −2141 | **3 → 3** (unch) | **byte-identical** (1783252892.8104) |
| To2 | open | −1709 | 0 → 0 | **byte-identical** |

**Verdict (L-UNSWEPT):** `EXIT=0`; order honored exactly (`Tu1 < To1 < Tu2 < To2`, front-clustered above the un-addressed `Tc1/Tcm1/Ts1/Ts2`). The completed-unswept members are **`index`-only + umd-SILENT — NOT reopened** (`status=3`, `stopDate`, `umd` byte-identical), exactly like the open members. Confirms L-CANCELED: an unswept resolved direct child reorders cleanly, no reopen. Un-addressed rows fully untouched (partial wire = named rows only).

### L-SWEPT(a) — swept-ONLY wire

State: `Ts1,Ts2` swept (stop 1783252885.66 / 1783252887.01 <= boundary 1783252888.86). Wire `Ts2,Ts1` (swap the two swept to-dos):

| to-do | idx BEFORE | idx AFTER | status B→A | stopDate B→A | `umd` |
|---|---|---|---|---|---|
| Ts2 | 0 | **−4438** | **3 → 0** | **1783252887.014 → NULL** | bumped → 1783252937.8400 |
| Ts1 | −88 | **−3850** | **3 → 0** | **1783252885.663 → NULL** | bumped → 1783252937.8394 |

**Verdict (L-SWEPT-a):** `EXIT=0`; the swap is honored (`Ts2 < Ts1`, front-clustered above all others). **Swept to-dos ARE reachable by the verb** — but repositioning one **REOPENS** it (`status 3→0`, `stopDate→NULL`, `umd` bumped). Repositioning a swept to-do re-inserts it into the live body region (above the Logbook boundary), and the app un-completes it — a §5o-family move-in reopen. **This is the reopen HEADSORT saw, but for to-dos it fires ONLY on the swept class**, not the unswept one (L-CANCELED/L-UNSWEPT). 2 `umd` bumps = 2 swept members.

### L-MIXED (L-SWEPT b) — one wire moving every class

Reconstituted lifecycle (2nd sweep; boundary 1783252971.93; `Ts*` swept, `Tu*` unswept, `To*` open — the two unswept actors were reopened+recompleted AFTER the sweep so their fresh `stopDate` lands above the advanced boundary). Full 6-id wire `Ts1,To2,Tu1,Ts2,To1,Tu2`:

| to-do | class | idx AFTER | status B→A | `umd` |
|---|---|---|---|---|
| Ts1 | swept | −5996 | **3 → 0** | bumped → 1783253051.3152 |
| To2 | open | −5600 | 0 → 0 | **byte-identical** |
| Tu1 | unswept | −5056 | **3 → 3** (unch) | **byte-identical** (1783253035.2615) |
| Ts2 | swept | −4438 (retained) | **3 → 0** | bumped → 1783253051.3141 |
| To1 | open | −4251 | 0 → 0 | **byte-identical** |
| Tu2 | unswept | −3621 | **3 → 3** (unch) | **byte-identical** (1783253036.6193) |

**Verdict (MIXED):** `EXIT=0`; the sent order is honored **EXACTLY** (`Ts1 < To2 < Tu1 < Ts2 < To1 < Tu2`) with every class repositioned (the app re-spread the rows it needed and left `Ts2` at its prior −4438, which still satisfies the relative order). In ONE wire: the two **SWEPT** members REOPEN (`status 3→0`, `stopDate→NULL`, `umd` bump); the two **UNSWEPT** completed members are `index`-only + umd-SILENT (status/stopDate/umd byte-identical — **no reopen**); the two **OPEN** members are `index`-only + umd-silent. **`umd`-bump count = 2 = the number of SWEPT members** (NOT the four resolved members) — the direct contrast with HEADSORT, where the bump count equalled ALL archived (swept + unswept) headings. Un-addressed bystanders `Tc1`/`Tcm1` byte-identical.

### L-RESTORE — a restored SWEPT to-do retains its `index`

Isolates the PURE unarchive on the open actor `To1` (idx −4251): complete it, `log completed now` to SWEEP it, then `set status to open`:

| step | idx | status | stopDate |
|---|---|---|---|
| pre-complete | −4251 | 0 | NULL |
| completed + swept | **−4251** | 3 | 1783253069.675 (≤ boundary 1783253071.03) |
| **restored (set open)** | **−4251** | 0 | NULL (`umd` bumped 1783253073.868) |

**Verdict (L-RESTORE):** complete+sweep is **`index`-SILENT** (idx −4251 through `status 0→3`), and the pure unarchive is **`index`-SILENT** — `To1` re-enters the live body at its retained `index` −4251 (`status 3→0` + `stopDate→NULL` + `umd` bump only). Combined with the sweep writing **no** rows ("swept" is a pure view boundary), a swept to-do restored re-enters at its retained position — the exact H-RESTORE law. **And a swept to-do that is RE-RANKED first re-enters (reopened) at its NEW `index`** — e.g. MIXED reopened `Ts1` at its moved slot −5996, not its old −88. Both facets of the maintainer's index-retention ground truth hold for to-dos.

### L-HEADED — a logged to-do under a LIVE heading, re-ranked

Project `LSORT-HEADED`: heading `Hh` (`type=2`) over `Th1,Th2,Th3` (all `heading=Hh`, `project=NULL`). `Th2` completed + swept (stop 1783253087.03 ≤ boundary 1783253088.39). Wire `Th3,Th1,Th2` via the **project-scope** specifier `reorder to dos in project id <LSORT-HEADED>`:

| to-do | idx B→A | heading-FK B→A | project-FK B→A | status B→A | `umd` |
|---|---|---|---|---|---|
| Th3 | 0 → **−1064** | **Hh → NULL** | **NULL → proj** | 0 → 0 | **bumped** 1783253091.7951 |
| Th1 | −505 → −505 | **Hh → NULL** | **NULL → proj** | 0 → 0 | **bumped** 1783253091.7947 |
| Th2 | −313 → −313 | **Hh → NULL** | **NULL → proj** | **3 → 0** (REOPENED) | **bumped** 1783253091.7943 |

**Verdict (L-HEADED):** `EXIT=0`; order honored (`Th3 < Th1 < Th2`). The project-scope reorder is **NOT heading-aware** — all three addressed children are **REPARENTED out of the heading** (`heading→NULL`, `project→root`): this is the already-known **O06 / §9k rip** ([oddities §9k](../things-app-oddities.md), HEADSUB1), here re-confirmed under golden-v2 / 3.22.12 on the `index` axis for a project's heading-children. Because the heading-FK is a real mutation, **all three rows `umd`-bump** (NOT umd-silent — unlike a pure in-heading index reorder). The swept `Th2` **additionally REOPENS** (`status 3→0`, `stopDate→NULL`) — the LOGSORT swept-reopen law COMPOSES with the O06 reparent. The heading row `Hh` itself is byte-identical (idx 0, `status=0`). Takeaway: there is no project-scope surface to reorder a heading's children in place; and doing it anyway both reparents them and reopens any swept member.

### L-SIDEFX — the exact side-effect inventory (every accepted leg)

For the direct-child legs (L-BASE / L-CANCELED / L-UNSWEPT / L-SWEPT-a / MIXED), the fields that changed were **exactly**: `index` (every wire member) and — **only for SWEPT members** — `status` (3→0), `stopDate` (→NULL), and `userModificationDate`. Everything else byte-identical on every leg: OPEN and **UNSWEPT-resolved** members' `status`/`stopDate`/`umd`; un-addressed rows; project rows; `trashed`; `heading`/`project` FKs (all direct children, no heading involved). **`umd` bump count per leg = the number of SWEPT members in the wire** (L-BASE 0, L-CANCELED 0, L-UNSWEPT 0, L-SWEPT-a 2, MIXED 2) — resolved-but-unswept members and open members are umd-silent. L-HEADED is the one leg with a heading-FK delta (the O06 reparent: `index` + `heading` + `project` + `umd` on all three, + `status`/`stopDate` on the swept `Th2`).

### L-REFUSE — no class is refused

There was **no refusal** to characterize: every wire (open-only, canceled+completed, open+unswept, swept-only, full mixed, heading-children) returned `EXIT=0` and mutated the DB. No −1700 (comma-joined string honored), no silent no-op (every addressed row moved). Every lifecycle class of direct child is **ACCEPTED** — the "cost" for a SWEPT member is the reopen side effect; the "cost" for a heading-child is the O06 reparent.

## Reconciled laws (to-dos)

1. **LOGSORT reachability + sweep-dependent reopen law.** `_private_experimental_ reorder to dos in project id X with ids "…"` re-ranks direct-child to-do `index` into the exact sent order for EVERY lifecycle state — open, completed-unswept, canceled-unswept, completed-swept — in one comma-joined wire; a PARTIAL wire re-ranks only the named to-dos and front-clusters them above un-addressed ones. Mutation is **`index`-only + umd-SILENT for OPEN and for UNSWEPT resolved to-dos alike** (completed OR canceled — status/stopDate/umd byte-identical, NO reopen). For a **SWEPT** to-do the same re-rank **REOPENS** it (`status 3→0` + `stopDate→NULL` + `umd` bump) — the reposition pulls it out of the Logbook region into the live body (a §5o move-in reopen). **The to-do reopen is SWEEP-DEPENDENT** (swept reopens; unswept does not).

2. **Canceled ≡ completed.** An unswept CANCELED to-do (`status=2`) reorders `index`-only + umd-silent, identical to an unswept completed to-do (`status=3`). *(A swept canceled to-do was not directly re-ranked while swept; by the boundary-membership mechanism a swept canceled to-do is expected to reopen `2→0` exactly as a swept completed reopens `3→0`, but that is inferred, not directly probed here.)*

3. **`umd`-bump count = number of SWEPT members in the wire** (open + unswept-resolved members are umd-silent). A watch-mode implication: an open-or-unswept to-do reorder is invisible to a `MAX(userModificationDate)` freshness watcher; a wire touching a swept to-do bumps `umd` (because it reopens) and IS visible.

4. **Restore / complete / sweep index-silence.** Completing a to-do is `index`-silent; the sweep writes no rows; the pure unarchive (`set status to open`) is `index`-silent — so a swept to-do restored re-enters the body at its retained `index`, and a swept to-do re-ranked first re-enters (reopened) at its NEW `index`. Confirms the maintainer's index-retention ground truth for to-dos.

5. **Heading-children reparent (O06/§9k, re-confirmed).** The project-scope reorder of to-dos that live under a heading strips their `heading` FK (`→NULL`) and reparents them to the project root (`project→root`), umd-bumping all reparented rows; a swept member additionally reopens. There is no project-scope in-heading index reorder — this is the O06 rip, now re-confirmed on golden-v2 / 3.22.12, with the added observation that the swept-reopen law composes on top.

## HEADSORT parallel — which heading laws carry over, which diverge

| Facet | HEADSORT (headings) | LOGSORT (direct-child to-dos) | Parallel? |
|---|---|---|---|
| Wire = ONE comma-joined string; list literal → −1700 | yes | yes | **CARRIES** |
| Exact-order re-rank, every class reachable, `EXIT=0` | yes | yes | **CARRIES** |
| Partial wire front-clusters the named rows | yes | yes | **CARRIES** |
| OPEN member: `index`-only + umd-SILENT | yes | yes | **CARRIES** |
| Resolved member reachable regardless of sweep | yes | yes | **CARRIES** |
| **SWEPT** member REOPENS on re-rank | yes | yes | **CARRIES** |
| **UNSWEPT resolved** member reopens on re-rank | **YES (heading reopens)** | **NO (index-only, umd-silent)** | **⚠ DIVERGES** |
| Reopen is sweep-agnostic vs sweep-dependent | sweep-**AGNOSTIC** | sweep-**DEPENDENT** | **⚠ DIVERGES** |
| `umd`-bump count | = #archived (swept **+ unswept**) | = #**SWEPT** only | **⚠ DIVERGES** |
| Canceled (`status=2`) path | not probed (headings have no canceled state, §6a) | index-only unswept, like completed | **NEW (LOGSORT-only)** |
| Restore / archive / sweep are `index`-silent | yes | yes | **CARRIES** |
| Re-ranking a member preserves its parent FK | yes (headings are project-level; their children's FK intact) | **NO for a heading's CHILDREN — project-scope reparents them (O06/§9k)** | **NEW / O06** |

**Why the divergence.** An archived HEADING is conceptually always in the logged region — HEADSORT showed touching its order forces it back into the active body regardless of sweep. A resolved TO-DO is different: while UNSWEPT it is struck-through **in place in the live body**, so repositioning it stays in the body and nothing reopens; only once it is SWEPT (collapsed past the Logbook boundary) does a reposition re-cross that boundary and reopen it. So the heading reopen is order-triggered and sweep-agnostic; the to-do reopen is a body-vs-Logbook boundary crossing and therefore sweep-dependent.

## Bearing on the shipped surface (evidence-only — no code change here)

- The shipped **`reorder --scope project`** (the `todo reorder`/`todo move` project-scope placement leg) operates on OPEN to-dos and already REFUSES headed children via `H-REORDER-SCOPE` (ORD-9/O06). LOGSORT confirms that assumption is safe for the open case and adds two facts the planner should hold: (a) reordering a project's direct children that happen to be **completed/canceled but UNSWEPT** is clean (`index`-only, no reopen) — a benign case; (b) a wire that reaches a **SWEPT** direct child would silently **reopen** it (like ORD-12 for archived headings, but sweep-gated). Recorded as **ORD-13** in the [assumption register](../reference/assumption-register.md). No guard is wired here — the shipped reorder targets live rows; this is the characterization for a future logged-region reorder decision.
- The swept-to-do reachability is a **novel path** (reach + reposition a Logbook to-do headlessly, at the cost of reopening it) — [novel-paths](../reference/novel-paths.md) #3¾.

## Per-probe verdict summary

| Probe | Wire | Verdict |
|---|---|---|
| **L-BASE** | 6 open to-dos, `T4,T1,T6,T2,T5,T3` | `EXIT=0`; exact order; **index-only, umd-SILENT** — the control |
| **L-CANCELED** | canceled+completed unswept `Tc1,Tcm1` | `EXIT=0`; order honored; **BOTH index-only + umd-silent, NEITHER reopened** — diverges from HEADSORT |
| **L-UNSWEPT** | open+completed-unswept `Tu1,To1,Tu2,To2` | `EXIT=0`; exact order; completed-unswept **index-only + umd-silent, NO reopen**; open index-only |
| **L-SWEPT(a)** | swept-only `Ts2,Ts1` | `EXIT=0`; swap honored; **swept REACHABLE but REOPENED** (3→0, stop→NULL, umd+) |
| **L-SWEPT(b)/MIXED** | all-class `Ts1,To2,Tu1,Ts2,To1,Tu2` | `EXIT=0`; **exact order**, every class moves; 2 swept REOPENED, 2 unswept index-only, 2 open index-only; umd bumps = #swept (2) |
| **L-RESTORE** | complete+sweep+unarchive `To1` | complete/sweep/unarchive all **index-SILENT** (idx −4251 retained); swept re-ranked re-enters at NEW index (MIXED) |
| **L-HEADED** | heading-children `Th3,Th1,Th2` | `EXIT=0`; order honored; **O06/§9k REPARENT** (heading→NULL, project→root, all umd-bumped); swept `Th2` also REOPENED |
| **L-SIDEFX** | (all direct-child legs) | mutated set = `index` (all members) + `status`/`stopDate`/`umd` (**SWEPT members ONLY**); open + unswept-resolved + un-addressed byte-identical; umd bumps = #swept-in-wire |
| **L-REFUSE** | (all legs) | no refusal — every class ACCEPTED (`EXIT=0`), no −1700, no silent no-op |

## Notes

- Teardown: clone `logsort-lab` stopped + deleted; only `things-lab-golden-v2` (stopped) remains. No stray `tart run`.
- `logInterval` was set to 4 (Manually) via System Events AX for the campaign; it lives in `TMSettings` and is irrelevant to the shipped surface (a boundary knob only).
- Version-stamped `things-lab-golden-v2` / Things 3.22.12 per the [harness](harness.md) policy; re-confirmations of these laws under a later golden accrue in the [assumption register](../reference/assumption-register.md) *Confirmed under* column, never by editing this snapshot.
