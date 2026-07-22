/**
 * SIMFID normalizer + comparator unit tests. These are the host-side heart of
 * the fidelity suite: they prove that (a) uuids map to stable, side-aligning
 * placeholders keyed by (kind, title, container-aware discovery order), (b)
 * wall-clock timestamps bucket to dates and list indexes reduce to ranks, and
 * (c) the comparator reports a genuine untolerated field difference as DIVERGENT
 * while each declared tolerance class absorbs its probe-proven nondeterminism.
 * Every input here is a SYNTHETIC delta — no real Things data, no DB.
 */
import { describe, expect, it } from "vitest";

import { compareDeltas } from "../../lab/simfid/compare.ts";
import { buildIdentityMap, normalizeDelta } from "../../lab/simfid/normalize.ts";
import type {
  CellValue,
  DbDelta,
  DbSnapshot,
  Identity,
  NormalizedDelta,
} from "../../lab/simfid/types.ts";

// -------------------------------------------------------- identity mapping

function taskRow(fields: Record<string, CellValue>): Record<string, CellValue> {
  return { type: 0, title: "", status: 0, start: 1, ...fields };
}

describe("buildIdentityMap", () => {
  it("keys placeholders by (kind, title) and disambiguates a template/instance pair", () => {
    const after: DbSnapshot = {
      TMTask: {
        "uuid-tmpl": taskRow({
          title: "Water",
          rt1_recurrenceRule: "rule:fixed;weekly;1;ts0;[]",
          start: 2,
        }),
        "uuid-inst": taskRow({
          title: "Water",
          rt1_repeatingTemplate: "uuid-tmpl",
          startDate: 100,
        }),
      },
    };
    const map = buildIdentityMap({}, after);
    const tmpl = map.get("uuid-tmpl");
    const inst = map.get("uuid-inst");
    expect(tmpl?.placeholder).toBeDefined();
    expect(inst?.placeholder).toBeDefined();
    // Same (kind,title) group, distinct discovery orders → distinct placeholders.
    expect(tmpl?.placeholder).not.toBe(inst?.placeholder);
    expect([tmpl?.placeholder, inst?.placeholder].toSorted()).toEqual([
      "todo:Water#0",
      "todo:Water#1",
    ]);
    // Deterministic: rebuild yields the same assignment.
    const map2 = buildIdentityMap({}, after);
    expect(map2.get("uuid-tmpl")?.placeholder).toBe(tmpl?.placeholder);
    expect(map2.get("uuid-inst")?.placeholder).toBe(inst?.placeholder);
  });

  it("orders same-title children by their resolved container (template vs instance side)", () => {
    // Two "Phase 1" headings, one under the template project, one under the
    // instance project. Their own rows are structurally identical, so alignment
    // MUST come from the container FK — the depth-ordered signature does this.
    const after: DbSnapshot = {
      TMTask: {
        ptmpl: taskRow({ type: 1, title: "Proj", rt1_recurrenceRule: "rule:x", start: 2 }),
        pinst: taskRow({ type: 1, title: "Proj", rt1_repeatingTemplate: "ptmpl", start: 2 }),
        h1: taskRow({ type: 2, title: "Phase 1", project: "ptmpl" }),
        h2: taskRow({ type: 2, title: "Phase 1", project: "pinst" }),
      },
    };
    const map = buildIdentityMap({}, after);
    // The two headings get distinct placeholders, and each references a distinct
    // project placeholder — so the two sides never cross-align.
    expect(map.get("h1")?.placeholder).not.toBe(map.get("h2")?.placeholder);
    expect(map.get("ptmpl")?.placeholder).not.toBe(map.get("pinst")?.placeholder);
  });
});

// ------------------------------------------------------------- normalize

const identity = (snap: DbSnapshot): Map<string, Identity> => buildIdentityMap({}, snap);

describe("normalizeDelta", () => {
  it("re-points FK cells at placeholders and buckets wall-clock epochs to dates", () => {
    const after: DbSnapshot = {
      TMTask: { t1: taskRow({ title: "T", area: "area-1", creationDate: 1_783_252_800 }) },
      TMArea: { "area-1": { title: "Errands", visible: 1, index: 0 } },
    };
    const delta: DbDelta = {
      inserted: [{ table: "TMTask", key: "t1", row: after["TMTask"]!["t1"]! }],
      deleted: [],
      changed: [],
    };
    const norm = normalizeDelta(delta, identity(after));
    const row = norm.inserted.find((r) => r.table === "TMTask");
    expect(row?.fields["area"]).toBe("area:Errands#0"); // FK → placeholder
    expect(row?.fields["creationDate"]).toMatch(/^date:2026-07-/); // epoch → date bucket
  });

  it("ranks inserted list indexes and masks changed indexes", () => {
    const after: DbSnapshot = {
      TMTask: {
        a: taskRow({ title: "A", index: 5 }),
        b: taskRow({ title: "B", index: 2 }),
      },
    };
    const delta: DbDelta = {
      inserted: [
        { table: "TMTask", key: "a", row: after["TMTask"]!["a"]! },
        { table: "TMTask", key: "b", row: after["TMTask"]!["b"]! },
      ],
      deleted: [],
      changed: [{ table: "TMTask", key: "a", fields: [{ field: "index", before: 5, after: 9 }] }],
    };
    const norm = normalizeDelta(delta, identity(after));
    const a = norm.inserted.find((r) => r.placeholder === "todo:A#0");
    const b = norm.inserted.find((r) => r.placeholder === "todo:B#0");
    expect(a?.fields["index"]).toBe("rank:1"); // 5 is the higher of {2,5}
    expect(b?.fields["index"]).toBe("rank:0");
    // Changed index is masked (not compared as an absolute value).
    expect(norm.changed[0]?.fields[0]?.after).toBe("idx:masked");
  });
});

// -------------------------------------------------------------- compare

/** A minimal normalized delta with a single inserted TMTask row. */
function insertedRow(placeholder: string, fields: Record<string, CellValue>): NormalizedDelta {
  return { inserted: [{ placeholder, table: "TMTask", fields }], deleted: [], changed: [] };
}

describe("compareDeltas", () => {
  it("MATCH when the two normalized deltas are identical", () => {
    const d = insertedRow("todo:X#0", { type: 0, status: 0, start: 1 });
    expect(compareDeltas(d, structuredClone(d)).verdict).toBe("MATCH");
  });

  it("DIVERGENT on an untolerated field difference", () => {
    const sim = insertedRow("todo:X#0", { type: 0, status: 0, start: 1 });
    const app = insertedRow("todo:X#0", { type: 0, status: 3, start: 1 });
    const v = compareDeltas(sim, app);
    expect(v.verdict).toBe("DIVERGENT");
    expect(v.summary).toContain("status");
  });

  it("DIVERGENT when the app inserts a row the simulator never emits", () => {
    const sim: NormalizedDelta = { inserted: [], deleted: [], changed: [] };
    const app = insertedRow("todo:Ghost#0", { type: 0 });
    const v = compareDeltas(sim, app);
    expect(v.verdict).toBe("DIVERGENT");
    expect(v.differences.some((d) => d.class === "row-missing")).toBe(true);
  });

  it("TOLERATED(rt1-child-backlink): a subtree child's link present on one side only", () => {
    // The row is a subtree CHILD (has a project container), so the
    // nondeterministic per-child stamping is tolerated (RSIM-R C2 / RSIM-S).
    const base = { type: 0, project: "project:Proj#1", start: 1 };
    const sim = insertedRow("todo:Kid#0", { ...base, rt1_repeatingTemplate: null });
    const app = insertedRow("todo:Kid#0", { ...base, rt1_repeatingTemplate: "project:Proj#0" });
    const v = compareDeltas(sim, app);
    expect(v.verdict).toBe("TOLERATED");
    expect(v.tolerances).toContain("rt1-child-backlink");
  });

  it("does NOT tolerate the link difference on a TOP-LEVEL instance row (no container)", () => {
    // No project/heading → this is the primary instance, whose link IS asserted.
    const sim = insertedRow("todo:Item#1", {
      type: 0,
      project: null,
      heading: null,
      rt1_repeatingTemplate: null,
    });
    const app = insertedRow("todo:Item#1", {
      type: 0,
      project: null,
      heading: null,
      rt1_repeatingTemplate: "todo:Item#0",
    });
    expect(compareDeltas(sim, app).verdict).toBe("DIVERGENT");
  });

  it("TOLERATED(instance-next-sentinel): the app's junk next-date on an instance row", () => {
    const base = { type: 0, rt1_repeatingTemplate: "todo:Y#0" };
    const sim = insertedRow("todo:Y#1", { ...base, rt1_nextInstanceStartDate: null });
    const app = insertedRow("todo:Y#1", { ...base, rt1_nextInstanceStartDate: 69760 });
    const v = compareDeltas(sim, app);
    expect(v.verdict).toBe("TOLERATED");
    expect(v.tolerances).toContain("instance-next-sentinel");
  });

  it("TOLERATED(index-rank): a residual rank difference is not a fidelity fact", () => {
    const sim = insertedRow("todo:Z#0", { type: 0, index: "rank:0" });
    const app = insertedRow("todo:Z#0", { type: 0, index: "rank:1" });
    const v = compareDeltas(sim, app);
    expect(v.verdict).toBe("TOLERATED");
    expect(v.tolerances).toContain("index-rank");
  });

  it("TOLERATED(wallclock-bucket): different date buckets on a timestamp column", () => {
    const sim = insertedRow("todo:W#0", { type: 0, userModificationDate: "date:2026-07-05" });
    const app = insertedRow("todo:W#0", { type: 0, userModificationDate: "date:2026-07-06" });
    const v = compareDeltas(sim, app);
    expect(v.verdict).toBe("TOLERATED");
    expect(v.tolerances).toContain("wallclock-bucket");
  });

  it("a mix of tolerated + untolerated differences is DIVERGENT (untolerated wins)", () => {
    const sim = insertedRow("todo:M#1", {
      type: 0,
      rt1_repeatingTemplate: "todo:M#0",
      rt1_nextInstanceStartDate: null,
      status: 0,
    });
    const app = insertedRow("todo:M#1", {
      type: 0,
      rt1_repeatingTemplate: "todo:M#0",
      rt1_nextInstanceStartDate: 69760,
      status: 3,
    });
    const v = compareDeltas(sim, app);
    expect(v.verdict).toBe("DIVERGENT");
    // The sentinel diff is still recorded as tolerated even though the verdict is DIVERGENT.
    expect(v.differences.some((d) => d.tolerated === "instance-next-sentinel")).toBe(true);
  });
});
