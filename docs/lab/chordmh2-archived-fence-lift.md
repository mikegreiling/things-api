# CHORDMH2 — the archived-heading fence, lifted and certified

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`chordmh2-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-chordmh2.sh`](../../lab/scripts/research-chordmh2.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordmh2.sh setup     # clone + boot + airgap + clock pin + ship the CLI
                                                              … deps              # (re-)push commander + ui-enabled
                                                              … cert              # the ONE certification cell
                                                              … teardown
```

A **one-cell build certification**, not a probe campaign. [CHORDMH1](chordmh1-move-heading-build.md) shipped `project.move-heading` on the arrow chords with one deliberate capability cut: any completed/canceled heading in the project refused the whole move, because the row addressing is positional and *"whether Things renders a COMPLETED/CANCELED heading in the project view is not measured"*. [CHORD2](chord2-reorder-laws.md) cell 7a′ measured it — an archived heading does **not** render as a content row, takes **no** ordinal in the `select-heading-row` walk, and a live heading's ±1 **skips** its slot in one chord with no beep — and named the precondition for lifting the fence: the planner's ordinals must be computed over `status = 0` headings only. This cell certifies the lift against the app.

---

## The change under test

The fence was never really about rendering; it was standing in for an **ordinal mismatch**. `computeHeadingMovePre` read `SELECT uuid, status … ORDER BY "index"` and kept archived rows in `current`, so its ordinals and the AX walk's would disagree by one per archived heading — the plan would select the wrong row and the per-chord verifier would (correctly) stop the drive. Three reads now filter to the RENDERED order, and the whole-project refusal is gone:

| site | what it feeds |
|---|---|
| `computeHeadingMovePre` (`src/write/pre-state.ts`) | `current` / `targetOrder` / `untouched` — the plan and the delta assertion |
| `createHeadingOrderReader` (`src/write/vectors/ui-chord.ts`) | the driver's per-chord ground truth, and therefore every `select-heading-row` ordinal |
| `currentHeadingOrder` (`src/write/move.ts`) | the bare-placement anchor for `things reorder <headings…>` |

The child digest in `createHeadingOrderReader` is deliberately **not** filtered: it still covers every non-trashed child of every heading of the project, archived headings included, because no heading chord may disturb any of them.

Two refusals survive the lift, both for the same reason — an unrendered row has no ordinal:

* an archived heading named as a **movee** → `blocked:H-HEADING-ORDER`
* an archived heading named as an **anchor** → `blocked:H-HEADING-ORDER`

And one thing is deliberately **not** asserted: the archived row's own rank. It is absent from `untouched`, so the delta makes no claim about it. The live rows are renumbered around it over time and its drift among them is invisible.

---

## The cell

Fixture: a project seeded with four headings, two synthetic children each, then `GA` archived through the shipped verb (`project archive-heading … --children complete`). That leaves the archived row **between `G1` and `G2` in the one index axis** and invisible in the view:

```
raw index axis (every heading row)        RENDERED order
  title      status  idx                   G1 < G2 < G3
  G1         0       -510
  GA         3       -231     <- archived, holding a slot
  G2         0       -105
  G3         0        0
```

Drive, through the production CLI (`THINGS_API_UI_DIRECT=1 … project move-heading <project> G3 --first --dangerously-drive-gui --json`):

```
exit 0 · vector ui · tier 3 · elapsed 5245ms
drove 3 step(s): reveal → confirm the content table → reorder 1 heading(s) with the arrow chords (1 chord(s) posted)

raw index axis after                      RENDERED order after
  title      status  idx                   G3 < G1 < G2
  G3         0       -1086    <- the ONLY row rewritten
  G1         0        -510
  GA         3        -231
  G2         0        -105

archived row bytes before : status=3 idx=-231 stop=1783252902.22154 umd=1783252902.22159
archived row bytes after  : status=3 idx=-231 stop=1783252902.22154 umd=1783252902.22159
children                  : INTACT (heading FK + index byte-identical)
```

The two surviving refusals, same fixture, same run:

```
project move-heading … GA --first             -> exit 4  blocked:H-HEADING-ORDER
  "XSdF… is a completed/canceled heading — it is not shown in the project view,
   so there is no row to select and no chord can move it"
project move-heading … G1 --before-heading GA -> exit 4  blocked:H-HEADING-ORDER
  "anchor heading XSdF… is completed/canceled — an archived heading holds no
   position in the project view to place another heading against"
zero mutation on both
```

```
BEEP-SENTINEL [run]: 0 alert beep(s) in the window (allowed 99; 5 marks) — clean
```

---

## Verdict

> **The fence is LIFTED.** A project holding an archived heading is now an ordinary project to `project.move-heading`. **ONE chord** carried `G3` from the bottom of the rendered list to the top of it, straight past the archived row's slot — `-1086` is below `G1` (`-510`) **and** below the archived `GA` (`-231`) — and it was the only row rewritten, exactly the single-row-write law CHORDMH1 certified. The archived row is **byte-untouched** on all four columns read (`status`, `index`, `stopDate`, `userModificationDate`), every child kept its heading FK and index, and the cell posted **zero alert beeps**. The archived heading is simply not part of the problem: it is not in the plan, not in the walk, not in the delta, and not moved.

Two riders, recorded rather than fixed:

* the archived row's `index` will drift among the live ones as they are re-ranked around it. That is harmless — nothing renders it — and it is why the row is excluded from `untouched` rather than asserted unchanged.
* an archived heading is still unreachable. `project unarchive-heading` is the way back to a movable row; there is no chord that reaches one.

## What did NOT change

The chord itself, the driver's schedule, the per-chord single-row-write and children laws, the two-key gate, SESSGATE, and the background (tier 0/1) delivery are all exactly as CHORDMH1 certified them. This cell moves one precondition and re-runs the op against it.
