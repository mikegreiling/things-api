# RESID1 — batched residual probes (json parity · swept-restage landings · Daily→Manually stamp · Settings-AX retry)

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05 12:00** (guest TZ **UTC**, so `unixepoch` == `localtime`; leg 2 advances it to 2026-07-09). Campaign **2026-08-06**, ONE disposable clone (`lab/artifacts/resid1-lab/`, gitignored — `report.txt` + `final.sqlite`), no crash (Things ALIVE throughout, no DiagnosticReports). Discovery — no assertions; **DB row deltas are ground truth**, cross-checked against the app's OWN list membership (AppleScript `to dos of list "…"`) and the shipped guest CLI (`today`/Logbook). Driver: [`lab/scripts/research-resid1.sh`](../../lab/scripts/research-resid1.sh) (subcommands `setup·axretry·axid·jsonpar·jsonpar2·jsonpar3·jsonpar4·dailyman·restage·dump·teardown`).

Four queued residuals, batched because they share the sweep/settings machinery. Execution order: **leg 4 (AX gate)** → **leg 1 (JSONPAR, run while settings pristine + clock unadvanced)** → **leg 3 (DAILYMAN, mutates settings)** → **leg 2 (RESTAGE, advances the clock LAST, one-way)**.

## Bottom line

- **R-AXRETRY (leg 4) — the golden-v2 Settings-AX flake was CLONE/STATE-LOCAL, not a golden residual.** The exact HEADSORT recipe (`keystroke "," using command down`) opens `window "General"` and enumerates the log-interval `AXPopUpButton` on THIS fresh clone. BACKDT's failure reproduced ONLY as a stale-window-state flake: a fresh **quit + relaunch** clears it and Cmd-, then opens the panel on attempt 1, every time. Recipe hardened + banked; leg 3 unblocked.
- **R-JSONPAR (leg 1) — timestamped-add attribute parity holds for EVERY attribute EXCEPT the checklist, which exposes a shipped-surface BUG.** Dates land byte-exact (`stopDate`/`creationDate` to the second; a bare date normalizes to local **noon**, TZ-proof), tags land, a **project OR area `list-id` lands**, and **heading placement lands** — all confirmed live. But `todo add`/`project add` with a resolution timestamp (`--created-at`/`--completed-at`) **AND** `--checklist-item` **silently no-ops the entire import**: the engine emits `checklist-items` as a bare STRING array, which `things:///json` rejects wholesale (no row, no error). The OBJECT-array shape (`[{"type":"checklist-item","attributes":{"title":…}}]`) — already used on the engine's checklist-UPDATE path — works perfectly for the full rich case. **Fix is one line** ([src/write/commands.ts](../../src/write/commands.ts):446); evidence-only here (flagged for a follow-up). The CLI verify layer catches the no-op LOUDLY (`verify-failed:silent-noop`) — no silent corruption.
- **R-DAILYMAN (leg 3) — the Daily→Manually flip does NOT forward-sweep; the TIMEZ [UNPROBED] prediction is FALSIFIED.** The Settings-flip `manualLogDate` stamp fires specifically on **leaving "Immediately"** (whose boundary is `now`, so the stamp freezes it). A **Daily→Manually** flip carries `manualLogDate` forward **byte-unchanged** (no re-stamp) — today's still-pending completion window stays UNSWEPT (preserved), the opposite of the predicted flip-time forward-sweep. `manualLogDate` behaves as a monotonic high-water mark advanced only to prevent a boundary rewind.
- **R-RESTAGE (leg 2) — a swept DATED item whose date passes while swept RE-DERIVES its `when` to the current clock on reactivation, and lands in TODAY.** (a) A future-scheduled to-do completed before arrival, swept, then reactivated after its date has passed re-enters **TODAY** (arrived-dated) at its **retained index + heading**, with `start` flipped **2→1** (anytime) and its now-past `startDate` **retained**. (b) A someday to-do with a deadline that went overdue while swept reactivates into **TODAY**, the app **stamping `startDate := the overdue deadline date`** and `start` **2→1**. (c) The certified **L-RESTORE** invariants (index-silent, heading-retained, when-retained) still hold under golden-v2 / 3.22.12 for the plain case.

---

## Leg 4 — R-AXRETRY: the golden-v2 Settings-window AX retry

**Question (BACKDT residual).** BACKDT's clone could not OPEN the Settings panel via System Events synthetic clicks (menu enumeration worked; neither `⌘,` nor a menu-item click surfaced the window within 8 s), while HEADSORT/LOGSORT's clones could. Was the flake clone-local, or a golden-v2 residual that would BLOCK leg 3?

**Method.** Retry the exact HEADSORT recipe (`keystroke "," using command down`) on this fresh clone (read-only — no `logInterval` flip), then characterize three open methods and the reliability of Cmd-,.

| method | result |
|---|---|
| **A** `keystroke "," using command down` (the HEADSORT recipe) | **OPENED** — `windows=[][General][Today]`, `sw=[General]`, four `AXPopUpButton`s enumerated: `[Today] [Automatic] [Immediately] [Daily]` |
| **B** `click menu item "Settings…" of menu 1 of menu bar item 2` (the BACKDT recipe) | ran without error; `window "General"` present |
| **C** `open "things:///preferences"` | did **NOT** surface a settings window (`windows=[][Today]`) — no preferences URL route |

**The flake, characterized.** Between methods (repeated open/close via `⌘W`) a subsequent Cmd-, intermittently returned `-1728 Can't get window "General"` — the same symptom BACKDT hit. A **quit + relaunch** of Things clears it: with a clean window state, Cmd-, opens `window "General"` on **attempt 1**, reproducibly (AXID diagnostic). So the failure is **stale-window state**, not a golden-v2 capability loss — the baked AXVM1 L3-accessibility grant drives synthetic clicks fine.

**Popup identity (load-bearing for leg 3).** The log-interval popup ("Move completed items to Logbook") is `AXPopUpButton` **#3** (enumeration order `Today · Automatic · Immediately · Daily`), value `"Immediately"` at the golden default. There is a **second, unrelated popup showing `"Daily"`** (#4), so once `logInterval` is flipped to Daily the popup is **not identifiable by value alone** — leg 3 targets it by **index #3**.

**Verdict (R-AXRETRY): the BACKDT Settings-AX failure was clone/state-local, NOT a golden-v2 residual.** The HEADSORT recipe works on golden-v2; the only robustness requirement is a fresh quit+relaunch for a clean window state before Cmd-,. Recorded in the harness troubleshooting note. Leg 3 proceeds.

---

## Leg 1 — R-JSONPAR: timestamped-add json attribute parity (live CLI)

**Question (probe-backlog §C).** The resolution-timestamp add path (`add --completed-at [--created-at]`, shipped 0.14.0) imports a born-resolved item through `things:///json`. The payload shapes are unit-locked but were never live-probed beyond title/notes/dates/children (P4d/B-PROJ-JSON). Drive the real CLI against the clone for a representative matrix; byte-verify every attribute lands (dates exact, tags, checklist, container FK, heading placement).

**Method.** Drive the shipped guest CLI (`~/things-lab/bin/node dist/cli/main.js`) under the pristine golden `logInterval=0` (boundary=`now`, so a born-completed item's Logbook landing is unambiguous). Read the raw DB back per case.

### Representative matrix (as-shipped CLI)

| case | CLI flags | result |
|---|---|---|
| **A** | `--completed-at 2025-01-15T09:00 --created-at 2024-06-01T08:00 --tags JP-T1,JP-T2 --create-tags --checklist-item ck1 --checklist-item ck2 --project JP-PROJ --heading JP-HEAD` | **`verify-failed:silent-noop`** — no row created |
| **B** | `--completed-at 2025-02-20T14:30 --area LAB-AREA-A --tags JP-T1 --create-tags` | **OK** — `status=3`, `stopDate`→**2025-02-20 14:30:00** exact, tag `JP-T1`, area FK; **Logbook** |
| **C** | `--created-at 2024-03-01T08:00 --when 2026-07-20 --deadline 2026-07-25 --tags JP-T2 --create-tags --checklist-item ckc --project JP-PROJ` | **`verify-failed:silent-noop`** — no row created |
| **D** | `project add --completed-at 2025-04-10T10:00 --created-at 2024-01-01T12:00 --area LAB-AREA-B` | **OK** — `type=1 status=3`, `stopDate`→**2025-04-10 10:00:00**, `creationDate`→**2024-01-01 12:00:00**, area FK; **Logbook** |
| **E** | `--completed-at 2025-05-05 --created-at 2024-05-05` (bare dates) | **OK** — `status=3`, `stopDate`→**2025-05-05 12:00:00** (NOON), `creationDate`→**2024-05-05 12:00:00** (NOON); **Logbook** |

Cases A and C — the only two carrying a **checklist** — no-op'd; B/D/E (no checklist) landed every attribute exactly. **E confirms the bare-date normalization end-to-end:** `things:///json` rejects a bare date (B-DATEONLY / oddity 2h), so the engine expands a date-only value to local **noon** before dispatch — observed `12:00:00` on both `stopDate` and `creationDate` (guest TZ=UTC), vindicating `asDateBlock`/`utcNoon`.

### Isolation — the culprit is the CHECKLIST SHAPE, not the container/when/tags

`jsonpar2`/`jsonpar3`/`jsonpar4` isolate each attribute (all others held out):

| probe | shape | result |
|---|---|---|
| F | `--completed-at T --project JP-PROJ` (completed, project `list-id`, no checklist) | **OK** — project FK lands |
| I | `--created-at T --project JP-PROJ` (open, project `list-id`, no checklist) | **OK** — project FK lands |
| G | `--created-at T --when 2026-07-20` (`when`, no container) | **OK** — `startDate` lands |
| K | `--created-at T --when 2026-07-20 --area LAB-AREA-A` | **OK** |
| PLAIN | plain add into JP-PROJ (no timestamp) | OK (baseline: project `list-id` is normally fine) |
| RAW (raw json) | `completed:true` + `completion-date` + `list-id`=project | OK |
| RAWNAME (raw json) | `completed:true` + `completion-date` + `list`=project NAME | OK |
| L / M (CLI) | `--completed-at`/`--created-at` + `--checklist-item` **only** | **no-op** — no row |
| RAW-a/b/c (raw json) | completed±date / created + `checklist-items:["x1","x2"]` (STRING array) | **no row** — whole import rejected |
| **RAW-d** (raw json) | plain open + `checklist-items:["x1","x2"]` (STRING array, NO timestamp) | **no row** — whole import rejected |
| **OBJ** (raw json) | completed + completion-date + `checklist-items:[{type,attributes:{title}}]` (OBJECT array) | **OK** — checklist `x1\|x2` |
| OBJ2 (raw json) | open + OBJECT-array checklist | OK — `y1` |
| **OBJ3** (raw json) | full Case-A analogue: completed + BOTH dates + `list-id`=project + `heading` + tags + **OBJECT** checklist | **OK — EVERY attribute exact**: `status=3`, `stopDate`→2025-01-15 09:00:00, `creationDate`→2024-06-01 08:00:00, tags `JP-T1,JP-T2`, checklist `ck1\|ck2`, `heading`=JP-HEAD |

Project-as-`list-id`, `when`, and tags all work with timestamps (F/I/G/K). **RAW-d proves `things:///json` rejects a bare STRING array of `checklist-items` outright — even on a plain open to-do, no timestamp involved** — and **OBJ/OBJ2/OBJ3 prove the OBJECT-array shape is the correct (and only working) one.** OBJ3 reconstructs the exact failing Case A with the object-array checklist and lands everything, so **no other attribute is at fault**.

### The shipped bug (evidence-only; flagged for a follow-up)

The engine's timestamped-add compile emits the checklist as a bare string array:

- [`src/write/commands.ts`](../../src/write/commands.ts):446 (timestamped `add` json path) — `attrs["checklist-items"] = params.checklistItems;` (array of STRINGS)
- [`src/write/commands.ts`](../../src/write/commands.ts):838 (the checklist-UPDATE json path) — `"checklist-items": specs.map((s) => ({ type: "checklist-item", attributes: { title: s.title } }))` (array of OBJECTS)

The two paths disagree on shape; the update path uses the form the app accepts. So **`todo add`/`project add` with a resolution timestamp AND `--checklist-item` silently produces nothing** — caught loudly by the CLI verify (`verify-failed:silent-noop`), so it fails safe (no partial/corrupt item), but the feature is non-functional for that combination. The fix is to have the add path emit the object-array shape (or reuse the update path's mapper). NOT changed here (evidence-only scope).

**CLI input-format note.** `--completed-at`/`--created-at` accept `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss]` and **reject a trailing `Z`** (`2025-01-15T09:00:00Z` → `invalid timestamp`); the value is wall-clock in the effective zone (the app-host zone for a local run). The engine then emits a second-precision UTC `…Thh:mm:ssZ` json stamp internally.

**Verdict (R-JSONPAR): full attribute parity EXCEPT checklist.** Dates (exact + noon-normalized bare), tags, project/area `list-id`, and heading placement all land byte-exact through the timestamped-add json path. The `checklist-items` string-array shape is a compile bug (the app silently rejects it; the object-array shape works). §C line closed; the checklist-shape fix is flagged for a follow-up.

---

## Leg 3 — R-DAILYMAN: the Daily→Manually `manualLogDate` stamp timing

**Question (timezones.md §1 [UNPROBED] corner).** With `logInterval=1` (Daily) and completions pending inside today's window, flipping Settings to Manually — does `manualLogDate` stamp at **flip time** (forward-sweeping the pending window, the TIMEZ-derived prediction) or at the **last daily edge** (preserving it)? Only Immediately→Manually flips had been directly observed.

**Method.** Via the leg-4 AX recipe (target popup #3), flip `logInterval` 0→1 (Daily), complete three to-dos after the flip (inside today's window), then flip 1→4 (Manually). Byte-read `TMSettings` + the sweep state of the pending completions at each step.

| step | `logInterval` | `manualLogDate` | pending window |
|---|---|---|---|
| S0 pristine | 0 | NULL (0) | — |
| **FLIP 1** 0→1 (Immediately→Daily) | **1** | **1783253517.04 = 2026-07-05 12:11:57** (STAMPED at flip time) | — |
| complete DMAN-1/2/3 | 1 | 1783253517.04 (unchanged) | stopDate 12:12:21/23/24 > mld → **UNSWEPT** (not in Logbook) |
| **FLIP 2** 1→4 (Daily→Manually) | **4** | **1783253517.04 = 2026-07-05 12:11:57 — UNCHANGED (byte-identical, no re-stamp)** | DMAN still stopDate > mld → **UNSWEPT** (not in Logbook) |

The FLIP-1 stamp (leaving Immediately, whose boundary is `now`) froze `manualLogDate` at flip time — as the guard predicts. The DMAN completions (12:12:2x, AFTER that stamp) were therefore pending. **FLIP 2 left `manualLogDate` byte-identical** — had it re-stamped at flip time (~12:12:47) it would have advanced past the DMAN window and swept it; it did not. The pending window is **preserved**.

**Verdict (R-DAILYMAN): the Daily→Manually flip does NOT re-stamp `manualLogDate` and does NOT forward-sweep the pending window — the TIMEZ [UNPROBED] prediction is FALSIFIED.** Refined law: **the Settings-flip `manualLogDate` stamp fires specifically when LEAVING "Immediately"** (freezing the `now`-boundary so already-swept items stay swept); a **Daily→Manually** flip carries `manualLogDate` forward unchanged (a monotonic high-water mark advanced only to prevent a boundary rewind), so a day's still-pending completion window survives the flip. Corner upgraded from [UNPROBED] to [CERTIFIED] in [docs/reference/timezones.md](../reference/timezones.md) §1.

---

## Leg 2 — R-RESTAGE: complete → sweep → reactivate for DATED items whose date passes while swept

**Question (maintainer curiosity, 2026-08-05).** For DATED items completed then swept, with the clock advanced past their date WHILE swept, where do they land on reactivation? (a) a future-scheduled to-do; (b) a someday to-do with a deadline that goes overdue; (c) do the certified L-RESTORE invariants still hold?

**Method.** Build all fixtures at the pinned clock (2026-07-05), complete them, sweep via AppleScript `log completed now` (advances `manualLogDate` past their `stopDate` — all three in the Logbook), THEN advance the guest clock **2026-07-05 → 2026-07-09** (past both dates), relaunch Things (recompute buckets), and reactivate each (`set status … to open`). Oracle: the app's OWN `to dos of list "Today"/"Anytime"/"Upcoming"` + the guest CLI `today`.

### (a) RS-A — future-scheduled to-do (when=2026-07-08), completed before arrival

| state | `status` | `start` | `startDate` | heading | `index` | app list |
|---|---|---|---|---|---|---|
| swept (07-05) | 3 | 2 (scheduled) | 132805632 = **2026-07-08** | JP-HEAD | 0 | Logbook |
| **reactivated (07-09)** | 0 | **1 (anytime)** | **132805632 = 2026-07-08 (RETAINED, now past)** | **JP-HEAD (retained)** | **0 (retained)** | **TODAY** (also Anytime; NOT Upcoming) |

**Verdict (a): RS-A reactivates into TODAY (arrived-dated behavior).** Its now-past `startDate` (2026-07-08) is retained, `start` flips 2→1, and the app files it in Today (an anytime row with a past `startDate` = "arrived"). Index and heading are retained.

### (b) RS-B — someday to-do with a deadline (2026-07-07) that goes overdue while swept

| state | `status` | `start` | `startDate` | `deadline` | `index` | app list |
|---|---|---|---|---|---|---|
| swept (07-05) | 3 | 2 (someday) | NULL | 132805504 = **2026-07-07** | −378 | Logbook |
| **reactivated (07-09)** | 0 | **1 (anytime)** | **132805504 = 2026-07-07 (NEWLY STAMPED = the overdue deadline)** | 132805504 | **−378 (retained)** | **TODAY** |

**Verdict (b): RS-B reactivates into TODAY as overdue.** The reactivation **STAMPS `startDate := the (overdue) deadline date** and flips `start` 2→1 — the someday item becomes an anytime row dated to its deadline, which (being past) surfaces in Today. `index` retained; `deadline` unchanged. The `startDate := deadline` stamp is a notable reactivation side effect (oddity §9z).

### (c) RS-C — L-RESTORE re-certification (plain anytime under a heading)

| state | `status` | `start` | `startDate` | heading | `index` |
|---|---|---|---|---|---|
| swept (07-05) | 3 | 1 | NULL | JP-HEAD | 0 |
| **reactivated (07-09)** | 0 | 1 (unchanged) | NULL (unchanged) | **JP-HEAD (retained)** | **0 (retained)** |

**Verdict (c): L-RESTORE HOLDS under golden-v2 / 3.22.12.** A plain swept to-do reactivates **index-silent**, heading-retained, when-unchanged (`status 3→0` + `stopDate→NULL` + `umd` bump only) — the certified LOGSORT L-RESTORE invariant, re-confirmed with the restage machinery.

**Cross-leg note.** For DATED items (a, b) reactivation re-derives `when` to the current clock (arrived → Today), so index/heading are retained but `when` is TRANSFORMED (scheduled→anytime-arrived; someday+overdue→dated-to-deadline); the pure L-RESTORE byte-retention applies to the plain case (c). New laws banked in the [assumption register](../reference/assumption-register.md) (RD-13).

---

## Environment / hygiene

Things **3.22.12** (build 32212016) / macOS 15.7.7; guest airgapped (default route deleted, ping fails); clock pinned 2026-07-05 12:00 UTC (advanced to 2026-07-09 in leg 2). No crash across all four legs (Things ALIVE, no DiagnosticReports). One clone `resid1-lab`, torn down after `dump`. Ran alongside the REMREV campaign (which held the other VM slot); the 2-VM ceiling was respected.
