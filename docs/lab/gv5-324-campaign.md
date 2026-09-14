# GV5 — minting golden-v5 / golden-v5h (Things 3.24) and the 3.24 recertification sweep

**Version stamp:** `things-lab-golden-v5` (direct arm) and `things-lab-golden-v5h` (routed arm) · Things **3.24** (CFBundleVersion **32400006**, direct-download channel; the maintainer's host is MAS **32400506**) · macOS **15.7.7 (24G720)** guests · `Meta.databaseVersion` **29** · schema fingerprint `sha256:d2b7e98c…` · guest clock pinned **2026-07-05 12:00** · derived by APFS COW from `things-lab-golden-v4` / `-v4h` (Things 3.23 / DB 27). Campaign run **2026-09-14**, unattended, on a macOS **27.0** host. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Companion evidence: [dbv29-migration-diff.md](dbv29-migration-diff.md) (the host measurement, whose data half this campaign supersedes), [ai324-app-intents-catalog.md](ai324-app-intents-catalog.md) (why 3.24's epicenter is invisible to a macOS 15 lab). Golden record: [golden-v5-metadata.json](golden-v5-metadata.json). Predecessors: [gv4-323-campaign.md](gv4-323-campaign.md) + [gv4-323-certification.md](gv4-323-certification.md), whose structure this mirrors.

**ZERO FLIPS.** Every suite and both write-layer arms are green against 3.24 with **no expectation edited, no override added, and no verdict changed**. Unlike GV4 — which had to invent `expectFrom` because 3.23 removed a capability — this campaign changed not one line of any suite. What it *did* have to fix is two pieces of **lab harness** and one piece of **helper build configuration**, all three broken by the maintainer's HOST moving to macOS 27, none of them a Things behavior (§5). Because there are no flips, the reconciliation was carried out in the same change (§6).

---

## 1. How the goldens were built

Both by the drift-runbook DRIFT-1 in-place path, [`lab/scripts/golden-inplace-swap.sh`](../../lab/scripts/golden-inplace-swap.sh), exactly as v4 was:

1. `tart clone things-lab-golden-v4 things-lab-golden-v5` (APFS COW) — and separately `…-v4h → …-v5h`.
2. Boot, delete the default route (airgap verified by a failed ping), pin the clock to 2026-07-05 **before Things is ever launched**.
3. Copy out the pre-swap DB (databaseVersion 27) for the migration diff.
4. `rm -rf /Applications/Things3.app`, then `ditto -xk` + `mv` the pristine 3.24 zip into place — unlink before install, never an in-place overwrite.
5. One warm-up launch; the 27 → 29 migration runs; poll `Meta.databaseVersion` until stable; quit cleanly.
6. Copy out the post-swap DB, truncate `events.ndjson`, re-verify every inherited layer, `tart stop`.

### 1.1 Structural gates — golden-v5

| Gate | Result |
|---|---|
| `CFBundleShortVersionString` / `CFBundleVersion` | 3.23 / 32300036 → **3.24 / 32400006** |
| `LSMinimumSystemVersion` | **13.3, unchanged** — 3.24 still runs on the macOS 15.7.7 guests (3.23 was the release that moved it) |
| Code signature | `Developer ID Application: Cultured Code GmbH & Co. KG (JLMPQHK86H)`, **notarization ticket stapled**, `spctl -a -vv` = **accepted / source=Notarized Developer ID** |
| `Things.sdef` sha256 | `1b6752334207f68cdcb7e71dfc34a21407095bd239afe5df6b3cdd8e2c70cde0` — **byte-identical**, unchanged since 3.22.11. Zero dictionary delta; `_private_experimental_` still declared |
| `Meta.databaseVersion` | **27 → 29**, migrated live by the warm-up launch — the two-step jump with no 28, reproducing the host exactly |
| Schema fingerprint | `sha256:d2b7e98c…` **unchanged** across the migration (measured with `observeSchema()` on both DB copies), zero extra columns either side — `src/db/baselines/db-v29.ts` covers this golden |
| Trial clock | `firstAppLaunchDate = 2026-07-03 03:14:28 +0000`, **not reset** by the in-place update — 13 days of margin at the pin, so the 2026-07-18 wall is unmoved |
| Inherited layers | all six `things-proxy-*` shortcuts present; `kTCCServiceAppleEvents` / `SystemPolicyAllFiles` / `Accessibility` / `ScreenCapture` all `auth_value = 2`; disruption-monitor LaunchAgent intact |
| Positive control (DRPLC1) | **green** — `area add` → read back → `area delete` through the normal CLI on a throwaway clone, each exit 0, `dbVersion: 29`, `fingerprint: ok` |

The **postdated-timestamp curiosity** recurs exactly as GV4 predicted: the 3.24 bundle's signing timestamp is 2026-09-14 13:29:15, later than the pinned clock, so in-guest `codesign -dv` prints `postdated timestamp or bad system clock` while Gatekeeper accepts and the app launches. Harmless, and now confirmed to be a permanent property of pinned-clock goldens rather than a 3.23 artifact.

### 1.2 Structural gates — golden-v5h, and the helper grants

Identical on every row above (same zip, same clock, same fingerprint, same trial clock). The row only this arm can report:

| Gate | Result |
|---|---|
| Helper grants across the app swap | **survived.** On a throwaway v5h clone `things helpers status --json` reads deputy **1.4.0 · running · `axTrusted: true`**, reader **installed, running, granted**, both `signed` to `Developer ID Application: Mike Greiling (VNJWARH2W7)`; `doctor` reads `write: deputy` and `read: helpers` |

This is [DRPLC1](harness.md)'s law — a TCC row keys to the HELPER's code-signing requirement, not to anything about Things — now confirmed at **golden-mint scale** rather than mid-sitting: a routed golden can be re-pointed at a new Things build by the ordinary swap script, with no re-baking and no re-granting.

One harmless curiosity worth writing down because it looks alarming in a log: the deputy reports a **negative `uptimeMs`** (`-242457` here, `-935660821` on an older clone) on every pinned-clock clone. The helper starts at the guest's real boot clock and the driver then rolls the clock *backwards* to the pin, so elapsed time computes negative. A clock artifact, not a sick deputy.

### 1.3 Three mint failures, none of them Things

The v5 mint succeeded first try. **The v5h mint failed three times**, and none of the three was an app problem:

1. **`cp: ~/things-lab/artifacts/Things.sdef: No such file or directory`** — the swap script's evidence step assumed the non-helpers golden's home layout, and the v4h lineage has no `artifacts/` directory. Fixed with a `mkdir -p` in the script.
2. **and 3. SSH password auth flapped past the retry budget**, twice, at different steps. That turned out to be a real harness defect rather than a flake — see §5.1.

---

## 2. The DBV29 migration, re-measured in the lab — and it is ZERO

Full account, with method and transition tables, is appended to [dbv29-migration-diff.md](dbv29-migration-diff.md) as its dated *In-lab re-measurement (GV5)* section, which **supersedes that document's data half**. The three-line version:

- **DDL reproduces exactly**: two new Spotlight tables and two new indexes (`BSSpotlightDirtyEntity` + its partial index, `BSSpotlightIndexState`, `index_TMTask_userModificationDate`), **zero removals**, every pre-existing table/column/index/trigger byte-identical in a full `sqlite_master` **text** diff. Fingerprint identical on both sides; zero extra columns.
- **Data: ZERO changed rows, on every table.** 37 `TMTask` / 3 `TMChecklistItem` / 2 `TMArea` / 10 `TMTag` / 1 `TMSettings`, 0 inserted, 0 deleted, and not one column changed on one row. Against 3.23's migration — which cleared a sentinel on 35 of 37 rows and back-filled four counter columns — **3.24 does nothing to the data at all**.
- **The spawn cursor is SETTLED.** `rt1_instanceCreationStartDate` moved on 96 of 128 templates on the host pair, strictly forward; under the pinned clock here it moves on **0 rows**, on a pair whose only event is the 3.24 warm-up launch. The migration demonstrably ran and did not touch the cursor — so the host's mass forward move is the app catching each stale cursor up to "now" on first launch, exactly as GV4 §2.3 hypothesised and could not prove. The simulator is right not to model a migration-time cursor rewrite. (Bounded honestly: both lab templates sit AT the pin, so this shows the migration does not rewrite a *current* cursor, not that it would leave a *stale* one alone.)

Two pre-flagged readings also re-checked clean: `userModificationDate` was not rewritten (0 changed rows — the new index was built over existing values), and the v27 counter back-fill stands with zero `-1` sentinels remaining anywhere.

**A bound on what any macOS 15 lab can say about 3.24.** Both Spotlight tables are created **EMPTY** and stay empty — including the singleton `BSSpotlightIndexState` row the maintainer's macOS 27 host carries with `isEnabled = 1`. So the migration installs the plumbing on every OS, and the macOS-27-only integration writes the state row when it first runs. The release's entire epicenter is inert on these guests. That is the honest limit of this certification and the standing argument for the queued macOS 27 guest.

---

## 3. `lab:regress` against golden-v5 / v5h — ZERO FLIPS

Run 2026-09-14 with the runner, `regress.sh`, `e2e-write-smoke.sh` and `simfid.sh` re-pointed at the v5 pair. Driven by a non-stop wrapper (the GV4 shape) so every leg reports even when an earlier one fails — `regress.sh` itself is `set -e`. Golden-v4 was GREEN across all of these ([gv4-323-certification.md](gv4-323-certification.md) §1.7), so **every row below is a v4→v5 comparison, and every one is unchanged**.

| suite | probes | result | run id | notes |
|---|---|---|---|---|
| u (URL scheme) | 23 | **GREEN** | `u-20260914-191302` | U12's `when=`-on-a-template crash STILL reproduces (expected, `crash`/tier 0) — the `H-REPEAT-SCHEDULE` guard stays |
| a (AppleScript) | 39 | **GREEN** | `a-20260914-191543` | A01B still carries the 3.23 at-locus regression as `partial`; A10 tier 0, so the GV4 §1.6 race fix holds |
| x (cross-vector) | 3 | **GREEN** | `x-20260914-191911` | — |
| o (ordering) | 38 | **GREEN** | `o-20260914-192004` | **19 probes judged by a `>=3.23` `expectFrom` override** — byte-for-byte the same 19 GV4 reconciled. The private reorder command is still accepted-and-inert on 3.24, so the inertness canary holds and no suspended law is un-suspended |
| r (reminders) | 21 | **GREEN** | `r-20260914-192642` | R09's schedule-class crash still reproduces; R20/R21 still `unsupported` |
| e (editing) | 19 | **GREEN** | `e-20260914-192852` | — |
| p (gap-closure) | 30 | **GREEN** | `p-20260914-193051` | — |
| s (Shortcuts) | 4 (+2 `interactive` skipped) | **GREEN** | `s-20260914-193416` | the six golden-resident proxies still execute under 3.24 on the inherited Always-Allow |
| **write-layer e2e — DIRECT arm** (golden-v5) | **133 steps** | **GREEN, 0 failures** | `things-run-e2e-direct-20260914-143513` | transcript opens `Things 3.24 — native private reorder available: no`; 353 audit records, token-free; `dbVersion: 29` / `fingerprint: ok` throughout |
| **write-layer e2e — ROUTED arm** (golden-v5h) | **136 steps** | **GREEN, 0 failures** | `things-run-e2e-routed-20260914-144307` | plus the routed GUI smoke: **2 steps, 0 failures** — a real `todo add-repeating` driving the Repeat dialog **through the deputy** in **3 s**, the new template verified in the database by title, and the broker refusing no script |

**Alert beeps: 0 on every leg**, with the BEEPSEN1 sentinel armed throughout (70 / 118 / 10 / 115 / 64 / … marks per run, every window clean).

### 3.1 What this means, stated plainly

Things 3.24 is a **behavioral no-op update for everything the lab can reach**, the way 3.22.12 and 3.22.14 were and 3.23 emphatically was not. The sdef did not move, the migration touched no data, no probe changed verdict or tier, no refusal copy changed, and the shipped engine's 3.24 routing is identical to its 3.23 routing — the version gate still reads *native private reorder available: no* and takes the same SIT7 fallbacks. That is what earns the blanket register amendment in §6, with the 3.23 suspensions left exactly where they are.

### 3.2 No GUI surface delta, and why no AX census was run

No ui-vector suite flipped, and the routed GUI smoke drove the real Repeat dialog end-to-end through the broker on the first attempt, in 3 s, with zero beeps — so no recipe's tree moved and the [RDLG1](rdlg1-323-repeat-dialog-census.md) census method was not needed. **No GUI surface delta observed on macOS 15 guests; 3.24's GUI changes are macOS-27-gated** (the new Siri, Spotlight, the extra-tall widget, expanded notification snoozing), and none of them exist on these guests to census. What the macOS 27 AX stack does to these same recipes is a different question needing a different arm, and it stays queued.

---

## 4. SIMFID — applier fidelity re-certified under 3.24

Drift-runbook step 5. `SIMULATED_DATABASE_VERSION` and the fixture stamp already moved to 29 when the baseline shipped (#753), so this cycle is a verification pass rather than a re-model — and the §2 measurement is what justifies that: the appliers model DATA semantics, and 3.24 moved none.

| leg | result |
|---|---|
| `npm run lab:simfid -- --gate` (host-side replay against banked evidence) | **exit 0** — 35 cases: **30 MATCH · 5 TOLERATED · 0 DIVERGENT · 0 replay-error**, row for row identical to GV4-CERT |
| `bash lab/scripts/simfid.sh -- --gate` (fresh **golden-v5** clone drive of the headless CRUD cases) | **exit 0** — 35 cases: **30 MATCH · 5 TOLERATED · 0 DIVERGENT · 0 replay-error**, clone drive `simfid-clone-20260914-152009`, comparator `simfid-20260914-202138`. All six headless cases `op exit=0`; the six app deltas are fresh **Things 3.24 / golden-v5** captures, superseding the 2026-08-22 golden-v4 / 3.23 ones |

**The first attempt of this leg read 3 DIVERGENT, and it was the harness — see §5.4.** It is recorded rather than quietly re-run, because the shape it produced is the most dangerous one this lab can produce: a refused op writes nothing, an empty delta looks exactly like "the app no longer changes this row", and three rows therefore presented as a Things 3.24 behavior change. Run `simfid-clone-20260914-144450` / comparator `simfid-20260914-194610` is that false reading, kept as the negative control.

The five tolerated rows are the same five: `instance-next-sentinel` on the three `make-repeating` families and `rt1-child-backlink` on the project-with-children ones. Both tolerances keep their GV4-CERT rationale unchanged — nothing in 27 → 29 reaches child back-links or the sentinel's ≤3.22 provenance.

---

## 5. What actually broke: the HOST moved to macOS 27

The only red this campaign produced came from the maintainer's own machine having been upgraded to macOS **27.0**, not from Things 3.24. All three are fixed in this change, and all three are the kind of breakage that would have read as an app finding to a less suspicious run.

### 5.1 `lab_ssh`'s documented retry had never actually run

`lab/scripts/env.sh`'s `lab_ssh` has retried exit-255 "since fresh clones flap password auth in their first seconds" — except it never did, in any bash driver. The loop was

```sh
sshpass … ssh …
code=$?
```

and **every lab driver runs under `set -e`**, so the first failing `sshpass` aborted the whole script before `code=$?` was ever read. The retry only worked inside `lab_wait_for_ssh`, where the call sits in an `if` and `set -e` is suspended — which is exactly why clone BOOTS looked reliable while everything after the boot died on the first flap. Three golden mints and a positive-control run were killed by this before it was spotted.

Fixed by capturing the status with `|| code=$?` (the `set -e`-safe form) and widening the budget to five attempts with a linear backoff. The `|| code=$?` is the load-bearing half; the wider budget is because a **v4h/v5h** clone — whose helper LaunchAgents come up alongside sshd — flapped for longer than 6 s on two of three mints.

### 5.2 `lab_scp` had no retry at all, and a naive one is WRONG

`lab_scp` never retried, so the same flap mid-transfer (`scp: Connection closed`) killed drivers outright. Adding a retry is right, but adding a *naive* one is worse than none: **`scp -r src host:dest` is not idempotent** — the failed first attempt creates `dest`, so the retry copies INTO it and lands `dest/dest`. That is precisely what happened on the first routed-arm re-run: `dist` became `dist/dist`, `dist/cli/main.js` was absent, and the arm failed with a *completely* misleading message about the deputy not running. Every retry of a recursive copy now removes the remote destination first.

### 5.3 The helper binaries were built with `minos 28.0` — the routed arm's real blocker

**This is the finding worth the maintainer's attention.** With both transport bugs fixed, the routed arm still failed identically, and — the discriminator that mattered — **it reproduced byte-for-byte on a `golden-v4h` clone**, so it was never about 3.24 or about golden-v5h.

The symptom the CLI shows is uninformative: `error: the deputy is not running (no socket at …/deputy.sock)`. `launchctl print` tells the truth:

```
runs = 2
successive crashes = 2
last exit reason = OS_REASON_DYLD
```

and `otool -l` on the host-built binary names the cause:

```
LC_BUILD_VERSION   platform 1   minos 28.0   sdk 26.5
```

**`swiftc` with no `-target` defaults the deployment target to the BUILD HOST's OS version.** Once the maintainer's Mac went to macOS 27, every `scripts/build-helpers.sh` run produced a helper pair that dyld refuses to load on anything older — including every macOS 15.7.7 lab guest, and including any user's Mac not yet on 27. Nothing about it is lab-specific: **a released helper built on that host would have been unloadable for most users**, failing with the same unhelpful "not running (no socket)".

Fixed by pinning `DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET:-arm64-apple-macos13.0}"` and passing it to both `swiftc` invocations. The floor matches Things' own `LSMinimumSystemVersion` (13.3), so the helper runs anywhere the app it drives runs; both binaries now report `minos 13.0`, the source compiles at that floor with no availability errors, and the routed arm goes green on the next run. This is the fifth entry in the pattern the release gate exists for — machinery that is impeccable in one environment and dead in another — except that this time the differing environment is the BUILD host rather than the run host, which no existing gate step looks at.

**A standing check follows from it**, and is now in the [release checklist](../reference/release-checklist.md): assert the built helper's `minos` before shipping, because the value silently tracks whatever OS the maintainer last upgraded to.

### 5.4 The SIMFID clone driver never got the write escape — and a refusal looked like an app finding

The fourth breakage is the subtlest, and unlike the other three it was NOT caused by macOS 27. The SIMFID clone leg came back **27 MATCH · 5 TOLERATED · 3 DIVERGENT** (`simfid-clone-20260914-144450`, comparator `simfid-20260914-194610`), with `todo-reopen`, `todo-delete` and `tag-add-root` all reading *row changed by SIM only* — the comparator's way of saying **the app did nothing**. Three CRUD rows appearing to stop changing under a new Things build is exactly the shape of a real behavioral flip, and it would have been written up as one.

It was a refusal. Each of the three ops exited **4** (`Blocked` — "refused before touching the app"), so the clone captured a byte-empty delta. The split is perfectly diagnostic once seen: `todo.complete`, `todo.cancel` and `project.update` — the three that MATCHed — all compile a **URL-scheme** leg, while `todo.delete` and `tag.add` are **AppleScript-only by construction** (`if (vector !== "applescript") unsupportedVector(...)`) and `todo.reopen` resolves to the AppleScript status setter. A guest shell descends from sshd and carries no bundle id, so `writeCapability` reads `direct-unknown` and refuses every AppleScript-vector verb unless `THINGS_API_WRITE_DIRECT=1` says the clone's in-guest grant is real.

**The dates make it an omission, not a regression.** The prompt-free capability gate landed **2026-08-24** (#564, permissions doctrine WAVE A); the `THINGS_API_WRITE_DIRECT` escape landed **2026-08-25** (#597), which updated `lab/guest/e2e-write-smoke.sh` and `lab/scripts/env.sh` — every driver that was being run at the time. The SIMFID clone leg had last run on **2026-08-22**, two days *before* the gate existed, so nothing failed and nobody noticed; it has been latently broken for three weeks and this campaign is its first run since. That is the general hazard: **a lab driver that is only exercised at golden-mint time misses every doctrine change made between mints, and reports the miss as an app finding.**

Three fixes, all in this change:

1. `simfid.sh` now prefixes the guest drive with `$LAB_WRITE_DIRECT`, the same constant every other driver uses. The **ui** escape is deliberately not exported — the headless manifest drives no ui-vector op, and an escape nothing needs only widens what a clone may do.
2. The guest driver **fails closed**: it banks each op's exit code, stdout and stderr as `cases/<id>.op.json`, prints the refusal, and returns non-zero. `simfid.sh` aborts on that before the comparator ever runs, so a refused op can no longer be laundered into a verdict. This is the same class of defect as the 2026-07-22 SIGABRT (a non-self-contained guest node produced a spurious `tag-add-root` DIVERGENT from an empty delta) — caught twice now by inspection rather than by the harness, which is why the check is now the harness's.
3. Re-drive: **30 MATCH · 5 TOLERATED · 0 DIVERGENT**, gate exit 0, all six ops `exit=0` (`simfid-clone-20260914-152009`, comparator `simfid-20260914-202138`, 90 s wall clock end to end including the clone, boot, airgap and teardown).

**The rule this earns: an EMPTY app delta is never evidence until the op's exit code has been read.** A no-op and a refusal are indistinguishable downstream of the snapshot, and only one of them is a measurement.

---

## 6. Certification and the register walk

Because §3 is zero flips, this campaign both mints and certifies, rather than splitting across two documents the way 3.23 had to.

`things-lab-golden-v5` and `things-lab-golden-v5h` (Things 3.24, build 32400006, database version 29) are **CERTIFIED** as the active goldens. The register amendment is the **blanket** one, which 3.22.12 and 3.22.14 received and 3.23 was correctly refused: every law whose live lock ran green is stamped `3.24 (golden-v5)`, because — unlike 3.23 — no suite row went green by being reconciled to a *new* app behavior. Nothing was reconciled, so nothing can be hiding behind a reconciliation.

Two things are deliberately NOT changed:

- **The 3.23 suspensions stay suspended.** Every ordering law resting on `_private_experimental_ reorder to dos in` (ORD-1/2/3/7/8/9/12-HEADSORT/19/20/22) is still recorded SUSPENDED. The command is still accepted-and-inert on 3.24; the o-suite's 19 version-conditional rows assert that inertness and went green asserting it, which confirms the *suspension*, not the *law*. A suspended row does not accrue a version stamp by being suspended for one more release.
- **The standing residue is unchanged** — laws whose only lock is unit/engine/evidence-level, or which need a rig `lab:regress` cannot host (a clock roll, a TZ shift, a framebuffer, a live Things Cloud account). They are enumerated per-row in the register's 3.23 audit block and a missing stamp there is not drift.

`things config set certified-app-version 3.24` was **deliberately not run**. It stamps the operator's own config on the live host and silences `doctor`'s passive behavioral-drift notice, so it waits on the maintainer — and it has to be done on **both** of his Macs.

### What "certified" claims here

It claims: every suite and both write-layer arms run green against 3.24 images with no expectation changed; the substrate migration is measured on a clean clock-pinned pair and is DDL-only; the shipped engine's 3.24 behavior, including the deputy-routed path and one real GUI drive, is exercised end to end.

It does not claim anything about 3.24's actual epicenter. **The Siri / Spotlight / App-Intents integration is macOS-27-only and structurally unreachable from a macOS 15.7.7 guest** (§2), and the new `index_TMTask_userModificationDate` raises a forward question — whether the Spotlight indexer now consumes `userModificationDate` as a change feed, and what a deliberately-backdated `umd` does to indexing — that this campaign could not touch for the same reason. Both stay queued against the macOS 27 guest.

---

## 7. Operational notes

- **Disk.** 16 GiB free on `/Volumes/Workspace` at the start and **13 GiB at the end**, every clone torn down (`df`, never `du` — see the harness disk note). The SIMFID re-drive started with 14 GiB free against `simfid.sh`'s own 12 GiB floor — the narrowest margin this campaign ran at, and the reason the preflight check earns its keep. Both new goldens are APFS COW descendants of the v4 pair, so their cost is their own delta, not 25 GB each. The v4/v4h images are **retained**, retired in place; deleting them is the maintainer's call and would reclaim only their unique extents.
- **Wall clock.** Mint v5 ≈ 9 min; mint v5h ≈ 6 min (plus three failed attempts); two positive controls ≈ 1 min each; the eight suites 22 min (14:13 → 14:35); the two e2e arms ≈ 2 min each; SIMFID host-side seconds; the clone drive **90 s** end to end (clone, boot, airgap, clock pin, ship, drive six cases, collect, ingest, compare, teardown) — measured on the re-drive. End to end under two hours including the three mint failures and the `minos` investigation, plus a 90 s re-drive the next sitting for §5.4.
- **The trial wall is unmoved** — `firstAppLaunchDate` is inherited, not reset, so golden-v5's wall is still **2026-07-18** and every clock-rolling driver's `TRIAL_WALL` constant stays correct.
- **The pre/post migration DB pair is small enough to keep.** `db-pre-swap.sqlite` (176 KB, dbv 27) and `db-post-swap.sqlite` (192 KB, dbv 29) on each lineage are the §2 measurement's own inputs, banked with the rest of the run under the gitignored `lab/artifacts/gv5-20260914/` in the primary checkout. They are golden-seed data, fully synthetic, and never committed.
- **The swap script's trial-clock gate had been reading BLANK.** It ran `defaults read com.culturedcode.ThingsMac firstAppLaunchDate`, which prints nothing — the value lives in the GROUP CONTAINER plist (`…/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist`) — and a trailing `|| true` swallowed the emptiness. Now read by path, so the gate actually reports.
- **New reusable rig:** [`lab/scripts/gv5-poscontrol.sh`](../../lab/scripts/gv5-poscontrol.sh) — the DRPLC1 positive control as a standalone script (`gv5-poscontrol.sh <golden>`): clone, airgap, pin, ship the CLI, create → read → delete an area, and on a `*h` golden additionally report `helpers status`. Any future golden mint should end with it.

### A dated note on getting into the lab at all (2026-09-14)

**Attempt 1 of this campaign never reached step 1**, and the reason is now a standing pre-check. On macOS 27 the per-app **Local Network** privacy grant is enforced more tightly, and without it for the terminal app the host cannot ARP its own guests: a freshly cloned VM takes a DHCP lease (visible in `/var/db/dhcpd_leases`) and then answers nothing, so `lab_wait_for_ssh` times out looking exactly like a silent-first-boot flake. It is not a flake and there is nothing to script around — it is a TCC grant, and the only fix is the maintainer approving Local Network for the terminal in System Settings.

**The lab's positive control is therefore now `ping` the LAN gateway before any campaign**, and a failure stops the campaign rather than provoking a harness patch. Attempt 1 modified `golden-inplace-swap.sh` and `lab_wait_for_ssh` chasing the phantom boot flake and had to revert both. The diagnostic that distinguishes them in one step: **a guest holding a DHCP lease that never answers ARP is a HOST PERMISSION problem, not a guest boot problem.**
