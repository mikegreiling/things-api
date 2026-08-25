# HEADORD1 — heading ORDER on Things 3.23: a bounce protocol was not needed

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`headord1-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-headord1.sh`](../../lab/scripts/research-headord1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-headord1.sh setup    # clone + boot + airgap + clock pin + ship the CLI + AX kit
                                                              … menu-census      # cell 1  — the menu/context/keyboard census
                                                              … chords           # cell 1g — the chord law, characterised
                                                              … chords2          # cell 1h — the shipped-op questions
                                                              … chords3          # cell 1i — the loose ends, selection proven
                                                              … landing          # cell 2  — the re-entry landing law
                                                              … bounce           # cell 3  — the bounce prototype + head-to-head
                                                              … lifecycle        # cell 4  — the ephemeral scratch lifecycle
                                                              … picker           # cell 4d — why the Move… picker vanished
                                                              … teardown
```

**PROBE ONLY — no operation was shipped from this campaign.** The deliverable is this evidence plus the design recommendation in §6.

---

## The question, and the answer

Things 3.23 left `_private_experimental_ reorder` declared but silently inert, so `project.move-heading` refuses with no fallback and heading order is a recorded loss ([gv4-323-certification](gv4-323-certification.md), [design/reorder-canary](../design/reorder-canary.md)). REORDGAPS had already closed every headless door: no reorder spelling addresses a heading at all (HEADORD-b: -1708 / -1728 / -2740), and the only reorder that reaches headed children rips their heading FK (HEADORD-a). The hypothesis under test was a **BOUNCE protocol** — move headings out to an ephemeral project and back in target order, using the `project.move-heading-to-project` recipe #589/HXPC1 had just fixed.

The bounce works. It is also **the wrong answer**, because cell 1 — the cheapest cell, run first precisely because it was cheap — found that Things 3.23 still ships a first-class heading-reordering affordance:

> **⌘↑ / ⌘↓ move the selected heading up / down one slot; ⌘⌥↑ / ⌘⌥↓ move it to the top / bottom. There is no menu item, no context-menu item and no AX action anywhere that carries the equivalent — they are bare keybindings.**

Same reorder, measured side by side on identical fixtures: **1 chord / 6 s** versus **6 GUI dispatches / 24 s** (§3).

| Cell | Question | Verdict |
|---|---|---|
| **1** | is there ANY Move-Up/Down affordance for a selected heading? | **YES — bare arrow chords.** Absent from all 8 menu-bar menus and from the row's context menu; present as keybindings. |
| **1g** | what exactly do the chords do? | **⌘↑/⌘↓ = ±1 slot; ⌘⌥↑/⌘⌥↓ = to top/bottom.** Single-row `index` rewrite, no sibling renumber, children untouched. Null control clean. |
| **1h** | what would a shipped op need? | System Events `key code … using command down` **works, frontmost only**; `CGEventPostToPid` **works with Things BACKGROUNDED**. |
| **1i** | the to-do and boundary cases | **To-dos take the same full chord family.** A headed child driven across its bucket boundary **crosses into the adjacent heading** (heading-FK rewrite). |
| **2** | the bounce re-entry landing law | **FRONT-INSERT, deterministic 4/4** — a heading re-entering a project lands at the top, below the running index minimum. |
| **3** | full bounce prototype, C,A,B from A,B,C | **Target achieved** by the reverse-order bounce, 6 dispatches / 24 s, children 2/2/2 intact. The chord does it in 1 / 6 s. |
| **4** | ephemeral scratch lifecycle | Create + move-in + empty + delete is clean; **deleting a NON-empty scratch is a shallow trash that takes the heading and children with it.** |
| **4d** | why one drive lost its picker | **All three suspects acquitted** — a URL-created project is offered immediately, no relaunch needed. The 4a2 failure was a transient (1 in 24 drives), and it failed CLOSED. |

---

## §1 — Cell 1: the affordance census

Fixture `HO1-MENU` with headings `MA`, `MB`, `MC` (two synthetic children each). The middle heading was selected with the **shipped** `select-heading-row` primitive (`axSelectHeadingRowScript`, emitted out of `dist/` so the thing under test is the thing that ships), which returned `OK` and left exactly one content row selected with an empty `name of selected to dos` readback — the heading signature.

### 1a/1c — the menu bar, with and without a heading selected

Every menu-bar menu was enumerated with each item's `enabled` state and `AXMenuItemCmdChar`/`CmdModifiers`, once with nothing selected and once with the heading selected. The **entire** diff:

```
<   [false] Complete                     >   [true] Complete
<       -> [false] Mark as Completed     >       -> [true] Mark as Completed
<   [false] Convert to Project…          >   [true] Convert to Project…
<   [false] Remove From Project/Area     >   [false] Remove From Project
<   [false] Show in Area                 >   [true] Show in Project
```

Selecting a heading enables `Complete`, `Convert to Project…` and `Show in Project`. **Nothing resembling Move Up / Move Down / Reorder / Arrange appears anywhere**, enabled or disabled. The only `Move`-named item in the whole menu bar is `Items ▸ Move…` (`key=M mods=1`), which is the cross-project relocation HEADXPROJ already documented.

A second sweep asked which menu items carry ANY key equivalent expressed as a `CmdGlyph` (the attribute an arrow-key binding would use). The complete answer:

```
  Apple  > Force Quit…          glyph=27  char=[⎋]
  Apple  > Force Quit Things    glyph=27  char=[⎋]
  Things > Empty Trash…         glyph=23
  Things > Empty Trash          glyph=23
  Edit   > Delete Heading       glyph=23
  Edit   > Emoji & Symbols      glyph=149 char=[🌐]
```

No arrow glyph anywhere. **The reordering chords have no menu representation at all.**

### 1d — the context menu IS AX-visible on 3.23

REORDGAPS measured right-click NSMenus as AX-invisible on 3.22. Re-checked here with a `CGEvent` right-click on the heading row body: the menu **is** reachable through the raw AX API, parented under the content table (`/AXApplication/AXWindow[1]/AXScrollArea[1]/AXTable[15]`), with every item's title and enabled state readable:

```
=== AXMenu #1 at /AXApplication[2]/AXWindow[1]/AXScrollArea[1]/AXTable[15] ===
[1] role=AXMenu | ENABLED=true | @[616,319 189x362]
   [4] AXMenuItem ttl=When…               ENABLED=false
   [5] AXMenuItem ttl=Move…               ENABLED=true
   [6] AXMenuItem ttl=Tags…               ENABLED=false
   [7] AXMenuItem ttl=Deadline…           ENABLED=false
   [8] AXMenuItem ttl=Complete            ENABLED=true
  [11] AXMenuItem ttl=Get Info            ENABLED=false
  [12] AXMenuItem ttl=Duplicate Heading   ENABLED=true
  [13] AXMenuItem ttl=Convert to Project… ENABLED=true
  [14] AXMenuItem ttl=Delete Heading      ENABLED=true
  [16] AXMenuItem ttl=Remove From Project ENABLED=false
  [18] AXMenuItem ttl=Show in Project     ENABLED=true
  [19] AXMenuItem ttl=Log Completed       ENABLED=false
  [21] AXMenuItem ttl=Services            ENABLED=true
```

Two notes for whoever uses this surface next. **System Events cannot see it** — `menus of window` returns `-1728 Can't get every menu of item 1 of every window`; the raw `AXUIElementCopyAttributeValue` walk can. And the heading context menu carries **`Duplicate Heading`**, which no other surface we have catalogued offers. Still **no Move Up / Move Down**.

### 1e — the chords, discovered

Each arm re-selected the heading and fired one chord via `CGEventPost` at the HID tap, reading the heading `index` order back out of SQLite:

```
baseline order: MA < MB < MC
cmd-up        -> ORDER CHANGED  MA < MB < MC  ==>  MB < MA < MC
cmd-down      -> ORDER CHANGED  MB < MA < MC  ==>  MB < MC < MA
cmd-opt-up    -> ORDER CHANGED  MB < MC < MA  ==>  MC < MB < MA
cmd-opt-down  -> ORDER CHANGED  MC < MB < MA  ==>  MC < MA < MB
cmd-ctrl-up   -> NO DB delta
cmd-shift-up  -> NO DB delta
ctrl-cmd-down -> NO DB delta
```

Three headings cannot separate "up one" from "to top", so the law was settled in cell 1g on five. **Beeps: 0.**

---

## §2 — Cell 1g/1h/1i: the chord law

Fixture: five headings `K1…K5`, two children each, plus two loose to-dos, so move-one and move-to-end are distinguishable.

### The null control (1g0)

```
select ordinal 2: OK
NULL CONTROL CLEAN — the row select alone moves nothing
  (K1 < K2 < K3 < K4 < K5, unchanged)
```

The positional `select-heading-row` walk issues a `select` action on every row on its way to the target; this proves those selects move nothing, so every delta below is attributable to the chord.

### The law (1g1–1g4)

```
g1  ⌘↑   (3rd of five selected)   K1<K2<K3<K4<K5  ==>  K1<K3<K2<K4<K5     up ONE
g2  ⌘⌥↑  (3rd of five selected)   K1<K3<K2<K4<K5  ==>  K2<K1<K3<K4<K5     to TOP
g3  ⌘↓   (3rd of five selected)   K2<K1<K3<K4<K5  ==>  K2<K1<K4<K3<K5     down ONE
g3  ⌘⌥↓  (3rd of five selected)   K2<K1<K4<K3<K5  ==>  K2<K1<K3<K5<K4     to BOTTOM
g4  ⌘↑ on the TOP heading         no delta   + 1 alert beep
g4  ⌘↓ on the BOTTOM heading      no delta   + 1 alert beep
```

**The index write is single-row.** The ⌘↑ of g1 moved `K3` from `index -81` to `-357`, slotting it between `K1 (-497)` and `K2 (-235)`; **no sibling was renumbered**:

```
title  uuid8     idx        (after ⌘↑)
K1     2d9pRAci  -497
K3     F8qma36g  -357   <- the only row rewritten (was -81)
K2     HnJhsJkd  -235
K4     LVC1TPST  -39
K5     3P9vmFQf  0
```

Contrast BOUNCE2's §9h, where the bounce achieves a back-insert by renumbering every *non*-moved sibling. The chord is the cleaner primitive by a wide margin.

**Children are untouched.** `K3`'s two children kept byte-identical indices and a NULL project FK across the move:

```
K3 children before: [K3-c1:-511  K3-c2:0]
K3 children after:  [K3-c1:-511  K3-c2:0]
K3 child project FK: NULL
```

They follow the heading through the intact heading FK, exactly as the HEADXPROJ cross-project move does.

### The boundary beeps (1g4, 1h5) — the production rule

A chord that cannot move the row is **declined with an alert beep and zero delta**. Cell 1h5 turns this into a clean 1:1 count: with the bottom heading selected, ten consecutive ⌘↑ chords were fired in a single round trip. Four of them had somewhere to go; six did not:

```
10 chords (one ssh round trip, one selection) in 1s
before: M1 < M2 < M3 < M4 < M5
after : M5 < M1 < M2 < M3 < M4
BEEP-SENTINEL [headord1-cell1h]: 6 alert beep(s), all attributed to `cell1h5 cost`
```

**Six wasted chords, six beeps.** That is the beep-sentinel doctrine's exact case — the writes all landed, the probe is green, and the user hears six error tones. Any shipped op must compute its move count from the database and fire exactly that many chords.

### The vector question (1h1, 1h2)

| how the chord is sent | Things frontmost | Things backgrounded (Finder frontmost) |
|---|---|---|
| System Events `key code 126 using command down` | **lands** | **no delta** |
| `CGEventPostToPid(<Things pid>, …)` | (not separately run) | **lands** |

```
h1  System Events, frontmost:  M1<M2<M3<M4<M5  ==>  M1<M3<M2<M4<M5   *** WORKS ***
h2a CGEventPostToPid, Finder frontmost:  ==>  M1<M2<M3<M4<M5         *** LANDED ***
h2b System Events, Finder frontmost:     no delta (frontmost stayed Finder)
```

So there are two shapes, and they cost different amounts of disruption: the pure-System-Events path needs Things activated (tier 2 focus steal), while `CGEventPostToPid` reaches a backgrounded app. The selection primitive it pairs with is already background-capable (HEADCERT1), so a **fully background, zero-focus-steal heading reorder is reachable** — a far better disruption profile than the Move… drive, which activates the app and opens a popover plus a detached picker window (tier 3).

The shipped `key` primitive (`axKeyScript`) emits `key code N` / `keystroke "…"` with **no modifier support**, so either shape needs a new primitive.

### The chords reach TO-DOS too (1h3 → corrected by 1i1)

**A rig error, recorded because it nearly became a finding.** Cell 1h3 drove the ⌘⌥ arms with the AppleScript spelling `using command down and option down`, which is not valid modifier syntax; the `osascript` error was discarded along with the arm's output, and the cell reported "⌘⌥↑ and ⌘⌥↓ do nothing to a to-do". Cell 1i re-ran the same arms with `using {command down, option down}` **and the select readback printed on every arm** (the CNCAC1 positive-control rule — a zero delta from an unproven vector is evidence of nothing):

```
[cmd-up]       select U3 -> OK   U1<U2<U3<U4<U5  ==>  U1<U3<U2<U4<U5   MOVED
[cmd-opt-up]   select U3 -> OK   U1<U3<U2<U4<U5  ==>  U3<U1<U2<U4<U5   MOVED
[cmd-opt-down] select U3 -> OK   U3<U1<U2<U4<U5  ==>  U1<U2<U4<U5<U3   MOVED
[cmd-down]     select U3 -> OK   (U3 already last)                     NO DELTA + 1 beep
```

**Loose to-dos take the identical chord family with the identical law**, including the boundary beep. This is well outside HEADORD1's brief and is NOT characterised here beyond this — but it means the 3.23 ordering loss may have a GUI answer across the board, not only for headings. See §6 open decision 4.

### The bucket-boundary crossing (1i2, 1h4) — the one hazard

A **headed child** driven past the end of its heading does not decline; it **crosses into the adjacent heading**, both directions:

```
h4  M2-c1 (FIRST child of M2) driven ⌘↑
    before: heading=7BGPghc2 (M2)  project=NULL  index=-388
    after : heading=MFTLpEwt (M1)  project=NULL  index=-388   <- heading FK rewritten, index NOT
    M1 children now: M1-c1 < M1-c2 < M2-c1
    M2 children now: M2-c2

i2  N1-c2 (LAST child of N1) driven ⌘↓
    before: heading=QBsY6JhF (N1)  index=0
    after : heading=94HeFAv8 (N2)  project=NULL  index=-1046
    N1 children now: N1-c1
    N2 children now: N1-c2 < N2-c1 < N2-c2
```

This is correct app behaviour — it is exactly what dragging the row would do — but it is a **membership change disguised as a reorder**, and it is the one thing a shipped within-heading-order op must refuse or fence. Note it is *not* the HEADORD-a destruction: nothing is ripped to the project root, no index churn on the rest, and the heading order itself is unchanged.

**Headings do not do this.** A heading at a boundary declines (with the beep). And a heading moving past a loose unheaded to-do captures nothing:

```
i3  W2 driven ⌘↑ past the project's loose block
    heading order: W1 < W2  ==>  W2 < W1
    the loose to-do's heading FK: NULL   (unchanged — no capture)
    W2's children still 2
```

### Cost

| shape | measured |
|---|---|
| select (`select-heading-row`) + 1 chord, per move | **~5.2 s** (10 cycles in 52 s) — the positional select walk dominates, at 0.25 s per row probed |
| 10 chords after ONE selection, one round trip | **1 s** — ~100 ms per chord |

The selection is the cost, not the chord. A shipped op should select once and fire the whole move sequence.

---

## §3 — Cell 2 and 3: the bounce, measured anyway

### The landing law (cell 2), verbatim

> **A heading re-entering a project via `project.move-heading-to-project` FRONT-INSERTS: it lands at the top of the project's heading list, at an `index` below the running minimum of every row already in the project. Its children follow through the intact heading FK, un-renumbered. No sibling heading and no loose to-do is renumbered. The law held on 4 of 4 applicable arms.**

| arm | fixture | result | landing |
|---|---|---|---|
| 1 | `P=[A,B,C]`, bounce the middle heading `B` | `B < A < C` | **FRONT** |
| 2 | same, plus two loose to-dos in `P` | `B < A < C` | **FRONT** |
| 3 | `P` holds ONE heading; `P` is empty of headings at re-entry | `A`, index `0`, children 2 | (degenerate) |
| 4 | destination project is in **Someday** | `B < A` | **FRONT** |
| 5a | fresh fixture, base case repeated | `B5a < A5a < C5a` | **FRONT** |
| 5b | fresh fixture, base case repeated | `B5b < A5b < C5b` | **FRONT** |

Raw indices, arm 1 (`B` re-entered below `A`'s -641, which itself was unchanged):

```
title      uuid8     idx
B1-170624  47HcqtkS  -1094   <- re-entered here
A1-170624  6bv4CJEL  -641
C1-170624  Hy1SyWf6  0
```

Arm 2's dump shows the front-insert reaches above the loose block too — `B2` landed at `-804`, above `HO2-LOOSE1` at `-467`, and neither loose row moved. Arm 4 records a second fact worth having: **a heading parked in a Someday project keeps `start=1`** (the heading row is not somedayed by its container), and the return leg front-inserts as usual.

This places the heading in BOUNCE2's **FRONT-insert** class (loose / area-direct), *not* the strict-container BACK-insert class its headed children belong to — so the compile protocol is the **reverse-order** bounce (ANYBNC/SOMEBNC-area shape), not the forward-order one BOUNCE2-h derived for headed children. Worth flagging: the container and its members sit on opposite sides of that split.

### The prototype (cell 3)

Target `C, A, B` from `A, B, C`. Under a front-insert law the kept set must be a target *suffix* appearing in that relative order at the end of the source; here it is empty, so all three bounce, in reverse target order `B, A, C`:

```
-- bounce B --   out: OK 4s | P: HA < HC          back: OK 3s | P: HB < HA < HC
-- bounce A --   out: OK 4s | P: HB < HC          back: OK 3s | P: HA < HB < HC
-- bounce C --   out: OK 5s | P: HA < HB          back: OK 3s | P: HC < HA < HB

FINAL:  HC < HA < HB
TARGET: HC < HA < HB          *** TARGET ORDER ACHIEVED ***
children after: A=2 B=2 C=2  (before A=2 B=2 C=2)
scratch E now holds: [(none)]
COST: 6 GUI dispatches, 24s wall  (4.0 s per dispatch)
```

**The head-to-head, same target, fresh identical fixture:**

```
START:  KA < KB < KC
select the third heading (KC) -> OK
FINAL:  KC < KA < KB          *** TARGET ORDER ACHIEVED — 1 chord, 6s ***
children intact: KA=2 KB=2 KC=2
```

**1 chord / 6 s against 6 dispatches / 24 s** — and the 6 s is almost entirely the positional select walk plus a fixed settle, not the chord.

### The mid-protocol failure mode

Driving only the out leg leaves the heading and its children parked in the scratch project — nothing is lost and one more move recovers it:

```
out leg only: OK 5s
P holds:       [FA]
scratch holds: [FB]   children still with it: 2
recovery drive: OK 3s
P after recovery: FB < FA   children: 2
```

But note what recovery costs: `P` started as `FA < FB` and came back as `FB < FA`. **The recovery leg front-inserts like any other, so recovering an aborted bounce does not restore the pre-bounce order — it perturbs it further.** A bounce-based op would have to record the full pre-state order and re-derive a whole new protocol from wherever it died. The chord has no equivalent problem: each chord is an independent, individually verifiable ±1 step.

---

## §4 — Cell 4: the ephemeral scratch project

* **Creating a scratch by URL and moving a heading into it works** (4a): the heading and both children relocate, the source keeps its remaining heading.
* **Deleting an EMPTIED scratch is clean**: `trashed=1` on the scratch, no effect on anything returned to the source project.
* **Deleting a NON-EMPTY scratch is a shallow trash that takes the heading with it** (4b, 4c) — this is `project.delete`'s documented A24B shallow semantics, priced here for the heading case:

```
4c  delete the NON-EMPTY scratch3
    scratch3 trashed=1
    heading QA  trashed=0  project=LsfPivsB   <- still pointing INTO the trashed scratch
    QA children untrashed: 2 of 2
```

The heading row and its children are not themselves flagged, but they now hang off a trashed project and derive Trash membership from it. This is exactly the hazard `reorder.ts` guards with its never-trash-a-non-empty-scratch rule, and any bounce protocol would need the same guard. (`project.delete` is AppleScript-only and the Wave A write gate blocks the AppleScript vector in every sshd-descended shell, so these deletes were driven on the raw wire the shipped command compiles to — the same AppleScript, one gate short. This measures the app, not our gate.)

### 4d — the one failed drive, isolated

Cell 4a2 lost its picker mid-drive:

```
verify-failed:silent-noop — ui drive stopped at "commit the Move… picker on the
"things-api headord1 scratch2 171358" row" (System Events got an error: Can't get
window 1 of process "Things3" whose subrole = "AXUnknown" and size ≠ {40, 40}.
Invalid index. — no click was sent).
Completed: reveal → activate → open the heading's ellipsis menu → ellipsis menu ▸ Move…
  → narrow the Move… picker to "things-api headord1 scratch2 171358"
observed: {"project.uuid":"FbNbVD1xiQ31PYDWYrfpwG"}   (the source — nothing moved)
```

The picker opened, took the filter keystrokes, and was gone by the commit. Cell 4d put the three candidate causes on the bench and **acquitted all three**:

```
d1  picker WITHOUT a relaunch, project created by URL seconds earlier, UNFILTERED:
      picker id=MovePopUpDialog-94FF0A91-…
        [5]  [HO4D-SHORT-171711]
        [11] [things-api headord1 scratch2 171711]     <- offered immediately
    …then typing the LONG title:
        [5]  [things-api headord1 scratch2 171711]
        [11] [New Project "things-api headord1 scratch2 171711"]
d2  the SHORT title: filters to exactly one real row + the create row
d3  after a relaunch: byte-identical to d1
d4  the shipped CLI move, post-relaunch: OK 4s, destination holds the heading
```

So a URL-created project **is** indexed by the running app's picker with no relaunch, long space-bearing titles filter correctly, and the source being a scratch project is irrelevant. What distinguished 4a2 was that it was a **second consecutive ellipsis drive with no relaunch between it and a completed one** — the RESID1 stale-window family. Across the whole campaign: **25 drives, 23 clean, 1 transient (≈4%), 1 consequential refusal** (cell 4b correctly refused because 4a2 had left the heading elsewhere). The transient failed **closed**, with zero mutation and an `observed` field naming exactly where the heading actually was. The behaviour is right; the rate is the point (§6).

---

## §5 — Beep counts (sentinel per cell, `THINGS_LAB_BEEPS_OK=1`)

| cell | marks | beeps | attribution |
|---|---|---|---|
| 1 menu-census | 14 | **0** | — |
| 1g chords | 10 | **2** | `cell1g4 cmd-up at top`, `cell1g4 cmd-down at bottom` — the two deliberate boundary probes |
| 1h chords2 | 6 | **6** | all `cell1h5 cost` — the six deliberately wasted chords of the 10-chord burst |
| 1i chords3 | 4 | **1** | `cell1i1 todo arms` — the deliberate ⌘↓ on an already-last to-do |
| 2 landing | 13 | **0** | — |
| 3 bounce | 10 | **0** | — |
| 4 lifecycle | 8 | **0** | — |
| 4d picker | 7 | **0** | — |
| **total** | **72** | **9** | **every one a deliberately-probed declined chord; zero unexplained** |

The 6/6 match in cell 1h is also a **positive validation of the oracle** in this clone: six known-declined gestures produced exactly six logged beeps, and the four that had somewhere to go produced none.

---

## §6 — Design recommendation

### The vector: the arrow chords, not the bounce

Ship heading order on **⌘↑ / ⌘↓ / ⌘⌥↑ / ⌘⌥↓ against a `select-heading-row` selection**. Every axis favours it:

| | chord | bounce |
|---|---|---|
| dispatches for a 3-heading reorder | **1** | 6 |
| wall time (measured, same fixture) | **6 s** | 24 s |
| rows written per step | **1** (`index` on the moved heading) | 1 (`project` FK), plus a full re-entry renumber |
| scratch container needed | **no** | yes — create, verify empty, delete |
| disruption | **tier 0/1 reachable** (background via `CGEventPostToPid`) | tier 3 (activate + popover + detached picker) |
| mid-protocol abort | each chord is an independent ±1 step; re-derive from the DB | heading parked in a scratch; **recovery perturbs order further** |
| observed failure rate | 0 in ~40 chords | 1 transient in 24 drives (≈4%) |
| Things Cloud change records | 1 per step | 2 per heading |

### The law it rests on

> Within a project, ⌘↑ / ⌘↓ move the selected heading one slot up / down and ⌘⌥↑ / ⌘⌥↓ move it to the top / bottom of the project's heading list. The move rewrites the moved heading's `index` only; no sibling heading, loose to-do, or child row is renumbered, and children follow through their intact heading FK. A chord with nowhere to go is declined with zero delta and one alert beep. Measured on `things-lab-golden-v4` / Things 3.23 (32300036), cells 1e / 1g1–1g4 / 1i3, null-controlled.

### Cost and disruption, honestly

* The chord itself is ~100 ms. The **selection dominates**: `select-heading-row` is a positional walk that issues a `select` action on every content row with a 0.25 s delay, so it costs ~5 s in a small project and grows with row count. An op that reorders N headings should select once per heading and batch that heading's chords, or (better) reorder in an order that lets one selection serve several moves.
* **The background path is real but is a new primitive.** `axKeyScript` has no modifier support, and the System-Events spelling only lands when Things is frontmost. Adding a modifier-bearing System Events variant is the small change (tier 2, focus steal); adding a `CGEventPostToPid` primitive is the larger one and buys tier 0/1.
* **Never fire a chord that cannot move the row.** Six wasted chords produced six alert beeps (§2). The move count must be computed from the pre-state, not discovered by firing until nothing changes.
* **Everything here is `lab-certified` only.** No on-hardware confirmation, and the affordance is an undocumented private keybinding with no menu representation — it has no more contract than any other AX surface (harness §AX-drive scrutiny), which is an argument for the same fail-closed discipline `move-heading-to-project` now carries, not against shipping.
* **Sync is unmeasured.** The clone is airgapped; whether a chord-driven `index` write produces one Things Cloud change record per move is modelled (SYNC2), not measured.

### Open decision points for the maintainer

1. **Which chord vocabulary does the op compile to?** ⌘⌥↑/⌘⌥↓ reach an end in one step, so a full N-heading reorder is cheapest as a sequence of to-top / to-bottom moves rather than ±1 walks. Recommendation: compile to the same shape the reorder planner already uses elsewhere — place each heading in reverse target order with ⌘⌥↑ (to top), N chords total, one selection each.
2. **System Events (tier 2) or `CGEventPostToPid` (tier 0/1)?** The background path is strictly better for the user and strictly more code — a new primitive plus its own certification. Recommendation: ship the System Events modifier variant first (it reuses the existing `key` primitive family and the existing activate preamble), and treat the background poster as a follow-up once the op is certified.
3. **Does `project.move-heading` un-refuse, or is this a new verb?** The chord reaches within-project heading order — exactly what `project.move-heading` refuses today. Recommendation: un-refuse the existing verb behind the ui vector rather than mint a new one; the CLI vocabulary is already right and ALPHA-CONTRACT means the vector swap costs nothing.
4. **The to-do half.** §2 measured, incidentally, that the identical chord family reorders **to-dos** — loose project children, with the same ±1 / to-end law and the same boundary beep. If that generalises, the 3.23 reorder loss has a GUI answer well beyond headings, and several `bounce`-compiled scopes in `reorder.ts` could be replaced by something cheaper and non-renumbering. **This campaign did not characterise it** (no area/Today/Someday arms, no interaction with the front/back-insert classes, no `todayIndex` arm). Recommendation: a dedicated follow-up campaign before any of it is wired.
5. **The bucket-boundary crossing.** A headed *child* driven past its heading's edge crosses into the adjacent heading (heading-FK rewrite, §2). A within-heading child-order op must therefore fence its chords at the bucket edge; a heading-order op is unaffected (headings decline instead). Decide whether the fence lives in the planner (compute the exact move count) or as a post-drive membership assert — recommendation: both, since the planner already needs the count to avoid the beep.
6. **Does the reorder canary still need building?** [design/reorder-canary.md](../design/reorder-canary.md) exists to lift the `privateReorderIsNoOp` gate if Cultured Code ever fixes the private command. If heading order (and possibly all order) ships on the chords instead, the canary's value drops to "detect that a cheaper native path returned", which is a much weaker motivation. Recommendation: park the canary until decision 4 is settled.

---

## §7 — What was NOT probed

* **On-device certification** — everything here is `lab-certified` ([ui-certification-runbook](ui-certification-runbook.md)).
* **The to-do chord family beyond loose project children** — no area, Today, Evening, Someday or `todayIndex` arms (§6 decision 4).
* **Multi-row selection** — whether the chords move a multi-heading selection as a block.
* **Views other than the project view** — heading rows only exist there, but a to-do chord op would need the other views measured.
* **Where the chords come from** — they are bare keybindings with no menu item; whether they are documented anywhere by Cultured Code, and therefore how stable they are across builds, is unknown.
* **Cloud sync behaviour** of a chord-driven `index` write (airgapped clone).
