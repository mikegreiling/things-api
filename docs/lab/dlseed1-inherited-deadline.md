# DLSEED1 — the deadlined source: what the GUI does with it, and whether we do the same

**Probed:** 2026-09-05 · Things **3.23** build 32300036 · macOS 15.7.7 · DB v27 · goldens **v4** (direct) and **v4h** (routed, helpers 1.4.0) · guest clock pinned 2026-07-05 12:00 (trial wall 2026-07-18) · synthetic `DLS1-*` / `DLS1R-*` fixtures only · the branch CLI (0.20.11 + this batch).

**Drivers:** [`lab/scripts/research-dlseed1.sh`](../../lab/scripts/research-dlseed1.sh) (direct, and the GUI oracle) · [`lab/guest/dlseed1-cells.sh`](../../lab/guest/dlseed1-cells.sh) through [`lab/scripts/stage5-rc-run.sh`](../../lab/scripts/stage5-rc-run.sh) (routed).

---

## 0. Headline

`things todo make-repeating <a to-do that already carries a deadline>` now exits **0** and lands **byte-for-byte the rule Things itself writes** when a person opens the Repeat dialog on that same to-do and picks *weekly*. Before this batch it exited **3**, calling the app's own default a mismatch (DEFAULTS2 §6).

The oracle is not an argument, it is a row: the two rule blobs — the GUI's and the CLI's — are identical hex, `ia` and `sr` anchors included.

---

## 1. What the dialog does with a deadlined seed, read off the live dialog

Seed: `startDate = 2026-07-09`, `deadline = 2026-07-12` (a three-day gap), nothing else.

| moment | `freq` | `interval` | `Next:` | `Add deadlines` | `start N days earlier` |
| --- | --- | --- | --- | --- | --- |
| dialog AS OPENED | `after completion` | 1 | *(no control)* | **1** | **3** |
| after choosing `weekly`, nothing else touched | `weekly` | 1 | **Sun, Jul 12, 2026** | **1** | **3** |

Two facts, both of them the ruling's premises:

1. **The deadline is pre-filled from the row.** "Add deadlines" is ticked and the offset already holds `deadline − start` = 3, before anything is clicked. (DEFAULTS1 §4 S11 measured this; here it is re-read on the seed shape the promote actually produces, because `make-repeating` CLONES the source.)
2. **The cadence row anchors on the DUE date.** `Next:` comes up on **Jul 12** — the deadline — not on Jul 09.

Press OK and Things commits:

```
tp=0 fu=256 fa=1 ts=-3 rc=0 ed=64092211200.0 of=[{wd=0}] next=2026-07-09 icStart=2026-07-09
ROW deadline=4001-01-01   (the deadlined-series sentinel)
```

So the app's own default is: **deadlined series, offset 3, first occurrence on the source's own start date** — `Next:` names the due date and the app back-shifts the start by the offset. `of=[{wd=0}]` is Sunday: the weekday of the DUE date, not of the start.

## 2. The shipped verb, on an identical seed

`things todo make-repeating <uuid> --frequency weekly --interval 1 --dangerously-drive-gui`

```
exit 0
tp=0 fu=256 fa=1 ts=-3 rc=0 ed=64092211200.0 of=[{wd=0}] next=2026-07-09 icStart=2026-07-09
ROW deadline=4001-01-01
```

**PASS — the rule is byte-for-byte the GUI's own** (the driver compares the decoded rule field by field and the raw `quote(rt1_recurrenceRule)` blobs; both match).

And the result SAYS what it inherited:

> the to-do's own deadline came with it: every occurrence is due 3 days after its start — pass `--deadline` (or `--start-days-earlier`) to set a different one

with the landed-rule echo reading *"the series repeats every week; the first occurrence is 2026-07-09, with a deadline 3 days later"*.

## 3. The boundaries — each one measured, not reasoned

| cell | request | landed | verdict |
| --- | --- | --- | --- |
| `cli` | *(no deadline flags)* | `ts=-3`, `icStart=2026-07-09`, deadlined | inherits the seed's geometry = the GUI's own |
| `override` | `--deadline --start-days-earlier 7` | `ts=-7`, `icStart=2026-07-09`, `of=[{wd=4}]` | the CALLER's geometry wins; the anchor moves to the new due date (Jul 16, a Thursday) |
| `zero` | `--deadline --start-days-earlier 0` | `ts=0`, `icStart=2026-07-09`, deadlined | "due on its start date" — the pre-filled **3** is TYPED AWAY, which is why the recipe now drives a named offset even when it is zero |
| `backwards` | seed `start 2026-07-12`, `deadline 2026-07-09`; no flags | `ts=0`, `icStart=2026-07-12`, template deadline sentinel present | a deadline BEFORE the start is not inherited — the dialog discards it and anchors on the start (S12 / [oddities §31](../things-app-oddities.md)) |
| `control` | deadline-free seed, no flags | `ts=0`, `icStart=2026-07-09`, **not** deadlined | unchanged behavior — the regression guard |

Every cell exited **0**.

## 4. The routed arm — the same shapes through the deputy

`RC_DIST=dist GUEST_CELLS=lab/guest/dlseed1-cells.sh bash lab/scripts/stage5-rc-run.sh` on golden-v4h (helpers 1.4.0, `helpers-enabled true`, NORMAL CLI syntax only):

```
ok   [1] 10-inherited  — exit 0, ts=-3 icStart=2026-07-09 deadlined=yes   (6,570 ms)
ok   the inherited deadline is disclosed
ok   [2] 20-override   — exit 0, ts=-7 icStart=2026-07-09 deadlined=yes   (4,110 ms)
ok   [3] 30-zero       — exit 0, ts=0  icStart=2026-07-09 deadlined=yes   (5,230 ms)
ok   [4] 40-control    — exit 0, ts=0  icStart=2026-07-09 deadlined=no    (3,320 ms)
ok   [5] 50-closedwin  — exit 0, ts=0  icStart=2026-07-09 deadlined=no    (3,494 ms)
# DLSEED1 routed arm: GREEN (5 cells)
```

## 5. §closed-window — the reopen rung on the dialog-class side, and what a ⌘W actually leaves behind

The 2026-09-05 ruling extended LOCKSCR2's normalization rung to the promote composites' pre-seed preflight. The cell that goes with it (`closedwin`, both arms): ⌘W the Things window on an unlocked guest, then promote.

```
standard windows after ⌘W:                        0
reachability counts (thingsAs thingsAx allAx):    0 1 1
promote:                                          exit 0
standard windows after the promote:               1     (left open)
```

**The measurement worth keeping is the middle line.** `thingsAx` is every AX window of the process — **including the background placeholder Things keeps when you close its window** — so a ⌘W'd window still reads `thingsAx = 1` and the reachability gate says *reachable*. The pre-seed rung therefore does not fire here, and it does not need to: the drive's own `things:///show` reveal puts a real window back, the promote lands, and the window is left open.

That is why the sidebar drive needed its own rung and the dialog class does not hit the same wall: the drag's census wants a window with LISTS in it (the placeholder has none), while the reachability probe only counts windows. The extended rung stands for the two states that DO refuse, neither of which a ⌘W can stage in a clone:

- a **session**-scope verdict (`thingsAx = 0, allAx = 0`) on a session the lock probe has proven `unlocked` — which used to refuse with *"the Mac's screen is locked, or a full-screen app is covering the desktop"* about a Mac we had just proven unlocked;
- a **`no-window`** window-scope verdict (`thingsAx = 0`, other apps have windows) — Things running with no AX window at all.

Both are unit-locked in `test/engine/write-promote-clone.test.ts` (reopen once, proceed, disclose; never on an `unknown` session; never for an `other-space` window; refuse if the reopen yields no window).

## 6. What this leaves open

- **The `--deadline`-alone spelling on a deadline-free seed** is unchanged and unprobed here (it is the ordinary `add-repeating` geometry, DBLSPAWN1).
- **After-completion + an inherited deadline** is deliberately NOT asserted at the offset level: the app clamps that field to `period − 1` by silent substitution (DEFAULTS2 §clamp, [oddities §32](../things-app-oddities.md)), so the promote carries the deadline and leaves the offset to the app rather than predicting a clamped value or refusing a shape the GUI accepts. A cell that measures the clamped landing for a PROMOTE (rather than an add) would close it.
- **The seed-shaping skip** (the clone is re-scheduled only when the dialog's own anchor law does not already put it on the drive date) is exercised by every cell above — the inherited-deadline cells take the skip — but its own A/B (`with` and `without` the skip, byte-comparing the landed rule) was not run separately.
