import type { Baseline } from "../fingerprint.ts";

import { DB_V29 } from "./db-v29.ts";

/**
 * Schema baseline for Meta.databaseVersion = 30 (Things 3.25).
 *
 * Measured 2026-11-24 in the lab, not on a live library: the GV6 campaign
 * swapped Things 3.24 → 3.25 (direct-download build 32500008) into clock-pinned
 * clones of golden-v5 and golden-v5h, and the first 3.25 launch moved the stamp
 * 29 → 30. Evidence: docs/lab/gv6-325-campaign.md §2.
 *
 * This is the quietest migration the lab has measured. Across the banked
 * pre/post pair:
 *   - the observed fingerprint is BYTE-IDENTICAL to v29 (`sha256:d2b7e98c…`),
 *     with no new extra columns on any depended table;
 *   - the full `sqlite_master` TEXT is byte-identical — not one table, column,
 *     index or trigger was added, removed or rebuilt (contrast 27 → 29, which
 *     added two Spotlight tables and two indexes);
 *   - the DATA is identical on every table, row for row, except the
 *     `Meta.databaseVersion` value itself.
 * The bound, stated honestly: the golden seed is 37 tasks and holds no rows in
 * several tables (TMContact, TMSmartList, TMTombstone), so a migration step
 * that only touches row shapes the seed lacks would not show here. Nothing the
 * engine reads moved on any row the seed does have.
 *
 * `Things.sdef` DID change in 3.25 — for the first time since 3.22.11 — but
 * only by REMOVING two hidden commands (`filter by previous top tag` /
 * `filter by next top tag`) that nothing in this package uses.
 *
 * Per the 2026-08-22 identical-schema ruling (decisions.md; applied to
 * db-v27.ts and db-v29.ts) this baseline reuses the prior hash, and the
 * `accepted-fingerprint` escape hatch is not used. Unlike those two, the
 * behavioral re-certification ran BEFORE this baseline shipped, in the same
 * change (GV6: golden-v6 / -v6h + lab:regress + register walk), because the lab
 * had to recognize the stamp to run its own write gate.
 */
export const DB_V30: Baseline = {
  databaseVersion: 30,
  fingerprint: DB_V29.fingerprint,
  knownThingsAppVersions: ["3.25"],
};
