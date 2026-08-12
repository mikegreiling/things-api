# TAGMOD — userModificationDate side-effects of tag + area lifecycle, and the writable `modification date` restore recipe

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS 15.7.7 · DB schema v26 · guest clock pinned **2026-07-05 12:00** (guest TZ **UTC**, so `unixepoch == localtime`; pinned instant epoch **1783252800**). Campaign **2026-08-12**, ONE disposable clone (`tagmod-lab`, artifacts under gitignored `lab/artifacts/tagmod-lab/` — `report.txt` + per-row `fp/*.txt` fingerprints), no crash (Things ALIVE throughout). Discovery — no assertions; **DB row deltas are the ground truth**. Driver: [`lab/scripts/research-tagmod.sh`](../../lab/scripts/research-tagmod.sh) (subcommands `setup·t1·t2·t3·t4·t5·t6·dump·teardown`). Every write goes through an official surface (the shipped CLI's real commands, plus raw AppleScript / URL where the CLI's surfaces are distinct); reads are the RO SQLite oracle.

> ## ⚠️ SYNC CAVEAT — read before running umd-restore against a synced production store
>
> **All evidence here is from an UNSYNCED store (no Things Cloud account, airgapped clone).** How a manually-written `userModificationDate` (umd) interacts with Things Cloud's 3-way merge is **UNKNOWN** — the SYNC2 campaign that would settle it is BLOCKED ([headless-research SYNC2](headless-research.md); umd is a natural merge discriminator, and Things Cloud is a timestamp-ordered 3-way merge, NOT last-writer-wins — [things-cloud-sync-semantics]). Writing a **past** umd onto a synced row could plausibly make the local edit LOSE a merge against a peer's stored state, or be silently reconciled away, or (worst) confuse the sync engine's change-tracking. **Do NOT run the umd-restore recipe (T5) against a live synced production store until the sync interaction is probed.** The findings below are sound for a single-device/unsynced store; treat the restore recipe as sync-unsafe until proven otherwise.

## Motivation

The maintainer plans a mass tag cleanup on his production store: delete seldom-used tags, retroactively apply tags to many items, delete `(archived)` areas after tagging their contents. Each of those could stamp `userModificationDate` on hundreds of LOGGED to-dos/projects — which floods the `things changes` timeline (umd is the changes-view key) and matters for the future watch feature. TAGMOD answers, per operation, **whether the member rows' umd bumps**, and whether AppleScript's writable `modification date` property enables capturing-and-restoring umd so a bulk edit can be made timeline-silent.

## Bottom line (the cleanup playbook)

| Operation | Member umd | Timeline cost | Notes |
|---|---|---|---|
| **Delete a tag** (leaf or parent-subtree) | **SILENT** | **FREE** | join rows cascade-removed; task rows untouched (T3) |
| **Rename a tag** | **SILENT** | **FREE** | tag title changes in place; members never touched (T2) |
| **Apply / remove a tag** on an item | **BUMPS** | **COSTLY** | every working surface bumps the member umd — open AND logged, to-do AND project (T1) |
| **Delete an area** (open direct members) | **BUMPS** | expected | open members are TRASHED (that's the point) + umd bumped (T4) |
| **Delete an area** (logged direct members) | **SILENT** | **FREE** | logged/swept members are DETACHED (area→NULL), NOT trashed, umd-silent — a status-dependent refinement to RD-5 (T4) |
| **`set modification date` (the restore lever)** | writes umd directly | — | surgical, sticky, reversible modulo a 1-second resolution floor (T5) |

**So:** deleting and renaming tags is timeline-free and can be done at any volume with zero `changes` noise. The one umd-costly step is **retroactively applying tags** — every tagged item (open OR logged) gets stamped. That is exactly where the **umd-restore recipe** pays off: apply the tag, then knock the umd back to (essentially) its captured value, leaving only the intended tag change and a ≤1-second-lower umd that a `changes --since` query will not surface. Deleting an `(archived)` area is cheap for its logged contents (detached, silent); its open contents get trashed (and umd-bumped, but they're being trashed anyway).

**Structural fact (T6):** neither `TMTag` (`uuid, title, shortcut, usedDate, parent, index, experimental`) nor `TMArea` (`uuid, title, visible, index, cachedTags, experimental`) has a `userModificationDate` column. Tag and area own-row mutations are therefore **structurally incapable** of appearing in a umd-keyed changes timeline; the only way a tag/area op reaches `changes` is through a *member task* umd bump (which, per T2/T3, rename and delete never cause).

---

## T1 — tag apply / remove bumps the member umd (every working surface, open + logged)

Four members held constant: `M-TODO-O` (open to-do), `M-TODO-L` (logged/swept to-do, status 3), `M-PROJ-O` (open project), `M-PROJ-L` (logged project, status 3). Applied then removed the tag `TM-APPLY` via four surfaces; measured umd before/after each leg.

| Surface | apply → member umd | remove → member umd |
|---|---|---|
| **CLI `todo/project tags --set … --vector url-scheme`** | **BUMP** ×4 (all members) | **BUMP** ×4 |
| **CLI `… --vector applescript`** | **BUMP** ×4 | **BUMP** ×4 |
| **raw AS `set tag names of <kind> id X to …`** | **BUMP** ×4 | **BUMP** ×4 |
| **raw URL `things:///update?id=X&tags=…`** | to-dos **BUMP**; **projects SILENT** (no-op) | to-dos **BUMP**; projects SILENT |

**Every surface that actually changes an item's tag set bumps that item's `userModificationDate`** — irrespective of open vs logged, to-do vs project. The tag assignment lives in the separate `TMTaskTag` join table, yet the app still re-stamps the *owning task row*'s umd (and its denormalized `cachedTags` blob) on the change. Logged/swept members are stamped exactly like open ones — so retroactively tagging a Logbook item WILL surface it in `changes`.

**Aside (not a new law):** raw `things:///update?…&tags=` on a **project** uuid is a silent no-op (that URL verb targets to-dos; projects need `update-project`) — hence the two "SILENT" cells, which reflect *no tag change happening*, not a umd exemption. The shipped CLI routes project tag writes through the correct surface (its url-scheme leg bumped, first row), so the CLI is unaffected.

## T2 — tag rename is umd-silent on every member

All four members carried `TM-REN`. Renamed `TM-REN → TM-REN2` via the shipped CLI (`tag update --title`, which compiles AS `set name of tag id`), then `TM-REN2 → TM-REN3` via raw AS `set name of tag`. **Member umd byte-identical in every case** (open + logged, to-do + project), on both surfaces. The tag's own row keeps its `uuid` (assignments survive — E02), and its `usedDate`/`index` are unchanged. Because `TMTaskTag` stores the tag **uuid**, a title change touches no member row at all. Renaming is timeline-free at any volume.

## T3 — tag delete is umd-silent on every member (leaf and subtree)

- **Leaf delete** (`TM-DEL` via CLI `tag delete --dangerously-permanent`, AS `delete tag id`): the `TMTag` row is hard-deleted and its `TMTaskTag` join rows cascade away (confirming A26), but **every member task row's umd is byte-identical** — open + logged, to-do + project.
- **Parent-subtree delete** (`TM-PARENT`, holding child `TM-CHILD`, via CLI `tag delete --dangerously-permanent --acknowledge-subtree`): **both** the parent AND the child `TMTag` rows are hard-deleted, and every member's join rows to either tag are removed — `M-TODO-O` lost its `TM-CHILD` assignment, `M-PROJ-O` lost its `TM-PARENT` assignment — yet **both members' umd stayed byte-identical.**

So deleting a tag (however nested) is a pure join-table + tag-row operation; the member task rows are never stamped. Deleting seldom-used tags is timeline-free.

## T4 — area delete: FK fate is STATUS-DEPENDENT, and only open members are trashed + umd-bumped

Fixture area `TM-AREA` containing: `AP-OPEN` (open project + child `AP-CHILD`), `AP-LOG` (logged project), `AD-OPEN` (area-direct open to-do), `AD-LOG` (area-direct logged to-do). Deleted via CLI `area delete --dangerously-permanent --allow-non-empty` (AS `delete area id`).

| Member | before | after `trashed` | after `area` FK | umd |
|---|---|---|---|---|
| `AD-OPEN` (direct to-do, **open**) | trashed 0 | **1** | cleared (NULL) | **BUMP** (…839.371 → …995.657) |
| `AD-LOG` (direct to-do, **logged**) | trashed 0 | **0** | cleared (NULL) | **SILENT** |
| `AP-OPEN` (project, **open**) | trashed 0 | **1** | cleared (NULL) | **BUMP** (…838.387 → …995.657) |
| `AP-LOG` (project, **logged**) | trashed 0 | **0** | cleared (NULL) | **SILENT** |
| `AP-CHILD` (child of `AP-OPEN`) | trashed 0 | **0** | (project FK intact) | **SILENT** — derived-trash via parent (A24B) |

The `TMArea` row is hard-deleted (confirming A25). **But the trash cascade is status-dependent, refining the documented AREADEL/RD-5 law** (which stated "a direct to-do → `trashed=1`" and "a contained project → `trashed=1` … for BOTH empty + child-bearing" without a status qualifier — that evidence exercised only *open* members):

- **OPEN** direct members (to-do or project) → `trashed=1`, `area` FK cleared, **umd bumped** (trashing is a modification).
- **LOGGED / swept** direct members (status 3) → **NOT trashed** (`trashed=0`), merely **DETACHED** (`area` FK → NULL), **umd-silent**. They stay LIVE in the Logbook, orphaned from the deleted area.
- An open project's child follows A24B unchanged (project FK intact, derived-trashed through the parent).

For the cleanup: deleting an `(archived)` area whose contents are all in the Logbook trashes nothing and stamps nothing — the logged contents simply lose their area. (Scope note: the logged fixtures were completed-AND-swept; the completed-but-*unswept* case was not separately isolated. A dedicated follow-up could split resolved-unswept vs swept, but the maintainer's `(archived)`-area scenario is the swept-logged case measured here.)

## T5 — `set modification date` is a surgical, sticky, reversible umd writer (the restore lever)

AppleScript `set modification date of <to do|project> id X to <datetime>`, exercised on `T5-TODO` (open to-do), `T5-PROJ` (open project), `T5-LOG` (logged to-do). Full-row fingerprints (all `TMTask` columns) captured before/after each step; diffs in `lab/artifacts/tagmod-lab/fp/`.

- **T5a — sticks + surgical.** Setting umd to a past instant (`2025-03-01 09:15:20` = epoch 1740820520) lands exactly on re-read, and the full-row byte-diff shows **ONLY `userModificationDate` changed** — `creationDate`, `stopDate`, `status`, `start*`, everything else byte-identical. True on the to-do, the project, and the logged row.
- **T5b — durable across relaunch.** After `Things3 quit` + relaunch, the past umd is unchanged (1740820520.0). The app does NOT re-stamp it to "now".
- **T5f — forward works.** Setting a future instant (2027) sticks identically.
- **T5c — reversible, modulo 1-second resolution.** Restoring toward the captured value via an epoch→AS-date lands on the **floored second** (e.g. captured …842.**772** → restored …842.**000**); the byte-diff vs pre shows only that sub-second umd delta, nothing else. **The AppleScript `modification date` setter has 1-second resolution — it cannot reproduce the stored sub-second fraction.** The restored umd is therefore always ≤ the original (same integer second at best), which is harmless-to-safe for a `changes --since` query (a lower umd is never *more* likely to surface).
- **T5d — the real restore recipe.** Capture umd → apply a genuine mutation (CLI `todo tags --set`, umd bumps to …3117.774) → restore umd to floor(captured). The full-row byte-diff vs pre shows **only the intended tag change** (`cachedTags` blob) with umd back at the captured second — every other byte identical. The tag persists; the umd bump is neutralized.
- **T5e — restored umd survives unrelated activity.** After a relaunch and writes to *other* rows, the restored umd is unchanged. The app does not opportunistically re-stamp it.

**Recipe (single-device / unsynced only — see the sync caveat):** for a bulk tag apply that must stay out of the timeline, per item: `umd0 = read userModificationDate` → apply the tag → `set modification date … to (epoch floor(umd0))`. Net effect: the tag change persists, umd returns to its original second (never higher), and the row is otherwise byte-identical. Feasible on to-dos, projects, and logged rows alike. This validates a future `update … --preserve-modified`-style option (up-next).

## T6 — tags and areas have no umd column (own-row changes are timeline-invisible)

`pragma_table_info` confirms `TMTag` = `uuid, title, shortcut, usedDate, parent, index, experimental` and `TMArea` = `uuid, title, visible, index, cachedTags, experimental` — **neither carries `userModificationDate`.** A tag rename/delete or area rename/delete cannot bump a tag/area own-row umd because none exists; combined with T2/T3 (member umd silent on rename/delete), tag and area lifecycle ops are entirely absent from a umd-keyed `changes` timeline except when they change a *member's tag set* (T1). `usedDate` on a tag did not move on rename.

## What this settles / feeds

- **The cleanup playbook** (bottom-line table): delete + rename tags freely (timeline-free); the umd cost is concentrated in *applying* tags; area-delete is cheap for logged contents.
- **RD-5 / AREADEL refinement:** area-delete's trash cascade + umd bump is OPEN-member-only; logged members detach umd-silent (oddity below; register RD-5 note).
- **`--preserve-modified` feasibility:** the `set modification date` restore lever is real, surgical, durable, and reversible to the second — a viable engine primitive for a timeline-silent bulk edit, gated behind the sync caveat (up-next follow-up).
