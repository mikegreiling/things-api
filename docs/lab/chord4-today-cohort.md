# CHORD4 — the Today entry-cohort boundary, and the This Evening top edge

**Probed under: `things-lab-golden-v4` · Things 3.23 (32300036) · macOS 15.7.7 · guest clock pinned 2026-07-05 (trial wall 2026-07-18, never rolled) · AXVM1 direct grant, no helpers.** **Certified under `things-lab-golden-v4h`, same Things build, helpers 1.4.0 routed inside the guest (§7).** Disposable clones (`gscr-chord4-*`), destroyed on teardown. All fixtures synthetic, seeded through the shipped CLI's URL-scheme vector — never a direct SQLite write. Driver: [`lab/scripts/research-chord4.sh`](../../lab/scripts/research-chord4.sh).

```sh
export TART_HOME=/Volumes/Workspace/tart
bash lab/scripts/research-chord4.sh
```

This is the probe cell [CHORD3](chord3-todo-chord-op.md) §6 named as the gate on PR 2 — the `today` / `evening` chord columns. It is answered here before a line of the op was written.

---

## The question

The Today view's displayed order is **not** `todayIndex` order. `todayOrderBy` (`src/read/predicates.ts`, shared by the reader, the view and TODWIRE's minimal wire) sorts

```
startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC
```

so the entry **cohort** outranks the manual rank. The arrow chord moves a row one DISPLAYED slot and writes `todayIndex` ([CHORD2](chord2-reorder-laws.md) §4). So what happens when a ⌘↑ / ⌘↓ would carry a row past a row in a different cohort? Either the cohort is a hard partition (the app declines), or the app makes the position expressible by rewriting the cohort — the silent collapse TODWIRE's minimal wire exists to avoid.

## The answer, in one line

> **The cohort is not a partition and the app does not decline: a chord across an entry-cohort boundary RE-STAMPS the mover's `todayIndexReferenceDate` to the DESTINATION cohort's key — not to today — and does it with no beep and no `userModificationDate` stamp on any row.** The move is durable across an app relaunch, and the collapse is one-way: chording the row back does not restore the cohort it came from.

Outcome (ii) of the three the cell was written to distinguish, in its worst form: the crossing is invisible to the `umd` tripwire CHORD2 §6a gave the chord driver as its post-hoc backstop, so nothing downstream of the gesture can notice it. That makes the PR 2 pre-flight fence the only defence rather than a courtesy.

---

## §1 — The rig

Two cohorts, both reached through official surfaces. The NEWER cohort is two synthetic rows entered into Today on the clone's pinned day through `things todo add … --when today`; the OLDER cohorts are the golden's own baked Today set, whose entry dates predate the clone. (A first pass tried to seed the older cohort with `--when 2026-07-03`; **the URL scheme coerces a past `when` date to today** — the write verified-failed and all four rows landed in one cohort. Recorded as [oddities §](../things-app-oddities.md) material; the golden's own set is the working handle.)

The Today view as the clone renders it, in comparator order, with the cohort key made explicit:

| title | sb | startDate | tiRef | **cohort** | todayIndex | start |
|---|---|---|---|---|---|---|
| C4-N2 | 0 | 07-05 | 07-05 | **132805248 (07-05)** | -971 | 1 |
| C4-N1 | 0 | 07-05 | 07-05 | 132805248 | -604 | 1 |
| LAB-REPEAT-WEEKLY-PROJ | 0 | 07-05 | 07-05 | 132805248 | -257 | 2 |
| LAB-REPEAT-DAILY (QKbe) | 0 | 07-05 | 07-05 | 132805248 | -145 | 2 |
| LAB-PINNED-TODAY | 0 | 07-05 | 07-05 | 132805248 | 0 | 2 |
| *LAB-DEADLINE-ONLY* | 0 | *NULL* | 07-04 | **132805120 (07-04)** | 0 | 1 |
| LAB-REPEAT-DAILY (RAAM) | 0 | 07-04 | 07-04 | 132805120 | 0 | 2 |
| LAB-TODAY-1 | 0 | 07-03 | 07-03 | **132804992 (07-03)** | -619 | 1 |
| LAB-REPEAT-DAILY (11NN) | 0 | 07-03 | 07-03 | 132804992 | -396 | 2 |
| LAB-EVENING-1 (stale) | 1 | 07-03 | 07-03 | 132804992 | -229 | 1 |
| — *This Evening* — | | | | | | |
| C4-E2 (reminder 21:30) | 1 | 07-05 | 07-03 | 132804992 | -80 | 1 |
| C4-E1 (reminder 20:00) | 1 | 07-05 | 07-03 | 132804992 | 0 | 1 |

**`todayOrderBy` is confirmed as the app's own comparator, to the tiebreak.** The AX row census matches this table row for row, including the two places it is not obvious: `LAB-DEADLINE-ONLY` (a deadline-PULLED row: `startDate` NULL, so its cohort comes from `deadline`) sits above `LAB-REPEAT-DAILY (RAAM)` on an exact `todayIndex` tie, broken by `uuid ASC` — `EEFM…` before `RAAM…`; and the STALE evening row `LAB-EVENING-1` (bucket 1, day passed) renders in Today PROPER, above the `This Evening` header, exactly as the placement law says (STEV1).

Two rig facts worth carrying into the build:

* **The rendered Today section is a SUPERSET of the `today` reorder scope.** `LAB-DEADLINE-ONLY` is rendered, ranks on the same `todayIndex` axis, and is renumbered by a chord that steps over it (§3) — but `computeReorderPre`'s `today` membership requires `startDate IS NOT NULL`, so it is not a scope member. A ±1 chord counts DISPLAYED slots, so the driver's column must be what the view renders, not what the scope admits.
* **A freshly created This Evening row is stamped `tiRef` = 2026-07-03 while its `startDate` is 2026-07-05** — two days behind the clock, reproducibly, on both seeds. Unexplained; recorded as measured. It does not affect the design (every live evening row shares one cohort key, so the section orders on `todayIndex` alone), but it is a loose thread for anyone reasoning about what `todayIndexReferenceDate` means.

## §2 — The cell table

Run `gscr-chord4-97926` (2026-07-05 guest clock, 2026-09-07 wall). Every cell: one AX selection by uuid (the shipped `axSelectRowByIdScript`), ONE ⌘-arrow posted with `CGEventPostToPid` while Finder is frontmost, then a FULL 41-column diff over **every untrashed row in the database** — 39 rows, 1,599 fields compared — so a re-stamp on a bystander cannot escape it.

| # | cell | the chord | what the database did | verdict |
|---|---|---|---|---|
| 1 | **incohort** — the 2nd row of the view, up, inside the top cohort | ⌘↑ | `C4-N1.todayIndex: -604 → -1347`. Nothing else, on any row | **CHORD2 §4 reproduced.** Single-row rank write, `umd` silent, `tiRef` untouched |
| 2 | **topedge** — the 1st row of the whole view, up | ⌘↑ | *(no field changed on ANY untrashed row)* | **DECLINED**, + 1 alert beep. The only beep in the run |
| 3 | **s2chord** — a `start = 2` row pinned into Today, up, inside its cohort | ⌘↑ | `LAB-PINNED-TODAY.start: 2 → 1`, `.todayIndex: 0 → -201` | **A NEW side effect, and it is NOT the crossing's** (§4) |
| 4 | **xdown** — the LAST row of the top cohort, DOWN across the boundary | ⌘↓ | `LAB-DEADLINE-ONLY.todayIndex: 0 → -539`; `QKbe.start: 2 → 1`; **`QKbe.todayIndexReferenceDate: 132805248 (07-05) → 132805120 (07-04)`** | **THE GATE. Cohort RE-STAMPED to the destination.** No beep, **no `umd` on either row**. Durable across relaunch |
| 5 | **xup** — the same row, back UP across the boundary | ⌘↑ | `QKbe.todayIndex: -145 → -984`. `tiRef` NOT restored | **The collapse is ONE-WAY.** The row now lives in the older cohort permanently |
| 6 | **evein** — the 2nd live This Evening row, up, inside the section | ⌘↑ | `C4-E1.todayIndex: 0 → -176` | **THE PRIZE, at the primitive.** `reminderTime` untouched, `umd` silent |
| 7 | **evetop** — the 1st live This Evening row, up, at the section edge | ⌘↑ | `C4-E1.startBucket: 1 → 0`, `C4-E1.userModificationDate` stamped | **CHORD2 §4be2 confirmed on 3.23.** Silent de-evening; `reminderTime` survives it; durable |

Beeps across the whole run: **1**, attributed to `topedge`. Finder frontmost before and after every cell. Wall time per cell (select + one chord + settle): **3–4 s**.

## §3 — The crossing, in full

```
xdown  LAB-REPEAT-DAILY (QKbe1HaA), the last row of the 07-05 cohort, ⌘↓
       CHANGED EEFM2Tu6.todayIndex:               0 -> -539            <- the row it passed
       CHANGED QKbe1HaA.start:                    2 -> 1
       CHANGED QKbe1HaA.todayIndexReferenceDate:  132805248(2026-07-05) -> 132805120(2026-07-04)
       (rows in both: 39; fields compared: 1599)
       0 alert beeps
```

Three things are worth naming separately.

**(a) The re-stamp is to the DESTINATION cohort, not to today.** This is the opposite of TODWIRE's native wire, which re-stamps every named row's `tiRef` **forward** to today (which is how the native path expresses a cross-cohort move: it promotes the row into the newest cohort). The chord instead demotes the mover into the cohort it is moving toward. Both are cohort collapses; they collapse in opposite directions.

**(b) The mover's own `todayIndex` was not written.** The app satisfied the requested order by renumbering the SIBLING it passed instead — CHORD2 §2a's "the app picks whichever single write is cheapest", reproduced here on the day axis. So a driver that asserts "the mover's rank changed" would be wrong; the assertion has to be on the ORDER, which is what the shipped driver already does.

**(c) No `userModificationDate`, anywhere.** CHORD2 §6a's law — *a pure rank move is `umd`-silent; every measured crossing stamped it* — has an exception, and it is this one. A **container** crossing (§3a/§3e/§3f, and `evetop` above) stamps `umd`; a **cohort** crossing does not. The chord driver's `umd` tripwire therefore cannot see a cohort collapse after the fact, which is why PR 2 fences it BEFORE any chord is posted rather than catching it afterwards.

The mover's containment digest (`project|heading|area|start|startBucket`) *did* change here — but only because of the independent `start` rewrite in §4, which is not a property of crossings. A cohort crossing on a `start = 1` row would change nothing the driver's per-chord assertion inspects.

## §4 — The independent finding: a chord promotes a `start = 2` Today row

Cell 3 exists to isolate it, and it does:

```
s2chord  LAB-PINNED-TODAY (start = 2, startDate = today), ⌘↑ INSIDE its own cohort
         CHANGED Z3NGaTnM.start:      2 -> 1
         CHANGED Z3NGaTnM.todayIndex: 0 -> -201
```

No crossing, no cohort change, no beep, no `umd`. So **any** chord on a someday-stage row that has been pinned into Today rewrites `start` 2 → 1 — a scheduling-state change performed by a gesture that is otherwise a pure reorder, and one the app makes silently. `start` is part of the driver's containment digest, so PR 1's existing per-chord tripwire DOES catch it and stops the drive; the today/evening column has to decide deliberately whether such rows are members. Filed in [oddities](../things-app-oddities.md).

## §5 — What this settles for the build

1. **The `today` / `evening` chord op must fence cohort boundaries PRE-FLIGHT.** The app will happily perform the crossing, the damage is silent and one-way, and no post-hoc tripwire sees it. Ruling recorded in [design/decisions.md](../design/decisions.md) (2026-09-07).
2. **The This Evening top edge must be fenced pre-flight too** — `evetop` confirms §4be2 on this build. That one at least stamps `umd`, so the tripwire is a real backstop; the fence saves a real write rather than a beep.
3. **The driver's column for `today` is what the VIEW renders, not what the scope admits.** Deadline-pulled rows are rendered, share the rank axis, and are stepped over by the gesture.
4. **Within a cohort — and within This Evening — the chord is exactly the clean primitive PR 1 shipped**: one row's `todayIndex`, `umd` silent, `reminderTime` intact.
5. **`todayOrderBy` needs no correction.** It reproduces the app's rendered order to the `uuid` tiebreak, across three cohorts, a deadline-pulled row and a stale evening row.

## §6 — What this campaign does NOT establish

* **Cohorts inside This Evening.** Every live evening row in the fixture shared one cohort key, so the section ordered on `todayIndex` alone. Whether two live evening rows can carry different `tiRef` values — and therefore whether the evening column needs the cohort fence at all — is unmeasured. PR 2 fences both columns anyway, which is correct under either answer.
* **Why a fresh evening row is stamped `tiRef` two days behind the clock** (§1). Reproduced twice; unexplained.
* **Multi-slot crossings.** Every cell posted exactly one chord. Whether a run of chords across two cohort boundaries re-stamps twice is unmeasured (the fence makes it unreachable through the shipped op).
* **ORD-19** — whether a chord-set rank on a repeating template's projected row in an Upcoming day-block survives the next occurrence spawn. Still open; it needs a clock roll inside the trial wall, which this driver does not do.
* **Sync.** Airgapped clone. A `tiRef` re-stamp is an ordinary attribute change and SYNC2's 3-way merge should treat it as one, but nothing here measured it.

---

## §7 — The build, certified (2026-09-07)

The op shipped on the answer above. `today` and `evening` are chord columns now, and the migration is certified in the routed guest through the production CLI: run `gscr-chord2-39148` on **`things-lab-golden-v4h`** (helpers 1.4.0 installed, granted and routed inside the guest), **all 24 cells GREEN, 62 assertions, 0 alert beeps across 25 sentinel marks**, Finder frontmost before and after every drive.

```sh
export TART_HOME=/Volumes/Workspace/tart
npm run build
VM_NAME=gscr-chord2-N RC_DIST="$PWD/dist" GUEST_CELLS=lab/guest/stage5-cells-chord.sh \
  bash lab/scripts/stage5-rc-run.sh
```

### 7.1 — What the shape had to become

Three things the `index` columns did not need, each from §1–§5:

1. **The driver's oracle reads through `todayOrderBy`.** Ordering the column by its rank key would have mis-numbered the very first displayed slot, since the entry cohort outranks `todayIndex`.
2. **The column is the RENDERED section, not the reorder scope.** `columnPredicate("today", packedToday)` admits the deadline-pull arm and drops the live evening rows host-side (`todayPlacement`); the target order is built by splicing the movee block into that rendered list rather than by taking `wireList`, whose order is the raw rank and whose membership is the scope. A deadline-pulled row is never a movee — it is a slot the walk counts.
3. **A pre-flight cohort fence, asked one read BEFORE the drive** (`cohortFenceViolation`, called from `runChord`), so a refusal costs no reveal, no selection and no chord — and can still be served by the transport that expresses the move. Two conditions: every named row shares one entry cohort, and the target preserves the column's cohort sequence. The per-chord assertion now compares the cohort too, as the backstop behind it.

### 7.2 — The cell table

| # | cell | verdict |
|---|---|---|
| 12 | **seed** — four `--when today` rows and two `--when evening --reminder` rows, on a clone whose baked Today list already spans **3 entry cohorts** | **PASS.** The fence has a real boundary to fence |
| 13a | **cross-cohort, bounce OFF** — lift a row from an older group to the top of Today | **PASS (exit 4, `blocked:H-REORDER-SCOPE`), 162 ms.** *"the requested position would move "LAB-REPEAT-DAILY" into a different Today entry group … Reschedule the item (`things todo update <ref> --when today`) to move it into today's group first"*. Order unchanged, **no row re-dated**, zero chords |
| 13c | **`--in today --end` on a multi-cohort list** | **PASS (exit 4), 156 ms.** The same refusal, and worth its own cell: "the bottom of Today" is *below rows that entered earlier*, so it is a cross-group position by construction |
| 14a | **move up inside the group** — `reorder <T1> --in today --start` | **PASS.** Three slots in 3.9 s, order exact, audit `vector=ui result=ok`, **Finder frontmost before AND after** |
| 14b | **an anchored placement** — `--in today --after <T3>` | **PASS.** 2.7 s, T1 lands immediately after T3, `vector=ui` |
| 14 | **the cohort + `umd` tripwires** — every day-axis row's entry cohort and every fixture row's modification date, across both moves | **PASS.** Byte-identical. The chord re-dates nothing and stamps nothing |
| 15 | **the This Evening TOP edge** — `reorder <evening row> --in today --start` | **PASS (exit 4, blocked).** *"--in today but the items are in the evening bucket — they are not Today members"*. Neither section moved. The edge is fenced by the scope's own membership (O03), before a vector is chosen; the ±1 walk cannot reach it either, and the containment tripwire is the third layer |
| 16a | **an evening reorder on the chord** — `--in evening --start` on a reminder-carrying row | **PASS.** 6.9 s, order exact, `vector=ui`, **`reminderTime` byte-identical on both evening rows** |
| 16b | **the R07 contrast** — the same move with the vector off | **MEASURED, and it says NO. §7.3** |
| 17 | **the day-axis fallback** — `ui-enabled false`, same request | **PASS.** 0.24 s, order exact, audit `vector=url-scheme` |
| 18 | **undo** — a Today chord reorder, then `undo --txn <its token>` | **PASS.** 2.7 s each way; the undo restored the exact prior Today order |
| 19 | **the cross-cohort request FALLS BACK** — bounce on | **PASS.** Exit 0 in 0.25 s, audit `vector=url-scheme`, and the result carries both the chord-unavailable note (*"the keyboard-shortcut reorder could not run here (…), so the order was set with the schedule round-trip instead"*) and the bounce's own re-dating warning (*"1 row(s) whose day had already passed are now dated today"*) |

Cells 0–11 (PR 1's `index` columns) re-ran GREEN in the same arm.

### 7.3 — R07 did not reproduce, and the CHANGELOG claim was withdrawn

This migration was expected to retire a data-loss side effect: `bounceSpecOf("evening")` carries the caveat *"when=evening CLEARS reminderTime for BOTH kinds (§9n / R07)"*, so the evening bounce was supposed to come back with the alarm gone. Cell 16b is the direct comparison — the same row, the same request, the chord vector switched off:

```
reminders after the chord:  EV1=1342177280  EV2=1440743424
reminders after the BOUNCE: EV1=1342177280  EV2=1440743424
*** R07 DID NOT REPRODUCE: the evening bounce PRESERVED the moved row's reminder ***
```

One clean data point on Things 3.23 / golden-v4h. It does not overturn R07 — that verdict was taken on an earlier build and this cell was not designed as its re-probe — but it does mean the "removes a data-loss side effect" line was struck from the CHANGELOG before it shipped, and the capability matrix now says the caveat is unconfirmed here. Re-probing R07 on 3.23 (and correcting the `reorder.ts` comment if it has lapsed) is filed in up-next.

### 7.4 — Latency in the clone

| move | wall |
|---|---|
| a cross-cohort request, refused pre-flight | **0.16 s** (no reveal, no selection, no chord) |
| three slots up, Today | **3.9 s** |
| an anchored placement, Today | **2.7 s** |
| one slot inside This Evening | **6.9 s** |
| the fallback bounce, same request | **0.24 s** |
| undo (a cohort block restored) | **2.7 s** |

Same shape as CHORD3 §4: the cost is the SELECT WALK, not the chords. The evening move is the slowest because its row sits near the bottom of a twelve-row table and the walk probes in table order. Clone numbers on an idle app — real-hardware latency is the maintainer's own measurement.

### 7.4b — The direct arm

`npm run lab:run -- --suite lab/suites/o-suite.json` on a fresh golden-v4 clone (`things-run-o-20260907-224948`, 2026-09-07): **GREEN, O01–O39, 0 alert beeps across 115 sentinel marks.** The ordering suite's verdicts are unchanged by this build, which is the expected result and the point of running it — the chord is a new vector for the operation, not a change to the wire protocols the suite locks.

### 7.5 — What the build did NOT change

* **The undo inverse is scoped to ONE cohort.** `undo` reconstructs a previous order by sorting the captured ranks ascending, and on the day axis the rank is not the displayed order. So the ordering delta captures the movees' own entry-cohort BLOCK — the region where `todayIndex` ascending *is* the displayed order, and which the pre-flight fence guarantees the move never left. That gives the day axis the same single-row-undo fix the `index` columns got in PR 1, over the only region where the inverse is well defined.
* **`--in today --end` on a multi-cohort list is a refusal, not a bug** (cell 13c). The caller who means it can have it through `--strategy bounce`, which expresses it the only way the app does: by re-dating.
* **The `today` scope's membership is unchanged.** A deadline-pulled row is a slot the chord counts, never a row it will move; naming one is still refused by `computeReorderPre`.
