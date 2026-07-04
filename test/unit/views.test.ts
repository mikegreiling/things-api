import { afterEach, describe, expect, it } from "vitest";

import { projectView } from "../../src/read/project-view.ts";
import { inheritedTagsFor } from "../../src/read/tags.ts";
import { fetchTaskByUuid } from "../../src/read/queries.ts";
import {
  anytimeView,
  inboxView,
  isTodayMember,
  logbookView,
  somedayView,
  todayView,
  upcomingView,
} from "../../src/read/views.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagArea,
  tagTask,
} from "../fixtures/seed.ts";

const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02

let fx: FixtureDb;
afterEach(() => fx?.close());

describe("todayView", () => {
  it("splits Today vs This Evening; newer-entry cohorts first, todayIndex within", () => {
    fx = buildFixtureDb();
    // referenceDate defaults to startDate via COALESCE when unset — the
    // 07-02 cohort (t2) outranks the overdue 07-01 cohort (t1, promo).
    seedTodo(fx.db, { title: "t2", startDate: "2026-07-02", todayIndex: 20 });
    seedTodo(fx.db, { title: "t1", startDate: "2026-07-01", todayIndex: -50 }); // overdue stays in Today
    seedTodo(fx.db, { title: "e1", startDate: "2026-07-02", evening: true, todayIndex: 5 });
    seedTodo(fx.db, { title: "future", startDate: "2026-07-09", start: "someday" });
    seedTodo(fx.db, {
      title: "pending-promotion",
      start: "someday",
      startDate: "2026-07-01",
      todayIndex: 99,
    });
    seedTodo(fx.db, { title: "template", startDate: "2026-07-02", recurrenceRule: true });

    const view = todayView(fx.db, NOW);
    expect(view.today.map((i) => i.title)).toEqual(["t2", "t1", "pending-promotion"]);
    expect(view.evening.map((i) => i.title)).toEqual(["e1"]);
  });

  it("expires stale This Evening assignments back into Today proper (live-verified 2026-07-02)", () => {
    fx = buildFixtureDb();
    // Scheduled to This Evening on a PAST day and never done — the UI shows
    // it in Today proper, not This Evening (the 6 phantom items from 2025-01-13).
    seedTodo(fx.db, {
      title: "stale-evening",
      startDate: "2025-01-13",
      evening: true,
      todayIndex: 1,
    });
    seedTodo(fx.db, { title: "tonight", startDate: "2026-07-02", evening: true, todayIndex: 2 });

    const view = todayView(fx.db, NOW);
    expect(view.today.map((i) => i.title)).toEqual(["stale-evening"]);
    expect(view.evening.map((i) => i.title)).toEqual(["tonight"]);
    // raw assignment stays visible on the entity for both
    expect(view.today[0]?.todaySection).toBe("evening");
  });

  it("badge mirrors the sidebar: deadline due/overdue vs other", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "overdue-dl", startDate: "2026-07-01", deadline: "2026-06-30" });
    seedTodo(fx.db, { title: "due-today", startDate: "2026-07-01", deadline: "2026-07-02" });
    seedTodo(fx.db, { title: "future-dl", startDate: "2026-07-01", deadline: "2026-07-09" });
    seedTodo(fx.db, { title: "no-dl", startDate: "2026-07-01" });

    const view = todayView(fx.db, NOW);
    expect(view.badge).toEqual({ dueOrOverdue: 2, other: 2 });
  });

  it("a DUE deadline pulls items into Today, even from the Inbox (UI-oracle 2026-07-04)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "deadline-only", deadline: "2026-06-30" }); // overdue, no startDate
    seedTodo(fx.db, { title: "inbox-due", start: "inbox", deadline: "2026-07-02" });
    seedTodo(fx.db, { title: "deadline-future", deadline: "2026-07-09" }); // not yet due
    // A FUTURE startDate suppresses deadline membership (F-DL-FUTURE-START).
    seedTodo(fx.db, {
      title: "suppressed",
      start: "someday",
      startDate: "2026-07-10",
      deadline: "2026-06-30",
    });
    // A dismissed nag suppresses too (deadlineSuppressionDate = deadline;
    // all 12 live absentees carried it). An OLDER suppression from a prior
    // deadline does not.
    seedTodo(fx.db, {
      title: "nag-dismissed",
      deadline: "2026-06-30",
      deadlineSuppressionDate: "2026-06-30",
    });
    seedTodo(fx.db, {
      title: "old-suppression",
      deadline: "2026-07-01",
      deadlineSuppressionDate: "2026-06-20",
    });
    const view = todayView(fx.db, NOW);
    expect(view.today.map((i) => i.title).toSorted()).toEqual([
      "deadline-only",
      "inbox-due",
      "old-suppression",
    ]);
    expect(view.badge.dueOrOverdue).toBe(3);
  });

  it("orders by entry cohort (referenceDate DESC), then todayIndex, then uuid", () => {
    fx = buildFixtureDb();
    // Older cohort with a manual order; newer cohort added later sits ON TOP
    // even though its todayIndex values overlap (UI-oracle research runs
    // things-run-todayorder-20260704-021325 / -021640).
    seedTodo(fx.db, {
      uuid: "OLD-A",
      title: "old-a",
      startDate: "2026-06-30",
      todayIndex: -500,
      todayIndexReferenceDate: "2026-06-30",
    });
    seedTodo(fx.db, {
      uuid: "OLD-B",
      title: "old-b",
      startDate: "2026-06-30",
      todayIndex: 10,
      todayIndexReferenceDate: "2026-06-30",
    });
    seedTodo(fx.db, {
      uuid: "NEW-1",
      title: "new-1",
      startDate: "2026-07-02",
      todayIndex: -100,
      todayIndexReferenceDate: "2026-07-02",
    });
    // Same cohort + same todayIndex → uuid tiebreak (observed stable).
    seedTodo(fx.db, {
      uuid: "TIE-B",
      title: "tie-b",
      startDate: "2026-07-02",
      todayIndex: 0,
      todayIndexReferenceDate: "2026-07-02",
    });
    seedTodo(fx.db, {
      uuid: "TIE-A",
      title: "tie-a",
      startDate: "2026-07-02",
      todayIndex: 0,
      todayIndexReferenceDate: "2026-07-02",
    });
    const view = todayView(fx.db, NOW);
    expect(view.today.map((i) => i.title)).toEqual(["new-1", "tie-a", "tie-b", "old-a", "old-b"]);
  });
});

describe("list views", () => {
  it("routes items to inbox/anytime/upcoming/someday by (start, startDate)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "in-inbox", start: "inbox" });
    seedTodo(fx.db, { title: "unscheduled", start: "active", index: 1 });
    seedTodo(fx.db, {
      title: "scheduled-today",
      start: "active",
      startDate: "2026-07-02",
      index: 2,
    });
    seedTodo(fx.db, { title: "future", start: "someday", startDate: "2026-07-10" });
    seedTodo(fx.db, { title: "incubating", start: "someday" });

    expect(inboxView(fx.db).map((i) => i.title)).toEqual(["in-inbox"]);
    // Anytime mirrors the UI: unscheduled AND Today members (starred in UI)
    expect(anytimeView(fx.db, NOW).map((i) => i.title)).toEqual(["unscheduled", "scheduled-today"]);
    expect(upcomingView(fx.db, NOW).map((i) => i.title)).toEqual(["future"]);
    expect(somedayView(fx.db).map((i) => i.title)).toEqual(["incubating"]);
  });

  it("isTodayMember marks the UI star in Anytime", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "unscheduled", start: "active", index: 1 });
    seedTodo(fx.db, { title: "starred", start: "active", startDate: "2026-07-01", index: 2 });
    const items = anytimeView(fx.db, NOW);
    expect(items.map((i) => [i.title, isTodayMember(i, NOW)])).toEqual([
      ["unscheduled", false],
      ["starred", true],
    ]);
  });

  it("logbook orders by stopDate desc and excludes trashed", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "older", status: "completed", stopDate: 100 });
    seedTodo(fx.db, { title: "newer", status: "canceled", stopDate: 200 });
    seedTodo(fx.db, { title: "trashed-done", status: "completed", stopDate: 300, trashed: true });
    expect(logbookView(fx.db).map((i) => i.title)).toEqual(["newer", "older"]);
  });
});

describe("projectView", () => {
  it("segments active/headed/later/logged/trashed and dedupes heading children", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "LAB-AREA-A");
    const project = seedProject(fx.db, { title: "Launch", area });
    const heading = seedHeading(fx.db, { title: "Phase 1", project });
    seedTodo(fx.db, { title: "active-1", project, index: 2 });
    // DB invariant: headed to-dos have project = NULL
    seedTodo(fx.db, { title: "headed-1", heading, project: null, index: 1 });
    seedTodo(fx.db, { title: "sched", project, startDate: "2026-07-05", start: "someday" });
    seedTodo(fx.db, {
      title: "sched-same-day",
      project,
      startDate: "2026-07-05",
      start: "someday",
    });
    seedTodo(fx.db, { title: "incub", project, start: "someday" });
    seedTodo(fx.db, { title: "tpl", project, recurrenceRule: true });
    seedTodo(fx.db, { title: "done", project, status: "completed", stopDate: 50 });
    seedTodo(fx.db, { title: "junk", project, trashed: true });

    const view = projectView(fx.db, project, NOW);
    expect(view.project.title).toBe("Launch");
    expect(view.active.map((i) => i.title)).toEqual(["active-1"]);
    expect(view.headings).toHaveLength(1);
    expect(view.headings[0]?.items.map((i) => i.title)).toEqual(["headed-1"]);
    expect(view.later.scheduled).toEqual([expect.objectContaining({ date: "2026-07-05" })]);
    expect(view.later.scheduled[0]?.items).toHaveLength(2);
    expect(view.later.repeating.map((i) => i.title)).toEqual(["tpl"]);
    expect(view.later.someday.map((i) => i.title)).toEqual(["incub"]);
    expect(view.logged.map((i) => i.title)).toEqual(["done"]);
    expect(view.trashed.map((i) => i.title)).toEqual(["junk"]);
  });
});

describe("inherited tags", () => {
  it("collects area + project tags through the heading chain, excluding direct tags", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Area");
    const areaTag = seedTag(fx.db, "area-tag");
    tagArea(fx.db, area, areaTag);
    const project = seedProject(fx.db, { title: "P", area });
    const projTag = seedTag(fx.db, "proj-tag");
    tagTask(fx.db, project, projTag);
    const heading = seedHeading(fx.db, { title: "H", project });
    const todo = seedTodo(fx.db, { title: "child", heading, project: null });
    const directTag = seedTag(fx.db, "direct");
    tagTask(fx.db, todo, directTag);

    const row = fetchTaskByUuid(fx.db, todo);
    expect(row).not.toBeNull();
    const inherited = inheritedTagsFor(fx.db, row as NonNullable<typeof row>);
    expect(inherited.map((t) => t.title).sort()).toEqual(["area-tag", "proj-tag"]);
  });
});

describe("tag-filtered list views (Phase 10)", () => {
  function seedTagChain() {
    fx = buildFixtureDb();
    const tag = seedTag(fx.db, "focus");
    const area = seedArea(fx.db, "Work");
    tagArea(fx.db, area, tag);
    const proj = seedProject(fx.db, { title: "P", area, startDate: "2026-07-02" });
    const heading = seedHeading(fx.db, { title: "H", project: proj });
    // Membership through every hop of the inheritance chain:
    const direct = seedTodo(fx.db, { title: "direct", startDate: "2026-07-02" });
    tagTask(fx.db, direct, tag);
    seedTodo(fx.db, { title: "via-project", project: proj, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "via-area", area, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "via-heading", heading, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "unrelated", startDate: "2026-07-02" });
    return { tag };
  }

  it("today: matches direct + inherited through project/area/heading, excludes the rest", () => {
    seedTagChain();
    const view = todayView(fx.db, NOW, { tag: "focus" });
    const titles = [...view.today, ...view.evening].map((i) => i.title).toSorted();
    // "P" itself is area-tagged too (projects are list items in Today).
    expect(titles).toEqual(["P", "direct", "via-area", "via-heading", "via-project"]);
  });

  it("resolves by uuid too, and unfiltered views are unchanged", () => {
    const { tag } = seedTagChain();
    const byUuid = todayView(fx.db, NOW, { tag });
    expect(byUuid.today.map((i) => i.title)).toContain("direct");
    expect(todayView(fx.db, NOW).today.map((i) => i.title)).toContain("unrelated");
  });

  it("throws loudly on unknown or ambiguous tag references", () => {
    seedTagChain();
    expect(() => todayView(fx.db, NOW, { tag: "nope" })).toThrow(/tag not found/);
    seedTag(fx.db, "focus"); // duplicate title
    expect(() => todayView(fx.db, NOW, { tag: "focus" })).toThrow(/ambiguous/);
  });

  it("filters anytime/someday/logbook the same way", () => {
    seedTagChain();
    seedTodo(fx.db, { title: "done-tagged", status: "completed", stopDate: 1_780_000_100 });
    expect(anytimeView(fx.db, NOW, { tag: "focus" }).map((i) => i.title)).not.toContain(
      "unrelated",
    );
    expect(somedayView(fx.db, { tag: "focus" })).toEqual([]);
    expect(logbookView(fx.db, { tag: "focus" }).map((i) => i.title)).not.toContain("done-tagged");
  });
});
