// SIMFID — simulator-fidelity replay suite. Shared host-side types.
//
// SIMFID certifies `src/write/vectors/simulator.ts` against the REAL Things app,
// op by op (docs/lab/probe-backlog.md §C). For each simulator-covered op it
// compares two row-level DB deltas:
//   - the SIM delta: the op replayed on the host through the full write pipeline
//     with the simulator vector, from a synthetic fixture pre-state (real);
//   - the APP delta: the same op driven through the guest CLI against the real
//     app from an IDENTICAL logical pre-state, in a disposable Tart clone
//     (lab/scripts/simfid.sh) OR — for the tier-3 GUI recurrence ops, and until
//     a fresh clone drive re-banks them — transcribed from the banked RSIM probe
//     evidence into lab/simfid/app-golden/*.json (provenance-tagged).
// Both deltas are NORMALIZED (uuids → stable placeholders keyed by (kind, title,
// discovery order); wall-clock timestamps → date buckets; ordering indexes →
// ranks) and compared with declared tolerances for the probe-proven app
// nondeterminism (the per-child instance→template `rt1_repeatingTemplate`
// stamping — RSIM-R C2 / RSIM-S). A residual difference is a divergence the
// suite REPORTS (simulator bug OR newly-discovered app behavior); SIMFID never
// silently edits the appliers.

import type { CellValue, DbDelta } from "../runner/types.ts";

export type { CellValue, DbDelta, DbSnapshot } from "../runner/types.ts";

/** The object kind a placeholder names — derived from the table (+ TMTask.type). */
export type EntityKind = "todo" | "project" | "heading" | "area" | "tag" | "checklist";

/** A row's stable, uuid-free identity in a delta. `placeholder` aligns the two sides. */
export interface Identity {
  kind: EntityKind;
  title: string;
  /** Index within the (kind,title) group after a canonical, uuid/clock-free sort. */
  discoveryOrder: number;
  /** `${kind}:${title}#${discoveryOrder}` — the token uuids map to. */
  placeholder: string;
}

/** A normalized row: real uuids/clocks/indexes replaced by stable tokens. */
export interface NormalizedRow {
  placeholder: string;
  table: string;
  fields: Record<string, CellValue>;
}

export interface NormalizedFieldChange {
  field: string;
  before: CellValue;
  after: CellValue;
}

export interface NormalizedChange {
  placeholder: string;
  table: string;
  fields: NormalizedFieldChange[];
}

/** A delta with every uuid/clock/index normalized; the unit of comparison + the golden shape. */
export interface NormalizedDelta {
  inserted: NormalizedRow[];
  deleted: { placeholder: string; table: string }[];
  changed: NormalizedChange[];
}

/** Per-op comparison outcome. */
export type VerdictKind = "MATCH" | "TOLERATED" | "DIVERGENT";

/** One field-level difference between the sim and app normalized deltas. */
export interface Difference {
  /** insert / delete / change / row-presence. */
  class: "inserted" | "deleted" | "changed" | "row-missing" | "row-extra";
  table: string;
  placeholder: string;
  field?: string;
  sim: CellValue | "—";
  app: CellValue | "—";
  /** Set when a declared tolerance absorbs this difference. */
  tolerated?: string;
  detail: string;
}

export interface OpVerdict {
  verdict: VerdictKind;
  /** Tolerance names that fired (deduped). */
  tolerances: string[];
  /** Every difference (tolerated and not). */
  differences: Difference[];
  /** Human-readable one-liner for the results table. */
  summary: string;
}

/** Where an app-side delta came from — surfaced in the results table for honesty. */
export type Provenance =
  | { source: "clone-drive"; runId: string; note?: string }
  | { source: "rsim-evidence"; ref: string; note?: string }
  | { source: "suite-evidence"; ref: string; note?: string };

/** A checked-in golden app delta (normalized) with its provenance. */
export interface AppGolden {
  caseId: string;
  op: string;
  provenance: Provenance;
  delta: NormalizedDelta;
}

/** The raw (un-normalized) delta plus the snapshots it was diffed from. */
export interface RawCapture {
  before: import("../runner/types.ts").DbSnapshot;
  after: import("../runner/types.ts").DbSnapshot;
  delta: DbDelta;
}
