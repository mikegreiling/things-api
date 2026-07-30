# SL2 — trash / empty-trash / restore dynamics of repeating-template instances

**Extends [SL1](sl1-show-latest.md)** (Show Latest = `max(creationDate)`, no status filter — but SL1 NEVER tested a *trashed* instance). SL2 answers what trashing, emptying, restoring, and hard-deleting do to a repeating template's instances, and how Show Latest reads that. The headline result: **Show Latest's candidate set EXCLUDES trashed instances**, which CONTRADICTS the shipped `latestInstanceUuid` derivation (SL1 shipped with no `trashed` filter) — fixed in this PR.

## Verdicts as read-layer laws

| # | Question | Law our read layer / model implements |
|---|---|---|
| **L1** | Show Latest vs a TRASHED latest instance | **Show Latest candidate set = instances WHERE `rt1_repeatingTemplate=:t` AND `trashed=0`, then `ORDER BY creationDate DESC LIMIT 1`.** A trashed max-`creationDate` instance is SKIPPED; the pick is the newest UNTRASHED instance. (Trashed instances are NOT candidates.) |
| **L1b** | After empty-trash | The association is **computed live**, not stored: emptying the Trash re-resolves Show Latest to the next surviving instance — no dangling reference, no error. |
| **L1c** | Template with ZERO instances | The **"Show Latest" menu item is ABSENT** (removed from the Items ▸ Repeat submenu, which then holds only `Reschedule…`, `Pause`) — not disabled, not a no-op-on-click. There is nothing to derive; a `latestInstance` read returns `null` (omit-empty). |
| **L2** | FIXED repeater, live instance trashed | A fixed repeater is **date-driven off the template**: the next occurrence spawns on schedule regardless of any trashed instance. **Trashing an instance mutates NO template `rt1_*` column.** The trashed occurrence's date is NOT re-materialized (the occurrence is already counted). |
| **L3** | AFTER-COMPLETION repeater, live instance trashed | **NOT dormant.** Trashing the live open after-completion instance is treated by the scheduler exactly like **completing** it: the template stamps `rt1_afterCompletionReferenceDate` = the trashed instance's `startDate` and `rt1_nextInstanceStartDate` = that + interval, and the replacement spawns on schedule (one interval later). `rt1_instanceCreationPaused` stays `0` — the series does NOT pause itself; it self-*advances*. |
| **L4** | RESTORE collision | Restoring a trashed instance while a replacement already exists yields **TWO concurrent live instances of one template**, both with `rt1_repeatingTemplate` intact. The app **tolerates it** — no merge, no mutation, no error; both render as distinct rows in Today. Show Latest still picks `max(creationDate)` over the untrashed set (the restored older one is not picked). |
| **L5** | HARD-DELETE (trash+empty) the live after-completion instance | Same series-advance as L3 (the advance is stamped on the TEMPLATE at trash time, so the series **survives** the hard delete and keeps spawning). A `TMTombstone` row IS written (the instance carries `leavesTombstone=1` — repeating lineage, TOMB1). |

## Environment

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (UNTOUCHED). ONE disposable `--vnc-experimental` clone `sl2-lab`, airgapped, clock pinned **2026-07-05 12:00** then advanced **+1 day/step** through **07-11** (RSIM-S small-increment law). Accessibility via the AXVM1 rung-b VNC grant; ui-vector conversions (`make-repeating`) driven through the **production CLI** e2e bundle. Fixtures fully synthetic. Branch `mg/sl2-trash-dynamics`. Artifacts (gitignored): `lab/artifacts/sl2-lab/`.

## Method / oracle / harness

Oracle = **`id of selected to dos`** (Things' own selection model), the SL1-sanctioned path — re-verified here against a known seed (`95tovetAyq9R58hp5714D6` → itself). Writes went only through official surfaces: URL scheme (`add` / `update?completed=true`), AppleScript (`delete to do id` = move to Trash; `move to do … to list "Inbox"` = scripted Put Back, E15; `empty trash`), the GUI right-click **Put Back** (VNC HID, PLOG1 recipe), and the CLI ui-vector `make-repeating` (`--dangerously-drive-gui`, fixed and `--after-completion`). Ground truth = read-only guest SQLite. Scripts: [`lab/scripts/research-sl2.sh`](../../lab/scripts/research-sl2.sh) (setup, leaves VM up), [`lab/scripts/sl2.sh`](../../lab/scripts/sl2.sh) (dispatcher: `convert / imatrix / tmatrix / trash / restore / empty / complete / clock / showlatest / putback / tomb`).

`imatrix` = one row per instance (`type`, `status`, `trashed`, `start`, `startDate`, `creationDate`, `stopDate`, template-FK); `tmatrix` = the template's generation bookkeeping (`trashed`, `status`, `hasRule`, `paused`=`rt1_instanceCreationPaused`, `icCount`=`rt1_instanceCreationCount`, `icStartD`, `nextStartD`=`rt1_nextInstanceStartDate`, `afterComplRefD`=`rt1_afterCompletionReferenceDate`).

## Q1 — Show Latest vs a TRASHED latest instance (FIXED daily template `EpnyfRZE`)

Three OPEN instances accumulated by +1-day advances (07-05/06/07):

| tag | uuid | creationDate | occ. date |
|---|---|---|---|
| I05 | `RytJoqEaqgVwQ8yktmBBy7` | 1783209600 | 07-05 |
| I06 | `9dVYhx4kk7ZFHdEfB9A79u` | 1783296000 | 07-06 |
| I07 | `6E1z4NgVK4BH9vPECrQkCb` | 1783382400 | 07-07 (max) |

| step | state | Show Latest PICK | verdict |
|---|---|---|---|
| baseline | I05/I06/I07 all `trashed=0` | **I07** (max creation) | reconfirms SL1 |
| trash I07 | I07 `trashed=1`; I05/I06 open | **I06** (newest untrashed) | **skips the trashed max → L1: `trashed=0` filter** |
| empty trash | I07 hard-deleted; I05/I06 open | **I06** (survivor) | **L1b: computed live, no dangling/error** |
| trash I05+I06, empty (ZERO instances) | template has 0 instances | **menu item absent** (`enabled` read `-1728`; Repeat submenu = `Reschedule…, Pause`; selection stays on the template) | **L1c: affordance removed, not disabled** |

Contrast, template WITH instances: Repeat submenu = `Reschedule…, Pause, Show Latest`. (The "3 trashed rows before empty" on the first empty = my 1 instance + 2 pre-existing golden trash rows; the empty is global — see the sequencing note below.)

## Q2 — after-completion repeater, live instance trashed (template `TvCwwLir`)

`tmatrix` progression (the load-bearing evidence):

| step | icCount | nextStartD | afterComplRefD | paused | imatrix (open live instance) |
|---|---|---|---|---|---|
| post-convert AC | 1 | NULL | NULL | 0 | `GJyuVGLH` 07-08 open |
| complete `GJyuVGLH` (07-08) | 1 | **07-09** | **07-08** | 0 | `GJyuVGLH` → status 3 (mechanism works) |
| advance 07-09 (spawn) | 2 | NULL | NULL | 0 | `Gv4AmWUB` 07-09 open (template reset) |
| **trash `Gv4AmWUB`** (no completion) | 2 | **07-10** | **07-09** | **0** | (none open — but template ADVANCED) |
| advance 07-10 | 3 | NULL | NULL | 0 | `SmFdP2Uw` 07-10 open (replacement SPAWNED) |

The trash of the live open instance stamped `afterComplRefD` = the trashed instance's own date (07-09) and `nextStartD` = +interval (07-10) — **exactly what completion does** — and the replacement spawned on schedule. `paused` never moved off `0`. **L3: trash of a live AC instance == completion trigger; the series self-advances, it does not go dormant and does not pause itself.**

## Q3 — FIXED repeater, live instance trashed (template `FsV96JFb`)

| step | imatrix | tmatrix |
|---|---|---|
| post-convert (07-07) | `DSA49MjV` 07-07 open | icCount=1, nextStartD=07-08, paused=0 |
| trash `DSA49MjV` (live) | `DSA49MjV` `trashed=1` | **icCount=1, nextStartD=07-08, paused=0 — UNCHANGED** |
| advance 07-08 | `DSA49MjV` trashed 07-07 + `VZw8bWjE` 07-08 open | icCount=2, nextStartD=07-09 |

**L2: fixed repeater is date-driven; trashing the live instance mutates no template column; the next occurrence spawns on schedule; the trashed date is not re-materialized.**

## Q4 — RESTORE collision (from Q3: `DSA49MjV` trashed 07-07 + `VZw8bWjE` live 07-08)

Restored `DSA49MjV` via **GUI Put Back** (right-click in the Trash view; the top item reads **"Put Back in Today"** — location/date-aware). Reachable exactly per PLOG1.

| after restore | `DSA49MjV` (restored) | `VZw8bWjE` (replacement) |
|---|---|---|
| trashed | 0 | 0 |
| start / startDate | **start=1, startDate=07-07 (in-place, kept)** | start=2, startDate=07-08 |
| `rt1_repeatingTemplate` | `FsV96JFb` (intact) | `FsV96JFb` (intact) |

**Two concurrent live instances of one template**, both FK-intact, no merge/mutation/error; the GUI renders both as separate rows in Today. **Show Latest PICK = `VZw8bWjE`** (max `creationDate` 07-08) — the restored older instance is NOT picked. **L4.**

**Put Back vs scriptable move (both feasible, measured):** re-trashing `DSA49MjV` and restoring via the scriptable `move … to list "Inbox"` (E15) left it `start=0, startDate=NULL` — **de-scheduled to the Inbox**. GUI Put Back preserves the occurrence's schedule in place (`start=1, startDate=07-07`); the scripted move clears it. Both un-trash and both preserve the template FK; neither changes the Show Latest pick (still max `creationDate`).

## Q5 — HARD-DELETE the live after-completion instance (template `TvCwwLir`, live `SmFdP2Uw` 07-10)

`leavesTombstone` on `SmFdP2Uw` pre-delete = **1** (repeating lineage). Trash `SmFdP2Uw` → template stamped `afterComplRefD`=07-10 / `nextStartD`=07-11 (the L3 advance repeats). Empty trash (hard delete). After: the row is GONE and `TMTombstone` holds **exactly 1 row for its uuid** (total 3→5; the co-emptied trashed AC instance `Gv4AmWUB` also tombstoned — both repeating lineage). Advancing to 07-11 spawned the replacement `8aDEhVDL` (07-11): **the series SURVIVES the hard delete** because the advance was already stamped on the template. **L5 confirms TOMB1's `leavesTombstone=1 ⇒ tombstone` gate on the trash+empty path.** (One-line, not a tombstone re-probe.)

## Read-layer parity (the query fix in this PR)

Q1/L1 **contradicts the shipped `latestInstanceUuid`** (`src/read/queries.ts`), which SL1 shipped with NO `trashed` filter (`… ORDER BY creationDate DESC LIMIT 1`). The GUI Show Latest never selects a trashed instance, so the derivation must add **`AND trashed = 0`** to be GUI-faithful. Fixed here: the query, its JSDoc (cite SL2), the R11 e2e pin (new assertion: a trashed max-`creationDate` instance is excluded), and the `contract.md` `latestInstance` glossary wording. Note that SL1's "no *status* filter" survives untouched — a COMPLETED newest-spawned instance is still the latest (SL1 D1); only *trashed* is filtered.

## Sequencing note (the global empty-trash)

`empty trash` is global. Questions were ordered Q1 → Q3 → Q4 → Q2 → Q5 so that the only mid-run empties (Q1, Q5) fired when the Trash held only the intended rows (plus, on Q1's first empty, the golden's 2 pre-existing trash rows, which were incidental collateral). Q4's Put Back ran with a single-row Trash (clean coordinate). Each question read its own template, so the Q1 template's continued spawning on later advances did not affect any other matrix.

## Anything odd → filed to [things-app-oddities.md](../things-app-oddities.md)

**Trashing a live after-completion repeating instance advances the series as if it were completed** (stamps `rt1_afterCompletionReferenceDate` = the trashed instance's date and `rt1_nextInstanceStartDate` = +interval, then spawns the next occurrence on schedule). A user who trashes an unwanted after-completion occurrence — expecting to skip it — instead gets the next one generated, identical to having completed it. Evidence: Q2 `tmatrix` progression above (`sl2-lab`, 3.22.11).
