import type { Baseline } from "../fingerprint.ts";

/**
 * Schema baseline for Meta.databaseVersion = 26.
 * Captured 2026-07-02 from a live Things 3.22.11 library; the fixture DDL
 * (test/fixtures/schema-v26.sql) reproduces this fingerprint exactly
 * (asserted by test/unit/fingerprint.test.ts).
 */
export const DB_V26: Baseline = {
  databaseVersion: 26,
  // Recomputed 2026-08-23: manifest gained TMTask.rt1_instanceCreationStartDate
  // and TMTask.rt1_instanceCreationCount (the spawn cursor + tally the
  // projection-day helper reads — src/db/schema.ts says why); both columns are
  // pre-existing in v26 and v27 alike, so this is a manifest widening, not a
  // schema change, and DB_V27 shares the constant.
  // Prior (2026-07-10 — TMSettings.logInterval + TMSettings.manualLogDate):
  //   sha256:784bd2f6533e6f85e053b0ec68958083d4ebca11c152ad1d2935178240d4c52b
  // Prior (2026-07-04, Phase 10b/10c — rt1_instanceCreationPaused +
  // deadlineSuppressionDate):
  //   sha256:5526059b10ffffe1b67f796d031857d030403bd5b747374646a2803a55c0e5c3
  fingerprint: "sha256:d2b7e98c6d384ef1ecd256b1410a11652e80c5860cc48370ec9b4d6956c7d4df",
  // Things 3.22.12 (build 32212016) ships the IDENTICAL DB v26 schema (fingerprint
  // byte-identical) and an identical Things.sdef — a behavioral-only update, re-certified
  // 2026-08-03 against golden-v2 (drift-runbook step 3; assumption-register *Confirmed under*).
  knownThingsAppVersions: ["3.22.11", "3.22.12"],
};
