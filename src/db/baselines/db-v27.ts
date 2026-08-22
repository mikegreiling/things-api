import type { Baseline } from "../fingerprint.ts";

import { DB_V26 } from "./db-v26.ts";

/**
 * Schema baseline for Meta.databaseVersion = 27 (Things 3.23).
 *
 * Captured 2026-08-22 from a live Things 3.23 library: tables, columns, and
 * triggers are byte-identical to v26 (fingerprint equal; every extra column
 * pre-existing), and the migration's DDL delta is INDEX-ONLY — invisible to
 * the fingerprint by design (indexes steer the query planner, not data
 * semantics). The measured migration (docs/lab/dbv27-migration-diff.md) also
 * rewrote data: `rt1_nextInstanceStartDate` retired (nulled library-wide),
 * leaf-action counters now self-counting on to-dos, spawn cursors re-anchored
 * forward — so writes re-enable on this baseline while doctor's passive
 * behavioral notice keeps pointing at the re-certification (drift-runbook
 * steps 2–3: new golden + lab:regress + assumption-register walk) until
 * `certified-app-version` moves to 3.23.
 *
 * The v26 fixture DDL (test/fixtures/schema-v26.sql) reproduces this
 * fingerprint exactly (asserted by test/unit/fingerprint.test.ts).
 */
export const DB_V27: Baseline = {
  databaseVersion: 27,
  fingerprint: DB_V26.fingerprint,
  knownThingsAppVersions: ["3.23"],
};
