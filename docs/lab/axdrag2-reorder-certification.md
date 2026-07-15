# AXDRAG2 — `area.reorder-sidebar` build probes + certification (and the tag.reorder block)

**Verdict (2026-07-15):** the production **`area.reorder-sidebar`** op is **LAB-CERTIFIED** end-to-end through the shipped CLI (`things area reorder-sidebar … --dangerously-drive-gui`) against **Things 3.22.11 / macOS 15.7.7 / DB v26**: rung-1 single drags (both directions), the rung-3 multi-hop floor (3 hops + final drag on a shrunken viewport), to-first/to-last, a verified undo round-trip, and the fail-closed negatives — all DB-asserted with the `TMArea` count and every task's area assignment invariant. **Rung 2 (scroll-while-held) is BUILT and probe-certified but ships DISABLED**: its long-travel form is the strongest trigger of a newly characterized app bug — after drag+scroll churn the sidebar's **AX mirror drops or blanks row elements until Things is relaunched** (oddities §9). **`tag.reorder` is NOT SHIPPED**: the bulletproof chain breaks at its first link — tag rows expose no names and the DB→row mapping is unverifiable whenever `TMTag."index"` ties exist (they always do for never-dragged tags), so a mis-aim could silently re-parent with no reliable recovery addressing.

Ran in ONE disposable clone `axdrag2-lab` of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP on), Accessibility via the AXVM1 rung-b VNC toggle, everything else over SSH. Reproducible: [`lab/scripts/research-axdrag2.sh`](../../lab/scripts/research-axdrag2.sh) (subcommands `setup` / `probe-a` / `probe-b` / `cert` / `tags` / `teardown`; envelopes + probe JSON under the gitignored `lab/artifacts/axdrag2-lab/`). Seeded 23 areas on top of the golden's two (25 total, sidebar ≈ 2.3 viewports) + `Proj-under-Area-{03,08,15}` so area groups carry nested project rows. Companions: [axdrag1-reorder.md](axdrag1-reorder.md) (the geometry evidence base), [native1-spike.md](native1-spike.md) (the HID primitive), [ax-initiative.md](../design/ax-initiative.md) (build item 3), [ui-vector.md](../design/ui-vector.md).

## The design rulings this build implements (Mike + Fable, 2026-07-15, amended)

- **The visibility ladder**: rung 1 = pre-scroll until source + drop boundary share the viewport, then one certified AXDRAG1 drag; rung 2 = **scroll-while-held** (wheel events while the drag is held; **edge-hover auto-scroll was REJECTED** for production — app-controlled velocity is untrustworthy, AXDRAG1-c stays lab-only); rung 3 = the **multi-hop correctness floor** (one viewport per hop, DB assert after EVERY hop, strict-progress infinite-loop guard with one retry, hop cap = ceil(areas ⁄ visible-slots) + 2, honest positional abort — a partially-moved area is benign).
- **No hardcoded pixel geometry**: every aimed coordinate derives from the live AX frames of the same snapshot generation — boundaries are gap midpoints (spacer-row centers), slot pitch is the median adjacent area-row y-delta, the downward correction is the source's measured group span (so areas with visible nested projects stay correct), the grab x is a fraction of the row's resolved width, and scroll travel-per-click is measured, not assumed.

## AXDRAG2-a — mid-drag AX polling + mid-drag wheel delivery → **GO (both halves, both directions)**

While a synthetic drag was held on a sidebar row (grab → 3px wiggle → periodic `kCGEventLeftMouseDragged` keep-alives), line-unit scroll-wheel `CGEvent`s posted to the HID tap **scrolled the list underneath the held item**, and AX frame reads stayed **fresh tick-by-tick**:

- **Down**: 12 ticks at delta −3 took the scrollbar `AXValue` 0 → 0.43 monotonically; the watch row's frame tracked 1464 → 1112 (~30 px/tick); the post-abort resolve read 1104 — an ~8 px **post-wheel settle drift** (this later mattered: the held gesture now waits for two stable boundary reads before aiming, and re-resolves once more at the destination).
- **Up**: symmetric (0.43 → 0.14; watch row 0 → 240; post-abort == final sample exactly).
- **Escape mid-drag aborted cleanly** every time — the `TMArea."index"` vector stayed byte-identical (reconfirms AXDRAG1-d).
- Method note: a grab point must be **on-screen** — two arms that grabbed a virtual (off-display) row coordinate were invalid no-ops and were re-run.

## AXDRAG2-b — the area-row chevron (record-only) → **exists as a node, not actuatable**

Contrary to the "hover-drawn, no AX node" expectation: every area row carries a persistent 18×18 **`AXImage d="Source Toggle Template"`** child at the row's right edge (x≈249 of the 240-wide row frame, i.e. the collapse chevron), present identically before and after a real pointer hover. But the row's `AXUIElementCopyActionNames` is **empty** — nothing is AXPress-able. So the chevron is frame-resolvable but only mouse-actuatable. **Recorded; nothing built on it** (collapsing mutates user sidebar state and does not bound the reorder problem).

## AXDRAG2-c — certification through the production CLI

Every arm is the real shipped command against the guest DB (read-only SQLite asserts). The success envelope now carries the drive's step summary (rung + hop/tick counts) as a note — that is the evidence surface below. `H-UI-DRIVE` two-key gating throughout; no new gate.

| Arm | Command | Result | DB assert |
|---|---|---|---|
| c1 rung-1 DOWN | `Area-02 --after Area-05` | ok — "one drag" | adjacency ✓, order ✓ |
| c2 rung-1 UP | `Area-06 --before Area-01` | ok — "one drag" | adjacency ✓ |
| c3 **undo round-trip** | `undo --txn m-3fbca3cdba99` (inverts c2) | ok — inverse drove one drag | Area-06 back at its EXACT prior slot (after Area-18) ✓ |
| c4/c9 **rung-3 multi-hop** | window shrunk to 935×420 (viewport ≈ 350), ladder pinned to the floor, `Area-01`/`Area-22 --last` | ok — **"moved with 3 intermediate hop(s) + the final drag"** (c9) | after EVERY hop: source immediately above its aimed anchor, count + assignments invariant ✓ |
| c5 rung-3 UP | `Area-22 --first` (small window) | ok — hops + final | position 0 ✓ |
| c4b rung-2 (pre-cap build) | `Area-23 --last` (~0.6 viewport travel) | ok — scroll-while-held drop | adjacency ✓ — the one full rung-2 production pass |
| c10/c11 far moves (default ladder) | `Area-13 --before Area-01`, `Area-10 --before Area-12` | ok — "1 intermediate hop + the final drag" | adjacency ✓ |
| c6 negative: gating | no `--dangerously-drive-gui` | **blocked, exit 4** | index vector unchanged ✓ |
| c7 negative: duplicate visible name | second area titled `Area-05` seeded, then a move on it | **refused (H-UNKNOWN-DESTINATION "ambiguous")** before any gesture | order unchanged ✓ |
| ghost refusals | far moves in an AX-degraded session (below) | **refused fail-closed** naming the row + the relaunch remediation | "No sidebar change was left behind" — verified ✓ |
| c8 text-size arm | `NSTableViewDefaultSizeMode=3` + relaunch, rung-1 move | ok — one drag | Things **ignores** the OS sidebar-size default (row histogram stayed 24/16), so no in-app metric variation is lab-reachable; the derived-geometry guarantee rests on the frame-derived code + the unit suite (which certifies rescaling) |
| gating: config off | `ui-enabled false` | **unsupported, exit 6** | — |

Final state: 25 areas (count invariant across ~20 gestures), all 25 `TMArea."index"` values distinct (fully materialized), every `TMTask.area` assignment byte-identical to the seed state.

### The discovery that reshaped the ladder: sidebar AX-mirror GHOSTS (oddities §9)

During long-travel rung-2 attempts and drag-heavy sessions, the sidebar's AX table went **incoherent**: a row element would stop exposing its static text (keeping a stale frame), or vanish from the tree entirely, while the app's VISUAL list, the AppleScript oracle (`get name of areas`), and the DB all stayed correct and mutually consistent. Characterization:

- Reproduced repeatedly; the affected row varies; two adjacent project-section rows (`LAB-REPEAT-WEEKLY-PROJ` + "Later Projects") also blank intermittently.
- **Idle does not heal it; scrolling the row on-screen does not heal it; navigating lists does not heal it. Only relaunching Things restores coherence.**
- Strongest trigger: scroll-while-held travel beyond ~1.5 viewport heights (a ~2.7-viewport held travel corrupted the mirror mid-gesture); window resizes mid-session correlate too. Un-held scrolling + short drags (rungs 1/3) ran ~20 gestures without triggering it.
- Driver behavior on a ghost: **fail-closed refusal before any synthesis**, naming the row and the relaunch remediation; one 2 s settle-retry absorbs the transient right-after-launch variant.

Consequence — **rung 2 ships dark**: built, probe-certified, travel-capped at 1.5 viewports, but disabled by default (`THINGS_UI_DRAG_LADDER=held-scroll` re-enables it for lab work; `no-held-scroll` remains the explicit floor-pin the certification used). The certified production ladder is **rung 1 + rung 3**, which cover any sidebar length.

## AXDRAG2-d — tag.reorder scoping → **BLOCKED (do not ship)**

The bulletproof chain the brief required breaks at its **first link** (verified DB→row mapping):

1. The Tags window (`Window ▸ Tags`, pure-AX menu press) exposes 8 rows for the 8 top-level tags — **count matches, names do not exist**: every row's descendant text is the placeholder `Dialog Tag Template` (+ `Dialog Chevron Template` on the one parent-tag row). Identity is purely positional (reconfirms AXDRAG1-e).
2. The DB cannot order the rows: **four of the eight top-level tags tie at `TMTag."index" = 0`** (every never-dragged tag sits at 0 — ties are the NORM, not an edge case), so the "canonical DB order → window row order" mapping is undefined exactly where addressing needs it. Areas escaped this because the first drag materializes all indexes — but for tags the only in-place materializer would be the very reorder op we cannot yet aim.
3. A mis-aimed drop **on a row center silently RE-PARENTS** (`TMTag.parent` — AXDRAG1-e), and recovery is positional too, so a wrong-tag grab compounds rather than heals.

Per the ruling, `tag.reorder` is **blocked-on-judgment**, recorded in [ax-initiative.md](../design/ax-initiative.md). What would unblock it: a name handle on tag rows (app change), or a validated tie-breaking oracle for the Tags window order (none found — the AppleScript `tags` collection order was not validated against the window this campaign).

## Environment

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (clock pinned 2026-07-05) · Accessibility granted via AXVM1 rung-b (VNC single-client discipline: one `vncdo` per step, timeout-wrapped) · guest e2e bundle = node binary + `dist` + commander only.
