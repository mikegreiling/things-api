# PERF1 — UI-drive wall-clock reduction (session-reachability probe scoping)

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00.** ONE disposable clone `perf1probe` of golden-v3 (golden untouched), airgapped. golden-v3 carries the baked L3-accessibility grant, so the raw probe osascripts run their AX enumeration over SSH. Measures the SESSGATE session-reachability probe script ONLY (no CLI bundle shipped). Fixtures/desktop fully synthetic (the golden's own empty state). The live-host trace this optimizes against (maintainer's desktop, 2026-08-18) is referenced in shape only; the real host's data is deliberately kept out of the repo. Sibling to [trace1-drive-timings.md](trace1-drive-timings.md) (which stays immutable — the whole-drive baseline).

## The measured problem (host trace, 2026-08-18)

A single `todo add-repeating … --dangerously-drive-gui` on the maintainer's large, actively-syncing production desktop took ~28.8s. The session-reachability probe ran TWICE — 8053ms + 7068ms = **15.2s, 53% of the whole invocation**:

- once as the orchestrator's **pre-seed gate** (`gateSessionReachability`, `src/write/promote-clone.ts`), before the composite seeds its row;
- once as the **in-drive gate** (`ensureWindowReachable`, `src/write/vectors/ui.ts`), after the reveal and before the menu press.

The probe (`axSessionReachabilityScript`, `src/write/vectors/session-reachability.ts`) enumerated AX windows across EVERY foreground process via System Events to compute `allAx` (the app-wide window total) on every call. That walk is near-free on the empty lab golden but seconds-long on a busy real desktop with many window-bearing apps (browsers with many windows, etc.). Both gates paid it in full, ~20s apart.

The probe's three-value output is `"AS AX ALL"` — Things' own AppleScript window count, the System-Events AX window count for Things, and the app-wide AX total — and the discriminator (`interpretReachability`) is:

- `thingsAx >= 1` → **reachable** (`allAx` irrelevant);
- `thingsAx = 0` AND `allAx = 0` → **session** (locked screen / full-screen Space hides every window — refuse);
- `thingsAx = 0` AND `allAx > 0` → **window** (Things' window is on another Space or absent — relocate);
- unparseable / `thingsAx < 0` → **reachable** (fail-open).

## The fix (behavior-preserving)

Two changes, neither of which alters any verdict `interpretReachability` can produce:

1. **Gate the app-wide walk behind `thingsAx = 0`.** When Things has an AX-visible window (`thingsAx >= 1`, the common healthy case — and the maintainer's normal desktop state) the verdict is already "reachable" regardless of `allAx`, so the walk is pure waste. It is skipped and `allAx` is left at `-1` (never consulted on that branch). When `thingsAx < 0` (AX unreadable) the gate fail-opens on `thingsAx`, so the walk is likewise skipped.
2. **Short-circuit the walk when it does run.** With `thingsAx = 0`, stop at the FIRST window-bearing app and report `allAx = 1` (not the sum). The discriminator only ever tests `allAx === 0` vs `> 0`, so a boolean "any other window?" yields byte-identical verdicts while avoiding the cost of materializing every app's full window list.

Plus an **intra-invocation memo** (`createReachabilityCache`) shared between the two gates so a promote composite does not probe twice. Only a `reachable` verdict is memoized (30s TTL): a not-reachable verdict must always re-probe fresh because the in-drive gate runs AFTER the reveal — which can legitimately turn a pre-seed "window" verdict into "reachable" — and because a mid-drive lock/Space-move is caught by the cleanup path's OWN independent blindness probe (`clearDialog`, deliberately not routed through the memo). See the ruling in [docs/design/decisions.md](../design/decisions.md) 2026-08-18 (PERF1).

## Before/after measurement (golden-v3, raw probe script, N=7 reps each)

Collected by [`lab/scripts/research-perf1-probe.sh`](../../lab/scripts/research-perf1-probe.sh): the OLD (always-walk, summed `allAx`) and NEW (gated + short-circuit) probe osascripts run back-to-back against the live Things app, timed on the guest with `Time::HiRes` around the `osascript` subprocess (SSH round-trip excluded — this is the pure per-hop cost the drive pays). Artifacts (gitignored): `lab/artifacts/perf1-probe/`. **Foreground app processes on this golden desktop: 1** (Things only) — so the walk here traverses a SINGLE app; the maintainer's busy desktop has many, which is why the golden cannot reproduce the 8s magnitude (same reason TRACE1 can't reproduce #487's slowness).

| state | script | probe output | verdict | osascript ms (min/median/max) |
| --- | --- | --- | --- | ---: |
| A — Things reachable (`thingsAx=2`) | OLD (walk runs) | `1 2 2` | reachable | 98 / **109** / 159 |
| A — Things reachable (`thingsAx=2`) | NEW (walk skipped) | `1 2 -1` | reachable | 64 / **67** / 84 |
| B — one AX window (`thingsAx=1`) | OLD (walk runs) | `0 1 1` | reachable | 99 / **104** / 117 |
| B — one AX window (`thingsAx=1`) | NEW (walk skipped) | `0 1 -1` | reachable | 63 / **64** / 78 |

**Verdict equivalence (live):** in both states OLD and NEW resolve to the SAME verdict. The `allAx` value differs (`2`/`1` vs `-1`) precisely because the NEW script skips the walk, but `interpretReachability` never consults `allAx` when `thingsAx >= 1`, so the verdicts are byte-identical. The `thingsAx = 0` walk-short-circuit path (where `allAx` DOES decide session-vs-window) could not be forced live — Things retains one AX window even after `close windows` (state B landed `thingsAx=1`, an AppleScript-vs-AX divergence: `thingsAs=0` but `thingsAx=1`) — so its equivalence is locked by unit tests instead (`test/unit/session-reachability.test.ts`: `1 0 0` → session, `1 0 4`/`0 0 4` → window, identical under both the sum and the short-circuit).

**Timing:** even on this single-app golden, skipping the walk cuts the reachable-case probe **~38%** (109 → 67ms; 104 → 64ms) — the ~40ms delta is the cost of walking ONE foreground app. On the maintainer's busy desktop that same walk cost ~8s; the NEW probe skips it entirely in the reachable case (the desktop's normal state), and the memo drops the composite's second probe to zero.

## Projected host improvement

The host trace's 15.2s was two full-walk probes (8053 + 7068ms) in the reachable state. Post-PERF1:

- **Probe 1 (pre-seed gate):** `thingsAx >= 1` → walk skipped → one osascript hop of the two cheap window counts (the golden shows tens of ms; even several × on a busy host it is sub-second, not 8s).
- **Probe 2 (in-drive gate):** served from the memo (probe 1 was reachable, < 30s prior) → **0 additional probe cost**.

So the ~15.2s / 53% collapses to a single sub-second probe — the bulk of the 28.8s add-repeating's probe overhead is removed, with the refuse-locked / relocate-wrong-Space / disclose semantics unchanged. (The exact busy-desktop residual is not re-measurable in-lab; it is bounded above by one scoped-probe hop.)

## Deferred (PERF1 brief deliverables 2 & 3)

The set-datetime `AXDateTimeArea` collect scoping (the 4390ms app-root tree walk) and the per-step delay audit (settle delays, redundant re-polls, spawn overhead) are deferred to a follow-up — see [docs/up-next.md](../up-next.md) (small code). This doc will be extended (not re-stamped) when they land, or a sibling campaign doc will be added if they run under a new golden.
