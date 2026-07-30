/**
 * R10 lifecycle taxonomy: the pure {@link deriveStage} derivation matrix, the
 * today/evening marker corners (GUI-verified UPC1 / F-DL, oddities §8d–8e), and a
 * property-style consistency check that every item's derived `stage` equals the
 * bucket a view (flat catalogue or card sub-bucket) puts it in — the invariant
 * that justifies reusing ONE derivation everywhere.
 */
import { afterEach, describe, expect, it } from "vitest";

import { deriveStage, deriveWhen, type StageInput, type WhenInput } from "../../src/read/stage.ts";
import { shapeReadPayload } from "../../src/read/shape.ts";
import { projectView } from "../../src/read/project-view.ts";
import {
  anytimeView,
  inboxView,
  logbookView,
  searchView,
  somedayView,
  todayView,
  trashView,
  upcomingView,
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
    // A future When-date (no today marker) is upcoming.
    expect(deriveStage(base({ logged: false, startDate: "2026-08-01" }))).toBe("upcoming");
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

  it("a strictly-FUTURE startDate (no today marker) → upcoming; Upcoming is strictly future (UPC1)", () => {
    // A future When-date carries no `today` marker (mappers scheduledArm requires
    // startDate <= today), so it derives upcoming.
    expect(deriveStage(base({ startDate: "2026-08-01" }))).toBe("upcoming");
    expect(deriveStage(base({ start: "someday", startDate: "2026-08-01" }))).toBe("upcoming");
  });

  it("an ARRIVED startDate (today marker present) → anytime, NOT upcoming (UPC1 strictly-future)", () => {
    // Today (07-02) and overdue (06-01) When-dates have both arrived — the entity
    // carries `today: true` — so they are Anytime + Today, never Upcoming.
    for (const d of ["2026-06-01", "2026-07-02"]) {
      expect(deriveStage(base({ startDate: d, today: true }))).toBe("anytime");
      // arrived someday-scheduled (start=2, startDate <= today) is an Anytime member too.
      expect(deriveStage(base({ start: "someday", startDate: d, today: true }))).toBe("anytime");
    }
  });

  it("someday (undated, deferred) → someday; active undated → anytime", () => {
    expect(deriveStage(base({ start: "someday", startDate: null }))).toBe("someday");
    expect(deriveStage(base({ start: "active", startDate: null }))).toBe("anytime");
  });
});

const whenBase = (over: Partial<WhenInput> = {}): WhenInput => ({
  stage: "anytime",
  startDate: null,
  repeating: { isTemplate: false, nextOccurrence: null },
  ...over,
});

describe("deriveWhen — the time-axis position matrix (R12)", () => {
  it("evening marker → `evening` (wins over today)", () => {
    expect(deriveWhen(whenBase({ today: true, evening: true }))).toBe("evening");
  });

  it("today marker → `today` (any arm: arrived startDate OR deadline-pull)", () => {
    // Arrived active-dated row (stage anytime + today marker).
    expect(deriveWhen(whenBase({ stage: "anytime", startDate: "2026-07-01", today: true }))).toBe(
      "today",
    );
    // Deadline-pulled anytime (undated active, today marker, no startDate).
    expect(deriveWhen(whenBase({ stage: "anytime", today: true }))).toBe("today");
    // Deadline-pulled INBOX (stage inbox, today marker) — inbox CAN read when:today.
    expect(deriveWhen(whenBase({ stage: "inbox", today: true }))).toBe("today");
    // Deadline-pulled SOMEDAY (stage someday, today marker) — surfaced in Today.
    expect(deriveWhen(whenBase({ stage: "someday", today: true }))).toBe("today");
  });

  it("a suppressed someday deadline (NO marker) → absent", () => {
    // Suppression drops the today marker (mappers deadlineArm guard); no when.
    expect(deriveWhen(whenBase({ stage: "someday" }))).toBeUndefined();
  });

  it("a strictly-future scheduled row (no marker) → its ISO date", () => {
    expect(deriveWhen(whenBase({ stage: "upcoming", startDate: "2026-08-01" }))).toBe("2026-08-01");
  });

  it("a repeating TEMPLATE: projected → its ISO next occurrence; unprojected → absent", () => {
    expect(
      deriveWhen(
        whenBase({
          stage: "upcoming",
          repeating: { isTemplate: true, nextOccurrence: "2026-09-15" },
        }),
      ),
    ).toBe("2026-09-15");
    // Paused / after-completion (no projection) → no when.
    expect(
      deriveWhen(
        whenBase({ stage: "upcoming", repeating: { isTemplate: true, nextOccurrence: null } }),
      ),
    ).toBeUndefined();
  });

  it("unscheduled and not in Today → absent", () => {
    expect(deriveWhen(whenBase({ stage: "anytime" }))).toBeUndefined();
    expect(deriveWhen(whenBase({ stage: "someday" }))).toBeUndefined();
  });

  it("logged/trashed rows have NO when even with a marker or a future date", () => {
    expect(deriveWhen(whenBase({ stage: "logbook", today: true }))).toBeUndefined();
    expect(deriveWhen(whenBase({ stage: "logbook", startDate: "2026-08-01" }))).toBeUndefined();
    expect(deriveWhen(whenBase({ stage: "trash", evening: true }))).toBeUndefined();
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

  it("banner-materialized form (start=1, startDate:=deadline=today) → stage anytime + today:true", () => {
    // UPC1 §8d: acknowledging the "new to-dos" banner mutates the item to start=1,
    // startDate := deadline (= today). That is an ARRIVED When-date, so under the
    // strictly-future Upcoming law (UPC1 §8, R10.2) it derives ANYTIME + today,
    // NOT upcoming (an arrived-dated open item is in Today + Anytime).
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "materialized",
      start: "active",
      startDate: "2026-07-02",
      deadline: "2026-07-02",
    });
    const hit = (searchView(fx.db, "materialized", {}, NOW) as ListItem[])[0]!;
    expect(deriveStage(hit)).toBe("anytime");
    expect(markerRow("materialized").today).toBe(true);
  });

  it("This-Evening (startBucket=1, startDate today) → today AND evening markers", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "tonight", start: "active", startDate: "2026-07-02", evening: true });
    expect(markerRow("tonight")).toEqual({ today: true, evening: true });
  });
});

/** `when` derived over a real materialized entity, mirroring src/read/shape.ts `whenOf`. */
const whenOfEntity = (i: ListItem): ReturnType<typeof deriveWhen> =>
  deriveWhen({
    stage: deriveStage(i),
    today: i.today === true,
    evening: i.evening === true,
    startDate: i.startDate,
    repeating: {
      isTemplate: i.repeating.isTemplate,
      nextOccurrence: i.repeating.nextOccurrence ?? null,
    },
  });

describe("deriveWhen — over real entities through the read pipeline (R12)", () => {
  it("banner-materialized UPC1 case (start=1, startDate:=deadline=today) → when `today`", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "materialized",
      start: "active",
      startDate: "2026-07-02",
      deadline: "2026-07-02",
    });
    const hit = (searchView(fx.db, "materialized", {}, NOW) as ListItem[])[0]!;
    expect(whenOfEntity(hit)).toBe("today");
    // And it composes through the emit boundary (search keeps `when`).
    const wire = (shapeReadPayload("search", [hit], false) as Record<string, unknown>[])[0]!;
    expect(wire["when"]).toBe("today");
  });

  it("deadline-pulled inbox/someday compose: stage dropped by the pure view, `when: today` kept", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "in-dl", start: "inbox", startDate: null, deadline: "2026-07-02" });
    seedTodo(fx.db, {
      title: "some-dl",
      start: "someday",
      startDate: null,
      deadline: "2026-07-01",
    });
    // Through the real inbox emit: stage dropped (pure), `when: today` kept.
    const inboxRow = (
      shapeReadPayload("inbox", inboxView(fx.db, NOW), false) as Record<string, unknown>[]
    ).find((r) => r["title"] === "in-dl")!;
    expect("stage" in inboxRow).toBe(false);
    expect(inboxRow["when"]).toBe("today");
    // The someday catalogue is sectioned; find the row and check the same.
    const somedayShaped = shapeReadPayload("someday", somedayView(fx.db, NOW), false) as Array<{
      items: Record<string, unknown>[];
    }>;
    const someRow = somedayShaped.flatMap((s) => s.items).find((r) => r["title"] === "some-dl")!;
    expect("stage" in someRow).toBe(false);
    expect(someRow["when"]).toBe("today");
  });
});

describe("property — `when` ∈ {today, evening} ⟺ Today-view membership (R12)", () => {
  it("no when-derivation can disagree with the Today view the star renders", () => {
    fx = buildFixtureDb();
    // A spread that exercises BOTH today arms + non-members across stages.
    seedTodo(fx.db, { title: "p-arrived", start: "active", startDate: "2026-07-01" }); // today (arrived)
    seedTodo(fx.db, {
      title: "p-evening",
      start: "active",
      startDate: "2026-07-02",
      evening: true,
    }); // evening
    seedTodo(fx.db, {
      title: "p-dl-any",
      start: "active",
      startDate: null,
      deadline: "2026-07-02",
    }); // today (deadline)
    seedTodo(fx.db, {
      title: "p-dl-some",
      start: "someday",
      startDate: null,
      deadline: "2026-07-01",
    }); // today (someday-deadline)
    seedTodo(fx.db, {
      title: "p-supp",
      start: "someday",
      startDate: null,
      deadline: "2026-07-01",
      deadlineSuppressionDate: "2026-07-01",
    }); // NOT today (suppressed)
    seedTodo(fx.db, { title: "p-future", start: "someday", startDate: "2026-08-01" }); // NOT today (future)
    seedTodo(fx.db, { title: "p-any", start: "active", startDate: null }); // NOT today
    seedTodo(fx.db, { title: "p-inbox", start: "inbox", startDate: null }); // NOT today

    const view = todayView(fx.db, NOW);
    const members = new Set([...view.today, ...view.evening].map((i) => i.uuid));

    // Sweep every entity we can reach and assert the biconditional.
    const all = [
      ...(searchView(fx.db, "p-", {}, NOW) as ListItem[]),
      ...(upcomingView(fx.db, NOW) as ListItem[]),
      ...inboxView(fx.db, NOW),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const i of all) {
      const w = whenOfEntity(i);
      const whenSaysToday = w === "today" || w === "evening";
      expect(whenSaysToday).toBe(members.has(i.uuid));
    }
  });
});

describe("property — the emitted stage equals deriveStage, present exactly where the table says", () => {
  type WireRow = Record<string, unknown>;
  /** Flatten a flat ListItem[] OR a SidebarSection[] (`[{area, items}]`) to its rows. */
  const flatten = (v: unknown): WireRow[] => {
    const out: WireRow[] = [];
    for (const el of v as WireRow[]) {
      const items = el?.["items"];
      if (Array.isArray(items)) out.push(...(items as WireRow[]));
      else out.push(el);
    }
    return out;
  };
  /** uuid → deriveStage over the UNSHAPED entities of a view. */
  const stageMap = (unshaped: unknown): Map<string, string> => {
    const m = new Map<string, string>();
    for (const i of flatten(unshaped))
      m.set(i["uuid"] as string, deriveStage(i as unknown as StageInput));
    return m;
  };

  it("stage emitted iff the flat catalogue is stage-MIXED, and (when emitted) equals deriveStage exactly", () => {
    fx = buildFixtureDb();
    // Provably stage-PURE catalogues.
    seedTodo(fx.db, { title: "zz-inbox", start: "inbox", startDate: null });
    seedTodo(fx.db, { title: "zz-some", start: "someday", startDate: null });
    seedTodo(fx.db, { title: "zz-log", status: "completed", stopDate: NOW_EPOCH - 3600 }); // swept
    seedTodo(fx.db, { title: "zz-trash", trashed: true });
    // Anytime is stage-PURE (R10.2): an undated active row AND an ARRIVED-dated
    // (startDate <= today) row BOTH derive stage `anytime` — Upcoming is strictly
    // future, so an arrived When-date is Anytime + Today, never Upcoming.
    seedTodo(fx.db, { title: "zz-any", start: "active", startDate: null });
    const arrived = seedTodo(fx.db, {
      title: "zz-arrived",
      start: "active",
      startDate: "2026-07-01",
    });
    // Upcoming is stage-MIXED: a FUTURE-scheduled row (start=2, stage upcoming)
    // AND two deadline-forecast undated rows (a future deadline, no when-date)
    // whose stages are `anytime` (active) and `someday` (deferred).
    const upfut = seedTodo(fx.db, { title: "zz-upfut", start: "someday", startDate: "2026-08-01" });
    const fcAny = seedTodo(fx.db, {
      title: "zz-dl-active",
      start: "active",
      startDate: null,
      deadline: "2026-07-20",
    });
    const fcSome = seedTodo(fx.db, {
      title: "zz-dl-someday",
      start: "someday",
      startDate: null,
      deadline: "2026-07-20",
    });

    // Pure catalogues: every member derives the one stage the view names, and
    // the wire DROPS the field (the view provably states it). `anytime` is now
    // among them (R10.2) — its arrived-dated members derive `anytime`.
    const pure: Array<[string, unknown, string]> = [
      ["inbox", inboxView(fx.db, NOW), "inbox"],
      ["anytime", anytimeView(fx.db, NOW), "anytime"],
      ["someday", somedayView(fx.db, NOW), "someday"],
      ["logbook", logbookView(fx.db, NOW), "logbook"],
      ["trash", trashView(fx.db, NOW), "trash"],
    ];
    for (const [kind, unshaped, stg] of pure) {
      for (const i of flatten(unshaped)) expect(deriveStage(i as unknown as StageInput)).toBe(stg);
      for (const row of flatten(shapeReadPayload(kind, unshaped, true)))
        expect("stage" in row).toBe(false);
    }

    // The R10.2 correction is load-bearing: the arrived-dated row IS an Anytime
    // member, derives `anytime` (not `upcoming`), and its stage is DROPPED.
    const anyWire = flatten(shapeReadPayload("anytime", anytimeView(fx.db, NOW), true));
    const arrivedRow = anyWire.find((r) => r["uuid"] === arrived);
    expect(arrivedRow).toBeDefined();
    expect("stage" in arrivedRow!).toBe(false);

    // Mixed/derived catalogues: the wire KEEPS stage and it equals deriveStage
    // EXACTLY (strict per-item equality — not the weakened ∈{anytime,upcoming}).
    const mixed: Array<[string, unknown]> = [
      ["upcoming", upcomingView(fx.db, NOW)],
      ["search", searchView(fx.db, "zz", {}, NOW)],
    ];
    for (const [kind, unshaped] of mixed) {
      const want = stageMap(unshaped);
      for (const row of flatten(shapeReadPayload(kind, unshaped, true)))
        expect(row["stage"]).toBe(want.get(row["uuid"] as string));
    }

    // And the upcoming mixing is REAL — it carries rows whose stage differs from
    // the catalogue name (so strict equality is load-bearing). Its future-dated
    // member stays `upcoming`; the two deadline-forecast rows are anytime/someday.
    const upWire = flatten(shapeReadPayload("upcoming", upcomingView(fx.db, NOW), true));
    expect(upWire.find((r) => r["uuid"] === upfut)?.["stage"]).toBe("upcoming");
    expect(upWire.find((r) => r["uuid"] === fcAny)?.["stage"]).toBe("anytime");
    expect(upWire.find((r) => r["uuid"] === fcSome)?.["stage"]).toBe("someday");
  });

  it("project card sub-buckets: the bucket an item lands in equals its derived stage", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "P" });
    const children = [
      seedTodo(fx.db, { title: "c-anytime", project: proj, start: "active", startDate: null }),
      seedTodo(fx.db, { title: "c-upfut", project: proj, startDate: "2026-08-01" }),
      // ARRIVED When-date (today): rebuckets to `anytime`, NOT the upcoming
      // date-groups — Upcoming is strictly future (R10.2).
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
    // R10.2: the arrived (today) child `c-uptoday` sits in `anytime`, and NO
    // upcoming group is keyed on its arrived date — Upcoming holds only future
    // dates + the date-less template group.
    const cUpToday = children[2]!;
    expect((shaped["anytime"] as Row[]).some((r) => r.uuid === cUpToday)).toBe(true);
    expect((shaped["upcoming"] as Grp[]).some((g) => g.date === "2026-07-02")).toBe(false);
  });
});
