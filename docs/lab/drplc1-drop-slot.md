# DRPLC1 — the drop slot: what Things really does to the sidebar while a row is held (#729)

**Probed under TWO builds in one sitting per arm, on `things-lab-golden-v4` / `things-lab-golden-v4h` clones · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18):**

| Cell tag | App | Build | Arms |
|---|---|---|---|
| `323` | Things **3.23** | 32300036 | direct (golden-v4) · routed (golden-v4h) |
| `3233` | Things **3.23.3** | 32303001 | the same clone, upgraded in place from the banked installer, with a write probe against the trial wall before anything is believed |

One disposable clone at a time (`drplc1-lab`), destroyed by an `EXIT` trap. Fixtures fully synthetic — 12 areas `DRPLC-A01…A12`, the source carrying three projects, one 26-project wall mid-list so the [SBCOL1](sbcol1-sidebar-collapse.md) fold rung runs. Driver [`lab/scripts/research-drplc1.sh`](../../lab/scripts/research-drplc1.sh), guest helper [`lab/scripts/drplc1-helper.jxa.js`](../../lab/scripts/drplc1-helper.jxa.js), analyzer [`lab/scripts/drplc1-analyze.py`](../../lab/scripts/drplc1-analyze.py):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-drplc1.sh probe --upgrade
                                                            … cert direct --upgrade
                                                            … cert routed --upgrade
                                                            … teardown
```

## The report

[#729](https://github.com/mikegreiling/things-api/issues/729), from the maintainer's M1 (Things 3.23.3, things-api 0.20.10, helpers 1.4.0, routed): `area reorder <first-of-12> --last --dangerously-drive-gui` lands the area **second-to-last**, deterministically, twice (the driver's own retry included), then exits 3 `verify-failed:mismatch`. The blocking area folded and re-expanded correctly; ~33 s. A later failure than [#676](https://github.com/mikegreiling/things-api/issues/676): the path was cleared and a drag DID land — in the wrong slot.

## The answers, in one table

| Question | Answer |
|---|---|
| Does lifting a sidebar row COLLAPSE its slot, as [AXDRAG1-a](axdrag1-reorder.md) measured on 3.22.11? | **No.** The group leaves the table and a **48 pt LANDING GAP** takes its place — two ordinary 24 pt rows, not a distinct kind |
| Is that a 3.23.3 change? | **No.** 3.23 does it too, identically. The lab never saw it because nothing had ever read the layout mid-drag |
| Does the gap stay where the row was? | **No — it TRACKS THE POINTER.** Rows above the current insertion point sit at `static − span`, rows below it at `static − span + 48` |
| What does the app hit-test the pointer against? | **The layout WITHOUT the gap** — the collapsed one. Measured, because a loop that aimed at a point read off the LIVE frames oscillated with an amplitude of exactly one gap |
| Anything else moves? | Yes. A sidebar scrolled to its bottom cannot stay there when the content shortens, so the app reduces the scroll offset and **every** row moves (measured +64 pt) |
| So what was wrong with the shipped aim? | To-last is the only placement whose point lies **outside** the collapsed content — 8 pt past the last row's bottom, where the app's answer is a courtesy rather than geometry. Every other placement aims strictly between two rows |
| Did #729 reproduce headlessly? | **No.** The clone resolves that off-content point to "the end" every time, on both builds |
| Fix | The drop point is **steered against the app's own landing slot**, read from live frames with the button held, and the button does not come up until the app is showing the slot the move asked for |

## §1 — the measurement: hold the drag open and census the whole table

`liftread` grabs the source exactly the way the shipped gesture does (MOVED → DOWN → a 3 pt wiggle → DRAG back), then — button still held — takes three full row censuses, Escape-aborts ([AXDRAG1-d](axdrag1-reorder.md): a byte-identical index vector) and censuses once more. [AXDRAG2-a](axdrag2-reorder-certification.md) had proved AX frames re-resolve fresh mid-drag; this is the first time anything read all of them.

**Things 3.23, source `DRPLC-A09` (first of 12, three nested projects), pointer parked at the grab point:**

```
before: viewport y=63 h=610  rows=65  bottom=1520.0
mid[*]: viewport y=63 h=610  rows=62  bottom=1456.0      <- three rows fewer, 64 pt shorter
source row present mid-drag: no
  DRPLC-A10  static y= 472.0  live y= 408.0  dy=-64.0
  …every row below the source: dy = -64.0 exactly…
  DRPLC-A05  static y=1496.0  live y=1432.0  dy=-64.0
  source y=360.0 h=24.0   computed group span = 112.0
  derived landing gap: 48.0 pt (span 112.0, shift -64.0)
```

**Things 3.23.3, source `DRPLC-A09` (first of 12, NO nested projects):**

```
before: rows=65  bottom=1520.0
mid[*]: rows=65  bottom=1528.0                            <- same count, 8 pt TALLER
source row present mid-drag: no
  …every row below the source: dy = +8.0 exactly…
  source y=360.0 h=24.0   computed group span = 40.0
  derived landing gap: 48.0 pt (span 40.0, shift +8.0)
```

One law, two builds, two span regimes. A row below the source sits at `static − span + 48`: the lifted group leaves and a **48 pt placeholder** takes its place. With a 112 pt group the list gets 64 pt shorter; with a 40 pt group it gets **8 pt taller and the rows below move DOWN**. The old model — subtract the span — is wrong by the gap, always, and its sign is not even fixed.

The placeholder is not identifiable by its height. The mid-drag row-height histogram is `{24: 48, 16: 14}`, the same two classes as before the lift: 48 pt is **two ordinary 24 pt rows**. Which is why the first build of the fix, which hunted for a row of an unfamiliar height, found nothing and refused every drop.

## §2 — the gap TRACKS THE POINTER

`liftmove` repeats the cell with the pointer walked 200 pt down the list before the censuses. The shift stops being uniform:

```
  DRPLC-A10  static y= 472.0  live y= 360.0  dy=-112.0   <- above the insertion point
  DRPLC-A08  static y= 512.0  live y= 400.0  dy=-112.0
  DRPLC-A07  static y= 552.0  live y= 440.0  dy=-112.0
  DRPLC-A11  static y= 592.0  live y= 480.0  dy=-112.0
  DRPLC-A12  static y= 632.0  live y= 520.0  dy=-112.0
  DRPLC-A06  static y= 672.0  live y= 608.0  dy= -64.0   <- below it
  DRPLC-A04  static y= 712.0  live y= 648.0  dy= -64.0
```

−112 is the full group span; −64 is `−span + 48`. The line between the two classes is exactly where the pointer is. **The mid-drag layout is a function of the pointer**, so no static number describes it — and the gap is the app saying, on every frame, where the drop would land. It is the observable a closed loop should have been polling all along.

## §3 — and the app hit-tests the layout WITHOUT the gap

This one was measured by a fix that did not work. The first closed loop aimed at the point the static planner aims at — the mid-gap between the anchor and the row above it — and re-read until the pointer and that point agreed. Three of four cells failed, with the same signature:

```
drag the area "DRPLC-A09" to the top of the area list — FAILED:
  (iterations-exhausted: the live boundary never settled (176->224, 224->176, 176->224, 224->176))
drag the area "DRPLC-A07" below "DRPLC-A11" — FAILED:
  (iterations-exhausted: the live boundary never settled (496->544, 544->496, 496->544, 544->496))
```

Amplitude 48 pt — the gap, exactly. Read it as a loop: at 176 the app holds the gap above the anchor, so the anchor RENDERS at 224 and the live mid-gap point reads 224. Move there, and the app resolves 224 in the **gap-free** layout, where it is past the anchor — so it moves the gap below, the anchor rises to 176, and the point reads 176 again. Only one model produces that: **the pointer is resolved against the collapsed layout, and the gap is drawn afterwards.**

Two consequences, and the campaign needed both:

- A live-frame aim is correct only once the gap's displacement is subtracted from it. The COLLAPSED frame is `pre-grab y − span` for every row below the source and `pre-grab y` above it — which is exactly what the pre-DRPLC1 `correctedDropY` computed. **The old arithmetic was right about the frame it aimed in.**
- Aiming at a BOUNDARY in that frame is still wrong for a loop that re-reads, because a boundary is the one point an arbitrarily small shift flips. The live aim is a strictly interior point of the target row.

### Why to-last, and only to-last

In the collapsed frame the shipped aim is `boundaryBelowLast − span`, i.e. `medianSpacerHeight / 2` — **8 pt** — below the collapsed last row's bottom edge. Every other placement aims at a mid-gap strictly BETWEEN two rows. So to-last is the only one of the four whose point lies **outside the collapsed content**, in a region where "the end of the list" is what the app chooses to resolve to rather than what the geometry says. Eight points of margin, on the one placement #729 reports.

That is the mechanism. What it does not do is reproduce: on both builds the unfixed driver's `--last` landed correctly in the clone every time (`elapsedMs` 10961 on 3.23 and 6206 on 3.23.3, the wall folded and restored in both), and so did a to-last on a shrunken fixture with no scroll bar at all.

### The scroll-bar hypothesis: ruled out

The alternative — that the to-last boundary is computed against the viewport floor, so a list that fits without a scroll bar aims wrong — is not what happens. `boundaryBelowLast` is derived entirely from the last row's own frame; the viewport is nowhere in that arithmetic. The `fits` cell (12 areas, 6 projects, a 1200×900 window, `scroll=0`, the whole list inside the viewport, no scroll bar) landed the move on both builds.

## §4 — four things the drive has to know, each paid for by a build that failed

The loop that ships is the fifth. The four corrections, in the order the lab produced them, because each is a fact about the app rather than about our code:

1. **Aim at the INTERIOR of a slot, never at its boundary** (§3). A blind gesture wants the mid-gap — the point furthest from both wrong answers in a layout nobody re-reads. A closed loop wants the quarter point inside the row, because it re-reads, and a boundary flips.
2. **Element references taken before the grab read STALE frames.** Holding `ANCHOR_EL` and the last row's element from the pre-grab pass, the loop watched the last row sit motionless at its pre-drag `y` through four iterations while the row count (39 → 36) proved the lift had plainly happened. The rows are re-fetched from the table every pass now, and the model is matched by GEOMETRY rather than by identity.
3. **A bottom-pinned list moves as a whole.** A sidebar scrolled to its end cannot stay there when the lift shortens the content, so the app reduces the scroll offset and every row shifts — measured at +64 pt, which made the topmost row read `-96` against a model expecting `-160`. The collapsed model is therefore matched **up to a translation**, read off the topmost row.
4. **`sourceGroupSpan` was wrong for the LAST area.** With no next-area row to end its section it fell back to one slot pitch, which is right only for an area with no visible projects — so a `--first` move whose source was the bottom area computed a 40 pt group for a 112 pt one and the mid-drag layout became unaccountable (`n=36/37`). It now runs to the bottom of the table. The drive does not trust even that: the span is a HYPOTHESIS, and the loop tries a few neighbouring row/spacer multiples and keeps the first that makes the live table read as "the collapsed list plus a placeholder". A wrong span cannot pass that test.

A fifth, from the same batch and cheap to state: holding the pointer 6 pt (`BAND_PAD`) from the viewport floor for several reads is long enough to trigger the app's own mid-drag EDGE AUTO-SCROLL ([AXDRAG1-c](axdrag1-reorder.md): ~5 pt from the floor ran the list 0.036 → 1.0 in 2.5 s). The shipped blind gesture never noticed, because it held for 400 ms. The loop reads the scroll fraction every iteration and refuses `auto-scrolling` rather than chasing a target on a moving list.

## §5 — the fix: steer on the app's own landing slot

`jxaSidebarLiveDragScript` replaces `jxaSidebarDragScript`. It still opens the drag the NATIVE1 way and still travels to the caller's static estimate — and then, with the button held:

1. builds the **collapsed model** from the pre-grab geometry (every row's frame, minus the source's group span below it), fitting the span against the live table;
2. reads the live rows and finds the **placeholder's slot** — the first live top that disagrees with the collapsed model, matched up to a uniform scroll translation;
3. if that slot is the one the move asked for, **drops where the pointer already is**. The app has rendered the answer; the pointer does not move again between the read and the release;
4. otherwise **steers**: the first move goes to the computed interior point (the anchor row's top quarter, or the last row's bottom quarter), and after that the loop walks half a row toward the slot it wants and asks again. Which makes the drive independent of exactly where the app puts its slot boundaries — a model of that was wrong twice in this campaign, and the app renders the answer on every frame;
5. re-takes the PTRGD1 drop-time guard **at the live point**, not at the estimate;
6. Escape-aborts on anything else — an unresolvable pane, an unconfirmable source row, an anchor that will not resolve, a layout the model cannot account for, a list scrolling underneath, a point outside the visible band. **There is no blind drop**, and every refusal names its own numbers (the band it left, the fractions it scrolled between, the last four pointer→slot pairs). A script that dies outright now reports the interpreter's own first line instead of "the drag gesture did not complete" — which is what made three of these findings cost a whole sitting each.

**What it costs.** Geometry only: `AXRows` plus one batched position+size fetch per row, which realizes nothing (~2 ms for 174 rows in the field, [VOPAT1](vopat1-screen-reader-pattern.md) §3). A **to-last** drop realizes **zero** rows; an insert-above drop realizes **one** — the anchor, before the gesture starts, addressed by the ordinal the census's row map named and confirmed by its title. The pane is addressed by index ([VOPAT2 PR 2](vopat2-pr2-sparse-reads.md)) and confirmed geometrically by finding the source's own frame among its rows, so **no semantic census runs inside the gesture**. The `sidebar-drag` step budget moves from a flat 30 s to two census-equivalents.

The static estimate is not deleted — it is demoted. It still centres the pre-scroll, still measures the tall-section wall, and still feeds the PTRGD1 pre-gesture containment check. Because the live aim lies between the corrected estimate and the uncorrected static one, the pre-scroll and the wall pre-flight now work on the **interval** between the two (`dropInterval` / `travelNeeded`) rather than on the corrected point alone.

Rung 3's hops go through the same gesture, so a multi-hop move is closed-loop per hop.

## §6 — certification

Two sittings, one clone each, every cell run twice — once on 3.23 and once on the same clone upgraded in place to **3.23.3**. The routed arm asserted its identity before a single probe (`mode true · running · automation→Things granted · axTrusted · automation→System Events granted · reader granted · deputy 1.4.0`) and carried **no lab escapes**, per the HELPGST1 routing-arm law.

| Cell | direct · 3.23 | direct · 3.23.3 | routed · 3.23 | routed · 3.23.3 |
|---|---|---|---|---|
| `--last` (first area → the end, across the 26-project wall) | LANDED | LANDED | LANDED | LANDED |
| `--first` (last area → the top) | LANDED | LANDED | LANDED | LANDED |
| `--before <mid-list anchor>` | LANDED | LANDED | LANDED | LANDED |
| `--after <mid-list anchor>` | LANDED | LANDED | LANDED | LANDED |
| the SBCOL1 fold + restore | folded and re-expanded in every cell above | — | — | — |
| duplicate-title pair, moved by uuid | LANDED (the intended twin) | — | LANDED | — |
| restore-on-abort (a): a held drag, Escape-aborted | index vector BYTE-IDENTICAL | — | BYTE-IDENTICAL | — |
| restore-on-abort (b): an anchor that does not exist | refused, nothing posted | — | refused, nothing posted | — |
| `THINGS_API_SIDEBAR_SPARSE=0` A/B | LANDED | — | LANDED | — |
| no wall, no scroll bar (12 areas, 6 projects, 1200×900) | LANDED | LANDED | — | LANDED |
| invariants (`TMArea` count + assignment digest) | 12 / unchanged from seed in every cell | 12 / unchanged | 12 / unchanged | 12 / unchanged |

**Helper grants survive an in-clone app upgrade.** After `/Applications/Things3.app` was replaced with 3.23.3, `things helpers status --json` still read every leg `granted` with the deputy running 1.4.0 — the TCC rows are keyed to the HELPER's signing requirement, and nothing about Things is in them. So the routed arm can be re-pointed at a new Things build without re-baking a golden.

### The live-vs-static delta, and what it is worth

The traced to-last move reports the same thing on both builds:

```
drop-target: anchor=end-of-list static=664 corrected=624 span=40 live=624 live-vs-static=0
             stop=placed iters=1
  {k:0, at:624, slot:37, want:37, dbg:'n=39/37 shift=0', rows:39, scroll:0.968}
```

**Zero.** In the clone the corrected estimate is already the right point, the very first live read finds the app offering slot 37 of 37, and the button comes up where the pointer already is — one iteration, no steering. That is the honest result and it is the point rather than a disappointment: the fix's value here is not that it moves the aim, it is that **the aim is confirmed against the app's own rendering before the release**, so the 8 pt of margin §3 identifies is no longer load-bearing. A host where the margin does not hold gets a steer and lands; a host where nothing can be read gets an Escape-abort and a sentence, not a wrong slot.

What the same records also give, for the cost ledger:

```
3.23    censuses 9 (8 sparse, 1 sweep, 1 escalation)  axCalls 2577  rowsRealized 161
        gestures {drag 1, chevron 2, scroll 1}        settles {observed 4, missed 0, timer 0}
3.23.3  censuses 7 (6 sparse, 1 sweep, 1 escalation)  axCalls 2157  rowsRealized 137
        gestures {drag 1, chevron 2, scroll 0}        settles {observed 3, missed 0, timer 0}
```

The drag's own live reads are inside those `axCalls` and add **no** realized rows to a to-last move, which is what the geometry-only design was for. Every settle was observed on both arms — the routed one included, DEPOBS1 having landed first.


## What this does NOT settle

**Whether the maintainer's M1 lands in the wrong slot for the reason modelled in §3.** The clone resolves the shipped off-content aim to "the end" every time, on both builds and in both arms, so the field trigger is inferred from the measured layout law plus the 8 pt of margin, not observed. What the fix removes is the dependence itself: after this change the drop point is not a point at all — it is a slot the app has confirmed it will use, read from the layout on screen at the moment of release. The confirming evidence is the maintainer's own re-run, and the drive now emits a `sidebar-drop-target` trace record per gesture (`staticY`, `correctedY`, `span`, `liveY`, `liveVsStatic`, `stop`, and the loop's iteration ledger), so that re-run reports its own numbers rather than needing another campaign.
