# TOMB1 — TMTombstone lifecycle

Run `things-run-tomb1-20260726-215611` (`lab/scripts/research-tomb1.sh`). Answers **atlas [schema-v26.md](../atlas/schema-v26.md) open-question 5** and the gating question for the **`changes --since` deletion-visibility feature** ([up-next.md](../up-next.md) §6, from the task-API-landscape study): *when does a `TMTombstone` row appear, and is `deletionDate` trustworthy as a `--since` cursor?*

**Environment.** things-lab-golden-v1 · Things 3.22.11 · macOS 15.7 guest · DB schema v26. Networked phases run on the **PINNED clock 2026-07-05** (the golden's 15-day trial, first-launched 2026-07-03, is EXPIRED at real time ~2026-07-18; under the pinned clock it reads "13 days left" and Things Cloud is fully reachable — the SYNCLAT recipe; NTP-ing to real time trips a STICKY "Trial Period Has Ended" read-only modal). Throwaway Things Cloud account (mail.tm + random password, no Apple ID); creds in the gitignored run dir; **account BURNED afterward** (Syncrony `DELETE` → 202, re-DELETE → 404 confirmed).

## Headline verdict

**A `TMTombstone` row is written if and ONLY if the deleted row carried `leavesTombstone = 1`.** That flag is set only on **repeating-template lineage** (the hidden template row + its spawned instances) — it is **NEVER** set on an ordinary user to-do, project, or checklist item, and attaching/using a Things Cloud account does not flip it. Therefore:

- **Ordinary deletions leave NO tombstone** — proven for both the local deleter (every delete path, sync on and off) AND the remote receiver (a device that pulls down and *applies* a remote hard-delete removes the row with **zero** tombstone written).
- **Repeating-lineage deletions DO tombstone** — deleting a `leavesTombstone=1` repeating instance wrote exactly one `TMTombstone` row (a plain control to-do deleted in the *same* empty-trash wrote none).
- **`deletionDate` is a trustworthy epoch** (Unix seconds REAL = the deleter's wall-clock at delete time) — but it only exists for the narrow tombstoned population.

**`TMTombstone` is NOT a general deletion log.** It records repeating-template lineage churn, not the deletions a mirror-keeping consumer cares about. See the **BUILD/DON'T-BUILD** call at the bottom.

## Schema (confirmed)

`CREATE TABLE 'TMTombstone' ('uuid' TEXT PRIMARY KEY, 'deletionDate' REAL, 'deletedObjectUUID' TEXT)`. No title, no type — a tombstone is intentionally content-free (uuid + when). `TMArea` has **no** `leavesTombstone` column at all.

## Phase 0 — AIRGAP CONTROL (no account, pinned clock)

Reconfirms + **extends** A25/A27 (a-suite §5) across every delete path. `BSSyncronyMetadata`=0 (no account). Every probe: `TMTombstone` stays **0**; the deleted row's `leavesTombstone` never flips (it was 0 and stays 0). All targets here were ordinary `leavesTombstone=0` items.

| Probe | Delete path (AppleScript unless noted) | Row outcome | `TMTombstone` |
|---|---|---|---|
| TOMB1-a | to-do → trash | `trashed=1`, links intact | **0** |
| TOMB1-b | empty trash (hard delete) | row gone | **0** |
| TOMB1-c | project trash + empty | project `trashed=1` **shallow** (child keeps `trashed=0`); both hard-deleted on empty | **0** |
| TOMB1-d | area delete | `TMArea` **hard-deleted immediately**; child `trashed=1` | **0** |
| TOMB1-e | checklist-item delete via URL `update` list-rewrite | item row hard-deleted | **0** |
| TOMB1-6 | relaunch | — | **0** (nothing appears retroactively) |

**`leavesTombstone` is not a delete marker.** The golden's four `leavesTombstone=1` rows are all **repeating** lineage (the `LAB-REPEAT-WEEKLY-PROJ` template + 3 `LAB-REPEAT-DAILY` instances); the actually-trashed rows (`LAB-TRASH-ME`, `L5-CONSENT-PROJ`) are `leavesTombstone=0`. Deleting a row never flips its own `leavesTombstone`.

**S-delperm was sync-OFF (2f answered).** The golden is `thingsCloudDeclined:true` / `BSSyncronyMetadata`=0. The Shortcuts "Delete Immediately" hard-delete leaving no tombstone (oddities §5i) is **not Shortcuts-specific** — it is the universal `leavesTombstone=0` behavior every delete path shows. The phase-1 reprobe confirms it holds under an account too.

## Phase 1 — ACCOUNT ATTACHED, single clone (local deletes)

Account created in-VM (`BSSyncronyMetadata` 0→11, sync working, trial valid). Re-ran the whole delete matrix under an actively-syncing account — every ordinary (`leavesTombstone=0`) local delete still produced **zero** tombstones (trash, empty-trash, project trash+empty, area delete, checklist-item edit-delete, and persisting 0 across relaunch). **Attaching an account changes nothing for an ordinary delete.**

## Phase 2 — REMOTE deletion, two clones (A=observer, B=deleter)

Both clones on one account, merge=keep-cloud (each synced down 33 LAB items, `BSSyncronyMetadata`=12). **TEST 1** (the clean one): B created `TOMB-REMOTE-NEW` (a plain `leavesTombstone=0` to-do), it propagated to A in ~8 s (forced pull via `things:///show?id=`), then B hard-deleted it (trash+empty). After A's relaunch forced a full sync, **A had genuinely applied the deletion — the row was gone from A (`UB_present=0`) — yet A's `TMTombstone` stayed 0.** So *receiving and applying a remote hard-delete of an ordinary item writes no tombstone on the receiver*. (Deletions still propagate correctly — via the Syncrony change-log, not `TMTombstone`.)

*Caveats:* APNs is unavailable in the VM, so the observer only pulls on `things:///show` / relaunch, not spontaneously (the relaunch is the reliable observation point). **TEST 2** (delete a pre-existing seed) was **void** — the AppleScript selector `delete to do (first to do whose name is …)` errored `-1700`; use `delete to do "TITLE"` (fixed in the script). No remote-delete of a `leavesTombstone=1` row was measured (see follow-up).

## Phase 3 — the `leavesTombstone` GATE (ARM 7, single account clone)

The decisive test. On one account clone, deleted a `leavesTombstone=1` **repeating instance** and a plain `leavesTombstone=0` control **in the same empty-trash**:

| Deleted row | `leavesTombstone` | `TMTombstone` after delete | `deletionDate` |
|---|---|---|---|
| repeating instance `LAB-REPEAT-DAILY` | 1 | **1 row written** | `1783252895.6` = **Jul 5 12:01:35 pinned wall-clock** (the deleter's clock at delete time) |
| control `ARM7-PLAIN` to-do | 0 | **none** | — |

The tombstone appeared on a **local** delete (single clone), persisted across relaunch, and carried a real epoch `deletionDate`. This nails the gate: **`leavesTombstone` — not sync direction — decides whether a tombstone is written.**

## Answers to the campaign questions

- **When does a tombstone appear?** On deletion of a row with `leavesTombstone=1` (repeating-template lineage). Never for ordinary to-dos/projects/areas/checklist items, on any device, sync on or off.
- **Which delete paths?** Irrelevant — the gate is the *row's* `leavesTombstone`, not the path. Trash-vs-empty-trash-vs-remote all behave the same for a given row.
- **Is `deletionDate` trustworthy as a `--since` cursor?** The *value* is trustworthy (real Unix-seconds wall-clock of the delete). The *population* is not — the table only ever contains repeating-lineage deletions.
- **Is the picture "delete → tombstone with reliable deletionDate"?** No. It is "delete-of-a-repeating-lineage-row → tombstone; delete-of-anything-else → nothing."

## BUILD / DON'T-BUILD — `changes --since` deletion visibility

**DON'T BUILD `changeKind:"deleted"` on top of `TMTombstone`.** It would surface only the churn of repeating-template instances and would **silently miss every ordinary user deletion** (the exact events a mirror-keeping consumer needs). A deletion feed that reports repeating-instance retirements while dropping "user deleted this project" is worse than none — it looks complete but is systematically biased. `deletionDate` being a sound timestamp does not rescue it; the row *membership* is the wrong set.

**Honest degradation is the right move:** the changes feed should state that deletions are **not reliably trackable from the local database** (only repeating-lineage deletions leave a record) rather than emit a partial `@removed` stream. If deletion tracking is ever truly needed, the viable foundations are **(a)** a snapshot-diff of a scoped member set (uuid-set diff between polls — exactly what the §6 `watch` mode already needs, and it catches ALL deletions within its scope), or **(b)** the Syncrony server-side change-log, which is not locally queryable. Fold this verdict into the §6 landscape item and the watcher design.

## Follow-ups (not blocking; queue as TOMB2 if deletion-tracking is ever revived)

1. **What else sets `leavesTombstone=1`?** Only repeating lineage was observed; whether any ordinary item ever acquires it (e.g., after some sync/lifecycle milestone) is unmapped. If ordinary items never get it, the DON'T-BUILD is absolute.
2. **Production ground-truth (READ-ONLY).** A single `scripts/prod-read.sh` pass on Mike's long-lived multi-device library would confirm the real `TMTombstone` population is repeating-dominated (object types + `deletionDate` span). Must use the ONE stable prod-read command shape — no ad-hoc query shapes (consent rail).
3. **Remote delete of a `leavesTombstone=1` row** (TEST 2 was void) — expected to tombstone on both ends by the gate, but unmeasured.

**Artifacts:** `lab/artifacts/things-run-tomb1-20260726-215611/` (gitignored) — account-creation + login screenshots, `final-A.sqlite` (phase 1), `arm5-final-{A,B}.sqlite` (phase 2), `arm7-final.sqlite` (phase 3), `report.txt`.
