/**
 * R10 lifecycle taxonomy: the pure {@link deriveStage} derivation matrix, the
 * today/evening marker corners (GUI-verified UPC1 / F-DL, oddities §8d–8e), and a
 * property-style consistency check that every item's derived `stage` equals the
 * bucket a view (flat catalogue or card sub-bucket) puts it in — the invariant
 * that justifies reusing ONE derivation everywhere.
 */
import { afterEach, describe, expect, it } from "vitest";

import { deriveStage, type StageInput } from "../../src/read/stage.ts";
import { shapeReadPayload } from "../../src/read/shape.ts";
import { projectView } from "../../src/read/project-view.ts";
import {
  anytimeView,
  inboxView,
  logbookView,
  searchView,
  somedayView,
  trashView,
  type ListItem,
} from "../../src/read/views.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02
const NOW_EPOCH = NOW.getTime() / 1000;

const base = (over: Partial<StageInput> = {}): StageInput => ({
  trashed: false,
  logged: false,
  start: "active",
  startDate: null,
  repeating: { isTemplate: false },
  ...over,
});

describe("deriveStage — the derivation matrix", () => {
  it("trashed wins over EVERYTHING, including a logged row", () => {
    expect(deriveStage(base({ trashed: true }))).toBe("trash");
    expect(deriveStage(base({ trashed: true, logged: true }))).toBe("trash");
    expect(deriveStage(base({ trashed: true, logged: true, startDate: "2026-08-01" }))).toBe(
      "trash",
    );
  });

  it("logged (past the logbook boundary) → logbook, below trash", () => {
    expect(deriveStage(base({ logged: true }))).toBe("logbook");
    expect(deriveStage(base({ logged: true, startDate: "2026-08-01" }))).toBe("logbook");
  });

  it("completed/canceled but NOT yet logged keeps its live stage (logged=false falls through)", () => {
    // markLogged leaves logged=false for a checked-but-unswept row → live stage.
    expect(deriveStage(base({ logged: false, start: "active", startDate: null }))).toBe("anytime");
    expect(deriveStage(base({ logged: false, startDate: "2026-06-01" }))).toBe("upcoming");
    expect(deriveStage(base({ logged: false, start: "someday", startDate: null }))).toBe("someday");
    expect(deriveStage(base({ logged: false, start: "inbox" }))).toBe("inbox");
  });

  it("inbox (start=0) → inbox", () => {
    expect(deriveStage(base({ start: "inbox" }))).toBe("inbox");
  });

  it("a repeating template → upcoming, regardless of its projected date", () => {
    expect(deriveStage(base({ repeating: { isTemplate: true } }))).toBe("upcoming");
    // paused / after-completion template (no startDate) still → upcoming.
    expect(
      deriveStage(base({ repeating: { isTemplate: true }, start: "someday", startDate: null })),
    ).toBe("upcoming");
  });

  it("any startDate — past, today, OR future — → upcoming (Upcoming ⊇ Today)", () => {
    for (const d of ["2026-06-01", "2026-07-02", "2026-08-01"]) {
      expect(deriveStage(base({ startDate: d }))).toBe("upcoming");
      expect(deriveStage(base({ start: "someday", startDate: d }))).toBe("upcoming");
    }
  });

  it("someday (undated, deferred) → someday; active undated → anytime", () => {
    expect(deriveStage(base({ start: "someday", startDate: null }))).toBe("someday");
    expect(deriveStage(base({ start: "active", startDate: null }))).toBe("anytime");
  });
});

let fx: FixtureDb;
afterEach(() => fx?.close());

/** Read one entity back through a mixed view (keeps `stage` + markers on the wire). */
function markerRow(title: string): { today: true | undefined; evening: true | undefined } {
  const hits = searchView(fx.db, title, {}, NOW) as ListItem[];
  const item = hits.find((i) => i.title === title)!;
  return { today: item.today, evening: item.evening };
}

describe("today/evening markers — the GUI-verified corners (UPC1 / F-DL, oddities §8d–8e)", () => {
  it("deadline-today UNDATED active → stage anytime + today:true (the deadline arm, no startDate)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "dl-active",
      start: "active",
      startDate: null,
      deadline: "2026-07-02",
    });
    const hit = (searchView(fx.db, "dl-active", {}, NOW) as ListItem[])[0]!;
    expect(deriveStage(hit)).toBe("anytime");
    expect(markerRow("dl-active").today).toBe(true);
    expect(markerRow("dl-active").evening).toBeUndefined();
  });

  it("SOMEDAY item with a due/overdue UNsuppressed deadline → stage someday + today:true", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "some-due",
      start: "someday",
      startDate: null,
      deadline: "2026-07-01", // overdue vs 07-02
    });
    const hit = (searchView(fx.db, "some-due", {}, NOW) as ListItem[])[0]!;
    expect(deriveStage(hit)).toBe("someday");
    expect(markerRow("some-due").today).toBe(true);
  });

  it("the SAME someday item once SUPPRESSED stays out of Today → stage someday, NO today marker", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "some-supp",
      start: "someday",
      startDate: null,
      deadline: "2026-07-01",
      deadlineSuppressionDate: "2026-07-01", // dismissed nag (supp == deadline)
    });
    const hit = (searchView(fx.db, "some-supp", {}, NOW) as ListItem[])[0]!;
    expect(deriveStage(hit)).toBe("someday");
    expect(markerRow("some-supp").today).toBeUndefined();
  });

  it("banner-materialized form (start=1, startDate:=deadline=today) → stage upcoming + today:true", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "materialized",
      start: "active",
      startDate: "2026-07-02",
      deadline: "2026-07-02",
    });
    const hit = (searchView(fx.db, "materialized", {}, NOW) as ListItem[])[0]!;
    expect(deriveStage(hit)).toBe("upcoming");
    expect(markerRow("materialized").today).toBe(true);
  });

  it("This-Evening (startBucket=1, startDate today) → today AND evening markers", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "tonight", start: "active", startDate: "2026-07-02", evening: true });
    expect(markerRow("tonight")).toEqual({ today: true, evening: true });
  });
});

describe("property — an item's stage equals the view bucket that contains it", () => {
  it("flat catalogues agree with deriveStage (inbox / trash / logbook / someday)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "inbox-1", start: "inbox", startDate: null });
    seedTodo(fx.db, { title: "trash-1", trashed: true });
    seedTodo(fx.db, {
      title: "log-1",
      status: "completed",
      stopDate: NOW_EPOCH - 3600, // swept (logInterval defaults to 0 → boundary now)
    });
    seedTodo(fx.db, { title: "some-1", start: "someday", startDate: null });

    for (const i of inboxView(fx.db, NOW)) expect(deriveStage(i)).toBe("inbox");
    for (const i of trashView(fx.db, NOW)) expect(deriveStage(i)).toBe("trash");
    for (const i of logbookView(fx.db, NOW)) expect(deriveStage(i)).toBe("logbook");
    for (const s of somedayView(fx.db, NOW))
      for (const i of s.items) expect(deriveStage(i)).toBe("someday");
    // The Anytime CATALOGUE is a Today-inclusive mix: every member is anytime OR
    // an arrived/starred upcoming row (a dated <= today member).
    for (const s of anytimeView(fx.db, NOW))
      for (const i of s.items) expect(["anytime", "upcoming"]).toContain(deriveStage(i));
  });

  it("project card sub-buckets: the bucket an item lands in equals its derived stage", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "P" });
    const children = [
      seedTodo(fx.db, { title: "c-anytime", project: proj, start: "active", startDate: null }),
      seedTodo(fx.db, { title: "c-upfut", project: proj, startDate: "2026-08-01" }),
      seedTodo(fx.db, { title: "c-uptoday", project: proj, startDate: "2026-07-02" }),
      seedTodo(fx.db, { title: "c-someday", project: proj, start: "someday", startDate: null }),
      seedTodo(fx.db, { title: "c-tmpl", project: proj, recurrenceRule: true }),
      seedTodo(fx.db, {
        title: "c-log",
        project: proj,
        status: "completed",
        stopDate: NOW_EPOCH - 3600,
      }),
      seedTodo(fx.db, { title: "c-trash", project: proj, trashed: true }),
    ];
    void children;
    const head = seedHeading(fx.db, { title: "H", project: proj });
    seedTodo(fx.db, { title: "h-anytime", heading: head, start: "active", startDate: null });
    seedTodo(fx.db, { title: "h-upcoming", heading: head, startDate: "2026-08-05" });

    const view = projectView(fx.db, proj, NOW);
    // Map every child uuid to its derived stage from the UNSHAPED entities.
    const stageOf = new Map<string, string>();
    const record = (i: ListItem) => stageOf.set(i.uuid, deriveStage(i));
    view.active.forEach(record);
    view.scheduled.forEach((g) => g.items.forEach(record));
    view.someday.forEach(record);
    view.repeating.forEach(record);
    view.logged.forEach(record);
    view.trashed.forEach(record);
    for (const g of view.headings) {
      g.items.forEach(record);
      g.scheduled.forEach((d) => d.items.forEach(record));
      g.someday.forEach(record);
      g.repeating.forEach(record);
    }

    const shaped = shapeReadPayload("project-view", view, true) as Record<string, unknown>;
    type Row = { uuid: string };
    type Grp = { date: string | null; items: Row[] };
    const checkBucket = (items: Row[], stage: string) => {
      for (const i of items) expect(stageOf.get(i.uuid)).toBe(stage);
    };
    checkBucket(shaped["anytime"] as Row[], "anytime");
    checkBucket(shaped["someday"] as Row[], "someday");
    checkBucket(shaped["logbook"] as Row[], "logbook");
    checkBucket(shaped["trash"] as Row[], "trash");
    for (const g of shaped["upcoming"] as Grp[]) checkBucket(g.items, "upcoming");
    // The heading group is bucketed the same way.
    const grp = (shaped["headings"] as Array<Record<string, unknown>>)[0]!;
    checkBucket(grp["anytime"] as Row[], "anytime");
    checkBucket(grp["someday"] as Row[], "someday");
    for (const g of grp["upcoming"] as Grp[]) checkBucket(g.items, "upcoming");

    // And the shape actually placed each stage where expected.
    expect((shaped["anytime"] as Row[]).length).toBeGreaterThan(0);
    expect((shaped["upcoming"] as Grp[]).some((g) => g.date === "2026-08-01")).toBe(true);
    expect((shaped["upcoming"] as Grp[]).some((g) => g.date === null)).toBe(true); // the template
    expect((shaped["logbook"] as Row[]).length).toBe(1);
    expect((shaped["trash"] as Row[]).length).toBe(1);
  });
});
