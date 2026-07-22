// SIMFID comparator: two NORMALIZED deltas (sim vs app) → an OpVerdict of
// MATCH / TOLERATED(<which>) / DIVERGENT(<detail>). Every field-level difference
// is checked against the declared tolerances (tolerances.ts); a difference no
// tolerance absorbs is a divergence the suite REPORTS — a simulator bug OR
// newly-discovered app behavior. SIMFID never edits the appliers.

import { matchTolerance } from "./tolerances.ts";
import type {
  CellValue,
  Difference,
  NormalizedChange,
  NormalizedDelta,
  NormalizedRow,
  OpVerdict,
} from "./types.ts";

/** Membership key for a (table, placeholder) pair. Tab-separated — never split back. */
const rowKey = (table: string, placeholder: string): string => `${table}\t${placeholder}`;

/** Merge sim+app normalized field views for a row (app wins; sim fills gaps). */
function mergeFields(
  sim: Record<string, CellValue> | undefined,
  app: Record<string, CellValue> | undefined,
): Record<string, CellValue> {
  return { ...sim, ...app };
}

const fmt = (v: CellValue | "—"): string => (v === null ? "null" : String(v));

function pushFieldDiff(
  diffs: Difference[],
  cls: Difference["class"],
  table: string,
  placeholder: string,
  field: string,
  sim: CellValue | "—",
  app: CellValue | "—",
  rowFields: Record<string, CellValue>,
): void {
  if (sim === app) return;
  const tol = matchTolerance({ table, placeholder, field, sim, app, rowFields });
  diffs.push({
    class: cls,
    table,
    placeholder,
    field,
    sim,
    app,
    ...(tol !== null ? { tolerated: tol.name } : {}),
    detail: `${field}: sim=${fmt(sim)} app=${fmt(app)}${tol !== null ? ` [${tol.name}]` : ""}`,
  });
}

function compareInserted(sim: NormalizedDelta, app: NormalizedDelta, diffs: Difference[]): void {
  const simMap = new Map(sim.inserted.map((r) => [rowKey(r.table, r.placeholder), r]));
  const appMap = new Map(app.inserted.map((r) => [rowKey(r.table, r.placeholder), r]));
  const keys = new Set([...simMap.keys(), ...appMap.keys()]);
  for (const key of [...keys].toSorted()) {
    const s = simMap.get(key);
    const a = appMap.get(key);
    const row = (s ?? a) as NormalizedRow;
    const merged = mergeFields(s?.fields, a?.fields);
    if (s === undefined || a === undefined) {
      // A row inserted on one side only — a presence difference the suite reports.
      diffs.push({
        class: s === undefined ? "row-missing" : "row-extra",
        table: row.table,
        placeholder: row.placeholder,
        sim: s === undefined ? "—" : "present",
        app: a === undefined ? "—" : "present",
        detail:
          s === undefined
            ? `row inserted by APP only: ${row.table} ${row.placeholder}`
            : `row inserted by SIM only: ${row.table} ${row.placeholder}`,
      });
      continue;
    }
    const fields = new Set([...Object.keys(s.fields), ...Object.keys(a.fields)]);
    for (const field of [...fields].toSorted()) {
      pushFieldDiff(
        diffs,
        "inserted",
        row.table,
        row.placeholder,
        field,
        s.fields[field] ?? null,
        a.fields[field] ?? null,
        merged,
      );
    }
  }
}

function compareChanged(sim: NormalizedDelta, app: NormalizedDelta, diffs: Difference[]): void {
  const simMap = new Map(sim.changed.map((r) => [rowKey(r.table, r.placeholder), r]));
  const appMap = new Map(app.changed.map((r) => [rowKey(r.table, r.placeholder), r]));
  const keys = new Set([...simMap.keys(), ...appMap.keys()]);
  for (const key of [...keys].toSorted()) {
    const s = simMap.get(key);
    const a = appMap.get(key);
    const row = (s ?? a) as NormalizedChange;
    if (s === undefined || a === undefined) {
      diffs.push({
        class: s === undefined ? "row-missing" : "row-extra",
        table: row.table,
        placeholder: row.placeholder,
        sim: s === undefined ? "—" : "changed",
        app: a === undefined ? "—" : "changed",
        detail:
          s === undefined
            ? `row changed by APP only: ${row.table} ${row.placeholder}`
            : `row changed by SIM only: ${row.table} ${row.placeholder}`,
      });
      continue;
    }
    const simAfter = new Map(s.fields.map((f) => [f.field, f.after]));
    const appAfter = new Map(a.fields.map((f) => [f.field, f.after]));
    const merged = mergeFields(Object.fromEntries(simAfter), Object.fromEntries(appAfter));
    const fields = new Set([...simAfter.keys(), ...appAfter.keys()]);
    for (const field of [...fields].toSorted()) {
      // A field changed on one side only → the other side's after-value is its
      // (unchanged) value, which we do not have here; treat absence as "—".
      pushFieldDiff(
        diffs,
        "changed",
        row.table,
        row.placeholder,
        field,
        simAfter.has(field) ? (simAfter.get(field) ?? null) : "—",
        appAfter.has(field) ? (appAfter.get(field) ?? null) : "—",
        merged,
      );
    }
  }
}

function compareDeleted(sim: NormalizedDelta, app: NormalizedDelta, diffs: Difference[]): void {
  const simMap = new Map(sim.deleted.map((r) => [rowKey(r.table, r.placeholder), r]));
  const appMap = new Map(app.deleted.map((r) => [rowKey(r.table, r.placeholder), r]));
  const keys = new Set([...simMap.keys(), ...appMap.keys()]);
  for (const key of [...keys].toSorted()) {
    const s = simMap.get(key);
    const a = appMap.get(key);
    if ((s === undefined) === (a === undefined)) continue; // both deleted, or neither → agree
    const row = (s ?? a)!;
    diffs.push({
      class: s !== undefined ? "row-extra" : "row-missing",
      table: row.table,
      placeholder: row.placeholder,
      sim: s !== undefined ? "deleted" : "—",
      app: a !== undefined ? "deleted" : "—",
      detail:
        s !== undefined
          ? `row deleted by SIM only: ${row.table} ${row.placeholder}`
          : `row deleted by APP only: ${row.table} ${row.placeholder}`,
    });
  }
}

export function compareDeltas(sim: NormalizedDelta, app: NormalizedDelta): OpVerdict {
  const differences: Difference[] = [];
  compareInserted(sim, app, differences);
  compareChanged(sim, app, differences);
  compareDeleted(sim, app, differences);

  const untolerated = differences.filter((d) => d.tolerated === undefined);
  const tolerances = [
    ...new Set(differences.map((d) => d.tolerated).filter((t): t is string => t !== undefined)),
  ];

  let verdict: OpVerdict["verdict"];
  let summary: string;
  if (differences.length === 0) {
    verdict = "MATCH";
    summary = "MATCH";
  } else if (untolerated.length === 0) {
    verdict = "TOLERATED";
    summary = `TOLERATED(${tolerances.join(", ")})`;
  } else {
    verdict = "DIVERGENT";
    const heads = untolerated.slice(0, 3).map((d) => d.detail);
    summary = `DIVERGENT(${heads.join("; ")}${untolerated.length > 3 ? `; +${untolerated.length - 3} more` : ""})`;
  }
  return { verdict, tolerances, differences, summary };
}
