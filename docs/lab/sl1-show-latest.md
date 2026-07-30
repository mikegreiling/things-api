# SL1 — the Things GUI "Show Latest" criterion

**Verdict (2026-07-29): "Show Latest" selects the instance with the MAXIMUM `creationDate` among the template's instances — i.e. the most recently *spawned* occurrence — and NOTHING else.** It is independent of `startDate`, `userModificationDate`, `stopDate`, and completion `status` (open vs completed). Stated as the DB-derivable rule the planned `latestInstance` read-layer derivation must implement:

```sql
SELECT uuid FROM TMTask
WHERE rt1_repeatingTemplate = :templateUuid
ORDER BY creationDate DESC
LIMIT 1;
```

For a repeating series, `creationDate` on each instance is **backdated to that occurrence's midnight** (RSIM), so `max(creationDate)` = "the instance generated for the latest occurrence date" = "the most recently spawned instance." This holds identically for a repeating **to-do** template (Items ▸ Repeat ▸ Show Latest on the selected template) and a repeating **PROJECT** template (repeat-bar popover ▸ Show Latest, UIC3 recipe) — it is not to-do-specific.

Confound that CANNOT be broken via official surfaces (recorded, not resolved): physical row-insertion order (sqlite `rowid`) is perfectly **collinear** with `creationDate` for every app-spawned instance (rowids 41 < 44 < 46 < 48 tracked `creationDate` 1783209600 < 1783296000 < 1783382400 < 1783468800), and there is no write surface to set `creationDate` independently. Both order identically and both point to the same pick; `creationDate` is the real, queryable column, so the read layer uses it. `TMTask."index"` was **uniform (−1171)** across all instances of a series, so it is NOT the ordering key.

ONE disposable clone `sl1-lab` of `things-lab-golden-v1` (golden UNTOUCHED; airgapped; clock pinned **2026-07-05 12:00** then advanced +1-day/step to accumulate occurrences; Things **3.22.11 / macOS 15.7.7 / DB v26**; Accessibility via the AXVM1 rung-b VNC grant; ui-vector conversions driven through the **production CLI** e2e bundle). Branch `mg/sl1-show-latest`. Scripts: [`lab/scripts/research-sl1.sh`](../../lab/scripts/research-sl1.sh) (setup + oracle verification + seed), [`lab/scripts/sl1-clock.sh`](../../lab/scripts/sl1-clock.sh) (+1-day advance), [`lab/scripts/sl1-round.sh`](../../lab/scripts/sl1-round.sh) (to-do Show Latest round), [`lab/scripts/sl1-proj.sh`](../../lab/scripts/sl1-proj.sh) (project repeat-bar popover Show Latest; embeds the AX driver inline). Fixtures fully synthetic. Artifacts (gitignored): `lab/artifacts/sl1-lab/`.

## The oracle — `id of selected to dos` (verified), NOT the clipboard

Show Latest navigates to and *selects* the chosen instance; list rows are not AX-readable by title (and all instances share one title), so the pick is read from **Things' own selection model**:

```applescript
tell application "Things3" to get id of selected to dos    -- returns the selected instance's uuid
```

**Verified before trusting it (research-sl1.sh):** selecting a KNOWN synthetic seed item via `things:///show?id=95tovetAyq9R58hp5714D6` and reading `id of selected to dos` returned **exactly** `95tovetAyq9R58hp5714D6` (name `LAB-P-1`, count 1). It also resolves a **shown PROJECT** to its uuid (Things treats a shown project as the selection — count 1), which is what made the project replication readable.

**The clipboard "Copy Link" oracle was UNREACHABLE from the menu bar and was NOT used.** `Items ▸ Share…` has **no submenu** (`menu 1 of menu item "Share…"` → `-1719 Invalid index`) on either a to-do or a project — the app's Copy Link lives only on the row right-click context menu (Share ▸ Copy Link, oddities intro), an NSMenu that AX drives awkwardly. Since `id of selected to dos` is a direct read of Things' selection model (stronger than AX-reading a focused element, the brief's stated fallback) and was verified against a known selection, it is the sole oracle here. This is the brief's sanctioned path when Copy Link proves unreachable.

## The to-do matrix — disambiguating the four candidate keys

A plain to-do `SL Daily` was converted to a **daily fixed** repeater (source deleted, RSIM identity replacement); template = `2FfW9TVtWj5PKpPCRNGHAb`. Three +1-day clock advances (07-06/07/08) accumulated four OPEN instances (occurrences do NOT auto-complete; they persist — RSIM-S). All `creationDate` values are unix-epoch seconds here (the golden differ's "2057" is the known double-epoch artifact); `userModificationDate` starts **NULL** on an unedited instance and is set to the edit wall-clock on first mutation; `stopDate` NULL until completion.

Instances (template `2FfW9TVtWj5PKpPCRNGHAb`):

| tag | uuid | creationDate (occ. midnight) |
|---|---|---|
| I05 | `QkCf2WHRihBfZqsh6LAF9W` | 1783209600 (2026-07-05) |
| I06 | `5U6h95mDXXVv7S4qpxb3DV` | 1783296000 (2026-07-06) |
| I07 | `7p1bCiupLCE8DxKyyruSW4` | 1783382400 (2026-07-07) |
| I08 | `9HgDnw12T4U4WWSrodJoWJ` | 1783468800 (2026-07-08) |

Mutations were applied through the **official URL scheme** (`things:///update?id=…&when=…` / `&completed=true`, tier-0). Each round: read the matrix, re-select the template (`things:///show?id=<template>`), click `Items ▸ Repeat ▸ Show Latest` (AX by name, AXVM1 recipe), read `id of selected to dos`.

| Round | State change (which key is max, per instance) | Predicted-by criterion | **PICK** | Rules out |
|---|---|---|---|---|
| **A** baseline | all 4 open; `startDate`=`creationDate` order (07-05<06<07<08); `userMod` all NULL; `stop` all NULL | creation=start=I08 | **I08** | (establishes the top; all keys agree) |
| **B** reschedule I05→07-20 | max `startDate`=**I05** (07-20); max `creationDate`=**I08**; max `userMod`=**I05** (just edited); all open | creation=I08 | **I08** | **`startDate`** (I05 not picked); **`userModificationDate`** (I05 not picked) |
| **C3** reschedule I08→07-15 (winner off "today"; NO instance at today=07-08) | occurrences 07-06/07-07/07-15/07-20; max `creationDate`=**I08**(@07-15); "current/most-recent-≤-today"=**I07**(07-07); max `startDate`=**I05**(07-20) | creation=I08 | **I08** | **"current/today occurrence"** (I07 not picked); re-confirms not `startDate` |
| **D1** complete I08 | I08 now `status=3` (+`stopDate`), still max `creationDate`; I06/I07 open | creation=I08 | **I08** | **completion status** (a completed instance is still chosen) |
| **D2** complete I05 (min creation) → newest `stopDate` | max `stopDate`=**I05** (1783512385); max `creationDate`=**I08** (`stopDate` 1783512348) | creation=I08 | **I08** | **`stopDate`** (I05 not picked) |

Every pick is `max(creationDate)`. Only `creationDate` survives all five rounds. (An earlier attempt to move the winner to a *past/today* date via the URL scheme was a silent no-op — see method caveats — so it was redone with future dates; C3 is the valid separation of `creationDate` from the "current occurrence" reading.)

## Open-vs-completed / most-recently-completed — ANSWERED

The brief's specific sub-question: does "Latest" prefer the open pre-spawned future instance, or the most-recently-completed past one? **Neither preference exists.** D1 shows a *completed* instance is chosen when it is the max-`creationDate` one (no bias toward open); D2 shows the most-recently-*stopped* instance is NOT chosen when its `creationDate` is not the max (no bias toward recent completion). "Latest" is purely `max(creationDate)`, blind to status and to `stopDate`.

## Project-template replication (repeat-bar popover, UIC3) — CONFIRMS

A plain project `SLProbeProj` → **daily fixed** repeater (template `BfvxS3gADibRxSvz6RXiXi`); +1-day advances (07-09/07-10) accumulated three OPEN project instances; the earliest (`Wyqy5kzf…`, min `creationDate`) was rescheduled to a future `startDate` 07-25 via `things:///update-project`:

| tag | uuid | creationDate | startDate |
|---|---|---|---|
| PJ08 | `Wyqy5kzf8LnLq3Prt8Gqt3` | 1783468800 (07-08) | **2026-07-25** (max startDate) |
| PJ09 | `FE9paASJuGqHhrYWyKPXAh` | 1783555200 (07-09) | 2026-07-09 |
| PJ10 | `EqGgLBmp7EQGe9hZTMyN2q` | 1783641600 (07-10) | 2026-07-10 (**max creationDate**) |

Revealing the template project, HID-clicking the repeat bar (opened the expected ≈215×220 `AXUnknown` popover — UIC3), then HID-clicking `Show Latest`, then `id of selected to dos`: **PICK = `EqGgLBmp7EQGe9hZTMyN2q` (PJ10, max creationDate)** — NOT PJ08 (max startDate). The criterion replicates on the project surface exactly.

## Read-layer derivation input

- `latestInstance(templateUuid)` = `SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate = :t ORDER BY creationDate DESC LIMIT 1` — over BOTH to-do (`type=0`) and project (`type=1`) instances; do NOT filter by `status` (a completed instance is a valid "latest") and do NOT order by `startDate`/`userModificationDate`/`stopDate`.
- **Tie-break (untested; not expected):** `creationDate` is the occurrence midnight and is unique per occurrence for a normal series, so ties should not arise. If a defensive secondary is wanted, `rowid DESC` (equivalently uuid/insertion order) matches the app's collinear order.
- Paused/after-completion series behave no differently for THIS action — Show Latest reads whatever instances exist by `creationDate`; it does not consult the template's `rt1_nextInstanceStartDate`.

## Anything odd

- **URL-scheme `update`/`update-project` `when=` is a silent no-op for a PAST or TODAY date on an already-scheduled repeating instance** (no error, no coercion, `startDate` unchanged); only strictly-FUTURE `when` values applied (verified repeatedly: 07-20/07-15/07-25 landed; 07-03 and 07-08(=today) did not). Tangential to SL1 (a URL-scheme write-path quirk on repeating instances) and not chased further; flagged here so the round design's reliance on future-only reschedules is on record. Not filed to oddities (URL-scheme-write behavior, unconfirmed as a general bug vs. a repeating-instance guard).
- **Menu-bar `Items ▸ Share…` has no Copy Link submenu** (`-1719` on `menu 1`) — consistent with Copy Link being row-context-menu-only. Noted for any future clipboard-oracle attempt.
- **`id of selected to dos` resolves a shown PROJECT to its uuid** (Things' selection model treats a shown project as a selected "to do" for this accessor, count 1) — a convenient uuid oracle for project navigation, used here for the project replication. Added to novel-paths.

## Environment

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (clock pinned 2026-07-05, advanced +1-day/step through 07-10). One clone, torn down on completion.
