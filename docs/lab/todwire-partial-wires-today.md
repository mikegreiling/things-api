# TODWIRE — partial-wire laws on the native `list "Today"` reorder (the MOVPLC sequel)

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05 12:00**, then rolled forward to **07-06** and **07-07** to manufacture five distinct `todayIndexReferenceDate` cohorts (the [today-order-research](today-order-research.md) method, as in [MOVPLC](movplc-move-placement-today.md)). Campaign **2026-08-11**, ONE disposable clone (`lab/artifacts/todwire-lab/`, gitignored — `report.txt` + `final.sqlite` + `screens/*.png`), no crash (Things ALIVE throughout, no DiagnosticReports). Discovery — **DB row deltas are ground truth**. Driver: [`lab/scripts/research-todwire.sh`](../../lab/scripts/research-todwire.sh) (subcommands `setup·loginterval·roll06·roll07·cancel·exp1·exp2·exp3·exp4·drag-shot·drag·drag-snap·dump`). GUI cross-cohort drag via **vncdotool** against the `--vnc-experimental` framebuffer (1024×768, single-client; the golden-v2 AXVM1 L3-accessibility layer), reusing the [TDRAG](tdrag-ax-residuals.md) held-waypoint gesture recipe.

## Why this campaign

[MOVPLC](movplc-move-placement-today.md) proved a **FULL** `list "Today"` wire re-stamps EVERY named row's `todayIndexReferenceDate → today` (cohort fusion) and rewrites the whole VISIBLE order, while UNNAMED rows stay byte-untouched. #442 removed the unrequested placement leg from a bare `todo move`. But an EXPLICIT `reorder <x> --start --in today` still compiled the OLD full wire (`computeReorderPre` `today` census: `[...movees, ...ALL remaining open bucket-0 members by raw todayIndex ASC]`), so it too rewrote the whole visible order and fused every cohort. The maintainer's ruling (2026-08-11): the reorder operation must PRESERVE the observable order — name only what must move, census in VISIBLE order, disclose cohort re-stamps. This campaign characterizes PARTIAL / minimal `list "Today"` wires so the engine (Phase 2) can compile the smallest id list realizing a requested placement. Scope: the **native `list "Today"` view-axis wire only** — the evening axis is bounce-only and the day/upcoming axes use deadline-cycle / dated-bounce protocols (different verbs), out of scope here (see §Scope).

## The wire under test

```
tell application "Things3" to _private_experimental_ reorder to dos in list "Today" with ids "<comma-joined>"
```
Ids are ONE comma-joined string (the −1700 list-literal law). Every fire returned **`EXIT=0`**.

## Fixture

Five distinct `todayIndexReferenceDate` cohorts, manufactured by seeding into Today under a rolled-forward clock (the app never normalizes entry dates). Golden pre-seeds contributed 07-03/07-04; the campaign added 07-05/06/07:

- **Open Today to-dos** per cohort: `C5a/b/c` + `LIN-5` (07-05), `C6a/b/c` + `LIN-6` (07-06), `C7a/b/c` + `LIN-7` (07-07), plus golden `LAB-*` rows on 07-03/04/05/06/07.
- **Unswept canceled bystanders**: `C5b`, `C6b` canceled after `logInterval` set to **Manually** (AX) so they stay unswept and keep rendering in Today (`status=2`).
- **Stale evening** (`startBucket=1`) bystanders: golden `LAB-EVENING-1` + `EVE1` (seeded `when=evening`).

**Baseline** — the DB comparator (`startBucket ASC, COALESCE(tiRef,startDate,deadline) DESC, todayIndex ASC, uuid`) reconstructs the GUI `to dos of list "Today"` order exactly. Crucially the VISIBLE order **groups by cohort** (07-07 `LIN-7,C7c,C7b,C7a`, then 07-06 `LIN-6,C6c,C6b,C6a`, then 07-05…, 07-04, 07-03, evening) while the RAW `todayIndex ASC` order (what the OLD full wire sent) **interleaves cohorts** (`LIN-7, LIN-5, LIN-6, C7c, C5c, C6c, …`). The two orders are materially different — the whole premise of the fix.

## The law table (per wire shape / anchor class)

Snapshot columns: `tIdx`=todayIndex, `tiRef`=todayIndexReferenceDate, `sd`=startDate, `umd`=userModificationDate.

### EXP1 — single-ID wire (`--start` / `--first`, one movee) → **clean front-insert, movee-only write**

Fired `with ids "<C5a>"` (C5a alone, a 07-05-cohort row).

| Row | tIdx before → after | tiRef before → after | umd |
| --- | --- | --- | --- |
| **C5a** (movee) | −472 → **−2738** (new global min) | 07-05 → **07-07** | **UNCHANGED** (`umd`-silent) |
| every other row (all cohorts + canceled + evening bystanders) | **byte-identical** | **byte-identical** | — |

**Landing:** GUI order became `C5a, LIN-7, C7c, C7b, C7a, …` — C5a jumped to the **VISIBLE TOP** (above the entire 07-07 cohort), because its `tiRef` was raised to today (the newest cohort) and its `todayIndex` to the new global min. Verified the previous visible top **LIN-7 stayed byte-identical** (tIdx=−2150) — no re-base of unnamed rows. **A single-ID wire touches ONLY the movee** (`tiRef→today`, `tIdx→min`, `umd`-silent) and lands it at the visible top. This is exactly the wire `--start` needs.

### EXP2 — prefix wire (`--start`, N movees) → **named block clusters at visible top in SENT order; unnamed interleave preserved**

Fired `with ids "<C6a>,<C7a>"` (C6a first, C7a second — two cohorts).

| Row | tIdx after | tiRef after |
| --- | --- | --- |
| **C6a** (named #1) | **−3797** (new min) | 07-06 → **07-07** |
| **C7a** (named #2) | **−3317** | 07-07 (already) |
| every unnamed row | **byte-identical** | **byte-identical** |

**Landing:** `C6a, C7a, C5a, LIN-7, C7c, C7b, …, LIN-6, C6c, …, LIN-5, C5c, …` — the named pair clusters at the TOP in **sent order** (C6a above C7a), and the unnamed remainder is EXACTLY its prior visible order (`C5a` from EXP1, then 07-07 `LIN-7,C7c,C7b`, then 07-06 `LIN-6,C6c`, then 07-05…). The unnamed rows keep their cohorts intact and therefore their visible positions. **Confirmed the partial-wire law holds on the today axis identically to HEADSORT: result = `[named in wire order] ++ [unnamed in prior VISIBLE order]`.**

### EXP3 — mid-list anchor (`--after y` / `--before y`, y mid-list) → **requires naming the visible PREFIX through y; fuses only that prefix**

Goal: place `C7c` (07-07) directly AFTER `C6c` (07-06, mid-visible-list). Computed wire via `minimalReorderWire(visibleOrder, targetOrder)` = the visible prefix from top through C6c, with C7c appended last: **9 ids** `[C6a, C7a, C5a, LIN-7, C7b, LAB-REPEAT-DAILY(07-07), LIN-6, C6c, C7c]`.

**Landing:** `…, LIN-6, C6c, C7c, C6b, …` — **C7c landed directly after C6c** (request realized). All 9 NAMED rows re-stamped `tiRef → 07-07` (incl. LIN-6 07-06→07-07 and C6c 07-06→07-07); every one got a fresh `todayIndex` in a new min-space; **all `umd`-silent**. The UNNAMED tail below the anchor (`C6b` canceled 07-06, `LAB-REPEAT-DAILY` 07-06, `LIN-5/C5c/C5b` 07-05, all 07-04/03 rows) stayed **byte-identical**.

**This is the MINIMAL wire, and it is unavoidable** (analysis, confirmed by the primitive): the native reorder can only RAISE a named row's `tiRef` to *today* — it cannot assign an older `tiRef`. So to seat `C7c` (today-cohort) directly below `C6c`, `C6c` must itself be raised to today (named), and then every row that must remain visually ABOVE `C6c` must also be named-and-ordered (else it interleaves wrongly by its own cohort). Naming only `{C6c, C7c}` would send BOTH to the visible top, not after `C6c`'s current neighbours. **So `--after`/`--before` inherently fuse the entire visible prefix down to the insertion point** — the re-stamped set = the named prefix, disclosed. (`--end`/`--last` is the extreme: the movee must sort below every open row, so the whole visible open list is named, movee last — full open-cohort fusion.)

### EXP4 — re-stamp scope / idempotency → **UNCONDITIONAL: every named row rewritten on every fire, position-independent, `umd`-silent**

Re-fired the EXP2 wire `with ids "<C6a>,<C7a>"` while C6a,C7a were ALREADY the top two rows in the correct order.

| Row | tIdx before re-fire → after |
| --- | --- |
| C6a | −8316 → **−9200** (fresh, more-negative min-space) |
| C7a | −7649 → **−8769** |

The app **REWROTE** both rows' `todayIndex` into a fresh descending min-space and (re-)stamped `tiRef→today` **even though their position, order, and cohort were already satisfied** — a re-fire is NOT a byte no-op; each fire extrapolates a fresh front space (exactly like AXDRAG1's "each drag extrapolates fresh sparse values"). `umd` stayed silent. **Claim 4 resolved: the native `list "Today"` reorder writes `tiRef→today` + a fresh `todayIndex` on EVERY named row UNCONDITIONALLY (not gated on whether the row's position or cohort changed).** So the conservative Phase-2 disclosure — "every named non-movee row's Today cohort will re-stamp" — is exactly right, never an over-count.

### Bystander invariant (all fires) → **HOLDS**

Across EXP1–EXP4 the unswept **canceled** rows (`C5b`, `C6b`, `status=2`) and stale **evening** rows (`EVE1`, `LAB-EVENING-1`, `startBucket=1`) — never named (the census excludes `status≠0` and bucket-1) — stayed **byte-identical** (tIdx, tiRef, umd), sinking below the collapsed open block exactly as MOVPLC predicted. Confirms the MOVPLC exclusion law on partial wires.

## GUI cross-cohort mid-list drag (maintainer addendum, read-side evidence)

Two vncdotool drags on the multi-cohort fixture (held-waypoint gesture, framebuffer coordinates; content rows are not AX-title-addressable, ORDFIN1 §8h / TDRAG — identified visually):

| Drag | Movee (cohort) | Dropped into region | `tiRef` before → after | `tIdx` after | Other rows |
| --- | --- | --- | --- | --- | --- |
| A (down) | `C6a` (07-07) | between `C5c`/`C5b` (**07-05** band) | 07-07 → **07-05** | **−1104** (interpolated between C5c −1488 and C5b −1053) | **all byte-identical** |
| B (up) | `LIN-5` (07-05) | between `C7a`/`C5a` (**07-07** band) | 07-05 → **07-07** | **−7838** (interpolated between C7a −8769 and C5a −7282) | **all byte-identical** |

**Verdict — option (a): an ordinary Today drag that crosses a cohort boundary ADOPTS THE ANCHOR'S COHORT.** The GUI rewrites the dragged row's `todayIndexReferenceDate` := the destination region's cohort date (the neighbour cohort at the drop point) — a **SINGLE-ROW write** — and interpolates its `todayIndex` between the two drop neighbours. It does this **symmetrically** (drop into an OLDER band → older `tiRef`; drop into a NEWER band → newer `tiRef`). `startDate` is **untouched** (C6a kept `sd=07-06` while its `tiRef` became 07-05), `umd` is **silent**, and **no other row changes**. The app itself therefore **falsifies the per-row "date entered Today"** to whatever cohort the user drops into — a plain drag can give a row an entry date it never had (older or newer than its real arrival).

**Consequence (bounds the honesty of any "time in Today" feature).** `todayIndexReferenceDate` is NOT a faithful "date the item entered Today": both the native reorder (raises every named row to *today*) and an ordinary GUI drag (adopts the drop neighbour's cohort, older or newer) overwrite it as a pure ordering coordinate. A `todaySince` / "time in Today" field built on `tiRef` would be silently wrong after any manual reorder or cross-cohort drag. (This corroborates the maintainer's decision to SCRAP the `todaySince` idea.) Read-side evidence only — does not gate the Phase-2 wire fix.

## Verdicts (for the register / the fix)

- **Single-ID / prefix front-insert (`--start`) — MINIMAL & CLEAN.** Name only the movees; they land at the visible top in sent order; only the movees re-stamp; every other row (incl. canceled/evening bystanders) is byte-untouched. This is the wire the fix sends for `--first`/`--start` (no non-movee re-stamp → disclosure count 0).
- **Partial-wire law (today axis) — CONFIRMED = HEADSORT.** `result = [named in wire order] ++ [unnamed in prior VISIBLE order]`, so `minimalReorderWire(visibleComparatorOrder, targetOrder)` is the correct minimal wire. One law, one implementation (share the reader's Today comparator + the existing `minimalReorderWire`).
- **Anchor / end classes (`--after`/`--before`/`--last`) — realizable but INHERENTLY prefix-fusing.** The minimal wire names the visible prefix down to the insertion point (movee last); those named non-movee rows re-stamp `tiRef→today`. NOT a broad-naming failure — it is the tightest wire the primitive allows (it can only raise `tiRef` to today), and the unnamed tail is provably untouched. The fix DISCLOSES the count of non-movee rows that will re-stamp (the #V11 pattern). **No Phase-2 STOP** — the front-insert law landed exactly at the visible top and minimal wires realize every anchor class.
- **Re-stamp scope — UNCONDITIONAL, `umd`-silent.** Every named row rewritten every fire regardless of position; bystanders never touched.
- **GUI cross-cohort drag — single-row cohort ADOPTION (option a), symmetric, `startDate`/`umd`-preserving.** The app falsifies the dragged row's entry cohort to the drop neighbour's; `tiRef` is an ordering coordinate, not an entry-date signal.

## Scope (what this campaign does NOT cover)

Only the native `list "Today"` view-axis wire. The engine's OTHER "today-family" reorder paths use DIFFERENT protocols and were not re-probed here: **evening** is bounce-only (no native surface, O03); **day / container-day / tomorrow** ride the dated `when=` bounce or the DLBNC **deadline-cycle** (`deadline=` clear+re-set) / `list "Tomorrow"` one-call wire, none of which re-stamp `tiRef→today` the way `list "Today"` does. The Phase-2 minimal-wire change applies to the `today` (and structurally-identical) native-`list "Today"` compile; the day-axis leg families are unaffected.

## Environment

Things **3.22.12** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v2` (clock pinned 2026-07-05, rolled to 07-06/07-07) · Accessibility via the baked AXVM1 L3 layer (vncdotool HID for the drag arms) · airgapped offline clone · ordering is local (no cloud account).
