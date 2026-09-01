# SBSCR1 — why the sidebar would not scroll, and the pointerless route that replaces the wheel

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS **15.7.7** (24G720) · pinned clock **2026-07-05** (trial wall 2026-07-18) · airgapped clone, destroyed at teardown.
**Driver:** [`lab/scripts/research-sbscr1.sh`](../../lab/scripts/research-sbscr1.sh) + [`lab/scripts/sbscr1-helper.jxa.js`](../../lab/scripts/sbscr1-helper.jxa.js)
**Occasioned by:** [#672](https://github.com/mikegreiling/things-api/issues/672)

## The field report

things-api 0.20.2 / Things 3.23.2 / macOS 15.4.1, on the maintainer's second Mac.
`things reorder <area> --end --dangerously-drive-gui` correctly detected the AXDRAG5 tall-section
wall and selected the SBCOL1 collapse fallback — then died after ~63s with
`"<area>"'s row could not be scrolled into view`, having produced **no visible sidebar
movement at all**. The blocking section was ~1,528pt of rows in a ~901pt viewport; the
post-failure snapshot showed the sidebar still at its top boundary.

`scrollUntil()` returns `null` for five distinct causes and `toggleDisclosure()` flattened all
five into that one sentence, so the report could not say which had happened.

## The fixture

A synthetic sidebar reproducing the field geometry: 16 areas, 117 table rows, and one WALL —
area `Mu` with 60 projects, **1,480pt of section in a 346pt viewport** (field: 1,528pt in 901pt),
sitting below the fold with the sidebar pinned at `scroll = 0`.

```
viewport y=63 h=346 usable=322  scroll=0  table-rows=117  area-rows=16/16
LAB-AREA-B   top=360   height=64    rows=3   fits   visible
Iota         top=424   height=40    rows=2   fits   OFF-SCREEN
…
Mu           top=632   height=1480  rows=62  WALL   OFF-SCREEN
…
Xi           top=2640  height=96    rows=4   fits   OFF-SCREEN
```

## §1 — H1: scroll-under-pointer routing is ABSOLUTE (cell `ptr`)

Six measurements: three pointer parks × wheel dispatched with and without a pointer move to the
sidebar centre first. Each dispatch was `-6` line-unit clicks from the top boundary; movement is
the delta of the topmost row's `y`.

| pointer parked at | pointer moved to sidebar first | pointer at dispatch | movement |
|---|---|---|---|
| screen corner (5,5) | no | (5,5) | **0 px** |
| screen corner (5,5) | yes | (164,236) | **−180 px** |
| content pane (631,236) | no | (631,236) | **0 px** |
| content pane (631,236) | yes | (164,236) | **−180 px** |
| sidebar centre (164,236) | no | (164,236) | **−180 px** |
| sidebar centre (164,236) | yes | (164,236) | **−180 px** |

**The law (measured, not assumed): a synthesized `kCGScrollEventUnitLine` wheel event posted to
the HID tap is delivered to the view under the POINTER, and nowhere else.** With the cursor off
the sidebar the sidebar does not move by a single pixel — no error, no dispatch failure, just
silence. This retires the "scroll-wheel synthesis is positionless and allowed" note in
`ui-drag.ts`'s header doctrine: wheel synthesis is *position-dependent* and always was.

**H1 is convicted as an OS law and ACQUITTED as the cause of #672**: `jxaSidebarScrollScript`
already moves the pointer to the sidebar centre before every dispatch, so the shipped path was
never exposed to it. The `ptr` cell's `moveFirst=1` rows are the proof — the shipped primitive
scrolled identically from all three parks.

Travel calibration, incidentally: 6 clicks × 3 delta units → 180px, i.e. **exactly the 30px
`PX_PER_CLICK_SEED`** the driver seeds with.

## §2 — H2: a deterministic POINTERLESS route exists (cell `axscroll`) ★

The sidebar's scroll area exposes an `AXScrollBar` child whose **`AXValue` is settable**:

```
scrollBar  role=AXScrollBar  orient=AXVerticalOrientation  actions=(none)
    AXValue                            settable=YES   <<<
    AXFocused                          settable=YES
    AXHidden                           settable=YES
```

Setting it scrolls the list, `AXError = 0`, **with the pointer parked at (5,5) throughout**, on a
perfectly linear mapping:

| set `AXValue` | row `y` before → after | movement |
|---|---|---|
| 0.0 → 0.5 | 80 → −1092 | −1172 px |
| 0.5 → 1.0 | −1092 → −2264 | −1172 px |
| 1.0 → 0.0 | −2264 → 80 | +2344 px |

**Full scroll range = 2,344px for one unit of fraction, exactly linear.** The geometric predictor
`(contentSpan − viewport.h)` computes 2,310px from the same snapshot — 1.5% low, which a
closed loop absorbs on its first measured iteration.

Two neighbouring settables were found and are deliberately **not** used: `AXSelectedRows` on the
table and `AXSelected` on a row. Selecting a sidebar row navigates the content pane — a visible
side effect the user never asked for.

The row-action arm is a clean negative, confirming SBRES1: sidebar rows advertise **no actions at
all**, so `AXScrollToVisible` (and every sibling) returns `-25206` (`kAXErrorActionUnsupported`)
and moves nothing.

| action on the off-screen wall row | AXError | movement |
|---|---|---|
| `AXScrollToVisible` | −25206 | 0 px |
| `AXScrollAreaToVisible` | −25206 | 0 px |
| `AXShowMenu` | −25206 | 0 px |

## §3 — H3: natural scrolling does NOT invert a synthesized wheel (cell `natural`)

`com.apple.swipescrolldirection` is the trackpad default on every laptop and was the obvious
suspect for a driver that scrolls the wrong way into a boundary. It is not:

| `com.apple.swipescrolldirection` | wheel `-6` from the top boundary | movement |
|---|---|---|
| `false` (0) | pointer over sidebar | **−180 px** (content up — the shipped convention) |
| `true` (1) | pointer over sidebar | **−180 px** (identical) |

**H3 ACQUITTED.** The inversion is applied by the HID layer to real device events; a
`CGEventPost`-ed line-unit wheel enters below that layer and is never flipped. (Both readings were
taken after a Things relaunch, so the pref was live.)

## §4 — H4: the AXScrollBar survives hidden scrollbars (cell `bars`)

The laptop/trackpad default hides scrollbars until you scroll, which would have made §2's route
useless on exactly the machine that reported the bug. It does not:

| `AppleShowScrollBars` | `hasBar` | scrollbar value readable | `setbar 0.5` |
|---|---|---|---|
| `Automatic` | true | 0 | −1172 px, AXError 0 |
| `WhenScrolling` | true | 0 | −1172 px, AXError 0 |
| `Always` | true | 0 | −1172 px, AXError 0 |

**The overlay scrollbar is hidden VISUALLY but present and settable in the AX tree under every
setting.** H4 acquitted as a cause; more importantly, the §2 route is available on the field
host's configuration.

## §5 — the fix prototype: one iteration, no pointer (cell `seek`)

The shipped closed loop with its wheel primitive replaced by a scrollbar-fraction primitive,
seeded geometrically and calibrated from measured travel, driving the off-screen wall row into
the band with the pointer parked at (5,5):

```
terminal reason: reached   pointer at end: {'x': 5, 'y': 5}
it=0  rowY=592  vpY=63  vpH=346  err=-368.0  scroll=0.00000  reqDelta=0.15931
      target=0.15931  axErr=0  afterRowY=218.5  afterScroll=0.15931  px/frac=2310
it=1  rowY=218  vpY=63  vpH=346  err=0.0  → in band
```

**One dispatch.** The geometric seed put the row 0.5pt from its aim. The wheel loop needs one
snapshot + one dispatch per ~360px of travel and re-reads the whole sidebar between each.

## §6 — the pre-fix e2e baseline: the lab does NOT reproduce the field failure (cell `e2e`)

The #672 command shape verbatim — `things reorder <area> --end --dangerously-drive-gui
--verify-timeout 120000 --json` — with the pointer parked at (5,5) **succeeded** on 0.20.2 in
39s: the wall was collapsed, the drag landed, the sidebar was restored, and both invariants held.

This is the honest verdict on the first three hypotheses as *causes*: none of them convicts, and
the VM cannot make the shipped 0.20.2 fail the way the field host does. What the campaign can do
— and §2 does — is delete the entire pointer-and-wheel class from the mechanism.

## §7 — the field A/B re-aims the campaign: the gate is the SNAPSHOT, not the scroll

Mid-campaign the maintainer ran a hardware A/B (cursor on the sidebar vs cursor over Finder) on
the affected machine. **Neither run reached `scrollUntil()` at all.** Both died earlier and
identically, in ~33s, exit 3, zero mutation:

> reading the sidebar took longer than 30s and was stopped — nothing was dragged.

against a **174-row sidebar**. Two consequences, and they reverse the campaign's priorities:

1. **H1 is untested in the field, not refuted.** The pointer never mattered because no scroll was
   ever attempted. §1's law and §2's replacement still stand on their own evidence.
2. **The gating bug is the sidebar READ scaling on real hardware**, and everything below is about
   that.

The A/B also produced two collateral findings, both fixed in the same change:

- **`THINGS_API_TRACE=1` was silently ignored** — only the exact string `true` parsed, so the
  entire diagnostic session ran with tracing off and nothing said so. A diagnostic switch that
  quietly does nothing is its own honesty bug.
- The field JSON carried **no `steps` array at all**. The `silent-noop` exit is the one
  verify-failed path in `pipeline.ts` that omitted `stepsOf(executeResult)` — so the failure a
  field report is *most* likely to hit arrived without the diagnostic ladder's middle rung.

## §8 — where the sidebar read's time actually goes (cell `snapcost`)

The fixture was grown to the field's scale (178 sidebar rows, 190 table rows across both panes)
and the shipped snapshot instrumented per pane and per depth ([`sbscr1-cost.jxa.js`](../../lab/scripts/sbscr1-cost.jxa.js)
counts every AX call).

**Result at 178 rows, 740pt window:** the shipped script ran in **2.09s**. Depth-6 costs 2.20s
against depth-2's 1.93s — **+14%, not an explosion.** The depth-escalation theory does not
account for a 30s read on its own.

| depth | ms | AX calls | sidebar pane (178 rows) | content pane (12 rows) |
|---|---|---|---|---|
| 1 | 677 | 742 | 552ms / 519 calls — **0/16 titles → escalates** | 125ms / 223 calls |
| 2 | 1926 | 2002 | 1782ms / 1750 calls — 16/16 | 144ms / 252 calls |
| 6 | 2195 | 2280 | 2050ms / 2028 calls — 16/16 | 144ms / 252 calls |

Three further findings from the same cell:

- **The content pane is never the cost.** Things virtualizes it to ~12 exposed rows regardless of
  window height, while the sidebar exposes **all** of its rows (AXDRAG1's virtualized-frame law,
  now measured at scale). A big window does not make the read big; a big *sidebar* does.
- **`AXEnhancedUserInterface` is irrelevant.** The obvious "the field host has it on and the lab
  turns it off" theory: measured both ways, 2.10s vs 2.16s, byte-identical output. Acquitted.
- **The cost is AX ROUND-TRIPS, not arithmetic.** 2,002 calls for a 190-row read, each a
  synchronous IPC serviced on Things' own main thread. That is why a VM with an idle app reads in
  2s and a real Mac with a busy one can take fifteen times longer for the same row count — and
  why the fix has to be *fewer calls*, not a longer wait.

### The wasted generation

The row subtree is shallow — `AXRow → AXCell → AXUnknown`, with the area title at level 2
(`title-at-L2` for all 16 areas; 2.9 node visits per row). Yet the harvest was spending ~9.8
calls per row. The reason is in `textOf`'s guard placement:

```js
function textOf(n, acc, depth){ if(n===null||depth<0) return acc;   // OLD
  …push n's text…
  for (…) textOf(node(n.children[i]), acc, depth-1); return acc }
```

The recursion **fetches** each child before the callee's own `depth<0` guard rejects it — so an
entire generation of `node()` round-trips was made and thrown away without ever contributing a
character of text. Moving the guard before the fetch is output-identical:

| | shipped snapshot at 178 rows |
|---|---|
| before | **2.09s** (2.09 / 2.20 / 2.02) |
| after | **0.82s** (0.92 / 0.80 / 0.80 / 0.84) |

**2.5× faster, byte-for-byte the same rows** (9019 → 9029 bytes; the +10 is the new `depth`
field). Together with the confined escalation below, the field's >30s read should land well
inside even the old flat budget.

## §9 — what shipped

1. **The scroll primitive is the scroll bar's `AXValue`** (§2), with the wheel kept as the
   fallback for a scroll area exposing no bar. The fallback still moves the pointer first,
   because §1 is why it must.
2. **`textOf` fetches no generation it will not read** (§8) — 2.5× off the sidebar read.
3. **The depth escalation is CONFINED and VISIBLE.** It used to re-run the whole locator: a
   second window walk plus a full re-harvest of every candidate pane. It now re-harvests only the
   sidebar's own table, reports the depth it used and whether it escalated, and the drive
   remembers that depth so the double pass is paid at most once.
4. **The read's budget scales with the sidebar** — `max(30s, rows × 400ms)`, capped at 90s,
   instead of a flat 30s that failed on exactly the large sidebars the rung exists for.
5. **Five distinct terminal reasons** replace the flattened sentence: `snapshot-failed`,
   `scroll-dispatch-failed`, `scroll-no-effect`, `pinned-at-boundary`, `iteration-limit`. The
   human copy stays, with the structured reason beside it, at **both** scroll-refusal sites.
6. **Per-iteration telemetry** at trace tier (`sidebar-scroll-loop`), with the terminal reason and
   the last iteration's measurements riding the failure payload unconditionally.
7. **Two direction/granularity traps closed.** The wheel path could only learn its sign convention
   from *measured* travel, so a wrong-way scroll into a boundary moved nothing, taught it nothing,
   and was called "pinned" after two turns — a stall now flips direction and retries once. And a
   residual error below half a wheel click can only oscillate, so the loop now stops and says
   `scroll-no-effect` instead of burning all 18 iterations to report `iteration-limit`.
8. **`THINGS_API_TRACE=1` works** — as do `yes`/`on`/`0`/`no`/`off`; an unreadable spelling is
   still refused rather than guessed at.
9. **The `silent-noop` exit carries `steps`** like every other verify-failed path.

## §10 — certification (post-fix, adversarial pointer)

All cells run against the rebuilt driver on the same clone, **with the pointer deliberately parked
at (5,5) before every drive**:

| cell | move | result |
|---|---|---|
| `e2e` | `reorder Nu --end` across the 1,480pt wall | **PASS** — 48s, wall collapsed + restored (62 rows, identical), invariants held |
| `e2e` | `reorder Epsilon --end` across the wall | **PASS** — 41s, same |
| `cert` (SBRES1) | semantic resolution at 1200pt window width | **PASS** — 178 rows, `hasBar: true` |
| `cert` (SBCOL1) | `Xi --before Mu` — upward across the wall | **PASS** — 34s, 3 hops + final drag, collapsed + re-expanded, disclosure restored |

Zero unexpected beeps under the sentinel throughout (`THINGS_LAB_BEEPS_OK=1`, accounting mode).

## Reusable for the next campaign

- [`sbscr1-helper.jxa.js`](../../lab/scripts/sbscr1-helper.jxa.js) verbs: `state`, `geom`, `park`,
  `wheel <n> <moveFirst>`, `sbinfo`, `setbar <fraction>`, `rowaction <title> <action>`,
  `rowy <title>`, `seek <title> [maxIter]`.
- [`sbscr1-cost.jxa.js`](../../lab/scripts/sbscr1-cost.jxa.js): an AX-call-counting copy of the
  shipped resolver, attributing cost per pane and per depth, plus a `composition` verb that
  histograms a row's subtree by role and level. **Any future "the snapshot is slow" question
  starts here** — the answer is always a call count, never a guess.
- **`mouseLoc()` trap:** `CGEventGetLocation` returns a plain `CGPoint` struct, which is *not* a CF
  type — `CFCopyDescription` on it yields nothing and silently reads as `null`. Use
  `NSEvent.mouseLocation` and flip its bottom-left origin against `NSScreen.frame.size.height` to
  reach the top-left space that AX frames and `CGEventPost` both use.
- **Any cell that dispatches a wheel event must state where the pointer was**, and a cell that
  claims a scroll did nothing must include a positive control with the pointer over the target
  (the CNCAC1/URLEN1 law: a negative from an oracle never shown a positive is not evidence).

## Open — for a future sitting

- **The field's own numbers are still unmeasured.** The lab reads 178 rows in 0.82s post-fix; the
  field host read 174 rows in >30s pre-fix. The 15× gap is *attributed* to AX round-trip latency
  against a busy app, not measured there. The next field run under `THINGS_API_TRACE=1` will emit
  a `sidebar-snapshot` record per read (rows, depth, escalated, matched/expected, budget) and
  settle it.
- **3.23.2 parity was not built.** The golden is 3.23 (32300036); the field host runs 3.23.2. An
  in-place clone upgrade from `/Volumes/Workspace/things-releases/Things3-3.23.2-32302001.zip`
  (the SBRES1/DRIFT-1 path) would close it. Nothing measured here depends on a 3.23→3.23.2
  behavior change, but the read-cost numbers are golden-v4 numbers and should be re-taken under
  3.23.2 before they are treated as version-independent.
