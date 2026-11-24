# GV6 — minting golden-v6 / golden-v6h (Things 3.25) and the 3.25 recertification sweep

**Version stamp:** `things-lab-golden-v6` (direct arm) and `things-lab-golden-v6h` (routed arm) · Things **3.25** (CFBundleVersion **32500008**, direct-download channel; the maintainer's host was still on MAS 3.24.2 / 32402507, so the MAS 3.25 build is **not yet observed**) · macOS **15.7.7 (24G720)** guests · `Meta.databaseVersion` **30** · schema fingerprint `sha256:d2b7e98c…` · guest clock pinned **2026-07-05 12:00** · derived by APFS COW from `things-lab-golden-v5` / `-v5h` (Things 3.24 / DB 29). Campaign run **2026-11-24**, unattended, on a macOS **27.0** host. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Predecessor and template: [gv5-324-campaign.md](gv5-324-campaign.md). Golden record: [golden-v6-metadata.json](golden-v6-metadata.json).

**VERDICT: NOT CERTIFIED — zero suite flips, one app flip outside the suites' reach.** All eight suites (177 probes) and both write-layer arms are green, every probe identical to GV5 on verdict, tier, crash flag and `expectFrom` application. But Things 3.25 changed where a one-call json `[someday, anytime]` update files a loose to-do (§6), and the shipped `things reorder <x> --in anytime` bounce route depends on the old placement: on 3.25 it puts the item last and exits 0. The suites lock only the heading half of that law, so they stayed green. It is recorded, not fixed (§6.3), and ORD-5's register row is left un-stamped.

Two further findings are NOT 3.25 changes, and both matter beyond this release (§5): the Repeat-dialog shape manifest never covered 3.24, so every 3.24.x host has been running the fallback drive path since September; and four shipped ui-vector operations refuse on 3.23, 3.24 and 3.25 alike.

---

## 1. How the goldens were built

`lab/scripts/golden-inplace-swap.sh` (DRIFT-1 in-place), exactly as GV5: clone v5 → v6 (and v5h → v6h), boot, airgap, pin the clock before any launch, copy out the pre-swap DB, `rm -rf` + `ditto -xk` the banked 3.25 zip (`/Volumes/Workspace/things-releases/Things3-3.25-32500008.zip`, sha256 `d3e96b1f…49d1`), warm-up launch until `databaseVersion` is stable, copy out the post-swap DB, stop. Both mints succeeded first try (v6 ≈ 2 min, v6h ≈ 2 min); the GV5 transport fixes held. One SSH password flap during the v6 warm-up poll was absorbed by the polling loop.

| Gate | golden-v6 / golden-v6h |
|---|---|
| `CFBundleShortVersionString` / `CFBundleVersion` | 3.24 / 32400006 → **3.25 / 32500008** |
| `LSMinimumSystemVersion` | **13.3, unchanged** |
| Code signature | signing timestamp 2026-11-24 09:18:17, later than the pinned clock, so in-guest `codesign -dv` prints the permanent *postdated timestamp* curiosity; the app launches |
| `Things.sdef` sha256 | **CHANGED** for the first time since 3.22.11: `069e9ed6…1219`. The whole diff is the removal of two hidden commands, `filter by previous top tag` (THGSfptt) and `filter by next top tag` (THGSfntt), which nothing in `src/`, `lab/suites` or `lab/scripts` uses. All seven `_private_experimental_` declarations remain |
| `Meta.databaseVersion` | **29 → 30**, migrated live by the warm-up launch, both lineages |
| Schema fingerprint | `sha256:d2b7e98c…` **unchanged** (`observeSchema()` on both DB copies of both lineages), zero extra-column delta |
| Trial clock | `firstAppLaunchDate = 2026-07-03 03:14:28 +0000`, **not reset** — the 2026-07-18 wall is unmoved |
| Inherited layers | six `things-proxy-*` shortcuts present; AppleEvents / FDA / Accessibility / ScreenCapture rows for `sshd-keygen-wrapper` all `auth_value = 2`; v6h also carries the `com.pixelcog.things-api-helper` AppleEvents + Accessibility rows |
| Positive control (DRPLC1, `gv5-poscontrol.sh`) | **green on both** — `area add` → read back → `area delete`, each exit 0, `dbVersion: 30`, `fingerprint: ok` |
| Helper grants (v6h) | **survived the swap again** — deputy 1.4.0 running · `axTrusted: true` · reader installed, running, granted · both signed `Developer ID Application: Mike Greiling (VNJWARH2W7)`; `doctor` reads `write: deputy` / `read: helpers` |

## 2. The 29 → 30 migration: a stamp and nothing else

On both lineages, comparing the banked pre/post pair:

- **DDL: none.** The full `sqlite_master` text (type, name, table, SQL of every table, index and trigger; 191 rows) is byte-identical. 27 → 29 had added two Spotlight tables and two indexes; 29 → 30 adds nothing.
- **Data: none, except the stamp.** Every table dumped row by row (`.mode quote`, ordered) is identical apart from `Meta.databaseVersion` (29 → 30). 37 TMTask, 3 TMChecklistItem, 2 TMArea, 10 TMTag, 3 TMTaskTag, 1 TMAreaTag, 1 TMSettings; 0 inserted, 0 deleted.
- **Bound:** the seed holds no TMContact, TMSmartList or TMTombstone rows and both Spotlight tables are empty on a macOS 15 guest, so a step that touches only row shapes absent from the seed cannot show here.

**Decision point (b) applied:** stamp bumped, fingerprint byte-identical. Per the 2026-08-22 identical-schema ruling (precedent #753) `src/db/baselines/db-v30.ts` ships reusing the hash, with the drift-runbook step 5 lockstep: fixture stamp 30, `SIMULATED_DATABASE_VERSION` 30, the shared fixture DDL unchanged apart from a header note, the atlas and bench ROADMAP updated. Unlike 3.23/3.24 the baseline had to land BEFORE the gate ran: without it every guest CLI write is blocked as `unknown-version`, so the lab could not have exercised its own write layer (recorded in decisions.md).

## 3. `lab:regress` against golden-v6 / v6h — ZERO SUITE FLIPS

Run 2026-11-24 with the four pointers promoted, driven by the GV5 non-stop wrapper so every leg reports. Each suite's `verdicts.json` was compared probe by probe with GV5's banked runs (`lab/artifacts/gv5-20260914/suites/`) on verdict, tier, crash flag, `ok` and `appliedFrom`: **0 differences across 177 probes**.

| suite | probes | result | run id |
|---|---|---|---|
| u | 23 | GREEN (U12 crash still reproduces; guard stays) | `u-20261124-172244` |
| a | 39 | GREEN | `a-20261124-172517` |
| x | 3 | GREEN | `x-20261124-172844` |
| o | 38 | GREEN — the same 19 `>=3.23` overrides applied and green | `o-20261124-172930` |
| r | 21 | GREEN | `r-20261124-173609` |
| e | 19 | GREEN | `e-20261124-173809` |
| p | 30 | GREEN | `p-20261124-174004` |
| s | 4 (+2 interactive skipped) | GREEN | `s-20261124-174318` |
| **e2e — DIRECT arm** (golden-v6) | **133 steps, 0 failures** | GREEN; transcript opens `Things 3.25 — native private reorder available: no` | `things-run-e2e-direct-20261124-114411` |
| **e2e — ROUTED arm** (golden-v6h) | **136 steps, 0 failures** + routed GUI smoke **2 steps, 0 failures** (a real `todo add-repeating` through the deputy, 4 s, broker refused nothing) | GREEN | `things-run-e2e-routed-20261124-114530` |

Alert beeps: 0 on every leg. Both arms were re-run at the end with the final code of both PRs (§5.2): direct 133/0 (`things-run-e2e-direct-20261124-132943`), routed 136/0 + GUI smoke 2/0, 3 s (`things-run-e2e-routed-20261124-133101`).

**Private reorder on 3.25:** still accepted-and-inert. The o-suite canaries assert it, and `research-reord3242.sh` re-run on a golden-v6 clone with the 3.25 zip (`GOLDEN=things-lab-golden-v6 ZIP=…3.25… VM=reord325-lab`; the same-build re-swap is a no-op, then the cells) reads **INERT in all five scopes** (inbox, project id, area by name, area by id, today), positive control green. Artifacts: `lab/artifacts/reord325-lab/`. The driver's log line still says "golden-v5 as cloned": a hard-coded label, not the golden it ran on.

## 4. SIMFID under 3.25

| leg | result |
|---|---|
| `npm run lab:simfid -- --gate` (host) | exit 0 — 35 cases: **30 MATCH · 5 TOLERATED · 0 DIVERGENT** (`simfid-20261124-172253`) |
| `bash lab/scripts/simfid.sh -- --gate` (fresh golden-v6 clone) | exit 0 — **30 · 5 · 0**, all six ops `op exit=0`, 75 s (`simfid-clone-20261124-114849`, comparator `simfid-20261124-175003`) |

Same five tolerances, same rationale. [simfid-results.md](simfid-results.md) updated.

## 5. The GUI surface: what 3.25 changed, and what was already broken

### 5.1 AX census (GV6AX) — the rows were re-roled, the dialogs did not move

[`lab/scripts/research-gv6ax.sh`](../../lab/scripts/research-gv6ax.sh) takes the same census on any golden: every menu (with submenus) in three selection states, the main window at launch, the Repeat sheet, the detached Repeat window, the Reschedule… dialog and a project view with headings. It ran on golden-v4 (3.23), -v5 (3.24) and -v6 (3.25).

- **Repeat sheet, detached Repeat window, Reschedule dialog: identical across 3.23, 3.24 and 3.25 in every property a recipe reads** — roles, titles, values, child order and frames to the pixel. 3.24 → 3.25 is byte-identical including `_NS:` identifiers; 3.23 → 3.24 renumbered three `_NS:` ids (135→139, 129→132, 60→61), which no recipe uses (`ui-recipes.ts` says so). The touch release's "roomier dialogs when opened via touch" do not show when a dialog is opened by a menu click.
- **Menus: identical 3.24 → 3.25.** `Items ▸ Share…` is new since 3.23 (it appears on v5 and v6, not v4); no recipe addresses it.
- **Main window: the content and sidebar rows' LEAVES were re-roled** (3.24 → 3.25). The table, its 31 rows and 31 cells, the scroll areas, descriptions and frames are unchanged. Inside the cells, `AXUnknown` became `AXButton` (row checkbox, with the hint *"Double-tap to mark as completed."*; the heading's `More. <title>`; sidebar entries) or `AXStaticText` (titles, counts), so anonymous `AXUnknown` leaves fell from 133 to 7 at launch. The list header's editable `AXTextArea` title is gone. Recorded as craft ([things-app-craft.md](../things-app-craft.md) §14).
- **Driver exposure.** One role-sensitive check exists: the Move… picker filter at `src/write/vectors/ui.ts` (`(role of e) is "AXUnknown"`). It was not reached in this campaign (§5.3); whether the picker's rows were re-roled too is open.

### 5.2 The shape manifest had never covered 3.24 (fixed in a separate PR)

`REPEAT_SHAPE_VERSIONS` in `src/write/vectors/ui-shape.ts` was `["3.23"]`. On any other build the Repeat drive gets no dialog-default reliance and no shape fast path, so it runs the full per-step discrimination. GV5 never extended it, so **every 3.24.x host (the maintainer's included) has run that fallback since 2026-09-14**. The routed v0.20.12 cell batch ([`stage5-cells-0.20.12.sh`](../../lab/guest/stage5-cells-0.20.12.sh)) shows what that costs:

| run | build | manifest | result |
|---|---|---|---|
| `gv6-s5-02012` | 3.25 | `["3.23"]` | 150 cells, **8 failures**: the four prefill quadrants report `p=0`, hop count 2 not 3, the DEPOBS3 cadence record is missing, and `--ends-after` refuses on its FIRST promote ("0 fields on the Ends: row") |
| `gv6-s5-02012-v5h` | 3.24 | `["3.23"]` | 150 cells, **87 failures**: the AppleScript transport hit `Can't get item 2 of missing value` measuring the dialog, then a 96 s monthly drive stranded a dialog and every later drive was correctly blocked |
| `gv6-s5-02012-mf` | 3.25 | `["3.23","3.24","3.25"]` | **150 cells, 0 failures** — all eight quadrants attributed, 3 hops as modelled, the known-red `--ends-after` back to its recorded shape |

The discriminator cell B shows the same thing for an unscheduled Inbox seed: `make-repeating --interval 1` and `--interval 2` both refuse with "the field did not take keyboard focus" on 3.24 and 3.25, and both land on 3.23 and on 3.25 with the manifest extended. Given §5.1's census, adding 3.24 and 3.25 is the lab sitting the manifest's own comment calls for. Every dialog open is still checked by the runtime shell match. Shipped as its own PR so it can be reviewed apart from the certification.

### 5.3 Every ui-vector operation, end to end through the deputy — four refuse, on every version

[`lab/guest/gv6-ui-cells.sh`](../../lab/guest/gv6-ui-cells.sh) covers every `UI_DRIVE_OPS` entry the v0.20.12 batch does not. [`lab/guest/gv6-ui-cells-b.sh`](../../lab/guest/gv6-ui-cells-b.sh) is the discriminator, run with ONE build on golden-v6h, -v5h and **-v4h**. Both run through `stage5-rc-run.sh` (normal CLI syntax, routed, DB oracles); the runner's default golden is now v6h (it was still v4h).

| operation | 3.25 | 3.24 | 3.23 | notes |
|---|---|---|---|---|
| `todo make-repeating` / `pause-repeat` / `reschedule-repeat` (dated seed) | ✅ | ✅ | ✅ | + 150/150 v0.20.12 batch with the manifest |
| `todo make-repeating` (unscheduled Inbox seed) | ❌ → ✅ with §5.2 | ❌ | ✅ | the manifest gap |
| **`todo resume-repeat`** | ❌ | ❌ | ❌ | `Can't get menu item "Resume" of … "Repeat" of menu "Items"` — pre-existing, root cause not investigated |
| `todo convert-to-project` | ✅ | ✅ | — | notes kept |
| `project make-repeating` | ✅ | ✅ (flaky without the manifest) | ✅ | |
| **`project pause-repeat` / `reschedule-repeat`** | ❌ | ❌ | ❌ | preflight: `text area 2 of UI element 1 of row 1 …` does not resolve. The header row has no text area on 3.23 or 3.24 either (`AXUnknown` children) or on 3.25 (`AXButton`/`AXStaticText`); the repeat-bar handle predates 3.23. Fails closed, nothing pressed. `project resume-repeat` shares the handle (it exits 0 only on an already-running series) |
| `project move-heading` (chord) · `dissolve-heading` · `promote-heading` | ✅ | ✅ | — | dissolve re-homes children as direct project children, untrashed (DISS1 holds) |
| **`project move-heading-to-project`** | ❌ | ❌ | ❌ | the dialog-identity guard refuses at "narrow the Move… picker": *expected other, found move-picker*. An engine regression newer than HXPC1's 3.23 certification, not the app |
| `area reorder --first` | ✅ | ✅ | — | plus the v0.20.12 batch's sidebar cells |
| `rescue status` / `dismiss` / `relaunch` | ✅ | ✅ | — | relaunch needs `--dangerously-force-quit` on a workstation-profile guest (the first cell run omitted it) |
| heading reveal stays background (`stage5-cells-heading-reveal.sh`) | ✅ | — | — | 9/9 |

Each ❌ reproduces with the same build on all three versions, so **none is a 3.25 change** and none moves a register row. All four fail closed. They are flagged, not fixed.

Two first-run reds were my cell script, not the product: a failed Move… left its picker open and contaminated the next cell, and the dissolve oracle read before the child row settled. The script now gives each heading verb its own project, dismisses between cells and polls.

## 6. The one 3.25 app flip: the anytime json collapse

### 6.1 How it showed

The CHORD3/CHORD4 routed batch ([`stage5-cells-chord.sh`](../../lab/guest/stage5-cells-chord.sh)) is **green on golden-v5h (63 ok) and red on golden-v6h in 3 of 3 runs**, always the same three cells: 9 (the fallback bounce, GUI off: `reorder A3 --in anytime --start` exits 0 and A3 lands LAST), 11a (a one-slot chord whose full-column verify then disagrees on the last two members) and 18b (a Today undo whose verify disagrees although the order is restored). Cell 9 is isolated below; 11a and 18b are reproducible but **not isolated**. 11a runs on the column cell 9 left behind.

### 6.2 Isolation (GV6BNC, [`lab/guest/gv6-bounce-cells.sh`](../../lab/guest/gv6-bounce-cells.sh), golden-v6h vs golden-v5h)

Fresh five-member loose Anytime column each time, target = member 4:

| probe | 3.24 | 3.25 |
|---|---|---|
| P1 shipped `things reorder <x> --in anytime --start` (GUI off) | front, exit 0 | **LAST, exit 0** |
| P2 probe: URL `update when=someday`, then `when=anytime` | front | front |
| P3 probe: ONE json import `[someday, anytime]` | front (`index` -10994 < min -10483) | **LAST** (`index` -1000 > max -13871) |

The shipped anytime bounce compiles to the P3 shape (`BounceSpec.jsonCollapsible: true` for `anytime`, ORD-5), so P1 inherits P3's flip. The engine's verify did not catch the wrong order, which is a second defect. ORD-4 (the sequential legs) still holds, and so does O18's heading-bucket collapse, which is why `lab:regress` is green. Recorded in [things-app-oddities.md](../things-app-oddities.md) §36.

### 6.3 Not fixed here, and why

The obvious candidate is `jsonCollapsible: false` for `anytime` on ≥ 3.25 (P2 shows the sequential legs still front-insert). But it is unproven for multi-item reverse dispatch, it leaves the verifier that passed a wrong order unfixed, and 11a/18b are not yet explained. That is a redesign, not a small fix. ORD-5 stays un-stamped. With GUI driving enabled the chord route is primary for this scope, but 11a shows it is not clean on 3.25 either.

## 7. Register walk

Fourteen law rows take `3.25 (golden-v6)`. **ORD-5 does not** (§6). Suspensions stay suspended (§3), and the state-3 residue is unchanged. Details: [assumption-register.md](../reference/assumption-register.md) "Things 3.25 / golden-v6".

`things config set certified-app-version 3.25` was not run. It is the maintainer's, on both Macs, once the App Store build is there. The recommendation is to hold it until ORD-5 is fixed, because the stamp silences doctor's drift notice.

## 8. Operational notes

- **Disk:** 30 GiB free on `/Volumes/Workspace` at the start, **28 GiB at the end** (`df`). v6/v6h are COW descendants of v5/v5h.
- **Goldens:** v6/v6h ACTIVE. v5/v5h retired in place (and used as this campaign's controls), v4/v4h retained (deletion is still the maintainer's call). `tart list` at the end shows exactly those six, all stopped.
- **Evidence** (gitignored, primary checkout): `lab/artifacts/v6-build/`, `v6h-build/` (pre/post DBs, sdef, row and DDL diffs, positive-control logs), `gv6ax-v4|v5|v6/`, `gv6ax-diff/`, `gv6-s5-*`, `gv6-bnc-*`, `reord325-lab/`, and the suite, e2e and SIMFID run ids above.
- **Hook refusal:** one Bash command writing documentation that quoted a json-import URL literally was refused by `.claude/hooks/prod-things-guard.sh` (it pattern-matched the URL text; nothing was sent). The edit was made with the editor instead.
