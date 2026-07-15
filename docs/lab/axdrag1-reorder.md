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
