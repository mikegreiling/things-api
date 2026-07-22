// SIMFID declared tolerances — the probe-proven app nondeterminism that must NOT
// count as a fidelity failure. Each is a named predicate over a single field
// difference plus the row's merged (sim∪app) normalized fields, so a tolerance
// can tell, e.g., a subtree CHILD row from the top-level instance row.
//
// Adding a tolerance is a deliberate act: it declares "the real app is
// nondeterministic here (evidence ref), so present-or-absent both pass." Never
// add one to paper over a genuine applier divergence — that is a DIVERGENT the
// suite must report.

import type { CellValue } from "./types.ts";

export interface ToleranceContext {
  table: string;
  placeholder: string;
  field: string;
  sim: CellValue | "—";
  app: CellValue | "—";
  /** The row's merged normalized fields (app wins; sim fills gaps) — role context. */
  rowFields: Record<string, CellValue>;
}

export interface Tolerance {
  name: string;
  /** Probe evidence that justifies tolerating this. */
  evidence: string;
  applies(ctx: ToleranceContext): boolean;
}

const isTemplatePlaceholder = (v: CellValue | "—"): boolean =>
  typeof v === "string" && (v.startsWith("project:") || v.startsWith("todo:"));

/** Whether the row is an INSTANCE (carries a template back-link) — not a plain child. */
const rowIsInstance = (f: Record<string, CellValue>): boolean =>
  f["rt1_repeatingTemplate"] !== null && f["rt1_repeatingTemplate"] !== undefined;

/** Whether the row is a subtree CHILD (filed under a project/heading). */
const rowIsChild = (f: Record<string, CellValue>): boolean =>
  (f["project"] !== null && f["project"] !== undefined) ||
  (f["heading"] !== null && f["heading"] !== undefined);

export const TOLERANCES: Tolerance[] = [
  {
    // The headline tolerance. RSIM-R C2 / RSIM-S S1d: at BOTH convert and
    // next-occurrence spawn, the app stamps a per-child instance→template
    // `rt1_repeatingTemplate` link on a NONDETERMINISTIC subset of subtree
    // children (6/7, 5/7, 6/6 across consecutive spawns of one series; headings
    // never linked). The simulator emits PLAIN instance-side children (link
    // absent). So on a subtree CHILD row, this field being present on one side
    // and absent on the other is expected — never assert it.
    name: "rt1-child-backlink",
    evidence: "RSIM-R C2 / RSIM-S S1d (docs/lab/rsim-results.md)",
    applies(ctx) {
      if (ctx.field !== "rt1_repeatingTemplate") return false;
      if (!rowIsChild(ctx.rowFields)) return false; // only subtree children, not the top-level instance
      const oneNull = ctx.sim === null || ctx.app === null;
      const oneTemplate = isTemplatePlaceholder(ctx.sim) || isTemplatePlaceholder(ctx.app);
      return oneNull && oneTemplate;
    },
  },
  {
    // RSIM: a minted INSTANCE row carries a junk uninitialized
    // `rt1_nextInstanceStartDate=69760` sentinel; only the TEMPLATE's next-date
    // drives generation. The simulator leaves the instance's value NULL/0.
    // Ignore this column's value on any instance row.
    name: "instance-next-sentinel",
    evidence: "RSIM (docs/lab/rsim-results.md — instance junk next=69760)",
    applies(ctx) {
      return ctx.field === "rt1_nextInstanceStartDate" && rowIsInstance(ctx.rowFields);
    },
  },
  {
    // Ordering indexes are compared as ranks; a residual rank difference (the app
    // assigns real list positions, the simulator hardcodes 0) is not a fidelity
    // fact. Normalization already ranks inserts / masks changes; this absorbs any
    // remainder.
    name: "index-rank",
    evidence: "SIMFID spec (indexes compared as ranks)",
    applies(ctx) {
      return ctx.field === "index" || ctx.field === "todayIndex";
    },
  },
  {
    // Creation/modification/stop timestamps are bucketed to the local date, not
    // compared exactly (the app backdates a minted instance to occurrence
    // midnight; the simulator stamps write-time — same pinned day, different
    // seconds). Absorb any residual bucket difference.
    name: "wallclock-bucket",
    evidence: "SIMFID spec (timestamps bucketed, not exact)",
    applies(ctx) {
      return (
        ctx.field === "creationDate" ||
        ctx.field === "userModificationDate" ||
        ctx.field === "stopDate"
      );
    },
  },
];

/** The first tolerance that absorbs this difference, or null. */
export function matchTolerance(ctx: ToleranceContext): Tolerance | null {
  return TOLERANCES.find((t) => t.applies(ctx)) ?? null;
}
