# CHORDMH1 — `project.move-heading`, restored on the arrow-chord vector

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`chordmh1-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-chordmh1.sh`](../../lab/scripts/research-chordmh1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordmh1.sh setup     # clone + boot + airgap + clock pin + ship the CLI + AX kit
                                                              … gate              # THE DELIVERY GATE — run first, alone
                                                              … ship              # rebuild + re-push dist/ (cert runs the SHIPPED code)
                                                              … cert              # the shipped op through the production CLI
                                                              … boundary          # the deliberate declined chord
                                                              … teardown
```

This is a **BUILD certification**, not a probe campaign. [HEADORD1](headord1-heading-order.md) discovered the affordance and characterised it; the maintainer endorsed shipping on it (2026-08-25: *"I fully endorse using this to move headings. This seems far less dangerous than changing containers, and I really like that this can be done without foregrounding the app."*). What shipped is `project.move-heading` on the **ui** vector, driving the app's own heading-order key chords as a closed loop against the database.

---

## The headline

| | |
|---|---|
| **Delivery** | **BACKGROUNDED** — the complete gesture runs with Things never activated and Finder frontmost throughout (§1) |
| **Certification** | 9/9 arms green through the production CLI (§3), children byte-identical on every one, **one chord per move** |
| **Beeps** | **0** across every cell except the deliberate boundary probe, which produced exactly the 1 it was fired to produce (§4) |
| **One law corrected** | HEADORD1's "the moved heading's `index` is rewritten" is direction-dependent — a ⌘↓ rewrites the SIBLING being passed, not the mover (§2). Found by the shipped verifier, on the first run |

---

## §1 — The delivery gate

HEADORD1 cell 1h2a landed a `CGEventPostToPid` chord with Finder frontmost, but it had **activated Things first** and only then backgrounded it — so it proved the chord reaches a backgrounded app, not that the whole gesture can be performed without ever touching the user's focus. This cell closes that gap. Things is launched with `open -g` and **never activated at any point**; the frontmost app is read back at every stage.

```
stage 0  baseline (Things launched with open -g, never activated)   frontmost = [Finder]
stage 1  reveal:  open -g things:///show?id=<project>                frontmost = [Finder]
stage 2  select:  the SHIPPED select-heading-row primitive, 3rd row  returned OK
                                                                     frontmost = [Finder]
stage 3  chord:   CGEventPostToPid, key 126, flags 0x100000 (⌘↑)
         G1 < G2 < G3 < G4 < G5   ==>   G1 < G3 < G2 < G4 < G5       frontmost = [Finder]
stage 4  a SECOND chord on the same selection, no re-select
         G1 < G3 < G2 < G4 < G5   ==>   G3 < G1 < G2 < G4 < G5
stage 5  ⌘⌥↓ (key 125, flags 0x180000)
         G3 < G1 < G2 < G4 < G5   ==>   G1 < G2 < G4 < G5 < G3       frontmost = [Finder]

*** BACKGROUND DELIVERY CONFIRMED ***
BEEP-SENTINEL [gate]: 0 alert beep(s), 6 marks — clean
```

**Verdict: ship background delivery.** The recipe carries **no `activate` step** — deliberately, and it is the only ui-vector recipe that can say so about a whole gesture. Stage 4 also re-confirms that the selection FOLLOWS the row it moves, which is what lets a multi-hop move cost one positional walk instead of one per hop.

Disruption tier: **0/1** (a background launch at most). For comparison, the same heading's cross-project move (`move-heading-to-project`) is tier 3 — it activates the app, opens a popover and a detached picker window.

---

## §2 — The law, corrected: which row gets renumbered

HEADORD1 §2 recorded the write as *"the moved heading's `index` is rewritten; no sibling is renumbered"*, measured on a ⌘↑ (cell 1g1: `K3` moved from `-81` to `-357`, slotting between `K1` and `K2`). The shipped op asserts that law per chord, and **arm 2 of the first certification run failed it** — cleanly, with the drive stopped and the honest report:

```
⌘↓ also rewrote the position of heading SmeqTNLvMd8s8KuRnq9JQ1, which the move never named
```

The measurement behind it:

| arm | chord | before (`title=index`) | after |
|---|---|---|---|
| 1 | ⌘↑ (C up one) | `A=-532 B=-246 C=0` | `A=-532 B=-246 **C=-343**` |
| 2 | ⌘↓ (A down one) | `A=-543 B=-201 C=0` | `A=-543 **B=-1152** C=0` |
| 3 | ⌘⌥↑ (C to top) | `A=-335 B=-197 C=0` | `A=-335 B=-197 **C=-686**` |
| 4 | ⌘⌥↓ (A to bottom) | `A=-394 B=-251 C=0` | `**A=593** B=-251 C=0` |

So the corrected law:

> **A chord rewrites exactly ONE heading row's `index`, and which row it is depends on the direction.** Moving a heading UP rewrites the MOVER (it takes a value between its new neighbours). Moving one DOWN rewrites the SIBLING it passes (that sibling takes a value below the mover, which is left byte-identical). The ⌘⌥ endpoint chords rewrite the MOVER. In every case exactly one row is renumbered, it is always a row the gesture passed over, and every other heading — plus every child row — is byte-identical.

It is the same shape AXDRAG1 recorded for the sidebar drag (*"a drag may renumber a NEIGHBOUR rather than the dragged row"*), and the same conclusion follows: **assert relative order, and assert that exactly one row moved — never assert which one on the wrong side of the swap.** HEADORD1 is not amended (evidence docs are immutable snapshots); it simply never fired a ⌘↓ with the index dump on.

Two things worth recording about how this was caught. It was caught by the **shipped** verifier, not by a probe — the per-chord assertion inside the driver, on the very first live run, with zero mutation beyond the (correct) order change and an error message that named the exact row and the exact chord. And the drive **stopped** rather than continuing from a state it could not vouch for, which is the whole point of the closed loop: the alternative posture would have shipped a green op resting on a law that is half true.

---

## §3 — Certification: the shipped op through the production CLI

Every arm seeds a fresh three-heading project (`A`, `B`, `C`, two synthetic children each) and drives `things project move-heading … --dangerously-drive-gui --json` in the guest, then reads the heading order, every heading's raw `index`, and every child's `(heading FK, index)` back out of SQLite.

| arm | request | order after | exit | chords | children | heading indexes |
|---|---|---|---|---|---|---|
| 1 | `C --before-heading B` (±1 up) | `A < C < B` | 0 | **1** | INTACT (6/6, FK + index byte-identical) | only `C` rewritten (`0 → -394`) |
| 2 | `A --after-heading B` (±1 down) | `B < A < C` | 0 | **1** | INTACT | only `B` rewritten (`-205 → -820`) — §2 |
| 3 | `C --first` (to-top, 2 slots) | `C < A < B` | 0 | **1** | INTACT | only `C` rewritten (`0 → -881`) |
| 4 | `A --last` (to-bottom, 2 slots) | `B < C < A` | 0 | **1** | INTACT | only `A` rewritten (`-563 → 661`) |
| 5 | `A --first`, already first | unchanged | 0 | **0** | INTACT | none rewritten |
| 6 | `C A --before-heading B` (a BLOCK of two) | `C < A < B` | 0 | **1** | INTACT | only `C` rewritten (`0 → -1110`) |
| 7 | `--dry-run` | unchanged | — | 0 | — | ZERO MUTATION |
| 8 | no `--dangerously-drive-gui` | unchanged | 4 | 0 | — | ZERO MUTATION (`H-UI-DRIVE`) |
| 9 | a project holding an ARCHIVED heading | unchanged | 4 | 0 | — | ZERO MUTATION (`H-HEADING-ORDER`) |

**Every certified move cost exactly one chord.** Arms 3 and 4 are endpoints, taken with the one-dispatch ⌘⌥ chords rather than a two-hop walk. Arm 6 is the same shortcut doing double duty — placing `C` at the top also puts `A` in its target slot, so a two-heading block move is one chord as well. Arm 5 sends none at all: the driver reads the order first and finds nothing to do.

Two live defects were found by these arms before they went green, both worth recording because both were found by the shipped machinery rather than by a probe:

* **The law correction of §2** — arm 2 refused on the first run, cleanly, naming the row and the chord.
* **A wrong movee set.** After §2 narrowed `untouched` to "bystanders the move never passes over", the compile was still deriving the driver's movee set as *everything not untouched* — which now wrongly licensed chording a bystander whose position merely shifts. A `--last` move consequently chorded three headings instead of one (still landing the right order, which is exactly why it needed catching). The movee set is now the caller's list verbatim, and a regression test pins it.

Arm 9 is the archived-heading fence. The chord vector addresses a heading row POSITIONALLY (the Nth selectable row in the rendered project view whose to-do readback is empty — HEADCERT1), and whether Things renders a completed/canceled heading in the project view is **not measured**. One anywhere in the project therefore makes every ordinal in the plan unvouchable, so the whole move refuses:

```
this project has 1 completed/canceled heading(s) (DnjqjV6JB66PJHpK2UKWKs), and heading order
is driven by selecting rows positionally in the project view — an archived heading makes every
position ambiguous
```

This is the over-caution direction the [harness §AX-drive scrutiny](harness.md) law requires, and it retires the old `#V11` reopen-disclosure policy along with the wire it described: the chord can never reopen an archived heading, because it never runs in a project that has one.

---

## §4 — The boundary decline, and the beep ledger

The shipped op computes its hop count from the database, so it should never provoke a declined chord in normal operation. This cell fires one **by hand** to confirm the decline is still what HEADORD1 measured and that the driver's progress guard would see it: a fresh three-heading project, the FIRST heading selected, one raw ⌘↑.

```
select the FIRST heading: OK
after ⌘↑ on the TOP heading:
  order   : N1 < N2 < N3  ==>  N1 < N2 < N3     (unchanged)
  indexes : UNCHANGED
  children: UNCHANGED
BEEP-SENTINEL [boundary]: 1 alert beep — `boundary cmd-up at top`
```

Zero mutation, one beep — exactly the declined-chord signature. In the shipped driver that same non-delta is the **progress guard**: the chord is not re-sent, the drive stops, and the refusal names the boundary and how many earlier chords did land.

| cell | marks | beeps | attribution |
|---|---|---|---|
| gate | 6 | **0** | — |
| cert (9 arms) | 10 | **0** | — |
| boundary | 2 | **1** | `boundary cmd-up at top` — the one deliberate decline |
| **total** | **18** | **1** | **the single beep was the one the campaign fired on purpose** |

Every normal-path drive is silent. That is the beep-sentinel doctrine's pass condition, and it is the direct payoff of computing the move count from the pre-state rather than discovering it.

---

## §5 — What shipped

* **`src/write/vectors/ui-chord.ts`** — the closed-loop driver. Reads heading order + a child-containment digest from the database, plans ONE chord, posts it, re-reads, and asserts three things before planning the next: the order is exactly what the chord aimed for, exactly one heading's `index` moved and it is one the gesture passed over, and the child digest is byte-identical. A chord that moves nothing stops the drive naming the boundary; a chord that lands elsewhere stops it naming where.
* **The step schedule** (`planChordStep`). The obvious "put `target[i]` into slot `i`" walk is wrong here, because `target[i]` is very often a heading the caller never named (asking to move `A` down one produces a target whose first element is the bystander `B`), and the obvious repair — push whichever movee sits at slot `i` down — thrashes forever when two movees sit side by side. The shipped rule fixes the first mismatch from the row's own side: if `target[i]` is a movee it is necessarily below slot `i`, so step it up; if it is a bystander, every row between slot `i` and its position is provably a movee, so push the one directly above it down past it. Both branches strictly reduce a non-negative distance. Endpoint shortcuts run first.
* **The op** — `project.move-heading` keeps its name, params (`project`, `headings[]`, `placement`) and both surfaces (`things project move-heading`, MCP `heading` action `move_heading`, and the universal `things reorder` dispatch). It gains the standard two-key ui gate (`ui.enabled` + `--dangerously-drive-gui`) and the SESSGATE session-reachability preflight, and it **loses its AppleScript surface entirely** — the private-reorder matrix entry is deleted, not merely gated, because no reorder spelling on any vector addresses a heading at all (HEADORD-b).
* **The verify oracle** — an `ordering` delta over the full target heading order, plus a new `unchanged` clause (every heading the move never passes over must hold its EXACT prior rank) and a `frozen` clause per child of a moved heading (heading FK intact, `userModificationDate` unbumped).

---

## §6 — What was NOT probed

* **On-device certification** — everything here is `lab-certified` ([ui-certification-runbook](ui-certification-runbook.md)).
* **Whether Things renders an ARCHIVED heading in the project view.** The op refuses that whole class rather than find out; measuring it is the one thing that would lift the fence.
* **Projects larger than five headings.** The positional selection walk costs ~0.25 s per row probed, so wall time grows with the project; nothing about the law depends on size, but the cost was not measured past the fixtures here.
* **Multi-row selection** — whether the chords move a multi-heading selection as a block (HEADORD1 left this open too; the shipped driver never selects more than one row).
* **The TO-DO half.** HEADORD1 measured, incidentally, that the identical chord family reorders loose project to-dos. That is a separate campaign and nothing here is wired to it.
* **Cloud sync behaviour** of a chord-driven `index` write (airgapped clone).
