import type { Baseline } from "../fingerprint.ts";

/**
 * Schema baseline for Meta.databaseVersion = 26.
 * Captured 2026-07-02 from a live Things 3.22.11 library; the fixture DDL
 * (test/fixtures/schema-v26.sql) reproduces this fingerprint exactly
 * (asserted by test/unit/fingerprint.test.ts).
 */
export const DB_V26: Baseline = {
  databaseVersion: 26,
  fingerprint: "sha256:e4267e1bd2017d0955cf03fc54409ac6fe7809bdb4509b4e91bfe00518352364",
  knownThingsAppVersions: ["3.22.11"],
};
