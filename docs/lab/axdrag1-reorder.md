# AXDRAG1 — hardening sidebar-AREA drag-reorder (and scoping TAG reorder)

**Status: PARTIAL — in progress.** Builds on [NATIVE1](native1-spike.md) (PR #142), which proved a single two-row area flip via synthesized HID-tap mouse events from JXA. AXDRAG1 hardens that into an *arbitrary rank placement* recipe, characterizes the `TMArea."index"` rewrite scheme, adds a scroll-then-drag recipe for off-viewport targets, probes mid-drag auto-scroll, catalogs drag hazards (accidental nesting / Escape-abort), and scopes TAG reorder + reversibility.

Things **3.22.11** / macOS **15.7.7** / DB **v26**, ONE disposable clone `axdrag1-lab` of `things-lab-golden-v1` (airgapped, clock-pinned 2026-07-05, SIP enabled), Accessibility granted via the AXVM1 rung-b VNC toggle, everything driven over SSH. Probe ids `AXDRAG1-a`…`AXDRAG1-f`. The reusable JXA driver (`axdrag.js`, verbatim at the end) is the deliverable — it is invoked `osascript -l JavaScript /tmp/axdrag.js <cmd> [args…]`.

## Setup (matches NATIVE1, deltas noted)

1. `tart clone things-lab-golden-v1 axdrag1-lab`; `tart run … --no-graphics --vnc-experimental`; airgap (`route delete default`), pin clock `070512002026`.
2. **Accessibility grant** — golden does NOT carry it (NATIVE1 finding reconfirmed): launch Things → provoke a denied AX op (auto-creates the disabled `kTCCServiceAccessibility | /usr/libexec/sshd-keygen-wrapper | 0` row) → open `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` → VNC toggle (framebuffer `1642 332`) → auth sheet (password field `1020 873`, Modify Settings `1020 966`, password `admin`) → `auth_value` 0→2. Re-probe `System Events … menu bar 1` returns the menu list at `exit 0`. **VNC discipline that mattered:** single-client RFB contends if you fire captures/clicks back-to-back in one process — run **one `vncdo` invocation per step, each `timeout`-wrapped**, with `sleep` between. Batching all steps into a single helper-loop produced silent no-ops (no PNGs, grant not applied); splitting into per-step invocations worked first try.
3. **Seed areas** — the Things URL scheme cannot create areas; AppleScript can: `tell application "Things3" … repeat … make new area with properties {name:"Area-NN"} …`. Seeded `Area-01`…`Area-15` on top of the golden's `LAB-AREA-A`/`LAB-AREA-B` → **17 areas**, enough that the sidebar scrolls at the VM window size (window `935×684` @ `44,25`; sidebar scroll-area viewport `240×610` @ `44,63`, visible bottom ≈ y 673pt; rows extend to y≈1072pt off-viewport).
4. Deploy the driver: pipe over SSH (`lab_ssh "$IP" 'cat > /tmp/axdrag.js' < axdrag.js`) — **`scp` flapped "Permission denied" on the fresh clone; the `cat >` pipe is reliable** (same trick as `gsql.sh`).

## AX structure of the sidebar table (AXDRAG1 addressing)

`winfo` + `rows` output (driver commands). The sidebar = the narrow (`w=240`) `AXTable` under the `AXStandardWindow`'s second `AXScrollArea`. Findings:

- **Row identity is NOT on the row's own `AXDescription`.** NATIVE1 reported sidebar rows carry an `AXDescription` (e.g. `d="LAB-AREA-A."`); on the AppleScript-seeded areas here **`AXDescription` is empty** on every row. The label is reachable instead by concatenating descendant `AXStaticText` `AXValue`s (driver `allText`): row text like `"Area-05.|Source Toggle Template|Area-05"`. So the robust addressing is **descendant-static-text match**, not row `AXDescription`. (Possible divergence: NATIVE1's areas may have been URL/other-seeded; worth noting for the op.)
- The table interleaves **h=24 entity rows** (areas, projects, built-ins) with **h=16 spacer rows** (empty text) — every area is followed by a spacer row that is itself a table row. Index arithmetic on rows must skip spacers.
- Built-ins occupy the first rows (Inbox, Today, Upcoming, Anytime, Someday, Logbook, Trash), then loose projects, then area/project groups.
- **Off-viewport rows still expose valid (virtualized) AX frames** — rows below the viewport bottom (y≈673) report real `AXPosition`/`AXSize` (down to y≈1072) even though not drawn. Frames alone don't tell you what's visible; cross-check against the scroll-area viewport rect from `winfo`.
- `AXSelected` **reads** on rows (`sel` field).

### Baseline DB ordering

All 17 areas start at **`TMArea."index" = 0`** (unmaterialized — Things writes `index` only on a UI drag, per NATIVE1 / the O13 note). The sidebar's displayed area order under an all-zero index is a stable tiebreaker (observed: Area-05, 02, 15, 07, 09, 04, 08, 13, 06, 03, 10, 11, 12, 14, 01 — not creation order). The first drag materializes indices.

## AXDRAG1-a — precision placement + drop geometry + index-rewrite scheme

**Verdict: arbitrary rank placement WORKS in both directions** (adjacent, multi-slot, to-first all confirmed via DB `TMArea."index"` sort). Source frames re-resolved by descendant-static-text (driver `dragname`; click point `row.x+170, row.y+row.h/2`, NATIVE1's label x). Three moves, each DB-verified:

| # | Move | Aimed drop | Result (visual order) | Index delta |
|---|---|---|---|---|
| 1 | Area-05 (1st NN) ↓ below Area-15 | (164, 620) | landed after Area-07 | **first drag materialized ALL 17 indices** |
| 2 | Area-07 → to-first (above LAB-AREA-B) | (164, 354), upward | Area-07 now rank 0 | only Area-07 changed: −44 → **−1155** |
| 3 | Area-15 ↓ past Area-05 | (164, 618), downward | Area-05, Area-15, Area-09 | only **Area-05** changed: −22 → −107 (the *neighbor*, not the dragged row) |

### Drop-point geometry (the load-bearing finding)

The sidebar table interleaves **h=24 entity rows with h=16 spacer rows → 40px per area "slot"** (area centers 40px apart). Drop placement is decided against the **live, mid-drag layout**, and **lifting the source collapses its slot**:

- **Upward drags: aim at STATIC (pre-drag) coordinates.** Targets above the source do not move when the source is lifted. NATIVE1's upward flip and Move 2's to-first both landed using raw pre-drag frames. To insert *before* a reference row, aim ~6px above its top (e.g. y=354 to precede a row at y=360).
- **Downward drags: subtract ONE slot-height (40px) from the static target.** Everything below the source's original position shifts **up by 40px** the instant the source is picked up, so a target computed from the static dump overshoots by one slot. Move 1 aimed at y=620 (≈12px above Area-07's *static* top 632) and landed *after* Area-07 — because live Area-07 had shifted to ~592 and y=620 fell in its bottom half.
- **Before-vs-after within a row is decided by which half the pointer lands in** (top half → insert before that row, bottom half → after), evaluated against the live layout.
- Practical op recipe: dump rows, pick the destination neighbor, and for a downward move use `neighborStaticY − 40`; for an upward move use `neighborStaticY`. Re-dump and re-verify after each move (indices/positions change).

### Index-rewrite characterization (`TMArea."index"`)

- **Lower index sorts higher; DB order by `"index"` == sidebar visual order** (reconfirmed at 17 areas — NATIVE1 saw it at 2).
- **First materializing drag renumbers the WHOLE list** into a sparse, *irregular* ranking (observed: −639, −401, −166, −76, −44, −22, −9, −4, −3, −2, −1, 0, 456, 1032, 1372, 1725, 2143 — not evenly spaced). Before any drag all areas sit at `index=0`.
- **Every subsequent drag reassigns exactly ONE row's index** to a value that slots it into place — an intermediate value strictly between the new neighbors (Move 3: −107 into the (−166, −76) gap — *between* them but **not** the exact midpoint −121), or an extrapolation beyond the current min/max for to-first/to-last (Move 2: −1155, below the −639 minimum).
- **Quirk — Things may renumber the NEIGHBOR instead of the dragged row** (Move 3: dragged Area-15 kept −76; its neighbor Area-05 was rewritten −22 → −107 to sit above it). Things picks whichever single reassignment realizes the requested order. **Consequence for undo (feeds AXDRAG1-f): you cannot restore by rewriting only the moved area's index — capture the full `TMArea."index"` vector pre-drag.**
- The sparse gaps mean many future single-value insertions before a full renumber is forced.
