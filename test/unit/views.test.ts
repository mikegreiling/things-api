import { afterEach, describe, expect, it } from "vitest";

import { areaView } from "../../src/read/area-view.ts";
import { projectView } from "../../src/read/project-view.ts";
import { inheritedTagsFor } from "../../src/read/tags.ts";
import { fetchTaskByUuid } from "../../src/read/queries.ts";
import {
  anytimeView,
  type SidebarSection,
  changesView,
  inboxView,
  isTodayMember,
  liteTitleSearch,
  logbookView,
  searchView,
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

/** Flattens grouped anytime/someday sections back to items for membership checks. */
const flat = (sections: SidebarSection[]) => sections.flatMap((s) => s.items);

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

  it("eveningOnly keeps the view shape: today empty, evening populated, badge over evening", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "day", startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "night", startDate: "2026-07-02", evening: true });
    seedTodo(fx.db, {
      title: "night-due",
      startDate: "2026-07-02",
      deadline: "2026-07-02",
      evening: true,
    });

    const view = todayView(fx.db, NOW, { eveningOnly: true });
    expect(view.today).toEqual([]);
    expect(view.evening.map((i) => i.title).toSorted()).toEqual(["night", "night-due"]);
    // Badge counts only the evening members (mirrors the tag filter's badge).
    expect(view.badge).toEqual({ dueOrOverdue: 1, other: 1 });
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
    expect(flat(anytimeView(fx.db, NOW)).map((i) => i.title)).toEqual([
      "unscheduled",
      "scheduled-today",
    ]);
    expect(upcomingView(fx.db, NOW).map((i) => i.title)).toEqual(["future"]);
    expect(flat(somedayView(fx.db)).map((i) => i.title)).toEqual(["incubating"]);
  });

  it("isTodayMember marks the UI star in Anytime", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "unscheduled", start: "active", index: 1 });
    seedTodo(fx.db, { title: "starred", start: "active", startDate: "2026-07-01", index: 2 });
    const items = flat(anytimeView(fx.db, NOW));
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

describe("upcomingView deadline-forecast cohort (UPC1)", () => {
  it("forecasts future-deadline anytime/someday to-dos and someday projects under the DEADLINE date, excludes Inbox", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "anytime-dl", start: "active", deadline: "2026-07-20" });
    seedTodo(fx.db, { title: "someday-dl", start: "someday", deadline: "2026-07-22" });
    seedProject(fx.db, { title: "someday-proj-dl", start: "someday", deadline: "2026-07-25" });
    seedTodo(fx.db, { title: "inbox-dl", start: "inbox", deadline: "2026-07-21" });
    // A future startDate is the SCHEDULED cohort, not forecast — control.
    seedTodo(fx.db, { title: "scheduled", start: "someday", startDate: "2026-07-15" });

    const items = upcomingView(fx.db, NOW);
    expect(items.map((i) => i.title)).toEqual([
      "scheduled", // when-date 07-15
      "anytime-dl", // deadline 07-20
      "someday-dl", // deadline 07-22
      "someday-proj-dl", // deadline 07-25
    ]);
    expect(items.map((i) => i.title)).not.toContain("inbox-dl");
    // JSON honesty: forecast rows keep startDate null (no faked when-date).
    const forecast = items.filter((i) => i.title !== "scheduled");
    expect(forecast.every((i) => i.startDate === null)).toBe(true);
    expect(forecast.every((i) => i.deadline !== null)).toBe(true);
  });

  it("drops a suppressed (dismissed-nag) deadline, keeps a re-armed one", () => {
    fx = buildFixtureDb();
    // supp == deadline: the reschedule-to-someday nag dismissal — ABSENT.
    seedTodo(fx.db, {
      title: "suppressed",
      start: "someday",
      deadline: "2026-07-20",
      deadlineSuppressionDate: "2026-07-20",
    });
    // supp < deadline: a stale suppression from a prior, earlier deadline that
    // was re-armed to a later date — PRESENT.
    seedTodo(fx.db, {
      title: "re-armed",
      start: "someday",
      deadline: "2026-07-22",
      deadlineSuppressionDate: "2026-07-01",
    });
    const titles = upcomingView(fx.db, NOW).map((i) => i.title);
    expect(titles).toEqual(["re-armed"]);
  });

  it("a when+deadline row appears ONCE under its when-date, never double-emitted", () => {
    fx = buildFixtureDb();
    // startDate (when) 07-20, deadline earlier at 07-10 — groups under the WHEN
    // date and the deadline rides as a flag; NOT also emitted at its deadline.
    seedTodo(fx.db, {
      title: "when-and-deadline",
      start: "someday",
      startDate: "2026-07-20",
      deadline: "2026-07-10",
    });
    const items = upcomingView(fx.db, NOW);
    expect(items.map((i) => i.title)).toEqual(["when-and-deadline"]);
    expect(items[0]?.startDate).toBe("2026-07-20");
    expect(items[0]?.deadline).toBe("2026-07-10");
  });

  it("--until clips forecast rows by their DEADLINE (their appearance date)", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "inside-dl", start: "someday", deadline: "2026-07-20" });
    seedTodo(fx.db, { title: "outside-dl", start: "someday", deadline: "2026-09-01" });
    const titles = upcomingView(fx.db, NOW, { until: "2026-08-05" }).map((i) => i.title);
    expect(titles).toContain("inside-dl");
    expect(titles).not.toContain("outside-dl");
  });

  it("--since skips forecast rows whose deadline is before the bound", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "early-dl", start: "someday", deadline: "2026-07-20" });
    seedTodo(fx.db, { title: "late-dl", start: "someday", deadline: "2026-09-01" });
    const titles = upcomingView(fx.db, NOW, { since: "2026-08-01" }).map((i) => i.title);
    expect(titles).not.toContain("early-dl");
    expect(titles).toContain("late-dl");
  });

  it("forecast rows survive repeats:false (they are not templates) and merge with scheduled rows", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "forecast", start: "active", deadline: "2026-07-20" });
    seedTodo(fx.db, { title: "scheduled", start: "someday", startDate: "2026-07-15" });
    seedTodo(fx.db, {
      title: "template",
      recurrenceRule: true,
      nextInstanceStartDate: "2026-07-18",
    });
    const titles = upcomingView(fx.db, NOW, { repeats: false }).map((i) => i.title);
    expect(titles).toEqual(["scheduled", "forecast"]); // template synthesis suppressed
  });
});

describe("anytime container cascade + sidebar grouping", () => {
  it("excludes children of someday/future-scheduled projects (the project row represents them)", () => {
    fx = buildFixtureDb();
    const somedayProj = seedProject(fx.db, { title: "sd-proj", start: "someday" });
    seedTodo(fx.db, { title: "hidden-sd-child", project: somedayProj });
    const futureProj = seedProject(fx.db, {
      title: "future-proj",
      start: "someday",
      startDate: "2026-07-10",
    });
    seedTodo(fx.db, { title: "hidden-future-child", project: futureProj });
    const activeProj = seedProject(fx.db, { title: "active-proj" });
    seedTodo(fx.db, { title: "visible-child", project: activeProj });

    const titles = flat(anytimeView(fx.db, NOW)).map((i) => i.title);
    expect(titles).toContain("active-proj");
    expect(titles).toContain("visible-child");
    expect(titles).not.toContain("sd-proj");
    expect(titles).not.toContain("hidden-sd-child");
    expect(titles).not.toContain("hidden-future-child");
  });

  it("cascades through headings (a headed child reaches its project via the heading row)", () => {
    fx = buildFixtureDb();
    const somedayProj = seedProject(fx.db, { title: "sd-proj", start: "someday" });
    const h1 = seedHeading(fx.db, { title: "H1", project: somedayProj });
    seedTodo(fx.db, { title: "headed-hidden", heading: h1 }); // project = NULL by invariant
    const activeProj = seedProject(fx.db, { title: "active-proj" });
    const h2 = seedHeading(fx.db, { title: "H2", project: activeProj });
    seedTodo(fx.db, { title: "headed-visible", heading: h2 });

    const titles = flat(anytimeView(fx.db, NOW)).map((i) => i.title);
    expect(titles).toContain("headed-visible");
    expect(titles).not.toContain("headed-hidden");
  });

  it("groups in sidebar order: top-level block first, then areas by index; direct to-dos before project blocks", () => {
    fx = buildFixtureDb();
    const areaB = seedArea(fx.db, "B-Area", 2);
    const areaA = seedArea(fx.db, "A-Area", 1);
    seedTodo(fx.db, { title: "loose", index: 50 });
    const topProj = seedProject(fx.db, { title: "top-proj", index: 9 });
    seedTodo(fx.db, { title: "top-proj-child", project: topProj, index: 1 });
    seedTodo(fx.db, { title: "areaB-direct", area: areaB, index: 1 });
    seedTodo(fx.db, { title: "areaA-direct", area: areaA, index: 7 });
    const projA = seedProject(fx.db, { title: "proj-in-A", area: areaA, index: 3 });
    const hA = seedHeading(fx.db, { title: "HA", project: projA });
    seedTodo(fx.db, { title: "projA-headed-child", heading: hA, index: 1 });

    const sections = anytimeView(fx.db, NOW);
    expect(sections.map((s) => s.area?.title ?? null)).toEqual([null, "A-Area", "B-Area"]);
    expect(sections[0]?.items.map((i) => i.title)).toEqual(["loose", "top-proj", "top-proj-child"]);
    expect(sections[1]?.items.map((i) => i.title)).toEqual([
      "areaA-direct",
      "proj-in-A",
      "projA-headed-child",
    ]);
    expect(sections[2]?.items.map((i) => i.title)).toEqual(["areaB-direct"]);
  });

  it("someday hides project children by default; activeProjectItems adds active-project ones only", () => {
    fx = buildFixtureDb();
    const activeProj = seedProject(fx.db, { title: "active-proj" });
    seedTodo(fx.db, { title: "sd-in-active", project: activeProj, start: "someday" });
    const somedayProj = seedProject(fx.db, { title: "sd-proj", start: "someday" });
    seedTodo(fx.db, { title: "sd-in-sd", project: somedayProj, start: "someday" });
    seedTodo(fx.db, { title: "sd-loose", start: "someday" });

    // GUI order: project rows first within a group, then direct to-dos.
    expect(flat(somedayView(fx.db, NOW)).map((i) => i.title)).toEqual(["sd-proj", "sd-loose"]);
    const withActive = flat(somedayView(fx.db, NOW, { activeProjectItems: true })).map(
      (i) => i.title,
    );
    expect(withActive).toContain("sd-in-active");
    expect(withActive).not.toContain("sd-in-sd");
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
    expect(flat(anytimeView(fx.db, NOW, { tag: "focus" })).map((i) => i.title)).not.toContain(
      "unrelated",
    );
    expect(somedayView(fx.db, NOW, { tag: "focus" })).toEqual([]);
    expect(logbookView(fx.db, { tag: "focus" }).map((i) => i.title)).not.toContain("done-tagged");
  });
});

describe("tag-hierarchy descendants (Phase 12)", () => {
  it("--tag parent matches child- and grandchild-tagged items (documented UI behavior)", () => {
    fx = buildFixtureDb();
    const parent = seedTag(fx.db, "errands");
    const child = seedTag(fx.db, "groceries", parent);
    const grandchild = seedTag(fx.db, "farmers-market", child);
    const sibling = seedTag(fx.db, "calls"); // unrelated root

    const direct = seedTodo(fx.db, { title: "direct", startDate: "2026-07-02" });
    tagTask(fx.db, direct, parent);
    const viaChild = seedTodo(fx.db, { title: "via-child", startDate: "2026-07-02" });
    tagTask(fx.db, viaChild, child);
    const viaGrandchild = seedTodo(fx.db, { title: "via-grandchild", startDate: "2026-07-02" });
    tagTask(fx.db, viaGrandchild, grandchild);
    const unrelated = seedTodo(fx.db, { title: "unrelated", startDate: "2026-07-02" });
    tagTask(fx.db, unrelated, sibling);

    const titles = todayView(fx.db, NOW, { tag: "errands" })
      .today.map((i) => i.title)
      .toSorted();
    expect(titles).toEqual(["direct", "via-child", "via-grandchild"]);
    // Filtering by the CHILD does not match parent-tagged items (downward only).
    expect(
      todayView(fx.db, NOW, { tag: "groceries" })
        .today.map((i) => i.title)
        .toSorted(),
    ).toEqual(["via-child", "via-grandchild"]);
  });
});

describe('untagged filter (GUI "No Tag")', () => {
  // One world exercising every inheritance hop the positive --tag path covers,
  // so the inversion is proven against the SAME relations (not just direct
  // assignments). Bare rows carry no tag by any hop and must survive.
  function seedUntaggedWorld() {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const work = seedArea(fx.db, "Work"); // area-tagged
    tagArea(fx.db, work, focus);
    const home = seedArea(fx.db, "Home"); // untagged area
    // Projects sit in Someday so they never pollute the Today list.
    const tagged = seedProject(fx.db, { title: "Ptag", area: home, start: "someday" });
    tagTask(fx.db, tagged, focus); // direct-tagged project
    const heading = seedHeading(fx.db, { title: "H", project: tagged });
    const bareProject = seedProject(fx.db, { title: "Pbare", area: home, start: "someday" });

    const D = "2026-07-02";
    // Tagged by each hop — every one must be EXCLUDED by --untagged:
    const direct = seedTodo(fx.db, { title: "wid direct", startDate: D });
    tagTask(fx.db, direct, focus);
    seedTodo(fx.db, { title: "wid via-project", project: tagged, startDate: D });
    seedTodo(fx.db, { title: "wid via-area", area: work, startDate: D });
    seedTodo(fx.db, { title: "wid via-heading", heading, startDate: D });
    // Genuinely bare — must be INCLUDED:
    seedTodo(fx.db, { title: "wid bare", startDate: D });
    seedTodo(fx.db, { title: "wid in-bare-project", project: bareProject, startDate: D });
    seedTodo(fx.db, { title: "wid in-bare-area", area: home, startDate: D });
    return { focus };
  }

  it("today: keeps only genuinely bare items, dropping direct + every inherited hop", () => {
    seedUntaggedWorld();
    const titles = todayView(fx.db, NOW, { untagged: true })
      .today.map((i) => i.title)
      .toSorted();
    expect(titles).toEqual(["wid bare", "wid in-bare-area", "wid in-bare-project"]);
  });

  it("is the exact inversion of --tag on the same view (partition, no overlap)", () => {
    seedUntaggedWorld();
    const all = todayView(fx.db, NOW).today.map((i) => i.title);
    const tagged = todayView(fx.db, NOW, { tag: "focus" }).today.map((i) => i.title);
    const untagged = todayView(fx.db, NOW, { untagged: true }).today.map((i) => i.title);
    // Every Today row is in exactly one side; the two sides are disjoint and cover all.
    expect([...tagged, ...untagged].toSorted()).toEqual([...all].toSorted());
    expect(tagged.filter((t) => untagged.includes(t))).toEqual([]);
  });

  it("search: narrows a needle to the untagged matches", () => {
    seedUntaggedWorld();
    const titles = searchView(fx.db, "wid", { untagged: true })
      .map((i) => i.title)
      .toSorted();
    expect(titles).toEqual(["wid bare", "wid in-bare-area", "wid in-bare-project"]);
  });

  it("filters grouped someday the same way (direct tag excluded, bare kept)", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const taggedSomeday = seedTodo(fx.db, { title: "someday tagged", start: "someday" });
    tagTask(fx.db, taggedSomeday, focus);
    seedTodo(fx.db, { title: "someday bare", start: "someday" });
    const titles = flat(somedayView(fx.db, NOW, { untagged: true }))
      .map((i) => i.title)
      .toSorted();
    expect(titles).toEqual(["someday bare"]);
  });
});

describe("searchView (Phase 12 ergonomics)", () => {
  function seedSearchWorld() {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Work");
    const proj = seedProject(fx.db, { title: "Widget launch", area });
    const heading = seedHeading(fx.db, { title: "H", project: proj });
    const tag = seedTag(fx.db, "focus");
    const open1 = seedTodo(fx.db, { title: "widget spec", project: proj });
    seedTodo(fx.db, { title: "widget kickoff", heading }); // headed child of proj
    seedTodo(fx.db, { title: "widget for home", area });
    const done = seedTodo(fx.db, { title: "widget retro", status: "completed" });
    seedTodo(fx.db, { title: "widget scrap", trashed: true });
    seedTodo(fx.db, { title: "unrelated note", notes: "mentions widget here" });
    seedTodo(fx.db, { title: "widget template", recurrenceRule: true });
    tagTask(fx.db, open1, tag);
    return { proj, area, done };
  }

  it("defaults to OPEN + untrashed; notes match; templates excluded", () => {
    seedSearchWorld();
    const titles = searchView(fx.db, "widget")
      .map((i) => i.title)
      .toSorted();
    expect(titles).toEqual([
      "Widget launch",
      "unrelated note",
      "widget for home",
      "widget kickoff",
      "widget spec",
    ]);
  });

  it("--logged / --trashed / --all widen the scope", () => {
    seedSearchWorld();
    expect(searchView(fx.db, "widget", { logged: true }).map((i) => i.title)).toContain(
      "widget retro",
    );
    expect(searchView(fx.db, "widget", { trashed: true }).map((i) => i.title)).toContain(
      "widget scrap",
    );
    const all = searchView(fx.db, "widget", { all: true }).map((i) => i.title);
    expect(all).toContain("widget retro");
    expect(all).toContain("widget scrap");
  });

  it("scopes by project (headed children included), area, tag, and type", () => {
    const { proj, area } = seedSearchWorld();
    expect(
      searchView(fx.db, "widget", { project: proj })
        .map((i) => i.title)
        .toSorted(),
    ).toEqual(["widget kickoff", "widget spec"]);
    expect(searchView(fx.db, "widget", { project: "Widget launch" })).toHaveLength(2);
    expect(
      searchView(fx.db, "widget", { area })
        .map((i) => i.title)
        .toSorted(),
    ).toEqual(["Widget launch", "widget for home"]);
    expect(searchView(fx.db, "widget", { tag: "focus" }).map((i) => i.title)).toEqual([
      "widget spec",
    ]);
    expect(searchView(fx.db, "widget", { type: "project" }).map((i) => i.title)).toEqual([
      "Widget launch",
    ]);
  });

  it("honors --limit and fails loudly on unknown refs", () => {
    seedSearchWorld();
    expect(searchView(fx.db, "widget", { limit: 2 })).toHaveLength(2);
    expect(() => searchView(fx.db, "widget", { project: "nope" })).toThrow(/project not found/);
    expect(() => searchView(fx.db, "widget", { area: "nope" })).toThrow(/area not found/);
    expect(() => searchView(fx.db, "widget", { tag: "nope" })).toThrow(/tag not found/);
  });
});

describe("searchView heading doctrine + ranking (item 5)", () => {
  it("a heading-title match surfaces the PARENT PROJECT (matchedVia), never a bare heading", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "Arcade Restoration", index: 1 });
    seedHeading(fx.db, { title: "Fix OutRun Steering Wheel", project: proj });
    seedTodo(fx.db, { title: "buy paint", project: proj });

    const hits = searchView(fx.db, "OutRun");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.type).toBe("project");
    expect(hits[0]?.title).toBe("Arcade Restoration");
    expect(hits[0]?.matchedVia).toEqual({ kind: "heading", title: "Fix OutRun Steering Wheel" });
  });

  it("a project matched by its own title/notes never carries a redundant matchedVia", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "OutRun cabinet", index: 1 });
    seedHeading(fx.db, { title: "OutRun wiring", project: proj });
    const hits = searchView(fx.db, "OutRun");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedVia).toBeUndefined();
  });

  it("heading matches do not apply to a --type todo search", () => {
    fx = buildFixtureDb();
    const proj = seedProject(fx.db, { title: "Arcade", index: 1 });
    seedHeading(fx.db, { title: "OutRun bits", project: proj });
    expect(searchView(fx.db, "OutRun", { type: "to-do" })).toHaveLength(0);
  });

  it("ranks title > notes; field trumps status (someday title beats active notes)", () => {
    fx = buildFixtureDb();
    // active NOTES match, most recently modified
    seedTodo(fx.db, {
      title: "alpha active",
      notes: "mentions zeta",
      start: "active",
      modificationDate: 1_790_000_000,
    });
    // someday TITLE match, older
    seedTodo(fx.db, { title: "zeta someday", start: "someday", modificationDate: 1_700_000_000 });
    const titles = searchView(fx.db, "zeta").map((i) => i.title);
    expect(titles).toEqual(["zeta someday", "alpha active"]);
  });

  it("ranks projects above to-dos, then most-recently-modified within a tier", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "kappa todo", modificationDate: 1_790_000_000 });
    seedProject(fx.db, { title: "kappa proj", modificationDate: 1_700_000_000, index: 1 });
    const titles = searchView(fx.db, "kappa").map((i) => i.title);
    expect(titles).toEqual(["kappa proj", "kappa todo"]);
  });
});

describe("liteTitleSearch (did-you-mean fallback)", () => {
  function seedWorld() {
    fx = buildFixtureDb();
    seedArea(fx.db, "Hobby Corner");
    seedProject(fx.db, { title: "Hobby Firmware", index: 1 });
    seedTodo(fx.db, { title: "hobby solder", modificationDate: 1_790_000_000 });
    seedTodo(fx.db, { title: "hobby archived", status: "completed" });
    seedTodo(fx.db, { title: "unrelated", notes: "hobby appears only in notes" });
  }

  it("matches TITLES only (never notes); containers first, then to-dos; open only", () => {
    seedWorld();
    const { candidates } = liteTitleSearch(fx.db, "hobby");
    const labels = candidates.map((c) => (c.kind === "area" ? c.area.title : c.task.title));
    // Area + project first, then the open to-do; the notes-only + logged rows excluded.
    expect(labels).toEqual(["Hobby Corner", "Hobby Firmware", "hobby solder"]);
  });

  it("type scope narrows to one class", () => {
    seedWorld();
    expect(liteTitleSearch(fx.db, "hobby", { type: "area" }).candidates.map((c) => c.kind)).toEqual(
      ["area"],
    );
    expect(
      liteTitleSearch(fx.db, "hobby", { type: "project" }).candidates.map((c) =>
        c.kind === "task" ? c.task.title : c.kind,
      ),
    ).toEqual(["Hobby Firmware"]);
    expect(liteTitleSearch(fx.db, "hobby", { type: "to-do" }).candidates).toHaveLength(1);
  });

  it("reports the pre-cap total and caps the returned rows", () => {
    fx = buildFixtureDb();
    for (let i = 0; i < 15; i++) seedTodo(fx.db, { title: `match ${i}`, index: i });
    const { candidates, total } = liteTitleSearch(fx.db, "match", { limit: 10 });
    expect(candidates).toHaveLength(10);
    expect(total).toBe(15);
  });

  it("a miss returns no candidates, total 0", () => {
    seedWorld();
    expect(liteTitleSearch(fx.db, "zzz")).toEqual({ candidates: [], total: 0 });
  });
});

describe("tag descendant closure safety", () => {
  it("terminates on a parent CYCLE in tag data (UNION dedupe)", () => {
    fx = buildFixtureDb();
    const a = seedTag(fx.db, "cycle-a");
    const b = seedTag(fx.db, "cycle-b", a);
    fx.db.prepare("UPDATE TMTag SET parent = ? WHERE uuid = ?").run(b, a); // a↔b cycle
    const item = seedTodo(fx.db, { title: "cycled", startDate: "2026-07-02" });
    tagTask(fx.db, item, b);
    const view = todayView(fx.db, NOW, { tag: "cycle-a" });
    expect(view.today.map((i) => i.title)).toEqual(["cycled"]);
  });
});

describe("exact-tag filtering (Phase 12c)", () => {
  it("exactTag matches the named tag only, excluding descendants", () => {
    fx = buildFixtureDb();
    const parent = seedTag(fx.db, "errands");
    const child = seedTag(fx.db, "groceries", parent);
    const direct = seedTodo(fx.db, { title: "direct", startDate: "2026-07-02" });
    tagTask(fx.db, direct, parent);
    const viaChild = seedTodo(fx.db, { title: "via-child", startDate: "2026-07-02" });
    tagTask(fx.db, viaChild, child);

    expect(
      todayView(fx.db, NOW, { tag: "errands", exactTag: true }).today.map((i) => i.title),
    ).toEqual(["direct"]);
    // Default (descendants) still matches both.
    expect(
      todayView(fx.db, NOW, { tag: "errands" })
        .today.map((i) => i.title)
        .toSorted(),
    ).toEqual(["direct", "via-child"]);
    // exactTag still honors area/project INHERITANCE (orthogonal dimension).
    const area = seedArea(fx.db, "Work");
    tagArea(fx.db, area, parent);
    seedTodo(fx.db, { title: "via-area", area, startDate: "2026-07-02" });
    expect(
      todayView(fx.db, NOW, { tag: "errands", exactTag: true })
        .today.map((i) => i.title)
        .toSorted(),
    ).toEqual(["direct", "via-area"]);
    // And search takes it through SearchOptions.
    expect(
      searchView(fx.db, "via", { tag: "errands", exactTag: true }).map((i) => i.title),
    ).toEqual(["via-area"]);
  });
});

describe("changesView (Phase 13)", () => {
  it("returns created vs modified since a moment, including trashed/logged/templates", () => {
    fx = buildFixtureDb();
    const SINCE = 1_790_000_000; // epoch seconds
    seedTodo(fx.db, {
      title: "old-untouched",
      creationDate: SINCE - 100,
      modificationDate: SINCE - 50,
    });
    seedTodo(fx.db, {
      title: "edited-after",
      creationDate: SINCE - 100,
      modificationDate: SINCE + 10,
    });
    seedTodo(fx.db, {
      title: "born-after",
      creationDate: SINCE + 20,
      modificationDate: SINCE + 20,
    });
    seedTodo(fx.db, {
      title: "trashed-after",
      trashed: true,
      creationDate: SINCE - 100,
      modificationDate: SINCE + 30,
    });
    seedTodo(fx.db, {
      title: "template-edited",
      recurrenceRule: true,
      creationDate: SINCE - 100,
      modificationDate: SINCE + 40,
    });

    const changes = changesView(fx.db, { since: new Date(SINCE * 1000) });
    expect(changes.map((c) => [c.title, c.changeKind])).toEqual([
      ["template-edited", "modified"],
      ["trashed-after", "modified"],
      ["born-after", "created"],
      ["edited-after", "modified"],
    ]);
    expect(changes.find((c) => c.title === "trashed-after")?.trashed).toBe(true);
    expect(changes.find((c) => c.title === "template-edited")?.repeating.isTemplate).toBe(true);
    expect(changesView(fx.db, { since: new Date(SINCE * 1000), limit: 2 })).toHaveLength(2);
  });
});

describe("areaView", () => {
  it("segments active/projects/later/logged; resolves by title; sidebar project order", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Home");
    seedTodo(fx.db, { title: "active-1", area, index: 2 });
    seedTodo(fx.db, { title: "sched", area, startDate: "2026-07-09", start: "someday" });
    seedTodo(fx.db, { title: "incub", area, start: "someday" });
    seedTodo(fx.db, { title: "done", area, status: "completed", stopDate: 100 });
    seedProject(fx.db, { title: "proj-b", area, index: 9 });
    seedProject(fx.db, { title: "proj-a", area, index: 3 });
    seedProject(fx.db, { title: "elsewhere" });

    const view = areaView(fx.db, "Home", NOW);
    expect(view.area.title).toBe("Home");
    expect(view.active.map((i) => i.title)).toEqual(["active-1"]);
    expect(view.projects.map((i) => i.title)).toEqual(["proj-a", "proj-b"]);
    expect(view.later.scheduled[0]?.items.map((i) => i.title)).toEqual(["sched"]);
    expect(view.later.someday.map((i) => i.title)).toEqual(["incub"]);
    expect(view.logged.map((i) => i.title)).toEqual(["done"]);
  });

  it("throws on unknown and ambiguous area references", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Dup");
    seedArea(fx.db, "Dup");
    expect(() => areaView(fx.db, "Nope", NOW)).toThrow(/not found/);
    expect(() => areaView(fx.db, "Dup", NOW)).toThrow(/ambiguous/);
  });
});

describe("resolveTaskUuidPrefix", () => {
  it("resolves unique prefixes, prefers exact matches, errors on short/ambiguous/unknown", async () => {
    const { resolveTaskUuidPrefix } = await import("../../src/read/queries.ts");
    fx = buildFixtureDb();
    seedTodo(fx.db, { uuid: "ABCDEF1234567890AAAAAA", title: "one" });
    seedTodo(fx.db, { uuid: "ABCXYZ1234567890BBBBBB", title: "two" });
    // a full uuid that is also a strict prefix of a longer one
    seedTodo(fx.db, { uuid: "SHORTUUID111111111111", title: "short" });
    seedTodo(fx.db, { uuid: "SHORTUUID1111111111112", title: "longer" });

    expect(resolveTaskUuidPrefix(fx.db, "ABCDEF")).toBe("ABCDEF1234567890AAAAAA");
    expect(resolveTaskUuidPrefix(fx.db, "ABCXYZ123")).toBe("ABCXYZ1234567890BBBBBB");
    // exact match wins over prefix ambiguity
    expect(resolveTaskUuidPrefix(fx.db, "SHORTUUID111111111111")).toBe("SHORTUUID111111111111");
    expect(() => resolveTaskUuidPrefix(fx.db, "ABC")).toThrow(/at least 6/);
    expect(() => resolveTaskUuidPrefix(fx.db, "ABCDEF1234567890ZZZZ99")).toThrow(/no record/);
    fx.db.exec("DELETE FROM TMTask WHERE uuid = 'SHORTUUID111111111111'");
    seedTodo(fx.db, { uuid: "ABCDEG9999999999CCCCCC", title: "three" });
    expect(() => resolveTaskUuidPrefix(fx.db, "ABCDE9")).toThrow(/no record/);
    expect(() => resolveTaskUuidPrefix(fx.db, "ABC" + "DE".repeat(2))).toThrow(
      /ambiguous|no record/,
    );
  });
});
