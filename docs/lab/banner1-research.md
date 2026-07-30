# BANNER1 — the Today "You have N new to-dos" banner + yellow-pip law

**Extends [UPC1](upcoming-research.md) finding 2 / oddities §8d** (deadline-pulled Today members are computed overlays that MATERIALIZE `start→1, startDate:=deadline` when the banner is acknowledged). BANNER1 characterizes the WHOLE banner: which Today members are counted/pipped, where the "reviewed" state lives, exactly what clicking OK mutates per membership class, and whether a reader can reconstruct the pip set from data. The headline is a clean, DB-derivable law with a strong API consequence.

## Verdicts as laws

| # | Question | Law |
|---|---|---|
| **L1 — the pip predicate** | Which Today members are pip'd / counted in "N new"? | A Today member is **new (pip'd, counted in the banner) ⟺ it is NOT yet in materialized form** — i.e. `start != 1 OR startDate IS NULL`. Materialized = `start=1 AND startDate IS NOT NULL`. The banner **N = the count of pip'd rows**, exactly. Confirmed row-for-row against a 23-member Today (6 predicted PIP = 6 rendered pips = banner "6"). |
| **L2 — membership classes** | What arrives new? | **Autonomous entrants are new:** (b) SCHEDULED arrival (`start=2` on its startDate), (c) repeat-instance SPAWN (`start=2`), (a) DEADLINE-pull (`startDate IS NULL`, deadline due). **User-placed entrants are NOT new:** (d) an item moved to Today (`update when=today`) or (f) freshly `add`ed with `when=today` — both land already materialized (`start=1, startDate=today`), so they show **no pip and raise no banner**. |
| **L3 — the discriminator / persistence** | Where does "reviewed" live? Is the pip set derivable? | **There is NO separate reviewed/acknowledged marker.** OK's only DB effect is to MATERIALIZE the new rows themselves (see L4). The pip set is a **pure function of synced `TMTask` columns** (`start`, `startDate`, plus the todayView membership predicate) — **fully derivable by our reader.** Not app-session state: it PERSISTS across relaunch-without-OK, and after OK it stays cleared and does **not** reappear (materialization is durable, not a per-day recompute). |
| **L4 — what OK mutates, per class** | | OK **normalizes every new member to `start := 1` and a concrete `startDate`**: it flips `start 2→1` (scheduled/spawned/evening) or `start 0→1` (inbox deadline-pull — a silent DE-INBOX, §8s) and **stamps `startDate := todayIndexReferenceDate`** wherever it was NULL (deadline-pulls, §8d). Nothing else — no other column, **no other table**. Verified: OK on a 6-new Today changed exactly **12 dump lines = 6 TMTask rows**, zero rows in `TMMetaItem` / `Meta` / `TMSettings` / `BSSyncronyMetadata` / any other table. Already-dated rows are otherwise untouched; the hidden repeating **template** (`start=2`, `startDate NULL`, not a Today member) is never materialized. |
| **L5 — stamp timing** | Is `todayIndexReferenceDate` stamped at the deadline date or first-launch? | **At the deadline (entry-cohort) date — independent of when the app first sees it.** For a deadline-carrying item it is written **= the deadline at CREATION** and never re-stamped: an item with deadline 07-07, app **CLOSED across 07-07**, first launched 07-08, read `todayIndexReferenceDate = 07-07` (not 07-08). Closes UPC1's open question and [today-order-research](today-order-research.md) "Open edges" line 2. |

## The derivable pip predicate (the load-bearing result for the API)

Among the rows the todayView predicate already returns as **Today members**:

```
newInToday(row)  ⟺  row.start != 1  OR  row.startDate IS NULL
reviewed(row)    ⟺  row.start  = 1 AND row.startDate IS NOT NULL
```

Both operands are ordinary synced `TMTask` columns our reader already reads. A `provisional` / `new` marker on a Today entry **can be faithfully derived with zero new inputs** — no container file, no app-session hook, no separate meta record. This resolves the coordinator's H1-vs-H2:

- **H1 (a synced last-reviewed marker) is FALSIFIED** — clicking OK wrote **no marker row anywhere** (12/12 changed dump lines were the six materialized `TMTask` rows themselves; `TMMetaItem`, `Meta`, `TMSettings`, `BSSyncronyMetadata` all byte-identical across OK).
- **H2 (pip is derived per-item from synced fields) is CONFIRMED, refined:** the derivation is the L1 predicate above, and "acknowledged" is a **synced mutation of the very rows** (`start`/`startDate`), *not* per-device session state. This matches the maintainer's cross-device observation (both clients compute the same pip set from the same synced columns) — and predicts that an OK on one device propagates (the materialization syncs), so the other device also stops flagging them. **Sync propagation of the materialization was not directly observed** (airgapped single VM) — if that prediction ever matters, verify it with the SYNC2 two-clone rig; the single-device DB evidence stands on its own.

Why a bare date-cohort marker (e.g. `todayIndexReferenceDate > lastReviewedDate`) is the WRONG model, disproven by a natural experiment in the golden: two Today rows both carried `todayIndexReferenceDate = 07-03` yet one was pip'd (a `start=2` repeat instance) and one was not (`LAB-TODAY-1`, `start=1`+`startDate` set). A single global date cannot separate them; `start`/`startDate` do. `TMMetaItem` holds a single packed date **= today** (07-05 on the pinned clock) that tracks day-rollover and is **untouched by OK** — it is not a reviewed marker.

## Q1 — the class matrix (manufactured newcomers)

One clone, pinned 2026-07-05, +1-day advances. Seeds created at 07-05, materialized (OK), then observed as fresh 07-06 arrivals (and a 07-08 late-launch round). Pip state read from **VNC screenshots** (the AppleScript list oracle gives membership + order but **cannot see the banner or the pips** — both are custom NSViews, invisible to the AX tree; a `whose value contains "new"` static-text scan and a `button whose title is "OK"` scan both return empty). Ground truth = guest read-only SQLite.

| Class | Manufacture | Pre-OK DB shape | New / pip? | Banner N contribution |
|---|---|---|---|---|
| **(a) deadline-pull** | anytime + deadline, deadline day arrives | `start=1, startDate=NULL, deadline≤today` | **YES** (`startDate IS NULL`) | counts |
| **(b) scheduled arrival** | `when=<date>`, that date arrives | `start=2, startDate=today` | **YES** (`start!=1`) | counts |
| **(c) repeat-instance spawn** | daily fixed template, next occurrence spawns | `start=2, startDate=occ.` | **YES** (`start!=1`) | counts |
| **(d) pushed to Today** | `update?id=…&when=today` (while closed / from another device) | `start=1, startDate=today` (already materialized) | **NO** | — |
| **(e) evening arrival** | (see note) | evening = `startBucket=1`, orthogonal to newness | as its start-class | per (b) |
| **(f) fresh add-to-today** | `add?…&when=today` | `start=1, startDate=today` | **NO** | — |

Confirmed pip counts read from screenshots: 07-05 baseline "6 new" (golden's 4 repeat instances + 1 scheduled-today + 1 deadline-pull) → 6 pips; a single fresh repeat spawn → "1 new"; the 07-06 round → "6 new" (BAN-A deadline-pull, BAN-B scheduled, BAN-C spawn, BAN-E scheduled, plus golden LAB-P-2 deadline-pull + LAB-REPEAT-DAILY spawn) → 6 pips; the 07-08 late round → "6 new" including BAN-Q4 deadline-pull. Every count equalled the pip count and matched the L1 predicate exactly (confirmatory query cross-checked all 23 Today members).

**Evening note:** a genuine *future-evening arrival* is not manufacturable through the URL scheme (`when=` has no future-evening spelling; `when=evening` is today-evening only). The evening flag is `TMTask.startBucket=1` (golden `LAB-EVENING-1`: `start=1, startBucket=1`, and it is **not** pip'd once materialized) — orthogonal to newness. A scheduled item that happens to fall in the evening bucket is still governed by L1 via its `start`, so an evening arrival behaves exactly as class (b). Recorded as inferred, not separately screenshotted.

## Q1b — Someday / Inbox membership of a PRE-OK pulled item, and OK's de-inbox side effect

A **someday** to-do + deadline (`start=2`) and an **inbox** to-do + deadline (`start=0`), each with a due deadline at launch, read via the AppleScript list oracle:

- **PRE-OK (overlay, columns still `start=2`/`start=0`, `startDate NULL`): the item renders in Today ONLY — NOT in Someday, NOT in Inbox.** Oracle: Someday held only the untouched `LAB-SOMEDAY-1`; Inbox held only the untouched `LAB-INBOX-*`; the pulled `BAN-SD-DL`/`BAN-IB-DL` were absent from both, present in Today (and pip'd). **There is no dual membership** — the app's Someday/Inbox views already exclude a due-deadline-pulled row even though its `start` column has not yet moved. (This corroborates and extends [UPC1](upcoming-research.md)-C's "an unsuppressed past-due someday item leaves the Someday list for Today" to the pre-OK overlay and to the **Inbox** case, which UPC1 never pinned.)
- **POST-OK:** `BAN-IB-DL` `start 0→1` and `BAN-SD-DL` `start 2→1`, both `startDate := 07-06` (the deadline). Both stay in Today, still absent from Someday/Inbox.

Two consequences:
- **Reader divergence to encode:** a Someday/Inbox view keyed on the raw `start` column ALONE would still list a due-deadline-pulled row (its `start` is still 2/0 pre-OK) — but the GUI does not. Our someday/inbox views must exclude rows that the todayView pulls in (`startDate IS NULL AND deadline ≤ today AND not-suppressed`) to stay GUI-faithful, mirroring how todayView already claims them.
- **A silent side effect worth flagging (oddities §8s):** acknowledging the purely informational Today banner **de-inboxes an untriaged Inbox item** (`start 0 → 1`) and **de-somedays a Someday item** (`start 2 → 1`). A user who clicks OK to dismiss the notice has silently converted every deadline-pulled Inbox/Someday item into a triaged Anytime item.

## Q2 — persistence (the two isolation tests)

- **Relaunch WITHOUT OK (same day):** banner "6 new" and all 6 pips **PERSIST** identically → the state is not a launch-transient; it is recomputed from the unchanged columns.
- **OK, then relaunch (same day):** banner gone, pips gone, and they **do NOT reappear** → materialization is durable. This falsifies a "pip = cohort==today, returns until the day rolls" reading; the rows were changed, so they no longer satisfy L1.

## Q3 — what OK mutates, per class (full-row diff)

`.dump` before vs after OK, `/usr/bin/diff`, both the 07-05 baseline (6 new) and the 07-06 fresh round (6 new): **12 changed lines each = 6 TMTask rows, no other table.** Per class:

- **(a) deadline-pull** (`BAN-A-DLPULL`, golden `LAB-DEADLINE-ONLY`/`LAB-P-2`): `startDate` `NULL → deadline` (`start` stays 1 for an anytime source; `0→1` for an inbox source per §8d). This is the §8d materialization, now shown to be one case of the general rule.
- **(b) scheduled** (`BAN-B-SCHED`, `LAB-PINNED-TODAY`): `start` `2 → 1`; `startDate` unchanged.
- **(c) repeat spawn** (`BAN-C-REPEAT` instance, `LAB-REPEAT-DAILY` instances, `LAB-REPEAT-WEEKLY-PROJ` instance — projects included): `start` `2 → 1`; `startDate` unchanged.
- **(e) evening / (b)-like:** `start` `2 → 1`.
- **Not touched:** already-materialized rows, the hidden repeating **template** (`start=2`, `startDate NULL`, not a Today member), and suppressed items (never in the banner; keep `start=2`, §8d).

No unexpected column or table moved in any run.

## Q4 — stamp timing (UPC1's open question, closed)

`BAN-Q4-DL07`: anytime + deadline **07-07**, created 07-05. `todayIndexReferenceDate` was written **= 07-07 at creation**. App quit; clock advanced 07-06 → 07-07 → 07-08 with Things **CLOSED the whole time**; first launched 07-08. Post-launch read: `todayIndexReferenceDate = 07-07` (the deadline), **not 07-08** (first launch); the row entered Today and was pip'd (`start=1, startDate NULL`). So the entry-cohort date for a deadline-driven item is the **deadline date**, fixed at forecast time and invariant to a late first-launch. Symmetric with scheduled/spawn cohorts, whose `todayIndexReferenceDate` is their `startDate`.

## Replication guidance (for an API `new`/provisional marker)

A read-layer `provisional` (a.k.a. `new`, "not yet reviewed on the Today banner") flag on each Today entry is faithfully derivable and needs **no** new data source:

```
provisional := isTodayMember(row) AND (row.start <> 1 OR row.startDate IS NULL)
```

- It is computed from columns already in the todayView projection; it inherits Today membership's own predicate (so suppressed deadline items, future-start items, templates are already excluded).
- It matches the GUI's pip set and the banner count exactly, and it is **sync-stable** (both are TMTask columns; the same value is computed on every synced device).
- It cannot be *cleared* by our reader (writes go through official surfaces only, and clearing == the app's materialization which only the GUI banner performs) — so expose it read-only as a hint, not a mutable state.
- Do **not** try to derive it from `todayIndexReferenceDate` vs any stored marker: there is no marker, and the cohort date does not separate materialized from unmaterialized rows (the golden twin counter-example).

## Environment / method / harness

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (UNTOUCHED; clock-pinned 2026-07-05, advanced **+1 day/step** through 07-08, RSIM-S small-increment law — no +15-day wedge). ONE disposable `--vnc-experimental` clone `banner1-lab`, airgapped, torn down on completion. Accessibility via the AXVM1 rung-b VNC grant (used for setup + oracle reads only; the banner/pips are not AX-reachable, so **OK is clicked via VNC HID** at the banner-button coordinate and pips are read from screenshots). `make-repeating` (class c) driven through the **production CLI** e2e bundle (`todo make-repeating --frequency daily --interval 1 --dangerously-drive-gui`). Fixtures fully synthetic (`BAN-*`). Branch `mg/banner1-new-todos`. Scripts: [`lab/scripts/research-banner1.sh`](../../lab/scripts/research-banner1.sh) (setup — clone/airgap/pin/AX-grant/ship-bundle/oracle, leaves VM up) + [`lab/scripts/banner1.sh`](../../lab/scripts/banner1.sh) (dispatcher: `seed/repeater/relaunch/clock/rows/sql/metaitem/banner/ok/okvnc/shot/dbdump/cdump/pull/aslist`). Artifacts (gitignored): `lab/artifacts/banner1-lab/` (before/after-OK `.dump`s + `.settings`/`.container`/`.defaults` + the screenshot sequence `0705-*`/`0706-*`/`0708-*`).

## Oracle limits (what the AppleScript list oracle can / can't see)

`get name of to dos of list "Today"` returns membership **and order**, matching the rendered rows one-for-one — but is **blind to the yellow banner and the per-row pips** (both custom NSViews absent from the AX tree; a static-text scan for "new" and a `button "OK"` scan both come back empty). Pip identity therefore requires screenshots; the DB's `start`/`startDate` (the L1 predicate) is the exact ground-truth proxy, verified against the screenshots every round.
