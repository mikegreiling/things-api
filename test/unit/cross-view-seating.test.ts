/**
 * R7 cross-view dual-citizen seating — the read-shape v2 regression locks
 * (doctrine §5 step 4). A "dual citizen" is a row with membership on two axes: a
 * someday/anytime to-do carrying a future DEADLINE (a stage bucket AND a
 * projected day), or a repeating TEMPLATE (a resting bucket AND a projected
 * occurrence). R7 seats each ONCE per view, GUI-faithfully:
 *
 * - PROJECTION views (global `upcoming`) seat a dual citizen at its projected /
 *   deadline DAY block — the projection IS its seat.
 * - CONTAINER views (project / area) seat it in its CANONICAL stage bucket
 *   (someday / anytime), NEVER also in a day block.
 * - global `someday` / `anytime` show it canonically.
 * - and the master invariant: NO uuid appears twice within a single view's
 *   payload — every bucket is a complete, non-overlapping scope for its view.
 *
 * One shared fixture drives every assertion so a regression that double-seats a
 * dual citizen (or moves it off its GUI-faithful seat) fails here, in one place,
 * across all six read surfaces. DB-backed (real views + real shaping), so it
 * exercises the seating end to end, not a hand-built payload.
 */
import { afterEach, describe, expect, it } from "vitest";

import { shapeReadPayload } from "../../src/read/shape.ts";
import { projectView } from "../../src/read/project-view.ts";
import { areaView } from "../../src/read/area-view.ts";
import { anytimeView, somedayView, todayView, upcomingView } from "../../src/read/views.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02
const TODAY = "2026-07-02";
const DL_EARLY = "2026-07-10";
const OCC = "2026-07-15";
const DL_LATE = "2026-07-20";

type Row = Record<string, unknown>;
type Section = { when: string | null; items: Row[] };

/** Every `uuid` value anywhere in a shaped payload (rows, container nodes, headings). */
function uuidsIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const el of v) uuidsIn(el, out);
    return out;
  }
  if (v !== null && typeof v === "object") {
    const o = v as Row;
    if (typeof o["uuid"] === "string") out.push(o["uuid"] as string);
    for (const k of Object.keys(o)) if (k !== "uuid") uuidsIn(o[k], out);
  }
  return out;
}

/** R7 master invariant: no uuid appears twice within one view's shaped payload. */
function expectNoDuplicateUuid(label: string, payload: unknown): void {
  const all = uuidsIn(payload);
  expect(new Set(all).size, `${label} duplicated a uuid: ${all.join(",")}`).toBe(all.length);
}

const flat = (secs: Section[]): Row[] => secs.flatMap((s) => s.items);
/** The `when` of the day block an item seats in (null if it seats in no block). */
const blockWhenOf = (secs: Section[], uuid: string): string | null | undefined =>
  secs.find((s) => s.items.some((i) => i["uuid"] === uuid))?.when;
const rowByUuid = (rows: Row[], uuid: string): Row | undefined =>
  rows.find((r) => r["uuid"] === uuid);

let fx: FixtureDb;
afterEach(() => fx?.close());

/**
 * Seed the shared dual-citizen fixture and return the uuids. Area "Work" holds a
 * child project "Q3" plus two AREA-DIRECT dual citizens; Q3 holds two project-child
 * dual citizens and a repeating template; a LOOSE deadline-pulled row exercises the
 * today/anytime axis.
 */
function seedDualCitizens() {
  fx = buildFixtureDb();
  const work = seedArea(fx.db, "Work");
  const q3 = seedProject(fx.db, { title: "Q3", area: work, start: "active" });

  // Area-direct dual citizens (no project) — surface in area-view + global lists.
  const aAnytime = seedTodo(fx.db, {
    title: "a-anytime+dl",
    area: work,
    start: "active",
    startDate: null,
    deadline: DL_EARLY,
  });
  const aSomeday = seedTodo(fx.db, {
    title: "a-someday+dl",
    area: work,
    start: "someday",
    startDate: null,
    deadline: DL_LATE,
  });

  // Project-child dual citizens — surface in project-view + global upcoming.
  const pAnytime = seedTodo(fx.db, {
    title: "p-anytime+dl",
    project: q3,
    start: "active",
    startDate: null,
    deadline: DL_EARLY,
  });
  const pSomeday = seedTodo(fx.db, {
    title: "p-someday+dl",
    project: q3,
    start: "someday",
    startDate: null,
    deadline: DL_LATE,
  });
  // A repeating template projecting into upcoming at its next occurrence.
  const pTemplate = seedTodo(fx.db, {
    title: "p-template",
    project: q3,
    start: "active",
    startDate: null,
    recurrenceRule: true,
    nextInstanceStartDate: OCC,
  });

  // A LOOSE undated row whose due-today deadline PULLS it into Today + Anytime
  // (R13) and OUT of Someday — a today-axis dual citizen.
  const loosePull = seedTodo(fx.db, {
    title: "loose-pull",
    start: "someday",
    startDate: null,
    deadline: TODAY,
  });

  return { work, q3, aAnytime, aSomeday, pAnytime, pSomeday, pTemplate, loosePull };
}

describe("R7 cross-view seating — global upcoming (projection side)", () => {
  it("(a) seats every dual citizen at its DEADLINE / OCCURRENCE day block, keeping stage", () => {
    const s = seedDualCitizens();
    const secs = shapeReadPayload("upcoming", upcomingView(fx.db, NOW), false) as Section[];

    // Deadline-forecast rows seat under their DEADLINE day (startDate stays null).
    expect(blockWhenOf(secs, s.aAnytime)).toBe(DL_EARLY);
    expect(blockWhenOf(secs, s.pAnytime)).toBe(DL_EARLY);
    expect(blockWhenOf(secs, s.aSomeday)).toBe(DL_LATE);
    expect(blockWhenOf(secs, s.pSomeday)).toBe(DL_LATE);
    // The template projects at its next occurrence.
    expect(blockWhenOf(secs, s.pTemplate)).toBe(OCC);

    // Stage is KEPT (projection-side stage-MIXED) — the forecast rows carry their
    // canonical anytime/someday, the template its upcoming.
    const rows = flat(secs);
    expect(rowByUuid(rows, s.aAnytime)!["stage"]).toBe("anytime");
    expect(rowByUuid(rows, s.pSomeday)!["stage"]).toBe("someday");
    expect(rowByUuid(rows, s.pTemplate)!["stage"]).toBe("upcoming");
  });

  it("(c) no uuid appears twice in the upcoming payload", () => {
    seedDualCitizens();
    const secs = shapeReadPayload("upcoming", upcomingView(fx.db, NOW), false);
    expectNoDuplicateUuid("upcoming", secs);
  });
});

describe("R7 cross-view seating — container views seat in canonical stage buckets only", () => {
  it("(b) project-view: someday/anytime dual citizens seat in their stage bucket, in NO day block", () => {
    const s = seedDualCitizens();
    const out = shapeReadPayload("project-view", projectView(fx.db, s.q3, NOW), false) as Row;
    const children = out["children"] as Row;
    const bucketUuids = (k: string) =>
      ((children[k] as Row)["items"] as Row[]).map((i) => i["uuid"]);
    const dayBlocks = children["upcoming"] as Section[];

    // Canonical stage seats.
    expect(bucketUuids("anytime")).toContain(s.pAnytime);
    expect(bucketUuids("someday")).toContain(s.pSomeday);
    // NEVER also in a day block (a deadline never makes the stage `upcoming`).
    expect(blockWhenOf(dayBlocks, s.pAnytime)).toBeUndefined();
    expect(blockWhenOf(dayBlocks, s.pSomeday)).toBeUndefined();
    // The template DOES seat in a day block — its projection is its only seat.
    expect(blockWhenOf(dayBlocks, s.pTemplate)).toBe(OCC);
    expect(bucketUuids("anytime")).not.toContain(s.pTemplate);
  });

  it("(b) area-view: area-direct someday/anytime dual citizens seat in their stage bucket, in NO day block", () => {
    const s = seedDualCitizens();
    const out = shapeReadPayload("area-view", areaView(fx.db, s.work, NOW), false) as Row;
    const children = out["children"] as Row;
    const bucketUuids = (k: string) =>
      ((children[k] as Row)["items"] as Row[]).map((i) => i["uuid"]);
    const dayBlocks = children["upcoming"] as Section[];

    expect(bucketUuids("anytime")).toContain(s.aAnytime);
    expect(bucketUuids("someday")).toContain(s.aSomeday);
    expect(blockWhenOf(dayBlocks, s.aAnytime)).toBeUndefined();
    expect(blockWhenOf(dayBlocks, s.aSomeday)).toBeUndefined();
  });

  it("(c) no uuid appears twice in the project-view or area-view payload", () => {
    const s = seedDualCitizens();
    expectNoDuplicateUuid(
      "project-view",
      shapeReadPayload("project-view", projectView(fx.db, s.q3, NOW), false),
    );
    expectNoDuplicateUuid(
      "area-view",
      shapeReadPayload("area-view", areaView(fx.db, s.work, NOW), false),
    );
  });
});

describe("R7 cross-view seating — global someday/anytime show dual citizens canonically", () => {
  it("(d) anytime lists the anytime dual citizen + the deadline-pulled row (canonical stage-pure)", () => {
    const s = seedDualCitizens();
    const secs = shapeReadPayload("anytime", anytimeView(fx.db, NOW), false) as Section[];
    const uuids = flat(secs).map((i) => i["uuid"]);
    expect(uuids).toContain(s.aAnytime); // area-direct anytime dual citizen, canonically
    expect(uuids).toContain(s.loosePull); // R13: a due-deadline pull files under Anytime
    // Stage is DROPPED (the anytime catalogue is stage-pure).
    expect("stage" in rowByUuid(flat(secs), s.aAnytime)!).toBe(false);
    expectNoDuplicateUuid("anytime", secs);
  });

  it("(d) someday lists the someday dual citizen; the deadline-pulled row is NOT there (GUI-faithful)", () => {
    const s = seedDualCitizens();
    const secs = shapeReadPayload("someday", somedayView(fx.db, NOW), false) as Section[];
    const uuids = flat(secs).map((i) => i["uuid"]);
    expect(uuids).toContain(s.aSomeday);
    expect(uuids).not.toContain(s.loosePull); // pulled out of Someday into Today+Anytime
    expectNoDuplicateUuid("someday", secs);
  });
});

describe("R7 cross-view seating — today view (today/anytime axis)", () => {
  it("(a)/(c) the deadline-pulled dual citizen seats once in today, nowhere else in the payload", () => {
    const s = seedDualCitizens();
    const out = shapeReadPayload("today", todayView(fx.db, NOW), false) as {
      today: { items: Row[] };
      evening: { items: Row[] };
    };
    const todayUuids = out.today.items.map((i) => i["uuid"]);
    expect(todayUuids).toContain(s.loosePull);
    // The future-deadline dual citizens are NOT due today, so they do not appear.
    expect(todayUuids).not.toContain(s.aAnytime);
    expectNoDuplicateUuid("today", out);
  });
});
