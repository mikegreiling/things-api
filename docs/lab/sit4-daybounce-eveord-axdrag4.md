# SIT4 — the dated bounce, the project evening insertion law, the duplicate-title area drive (+ EVETZ)

Sitting 4 closes the LAST dead ordering cell and certifies the last cert-pending ui drive, across three arms plus a coordinator micro-arm, all in ONE disposable clone:

- **DAYBNC** — cross-date re-when × `todayIndex`: is a deterministic order protocol wireable for LOOSE scheduled to-dos **and area-less PROJECT rows** on an ARBITRARY future day (the last "app-default" ordering cell)?
- **EVEORD** — the project **evening** insertion law: does a project's `when=evening` re-entry FRONT-insert (like a to-do) or land mid-pack (like `when=today`, sit3 EVEPROJ)? I.e. is a reverse-order evening bounce with PROJECT movees wireable?
- **AXDRAG4** — certify PR #335's duplicate-title `area.reorder` GUI drive end-to-end through the production CLI (the AXDRAG3 `(index, uuid)` law, wired LAB-CERT PENDING).
- **EVETZ** (coordinator micro-arm) — can the `startDate = tomorrow + startBucket = 1` shape ("tomorrow evening") be written HEADLESSLY? Decides whether the shipped `blocked:clock` evening-pre-stage refusal can be lifted.

One offline Tart clone (`sit4-lab`, run 2026-07-31, Things **3.22.11**, macOS **15.7.7** Sequoia, DB schema **26**, pinned clock **2026-07-05 12:00**; ordering is local — no cloud account). Script: [`lab/scripts/research-sit4.sh`](../../lab/scripts/research-sit4.sh) (subcommands `setup` / `arm1` / `arm1c` / `arm2` / `arm2rem` / `arm3-grant` / `arm3` / `arm3-tie` / `arm3-multiview` / `arm3-neg` / `evetz` / `teardown`). Arms **1 / 2 / EVETZ are HEADLESS** (URL scheme + `things:///json` + AppleScript). **AXDRAG4 needs Accessibility** (granted per-clone via the AXVM1 rung-b VNC toggle) and drives the **production CLI** (`things area reorder … --dangerously-drive-gui`) through the guest e2e bundle. Test days: DAYBNC D = **2026-07-19** (+14d), D′ = **2026-07-20** (+15d, staging); evening = pinned today **2026-07-05**; EVETZ tomorrow = **2026-07-06**. Dates seeded via URL `when=<ISO>` (the app packs `startDate`); every value read back raw from SQLite — **no hand-packed date integers** (`encodePackedDate` discipline). All bounce/reorder targets are SCRAMBLED so a passing final order proves the sequence CONTROLS placement, not a no-op.

**Status: RAN + BANKED.** Headlines:

1. **DAYBNC = the DATED BOUNCE is the wireable protocol for an arbitrary future day, PROJECT rows included — and it PRESERVES reminders, deadlines, and heading FKs.** Cross-date re-when (`update?when=D′` then `when=D`) FRONT-inserts the row at the day-D GLOBAL `todayIndex` minimum (across containers) on re-entry — identically for loose to-dos, a headed project child, AND area-less scheduled project rows (`update-project?when=`). So a **reverse-target-order bounce** places the whole cross-container day group in exact requested order. A full 6-row scrambled bounce (4 to-dos incl. one reminder+deadline and one headed, + 2 project rows) landed the exact target order with EVERY collateral preserved: `startDate`, `start=2`, `reminderTime`, `deadline`, heading FK, project FK. **This closes the last "app-default" ordering cell** (loose scheduled + project rows on a future day). Contrast: bare `when=<date>` PRESERVES the reminder (confirming §2e/R21), whereas the evening bounce's `when=evening` STRIPS it (§9n).
2. **EVEORD = a project's `when=evening` re-entry FRONT-inserts at the evening-group `todayIndex` minimum (below to-dos AND projects) — NOT mid-pack.** The evening sub-bucket is ONE shared `todayIndex` axis across to-dos and projects; a project re-entering evening lands below the whole group's min, repeatably (×3). So a **reverse-order evening bounce with PROJECT movees is deterministically wireable** — the same law as the loose evening to-do bounce (the `when=today` mid-pack behavior of sit3 EVEPROJ does NOT govern the `when=evening` leg). Caveat: `when=evening` CLEARS `reminderTime` (§9n / R07), inherited by any evening bounce.
3. **AXDRAG4 = CERTIFIED.** PR #335's duplicate-title `area.reorder` drive works end-to-end through the production CLI on Things 3.22.11: distinct-index dupes (`--first`, `--after`), batch-TIED-index dupes (uuid-ASC tiebreak, `--first`), and the flagged-pending **multi-viewport** edge (31 areas, dupes at positions 2/6/30, `--last` via the rung-3 3-hop ladder) — the INTENDED uuid moved in every case (DB-asserted by `(index, uuid)` ordinal). Negatives hold: a duplicate-NAME ref refuses (`H-UNKNOWN-DESTINATION`), and the two-key gate blocks without `--dangerously-drive-gui` (`H-UI-DRIVE`). **The capability-matrix cell flips LAB-CERT PENDING → LAB-CERTIFIED.**
4. **EVETZ = the `sd=tomorrow + sb=1` shape is HEADLESSLY UNMANUFACTURABLE; `blocked:clock` stands.** `when=evening` ALWAYS forces `startDate=today` (it is a today-evening atom); any dated leg ALWAYS clears `startBucket=1` (→0); `things:///json` offers no independent `startBucket` control (`start-bucket` attribute silently ignored) and behaves identically to the URL scheme; AppleScript exposes no evening/bucket property. Rows are always EITHER (sd=tomorrow, sb=0) OR (sd=today, sb=1) — never both. Confirms §9n's note that `startBucket=1 + <future startDate>` is a **GUI/sync-origin-only** byte combination.

## Verdict table (observed)

| Arm | Question | Verdict |
|---|---|---|
| **DAYBNC** — cross-date re-when × `todayIndex` | is a deterministic day-order protocol wireable for loose scheduled to-dos AND project rows on an ARBITRARY future day? | **YES — the DATED BOUNCE, PROJECT rows included.** Re-entry (`when=D′`→`when=D`) FRONT-inserts at the day-D GLOBAL `todayIndex` min (across containers); a reverse-target bounce lands the exact cross-container order. A 6-row scramble (DP-2,DB-3,DP-1,DB-1,DB-4,DB-2) landed byte-exactly, `startDate`/`start=2`/`reminderTime`/`deadline`/heading FK/project FK all preserved. Closes the last app-default cell. Caveat list below. |
| **EVEORD** — project evening insertion | does `update-project?when=evening` re-entry FRONT-insert or land mid-pack? | **FRONT-insert at the evening-group global min (below to-dos AND projects), ×3 repeatable.** One shared evening `todayIndex` axis. Reverse-order evening bounce with PROJECT movees is WIREABLE — same law as the to-do evening bounce; the sit3 `when=today` mid-pack finding does NOT govern the `when=evening` leg. Caveat: `when=evening` strips `reminderTime` (§9n). |
| **AXDRAG4** — duplicate-title `area.reorder` drive | does PR #335's positional disambiguation certify end-to-end through the production CLI? | **CERTIFIED.** `--first`/`--after` on distinct-index dupes, `--first` on batch-tied (uuid-ASC) dupes, and `--last` across a 31-area multi-viewport sidebar (rung-3 3-hop) all moved the INTENDED uuid (DB-asserted). Duplicate-NAME ref refuses; two-key gate holds. Matrix cell → LAB-CERTIFIED. |
| **EVETZ** — headless "tomorrow evening" | can `startDate=tomorrow + startBucket=1` be written headlessly? | **NO — unmanufacturable on every surface.** `when=evening` clobbers date→today; any dated leg clears sb=1; json has no `startBucket` control; AppleScript has no bucket property. `blocked:clock` stands. |

## Per-arm detail

### DAYBNC — the dated bounce (D = 2026-07-19, D′ = 2026-07-20)

**Seed (day D, `startDate`=132807040).** 4 to-dos + 2 area-less scheduled PROJECT rows, all on D, all `start=2`/`startBucket=0` with a `todayIndex` on the shared day axis. Each new same-day add front-inserts below the current group min, so the seed `todayIndex` (most-negative = top):

| row | type | seed todayIndex | notes |
|---|---|---|---|
| DP-2 | 1 (project) | −2806 | area-less project row |
| DP-1 | 1 (project) | −2385 | area-less project row |
| DB-4 | 0 (to-do) | −1748 | HEADED under project DHP ▸ heading DH (heading FK `TrtZ6RBw`, `project` NULL — the child resolves its project via the heading) |
| DB-3 | 0 (to-do) | −1195 | loose |
| DB-2 | 0 (to-do) | −548 | loose + `reminderTime`=603979776 (09:00) + `deadline`=132807040 |
| DB-1 | 0 (to-do) | 0 | loose |

**(b) The re-entry law — round-trip D→D′→D.** A single row re-whened out to D′ and back:

- **Loose to-do DB-1** (seed tIdx 0, the bottom): on D′ (empty day) kept tIdx 0; back on D → **−3397** (below the global min DP-2 −2806) = the new day-D front. FRONT-INSERT.
- **Project row DP-1** (seed −2385): on D′ kept −2385; back on D → **−4060** (below the loose min DB-1 −3397). A PROJECT row front-inserts at the GLOBAL day min too — the `todayIndex` axis is genuinely shared across to-dos and area-less project rows.
- **Repeatability (DB-3 ×2):** first round → −4496 (below DP-1 −4060, the new front); second round → −4496 again (idempotent: re-whening a row already AT the global front returns the same value — `userModificationDate` advances but `todayIndex` does not move off the front). The front-insert placement is stable.

**(d) Collateral through the round-trip (the wireability decider).**

- **DB-2 (reminder + deadline), bare `when=` (no `@time`):** on D′ `reminderTime`=603979776 and `deadline`=132807040 both PRESERVED; back on D both still present, tIdx −5098 (front). **The dated bounce does NOT strip reminders or deadlines** — bare `when=<date>` carries them across the re-date (confirms §2e / R21). This is the decisive contrast with the evening bounce.
- **DB-4 (headed), round-trip:** heading FK `TrtZ6RBw` PRESERVED on D′ and back on D (tIdx −5444, front). **Re-when preserves the heading FK** — unlike the private container-day reorder, which RIPS a headed child's heading on the `todayIndex` axis (§9k). A headed same-day child participates in the global day axis AND survives re-when with its heading intact.

**(c) The full DATED BOUNCE — scrambled 6-row target.** Target cross-container order **DP-2, DB-3, DP-1, DB-1, DB-4, DB-2**; processed in REVERSE (each: `when=D′` then `when=D`; to-dos via `update`, projects via `update-project`). Final raw `todayIndex` (merged, ascending):

| position | row | todayIndex | preserved collateral |
|---|---|---|---|
| 1 | DP-2 (project) | −8191 | sd=132807040, start=2 |
| 2 | DB-3 (to-do) | −7839 | sd, start=2 |
| 3 | DP-1 (project) | −7378 | sd, start=2 |
| 4 | DB-1 (to-do) | −6924 | sd, start=2 |
| 5 | DB-4 (headed) | −6578 | sd, start=2, heading `TrtZ6RBw` |
| 6 | DB-2 (to-do) | −5982 | sd, start=2, rem=603979776, dl=132807040 |

**EXACT match to the target** — the scramble proves sequence controls placement. Every collateral byte preserved.

**Verdict + caveat list (the wireable protocol).** To order N same-future-day items (loose to-dos and/or area-less project rows and/or headed same-day children) into target `T1..Tn` (T1 = top): bounce them in REVERSE target order `Tn..T1`, each item `when=D′` then `when=D` (`update` for to-dos, `update-project` for projects). Caveats:

- **Non-destructive to reminders/deadlines/headings** (unlike the evening bounce, and unlike container-day reorder which rips headings).
- **Staging day D′** must tolerate a transient visit (the item briefly appears on D′ then leaves; D′'s own rows are undisturbed — front-insert renumbers nobody, PRJMIX). D′ = D+1 keeps the transient out of Today. **NEVER** stage through `when=today` (pollutes Today) or a schedule-class leg on a repeating **template** (§1 CRASH — templates must be refused/skipped, as the existing day protocols already do, §9e).
- **Cost** = 2 verified URL dispatches per item (away + back) = 2N dispatches, ≈ the BOUNCE2-t ~110 ms/item; 2N cloud change records online (SYNC2). Caps under the existing `bounce-max-items` (30).
- Both **to-do and project rows front-insert on ONE shared global day axis**, so a mixed cross-container day group sorts in a single reverse pass.
- Evidence only — **NOT wired.** This is the loose-scheduled-day (+ project row) counterpart to the shipped `tomorrow` one-call surface (ORDFIN2 TOMORROWLIST) for days beyond tomorrow.

### EVEORD — the project evening insertion law (evening = today 2026-07-05)

**Seed.** 2 evening to-dos (`add?when=evening`) + 2 area-less projects flagged This-Evening (`add-project` then `update-project?when=evening`). All `start=1`, `startBucket=1`, `startDate`=132805248 (today), on the evening `todayIndex` axis:

| row | type | seed todayIndex |
|---|---|---|
| EP-2 | 1 | −111 |
| EP-1 | 1 | −98 |
| EV-2 | 0 | −63 |
| EV-1 | 0 | 0 |

The four interleave on ONE axis (a project sits between/below to-dos), confirming a single shared evening `todayIndex` group.

**(control) To-do evening bounce (EV-1: `when=today`→`when=evening`).** `when=today` left evening (sb 0, tIdx −455); `when=evening` re-entered at **−120**, below the group min → front. The known to-do law holds.

**PROJECT evening bounce (EP-1: `update-project when=today`→`when=evening`), ×3.** Each rep: `when=today` moved EP-1 out of evening (sb 0, tIdx −558/−660/−627); `when=evening` re-entered at **−126 / −125 / −126**, each strictly below the evening-group min (EV-1 −120) → EP-1 became the FRONT of the whole evening group (below to-dos AND projects) every time. Not mid-pack.

**Verdict.** A project's `when=evening` re-entry FRONT-inserts at the evening-group global `todayIndex` min — the same law as the loose evening to-do bounce. So a **reverse-order evening bounce accepting PROJECT movees is deterministically wireable** (interleave to-do `update?when=today→evening` and project `update-project?when=today→evening` in reverse target order). The sit3 EVEPROJ `when=today` mid-pack finding governs only the daytime leg, not the `when=evening` re-entry. **Caveat:** `when=evening` CLEARS `reminderTime` — re-confirmed here (a `today@09:00` reminder, `reminderTime`=603979776, → NULL after `update?when=evening`, sb 0→1). Any evening bounce inherits the §9n/R07 reminder loss (the R07 caveat the shipped `evening` reorder scope already carries). Evidence only — NOT wired.

### AXDRAG4 — duplicate-title `area.reorder` certification (production CLI, VM GUI)

Accessibility granted per the AXVM1 rung-b VNC toggle (`auth_value` 0→2; the AX menu-bar read then returns `Apple, Things, File, …` exit 0). The guest e2e bundle (node + `dist` + commander) drives the **shipped** `things area reorder <ref> --first|--last|--before|--after <area> --dangerously-drive-gui`; every assert reads `TMArea ORDER BY "index", uuid` (the AXDRAG3 canonical sort) from read-only SQLite. The driver disambiguates a duplicate-titled uuid by computing its `(index, uuid)`-ASC rank among same-titled areas (recomputed each hop) and grabbing the Nth same-title AX row (`findAreaRowNth`/`areaTitleRank`), then DB-asserts the INTENDED uuid moved.

| Case | Command (target = the MIDDLE duplicate by `(index,uuid)`) | Drive | DB assert |
|---|---|---|---|
| **b1** distinct-index, `--first` | `area reorder <mid DUPE> --first` (3 DUPE-AREA via separate `make new area` = distinct sparse indexes) | ok — one drag (rung 1) | intended uuid `PxFxNr…` now index-min (top) ✓ |
| **b2** distinct-index, `--after` (no-op detect) | `area reorder <mid DUPE=EVmupS…> --after NB-2` | ok — "already in the requested position — nothing to move" | intended uuid identified correctly as already-after-NB-2 ✓ |
| **c (tie)** batch-TIED index, `--first` | `area reorder <mid TIE=668hd…> --first` (3 TIE-AREA via ONE AppleScript `repeat` = tied `index=0`, display uuid-ASC) | ok — one drag | middle tied uuid (uuid-ASC rank 1) now top ✓ |
| **d (multi-viewport)** distinct, `--last`, 31 areas | `area reorder <mid DUPE=EVmupS…> --last` (padded to 31 areas; DUPE-AREA at positions 2/6/30 — not sharing a viewport; window shrunk to 935×420) | ok — **"moved with 3 intermediate hop(s) + the final drag (multi-hop fallback)"** (rung 3) | intended uuid at index-max (bottom), `10300` ✓ |
| **N3** distinct, genuine `--after` | `area reorder <mid DUPE=WjVpru…> --after LAB-AREA-A` | ok — 3-hop + final drag | intended uuid immediately after LAB-AREA-A ✓ |
| **N1** duplicate-NAME ref | `area reorder DUPE-AREA --first` (title, not uuid) | **refused — `blocked:H-UNKNOWN-DESTINATION` "target reference is ambiguous"** before any gesture | order unchanged ✓ |
| **N2** two-key gate | `area reorder <uuid> --first` (no `--dangerously-drive-gui`) | **blocked — `blocked:H-UI-DRIVE`** | order unchanged ✓ |

**Self-invert (mismatch recovery).** The driver's per-hop DB assert + `(index,uuid)`-rank recomputation from LIVE state each hop is designed to keep the target's ordinal correct as the dragged area crosses a same-titled sibling — so a stale-ordinal mismatch does not arise through the shipped path, and a genuine self-invert was **not inducible** in these runs without artificially corrupting mid-gesture state. The self-invert guard exists and is unit-tested (PR #335 `test/unit/ui-drag.test.ts` / `test/unit/area-reorder-guards.test.ts`); the certification exercised the correct-targeting closed loop it protects. Recorded honestly: not triggered because the live re-read prevents the condition.

**Verdict: CERTIFIED (LAB-CERTIFIED, Things 3.22.11).** The duplicate-title drive moves the intended uuid across every addressing mode (distinct index, tied index/uuid-ASC, multi-viewport rung-3), the up-front duplicate-NAME refusal and two-key gate hold, and the multi-viewport edge that #335 flagged cert-pending is a correct-ladder pass (not a refusal). The capability-matrix "Sidebar: areas" cell flips **LAB-CERT PENDING → LAB-CERTIFIED**. On-device `certified` confirmation (real hardware) remains, per the ui-certification runbook.

### EVETZ — headless "tomorrow evening" (tomorrow = 2026-07-06)

Goal shape: `startDate = 132805376` (tomorrow) **AND** `startBucket = 1` (evening). Attempts (each read raw after every leg):

| # | recipe | result | what killed the shape |
|---|---|---|---|
| i | `when=evening` → `when=2026-07-06` | sd=132805376, **sb=0**, start=2 | the dated leg CLEARS `startBucket=1` (→0) |
| ii | `when=2026-07-06` → `when=evening` | **sd=132805248 (today)**, sb=1, start=1 | `when=evening` CLOBBERS `startDate` to today |
| iii-a | json update `when=2026-07-06` on an evening row | sd=132805376, **sb=0** | identical to URL — dated leg clears sb |
| iii-b | json update `when=evening` on a tomorrow row | **sd=132805248**, sb=1 | identical to URL — evening clobbers date to today |
| iv | AppleScript `schedule … for tomorrow`; `properties` grep for evening/bucket | sd=132805376, **sb=0**; no evening/bucket property exists | AppleScript has no `startBucket`/evening property; `schedule` sets date only |
| v | json ADD `when=2026-07-06` + `start-bucket:"evening"` | sd=132805376, **sb=0** | the `start-bucket` json attribute is silently ignored |

Final: no TZ-* row ever carried `sd=tomorrow + sb=1`. Every row is EITHER (sd=tomorrow, sb=0) OR (sd=today, sb=1) — the two states are mutually exclusive headlessly.

**Verdict.** The "tomorrow evening" shape is **headlessly UNMANUFACTURABLE**: `when=evening` is a *today-evening atom* (it forces `startDate=today`), and any dated leg drops the evening flag; `things:///json` gives no independent `startBucket` write (behaves exactly like the URL scheme, `start-bucket` ignored) and AppleScript exposes no bucket property. So the shipped `blocked:clock` evening-pre-stage refusal **STANDS** — evening placement cannot be staged for a future day from any headless surface. This confirms §9n's note that `startBucket=1` co-existing with a non-today `startDate` is a **GUI/sync-origin-only** byte combination. The roll-clock observation step (b) is moot (no future-evening row was produced). Evidence only.

## App oddities filed

**None new.** DAYBNC's reminder/deadline/heading preservation through cross-date re-when CONFIRMS existing §2e / R21 (dated bare `when=` carries the reminder to the new date) and contrasts §9n (`when=evening` clears it); EVEORD's `when=evening` reminder-clear re-confirms §9n / R07; EVETZ confirms §9n's GUI/sync-origin-only note for `startBucket=1` + future `startDate`. AXDRAG4 certifies existing behavior. The re-when idempotence-at-front (DAYBNC b3: re-whening a row already at the global `todayIndex` front returns the same value) is a benign stability property of the front-insert law, not a bug.

## Novel paths added

- **The DATED BOUNCE** (reverse-target `when=D′`→`when=D`) — a deterministic cross-container day-order protocol for loose scheduled to-dos AND area-less project rows AND headed same-day children on an ARBITRARY future day, reminder/deadline/heading-preserving. Filed in [reference/novel-paths.md](../reference/novel-paths.md).
- **The PROJECT evening bounce** (`update-project?when=today`→`when=evening` front-inserts at the evening-group min) — deterministic evening order with project movees. Filed in [reference/novel-paths.md](../reference/novel-paths.md).

## Reproduce

```sh
TART_HOME=/Volumes/Workspace/tart VNCDO=<path-to-vncdo> \
  bash lab/scripts/research-sit4.sh setup        # clone+boot(+vnc)+airgap+clock-pin+warm-up+token
  bash lab/scripts/research-sit4.sh arm1          # DAYBNC seed + re-when law + collateral
  bash lab/scripts/research-sit4.sh arm1c         # DAYBNC full dated bounce (scrambled 6-row)
  bash lab/scripts/research-sit4.sh arm2          # EVEORD project evening insertion ×3
  bash lab/scripts/research-sit4.sh arm2rem       # EVEORD §9n reminder-clear contrast
  bash lab/scripts/research-sit4.sh arm3-grant    # AXVM1 rung-b Accessibility toggle + e2e bundle (needs $VNCDO)
  bash lab/scripts/research-sit4.sh arm3          # AXDRAG4 distinct-index --first / --after
  bash lab/scripts/research-sit4.sh arm3-tie      # AXDRAG4 batch-tied uuid-ASC tiebreak
  bash lab/scripts/research-sit4.sh arm3-multiview# AXDRAG4 31-area multi-viewport rung-3
  bash lab/scripts/research-sit4.sh arm3-neg      # AXDRAG4 name-ref refusal + gate + genuine --after
  bash lab/scripts/research-sit4.sh evetz         # EVETZ headless tomorrow-evening attempts
  bash lab/scripts/research-sit4.sh teardown
```

Arms 1/2/EVETZ are headless (no Accessibility, no VNC); AXDRAG4 needs the `arm3-grant` step (`$VNCDO` = a `vncdotool` CLI). Evidence (gitignored, synthetic): `lab/artifacts/sit4-lab/report.txt`, `*.json`, `screens/`.
