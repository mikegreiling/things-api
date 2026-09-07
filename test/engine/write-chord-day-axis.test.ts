/**
 * CHORD4 — the day-axis chord column, end to end against a seeded database:
 * the reader's oracle (which must read through `todayOrderBy`, not the rank
 * column), the pre-state's rendered-column census, and the pre-flight cohort
 * fence the ruling of 2026-09-07 put in front of the drive.
 *
 * The laws under test were measured in docs/lab/chord4-today-cohort.md.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeReorderPre } from "../../src/write/pre-state.ts";
import {
  cohortFenceViolation,
  createTodoOrderReader,
} from "../../src/write/vectors/ui-chord-todo.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00");
/** encodePackedDate(2026-07-05) — the guest day CHORD4 was measured on. */
const PACKED_TODAY = 132805248;

let fixture: FixtureDb;
beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => {
  fixture.close();
});

/** Two entry cohorts plus a live This Evening pair, the CHORD4 §1 shape. */
function seedTodayView(): Record<string, string> {
  return {
    // cohort 2026-07-05 (entered today)
    n1: seedTodo(fixture.db, {
      title: "N1",
      startDate: "2026-07-05",
      todayIndexReferenceDate: "2026-07-05",
      todayIndex: -900,
      start: "active",
    }),
    n2: seedTodo(fixture.db, {
      title: "N2",
      startDate: "2026-07-05",
      todayIndexReferenceDate: "2026-07-05",
      todayIndex: -500,
      start: "active",
    }),
    // a DEADLINE-PULLED row: undated, rendered, on the same axis, NOT a scope
    // member (CHORD4 §1). Cohort comes from its deadline.
    pulled: seedTodo(fixture.db, {
      title: "PULLED",
      startDate: null,
      deadline: "2026-07-04",
      todayIndex: 0,
      start: "active",
    }),
    // cohort 2026-07-04
    o1: seedTodo(fixture.db, {
      title: "O1",
      startDate: "2026-07-04",
      todayIndexReferenceDate: "2026-07-04",
      todayIndex: -300,
      start: "active",
    }),
    // a STALE evening row — bucket 1, day passed: the app renders it in Today
    // PROPER (STEV1), so it belongs to the `today` column, not `evening`.
    stale: seedTodo(fixture.db, {
      title: "STALE-EVE",
      startDate: "2026-07-03",
      todayIndexReferenceDate: "2026-07-03",
      evening: true,
      todayIndex: -100,
      start: "active",
    }),
    // the LIVE This Evening section
    e1: seedTodo(fixture.db, {
      title: "E1",
      startDate: "2026-07-05",
      todayIndexReferenceDate: "2026-07-05",
      evening: true,
      reminder: "20:00",
      todayIndex: -80,
      start: "active",
    }),
    e2: seedTodo(fixture.db, {
      title: "E2",
      startDate: "2026-07-05",
      todayIndexReferenceDate: "2026-07-05",
      evening: true,
      todayIndex: 0,
      start: "active",
    }),
  };
}

describe("the day-axis chord oracle", () => {
  it("reads the Today column in VISIBLE order — cohort first, rank second", () => {
    const t = seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    const state = read({ column: "today", containerUuid: null, packedToday: PACKED_TODAY });
    // Raw `todayIndex` ASC would have been N1 N2 O1 STALE PULLED. The comparator
    // groups by entry cohort FIRST, so the 07-05 pair leads and the two 07-04
    // rows follow in rank order, with the oldest group last (CHORD4 §1).
    expect(state.rows.map((r) => r.title)).toEqual(["N1", "N2", "O1", "PULLED", "STALE-EVE"]);
    // …and the live evening rows are NOT in it — they are their own section.
    expect(state.rows.map((r) => r.uuid)).not.toContain(t["e1"]);
  });

  it("carries the entry cohort on every row, so the fence has something to read", () => {
    seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    const state = read({ column: "today", containerUuid: null, packedToday: PACKED_TODAY });
    const byTitle = new Map(state.rows.map((r) => [r.title, r.cohort]));
    expect(byTitle.get("N1")).toBe(byTitle.get("N2"));
    expect(byTitle.get("N1")).not.toBe(byTitle.get("O1"));
    // A deadline-pulled row's cohort comes from its deadline, and lands it in
    // the 07-04 group beside O1 — which is where the app rendered it.
    expect(byTitle.get("PULLED")).toBe(byTitle.get("O1"));
  });

  it("reads the This Evening section as the LIVE bucket-1 rows only", () => {
    const t = seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    const state = read({ column: "evening", containerUuid: null, packedToday: PACKED_TODAY });
    expect(state.rows.map((r) => r.title)).toEqual(["E1", "E2"]);
    // Evening membership expires daily: the stale row is not in it.
    expect(state.rows.map((r) => r.uuid)).not.toContain(t["stale"]);
  });

  it("moves the whole evening section into Today PROPER once its day has passed", () => {
    seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    // The same database, read a day later: nothing was written, the placement
    // law just re-derives (STEV1).
    const tomorrow = 132805376; // encodePackedDate(2026-07-06)
    expect(
      read({ column: "evening", containerUuid: null, packedToday: tomorrow }).rows,
    ).toHaveLength(0);
    const proper = read({ column: "today", containerUuid: null, packedToday: tomorrow });
    expect(proper.rows.map((r) => r.title)).toContain("E1");
  });
});

describe("computeReorderPre's rendered chord column", () => {
  it("is a SUPERSET of the today scope's own membership", () => {
    const t = seedTodayView();
    const pre = computeReorderPre(
      fixture.db,
      { scope: "today", uuids: [t["n1"] ?? ""] },
      null,
      NOW,
    );
    const members = pre.members.map((m) => m.uuid);
    const column = (pre.chordColumn ?? []).map((r) => r.uuid);
    // The deadline-pulled row is rendered — a slot the gesture counts — but it
    // is not a scope member and can never be a movee.
    expect(column).toContain(t["pulled"]);
    expect(members).not.toContain(t["pulled"]);
    for (const m of members) expect(column).toContain(m);
  });

  it("is null on a scope with no day axis", () => {
    const pre = computeReorderPre(fixture.db, { scope: "inbox", uuids: [] }, null, NOW);
    expect(pre.chordColumn).toBeNull();
    expect(pre.packedToday).toBe(PACKED_TODAY);
  });

  it("holds only the live evening rows on the evening scope", () => {
    const t = seedTodayView();
    const pre = computeReorderPre(
      fixture.db,
      { scope: "evening", uuids: [t["e1"] ?? ""] },
      null,
      NOW,
    );
    expect((pre.chordColumn ?? []).map((r) => r.uuid)).toEqual([t["e1"], t["e2"]]);
  });
});

describe("the pre-flight cohort fence, over a real column", () => {
  it("lets a move inside today's own entry group through", () => {
    const t = seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    const rows = read({ column: "today", containerUuid: null, packedToday: PACKED_TODAY }).rows;
    const order = rows.map((r) => r.uuid);
    // Swap N1 and N2 — both entered Today today.
    const target = [order[1] as string, order[0] as string, ...order.slice(2)];
    expect(cohortFenceViolation(rows, target, new Set([t["n2"] ?? ""]))).toBeNull();
  });

  it("REFUSES lifting an older row to the top of Today", () => {
    const t = seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    const rows = read({ column: "today", containerUuid: null, packedToday: PACKED_TODAY }).rows;
    const order = rows.map((r) => r.uuid);
    const target = [t["o1"] ?? "", ...order.filter((u) => u !== t["o1"])];
    const refusal = cohortFenceViolation(rows, target, new Set([t["o1"] ?? ""]));
    expect(refusal).toContain("O1");
    expect(refusal).toContain("--when today");
  });

  it("REFUSES a request naming rows from two entry groups at once", () => {
    const t = seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    const rows = read({ column: "today", containerUuid: null, packedToday: PACKED_TODAY }).rows;
    const refusal = cohortFenceViolation(
      rows,
      rows.map((r) => r.uuid),
      new Set([t["n1"] ?? "", t["o1"] ?? ""]),
    );
    expect(refusal).toContain("do not share one Today entry group");
  });

  it("lets an evening reorder through — one section, one cohort", () => {
    const t = seedTodayView();
    const read = createTodoOrderReader(fixture.db);
    const rows = read({ column: "evening", containerUuid: null, packedToday: PACKED_TODAY }).rows;
    expect(
      cohortFenceViolation(rows, [t["e2"] ?? "", t["e1"] ?? ""], new Set([t["e2"] ?? ""])),
    ).toBeNull();
  });
});
