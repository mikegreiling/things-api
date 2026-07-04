import type { Baseline } from "../fingerprint.ts";

/**
 * Schema baseline for Meta.databaseVersion = 26.
 * Captured 2026-07-02 from a live Things 3.22.11 library; the fixture DDL
 * (test/fixtures/schema-v26.sql) reproduces this fingerprint exactly
 * (asserted by test/unit/fingerprint.test.ts).
 */
export const DB_V26: Baseline = {
  databaseVersion: 26,
  // Recomputed 2026-07-04 after adding rt1_instanceCreationPaused to the
  // manifest (Phase 10b upcoming-occurrence synthesis); verified identical
  // from the live library and the fixture DDL.
  fingerprint: "sha256:902537feef1a0c96893b077b77e018726830d44cb731ac75f22d2c9b27093709",
  knownThingsAppVersions: ["3.22.11"],
};
