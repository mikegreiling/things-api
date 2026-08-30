# AXDRAG5 — the field stall: the tall-section wall, the honesty bug, and the sidebar-chord answer

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`axdrag5-lab`), destroyed at the end. All fixtures synthetic. Driver: [`lab/scripts/research-axdrag5.sh`](../../lab/scripts/research-axdrag5.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-axdrag5.sh setup   # clone + boot + airgap + clock pin + shipped bundle
                                                            … seed        # the field-shaped sidebar
                                                            … census      # rendered rows, section heights, snapshot cost
                                                            … empty       # the control move (small sections only)
                                                            … wall        # the move whose path crosses the oversized section
                                                            … chord       # ⌘-arrow chords on a sidebar AREA row
                                                            … chordclick  # the same, with the row HID-clicked first
                                                            … reship      # redeploy dist (re-run against the fixed driver)
                                                            … teardown
```

**Why.** A field failure on the maintainer's workstation (Things 3.23.2, macOS 15.7.7): `things area reorder <A> --before <B> --dangerously-drive-gui` ground for **332 s**, moved the subject four sidebar slots, then aborted claiming *"no drop slot toward the destination fits the visible sidebar — the viewport is too small to make progress. No sidebar change was left behind"* and reported `verify-failed:silent-noop` / *"a follow-up re-read found no landed change"*. Both claims were false. Issue #658.

**The correction that reframed the campaign.** The first diagnosis blamed "archived areas" — rows holding an index slot without rendering. **There is no such thing.** Things has no area-archive concept; the `(archived)` in the field data was part of the user's own area *titles*, and those areas render as ordinary sidebar rows. `TMArea` is `uuid, title, visible, index, cachedTags, experimental` — no status, no trash ([schema-v26](../atlas/schema-v26.md)) — and the field DB carried `visible = NULL` on every row. Nothing was hidden. The real mechanic is geometric, and this campaign measures it.

---

## The answers, in one table

| Cell | Question | Verdict |
|---|---|---|
| **census** | what does a real sidebar render per area, and what does one snapshot cost? | **An area's SECTION = its row + every project row Things draws under it, and one section can be ~2× the viewport.** A 24-project area measured **616 pt / 26 rows** against a **346 pt** viewport. One shipped `sidebar-snapshot` costs **~3.4 s** on an 80-row sidebar. |
| **wall** | can the shipped ladder cross a section taller than the viewport? | **NO — structurally, and it is not a viewport-size problem.** Both shipped rungs need the grab point and the drop boundary visible AT ONCE; a section taller than one drag's usable span can never be crossed, one hop at a time or otherwise. Reproduced the field message verbatim. |
| **wall (partial)** | what does the failure leave behind? | **A real, visible, synced partial move** — 3 hops, a recovery drag that did not verify, and a one-slot residue, reported as a failure. |
| **empty** | is the certified geometry unaffected? | **YES.** A move crossing only small/empty sections succeeds through the normal ladder (before AND after the fix). |
| **chord** | **CHORD2 §11's open cell** — do the ⌘-arrow reorder chords work on SIDEBAR rows? | **NO, decisively.** Four chords × two delivery routes = 8 dispatches, **zero `TMArea` index delta, one decline beep each (1:1)**. The sidebar pane cannot even take keyboard focus. `area.reorder` cannot migrate to the chord vector. |
| **tie law** | does the `(index, uuid)` ASC sidebar law hold when EVERY area is tied? | **YES** — with all 14 areas at `index = 0`, the rendered order matched `(index, uuid)` ASC exactly, and the first drag materialized all 14 (AXDRAG1-a/AXDRAG3 reconfirmed under 3.23). |

---

## The fixture (synthetic)

Twelve seeded areas plus the golden's two, 37 projects, sized so the sidebar mirrors the field shape. Window **935×420** (the AXDRAG2 multi-hop window), sidebar viewport **240×346 @ y 63**.

| area | project rows | note |
|---|---|---|
| LAB-AREA-B, Lambda, Iota, LAB-AREA-A, Beta, Alpha, Gamma | 0–3 | ordinary sections |
| **Eta** | **24** | **THE WALL** |
| Mu, Kappa, Delta, Theta, Epsilon, Zeta | 0–4 | ordinary sections |

Areas were seeded one `make new area` call at a time; **all 14 landed at `index = 0`** (AXDRAG1's unmaterialized state), and the rendered sidebar order matched `(index, uuid)` ASC exactly — the AXDRAG3 tiebreak law, measured here at a full 14-way tie rather than the 3-way ties AXDRAG4 used.

## §1 — census: the section law, and what a snapshot costs

The sidebar table is the narrow (`w = 240`) `AXTable` under **scroll area 2** of the standard window; the content table (`w = 697`) is scroll area 1. At 935×420 the sidebar exposed **80 table rows**, **14 of 14 area rows resolved** (off-viewport rows expose valid virtualized frames — AXDRAG1 reconfirmed).

```
viewport: y=63 h=346   (usable single-drag span = h - 24 = 322)
area            top   height   rows  fits?
LAB-AREA-B      360       64      3    yes
Lambda          424      112      5    yes
Iota            536       40      2    yes
LAB-AREA-A      576       88      4    yes
Beta            664       40      2    yes
Alpha           704       88      4    yes
Gamma           792       40      2    yes
Eta             832      616     26 *** NO — WALL ***
Mu             1448       64      3    yes
Kappa          1512       40      2    yes
Delta          1552       40      2    yes
Theta          1592       40      2    yes
Epsilon        1632      112      5    yes
Zeta           1744      120      5    yes
```

**The section law.** A sidebar area occupies its own row PLUS every row Things renders beneath it. Section height is therefore unbounded by anything the driver controls, and it is invisible to a fixture that seeds bare areas — which is exactly what AXDRAG1/AXDRAG2/AXDRAG4 did. Eta's 616 pt against a 322 pt usable span is a **1.9× wall**.

**Snapshot cost — the other half of the grind.** Three consecutive shipped `sidebar-snapshot` runs on this 80-row sidebar: **3.48 s / 3.38 s / 3.34 s** (5,779 bytes of JSON). The script walks every row and concatenates descendant static text to depth 6, so the cost scales with the WHOLE sidebar, not with the area count. The ladder takes one snapshot per hop plus up to `MAX_SCROLL_ITER = 18` per `scrollUntil` call (two such calls per hop) — dozens of snapshots per move. A successful control move here cost **125 s**; the field's 332 s over two hops on a ~150-row sidebar is the same number, scaled. It is very likely also what #651 hit from the other side: there the first snapshot never returned inside `STEP_TIMEOUT_MS = 30_000` and the drive refused with *"the sidebar did not resolve (is the window open and the sidebar visible?)"* after 33.5 s — on a sidebar that was plainly open.

## §2 — wall: the field failure, reproduced

`area reorder Zeta --before Gamma` — the path crosses Eta. Through the SHIPPED CLI, guest DB asserted before and after:

```
before: … Alpha < Gamma < Eta < Zeta < Mu < …
verify-failed:silent-noop after 30s
  "no drop slot toward the destination fits the visible sidebar — the viewport is
   too small to make progress. No sidebar change was left behind after 1 hop(s)."
after:  (unchanged)          area count PASS · assignments PASS
```

The field message, verbatim. The refusal is *technically* reachable-through-a-true-statement — no drop slot did fit — but it attributes the geometry to the window size, which no window size can fix: the wall is 616 pt of rows, and the remedy is to collapse the area or drag by hand.

**The partial-move variant** (`Epsilon --before Gamma`, a subject four slots further down, so the ladder hops across the small sections first before meeting Eta):

```
verify-failed after 75s, 3 hops
  "… RECOVERY DID NOT VERIFY: the area may be at an intermediate position after 3 hop(s)"
after:  … Delta < Epsilon < Theta      (Epsilon and Theta swapped — a one-slot residue)
```

So a failed move leaves a real, user-visible, syncing change behind — and the recovery drag is defeated by the same wall it was trying to undo.

## §3 — the honesty bug (independent of the geometry)

Two layers claimed "nothing landed" without checking.

**(a) `src/write/pipeline.ts`, the transport-failure branch.** After a nonzero-exit drive it re-verifies, and on `recovery.kind !== "ok"` it fell through to a **hardcoded** `silent-noop` with *"a follow-up re-read found no landed change"* — discarding the re-verify's own verdict. For the field record that verdict was `mismatch` (`assertedMovement === true`: the subject's rank had moved off its captured pre-value). `silent-noop` tells a caller the app changed nothing and a retry is safe; the truth was a partial move already on disk and syncing. **Fixed**: the branch now shapes its reason from the recovery outcome. The `Epsilon` run above, driven by the fixed build, reported:

```
verify-failed:mismatch —
  "… a follow-up re-read found the app DID change: part of the requested change landed
   before the failure, but the end state is not the one that was asked for. Nothing was
   rolled back — re-read the target … before retrying, or the retry will compound the
   partial change."
```

**(b) `src/write/vectors/ui-drag.ts`, `refuseOrRecover()`.** Its early return was `if (!orderChanged || hasRankTies(pre))` → *"No sidebar change was left behind"*. A tie is a legitimate reason to skip the **recovery drag** (the restore anchor is ambiguous), but it short-circuited past `orderChanged` and asserted the "no change" sentence anyway. Every never-dragged area sits at `index = 0`, so ties are the NORM on real data — the field DB had two, which is why the false claim fired there and not in this clone (whose indexes were materialized by then). **Fixed**: the tie now suppresses only the recovery, and the refusal reports where the area actually ended up.

## §4 — chord: CHORD2 §11's open cell, answered NO

The hope was that the ⌘-arrow reorder chords — one-row `index` write, backgrounded, tier 0, no pointer (CHORD2) — reach sidebar rows, which would retire the drag ladder entirely and make section height irrelevant. They do not.

**Arm A — AX `select` on the sidebar row, chords via `CGEventPostToPid`, Finder frontmost.** The `select` action navigates (window title `Today` → `Kappa`) and the row reports `AXSelected`. Then, per chord: **zero `TMArea` index delta**, tier 0 clean, and **4 alert beeps for 4 chords — exactly 1:1** (the CHORD2 §6 decline signature: the key reached Things and Things refused it).

**Arm B — the row HID-clicked first (Things frontmost), so the pane is genuinely engaged.** ⌘↑ / ⌘↓ / ⌘⌥↑ / ⌘⌥↓ via `CGEventPostToPid`, then ⌘↑ / ⌘↓ again via a frontmost System Events keystroke: **six dispatches, zero index delta, one decline beep each.**

**Why — the sidebar refuses keyboard focus at all:**

| probe | result |
|---|---|
| `AXFocusedUIElement` after clicking a sidebar row | the **content** table (`w=697`), never the sidebar (`w=242`) |
| `set focused of (sidebar table) to true` | accepted without error, focus **stays** on the content table |
| Tab-key focus cycling | lands on an `AXTextArea`, never the sidebar |
| plain ↓ (no modifier) after the click | sidebar selection **does not move** (`selected` row unchanged) |
| sidebar table `AXUIElementCopyActionNames` | **(none)** |
| sidebar row `AXCustomActions` | attribute **present but EMPTY** (count 0) on every row |

So the chord family is not "unsupported for areas" so much as **undeliverable**: the sidebar is not a keyboard-focusable pane, the chords are evaluated against the content list, and the content list (an empty area view) declines with a beep. There is no AX action and no VoiceOver custom action to press instead.

**Consequence.** `area.reorder` stays on the drag vector. The tall-section geometry is a permanent limitation of it, not a bug to be engineered around — so it earns an honest, immediate refusal rather than a five-minute grind. Reordering an area past a tall section is a mouse-only operation in Things 3.23.

## §5 — the fix, certified in-clone

Rebuilt, reshipped (`reship`), re-ran the same cells:

| cell | before | after |
|---|---|---|
| `wall` (`Zeta --before Gamma`) | 30 s, "the viewport is too small", 1 hop | **6 s**, no gesture at all, names Eta / 25 rows / 616 pt vs 346 pt, offers collapse-or-resize-or-hand-drag |
| `wall` (`Epsilon --before Gamma`) | 75 s, 3 hops, failed recovery, **one-slot residue left behind** | **6 s**, no gesture, **no residue** |
| `empty` control (`Theta --before Mu`) | ok, ladder | **ok, 38 s, ladder** — placement reached, count + assignments invariant |

The pre-flight measures the tallest section inside the travel span from the FIRST snapshot, refuses only when that section exceeds one drag's usable span AND the snapshot actually resolved rows inside it (so a partially-materialized AX tree cannot fabricate a wall out of a gap), and leaves every crossable geometry to the certified ladder.

## App oddities filed

[§28 — the sidebar is keyboard-unreachable and AX-inert](../things-app-oddities.md): no focusable pane, no table actions, an empty `AXCustomActions` on every row, and the reorder chords that work everywhere else decline 1:1. Area order is mouse-only, and automation has no non-pointer route to it.

## What remains

- **On-device confirmation.** The tall-section refusal and the honest partial-move reporting are certified in-clone; the maintainer's own re-run of the original field command is the real-hardware confirmation ([ui-certification-runbook](ui-certification-runbook.md)).
- **Snapshot cost is untouched.** ~3.4 s per snapshot on 80 rows is the shared root of this grind and of #651. The script shape is AXDRAG1-certified, so it was not re-cut here; profiling it (a cheaper row walk, or a row-count-bounded text collection) is filed as follow-up work, with #651 as its acceptance test.
- **Rung 2 stays dark.** Scroll-while-held would cross a tall section in one gesture, but it ships disabled for the oddities §9 AX-mirror ghost, and nothing here changes that trade.
