import type { Baseline } from "../fingerprint.ts";

import { DB_V26 } from "./db-v26.ts";

/**
 * Schema baseline for Meta.databaseVersion = 27 (Things 3.23).
 *
 * Captured 2026-08-22 from a live Things 3.23 library: the app bumped the
 * version stamp 26 → 27 with a BYTE-IDENTICAL schema — the observed
 * fingerprint equals the v26 baseline's, and every observed extra column
 * already exists in the v26 atlas/fixture, so no DDL moved anywhere (modeled
 * or unmodeled). A version bump without a schema delta marks an app-internal
 * (data/behavioral) migration: writes re-enable on this baseline, while
 * doctor's passive behavioral notice keeps pointing at the re-certification
 * (drift-runbook steps 2–3: new golden + lab:regress + assumption-register
 * walk) until `certified-app-version` moves to 3.23.
 *
 * The v26 fixture DDL (test/fixtures/schema-v26.sql) reproduces this
 * fingerprint exactly (asserted by test/unit/fingerprint.test.ts).
 */
export const DB_V27: Baseline = {
  databaseVersion: 27,
  fingerprint: DB_V26.fingerprint,
  knownThingsAppVersions: ["3.23"],
};
