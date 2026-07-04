import type { Baseline } from "../fingerprint.ts";

/**
 * Schema baseline for Meta.databaseVersion = 26.
 * Captured 2026-07-02 from a live Things 3.22.11 library; the fixture DDL
 * (test/fixtures/schema-v26.sql) reproduces this fingerprint exactly
 * (asserted by test/unit/fingerprint.test.ts).
 */
export const DB_V26: Baseline = {
  databaseVersion: 26,
  // Recomputed 2026-07-04 (Phase 10b/10c): manifest gained
  // rt1_instanceCreationPaused (occurrence synthesis) and
  // deadlineSuppressionDate (deadline-driven Today membership); verified
  // identical from the live library and the fixture DDL.
  fingerprint: "sha256:5526059b10ffffe1b67f796d031857d030403bd5b747374646a2803a55c0e5c3",
  knownThingsAppVersions: ["3.22.11"],
};
