import type { Baseline } from "../fingerprint.ts";

/**
 * Schema baseline for Meta.databaseVersion = 26.
 * Captured 2026-07-02 from a live Things 3.22.11 library; the fixture DDL
 * (test/fixtures/schema-v26.sql) reproduces this fingerprint exactly
 * (asserted by test/unit/fingerprint.test.ts).
 */
export const DB_V26: Baseline = {
  databaseVersion: 26,
  // Recomputed 2026-07-10: manifest gained TMSettings.logInterval and
  // TMSettings.manualLogDate (the log-move boundary — completion ≠ logged);
  // verified identical from the live library (doctor) and the fixture DDL.
  // Prior (2026-07-04, Phase 10b/10c — rt1_instanceCreationPaused +
  // deadlineSuppressionDate):
  //   sha256:5526059b10ffffe1b67f796d031857d030403bd5b747374646a2803a55c0e5c3
  fingerprint: "sha256:784bd2f6533e6f85e053b0ec68958083d4ebca11c152ad1d2935178240d4c52b",
  knownThingsAppVersions: ["3.22.11"],
};
