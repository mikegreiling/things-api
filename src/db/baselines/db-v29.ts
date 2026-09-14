import type { Baseline } from "../fingerprint.ts";

import { DB_V27 } from "./db-v27.ts";

/**
 * Schema baseline for Meta.databaseVersion = 29 (Things 3.24).
 *
 * Captured 2026-09-14 from the maintainer's live Things 3.24 library (MAS build
 * 32400506, macOS 27.0), read-only through the deputy's sql facade. The stamp
 * jumped 27 → 29 in ONE hop — a "28" was never observed on this host, the prior
 * install having been 3.23.4 (databaseVersion 27) — and the observed fingerprint
 * is BYTE-IDENTICAL to the v27 baseline (`sha256:d2b7e98c…`), with no new extra
 * columns beyond the set v26/v27 already carried. Evidence:
 * docs/lab/dbv29-migration-diff.md.
 *
 * The migration's DDL delta is TWO NEW TABLES plus TWO NEW INDEXES, all of it
 * Spotlight-index plumbing and all of it outside the depended-table manifest, so
 * the fingerprint ignores it by design:
 *   - `BSSpotlightDirtyEntity` (+ its partial `expansionCursor` index) and
 *     `BSSpotlightIndexState` — plausibly the dirty-tracking and checkpoint state
 *     for the 3.24 Spotlight semantic index (the release notes' "Full integration
 *     with Spotlight").
 *   - `index_TMTask_userModificationDate ON TMTask(userModificationDate)` — a new
 *     index over a column the engine already depends on; the column itself did
 *     not move.
 * Every existing table, column and trigger is byte-identical to the v27 capture.
 * `Things.sdef` is byte-identical too (unchanged since 3.22.11), so 3.24 carries
 * zero scripting-dictionary surface delta.
 *
 * Per the 2026-08-22 identical-schema ruling (decisions.md; first applied to
 * db-v27.ts) this baseline ships same-day reusing the prior hash — writes
 * re-enable honestly, the schema gate measures DDL and none of the depended DDL
 * moved — while doctor's passive behavioral notice keeps pointing at the
 * re-certification (drift-runbook steps 2–3: golden-v5 + lab:regress + register
 * walk) until `certified-app-version` moves to 3.24.
 *
 * The DATA half is measured too, and is quieter still: across the banked pre/post
 * pair the ONLY mass change is `rt1_instanceCreationStartDate`, moved strictly
 * forward on 96 of 128 repeating templates — the same first-launch spawn-cursor
 * catch-up DBV27 saw and GV4 §2.3 showed does not reproduce in a clock-pinned
 * migration. Every other column changed on 8 rows or fewer (organic edits; the
 * pre snapshot is three days old, so some noise is unavoidable).
 * `userModificationDate` was NOT rewritten — the new index was built over the
 * existing values — and no `-1` counter sentinels remain. A clean, clock-pinned
 * re-measurement rides the golden-v5 in-lab swap and supersedes it.
 *
 * The shared fixture DDL (test/fixtures/schema-v26.sql — ONE file for 26, 27 and
 * 29, the tables being identical) reproduces this fingerprint exactly (asserted
 * by test/unit/fingerprint.test.ts). That fixture now stamps
 * `Meta.databaseVersion = 29` and carries the v29 index/table set; the
 * simulator's `SIMULATED_DATABASE_VERSION` fence is pinned to 29 in lockstep.
 */
export const DB_V29: Baseline = {
  databaseVersion: 29,
  fingerprint: DB_V27.fingerprint,
  knownThingsAppVersions: ["3.24"],
};
