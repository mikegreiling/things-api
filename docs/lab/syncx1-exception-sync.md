# SYNCX1 — the exception's SYNC behavior: whose date survives when two devices disagree about a slot

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · **two networked clones** (A and B) signed into the ONE durable Things Cloud account, both in the guest default zone (UTC), guest clock pinned **2026-07-05 12:00** and rolled to 07-07 / 07-09 · AXVM1 accessibility grant baked. Campaign run 2026-08-23, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-syncx1.sh`](../../lab/scripts/research-syncx1.sh) (phases `p1`…`p8`, plus offline `cmpsnap`/`devcmp` re-diffs). Fixtures fully synthetic (`SYNCX1-C1`…`C4`). Artifacts: `lab/artifacts/syncx1-lab/` (gitignored) — `report.txt`, per-phase full-row snapshots in `snap/`, AX dumps in `ax/`.

**Documented airgap deviation (sanctioned).** These probes REQUIRE the sync server, so the harness airgap default is deliberately overridden — network stays UP for the clones (TOMB1/SYNC2/SYNCLAT/SYNC2B/SYNC3 precedent). Everything else is unchanged: reads-only prod, writes via official surfaces, disposable VMs. The host Things app/container and the maintainer's real Things Cloud account are **never** touched.

**Account doctrine (no churn).** The durable account (#2) was **logged into**, never re-registered and never burned; credentials stayed in the PRIMARY checkout's gitignored `lab/artifacts/sync-durable-account/` and never entered an argv, a log or this repository (the driver pipes the password over ssh stdin into the guest's pasteboard and pastes it with ⌘V). The account was healthy throughout and is left alive.

**VM discipline.** A sibling campaign held one slot of the host's 2-VM ceiling, so the two clones were **sequenced, never concurrent** — every phase boots one clone, acts, and stops it. That is not a compromise for this campaign: sequencing is what makes "B has not received A's changes yet" a controlled fact rather than a race.

**DB oracle:** every phase is bracketed by a **full-row snapshot** of every `TMTask` column for the `SYNCX1-%` corpus (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed) diffed field by field, on **both** devices, plus a cross-device compare of the two snapshots (`devcmp`, which ignores only the three device-local rank columns `index` / `todayIndex` / `experimental`).

Predecessors: [repx2-exception-chooser.md](repx2-exception-chooser.md) §8 cell 4 and [repx3-chooser-residuals.md](repx3-chooser-residuals.md) §8 cell 1 — both name this as the open question a shipped exception-move op most needs answered. Sync model: [sync2b-durable-account.md](sync2b-durable-account.md) SY-3, [sync3-dedupe-tiebreak.md](sync3-dedupe-tiebreak.md) SY-3b.

---

## 0. Headline

1. **The exception WINS the merge, and there is no duplicate.** Device B, having independently materialized the vacated slot while disconnected, ends up with **one** row carrying **A's exception `startDate`** — its own rule-dated version is overwritten attribute by attribute, not kept beside it. Both devices finish byte-identical (§3).
2. **The slot-derived uuid law holds ACROSS DEVICES, and the exception carries the slot's uuid even though it is dated elsewhere.** A's `Make Exception` minted `DUf5vsFSiAnwVhWrdjDRiU` dated 2026-07-14; B, offline and never having seen it, had already minted **the same uuid** for the 07-07 slot. This is what makes the collapse structural rather than a reconciler's lucky guess (§3.1).
3. **A cursor advance that arrives BEFORE the peer's clock suppresses the peer's spawn entirely.** Device B, holding A's merged exception, rolled onto the vacated slot and produced **nothing** — no row, no cursor movement, no delta at all for that series (§2).
4. **The merge is not "each scalar to its MAX".** B's losing row had the numerically **later** `creationDate` (occurrence midnight, `1783382400.0`) and was the **later arriver**, and it still lost every contested attribute to A's row (`creationDate 1783252967.59`). The one attribute that separated them: A's row carried a `userModificationDate`; B's clock-spawned row's was **NULL**. This refines SY-3b, where `creationDate → MAX` was measured with `umd` co-varying (§3.2).
5. **`Update Rule` does NOT reconcile a peer's already-materialized occurrence** — B's stale-phase 07-07 row survives the re-anchor untouched, so the re-anchored series ends up holding one occurrence its new rule never scheduled. Coherent (it is the single-device "existing instances are untouched" law), but it is the honest cost of a cross-device re-anchor (§4).
6. **[Oddities §17](../things-app-oddities.md)'s double-book replicates faithfully and does NOT compound.** An exception parked on a live rule slot yields exactly **two** rows on that day on **both** devices — the second device's own spawn of that slot collapses into the first's by the same deterministic uuid. §17 is a one-device-severity defect that syncs correctly (§5).
7. **No ghost, no resurrection, no crash.** Three relaunch rounds per device across two clock advances produce *(no field changed on any surviving row)*, and the final states are identical on both devices across 15 rows and 615 fields (§6).

> **Bottom line for the exception-move decision:** the hard precondition is **CLEARED**. An exception does not duplicate on a second Mac; it is not silently reverted by a peer's spawner; and the peer's stale spawn is absorbed rather than left as a twin. The remaining hazard against the op is the pre-existing single-device one (§17), which sync neither creates nor worsens. **The build/don't-build call remains the maintainer's** — this campaign only removes the blocker.

---

## 1. The rig

### 1.1 Fixtures

Four `every-2-days` series, all built identically on device A at the pinned clock and all synced to the account before B ever attached:

```
things:///add?title=SYNCX1-C<n>&when=2026-07-05   then   Items ▸ Repeat… → daily, interval 2 → OK
  rule  tp=0 fu=16 fa=2 ts=0 rc=0 of=[{dy=0}]   sha256:46315b41130a7181 (627 B)
  next = icStart = 2026-07-07 ; icCount = 1 ; rows: the materialized 07-05 instance + the template
  slots: 07-07 · 07-09 · 07-11 · 07-13
```

Every-2-days rather than weekly for one reason: a weekly series' second slot is 2026-07-19, **past golden-v4's trial wall** ([harness](harness.md), REPX3 §5), and the campaign needs two live slots inside the window. It is also a rule whose two cursor columns genuinely differ (REPX1 §2.3), so nothing here rests on the daily degenerate case.

| fixture | template uuid | role |
|---|---|---|
| `SYNCX1-C1` | `7LutMPakqhxFB1WAe279QC` | **cell 1** — MERGE-FIRST; exception 07-07 → **Jul 12** (a non-slot day) |
| `SYNCX1-C2` | `9QF5LHJ4QGbjXuhkVscxAB` | **cell 2** — SPAWN-FIRST; exception 07-07 → **Jul 14** (a non-slot day) |
| `SYNCX1-C3` | `LVTmtbMcsGm5e5ju38aBFP` | **cell 3** — SPAWN-FIRST against `Update Rule` → **Jul 12** |
| `SYNCX1-C4` | `Km1Yor71nTAQkFNoWYvBfH` | **cell 5** — exception 07-07 → **Jul 9**, i.e. onto a LIVE rule slot |

Targets were chosen off the rule's own slot days (07-12 and 07-14 are even; the rule owns the odd days) so that cells 1–3 measure the sync question alone; C4 deliberately lands **on** a slot, which is the §17 arm.

### 1.2 The interleaving

APNs push is unavailable in a Tart guest, so a receiver pulls on relaunch / `things:///show` only (SYNCLAT); every "sync" below is two quit+relaunch rounds. "Offline" is the SYNC2B primitive — quit Things, delete both default routes, verify `curl cloud == 000`; reconnect by rebooting the clone (clean DHCP) and **re-pinning the clock before Things is allowed to launch** (a single launch at the host's real 2026-08 date would cross the trial wall and burn the clone, stickily).

| phase | device | clock | what happens |
|---|---|---|---|
| p1 | **A** | 07-05 | build C1–C4; `Make Exception` on **C1** (→07-12) and on **C4** (→07-09); push |
| p2 | **B** | 07-05 → 07-07 | attach, pull everything; **go offline**; roll onto the 07-07 slot |
| p3 | **A** | 07-05 | `Make Exception` on **C2** (→07-14); `Update Rule` on **C3** (→07-12); push |
| p4 | **B** | 07-07 | reconnect — **THE MERGE** |
| p5 | **A** | 07-05 → 07-07 | pull the merge; cross-device compare; then roll A onto 07-07 too |
| p6 | **B** | 07-09 | roll onto the next slot; converge |
| p7 | **A** | 07-09 | roll; converge; third-relaunch integrity |
| p8 | **B** | 07-09 | third-relaunch integrity; final cross-device compare |

By construction **B is the LAST device to push its version of the contested row** (it stayed offline through p3 and only rejoined in p4), which is what lets §3.2 separate "the merge follows arrival order" from "the merge follows a value".

### 1.3 Lineage, verified before anything is measured

After p2's first pull, on device B:

```
SYNCX1-C1 template on B: 1     SYNCX1-C2 template on B: 1
SYNCX1-C3 template on B: 1     SYNCX1-C4 template on B: 1     (1 = A's uuid, synced down)
C1's exception row present on B? 1     C4's? 1
```

All four templates and both p1 exception rows arrived with **A's uuids**, and B's copies of the four template rows are field-identical to A's. So every later disagreement is a genuine two-device disagreement about one shared record, not two records that merely look alike.

---

## 2. Cell 1 — MERGE-FIRST: the cursor advance arrives first, and B spawns nothing

### 2.1 The gesture on A (p1)

`Items ▸ When…` on C1's uuid-verified projection row, `July 12, 2026` typed and read back as a resolved row, Return → the three-button *Repeating To-Do* chooser (`Make Exception` / `Update Rule` / `Cancel` on `action-button-1/2/3`, byte-for-byte REPX2 §1.2's sheet), `Make Exception`:

```
INSERTED row 7MosxQaBbegnq391Wk36LJ
  startDate               = 2026-07-12          <- the chosen day
  status = 0 ; start = 2 ; rt1_instanceCreationCount = 0
  creationDate            = 1783252995.90352    <- the gesture wall-clock
  userModificationDate    = 1783252995.90572
  rt1_repeatingTemplate   = 7LutMPakqhxFB1WAe279QC

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-08   <- watermark: consumed slot + 1
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-09   <- cursor: the next RULE date
CHANGED template.todayIndexReferenceDate       : 2026-07-07 -> 2026-07-09
(template userModificationDate UNCHANGED — the cursor bookkeeping is umd-silent)
```

REPX3 §1.5's law, re-confirmed on a cloud-attached device: the two cursor columns split, and the template's `umd` does not move. That last fact is exactly why this cell has teeth — what B receives is a `umd`-silent cursor advance plus a new row, i.e. **ordinary merged data with no special marking whatsoever**.

### 2.2 The measurement on B (p2)

B pulled that state, went offline, and its clock was rolled to **2026-07-07** — the day C1's cursor used to point at.

| series on B at 07-07 (offline) | untrashed rows dated 07-07 | template after |
|---|---|---|
| **C1** (holds A's exception) | **0** | unchanged: `next=07-09 icStart=07-08 icCount=2` |
| **C4** (holds A's exception) | **0** | unchanged: `next=07-09 icStart=07-08 icCount=2` |
| C2 (untouched control) | **1** | `icCount 1→2`, `icStart 07-07→07-08`, `next 07-07→07-09` |
| C3 (untouched control) | **1** | same four fields, same four values |

> **Verdict — cell 1: device B spawns NOTHING on a slot another device already consumed.** The whole-series delta for C1 and C4 across the roll is *(no field changed on any surviving row)*. The two untouched controls on the very same clock roll spawn normally, so the silence is the merged exception's doing and not an artifact of the roll.

This is the benign answer, and it is benign for a mechanical reason worth stating plainly: **the peer does not need to understand "an exception happened".** It received a cursor and a watermark that are already past the slot, and its spawner's only question is whether the slot is behind the watermark. REPX3 §1.3's identity — `Make Exception` writes exactly what the clock spawn of that slot writes — is what makes an exception replicate correctly without a single line of exception-specific sync code.

Re-checked after the merge (p4) and at every later clock: C1 rows dated 07-07 = **0**, dated 07-12 = **1**, on both devices, permanently.

---

## 3. Cell 2 — SPAWN-FIRST: both devices claim the same slot, and the exception wins

The dangerous cell. B's clock reached the slot **before** the exception existed anywhere.

### 3.1 The two rows, minted independently

**B, offline at 2026-07-07** (p2) — the ordinary clock spawn:

```
INSERTED row DUf5vsFSiAnwVhWrdjDRiU
  startDate            = 2026-07-07                 <- the RULE's date
  creationDate         = 1783382400.0               <- exactly 2026-07-07 00:00 UTC (occurrence midnight)
  userModificationDate = NULL                       <- a clock spawn is UNSTAMPED at birth
  status = 0 ; start = 2 ; rt1_repeatingTemplate = 9QF5LHJ4QGbjXuhkVscxAB
CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-08
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-09
```

**A, at 2026-07-05** (p3) — `Make Exception`, projection 07-07 → `July 14, 2026`:

```
INSERTED row DUf5vsFSiAnwVhWrdjDRiU
  startDate            = 2026-07-14                 <- the CHOSEN day
  creationDate         = 1783252967.593844          <- the gesture wall-clock
  userModificationDate = 1783252967.597048
  status = 0 ; start = 2 ; rt1_repeatingTemplate = 9QF5LHJ4QGbjXuhkVscxAB
CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-08
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-09
```

> **`DUf5vsFSiAnwVhWrdjDRiU` on both sides.** Two devices that had not spoken minted the identical uuid for the same slot of the same template — and A's row wears that uuid while dated seven days away from the slot it came from. This is [SY-3b](sync3-dedupe-tiebreak.md)'s deterministic-uuid law and REPX3 §4.1's slot-derivation, now observed from the two ends at once. Note also that the **template deltas are byte-identical on both sides** (same four fields, same four values) — REPX3 §1.3 again — so the template row has literally nothing to merge.

### 3.2 The merge (p4), field by field

B rebooted (clean DHCP), was re-pinned to 07-07 **before** Things launched, and converged. Diffing B's offline state against B's post-merge state over the whole corpus:

```
CHANGED DUf5vsFS.startDate               : 2026-07-07 -> 2026-07-14
CHANGED DUf5vsFS.creationDate            : 1783382400.0 -> 1783252967.593844
CHANGED DUf5vsFS.todayIndexReferenceDate : 2026-07-07 -> 2026-07-14
CHANGED DUf5vsFS.userModificationDate    : None -> 1783252967.597048
(the C2 TEMPLATE row: no field changed — both devices had already written identical bytes)
untrashed C2 rows dated 07-07 = 0 ; dated 07-14 = 1
```

> **Verdict — cell 2: ONE row, and A's exception `startDate` survives.** Every contested attribute of the shared row took A's value. B's independently spawned rule-dated version is not kept beside it, not trashed, not ghosted — it is *overwritten*. Device A's own view (p5) needed no change at all to that row, and the cross-device compare after the merge reads **IDENTICAL on both devices (12 rows, 492 fields)**.

**What decided it — and what this says about the merge model.** Two candidate laws were separated by construction here, and both of the obvious ones are falsified:

| candidate | prediction | observed |
|---|---|---|
| last arriver wins | **B** wins (B rejoined in p4, after A's p3 push) | ✗ B lost |
| each scalar attribute → MAX (the SY-3b reading) | **B** wins `creationDate` (`1783382400.0` > `1783252967.59`) | ✗ `creationDate` went **down** |
| the side with the greater `userModificationDate` wins (NULL = never modified) | **A** wins everything (A `1783252967.597` vs B `NULL`) | ✓ |

So the honest refinement of the [SY-3b](sync3-dedupe-tiebreak.md) model is: **the per-attribute merge is arbitrated by `userModificationDate`, not by each attribute's own magnitude.** SY-3b measured "`creationDate` → MAX" on two rows that were *both* unstamped clock spawns (`umd` NULL on both sides), i.e. a tie in the primary key, where a secondary value comparison decides — which is exactly the case its three forced-order runs explored. Here the primary key is not tied, and `creationDate` moves *against* its maximum. One decisive observation, with arrival order eliminated as a confound; what it cannot separate is "greater `umd` wins" from "any stamped row supersedes an unstamped one", because only one side was ever stamped. Both readings say the same thing for the question this campaign was asked.

**Why that is the right outcome, not luck.** A clock spawn is a derived, unstamped materialization; an exception is a user edit that stamps `umd`. Arbitrating by `umd` means *the user's deliberate act beats the machine's derivation*, whichever device happens to be later or to reconnect last. That is the same design choice craft [§4a](../things-app-craft.md)/[§4b](../things-app-craft.md) records from the other direction.

---

## 4. Cell 3 — a rule re-anchor against a peer's stale-cursor spawn

Same interleaving, `Update Rule` instead of `Make Exception`. B (offline, p2) spawned C3's 07-07 occurrence `Ax6s8RS7AREoqUzM1eqb3u` (`creationDate 1783382400.0`, `umd` NULL). A then (p3) drove C3's projection 07-07 → `July 12, 2026` and pressed `Update Rule`:

```
CHANGED template.rt1_recurrenceRule            : sha256:46315b41130a7181 (627 B) -> sha256:b0e1b5b57c864ae1 (627 B)
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-12
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-12
CHANGED template.todayIndexReferenceDate       : 2026-07-07 -> 2026-07-12
CHANGED template.userModificationDate          : 1783252925.570764 -> 1783253016.411983
(no row minted; icCount unchanged at 1 on A)
```

After the merge, on **both** devices:

```
template  rule = sha256:b0e1b5b57c864ae1   next = icStart = 2026-07-12   icCount = 2   umd = 1783253016.411983
rows: the 07-05 instance · the template · Ax6s8RS7 dated 2026-07-07 (creationDate 1783382400.0, umd NULL)
```

Three readings:

- **A's re-anchor wins the template wholesale** — rule blob, both cursor columns, `todayIndexReferenceDate` and `umd` all take A's values on B. Consistent with §3.2: A's template write bumped `umd`, B's spawn left it silent.
- **`icCount` merges to 2** — A's write left it at 1, B's spawn raised it to 1→2, and the merged value is B's. The counter is the one field where the two devices genuinely disagreed *and* the arbitration did not follow the template's `umd`; it is a monotone tally, and both sides' claims are true. (On A this arrived as the campaign's only template-row change during p5's pull: `LVTmtbMc.rt1_instanceCreationCount: 1 -> 2`, alongside the insert of `Ax6s8RS7`.)
- **B's stale-phase occurrence SURVIVES the re-anchor, untouched.** Nothing re-dates, trashes or reconciles it, so the series now holds a live occurrence on 07-07 that its current rule never schedules and never will.

> **Verdict — cell 3: the re-anchor propagates completely and the peer's already-materialized occurrence is kept.** No duplicate and no ghost — but a re-anchor performed on one Mac does **not** retract an occurrence another Mac has already spawned under the old phase.

That last point is the honest cost rather than a defect: it is precisely the single-device law REPX3 §2.1 measured (a rule change never revisits materialized instances), and the alternative — deleting a row that exists on another device — would be data loss. It is worth naming because it is invisible from the device that performs the re-anchor: A never saw a 07-07 row until it pulled one.

---

## 5. Cell 5 — the oddities §17 double-book, across two devices

C4's exception was deliberately parked **on** a live rule slot: projection 07-07 → `July 9, 2026`, minting `5ydrEcVM3ALYMf1JDwriEF` dated 07-09 and leaving the cursor at 07-09 — the [§17](../things-app-oddities.md) setup, one gesture. Both devices then reached 07-09 (B in p6, A in p7).

| device | untrashed C4 rows dated 2026-07-09 | which |
|---|---|---|
| **B** at 07-09 | **2** | `5ydrEcVM` (A's exception, `creationDate 1783253039.39`) + `HuyqJ4kY` (the 07-09 slot spawn, `creationDate 1783555200.0` = 07-09 00:00 UTC) |
| **A** at 07-09 | **2** | the same two rows, same uuids, same values |

> **Verdict — cell 5: §17 replicates faithfully and does NOT compound.** The second device does not add a third copy: whichever device reaches the 07-09 slot first mints `HuyqJ4kY`, and the other device's spawner — having merged that device's cursor advance — never fires at all. The defect's severity is unchanged by sync.

The mechanism is cell 1's, one slot later. Device A's roll onto 07-09 (p7) produced **zero delta across all 615 fields**: it had already pulled B's 07-09 spawns, and its merged watermark was past the slot. The same held one slot earlier — A's roll onto 07-07 in p5 produced *(no field changed on any surviving row)*, i.e. A did not re-materialize the occurrence B had spawned there for C3 either.

For completeness, the ordinary-cadence controls on the same 07-09 roll: C1 spawned exactly one row (`FoAok9ws`), C2 exactly one (`PeUue4p7`), C3 none (its rule is re-anchored to 07-12), and every template moved to `icCount 3, icStart 07-10, next 07-11`.

---

## 6. Cell 4 — post-merge integrity, both directions

Every relaunch after the merge was measured, not assumed.

| check | result |
|---|---|
| B, two extra sync rounds at 07-09 (p6) | *(no field changed on any surviving row)* — 15 rows, 615 fields |
| A, two extra sync rounds at 07-09 (p7) | *(no field changed on any surviving row)* |
| A, a third relaunch (p7) | *(no field changed on any surviving row)* |
| B, a third relaunch (p8) | *(no field changed on any surviving row)* |
| **cross-device compare after the merge** (p5 A vs p4 B) | **IDENTICAL on both devices** — 12 rows, 492 fields |
| **cross-device compare, final** (p7 A vs p8 B) | **IDENTICAL on both devices** — 15 rows, 615 fields |
| crashes | `.ips` count 0 on both devices, every phase; app ALIVE throughout |

No ghost row, no resurrection of B's overwritten spawn, no second copy appearing on a later sweep, and no divergence between the devices in any column except the three device-local rank columns the compare deliberately ignores.

Final corpus (identical on A and B):

```
SYNCX1-C1  07-05 instance · template · 07-12 EXCEPTION · 07-09 spawn                  (07-07: none)
SYNCX1-C2  07-05 instance · template · 07-14 EXCEPTION · 07-09 spawn                  (07-07: none — B's spawn became the exception)
SYNCX1-C3  07-05 instance · template (re-anchored to 07-12) · 07-07 stale-phase spawn
SYNCX1-C4  07-05 instance · template · 07-09 EXCEPTION · 07-09 spawn                  (§17: two rows on 07-09)
```

---

## 7. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-craft.md](../things-app-craft.md) | **new 4d** — an exception replicates correctly across devices with no exception-specific sync code, because it writes exactly the bookkeeping a clock spawn writes and carries the slot's deterministic uuid; and the merge arbitrates by `userModificationDate`, so a user's deliberate edit beats another device's derived materialization |
| [things-app-oddities.md](../things-app-oddities.md) §17 | dated **cross-device addendum** — the double-book replicates identically on a second device and does NOT become a third copy |
| [capability-matrix.md](../capability-matrix.md) | the exception-move path's gap (e) "unmeasured … across sync" is **closed** for to-dos; the sync verdict and the `umd`-arbitrated merge are recorded |
| [reference/README.md](../reference/README.md) | new SYNCX1 probe-id row; the sync-behavior topic row gains this campaign |
| [up-next.md](../up-next.md) | the "exception's SYNC behavior" item is **deleted** (answered); the "decide whether to build the exception-move op" item carries the verdict — the decision itself stays the maintainer's |
| [sync3-dedupe-tiebreak.md](sync3-dedupe-tiebreak.md) SY-3b | its `creationDate → MAX` reading is **qualified, not contradicted** (recorded here, not by editing that immutable snapshot): both of SY-3b's rows were unstamped clock spawns, i.e. tied on `umd`; when the two sides' `umd` differ, `creationDate` follows the winning side and can move *down* |

## 8. Open cells this campaign did NOT close

1. **A repeating PROJECT's exception across sync.** Everything here is to-dos; the chooser on a project template is still blocked on the 3.23 project promote reveal (REPX2 §8 cell 1).
2. **`umd`-greater vs `umd`-stamped.** Only one side was ever stamped, so "the greater `userModificationDate` wins" and "any stamped row supersedes an unstamped one" are not separated. A cell that stamps BOTH sides at different times (e.g. an exception on A against a peer's spawn that was then edited on B) would isolate it — and would also test whether the arbitration is genuinely per-attribute or effectively whole-row for this record class, which this campaign could not tell apart because A won every attribute.
3. **A concurrent exception on BOTH devices.** Two `Make Exception` gestures on the same slot, on two disconnected devices, moving it to two different dates. Predicted by §3.2 to resolve to the later `umd`, unmeasured.
4. **Cross-ZONE.** Both clones ran UTC here, deliberately, so that `creationDate` differences came from the gesture-vs-midnight distinction rather than from zone offsets (SY-3's variable). A zone-split re-run would confirm §3.2's arbitration is zone-independent.
5. **A real APNs-woken receiver.** Every pull here was forced by a relaunch; the on-hardware push/pull cadence remains the standing SYNCLAT needs-hardware residual.

**Housekeeping note.** The 15 `SYNCX1-*` rows are left on the durable account, as SYNC2B's and SYNC3's fixtures were. The driver's `p1` purges every `SYNCX1-%` row (trash + empty trash) before building, so a re-run starts from a genuinely empty corpus on both the device and the cloud.
