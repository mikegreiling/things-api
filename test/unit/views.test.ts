import { afterEach, describe, expect, it } from "vitest";

import type { Ref } from "../../src/model/entities.ts";
import { areaView } from "../../src/read/area-view.ts";
import { projectView } from "../../src/read/project-view.ts";
import { areaTags, inheritedTagsFor, tagsView } from "../../src/read/tags.ts";
import {
  directTagScopeSql,
  directUntaggedScopeSql,
  fetchTaskByUuid,
  tagScopeBinds,
  tagScopeSql,
  untaggedScopeSql,
} from "../../src/read/queries.ts";
import { byUuid } from "../../src/read/detail.ts";
import { getField } from "../../src/write/verify/delta.ts";
import {
  anytimeView,
  type SidebarSection,
  changesView,
  inboxView,
  isTodayMember,
  liteTitleSearch,
  logbookView,
  projectsView,
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
  seedSettings,
  seedTag,
  seedTodo,
  tagArea,
  tagTask,
} from "../fixtures/seed.ts";

const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02
const NOW_EPOCH = NOW.getTime() / 1000;

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

  // GUI-parity ruling 2026-07-14 (Mike): Today shows CHECKED-BUT-UNSWEPT rows —
  // a completed/canceled item the log-move sweep has not passed stays checked
  // IN PLACE (completion ≠ logged), leaving only when the boundary advances.
  it("keeps a checked-but-unswept row in its slot; it leaves once the sweep passes", () => {
    fx = buildFixtureDb();
    // Manual boundary at yesterday noon: a stopDate after it is unswept.
    seedSettings(fx.db, { logInterval: 4, manualLogDate: NOW_EPOCH - 86400 });
    seedTodo(fx.db, { title: "open-a", startDate: "2026-07-02", todayIndex: 10 });
    seedTodo(fx.db, {
      title: "checked",
      startDate: "2026-07-02",
      todayIndex: 20,
      status: "completed",
      stopDate: NOW_EPOCH,
    });
    seedTodo(fx.db, { title: "open-b", startDate: "2026-07-02", todayIndex: 30 });

    // Before the sweep: the checked row keeps its comparator slot (todayIndex).
    const before = todayView(fx.db, NOW);
    expect(before.today.map((i) => i.title)).toEqual(["open-a", "checked", "open-b"]);
    const checked = before.today.find((i) => i.title === "checked");
    expect(checked?.status).toBe("completed"); // JSON surfaces the real status
    expect(checked?.logged).toBe(false); // unswept, so not logged

    // Advance the boundary past the checked row's stopDate → it is swept away.
    fx.db.prepare("UPDATE TMSettings SET manualLogDate = ?").run(NOW_EPOCH + 60);
    const after = todayView(fx.db, NOW);
    expect(after.today.map((i) => i.title)).toEqual(["open-a", "open-b"]);
  });

  it("keeps a CANCELED-but-unswept row in place too (both closed statuses)", () => {
    fx = buildFixtureDb();
    seedSettings(fx.db, { logInterval: 4, manualLogDate: NOW_EPOCH - 86400 });
    seedTodo(fx.db, { title: "open", startDate: "2026-07-02", todayIndex: 10 });
    seedTodo(fx.db, {
      title: "dropped",
      startDate: "2026-07-02",
      todayIndex: 20,
      status: "canceled",
      stopDate: NOW_EPOCH,
    });
    const view = todayView(fx.db, NOW);
    expect(view.today.map((i) => i.title)).toEqual(["open", "dropped"]);
    expect(view.today.find((i) => i.title === "dropped")?.status).toBe("canceled");
  });

  it("badge counts OPEN members only — a checked-unswept row is listed but does not move it", () => {
    fx = buildFixtureDb();
    seedSettings(fx.db, { logInterval: 4, manualLogDate: NOW_EPOCH - 86400 });
    // One open due-today item (red), one open item (gray).
    seedTodo(fx.db, { title: "due", startDate: "2026-07-01", deadline: "2026-07-02" });
    seedTodo(fx.db, { title: "plain", startDate: "2026-07-02" });
    const baseline = todayView(fx.db, NOW);
    expect(baseline.badge).toEqual({ dueOrOverdue: 1, other: 1 });
    // Adding a checked-unswept row — even one carrying a due deadline — must not
    // move the badge (the GUI badge counts remaining work).
    seedTodo(fx.db, {
      title: "checked-due",
      startDate: "2026-07-02",
      deadline: "2026-07-02",
      status: "completed",
      stopDate: NOW_EPOCH,
    });
    const view = todayView(fx.db, NOW);
    expect(view.today.map((i) => i.title)).toContain("checked-due");
    expect(view.badge).toEqual({ dueOrOverdue: 1, other: 1 });
  });

  it("a checked-but-unswept EVENING item stays in the This Evening section", () => {
    fx = buildFixtureDb();
    seedSettings(fx.db, { logInterval: 4, manualLogDate: NOW_EPOCH - 86400 });
    seedTodo(fx.db, {
      title: "tonight-done",
      startDate: "2026-07-02",
      evening: true,
      status: "completed",
      stopDate: NOW_EPOCH,
    });
    const view = todayView(fx.db, NOW);
    expect(view.evening.map((i) => i.title)).toEqual(["tonight-done"]);
    expect(view.today).toEqual([]);
    // A checked evening row still contributes nothing to the badge.
    expect(view.badge).toEqual({ dueOrOverdue: 0, other: 0 });
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

  // GUI-parity ruling 2026-07-14: anytime shows checked-but-unswept rows too.
  it("keeps a checked-but-unswept row in its index slot; it leaves once the sweep passes", () => {
    fx = buildFixtureDb();
    seedSettings(fx.db, { logInterval: 4, manualLogDate: NOW_EPOCH - 86400 });
    seedTodo(fx.db, { title: "open-1", start: "active", index: 1 });
    seedTodo(fx.db, {
      title: "checked",
      start: "active",
      index: 2,
      status: "completed",
      stopDate: NOW_EPOCH,
    });
    seedTodo(fx.db, { title: "open-2", start: "active", index: 3 });

    const before = flat(anytimeView(fx.db, NOW));
    expect(before.map((i) => i.title)).toEqual(["open-1", "checked", "open-2"]);
    expect(before.find((i) => i.title === "checked")?.logged).toBe(false);

    fx.db.prepare("UPDATE TMSettings SET manualLogDate = ?").run(NOW_EPOCH + 60);
    const after = flat(anytimeView(fx.db, NOW));
    expect(after.map((i) => i.title)).toEqual(["open-1", "open-2"]);
  });

  it("shows a closed-but-unswept PROJECT row in place but keeps its children cascade-excluded", () => {
    fx = buildFixtureDb();
    seedSettings(fx.db, { logInterval: 4, manualLogDate: NOW_EPOCH - 86400 });
    // A project checked-off but not yet swept: it stays in Anytime, and its
    // children remain represented BY the (checked) project row, not listed.
    const closedProj = seedProject(fx.db, {
      title: "closed-proj",
      status: "completed",
      stopDate: NOW_EPOCH,
    });
    seedTodo(fx.db, { title: "hidden-child", project: closedProj });
    const activeProj = seedProject(fx.db, { title: "active-proj" });
    seedTodo(fx.db, { title: "visible-child", project: activeProj });

    const items = flat(anytimeView(fx.db, NOW));
    const titles = items.map((i) => i.title);
    expect(titles).toContain("closed-proj");
    expect(items.find((i) => i.title === "closed-proj")?.status).toBe("completed");
    expect(titles).not.toContain("hidden-child");
    expect(titles).toContain("active-proj");
    expect(titles).toContain("visible-child");
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
  it("collects area + project tag NAMES through the heading chain, excluding direct tags (no provenance)", () => {
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
    // Direct tag excluded; inherited tags are surfaced by NAME only — no
    // container source/provenance. The chain still walks heading → project →
    // area (a heading can't be tagged), so the names are the project's and the
    // area's tags.
    expect(inherited.map((i) => i.title).toSorted()).toEqual(["area-tag", "proj-tag"]);
    // Shape is a plain TagRef — a `title`, and nothing else (no `source`).
    expect(inherited.every((i) => Object.keys(i).length === 1)).toBe(true);
  });

  it("returns inherited tags in canonical (index, uuid) order across the project+area union", () => {
    fx = buildFixtureDb();
    // Interleave project- and area-sourced tags by index so a naive
    // project-then-area concatenation would NOT be canonically ordered.
    const area = seedArea(fx.db, "A");
    const project = seedProject(fx.db, { title: "P", area });
    const aTag = seedTag(fx.db, "a-first", null, -100); // area, lowest index → first
    const pTag = seedTag(fx.db, "p-middle", null, -50); // project, middle
    const aTag2 = seedTag(fx.db, "a-last", null, 0); // area, highest index → last
    tagArea(fx.db, area, aTag);
    tagArea(fx.db, area, aTag2);
    tagTask(fx.db, project, pTag);
    const todo = seedTodo(fx.db, { title: "t", project });

    const row = fetchTaskByUuid(fx.db, todo);
    const inherited = inheritedTagsFor(fx.db, row as NonNullable<typeof row>);
    expect(inherited.map((i) => i.title)).toEqual(["a-first", "p-middle", "a-last"]);
  });

  it("a tag on both project and area is inherited ONCE (nearest-ancestor dedup)", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Home");
    const project = seedProject(fx.db, { title: "Reno", area });
    const shared = seedTag(fx.db, "important");
    tagArea(fx.db, area, shared);
    tagTask(fx.db, project, shared);
    const todo = seedTodo(fx.db, { title: "t", project });

    const row = fetchTaskByUuid(fx.db, todo);
    const inherited = inheritedTagsFor(fx.db, row as NonNullable<typeof row>);
    expect(inherited).toEqual([{ title: "important" }]);
  });

  it("a bare item (no ancestor tags) inherits an EMPTY array — stable JSON shape", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "A");
    const project = seedProject(fx.db, { title: "P", area });
    const todo = seedTodo(fx.db, { title: "t", project });
    const row = fetchTaskByUuid(fx.db, todo);
    expect(inheritedTagsFor(fx.db, row as NonNullable<typeof row>)).toEqual([]);
  });

  it("round-trip safety: the tag-edit read (getField 'tags') sees DIRECT tags only, never inherited", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Area");
    const areaTag = seedTag(fx.db, "area-tag");
    tagArea(fx.db, area, areaTag);
    const project = seedProject(fx.db, { title: "P", area });
    const projTag = seedTag(fx.db, "proj-tag");
    tagTask(fx.db, project, projTag);
    const todo = seedTodo(fx.db, { title: "child", project });
    const directTag = seedTag(fx.db, "direct");
    tagTask(fx.db, todo, directTag);

    const entity = byUuid(fx.db, todo);
    expect(entity).not.toBeNull();
    // The detail read surfaces inherited tags — but the direct-tag field the
    // set-tags inverse captures must exclude them, or undo would clobber the
    // ancestors' assignments onto the item.
    expect(
      (entity as NonNullable<typeof entity> & { inheritedTags: unknown[] }).inheritedTags,
    ).toHaveLength(2);
    expect(getField(entity as NonNullable<typeof entity>, "tags")).toEqual(["direct"]);
  });
});

describe("canonical tag order (TMTag index, ratified 2026-07-14)", () => {
  it("renders a to-do's tags in ascending TMTag.index, not alphabetical (CPAP oracle)", () => {
    fx = buildFixtureDb();
    // Live indexes from the acceptance oracle `Replace CPAP mask & air filter`.
    const recurring = seedTag(fx.db, "recurring", null, -16139);
    const home = seedTag(fx.db, "home", null, -13475);
    const housekeeping = seedTag(fx.db, "housekeeping", null, -13442);
    const todo = seedTodo(fx.db, { title: "Replace CPAP mask", startDate: "2026-07-02" });
    // Assigned in a deliberately non-canonical (and non-alphabetical) order.
    tagTask(fx.db, todo, home);
    tagTask(fx.db, todo, housekeeping);
    tagTask(fx.db, todo, recurring);

    const item = todayView(fx.db, NOW).today.find((i) => i.title === "Replace CPAP mask");
    expect(item?.tags.map((t) => t.title)).toEqual(["recurring", "home", "housekeeping"]);
  });

  it("breaks equal-index ties by UUID, not title (TAGORD1 oracle)", () => {
    fx = buildFixtureDb();
    // Never-dragged tags ubiquitously tie at index 0; the app breaks that tie by
    // the tag's UUID (ascending), NOT alphabetically — proven in a VM across the
    // Tags window, a to-do's pill row, and the filter-bar chips
    // (docs/lab/taglab-probes.md). Seed "zeta" first so its (sequential) uuid
    // sorts BEFORE "alpha": title order would put alpha first, uuid order (and
    // the real GUI) puts zeta first — a discriminating case.
    const zeta = seedTag(fx.db, "zeta", null, 0);
    const alpha = seedTag(fx.db, "alpha", null, 0);
    expect(zeta < alpha).toBe(true); // uuid order != title order for this pair
    const todo = seedTodo(fx.db, { title: "tied", startDate: "2026-07-02" });
    // Assigned in the opposite order to prove the sort is by tag, not assignment.
    tagTask(fx.db, todo, alpha);
    tagTask(fx.db, todo, zeta);

    const item = todayView(fx.db, NOW).today.find((i) => i.title === "tied");
    expect(item?.tags.map((t) => t.title)).toEqual(["zeta", "alpha"]);
  });

  it("orders area pill tags canonically too", () => {
    fx = buildFixtureDb();
    const later = seedTag(fx.db, "later", null, 200);
    const earlier = seedTag(fx.db, "earlier", null, -200);
    const area = seedArea(fx.db, "Work");
    tagArea(fx.db, area, later);
    tagArea(fx.db, area, earlier);

    expect(areaTags(fx.db, area).map((t) => t.title)).toEqual(["earlier", "later"]);
  });

  it("lists the `tags` tree depth-first: children follow their parent, siblings by index", () => {
    fx = buildFixtureDb();
    // A parent whose index sits ABOVE its children's — the interleave case that
    // makes a flat global sort put a child before its parent. DFS must not.
    const parent = seedTag(fx.db, "errands", null, -3281);
    seedTag(fx.db, "z-groceries", parent, -12063);
    seedTag(fx.db, "a-hardware", parent, -12000);
    seedTag(fx.db, "calls", null, -3000); // later root

    const order = tagsView(fx.db).map((t) => t.title);
    // errands precedes BOTH children despite its higher (later) index; the two
    // children order by their own index (childB -12063 before childA -12000);
    // the sibling root `calls` follows the whole errands subtree.
    expect(order).toEqual(["errands", "z-groceries", "a-hardware", "calls"]);
    // Nesting is carried by the parent NAME (uuids are internal); no uuid field.
    const childRow = tagsView(fx.db).find((t) => t.title === "z-groceries");
    expect(childRow?.parent).toBe("errands");
    expect(tagsView(fx.db).every((t) => !("uuid" in t))).toBe(true);
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
    const viaUuid = todayView(fx.db, NOW, { tag });
    expect(viaUuid.today.map((i) => i.title)).toContain("direct");
    expect(todayView(fx.db, NOW).today.map((i) => i.title)).toContain("unrelated");
  });

  it("throws loudly on unknown or ambiguous tag references", () => {
    seedTagChain();
    expect(() => todayView(fx.db, NOW, { tag: "nope" })).toThrow(/no tag matching/);
    seedTag(fx.db, "focus"); // duplicate title
    expect(() => todayView(fx.db, NOW, { tag: "focus" })).toThrow(/"focus" matches \d+ tags/);
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

describe("tag-scope derivation equivalence (all four scopes from one clause array)", () => {
  // A fixture with one to-do matched by EACH hop of the inheritance chain plus
  // an untagged control, so the four derived scopes can be asserted row-exact
  // AND proven to PARTITION the universe — the invariant the old hand-
  // synchronized quadruplication endangered.
  function seedInheritanceWorld() {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");

    // clause 1 — direct: the item's own tag.
    const direct = seedTodo(fx.db, { title: "direct" });
    tagTask(fx.db, direct, focus);

    // clause 2 — via project: the item's project is directly tagged.
    const p1 = seedProject(fx.db, { title: "P1" });
    tagTask(fx.db, p1, focus);
    seedTodo(fx.db, { title: "via-project", project: p1 });

    // clause 3 — via area: the item's area is tagged.
    const a1 = seedArea(fx.db, "A1");
    tagArea(fx.db, a1, focus);
    seedTodo(fx.db, { title: "via-area", area: a1 });

    // clause 5 — via heading → project: the heading's project is directly tagged.
    const p2 = seedProject(fx.db, { title: "P2" });
    tagTask(fx.db, p2, focus);
    const h1 = seedHeading(fx.db, { title: "H1", project: p2 });
    seedTodo(fx.db, { title: "via-heading-project", heading: h1, project: null });

    // clause 6 — via heading → project → area: the heading's project sits in a
    // tagged area (the project itself carries no direct tag).
    const a2 = seedArea(fx.db, "A2");
    tagArea(fx.db, a2, focus);
    const p3 = seedProject(fx.db, { title: "P3", area: a2 });
    const h2 = seedHeading(fx.db, { title: "H2", project: p3 });
    seedTodo(fx.db, { title: "via-heading-project-area", heading: h2, project: null });

    // control — untagged by every hop.
    seedTodo(fx.db, { title: "control" });

    return { focus };
  }

  // Run a scope predicate over the seeded to-dos (type = 0 keeps the container
  // projects/headings out of the row universe).
  const rows = (scope: string, binds: string[] = []) =>
    (
      fx.db
        .prepare(`SELECT t.title AS title FROM TMTask t WHERE t.type = 0 AND ${scope}`)
        .all(...binds) as { title: string }[]
    )
      .map((r) => r.title)
      .toSorted();

  // Clause 4 (item's project's area) has no dedicated fixture row: it can only
  // fire on a project-nested to-do whose project has an area, which the app
  // models as an inherited-via-area case already covered by other hops. The five
  // rows above exercise clauses 1, 2, 3, 5 and 6; the positive relation is their
  // OR, so it matches all five.
  const INHERITED = [
    "direct",
    "via-area",
    "via-heading-project",
    "via-heading-project-area",
    "via-project",
  ];
  const ALL = [...INHERITED, "control"].toSorted();

  it("--tag scope matches exactly the direct + inherited rows (whole relation)", () => {
    const { focus } = seedInheritanceWorld();
    const uuids = [focus];
    expect(rows(tagScopeSql(uuids.length), tagScopeBinds(uuids))).toEqual(INHERITED);
  });

  it("untagged scope matches exactly the untagged control", () => {
    seedInheritanceWorld();
    expect(rows(untaggedScopeSql())).toEqual(["control"]);
  });

  it("direct scope matches exactly the directly-tagged row (clause 1 alone)", () => {
    const { focus } = seedInheritanceWorld();
    const uuids = [focus];
    expect(rows(directTagScopeSql(uuids.length), uuids)).toEqual(["direct"]);
  });

  it("direct-untagged scope matches everything but the directly-tagged row", () => {
    seedInheritanceWorld();
    expect(rows(directUntaggedScopeSql())).toEqual([
      "control",
      "via-area",
      "via-heading-project",
      "via-heading-project-area",
      "via-project",
    ]);
  });

  it("--tag and --untagged PARTITION the fixture (whole relation: disjoint + total)", () => {
    const { focus } = seedInheritanceWorld();
    const uuids = [focus];
    const tagged = rows(tagScopeSql(uuids.length), tagScopeBinds(uuids));
    const untagged = rows(untaggedScopeSql());
    expect([...tagged, ...untagged].toSorted()).toEqual(ALL); // none in neither
    expect(tagged.filter((t) => untagged.includes(t))).toEqual([]); // none in both
  });

  it("direct and direct-untagged PARTITION the fixture (container relation)", () => {
    const { focus } = seedInheritanceWorld();
    const uuids = [focus];
    const direct = rows(directTagScopeSql(uuids.length), uuids);
    const directUntagged = rows(directUntaggedScopeSql());
    expect([...direct, ...directUntagged].toSorted()).toEqual(ALL); // none in neither
    expect(direct.filter((t) => directUntagged.includes(t))).toEqual([]); // none in both
  });
});

describe("overdue filter (open items past their deadline)", () => {
  // NOW is local 2026-07-02. "Overdue" = OPEN, deadline strictly BEFORE today.
  // A world of active to-dos spanning the deadline boundary, reused per view.
  function seedOverdueWorld() {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "od-yesterday", start: "active", deadline: "2026-07-01" });
    seedTodo(fx.db, { title: "od-today", start: "active", deadline: "2026-07-02" });
    seedTodo(fx.db, { title: "od-tomorrow", start: "active", deadline: "2026-07-03" });
    seedTodo(fx.db, { title: "od-none", start: "active" });
    // Completed + past deadline, never swept (stopDate NULL): OPEN_OR_UNSWEPT
    // keeps it in anytime/today, but --overdue (status = 0) must drop it.
    seedTodo(fx.db, {
      title: "od-done",
      start: "active",
      status: "completed",
      deadline: "2026-06-30",
    });
  }

  it("anytime: boundary — due-yesterday IN; today/tomorrow/none/completed OUT", () => {
    seedOverdueWorld();
    const titles = flat(anytimeView(fx.db, NOW, { overdue: true })).map((i) => i.title);
    expect(titles).toEqual(["od-yesterday"]);
    // The unfiltered view still carries the whole world (overdue only narrows).
    expect(flat(anytimeView(fx.db, NOW)).map((i) => i.title)).toEqual(
      expect.arrayContaining(["od-yesterday", "od-today", "od-tomorrow", "od-none", "od-done"]),
    );
  });

  it("today: keeps only the open, past-deadline members", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "today-overdue", start: "active", deadline: "2026-07-01" });
    seedTodo(fx.db, { title: "today-due", start: "active", deadline: "2026-07-02" });
    seedTodo(fx.db, { title: "today-sched", start: "active", startDate: "2026-07-02" });
    const view = todayView(fx.db, NOW, { overdue: true });
    expect([...view.today, ...view.evening].map((i) => i.title)).toEqual(["today-overdue"]);
  });

  it("inbox: keeps only inbox captures past their deadline", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "inbox-overdue", start: "inbox", deadline: "2026-07-01" });
    seedTodo(fx.db, { title: "inbox-future", start: "inbox", deadline: "2026-07-03" });
    seedTodo(fx.db, { title: "inbox-plain", start: "inbox" });
    expect(inboxView(fx.db, NOW, { overdue: true }).map((i) => i.title)).toEqual(["inbox-overdue"]);
  });

  it("someday: keeps only incubated items past their deadline", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "someday-overdue", start: "someday", deadline: "2026-07-01" });
    seedTodo(fx.db, { title: "someday-future", start: "someday", deadline: "2026-07-03" });
    seedTodo(fx.db, { title: "someday-plain", start: "someday" });
    const titles = flat(somedayView(fx.db, NOW, { overdue: true })).map((i) => i.title);
    expect(titles).toEqual(["someday-overdue"]);
  });

  it("search: narrows a needle to its open, past-deadline matches", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "widget overdue", start: "active", deadline: "2026-07-01" });
    seedTodo(fx.db, { title: "widget due", start: "active", deadline: "2026-07-02" });
    seedTodo(fx.db, { title: "widget none", start: "active" });
    const titles = searchView(fx.db, "widget", { overdue: true }, NOW).map((i) => i.title);
    expect(titles).toEqual(["widget overdue"]);
  });

  it("composes with --tag as an intersection (overdue AND tagged)", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const tagged = seedTodo(fx.db, { title: "od tagged", start: "active", deadline: "2026-07-01" });
    tagTask(fx.db, tagged, focus);
    seedTodo(fx.db, { title: "od untagged", start: "active", deadline: "2026-07-01" });
    const titles = flat(anytimeView(fx.db, NOW, { overdue: true, tag: "focus" })).map(
      (i) => i.title,
    );
    expect(titles).toEqual(["od tagged"]);
  });

  it("keys the boundary on the injected clock — due-today becomes overdue tomorrow", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "due-0702", start: "active", deadline: "2026-07-02" });
    // NOW = 07-02: not yet overdue.
    expect(flat(anytimeView(fx.db, NOW, { overdue: true })).map((i) => i.title)).toEqual([]);
    // One day later the SAME row is overdue — no hardcoded date anywhere.
    const tomorrow = new Date(2026, 6, 3, 12, 0);
    expect(flat(anytimeView(fx.db, tomorrow, { overdue: true })).map((i) => i.title)).toEqual([
      "due-0702",
    ]);
  });
});

describe("overdue filter in container views (OWN-DEADLINE UNIFORM)", () => {
  // NOW is local 2026-07-02; overdue = OPEN, deadline strictly < today.

  describe("projectsView (project LIST)", () => {
    it("keeps own-overdue projects; drops non-overdue, no-deadline, completed", () => {
      fx = buildFixtureDb();
      const area = seedArea(fx.db, "Zone", 1);
      seedProject(fx.db, { title: "proj-overdue", area, deadline: "2026-07-01", index: 1 });
      seedProject(fx.db, { title: "proj-due-today", area, deadline: "2026-07-02", index: 2 });
      seedProject(fx.db, { title: "proj-future", area, deadline: "2026-07-09", index: 3 });
      seedProject(fx.db, { title: "proj-none", area, index: 4 });
      // Completed + past deadline: OVERDUE re-asserts status = 0, so it drops.
      seedProject(fx.db, {
        title: "proj-done",
        area,
        deadline: "2026-06-30",
        status: "completed",
        stopDate: 10,
        index: 5,
      });
      expect(projectsView(fx.db, { overdue: true, now: NOW }).map((p) => p.title)).toEqual([
        "proj-overdue",
      ]);
      // Unfiltered, the same world carries every OPEN project (overdue narrows).
      expect(projectsView(fx.db, { now: NOW }).map((p) => p.title)).toEqual(
        expect.arrayContaining(["proj-overdue", "proj-due-today", "proj-future", "proj-none"]),
      );
    });

    it("keys the boundary on the injected clock — due-today becomes overdue tomorrow", () => {
      fx = buildFixtureDb();
      seedProject(fx.db, { title: "due-0702", deadline: "2026-07-02" });
      expect(projectsView(fx.db, { overdue: true, now: NOW }).map((p) => p.title)).toEqual([]);
      const tomorrow = new Date(2026, 6, 3, 12, 0);
      expect(projectsView(fx.db, { overdue: true, now: tomorrow }).map((p) => p.title)).toEqual([
        "due-0702",
      ]);
    });
  });

  describe("projectView (project show)", () => {
    it("filters children to own-overdue, collapses empty headings, keeps a surviving heading", () => {
      fx = buildFixtureDb();
      const project = seedProject(fx.db, { title: "Launch" });
      const hHit = seedHeading(fx.db, { title: "Phase 1", project, index: 1 });
      const hMiss = seedHeading(fx.db, { title: "Phase 2", project, index: 2 });
      // Loose children (no heading): one overdue, one due-today, one no-deadline.
      seedTodo(fx.db, { title: "loose-overdue", project, deadline: "2026-07-01", index: 1 });
      seedTodo(fx.db, { title: "loose-due", project, deadline: "2026-07-02", index: 2 });
      seedTodo(fx.db, { title: "loose-none", project, index: 3 });
      // Headed children (DB invariant: project = NULL when headed).
      seedTodo(fx.db, {
        title: "p1-overdue",
        heading: hHit,
        project: null,
        deadline: "2026-06-25",
      });
      seedTodo(fx.db, { title: "p2-none", heading: hMiss, project: null });

      const view = projectView(fx.db, project, NOW, { overdue: true });
      // Project header still renders regardless of the filter.
      expect(view.project.title).toBe("Launch");
      expect(view.active.map((i) => i.title)).toEqual(["loose-overdue"]);
      // Phase 2 collapses (no surviving child); Phase 1 kept with its overdue child.
      expect(view.headings).toHaveLength(1);
      expect(view.headings[0]?.heading.title).toBe("Phase 1");
      expect(view.headings[0]?.items.map((i) => i.title)).toEqual(["p1-overdue"]);
    });

    it("without the flag every heading renders (its own empty state)", () => {
      fx = buildFixtureDb();
      const project = seedProject(fx.db, { title: "Launch" });
      seedHeading(fx.db, { title: "Empty Phase", project });
      const view = projectView(fx.db, project, NOW, {});
      expect(view.headings.map((g) => g.heading.title)).toEqual(["Empty Phase"]);
    });
  });

  describe("areaView (area show)", () => {
    it("filters loose to-dos AND child projects by own deadline; no recursion into projects", () => {
      fx = buildFixtureDb();
      const area = seedArea(fx.db, "Home");
      // Direct to-dos: one overdue, one due-today, one no-deadline.
      seedTodo(fx.db, { title: "todo-overdue", area, deadline: "2026-07-01", index: 1 });
      seedTodo(fx.db, { title: "todo-due", area, deadline: "2026-07-02", index: 2 });
      seedTodo(fx.db, { title: "todo-none", area, index: 3 });
      // Child projects: overdue own deadline vs no deadline.
      const projOverdue = seedProject(fx.db, {
        title: "proj-overdue",
        area,
        deadline: "2026-06-20",
        index: 4,
      });
      const projClean = seedProject(fx.db, { title: "proj-clean", area, index: 5 });
      // NO RECURSION: an overdue to-do INSIDE a non-overdue project must NOT
      // surface in area show --overdue (that is project show --overdue's job).
      seedTodo(fx.db, {
        title: "buried-overdue",
        project: projClean,
        deadline: "2026-06-01",
      });
      // A clean child inside the overdue project — the project still qualifies
      // on its OWN deadline, and its children are never inspected here.
      seedTodo(fx.db, { title: "buried-clean", project: projOverdue });

      const view = areaView(fx.db, "Home", NOW, { overdue: true });
      expect(view.active.map((i) => i.title)).toEqual(["todo-overdue"]);
      expect(view.projects.map((i) => i.title)).toEqual(["proj-overdue"]);
      // The buried overdue to-do never appears at the area level.
      const surfaced = [...view.active, ...view.projects].map((i) => i.title);
      expect(surfaced).not.toContain("buried-overdue");
      expect(surfaced).not.toContain("proj-clean");
    });

    it("collapses to a clean empty state when nothing is overdue", () => {
      fx = buildFixtureDb();
      const area = seedArea(fx.db, "Home");
      seedTodo(fx.db, { title: "todo-none", area });
      seedProject(fx.db, { title: "proj-none", area });
      const view = areaView(fx.db, "Home", NOW, { overdue: true });
      expect(view.active).toEqual([]);
      expect(view.projects).toEqual([]);
    });
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
    expect(() => searchView(fx.db, "widget", { project: "nope" })).toThrow(/no project matching/);
    expect(() => searchView(fx.db, "widget", { area: "nope" })).toThrow(/no area matching/);
    expect(() => searchView(fx.db, "widget", { tag: "nope" })).toThrow(/no tag matching/);
  });

  it("treats LIKE wildcards in the query as literal characters", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "my task" });
    seedTodo(fx.db, { title: "my_task" });
    seedTodo(fx.db, { title: "myXtask" });
    seedTodo(fx.db, { title: "50% off" });
    seedTodo(fx.db, { title: "500 off" });
    // `_` is a single-char wildcard unless escaped: "my_task" must match ONLY
    // the literal underscore title, never "my task"/"myXtask".
    expect(searchView(fx.db, "my_task").map((i) => i.title)).toEqual(["my_task"]);
    // `%` is a multi-char wildcard unless escaped: "50%" must match "50% off"
    // and NOT "500 off".
    expect(searchView(fx.db, "50%").map((i) => i.title)).toEqual(["50% off"]);
    // Control: an ordinary substring still matches every title containing it.
    expect(
      searchView(fx.db, "task")
        .map((i) => i.title)
        .toSorted(),
    ).toEqual(["my task", "myXtask", "my_task"]);
  });

  it("liteTitleSearch treats LIKE wildcards as literal characters", () => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "my task" });
    seedTodo(fx.db, { title: "my_task" });
    seedTodo(fx.db, { title: "myXtask" });
    const literal = liteTitleSearch(fx.db, "my_task").candidates.map((c) =>
      c.kind === "task" ? c.task.title : c.area.title,
    );
    expect(literal).toEqual(["my_task"]);
    // Control: a plain substring still matches every title containing it.
    const substr = liteTitleSearch(fx.db, "task")
      .candidates.map((c) => (c.kind === "task" ? c.task.title : c.area.title))
      .toSorted();
    expect(substr).toEqual(["my task", "myXtask", "my_task"]);
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

describe("flat-view tag filters stay inheritance-inclusive (regression)", () => {
  // A world where a tag reaches items by BOTH direct assignment and every
  // container-inheritance hop, so the flat `--tag`/`--untagged` can be proven to
  // keep the whole inherited relation (container views suppress it — see below).
  function seedDirectWorld() {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const work = seedArea(fx.db, "Work");
    tagArea(fx.db, work, focus);
    const proj = seedProject(fx.db, { title: "P", area: work, startDate: "2026-07-02" });
    const heading = seedHeading(fx.db, { title: "H", project: proj });
    const D = "2026-07-02";
    const direct = seedTodo(fx.db, { title: "direct", startDate: D });
    tagTask(fx.db, direct, focus);
    seedTodo(fx.db, { title: "via-project", project: proj, startDate: D });
    seedTodo(fx.db, { title: "via-area", area: work, startDate: D });
    seedTodo(fx.db, { title: "via-heading", heading, startDate: D });
    seedTodo(fx.db, { title: "unrelated", startDate: D });
    return { focus };
  }

  it("flat --tag matches direct AND every container-inherited hop", () => {
    seedDirectWorld();
    // --tag: direct + every container-inherited hop, incl. the project row P
    // (it inherits focus from its area).
    expect(
      todayView(fx.db, NOW, { tags: ["focus"] })
        .today.map((i) => i.title)
        .toSorted(),
    ).toEqual(["P", "direct", "via-area", "via-heading", "via-project"]);
  });

  it("flat --tag keeps hierarchy-descendant expansion; --exact-tag drops it", () => {
    fx = buildFixtureDb();
    const parent = seedTag(fx.db, "errands");
    const child = seedTag(fx.db, "groceries", parent);
    const area = seedArea(fx.db, "Home");
    tagArea(fx.db, area, parent);
    const directChild = seedTodo(fx.db, { title: "direct-child", startDate: "2026-07-02" });
    tagTask(fx.db, directChild, child);
    seedTodo(fx.db, { title: "inherited-parent", area, startDate: "2026-07-02" });
    // Flat --tag errands matches the descendant-tagged child (B kept) AND the
    // area-inherited-parent row (A kept — inheritance-inclusive).
    expect(
      todayView(fx.db, NOW, { tags: ["errands"] })
        .today.map((i) => i.title)
        .toSorted(),
    ).toEqual(["direct-child", "inherited-parent"]);
    // --exact-tag drops descendant expansion (B): the descendant-only child no
    // longer matches; the area-inherited exact-parent row still does.
    expect(
      todayView(fx.db, NOW, { tags: ["errands"], exactTag: true }).today.map((i) => i.title),
    ).toEqual(["inherited-parent"]);
  });

  it("flat --untagged excludes an inherited-only item (whole-relation negation)", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const work = seedArea(fx.db, "Work");
    tagArea(fx.db, work, focus);
    const D = "2026-07-02";
    const direct = seedTodo(fx.db, { title: "has-direct", area: work, startDate: D });
    tagTask(fx.db, direct, focus);
    seedTodo(fx.db, { title: "inherited-only", area: work, startDate: D }); // inherits focus, no direct
    seedTodo(fx.db, { title: "bare", startDate: D });
    // Flat --untagged: no tag at all, direct OR inherited — the inherited-only
    // row (it inherits focus from its area) drops; only the truly bare row stays.
    expect(todayView(fx.db, NOW, { untagged: true }).today.map((i) => i.title)).toEqual(["bare"]);
  });
});

describe("multi-tag AND (repeatable, intersection)", () => {
  it("--tag foo --tag bar keeps only items carrying BOTH; a foo-only item is excluded", () => {
    fx = buildFixtureDb();
    const foo = seedTag(fx.db, "foo");
    const bar = seedTag(fx.db, "bar");
    const D = "2026-07-02";
    const both = seedTodo(fx.db, { title: "both", startDate: D });
    tagTask(fx.db, both, foo);
    tagTask(fx.db, both, bar);
    const fooOnly = seedTodo(fx.db, { title: "foo-only", startDate: D });
    tagTask(fx.db, fooOnly, foo);
    const barOnly = seedTodo(fx.db, { title: "bar-only", startDate: D });
    tagTask(fx.db, barOnly, bar);
    expect(todayView(fx.db, NOW, { tags: ["foo", "bar"] }).today.map((i) => i.title)).toEqual([
      "both",
    ]);
    // A single ref is unchanged (the foo set is both + foo-only).
    expect(
      todayView(fx.db, NOW, { tags: ["foo"] })
        .today.map((i) => i.title)
        .toSorted(),
    ).toEqual(["both", "foo-only"]);
  });
});

describe("tag filters in container views (§9a — direct-on-row, container inheritance suppressed)", () => {
  it("projectView --tag matches direct-on-child, NOT the project's-own-inherited tag", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const project = seedProject(fx.db, { title: "P" });
    tagTask(fx.db, project, focus); // project itself tagged → every child inherits it
    const tagged = seedTodo(fx.db, { title: "child-tagged", project });
    tagTask(fx.db, tagged, focus);
    seedTodo(fx.db, { title: "child-bare", project });
    // Container --tag suppresses the project's own inheritance hop: only the
    // child carrying focus DIRECTLY matches — an inheritance-inclusive filter
    // would be vacuous (every child inherits the project's focus).
    expect(
      projectView(fx.db, project, NOW, { tags: ["focus"] }).active.map((i) => i.title),
    ).toEqual(["child-tagged"]);
  });

  it("projectView --untagged means no DIRECT tag (the project's inherited tag is ignored)", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const project = seedProject(fx.db, { title: "P" });
    tagTask(fx.db, project, focus); // every child inherits focus
    const tagged = seedTodo(fx.db, { title: "child-tagged", project });
    tagTask(fx.db, tagged, focus);
    seedTodo(fx.db, { title: "child-bare", project });
    // Container --untagged is direct-only: the child with no direct tag survives
    // even though it inherits focus from the project (a whole-relation negation
    // would return nothing here — every child inherits focus).
    expect(projectView(fx.db, project, NOW, { untagged: true }).active.map((i) => i.title)).toEqual(
      ["child-bare"],
    );
  });

  it("projectView --tag keeps descendant expansion; --exact-tag drops it", () => {
    fx = buildFixtureDb();
    const parent = seedTag(fx.db, "errands");
    const child = seedTag(fx.db, "groceries", parent);
    const project = seedProject(fx.db, { title: "P" });
    const directChild = seedTodo(fx.db, { title: "direct-child", project });
    tagTask(fx.db, directChild, child); // directly tagged with the descendant
    seedTodo(fx.db, { title: "bare", project });
    // Container --tag errands matches a child DIRECTLY tagged with the
    // descendant (axis B kept).
    expect(
      projectView(fx.db, project, NOW, { tags: ["errands"] }).active.map((i) => i.title),
    ).toEqual(["direct-child"]);
    // --exact-tag drops descendant expansion — the descendant-only child no
    // longer matches.
    expect(
      projectView(fx.db, project, NOW, { tags: ["errands"], exactTag: true }).active.map(
        (i) => i.title,
      ),
    ).toEqual([]);
  });

  it("projectView tag filter collapses headings with no surviving child", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const project = seedProject(fx.db, { title: "Launch" });
    const hHit = seedHeading(fx.db, { title: "Phase 1", project, index: 1 });
    const hMiss = seedHeading(fx.db, { title: "Phase 2", project, index: 2 });
    const hit = seedTodo(fx.db, { title: "p1-focus", heading: hHit, project: null });
    tagTask(fx.db, hit, focus);
    seedTodo(fx.db, { title: "p2-bare", heading: hMiss, project: null });
    const view = projectView(fx.db, project, NOW, { tags: ["focus"] });
    expect(view.headings).toHaveLength(1);
    expect(view.headings[0]?.heading.title).toBe("Phase 1");
    expect(view.headings[0]?.items.map((i) => i.title)).toEqual(["p1-focus"]);
  });

  it("areaView filters loose to-dos AND child projects by direct tag; no recursion into projects", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const area = seedArea(fx.db, "Home");
    tagArea(fx.db, area, focus); // area-tagged → every row inherits focus
    const looseHit = seedTodo(fx.db, { title: "loose-focus", area, index: 1 });
    tagTask(fx.db, looseHit, focus);
    seedTodo(fx.db, { title: "loose-bare", area, index: 2 });
    const projHit = seedProject(fx.db, { title: "proj-focus", area, index: 3 });
    tagTask(fx.db, projHit, focus);
    const projBare = seedProject(fx.db, { title: "proj-bare", area, index: 4 });
    // A focus-tagged to-do buried inside the NON-matching project must not surface.
    const buried = seedTodo(fx.db, { title: "buried-focus", project: projBare });
    tagTask(fx.db, buried, focus);
    // Container --tag suppresses the area's own inheritance hop: only rows
    // carrying focus DIRECTLY survive (the area-inherited focus on every row is
    // ignored), and NO descent into project contents.
    const view = areaView(fx.db, "Home", NOW, { tags: ["focus"] });
    expect(view.active.map((i) => i.title)).toEqual(["loose-focus"]);
    expect(view.projects.map((i) => i.title)).toEqual(["proj-focus"]);
    const surfaced = [...view.active, ...view.projects].map((i) => i.title);
    expect(surfaced).not.toContain("buried-focus");
  });
});

describe("projectsView (project LIST) is FLAT — tag filter is inheritance-inclusive", () => {
  // The projects list is NOT a single-container view: projects sit in different
  // areas with heterogeneous inheritance, so `--tag` is inheritance-inclusive
  // (like `anytime` restricted to project rows) — distinct from `area show`,
  // which suppresses its one area's inheritance.
  it("--tag matches BOTH a directly-tagged project AND one that inherits the tag from its area", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const area = seedArea(fx.db, "Zone", 1);
    tagArea(fx.db, area, focus); // area-tagged → its projects inherit focus
    const direct = seedProject(fx.db, { title: "proj-direct", area, index: 1 });
    tagTask(fx.db, direct, focus);
    seedProject(fx.db, { title: "proj-inherited", area, index: 2 }); // inherits focus from area
    const other = seedArea(fx.db, "Other", 2);
    seedProject(fx.db, { title: "proj-unrelated", area: other, index: 3 });
    // Inheritance-inclusive → both Zone projects (direct + area-inherited); the
    // Other-area project is excluded.
    expect(
      projectsView(fx.db, { tags: ["focus"], now: NOW })
        .map((p) => p.title)
        .toSorted(),
    ).toEqual(["proj-direct", "proj-inherited"]);
  });

  it("CONTRAST: area show --tag suppresses the SAME area's inheritance (direct-on-row only)", () => {
    fx = buildFixtureDb();
    const focus = seedTag(fx.db, "focus");
    const area = seedArea(fx.db, "Zone", 1);
    tagArea(fx.db, area, focus);
    const direct = seedProject(fx.db, { title: "proj-direct", area, index: 1 });
    tagTask(fx.db, direct, focus);
    seedProject(fx.db, { title: "proj-inherited", area, index: 2 });
    // area show --tag focus: the area's own focus is inherited by every project,
    // so it is suppressed — only the directly-tagged project survives. This is
    // the deliberate difference from the projects LIST above.
    expect(areaView(fx.db, "Zone", NOW, { tags: ["focus"] }).projects.map((p) => p.title)).toEqual([
      "proj-direct",
    ]);
  });
});

describe("effective area (a to-do reports the nearest area up its chain)", () => {
  // byUuid returns AnyTask (Heading has no `area`); every subject below is a
  // to-do or project, so narrow to the area-bearing shape.
  const areaOf = (uuid: string): Ref | null =>
    (byUuid(fx.db, uuid) as { area: Ref | null } | null)?.area ?? null;

  it("a to-do nested in a project-in-an-area reports THAT area (project chain)", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Home");
    const project = seedProject(fx.db, { title: "Reno", area });
    const uuid = seedTodo(fx.db, { title: "child", project }); // t.area is NULL
    expect(areaOf(uuid)).toEqual({ uuid: area, title: "Home" });
  });

  it("a heading-nested to-do reports its heading's project's area (heading chain)", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Work");
    const project = seedProject(fx.db, { title: "Launch", area });
    const heading = seedHeading(fx.db, { title: "Phase 1", project });
    const uuid = seedTodo(fx.db, { title: "headed", heading, project: null }); // t.area + t.project NULL
    expect(areaOf(uuid)).toEqual({ uuid: area, title: "Work" });
  });

  it("a loose to-do in an area reports its direct area", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Home");
    const uuid = seedTodo(fx.db, { title: "loose", area });
    expect(areaOf(uuid)).toEqual({ uuid: area, title: "Home" });
  });

  it("an inbox to-do (no project/area) reports NO area", () => {
    fx = buildFixtureDb();
    const uuid = seedTodo(fx.db, { title: "captured", start: "inbox" });
    expect(areaOf(uuid)).toBeNull();
  });

  it("a project's area is its own direct area, unchanged (areas are not inherited)", () => {
    fx = buildFixtureDb();
    const area = seedArea(fx.db, "Home");
    const uuid = seedProject(fx.db, { title: "P", area });
    expect(areaOf(uuid)).toEqual({ uuid: area, title: "Home" });
    const loose = seedProject(fx.db, { title: "Loose" });
    expect(areaOf(loose)).toBeNull();
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
    expect(() => areaView(fx.db, "Nope", NOW)).toThrow(/no area matching/);
    expect(() => areaView(fx.db, "Dup", NOW)).toThrow(/"Dup" matches 2 areas/);
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
    expect(() => resolveTaskUuidPrefix(fx.db, "ABCDEF1234567890ZZZZ99")).toThrow(
      /no to-do matching/,
    );
    fx.db.exec("DELETE FROM TMTask WHERE uuid = 'SHORTUUID111111111111'");
    seedTodo(fx.db, { uuid: "ABCDEG9999999999CCCCCC", title: "three" });
    expect(() => resolveTaskUuidPrefix(fx.db, "ABCDE9")).toThrow(/no to-do matching/);
    expect(() => resolveTaskUuidPrefix(fx.db, "ABC" + "DE".repeat(2))).toThrow(
      /ambiguous|no to-do matching/,
    );
  });
});
