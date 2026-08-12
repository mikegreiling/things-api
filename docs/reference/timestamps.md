# Timestamps — the timestamp side-effect inventory

The consolidated map of **what changes each of the three task timestamps** Things stores — `creationDate`, `userModificationDate` (`umd`), and `stopDate` — per operation class, with the evidence for every cell. Read this whenever you are designing a write (which stamps will it move, and which bystanders?), building the `things watch` change-detector (what will and will not surface in a `umd`-keyed timeline?), or planning a bulk cleanup on the production store (how much `changes` noise will it make?).

**This is a SYNTHESIS document, not itself version-stamped evidence.** It re-states findings from the `docs/lab/` campaigns; each claim carries the probe id + evidence doc it comes from, and those cites carry their own Things-version / golden stamps (mostly **golden-v1 / 3.22.11** and **golden-v2 / 3.22.12**, both DB schema v26). Where a cell rests on golden-v1 only, or on a maintainer observation not yet VM-probed, that is called out inline. Follows the same pattern as [timezones.md](timezones.md) and [task-api-landscape.md](task-api-landscape.md).

**The three columns, up front** ([schema atlas](../lab/headless-research.md); [timezones.md](timezones.md) load-bearing fact):

- **`creationDate`** — UTC epoch, stamped at row birth. The finding below: **no known app operation re-stamps it in place on a surviving row.** The only ways the "same item" ends up with a new creation date are (a) our own explicit `--created-at` lever, or (b) an **identity replacement** — the row is destroyed and a fresh one minted.
- **`userModificationDate` (`umd`)** — UTC epoch, the key the `changes` view and the future `things watch` feature sort on. Some ops bump it, many re-rank rows **silently** — the silent class is the whole design hazard for a `umd`-keyed watcher (§2, watch consequence).
- **`stopDate`** — UTC epoch, the resolution instant; also the log-boundary discriminator ([glossary](glossary.md) log-boundary). Set by resolution, preserved across resolution-kind flips, cleared on reactivate (§3).

**UNPROBED cells are first-class content here** — an inventory exists precisely to name the corners nobody has measured, so they are never mistaken for "known silent" or "known preserved."

---

## 1. `creationDate` — what can change it

### 1a. The settled law

**No known operation re-stamps `creationDate` in place on a surviving row.** Every write we have byte-probed leaves an existing row's `creationDate` untouched — including the whole reorder family (ORD-12/13/18/19/20/22), tag apply/remove/rename/delete (TAGMOD T1–T3, [tagmod](../lab/tagmod-tag-area-umd.md)), resolution flips (BACKDT B-FLIP, [backdt](../lab/backdt-project-backdating-and-flips.md)), and reactivate (RESID1 L-RESTORE). `set creation date` full-row byte-diffs confirm the column is *only* touched by an explicit writer (TAGMOD T5a byte-diff — only the targeted stamp column moves).

The **only in-place / at-birth writers of a chosen `creationDate`** are our own two levers ([resolution-timestamp-surface.md](../design/resolution-timestamp-surface.md) §2):

| Lever | Vector | Timing | Side effects |
|---|---|---|---|
| `update … --created-at` | AS `set creation date of <kind> id X` | **in place on a surviving row** | status-safe (never flips status; works open/canceled/completed), **`umd`-silent** (does NOT bump), single-row (no child cascade) — BACKDT B-PROJ-AS.2 / flip2 SCRT |
| `add … --created-at` | `things:///json` `creation-date` | at row birth | atomic import; born open (or resolved with `--completed-at`) — RESID1 R-JSONPAR cases D/E, BACKDT B-PROJ-JSON.1 |

Both accept an ISO date or datetime; a **date-only** value normalizes to **noon in the effective zone** (json rejects a bare date outright; AS date-literals stamp midnight — BACKDT B-DATEONLY, [timezones.md](timezones.md) §6). URL `creation-date=` is a dead no-op on both kinds (BACKDT table, [oddities](../things-app-oddities.md) §2g).

### 1b. The IDENTITY-REPLACEMENT class (the "same item" gets a new date because it is a NEW row)

These operations do not re-stamp a row — they **destroy the row and mint a fresh one**, so the successor carries a new `uuid` AND a new `creationDate`. This is the only way (besides our `--created-at`) the thing a user thinks of as "the same item" ends up with a different creation date. External references to the old uuid dangle.

| Operation | Successor's `creationDate` | Evidence |
|---|---|---|
| **make-repeating, delete-path** (the default: bare/plain-children projects, bare/checklist to-dos) — source row hard-deleted, template + instance minted fresh | **template** = fresh write-time wall-clock (e.g. drive-time 12:07); **instance** = **occurrence-day MIDNIGHT backdate** (rule anchor, e.g. `1783209600` = 2026-07-05 00:00) | rsim-results [~line 206 + §RSIM-R](../lab/rsim-results.md); R5 instance `creationDate=1783209600` |
| **Spawned occurrences** (an after-completion or fixed schedule materializing the next instance) | born at **occurrence-midnight** (the rule anchor day), NOT wall-clock | [rsim-results](../lab/rsim-results.md) §RSIM-R; TIMEZ2 early-materialization confirms the same midnight anchor (RD-11) |
| **GUI Convert-to-Project on a repeating INSTANCE** — old instance uuid deleted, new project row minted, `rt1_repeatingTemplate` FK cleared | **conversion wall-clock** (e.g. `1783253594`), NOT an occurrence midnight; inherits title + `startDate` | §8m CONVINST ([sit5](../lab/sit5-areaproj-convinst-logsweep.md)); assumption-register RD-6 |
| **make-repeating, PRESERVE-path** (fixed project whose subtree holds a nested repeater; the one to-do preserve is a rich-content case, deadline the leading unisolated trigger) — source relinked as the instance, NOT deleted | source's **ORIGINAL add-time** (the row survives, so its `creationDate` is unchanged) | rsim-results §RSIM-R C1; the FK-derive-not-time-heuristic rule (~line 285) |
| **promote-via-clone `--preserve-created`** (our reimplemented make-repeating: `clone(X, --preserve-created) → native-promote → trash(X)`) | the clone deliberately keeps the source's `creationDate` (default without the flag: a new capture, created now) | [promote-via-clone](../design/promote-via-clone.md) §Defaults |

### 1c. UNPROBED `creationDate` cells

| Cell | Status | Note |
|---|---|---|
| **Plain (non-instance) GUI Convert-to-Project** creationDate | **UNPROBED** | SIT5 probed only the *repeating-instance* convert (CONVINST). Convert-to-Project on an ordinary to-do is almost certainly the same new-row identity replacement (both drive the same `Items ▸ Convert to Project…` menu op) but the `creationDate` VALUE of a non-instance convert was never captured, and convert has **no headless surface** (menu-only), so it has not been exercised. |
| **`project.promote-heading` (heading → project)** new project's creationDate VALUE | **UNPROBED (value only)** | Row identity IS settled: promote-heading is an **identity replacement** — new project uuid returned, old heading uuid gone, children reparent (HEADCERT1-c1, [headcert1](../lab/headcert1-certification.md); [heading-demotion-and-move](../design/heading-demotion-and-move.md) §2). By analogy with CONVINST the new project's `creationDate` is presumably the conversion wall-clock, but the actual stamp was **not measured** in the certification. |
| **`project.dissolve-heading` / `move-heading-to-project`** children/heading creationDate | **not a creationDate concern** | These re-home surviving rows (no identity replacement) — the rows keep their original `creationDate` trivially. DISS1 captured `index` preserved; HXPC1 captured a single-row FK change. (Their `umd` footprint is the open question — see §2c.) |
| **Heading demotion row-identity beyond promote** | n/a | There is no to-do↔heading or heading↔to-do *conversion* op in the surface — "heading demotion" is the umbrella for the project-scoped heading verbs ([heading-demotion-and-move](../design/heading-demotion-and-move.md) §2), of which only promote-heading is an identity replacement. |

---

## 2. `userModificationDate` (`umd`) — the bump/silent inventory

`umd` is the sort key of the `changes` view and the natural change signal for `things watch`. Operations split cleanly into a **bump class** (the row's `umd` is re-stamped to now — surfaces in `changes`) and a **silent class** (the row is mutated but `umd` is byte-identical — invisible to a `umd`-keyed timeline). The silent class is dominated by the native reorder family.

### 2a. The bump table (well-evidenced)

| Operation class | `umd` | Scope | Evidence |
|---|---|---|---|
| **Tag APPLY / REMOVE** | **BUMP** | the owning task row, **every working surface** (URL `update?tags=` for to-dos, `update-project` for projects, AS `set tag names`, both CLI `--vector` legs); open AND logged, to-do AND project | TAGMOD **T1** ([tagmod](../lab/tagmod-tag-area-umd.md)); register RD-23 |
| **Complete / cancel** (initial resolution) | **BUMP** | the resolved row; a project cascade-completes open children (each child bumped, stamped at *now*) | BACKDT B-PROJ-AS "complete (AS)" leg + B-PROJ-AS-OPEN cascade |
| **Resolution FLIP** (completed↔canceled, either direction, URL or AS, both kinds) | **BUMP** | the flipped row (`stopDate` **preserved** — §3) | BACKDT **B-FLIP** (a/b/c) |
| **Re-resolve same-state** (complete an already-completed item) | **SILENT — true no-op** | nothing changes: status, `stopDate`, AND `umd` all byte-identical | BACKDT **B-FLIP(d)** |
| **Reactivate / reopen** (swept or unswept) | **BUMP** | `status 3→0` + `stopDate→NULL` + `umd` bump — otherwise index/heading/when-silent | RESID1 **L-RESTORE / R-RESTAGE** ([resid1](../lab/resid1-batched-residuals.md)); LOGSORT; register RD-13 |
| **`update … --completed-at`** (AS `set completion date`) | **BUMP** | rewrites `stopDate`; **FORCES status=completed** from any prior status (open → completes; canceled → re-completes 2→3) — WG-7 guard | BACKDT §"set completion date", flip2 SCD; register WG-7 |
| **URL field writes** (`when=`, `deadline=`, `title=`, `notes=`, tags, status) | **BUMP** (1 per URL txn) | "URL field-writes always bump `umd`" — byte-probed for `when=`/tags/`deadline=`/status; title/notes ride the same general law | ORD-18 note ([register](assumption-register.md)); DLBNC-2 (1 bump per URL `deadline=` set) |
| **Deadline-cycle leg** (the forecast-reorder primitive: URL `deadline=` clear + re-set) | **BUMP ×2 per leg** | clear and set are separate URL txns → 2 bumps; every byte outside `todayIndex`+`umd` byte-identical | DLBNC **-3b / -4** ([dlbnc](../lab/dlbnc-deadline-cycle.md)) |
| **Container move / reparent** | **BUMP** (moved row) | a reparent writes the container FK + bumps the moved row's `umd`; a no-position move into Today does NOT fire the placement leg, so bystanders stay silent (ORD-20 consequence) | WG-2 reparent hazard (`project` NULL→P + `umd` bump, [tdrag](../lab/tdrag-ax-residuals.md)); MOVPLC / ORD-20 |
| **Area DELETE — OPEN direct members** | **BUMP** | open direct member (to-do OR project) → `trashed=1`, area FK cleared, `umd` bumped (trashing is a modification) | TAGMOD **T4** (§9aa); register RD-5 refinement |
| **AS `set modification date`** (the explicit `umd` writer / restore lever) | **writes `umd` directly** | surgical (only the `umd` column moves), durable across relaunch, reversible modulo a **1-second resolution floor** (setter cannot reproduce the sub-second fraction, so restored `umd` is always ≤ original) | TAGMOD **T5** (a–f) |

### 2b. The SILENT table (the watch-design hazard)

| Operation class | `umd` | Note | Evidence |
|---|---|---|---|
| **Tag RENAME** | **SILENT** | `TMTaskTag` stores the tag *uuid*, so a title change touches no member row; `TMTag` has no `umd` column at all | TAGMOD **T2 / T6**; register RD-23 |
| **Tag DELETE** (leaf and parent-subtree) | **SILENT** | join rows cascade away (A26); task rows never stamped | TAGMOD **T3 / T6** |
| **Area DELETE — LOGGED direct members** | **SILENT** | a logged/swept direct member (status 3) is NOT trashed, merely **DETACHED** (area FK→NULL), left live in the Logbook, `umd`-silent — the status-dependent refinement to RD-5 | TAGMOD **T4** (§9aa); register RD-5 |
| **Native Today reorder** (`reorder to dos in list "Today"`) | **SILENT** on every touched row | writes each named row's `todayIndex` + re-stamps `todayIndexReferenceDate→today`, leaving `start*`/`status`/`stopDate`/`umd` byte-identical; the `tiRef` re-stamp collapses entry cohorts (a subset reorder visibly re-ranks the whole list) | **ORD-20** MOVPLC ([movplc](../lab/movplc-move-placement-today.md)) |
| **Native Today partial-wire** (single- or multi-id) | **SILENT** (unconditional) | re-firing an already-placed wire still rewrites every named row's `todayIndex`/`tiRef`, still `umd`-silent | **ORD-22** TODWIRE ([todwire](../lab/todwire-partial-wires-today.md)) |
| **Heading reorder (`project.move-heading`) — OPEN headings** | **SILENT** (`index`-only) | index-only + `umd`-silent while every heading is open; an **ARCHIVED** heading in the wire is REOPENED instead (`status 3→0` + `stopDate→NULL` + `umd` bump — a bump, sweep-agnostic) | **ORD-12** HEADSORT ([headsort](../lab/headsort-heading-lifecycle-reorder.md)) |
| **Direct-child to-do reorder (`project` scope) — OPEN + UNSWEPT-resolved** | **SILENT** (`index`-only) | open AND unswept completed/canceled children re-rank `index`-only + `umd`-silent (no reopen); only a **SWEPT** child is reopened (`status 3→0` + `stopDate→NULL` + `umd` bump). `umd`-bump count = #swept in the wire | **ORD-13** LOGSORT ([logsort](../lab/logsort-logged-child-reorder.md)) |
| **Someday / anytime index re-ranks + bounces** | **SILENT** | `project id` someday re-rank rewrites `index` with `todayIndex`/`start`/`startDate`/`deadline`/`tiRef` byte-identical, **`umd` NOT bumped** (UPCDL-3); someday↔anytime bounce re-ranks `index` only (UPCDL-7b); deadline-cycle rewrites `todayIndex` with the someday `index` byte-identical (O31/O33) | **ORD-18** ([register](assumption-register.md)); UPCDL-3/7b ([upcdl](../lab/upcdl-deadline-axis.md)) |
| **Repeating-template day-block wiring** (native `list "Tomorrow"` / `list "Upcoming"` reorder, GUI projection drag) | **SILENT** | template `todayIndex` written alone, `umd`-silent, no reparent, no crash, persists across relaunch — to-do AND project templates | **ORD-19 / WG-2** TMPLSORT ([tmplsort](../lab/tmplsort-template-protocol.md)), PTMPL ([ptmpl](../lab/ptmpl-project-templates.md)), TDRAG-1/3 ([tdrag](../lab/tdrag-ax-residuals.md)) |
| **URL `deadline=` on a repeating TEMPLATE** | **SILENT** (no-op) | a template's deadline is unwritable on URL — byte-identical row, no `umd` bump (contrast the schedule-`when=` template CRASH) | WG-2 / TMPLDL-1a/1c ([tmpldl](../lab/tmpldl-projdl-deadline-cycle.md)); [oddities](../things-app-oddities.md) §2i |
| **Log sweep** (`log completed now`; the Logbook boundary crossing) | **SILENT** (mutates zero task rows) | "swept" is a pure view projection — no per-row bit; only the `TMSettings.manualLogDate` singleton advances (and only when there are pending completions to log) | plog1 / A28 / **LOGNOW** ([timezones.md](timezones.md) §1); glossary log-boundary |
| **Early materialization under a shifted-zone launch** | **SILENT** | a repeat template due on the shifted day materializes its instance early + advances its cursor/counter `umd`-silently (the new instance is a born row, §1b) | TIMEZ2 side-effect bill #2/#3 (RD-11, [timez2](../lab/timez2-pinned-zone-workaround.md)) |
| **`set creation date`** (our `update --created-at` leg) | **SILENT** | status-safe, only the `creationDate` column moves — see §1a | BACKDT B-PROJ-AS.2 / flip2 SCRT |
| **GUI banner "OK" materialize** (`today ok`) | **SILENT** | materializes `start:=1`/`startDate:=deadline` on member rows without bumping `umd` — GUI-only, not headless-reproducible (decided-not-to-implement) | BANNERACK / RD-2 ([banner1](../lab/banner1-research.md)) |

### 2c. UNPROBED `umd` cells

| Cell | Status | Note |
|---|---|---|
| **Checklist writes** (add / check / uncheck / edit / delete a checklist item) — owning to-do `umd` | **UNPROBED** | No campaign captured whether mutating a `TMChecklistItem` bumps the owning `TMTask`'s `umd`. RESID1 only characterized the checklist *at-creation import shape* (R-JSONPAR — the object-array vs string-array bug), not the `umd` effect of a checklist edit. Live-relevant for `things watch` (`modified` granularity is an open question in the up-next watch item). |
| **`project.dissolve-heading`** surviving children `umd` | **UNPROBED** | DISS1 captured `heading→NULL` + `project→parent` + `index` preserved + not-trashed ([heading-demotion-and-move](../design/heading-demotion-and-move.md) §2) but did **not** record the children's `umd`. A container re-home is a field write, so a bump is likely (cf. the reparent-hazard bump, WG-2), but it was not measured. |
| **`project.move-heading-to-project`** (cross-project) heading `umd` | **UNPROBED** | HXPC1 verified the heading's `project` FK flips to the destination as a "single-row change" ([heading-demotion-and-move](../design/heading-demotion-and-move.md) §2) but did not assert the `umd` byte. |
| **`title=` / `notes=` URL update** individually byte-probed | **generalized, not per-field byte-probed** | Covered by the "URL field-writes always bump `umd`" law (ORD-18), byte-confirmed for `when=`/tags/`deadline=`/status; the title/notes cells ride the general law rather than a dedicated byte-diff. |
| **Reminder-time write / clear** `umd` | **UNPROBED (as a `umd` cell)** | reminder writes go over URL `when=…@HH:MM` (a URL field write → expected bump by the general law) but the `umd` byte was not isolated in the reminder campaign. |

### 2d. The watch-feature consequence (cross-reference)

A `umd`-keyed change detector — the obvious design for `things watch` — **misses the entire silent class of §2b.** The native reorder family (ORD-20 Today reorder, ORD-22 partial-wire, ORD-12 open-heading reorder, ORD-13 open/unswept-child reorder, ORD-18 someday re-ranks, ORD-19 template wiring) re-ranks rows without touching `umd`, so a naive watcher keyed on `userModificationDate` would report **no change** after a user drag-reorders a project or Today. This is the load-bearing constraint recorded on the up-next **`things watch`** item (§9r): the member-snapshot diff must compare `index`/`todayIndex`/order **directly**, not just `umd`. (The wake signal — `main.sqlite-wal` mtime — does fire on a reorder; it is the *diff* that must not rely on `umd`.) See [up-next.md](../up-next.md) "Change-watch / poll mode".

---

## 3. `stopDate` — the resolution instant

`stopDate` is the UTC-epoch resolution instant and the log-boundary discriminator (an item is logged iff `status IN (2,3) AND stopDate ≤ boundary` — [glossary](glossary.md) log-boundary).

- **Set** by the initial complete/cancel (the resolution stamps `stopDate = now`; a project cascades to its open children, stamping each at *now* — BACKDT B-PROJ-AS-OPEN), and by our explicit **`--completed-at`** (AS `set completion date` on a resolved row, or `things:///json` at creation — BACKDT B-PROJ-AS.1 / B-PROJ-JSON.1). `set completion date` additionally **forces status=completed** from any prior status (WG-7).
- **Preserved** across every resolution-kind flip: URL `update?completed=/canceled=`, `update-project`, and AS `set status`, in both directions and for both kinds, keep `stopDate` byte-identical (only status + `umd` move). This is what makes the canceled-backdate **flip-dance** (flip→completed · AS backdate · flip→canceled) safe — every leg is certified `stopDate`-preserving, so a swept item stays swept across the sequence. BACKDT **B-FLIP** ([backdt](../lab/backdt-project-backdating-and-flips.md)); [resolution-timestamp-surface.md](../design/resolution-timestamp-surface.md) §2.
- **Cleared** (`stopDate→NULL`) on reactivate/reopen (`status 3→0`) — RESID1 L-RESTORE / HEADSORT H-RESTORE / LOGSORT (register RD-13). The reopen is also the trigger for the reorder-driven reopens (ORD-12 archived-heading, ORD-13 swept-child): re-ranking such a row reopens it and nulls `stopDate`.
- **Not a row stamp, but boundary-related:** `TMSettings.manualLogDate` is a **monotonic high-water mark** — it advances only to prevent a boundary rewind, fires specifically on *leaving "Immediately"*, and a Daily→Manually flip carries it forward byte-unchanged (does NOT forward-sweep the pending window). RESID1 **R-DAILYMAN** ([resid1](../lab/resid1-batched-residuals.md)) — this **falsifies** the earlier [timezones.md](timezones.md) §1 / [glossary](glossary.md) prediction that the flip stamps at flip time. It governs *which* resolved rows count as logged, not any individual `stopDate`.

---

## 4. Explicit overwrite levers (the deliberate writers)

The three surfaces a caller can use to set a timestamp to a chosen value, versus letting the app stamp it:

| Lever | Writes | Status | Caveats |
|---|---|---|---|
| **`--created-at <iso>`** | `creationDate` | **SHIPPED** (add: json at birth; update: AS `set creation date`) | status-safe + `umd`-silent on update; date-only → noon in effective zone; URL `creation-date=` is dead ([resolution-timestamp-surface.md](../design/resolution-timestamp-surface.md) §2) |
| **`--completed-at <iso>`** | `stopDate` | **SHIPPED** (add/complete/cancel/update, both kinds) | one field covers canceled items too (Get Info labels it "Completed on" universally — no `--canceled-at`); a canceled item that must stay canceled needs the 3-leg flip-dance; `add --completed-at` on a project requires every child resolved (§5b) |
| **AS `set modification date`** | `umd` | **NOT a shipped CLI flag** — queued as **`--preserve-modified`** | the timeline-silent bulk-edit lever (capture `umd` → mutate → restore to `floor(umd0)`); 1-second resolution floor; **sync-gate caveat** — proven only on an UNSYNCED store, its interaction with Things Cloud's timestamp-ordered 3-way merge is UNKNOWN (SYNC2 blocked), so it must not run against a synced production store until probed. TAGMOD T5; [up-next.md](../up-next.md) `--preserve-modified` item |

There is **no explicit lever** for `todayIndex`/`index` (those move only through the reorder protocols, §2b) and none for `startDate`/`deadline` beyond the ordinary `when=`/`deadline=` attribute writes.
