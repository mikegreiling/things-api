import type { Baseline } from "../fingerprint.ts";

import { DB_V26 } from "./db-v26.ts";

/**
 * Schema baseline for Meta.databaseVersion = 27 (Things 3.23).
 *
 * Captured 2026-08-22 from a live Things 3.23 library: tables, columns, and
 * triggers are byte-identical to v26 (fingerprint equal; every extra column
 * pre-existing), and the migration's DDL delta is INDEX-ONLY — invisible to
 * the fingerprint by design (indexes steer the query planner, not data
 * semantics). The migration DID move data, re-measured in a clock-pinned lab
 * clone and confirmed against a live 3.23 library — docs/lab/gv4-323-campaign.md
 * §2.1–§2.3, which CORRECTS the first host-side reading in
 * docs/lab/dbv27-migration-diff.md:
 *   - `rt1_nextInstanceStartDate` is SCOPED TO TEMPLATES, not retired: nulled on
 *     every non-template row, retained byte-identical on every repeating template
 *     that carried one (live host: 0 of 21,962 non-templates, 73 of 114 templates)
 *     — which is exactly what the new partial index is for. The 3.23 app still
 *     maintains the cache, so `src/model/template-projection.ts` is right to
 *     prefer it and derive only when it is absent.
 *   - the counter move is a `-1` sentinel → computed `0` back-fill on the row
 *     classes that never held a real count (leaf counts on `type=0`, checklist
 *     counts on `type=1`/`type=2`); rows carrying real counts were untouched. It
 *     is NOT a leaf self-count. Consumers that read `-1` as "unknown" now see a
 *     genuine 0.
 *   - the strictly-forward spawn-cursor rewrite did NOT reproduce in the lab
 *     (`rt1_instanceCreationStartDate` byte-unchanged); the host's move is best
 *     explained as cursor catch-up to "now" on first launch, not a schema rewrite.
 * So writes re-enable on this baseline while doctor's passive behavioral notice
 * keeps pointing at the re-certification (drift-runbook steps 2–3: new golden +
 * lab:regress + assumption-register walk) until `certified-app-version` moves
 * to 3.23.
 *
 * The shared fixture DDL (test/fixtures/schema-v26.sql — one file for both
 * generations, the tables being identical) reproduces this fingerprint exactly
 * (asserted by test/unit/fingerprint.test.ts). That fixture stamps
 * `Meta.databaseVersion = 27` and carries the v27 index set; the simulator's
 * `SIMULATED_DATABASE_VERSION` fence is pinned to 27 in lockstep.
 *
 * The hash is DB_V26's by construction — the two versions' depended shape is
 * identical — so a manifest widening (2026-08-23: the template spawn cursor +
 * tally) moves both baselines through the one constant.
 */
export const DB_V27: Baseline = {
  databaseVersion: 27,
  fingerprint: DB_V26.fingerprint,
  knownThingsAppVersions: ["3.23"],
};
