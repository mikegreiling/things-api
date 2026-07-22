// SIMFID normalizer. Turns a raw row-level delta (real uuids, wall-clock epochs,
// concrete list indexes) into a NormalizedDelta whose identities are stable
// across the two capture sides (host simulator vs real app), so a field-by-field
// comparison is meaningful:
//
//   - UUIDs → placeholders keyed by (kind, title, discovery order). Discovery
//     order is a CONTAINER-AWARE canonical sort (a template project and its
//     instance are distinguished by their rule/template columns; children by
//     their resolved container placeholder), so the same logical row lands on
//     the same placeholder on both sides even when titles collide (the
//     make-repeating template/instance duplication is exactly this case).
//   - Wall-clock epoch columns (creationDate/userModificationDate/stopDate) →
//     local-DATE buckets (the app backdates a minted instance to occurrence
//     midnight while the simulator stamps write-time; both fall on the pinned
//     day, so a bucket matches while an exact-epoch compare would not).
//   - Ordering indexes (index/todayIndex) → ranks (inserted rows) or a masked
//     token (changed rows): the app assigns real list positions, the simulator
//     hardcodes 0 — only the relative order is a fidelity fact.

import type {
  CellValue,
  DbDelta,
  DbSnapshot,
  EntityKind,
  Identity,
  NormalizedChange,
  NormalizedDelta,
  NormalizedRow,
} from "./types.ts";

/** FK columns whose cell value is a uuid to be re-pointed at a placeholder. */
const FK_COLUMNS = new Set([
  "area",
  "project",
  "heading",
  "rt1_repeatingTemplate",
  "task", // TMChecklistItem.task
  "parent", // TMTag.parent
  "tasks", // TMTaskTag.tasks
  "tags", // TMTaskTag.tags / TMAreaTag.tags
  "areas", // TMAreaTag.areas
]);

/** Free-running wall-clock epoch columns → date buckets, not exact seconds. */
const WALLCLOCK_COLUMNS = new Set(["creationDate", "userModificationDate", "stopDate"]);

/** List-order columns → ranks. */
const INDEX_COLUMNS = new Set(["index", "todayIndex"]);

const KIND_DEPTH: Record<EntityKind, number> = {
  area: 0,
  tag: 0,
  project: 1,
  heading: 2,
  todo: 3,
  checklist: 4,
};

function taskKind(type: CellValue): EntityKind {
  return type === 1 ? "project" : type === 2 ? "heading" : "todo";
}

interface RawRow {
  uuid: string;
  kind: EntityKind;
  title: string;
  fields: Record<string, CellValue>;
}

/** Collect identity-bearing rows from before∪after (after wins for a changed row). */
function collectRows(before: DbSnapshot, after: DbSnapshot): RawRow[] {
  const byUuid = new Map<string, RawRow>();
  const ingest = (snap: DbSnapshot, preferNew: boolean): void => {
    for (const [table, rows] of Object.entries(snap)) {
      if (table === "TMTaskTag" || table === "TMAreaTag") continue; // join rows carry no identity
      for (const [uuid, fields] of Object.entries(rows)) {
        if (byUuid.has(uuid) && !preferNew) continue;
        let kind: EntityKind;
        let title: string;
        if (table === "TMTask") kind = taskKind(fields["type"] ?? null);
        else if (table === "TMArea") kind = "area";
        else if (table === "TMTag") kind = "tag";
        else if (table === "TMChecklistItem") kind = "checklist";
        else continue;
        title = typeof fields["title"] === "string" ? fields["title"] : "";
        byUuid.set(uuid, { uuid, kind, title, fields });
      }
    }
  };
  ingest(before, false);
  ingest(after, true); // after-state fields win (post-mutation identity)
  return [...byUuid.values()];
}

/** A canonical, uuid/clock-free signature for intra-(kind,title) ordering. */
function signature(row: RawRow, placeholderOf: (uuid: string) => string): string {
  const f = row.fields;
  const has = (k: string): string => (f[k] === null || f[k] === undefined ? "0" : "1");
  const ref = (k: string): string => {
    const v = f[k];
    return typeof v === "string" ? placeholderOf(v) : "_";
  };
  switch (row.kind) {
    case "area":
      return `v${f["visible"] ?? "_"}`;
    case "tag":
      return `p${ref("parent")}`;
    case "project":
      return `rule${has("rt1_recurrenceRule")}|tmpl${has("rt1_repeatingTemplate")}|area${ref("area")}|start${f["start"] ?? "_"}|sd${f["startDate"] ?? "_"}`;
    case "heading":
      return `proj${ref("project")}|start${f["start"] ?? "_"}`;
    case "todo":
      return (
        `rule${has("rt1_recurrenceRule")}|tmpl${has("rt1_repeatingTemplate")}|` +
        `proj${ref("project")}|head${ref("heading")}|area${ref("area")}|` +
        `start${f["start"] ?? "_"}|sd${f["startDate"] ?? "_"}|dl${f["deadline"] ?? "_"}|status${f["status"] ?? "_"}`
      );
    case "checklist":
      return `task${ref("task")}|status${f["status"] ?? "_"}`;
  }
}

/**
 * Build uuid → Identity for every identity-bearing row in before∪after. Kinds
 * are processed shallow-to-deep so a row's signature can reference the already-
 * assigned placeholders of its (strictly shallower) container FKs.
 */
export function buildIdentityMap(before: DbSnapshot, after: DbSnapshot): Map<string, Identity> {
  const rows = collectRows(before, after);
  const map = new Map<string, Identity>();
  const placeholderOf = (uuid: string): string => map.get(uuid)?.placeholder ?? "?";

  const kindsByDepth = ([...new Set(rows.map((r) => r.kind))] as EntityKind[]).toSorted(
    (a, b) => KIND_DEPTH[a] - KIND_DEPTH[b],
  );

  for (const kind of kindsByDepth) {
    // Group this kind's rows by title.
    const groups = new Map<string, RawRow[]>();
    for (const r of rows) {
      if (r.kind !== kind) continue;
      const bucket = groups.get(r.title) ?? [];
      bucket.push(r);
      groups.set(r.title, bucket);
    }
    for (const [title, bucket] of groups) {
      // Stable sort by signature, then uuid as a last-resort deterministic tiebreak
      // (only reached for structurally identical rows, where order is immaterial).
      const ordered = bucket
        .map((r) => ({ r, sig: signature(r, placeholderOf) }))
        .toSorted((x, y) =>
          x.sig < y.sig ? -1 : x.sig > y.sig ? 1 : x.r.uuid < y.r.uuid ? -1 : 1,
        );
      ordered.forEach(({ r }, i) => {
        map.set(r.uuid, {
          kind,
          title,
          discoveryOrder: i,
          placeholder: `${kind}:${title}#${i}`,
        });
      });
    }
  }
  return map;
}

const isoDay = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

/** Normalize one cell value for a given column. */
function normValue(field: string, value: CellValue, ph: (u: string) => string): CellValue {
  if (value === null) return null;
  if (FK_COLUMNS.has(field) && typeof value === "string") return ph(value);
  if (WALLCLOCK_COLUMNS.has(field) && typeof value === "number") return `date:${isoDay(value)}`;
  if (INDEX_COLUMNS.has(field)) return "idx:masked"; // ranked separately for inserts; masked in changes
  return value;
}

function normFields(
  fields: Record<string, CellValue>,
  ph: (u: string) => string,
): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = normValue(k, v, ph);
  return out;
}

/** Placeholder for a delta row key: a single uuid, or "a|b" for a join table. */
function keyPlaceholder(table: string, key: string, ph: (u: string) => string): string {
  if (table === "TMTaskTag" || table === "TMAreaTag") {
    const [a = "", b = ""] = key.split("|");
    return `${ph(a)}|${ph(b)}`;
  }
  return ph(key);
}

/**
 * Replace inserted-row index columns (masked to "idx:masked" by normValue) with
 * a rank among same-table inserted rows. `inserted[i]` still lines up with
 * `raw.inserted[i]` here (called before the canonical re-sort).
 */
function rankInsertIndexes(inserted: NormalizedRow[], raw: DbDelta): void {
  for (const col of INDEX_COLUMNS) {
    const sortedByTable = new Map<string, number[]>();
    for (const ins of raw.inserted) {
      const v = ins.row[col];
      if (typeof v !== "number") continue;
      const bucket = sortedByTable.get(ins.table) ?? [];
      bucket.push(v);
      sortedByTable.set(ins.table, bucket);
    }
    for (const values of sortedByTable.values()) values.sort((a, b) => a - b);
    raw.inserted.forEach((rawIns, i) => {
      const v = rawIns.row[col];
      const norm = inserted[i];
      if (typeof v !== "number" || norm === undefined) return;
      norm.fields[col] = `rank:${(sortedByTable.get(rawIns.table) ?? []).indexOf(v)}`;
    });
  }
}

/** Canonical row ordering (by table, then placeholder) for stable comparison + serialization. */
function byPlace(
  a: { table: string; placeholder: string },
  b: { table: string; placeholder: string },
): number {
  if (a.table !== b.table) return a.table < b.table ? -1 : 1;
  if (a.placeholder !== b.placeholder) return a.placeholder < b.placeholder ? -1 : 1;
  return 0;
}

/** Normalize a raw delta against an identity map. */
export function normalizeDelta(delta: DbDelta, identity: Map<string, Identity>): NormalizedDelta {
  const ph = (u: string): string => identity.get(u)?.placeholder ?? `uuid:${u.slice(0, 6)}`;

  const inserted: NormalizedRow[] = delta.inserted.map((r) => ({
    placeholder: keyPlaceholder(r.table, r.key, ph),
    table: r.table,
    fields: normFields(r.row, ph),
  }));
  rankInsertIndexes(inserted, delta);

  const deleted = delta.deleted.map((r) => ({
    placeholder: keyPlaceholder(r.table, r.key, ph),
    table: r.table,
  }));

  const changed: NormalizedChange[] = delta.changed.map((r) => ({
    placeholder: keyPlaceholder(r.table, r.key, ph),
    table: r.table,
    fields: r.fields.map((fc) => ({
      field: fc.field,
      before: normValue(fc.field, fc.before, ph),
      after: normValue(fc.field, fc.after, ph),
    })),
  }));

  // Canonical ordering for stable comparison + golden serialization.
  inserted.sort(byPlace);
  deleted.sort(byPlace);
  changed.sort(byPlace);
  for (const c of changed) c.fields.sort((x, y) => (x.field < y.field ? -1 : 1));

  return { inserted, deleted, changed };
}
