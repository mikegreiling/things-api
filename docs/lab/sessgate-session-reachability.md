# SESSGATE — the TRUE #480 root cause: dialog-class ui ops need an AX-reachable window (session reachability)

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00.** ONE disposable clone `sessgate` of golden-v3 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v3 carries the baked L3-accessibility grant, so the ui-vector drives and the AX/AS window-count probes ran over SSH via System Events — no VNC. Ground truth = read-only guest SQLite + the live osascript window counts. Fixtures fully synthetic (`SESSGATE *` titles). Driver [`lab/scripts/research-sessgate.sh`](../../lab/scripts/research-sessgate.sh); the stuck-modal follow-up [`lab/scripts/research-sessgate-modal.sh`](../../lab/scripts/research-sessgate-modal.sh); artifacts (gitignored) `lab/artifacts/sessgate-lab/`.

The **live-host discovery** (maintainer's desktop, 2026-08-16) is the ground truth this campaign reproduces in-lab. The uuid/audit specifics of that host session are deliberately kept out of the repo (it was the maintainer's real database); everything below is the in-lab reproduction with synthetic to-dos.

## The report (#480) and the earlier miss

#480 was `todo add-repeating` timing out at "the Repeat dialog", leaving a residue seed that could not be trashed. ADR1 (golden-v2/3.22.12) and gv3-certification (golden-v3/3.22.14) both found it **does NOT reproduce in a clean airgapped clone** — the drive succeeds end-to-end. That left the divergence unexplained and pinned on "suspected 3.22.14 behavior change / sync / prod-DB scale". **SESSGATE found the real differentiator: SESSION STATE, not app version.**

## The live-host root cause (ground truth reproduced here)

The maintainer's session had **NO AX-reachable windows**: `System Events` reported **0 windows for EVERY process** (Things, Finder, Safari) while Things' own AppleScript dictionary reported **1 visible normal window**. Cause class: the screen was locked, or a full-screen app's Space hid all normal windows from the session's AX view (System Events enumerates current-Space windows only). In that state the #480 cascade is:

1. `things:///show?id=` selection works at the AS level and the Items menu is AX-reachable; the drive's eligibility assertion PASSES.
2. The menu press succeeds and the Repeat dialog opens **as a sheet on the AX-unreachable window** → the dialog-wait times out.
3. The Escape cleanup claimed "confirmed gone" — but it was AX-blind to the sheet, which actually **remained open**.
4. The still-open modal sheet **blocks AppleScript mutations app-wide**: the seed auto-trash (`delete to do id …`) returned verify-failed:silent-noop. This is the #480/#483 auto-trash failure — modal-blocked, not vector-broken (corroborates ADR1's "leftover modal blocks URL adds" bonus finding: the block extends to AS deletes).
5. Recovery that WORKS from the blind context: AppleScript `close window 1` (takes the stuck sheet with it) then `reopen` — app-level, no AX needed.

## In-lab reproduction (golden-v3 / 3.22.14)

The reachability probe is the exact three-count shape the shipped gate uses (`src/write/vectors/session-reachability.ts`): `thingsAs` (Things' own `count windows`), `thingsAx` (System Events windows of process Things3), `allAx` (System Events windows summed over every foreground app). All values are over SSH — AX menu presses and window counts work under lock (AXVM1), and the AS-mutation block is observable without unlocking, so no VNC was needed.

| Cell | State established | Discriminator (`AS AX ALL`) | Verdict |
|---|---|---|---|
| **A. baseline reachable** | window up (warm) | **`1 2 2`** | reachable — the gate proceeds |
| **C. window-scope** | `close every window of Things` (a Finder window kept open) | **`0 0 1`** (Things AX=0, others AX>0) | "window" scope; the maneuver `close window 1`+`reopen`+`activate` restores **`1 2 3`** — relocation makes the window AX-reachable |
| **B. locked session** | `sysadminctl -screenLock` + `SACLockScreenImmediate` | **`1 0 0`** (Things AS=1, every process AX=0) | "session" scope — exactly the live-host signature |

### The stuck-modal → AS-mutation-block → recovery chain (cell B follow-up — INCONCLUSIVE in-lab; law rests on live host + ADR1)

The modal-block law itself (§9cc) is the LIVE-HOST ground truth (the seed auto-trash `delete to do` returned audit-verified verify-failed:silent-noop while the sheet was stuck) plus ADR1's corroborating "a leftover Repeat dialog swallows `things:///add`" bonus finding. The tight in-lab follow-up ([`research-sessgate-modal.sh`](../../lab/scripts/research-sessgate-modal.sh)) attempted to reproduce it by opening the sheet **while UNLOCKED** (the plain `Items ▸ Repeat…` is frontmost-dependent, §9dd, so it does not open under a locked *screen*) and then locking — but it was **inconclusive**: a `make new to do` + raw `things:///show?id=` reveal did **not** leave the freshly-made row selected (`id of selected to dos` came back empty), so `Items ▸ Repeat…` never opened a sheet (`sheet visible while UNLOCKED` = `no-sheet`), and with no modal present the subsequent AS delete simply landed (`trashed=1`). This is a lab-scripting **selection-timing artifact** of the raw two-command reveal (the full CLI drive's reveal+settle+eligibility-assertion DID select and open the dialog — cell D1 above drove all 10 steps), not a refutation of the law. Re-establishing the stuck sheet in-lab needs the CLI drive's selection path (or a longer post-reveal settle) before the lock; the mechanistic block is nonetheless well-evidenced by the live host + ADR1, and the RECOVERY maneuver's core property (`close window 1` + `reopen` restores an AX-reachable window without the Accessibility tree) IS certified in cell C (`0 0 1` → `1 2 3`).

## The fix, re-certified in-lab

| Cell | Op (FIXED build) | Result |
|---|---|---|
| **D1. no regression (unlocked)** | `todo make-repeating … --dangerously-drive-gui` | **template created** (`drove 10 steps`), original trashed=1 — full success, no regression |
| **D2. refuse under lock** | `todo make-repeating … --dangerously-drive-gui` under the locked (`1 0 0`) session | **`blocked` exit 4, `code: blocked:H-UI-SESSION-UNREACHABLE`**; original untouched (`trashed=0`), **no template minted, no clone row** — zero mutation |

The wrong-Space **relocation** branch's discriminator (`0 0 1`) and its recovery maneuver (→`1 2 3`) are certified in cell C; the end-to-end drive-through-relocation is certified at the unit level (`test/engine/write-ui-vector.test.ts` — probe returns off-Space, then reachable after the close+reopen), because a genuine another-Space window is not headlessly orchestrable (macOS exposes no scriptable Spaces API), and in the no-window lab variant the drive's own `reveal` re-surfaces a window before the gate re-probes, so the relocation is not exercised end-to-end there.

## Laws banked (oddities)

- **§9cc** — an open modal sheet blocks AppleScript object-model mutations app-wide until dismissed; `close window 1`+`reopen` recovers even when AX-blind.
- **§9dd** — `Items ▸ Repeat…` is selection- AND frontmost-dependent; no background Repeat-dialog drive is possible (the `activate` preamble is load-bearing for dialog-class ops).

## What shipped (see [ui-vector.md](../design/ui-vector.md) three-state matrix)

The dialog-class recipes carry `needsWindowReachability`; the driver probes after the reveal and, per the three-state discriminator, **proceeds / relocates+discloses / refuses (exit 4)**. The promote orchestrators additionally refuse the locked signature BEFORE seeding (zero orphan rows). The failure cleanup is honest (never "confirmed gone" while AX-blind — it runs the proven close+reopen and says so).
