# CHORD2 — the full law matrix for the ⌘-arrow reorder chords

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`chord2-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-chord2.sh`](../../lab/scripts/research-chord2.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chord2.sh setup   # clone + boot + airgap + clock pin + CLI + AX kit
                                                          … bg        # cell 1 — the backgrounded end-to-end gate
                                                          … multi     # cell 2 — multi-selection, first pass
                                                          … multi2    # cell 2b — the arms the first pass invalidated
                                                          … multi3    # cell 2c — the clean-flags re-run
                                                          … bounds    # cell 3 — the boundary laws per row kind
                                                          … views     # cell 4 — the per-view column map
                                                          … views2/3/4 # cell 4b/4c/4d — the views the first pass missed
                                                          … tmpl2     # cell 5 — the repeating templates
                                                          … side      # cell 6 — the side-effect sweep
                                                          … extra     # cell 7 — the true template row
                                                          … arch      # cell 7a' — the archived heading
                                                          … teardown
```

**PROBE ONLY — no operation was shipped from this campaign.** The deliverable is this evidence plus the recommendation in §8.

---

## The answers, in one table

| Cell | Question | Verdict |
|---|---|---|
| **1** | does the WHOLE gesture work with Things backgrounded, at tier 0? | **YES, both halves, heading AND to-do.** AX selection + `CGEventPostToPid` chord, Finder frontmost throughout, **zero monitor events**, zero beeps. |
| **2** | multi-selection semantics | **The block moves as a unit, internal order preserved — and the app NEVER rewrites a selected row.** Non-contiguous selections **COALESCE**. A selection mixing a heading with a to-do is **DECLINED**. |
| **3** | boundary laws per row kind | **Two membership crossings and three clean declines.** A headed child at the top of the FIRST heading is **DEPORTED to the project root**; a loose row at the bottom of the loose block is **ADOPTED by the first heading**. ⌘⌥ is bucket-scoped, and crosses only when the bucket edge leaves it nowhere to go. |
| **4** | which column per view, and view-scoped side effects | **`index` for project / Inbox / Someday / Anytime; `todayIndex` for Today / Evening / Upcoming.** The Upcoming day-group **REORDERS and does NOT reschedule** — no `startDate` delta, and the group edge declines rather than crossing days. **The chord is VIEW-relative: under a tag filter it moves against the DISPLAYED neighbour, not the true sibling.** The Logbook declines. |
| **5** | the repeating templates | **A SPLIT, and it reopens one declared impossibility.** In a project list the template row is **IMMOVABLE** (§9e holds — declined, both chords). In an Upcoming day-group the SAME template row **MOVES on `todayIndex`**, with its uuid verified from the selection — **ORD-19 reopens**. |
| **6** | side effects | **A pure rank move is `umd`-SILENT; a membership change STAMPS `umd`.** Checklists byte-identical. The decline beep is **exactly 1:1** (7 wasted chords → 7 beeps). |
| **7a′** | (asked by the #606 build track) does an ARCHIVED heading render as a row? | **NO — it leaves the rendered row list entirely, takes no ordinal in the shipped positional walk, and the chord's ±1 SKIPS its slot.** The #606 fence can be lifted. |
| **7b** | the TRUE template row (not its occurrence) in a project list | **Declined on ⌘↑ and ⌘⌥↑**, identity verified as the rule row. |

---

## §1 — Cell 1: the backgrounded end-to-end gate

This is the cell that gates the build track, so it ran first and alone. The shape under test is the whole gesture, not a fragment: reveal with `open -g` (never `activate`), put **Finder** frontmost, set the selection with the **shipped** AX primitive, deliver the chord with `CGEventPostToPid`, and assert **both** that the rank delta landed and that the guest's disruption monitor saw nothing.

The monitor is the golden's own `disruption-monitor` LaunchAgent (`~/things-lab/events.ndjson`, the same stream `lab:run` computes tiers from). Each half of each arm is bracketed by a line-count mark and the slice read back.

### 1A — a HEADING

```
frontmost before anything: [Finder]
START headings: BH1 < BH2 < BH3 < BH4 < BH5
select-heading-row(ordinal 2) -> [OK]
frontmost after the SELECT: [Finder]
AX selection readback: selected row ordinals of 42: [11,33]
monitor slice (0 event(s)) for the SELECTION half:
DISRUPTION: tier 0 — NO focus steal, NO new window  *** CLEAN ***
chord: POSTED-TO-PID 828 code=126 flags=1048576 x1
frontmost after the CHORD: [Finder]
monitor slice (0 event(s)) for the CHORD half:
DISRUPTION: tier 0 — NO focus steal, NO new window  *** CLEAN ***
*** 1A HEADING: DELTA LANDED BACKGROUNDED — BH1<BH2<BH3<BH4<BH5 ==> BH1<BH3<BH2<BH4<BH5 ***

title  uuid8     idx
BH1    JcpGTN7B  -604
BH3    531HeFzK  -512   <- the only row rewritten
BH2    PaMLA4vX  -350
BH4    ES6NKuXc  -126
BH5    MtcKS2gy  0
```

### 1B/1C — a TO-DO

```
select-row(BT3) -> [OK]        frontmost after the SELECT: [Finder]
Things selection readback: [BT3]
monitor slice (0 event(s))  -> tier 0 CLEAN
*** 1B TO-DO: DELTA LANDED BACKGROUNDED — BT1<BT2<BT3<BT4<BT5 ==> BT1<BT3<BT2<BT4<BT5 ***

1C ⌘⌥↓ backgrounded:  BT1<BT3<BT2<BT4<BT5  ==>  BT1<BT2<BT4<BT5<BT3
   frontmost: [Finder]   monitor slice (0 event(s)) -> tier 0 CLEAN
1D control: frontmost [Finder], Things ALIVE
cell 1 beeps: 0 (6 marks)
```

> **The gate law.** With Things revealed by `open -g` and never activated, the shipped AX row/heading selectors set the selection and a `CGEventPostToPid` chord lands the rank write, for **both** headings and to-dos and for **both** the ±1 and the to-top/bottom families. The guest's frontmost application is `Finder` before the select, after the select and after the chord, and the disruption monitor records **zero events** across every half of every arm — not a launch, not an activation, not a window. Measured on `things-lab-golden-v4` / Things 3.23 (32300036), cells 1A–1D, 6 sentinel marks, 0 beeps.

Neither half failed. This independently reproduces the [CHORDMH1](chordmh1-move-heading-build.md) delivery-gate result on a second clone and extends it to the to-do row kind and to the ⌘⌥ family.

---

## §2 — Cell 2: multi-selection semantics

### 2.1 The rig defect this cell found first (and the app behaviour underneath it)

The first pass built its selections with plain/shift/cmd `CGEvent` clicks at the row's AX frame ([REPX1](repx1-instance-semantics.md) §1.2) and produced selections nobody asked for: "click V2, cmd-click V5" read back as the **contiguous** `V2,V3,V4,V5`. Cause, measured in cell 2b0: **a synthesized `CGEvent` inherits the CURRENT global modifier state unless the flags are set explicitly**, and the clicker only called `CGEventSetFlags` when a modifier was requested. So every "plain" click after a shift-click was still a shift-click:

```
2b0 (contaminated build)
  click N2 · shift-click N4        -> [N2, N3, N4]          (as intended)
  "plain"-click N3 (inside the block) -> [N2, N3]           (a shift-extend to N3)
  "plain"-click N6                 -> [N2, N3, N4, N5, N6]  (a shift-extend to N6)

2c0 (fixed build — CGEventSetFlags called on EVERY event, zero included)
  click G2 · shift-click G4        -> [G2, G3, G4]
  plain-click G6                   -> [G6]        <- collapses, as a plain click must
  plain-click G3                   -> [G3]
```

The fix is one line and is now in the driver's `ship_clickrow`; it is worth lifting into any future clicker. **Any campaign that mixes modified and unmodified synthetic clicks in one process has this bug until it sets flags explicitly** — and it fails in the most expensive way, by producing a plausible-looking selection that is not the one the cell is about.

A second, smaller rig lesson: the clicker returned as soon as it found a *row* mentioning the needle, so a `want` element carried only by a later row was unreachable. It now keeps scanning. That is what made cell 7b (the true template row) possible.

### 2.2 The law — the app never rewrites a SELECTED row

Every arm below reports the selection Things itself read back before the chord.

**(a) A contiguous block, ±1.** `V1<V2<V3<V4<V5<V6`, selection `V2,V3,V4`:

```
2a   ⌘↑  ==>  V2 < V3 < V4 < V1 < V5 < V6
     CHANGED UoeYFZkS(V1).index: -636 -> -74        <- ONE row, and it is NOT in the block
2a2  ⌘↓  ==>  V1 < V2 < V3 < V4 < V5 < V6
     CHANGED UoeYFZkS(V1).index: -74 -> -1035       <- ONE row, again the displaced sibling
```

The block moves as a unit, its internal order is preserved, and the write is **one row — the unselected neighbour the block passed over**.

**(b) A non-contiguous selection COALESCES.** `G1…G6`, selection `{G2, G5}` (verified `[G2-224652, G5-224652]`, AX row ordinals `[4,7]`), one ⌘↑:

```
before                        after
  G1  -390                      G2  -215     <- selected, index UNTOUCHED
  G2  -215   selected           G5   -19     <- selected, index UNTOUCHED
  G3   -79                      G1   625
  G4   -51                      G3  1007
  G5   -19   selected           G4  1665
  G6     0                      G6  2093

CHANGED RZt2RsdY(G1).index: -390 -> 625
CHANGED 4NW6emQG(G3).index:  -79 -> 1007
CHANGED Meh8TXvR(G4).index:  -51 -> 1665
CHANGED RArEKMu2(G6).index:    0 -> 2093
```

> **THE MULTI-SELECTION ANCHOR LAW, verbatim.** A chord on a multi-selection moves the selected rows as ONE BLOCK to the slot one step beyond the block's leading edge (⌘↑: one above the topmost selected row; ⌘↓: one below the bottommost), preserving the selection's internal relative order. A **non-contiguous** selection is **COALESCED** into a contiguous block at that anchor. The app **never rewrites a selected row's rank**: it renumbers exactly the UNSELECTED rows it has to displace, and they keep their own relative order. For a ±1 move of a contiguous block that is **one** row; for a coalescing move or a ⌘⌥ endpoint move it is every unselected row between the block and its destination. Measured on `things-lab-golden-v4` / Things 3.23 (32300036), cells 2a/2a2/2b1/2c1/2b3/2b4, full 41-column row diffs, selection read back from `Things3 → name of selected to dos` on every arm.

**(c) A MIXED heading + to-do selection is DECLINED.** Confirmed twice, on two fixtures, in both directions. The heading is selected with the shipped positional primitive and the child added by cmd-click; the AX row ordinals confirm both rows are selected while `name of selected to dos` (which excludes headings) shows only the child:

```
2c3  select heading ordinal 1 (GH2) -> OK   AX: selected row ordinals [7,24]
     cmd-click GH2-c1                       AX: selected row ordinals [7,8,24]
     Things selected to dos: [GH2-224652-c1]
     ⌘↑  ->  (no field changed on any surviving row)   + 1 beep
2c4  the same selection, ⌘↓
         ->  (no field changed on any surviving row)   + 1 beep
```

Heading order, child order and every heading FK are byte-identical across both. **A mixed-kind selection is refused wholesale, not partially applied** — the safest possible answer, and it means a shipped op need only detect the mix, never unwind a half-move.

**(d) ⌘⌥ on a multi-selection moves the block to the end.** Same law, more displaced rows:

```
2b3  block {N6,N1} (contiguous, mid-list), ⌘⌥↑
     N2<N4<N3<N6<N1<N5  ==>  N6<N1<N2<N4<N3<N5
     4 rows rewritten — every unselected row; the block untouched
2b4  block {N6,N1,N2} (at the top), ⌘⌥↓
     N6<N1<N2<N4<N3<N5  ==>  N4<N3<N5<N6<N1<N2
     3 rows rewritten — every unselected row; the block untouched
2b5  the same 3-block at the BOTTOM, ⌘↑ x4
     ==> back to the top; 3 rows rewritten; 1 beep (the 4th chord, nowhere left to go)
```

**(e) Two headings cannot be multi-selected by cmd-click.** A cmd-click on a second heading row's `Heading More Template` element left the AX selection unchanged (`[7,24]` before and after), and the chord that followed declined with a beep. Recorded as a negative, not a law: only one addressing shape was tried.

---

## §3 — Cell 3: the boundary laws per row kind

Fixture: two loose to-dos `DL1, DL2`, then headings `DH1`(2 children) and `DH2`(2 children). Full 41-column diffs on every arm.

### 3a — a headed child at the top of the FIRST heading is DEPORTED to the project root

There is no heading above the first one, so the row leaves the heading system entirely:

```
CHANGED TjrRSwJo(DH1-c1).heading: UyZ6uyCe… -> None
CHANGED TjrRSwJo(DH1-c1).project: None -> 2k7nSjNE…      <- now a loose project row
CHANGED TjrRSwJo(DH1-c1).userModificationDate: …712.355729 -> …750.922258
CHANGED GpmyG7Yq(DL2).index: 0 -> -619                   <- one loose sibling renumbered
CHANGED UyZ6uyCe(DH1).openUntrashedLeafActionsCount: 2 -> 1

kind  title          idx   proj      head
todo  DL1           -624   2k7nSjNE  -
todo  DL2           -619   2k7nSjNE  -
todo  DH1-c1        -614   2k7nSjNE  -      <- landed at the BOTTOM of the loose block
HEAD  DH1           -467   2k7nSjNE  -
HEAD  DH2              0   2k7nSjNE  -
```

**No beep.** The app treats this as a valid move, exactly as a drag to that position would be.

### 3f — and the inverse: a loose row at the bottom of the loose block is ADOPTED

```
CHANGED TjrRSwJo.heading: None -> UyZ6uyCe…     <- into the FIRST heading
CHANGED TjrRSwJo.project: 2k7nSjNE… -> None
CHANGED TjrRSwJo.userModificationDate: …750.922258 -> …786.495805
```

**No beep.** So the loose block and the first heading's bucket are adjacent and permeable in both directions, and the gesture that crosses them is indistinguishable from an ordinary ±1.

### 3b/3c/3g — the three clean declines

```
3b  the ABSOLUTE TOP loose row, ⌘↑     -> (no field changed on any surviving row)  + 1 beep
3c  the ABSOLUTE BOTTOM row, ⌘↓        -> (no field changed on any surviving row)  + 1 beep
3g  the TOP heading, ⌘↑ (the control)  -> (no field changed on any surviving row)  + 1 beep
```

The HEADORD1 heading-decline law reproduces exactly, and the project's absolute top and bottom decline the same way for to-dos.

### 3d/3e — ⌘⌥ on a headed child is BUCKET-scoped, and crosses only at the bucket edge

```
3d  ⌘⌥↑ on the LAST child of the SECOND heading (DH2 holds two children)
    CHANGED 9cRnoRBe.index: 0 -> -1037
    DH2 kids: DH2-c2 < DH2-c1        <- to the TOP OF ITS BUCKET, not of the project
    heading FK unchanged; DH1 and the loose block untouched

3e  ⌘⌥↓ on the ONLY child of the FIRST heading (nowhere to go inside the bucket)
    CHANGED UKNv7MES.heading: UyZ6uyCe…(DH1) -> Fi5KHSPp…(DH2)
    CHANGED UKNv7MES.userModificationDate: …712.355946 -> …779.903347
    DH1 kids: (none)     DH2 kids: DH2-c2 < DH2-c1 < DH1-c2
```

> **The boundary law.** For a headed child, ⌘⌥↑/⌘⌥↓ address the child's OWN heading bucket — the row goes to the top/bottom of that bucket and its heading FK is untouched. Only when the row is ALREADY at that end does the chord cross, landing at the far end of the adjacent bucket with a heading-FK rewrite; at the first heading's top edge the crossing target is the project root instead (heading FK cleared, project FK set). **No crossing beeps** — the beep marks a chord the app declined, never a membership change it performed.

That last clause is the production-critical one: **the beep cannot be used to detect a membership change.** The `umd` stamp can (§6).

---

## §4 — Cell 4: the per-view column map, and the view-scoped side effects

Every arm reveals the view, selects one row (readback printed), fires one chord, and diffs all 41 columns.

| view | reveal | rank column written | other columns touched | notes |
|---|---|---|---|---|
| **project list** | `show?id=<project>` | **`index`** | none | `LPv5iyQE.index: -128 -> -447` |
| **Inbox** | `show?id=inbox` | **`index`** | none | `QadpF3Hv.index: 0 -> -445` |
| **Someday** | `show?id=someday` | **`index`** | none | `Jkv3nqcn.index: -88 -> -340`; `start=2` preserved |
| **Anytime** (area-direct rows) | `show?id=anytime&filter=<tag>` | **`index`** | none | `N2Tm9rP7.index: -70 -> -215`; 0 beeps |
| **Today** (daytime) | `show?id=today` | **`todayIndex`** | none — `index`, `startDate`, `todayIndexReferenceDate`, `start` all unchanged | `LPAjqAPu.todayIndex: -138 -> -373` |
| **Today ▸ This Evening** | `show?id=today&filter=<tag>` | **`todayIndex`** | none — **`startBucket` stays 1** | `28mf61TX.todayIndex: -22 -> -57` |
| **Upcoming, inside a day-group** | `show?id=upcoming` | **`todayIndex`** | **none — NO `startDate` delta** | `BA9add5B.todayIndex: -104 -> -445` |
| **Logbook** | `show?id=logbook` | **nothing** | none | declined, + 1 beep — read-only |

### 4e2 — the Upcoming question, answered loudly: REORDER, never RESCHEDULE

The brief flagged a `startDate` delta as a scheduling side effect to report loudly. There is none, and the group edge is fenced:

```
4e2  the day-group's FIRST row by todayIndex, ⌘↑ x3
     (no field changed on any surviving row)
     (rows in both: 4; fields compared: 164)
     3 alert beeps, all attributed to `cell4e2 upcoming group edge`
```

> **The Upcoming law.** Inside an Upcoming day-group the chord re-ranks on **`todayIndex` only**. `startDate` is not written, no other row's date moves, and a chord at the group's leading edge is **DECLINED with a beep** rather than carrying the row into the neighbouring day. The day-group is a closed ordering scope: the chord cannot reschedule.

### 4be2 — the ONE view-scoped membership side effect: the Evening/daytime section boundary

The Today view's two sections are the exception. A row at the **top of This Evening**, driven ⌘↑, crosses into the daytime section:

```
4be2  the evening group's first row, ⌘↑ x2
      CHANGED GE5wAw5y.startBucket: 1 -> 0        <- OUT of This Evening
      CHANGED GE5wAw5y.todayIndex: -90 -> -272
      CHANGED GE5wAw5y.userModificationDate: …180.778549 -> …222.051719
```

Same shape as §3's heading crossings — a section-membership change performed silently, with no beep, by a gesture that is otherwise a pure reorder. Within the section (4cb) `startBucket` is preserved on all four rows.

### 4bf — the chord is VIEW-relative

A genuinely tag-filtered project view (`T1,T3,T5` tagged; `T2,T4` hidden; the AX census confirms three content rows, not five). `T3`'s **displayed** predecessor is `T1`; its **true** sibling is the hidden `T2`:

```
unfiltered order BEFORE: T1 < T2 < T3 < T4 < T5
select T3 (readback [T3-225806]) · ⌘↑
unfiltered order AFTER:  T3 < T1 < T2 < T4 < T5
CHANGED JBZQ2DuD(T3).index: -209 -> -1169
```

> **The filtered-view law.** The chord re-ranks against the rows the view is DISPLAYING, not against the container's true sibling list. In a filtered view a single ±1 therefore jumps over every hidden row between the mover and its displayed neighbour — here one ±1 crossed two true slots. Correct for a human (what you see is what moves); a trap for automation, which must either control the view's filter state or compute its move count from the displayed set.

---

## §5 — Cell 5: the repeating templates, and the one impossibility that reopens

`add-repeating` leaves **two** rows in the project sharing a title: the visible current **occurrence** (plain row, `startDate` set) and the **template**/rule row (`rt1_recurrenceRule` set, `start=2`). Both render. The first pass clicked the first row bearing the title and so measured the occurrence — the selection-id readback caught it:

```
selected ids: [ApKKg7LvGf4EosJXk7mwPT]   (template is 5LrCkxV61Te8nZoQDWuDeE)
```

The rule row is distinguishable in the AX tree by its repeat-day badge (`d:Mon`), which the occurrence row lacks. Every arm below prints `Things3 → id of selected to dos` and compares it to the uuid from SQLite before the chord is fired.

### 5c/7b — in a PROJECT LIST the template row is IMMOVABLE (§9e holds)

```
7b   click the row carrying the repeat-day badge -> selected ids: [PcDH1bEg4SCrYESh5dDSK7]
     *** the TEMPLATE (rule) row is selected ***
     ⌘↑   -> (no field changed on any surviving row)   + 1 beep
7b2  ⌘⌥↑ -> (no field changed on any surviving row)   + 1 beep
```

The template sat LAST in a five-row project, so ⌘↑ had four rows to move through; it declined anyway. The refusal is a property of the row KIND, not of its position. Meanwhile the same project's **occurrence** row moved normally (5c: `ApKKg7Lv.index: -79 -> -210`; 5c2 ⌘⌥↓ renumbered the sibling `AfAkxTSt.index: -151 -> -225`).

### 5d — in an UPCOMING DAY-GROUP the same kind of row MOVES, with a verified identity

The golden's `LAB-REPEAT-DAILY` (`W3PZB9e7W6BEtKmEKP4deG`, `start=2`, `startDate` NULL, `rt1_nextInstanceStartDate=132805376` = 2026-07-06) projects onto the Tomorrow day-block. On 3.23 that projected row carries its title as an `AXDescription` and selects with the template's own uuid:

```
click the LAB-REPEAT-DAILY row: CLICKED(no-mod) TITLE … [row 13 of 74]
selected names: [LAB-REPEAT-DAILY]
selected ids:   [W3PZB9e7W6BEtKmEKP4deG]
*** IDENTITY VERIFIED — the projection selects as the TEMPLATE uuid ***
⌘↑   ->  CHANGED W3PZB9e7.todayIndex: 2824 -> 2032
⌘↓   ->  CHANGED 4CuMPDWi.todayIndex: 2193 -> 1916     (the passed sibling; same net move, other direction)
```

The whole-table diff (192 rows × 41 columns) shows **exactly one column on one row** changing per chord. `rt1_nextInstanceStartDate`, `rt1_recurrenceRule`, `startDate`, `start` and `index` are all untouched — the series is not re-anchored, re-dated or disturbed; only its rank inside the day-block moves.

And plain rows reorder freely around it — a plain row driven up through the block crossed a template projection without rewriting it:

```
5e  the day-group's last plain row, ⌘↑ x6
    CHANGED RsQREKWw(Q2).todayIndex: 1814 -> -964     (one row; 1 beep = the 6th, wasted, chord)

the day-group after, by todayIndex
  Q2                -964   plain
  KQ1               -426   plain
  KQ2                  0   plain
  PT-230855          399   TEMPLATE     <- crossed, never rewritten
  Q3                 758   plain
  Q1                1208   plain
  LAB-REPEAT-DAILY  2032   TEMPLATE
```

> **The template law.** A repeating template's rank is reachable on the **`todayIndex`** axis and unreachable on the **`index`** axis. In a project list the rule row declines every chord (§9e's URL-inertness extends to the GUI chord). In an Upcoming day-group the same rule row is an ordinary participant: it is addressable (title in the AX tree), **verifiable** (the selection reads back the template's uuid), and **movable** (`todayIndex` rewritten, one row, one column, no re-anchoring), and plain rows re-rank across it freely.

**This reopens ORD-19.** [ORDFIN1](ordfin1-ordering-endgame.md) §1c/1d declared within-day reorder of a projected template infeasible on two independent grounds — no verifiable AX row identity, and §9e drag-inertness. On 3.23 the first ground is **gone** (title present, uuid confirmed through the selection), and the second is **bypassed**, because the chord is a keyboard gesture and not a drag. See §8.

---

## §6 — Cell 6: the side-effect sweep

### 6a/6b — `umd` and child integrity

```
6a  ⌘↑ on a plain to-do
    CHANGED PnUDfiYY.index: -320 -> -1133
    (that is the ENTIRE delta — 4 rows, 164 fields compared)

6b  ⌘⌥↓ on a to-do carrying notes + a 3-item checklist (already last: a decline)
    checklist before: [ck-a:-385 ck-b:-132 ck-c:0]
    checklist after:  [ck-a:-385 ck-b:-132 ck-c:0]
    (no field changed on any surviving row)
```

> **The `umd` discriminator.** A pure rank move writes the rank column and **nothing else** — `userModificationDate` is NOT stamped (cells 6a, 4a–4e, 5d/5e, 7a′; HEADORD1 measured the same for headings). Every arm in this campaign that DID stamp `umd` was a **membership change**: the §3a deportation, the §3e bucket crossing, the §3f adoption, the §4be2 evening→daytime crossing. So `umd` is a reliable post-drive oracle for "did this chord silently reparent the row?" — which matters precisely because the beep is not (§3).

Checklist rows, notes and every child index are byte-identical across chords.

### 6c/6d/6e — the beep is exactly 1:1

```
6c  a 4-row project, bottom row selected, 10 × ⌘↑ in ONE round trip
    before: E3 < E1 < E4 < E2        after: E2 < E3 < E1 < E4
    3 productive chords, 7 with nowhere to go
    BEEP-SENTINEL: 7 alert beep(s), all attributed to `cell6c burst`

6d  ⌘⌥↑ on a row already at the top -> zero delta, exactly 1 beep
6e  the chord with NO content row selected (the project selected in the sidebar)
    -> zero delta, exactly 1 beep
```

> **The decline law.** A chord the app cannot act on produces **exactly one alert beep and zero database delta** — for ±1 and ⌘⌥ alike, for a row at a boundary, for a multi-selection already at its destination, for a mixed-kind selection, for a repeating template row in a project list, in the Logbook, and with nothing selected at all. Validated 1:1 at scale: 7 wasted chords in a 10-chord burst produced exactly 7 beeps and 3 clean moves. The converse does **not** hold — a chord that performs a membership change is silent.

---

## §7 — Cell 7a′: the archived heading (asked by the #606 build track)

`project.move-heading` currently refuses in any project holding a completed/canceled heading, because its row addressing is positional and *"whether Things renders a COMPLETED/CANCELED heading in the project view is not measured"* ([src/write/pre-state.ts](../../src/write/pre-state.ts)). It is measured now.

Fixture: four headings, two children each; `BH2` archived through the shipped verb (the first attempt was correctly refused with `blocked:H-HEADING-CHILDREN`, so the children are reparented per its own remediation).

```
archive BH2 with --children reparent -> ok, status "completed"

DB heading rows after:            title  status  idx
                                  BH1    0       -547
                                  BH2    3       -263      <- archived, still in the index axis
                                  BH3    0       -167
                                  BH4    0          0

heading rows RENDERED before: 4      after: 3
  [3]  More. BH1 …                     [6]  More. BH1 …
  [7]  More. BH2 …    <- gone          [10] More. BH3 …
  [11] More. BH3 …                     [14] More. BH4 …
  [15] More. BH4 …
*** VERDICT: an ARCHIVED heading does NOT render as a content row ***
```

The shipped positional walk agrees exactly — its ordinals enumerate the **live** headings and stop:

```
select-heading-row ordinal 0: OK       AX: selected row ordinals [6,29]    (BH1)
select-heading-row ordinal 1: OK       AX: selected row ordinals [10,29]   (BH3)
select-heading-row ordinal 2: OK       AX: selected row ordinals [14,29]   (BH4)
select-heading-row ordinal 3: NOMATCH
```

And the chord's ±1 **skips the archived slot**, in one chord, with no beep:

```
live headings: BH1 < BH3 < BH4       ALL headings: BH1 < BH2 < BH3 < BH4
select ordinal 1 (BH3) · ⌘↑
CHANGED Yb6WtDbS(BH3).index: -167 -> -1127     <- straight past BH2 (-263) AND under BH1 (-547)
live headings AFTER: BH3 < BH1 < BH4
a second ⌘↑ on ordinal 1: CHANGED 6TjrY16H(BH1).index: -547 -> -1753
cell 7a' beeps: 0 (4 marks)
```

> **The archived-heading law.** A heading with a closed `status` is **not rendered** as a content row in the project view, takes **no ordinal** in the shipped `select-heading-row` walk, and is **skipped** by the chord's ±1 — one chord moves a live heading past it, and the archived row's own `index` is never rewritten. The rendered row order is therefore exactly the DB order **filtered to `status = 0`**.

**The #606 fence can be lifted**, with one precise rider: the planner's ordinal must be computed over `status = 0` headings only. Its current pre-state read (`SELECT uuid, status … ORDER BY "index"`) keeps archived rows in `current`, so its ordinals and the walk's would disagree by one per archived heading — that mismatch, not the rendering, is the real hazard. Archived headings should also stay refused as a *movee* or *anchor* (they cannot be selected at all), and the archived row's `index` will drift arbitrarily among the live ones over time, which is harmless because it is invisible.

---

## §8 — Recommendation

### 8.1 Which `reorder.ts` protocols the chord could replace or simplify

The chord's measured properties — one dispatch, a one-row write, no renumbering of anything the user did not move, tier 0/1 background delivery, no `umd` stamp, no scheduling side effect — beat every bounce on every axis the bounce was chosen for. Named against the measured laws:

| `reorder.ts` scope / protocol | today | what CHORD2 measured | recommendation |
|---|---|---|---|
| **`area-someday`** (reverse-order bounce, `anytime`↔`someday` round-trip; the destructive §9f AREA specifier is avoided by bouncing) | 2 verified mutations **per item**, `index` axis, every re-entry front-inserts | Someday re-ranks on **`index`** with a **one-row** write, no re-dating, `start=2` preserved (§4, 4d) | **REPLACE.** This is the clearest win: the bounce exists only because no native call reaches these rows, and it pays a full `when=` round-trip per item to buy a placement the chord buys with one keystroke. |
| **`anytime`** (area-less loose anytime, reverse-order bounce) | same shape | Anytime re-ranks on **`index`**, one-row write (§4, 4d, area-direct arm) | **REPLACE**, with the caveat in §8.3 — the loose/area-less population was not isolated. |
| **`someday`** / **`project-someday`** / **`heading`** / **`heading-someday`** | bounce or per-item re-head legs; `index` axis; back- or front-insert | all are `index`-axis container orders, all of which the chord re-ranks one row at a time inside the container's own view | **REPLACE where the container has a single addressable view.** The chord makes the front-insert/back-insert distinction *irrelevant* — there is no re-entry, so there is no landing law to model. |
| **the within-heading child order** (`heading` scope) | forward-order bounce; BOUNCE2-h back-insert | works, **but** §3 shows the bucket edge is permeable in both directions and crossing is silent | **REPLACE, WITH A HARD FENCE.** The planner must compute the exact move count from the pre-state and never over-fire: one chord too many at a bucket edge is a **silent reparent**, not a beep. Assert `heading` FK + `umd` unchanged after every chord (§6). |
| **`today`** / **`evening`** (bounce, `todayIndex`) | `when=` round-trips; the evening leg **strips `reminderTime`** (§9n) | both re-rank on **`todayIndex`** with a one-row write and **no** reminder/date/`startBucket` delta (§4) | **REPLACE — this one also removes a data-loss side effect.** The evening bounce's reminder-stripping simply has no analogue in the chord. Fence the Evening section's top edge (§4be2). |
| **`day`** (the DATED bounce, 2N legs) | cross-date `when=` round-trip per row | the Upcoming day-group re-ranks on **`todayIndex`**, one row per chord, **no `startDate` write**, and the group edge **declines** instead of crossing days (§4e2) | **REPLACE for within-day ordering.** The chord cannot leave the day, which is precisely the invariant the dated bounce has to be careful to preserve. |
| **`container-day`** / **`tomorrow`** (native `_private_experimental_ reorder`, gated by `allow-experimental` + the sdef canary) | one native call, but SUSPENDED-adjacent and gate-bound | the chord reaches the same day axis with no experimental gate | **KEEP for now, but they stop being load-bearing.** If the chord is adopted for `day`, these become an optimization (one call vs N chords) rather than the only surface. |
| **`projects`** (sidebar order, bounce) | `when=` round-trip per project | **NOT PROBED** — no sidebar-row chord arm was run | leave as is; see §9. |

Two protocol-level simplifications the chord unlocks beyond any single scope:

* **The whole front-insert / back-insert landing taxonomy can go** for every scope that moves to the chord. BOUNCE2's classes exist to predict where a row lands when it *re-enters* a container; the chord never removes a row from its container, so there is nothing to predict. That deletes a large amount of the planner's hardest-to-verify modelling.
* **The `--before`/`--after` co-touch disclosure shrinks.** A bounce anchor co-bounces the contiguous run between the block and the anchor; a chord displaces only the rows it passes, and the multi-selection law (§2) says the *selected* rows are never rewritten at all. The set of "rows we touched that you did not name" becomes exactly the passed-over run, computable from the pre-state.

### 8.2 Which app-impossibilities reopen

* **ORD-19 — a repeating template's day-block position — REOPENS.** Measured movable (§5d), with a uuid-verified selection, a one-column write, and no disturbance to the recurrence rule or its cursor. Both walls ORDFIN1 raised are down on 3.23: the projected row *does* expose its title to AX, and the gesture is a chord rather than the infeasible drag. This is the campaign's largest single finding and it deserves its own build cell before anything is wired — in particular, the interaction with `rt1_nextInstanceStartDate` advancing (does the chord-set rank survive the next spawn?) is unmeasured.
* **§9e template ORDER in a resting bucket — STAYS CLOSED.** The rule row declines every chord in a project list (§5c/7b), identity-verified, twice. §9e's inertness is now confirmed against a second, independent vector; the entry should be strengthened, not retired.
* **The `project.move-heading` archived-heading fence — LIFTABLE** (§7), with the `status = 0` ordinal correction as the actual precondition.

### 8.3 Fences any chord-compiled op must carry

1. **Compute the move count from the database; never fire until nothing changes.** Every wasted chord is an audible error tone (§6c, 7 for 7).
2. **The beep is not a membership alarm.** Crossings are silent. Assert `heading`/`project`/`area` FK and `startBucket` unchanged, and use the **`umd` stamp** as the cheap tripwire (§6a).
3. **Fence every bucket and section edge**: the first heading's top (deportation, §3a), the loose block's bottom (adoption, §3f), a bucket's far end under ⌘⌥ (§3e), and This Evening's top (§4be2).
4. **Own the view state.** The chord is view-relative (§4bf): an active tag filter silently changes what ±1 means.
5. **Refuse mixed-kind selections** — though the app already refuses them cleanly (§2c), so this is a fast-fail, not a safety net.
6. **Deliver backgrounded.** §1 shows the whole gesture at tier 0 with no `activate` step; there is no reason to ship the focus-stealing shape.

---

## §9 — Beep counts (sentinel per cell, `THINGS_LAB_BEEPS_OK=1`)

| cell | marks | beeps | attribution |
|---|---|---|---|
| 1 `bg` | 6 | **0** | — |
| 2 `multi` (first pass) | 10 | **2** | the mixed-selection arm and the block-already-at-top arm (this pass ran before the sentinel was switched to attribution mode) |
| 2b `multi2` | 12 | **1** | `cell2b5 chord burst` — the 4th chord of a 3-productive burst |
| 2c `multi3` | 8 | **4** | `cell2c2` (block already at top), `cell2c3` + `cell2c4` (the mixed selection, both directions), `cell2c5` |
| 3 `bounds` | 8 | **3** | `cell3b` (project top), `cell3c` (project bottom), `cell3g` (top heading — the control) |
| 4 `views` | 9 | **4** | 3 × `cell4e2` (the Upcoming group edge, deliberate), 1 × `cell4g` (the Logbook) |
| 4b `views2` | 6 | **2** | `cell4bc`, `cell4be` — both rig misses (an empty view and an off-screen click), nothing selected |
| 4c `views3` | 3 | **1** | `cell4ca` — the same empty-Anytime rig miss |
| 4d `views4` | 2 | **0** | — |
| 5b `tmpl2` | 6 | **1** | `cell5e` — the 6th chord of a 5-productive burst |
| 6 `side` | 3 windows | **9** | `cell6c` **7** (7 wasted of 10 — the 1:1 validation), `cell6d` **1**, `cell6e` **1** |
| 7 `extra` | 6 | **3** | `cell7a3` (top heading), `cell7b` + `cell7b2` (the template row declining, both chords) |
| 7a′ `arch` | 4 | **0** | — |
| **total** | **83** | **30** | **every one a declined chord; zero unexplained.** 24 were deliberate probes of a decline; 3 were rig misses that fired with nothing selected; 3 were the last chord of a fixed-count burst. |

The 7-for-7 match in cell 6c is also a positive validation of the oracle in this clone: three productive chords produced no beep, seven declined ones produced exactly seven.

---

## §10 — Rig defects this campaign found (worth inheriting)

1. **Synthetic `CGEvent` clicks inherit the live modifier state.** Call `CGEventSetFlags` on **every** event, zero included, or a "plain" click after a shift-click is still a shift-click — and it produces a plausible wrong selection rather than an error (§2.1).
2. **A row-clicker must keep scanning past a row that lacks the wanted element.** Returning on the first row that merely mentions the needle makes any later row unreachable — which is exactly the occurrence-vs-template case (§5).
3. **`Things3 → id of selected to dos` is the only honest selection oracle when titles are ambiguous.** Two rows shared a title in every `add-repeating` fixture; the uuid readback is what caught the wrong one.
4. **A `things:///json` batch containing a to-do with `checklist-items` landed NOTHING** and reported success — the project, its other children and the checklist row all failed to appear (filed as an oddity). Build checklist-bearing fixtures on their own leg.
5. **Title globs for full-row snapshots must be `%<stamp>%`, not `%-<stamp>`** — the latter silently excludes every `…-c1`/`…-c2` child row, which is precisely the population a heading cell is about. Cell 3's first pass produced a "clean" diff that was simply blind to the deported child.
6. **Fixtures seeded loose by `things:///json` land in the INBOX, which is not in Anytime.** Two Anytime arms measured an empty view before the third seeded area-direct rows.

---

## §11 — What was NOT probed

* **On-device certification** — everything here is `lab-certified` ([ui-certification-runbook](ui-certification-runbook.md)).
* **Sidebar rows** (the `projects` scope) — no chord was fired at a project row in the sidebar.
* **Search results** — the Logbook read-only control was run; Quick Find was not.
* **The `anytime` scope's exact population** — the Anytime arm used AREA-direct rows; area-less loose anytime rows (ANYBNC's population) were not isolated from Inbox membership.
* **A heading-only multi-selection** — one addressing shape was tried (a cmd-click on the heading row's More element) and it did not extend the selection (§2e).
* **Whether a chord-set template rank survives the next occurrence spawn** — the ORD-19 follow-up's first question.
* **Cloud sync behaviour** of a chord-driven rank write (airgapped clone), including whether the multi-selection law's "renumber the unselected rows" shape costs more change records than the bounce it would replace.
* **Row counts at scale** — every fixture was 3–6 rows; the ⌘⌥ endpoint chords renumber every displaced row, so a 200-row container's endpoint move is an unmeasured write volume.
