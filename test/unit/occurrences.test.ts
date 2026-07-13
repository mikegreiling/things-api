/**
 * Phase 16: occurrence generator — pure calendar math over decoded rules,
 * anchored on app-materialized dates. Conventions under test: day-31 clamps,
 * missing 5th-weekday skips, Sunday-based weekly cohorts, ed/rc bounds.
 */
import { describe, expect, it } from "vitest";

import { generateEventDates, projectOccurrences } from "../../src/model/occurrences.ts";
import type { RepeatRule } from "../../src/model/recurrence.ts";
import { upcomingView } from "../../src/read/views.ts";
import { buildFixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

function rule(partial: Partial<RepeatRule>): RepeatRule {
  return {
    type: "fixed",
    unit: "daily",
    interval: 1,
    startOffsetDays: 0,
    offsets: [],
    endDate: null,
    remainingCount: null,
    version: 4,
    ...partial,
  };
}

describe("generateEventDates", () => {
  it("daily with an interval", () => {
    const dates = generateEventDates(rule({ unit: "daily", interval: 3 }), "2026-07-10", {
      count: 4,
    });
    expect(dates).toEqual(["2026-07-10", "2026-07-13", "2026-07-16", "2026-07-19"]);
  });

  it("weekly multi-day: earlier weekdays of the anchor week are skipped", () => {
    // 2026-07-10 is a Friday; the rule also fires Mondays.
    const dates = generateEventDates(
      rule({ unit: "weekly", offsets: [{ weekday: 1 }, { weekday: 5 }] }),
      "2026-07-10",
      { count: 3 },
    );
    expect(dates).toEqual(["2026-07-10", "2026-07-13", "2026-07-17"]);
  });

  it("biweekly Sunday (the live cpap rule shape)", () => {
    const dates = generateEventDates(
      rule({ unit: "weekly", interval: 2, offsets: [{ weekday: 0 }] }),
      "2026-07-19",
      { count: 3 },
    );
    expect(dates).toEqual(["2026-07-19", "2026-08-02", "2026-08-16"]);
  });

  it("weekly with no offsets repeats on the anchor's weekday", () => {
    const dates = generateEventDates(rule({ unit: "weekly" }), "2026-07-08", { count: 2 });
    expect(dates).toEqual(["2026-07-08", "2026-07-15"]); // Wednesdays
  });

  it("monthly day-31 clamps to shorter months", () => {
    const dates = generateEventDates(
      rule({ unit: "monthly", offsets: [{ day: 31 }] }),
      "2026-01-31",
      { count: 3 },
    );
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("monthly last-day (-1)", () => {
    const dates = generateEventDates(
      rule({ unit: "monthly", offsets: [{ day: -1 }] }),
      "2026-02-28",
      { count: 3 },
    );
    expect(dates).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("monthly last-Friday (wdo -1)", () => {
    const dates = generateEventDates(
      rule({ unit: "monthly", offsets: [{ weekday: 5, weekdayOrdinal: -1 }] }),
      "2026-07-31",
      { count: 3 },
    );
    expect(dates).toEqual(["2026-07-31", "2026-08-28", "2026-09-25"]);
  });

  it("a missing 5th weekday SKIPS the month", () => {
    // June 2026 has five Mondays (…29th); July has four; August has five (31st).
    const dates = generateEventDates(
      rule({ unit: "monthly", offsets: [{ weekday: 1, weekdayOrdinal: 5 }] }),
      "2026-06-29",
      { count: 2 },
    );
    expect(dates).toEqual(["2026-06-29", "2026-08-31"]);
  });

  it("yearly Feb-29 clamps to Feb-28 off leap years", () => {
    const dates = generateEventDates(
      rule({ unit: "yearly", offsets: [{ month: 2, day: 29 }] }),
      "2028-02-29",
      { count: 3 },
    );
    expect(dates).toEqual(["2028-02-29", "2029-02-28", "2030-02-28"]);
  });

  it("yearly with no offsets repeats on the anchor's month/day", () => {
    const dates = generateEventDates(rule({ unit: "yearly", interval: 2 }), "2026-11-09", {
      count: 2,
    });
    expect(dates).toEqual(["2026-11-09", "2028-11-09"]);
  });

  it("stops at the rule's endDate", () => {
    const dates = generateEventDates(
      rule({ unit: "daily", interval: 7, endDate: "2026-07-20" }),
      "2026-07-10",
      { count: 10 },
    );
    expect(dates).toEqual(["2026-07-10", "2026-07-17"]);
  });

  it("caps at the rule's remainingCount", () => {
    const dates = generateEventDates(rule({ unit: "daily", remainingCount: 2 }), "2026-07-10", {
      count: 5,
    });
    expect(dates).toEqual(["2026-07-10", "2026-07-11"]);
  });

  it("honors the window's until bound", () => {
    const dates = generateEventDates(rule({ unit: "daily", interval: 5 }), "2026-07-10", {
      count: 10,
      until: "2026-07-21",
    });
    expect(dates).toEqual(["2026-07-10", "2026-07-15", "2026-07-20"]);
  });

  it("refuses after-completion rules", () => {
    expect(() =>
      generateEventDates(rule({ type: "after-completion" }), "2026-07-10", { count: 2 }),
    ).toThrow(/after-completion/);
  });
});

describe("projectOccurrences", () => {
  it("splits each event into start/deadline via ts (deadlined; instance-validated model)", () => {
    // Biweekly Sunday with a 4-day-early start: app says next start 07-15.
    const occ = projectOccurrences(
      rule({ unit: "weekly", interval: 2, offsets: [{ weekday: 0 }], startOffsetDays: -4 }),
      "2026-07-15",
      { count: 3 },
      true,
    );
    expect(occ).toEqual([
      { startDate: "2026-07-15", deadline: "2026-07-19" },
      { startDate: "2026-07-29", deadline: "2026-08-02" },
      { startDate: "2026-08-12", deadline: "2026-08-16" },
    ]);
  });

  it("deadlined ts=0 rules project with deadline = start", () => {
    // A deadlined ts=0 template (UI "Add deadlines", 0 days earlier) spawns
    // instances with deadline = startDate (birthday-style).
    const occ = projectOccurrences(rule({ unit: "daily" }), "2026-07-10", { count: 2 }, true);
    expect(occ).toEqual([
      { startDate: "2026-07-10", deadline: "2026-07-10" },
      { startDate: "2026-07-11", deadline: "2026-07-11" },
    ]);
  });

  it("deadline-less templates project with NO deadline (the GUI default; UI1 2026-07-12)", () => {
    // A deadline-less fixed template — the repeat editor's default — spawns
    // instances with a startDate but no deadline, even though its rule is
    // byte-identical to a deadlined ts=0 rule (oddities §8a).
    const occ = projectOccurrences(rule({ unit: "daily" }), "2026-07-10", { count: 2 }, false);
    expect(occ).toEqual([
      { startDate: "2026-07-10", deadline: null },
      { startDate: "2026-07-11", deadline: null },
    ]);
  });
});

describe("upcoming --horizon", () => {
  const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02

  const BIWEEKLY_SUNDAY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>fa</key><integer>2</integer>
  <key>fu</key><integer>256</integer>
  <key>of</key><array><dict><key>wd</key><integer>0</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>-4</integer>
</dict>
</plist>`;

  it("projects n occurrences per template, sorted into the date order", () => {
    const fx = buildFixtureDb();
    seedTodo(fx.db, { title: "between", start: "someday", startDate: "2026-07-20" });
    seedTodo(fx.db, {
      title: "cpap",
      recurrenceRuleXml: BIWEEKLY_SUNDAY_XML,
      nextInstanceStartDate: "2026-07-15",
      // ts=-4 is only reachable via "Add deadlines … N days earlier", so this
      // template is deadlined: its `deadline` column holds the 4001-01-01
      // sentinel (oddities §8a).
      deadline: "4001-01-01",
    });
    const items = upcomingView(fx.db, NOW, { horizon: 3 });
    expect(items.map((i) => [i.title, i.startDate, i.deadline])).toEqual([
      ["cpap", "2026-07-15", "2026-07-19"],
      ["between", "2026-07-20", null],
      ["cpap", "2026-07-29", "2026-08-02"],
      ["cpap", "2026-08-12", "2026-08-16"],
    ]);
    fx.close();
  });

  it("deadline-less templates project every occurrence with no deadline (UI1 2026-07-12)", () => {
    const fx = buildFixtureDb();
    // Same rule/next-date as cpap but deadline-less (no `deadline` column):
    // the GUI default. Every projected occurrence must carry deadline null.
    seedTodo(fx.db, {
      title: "dl-less",
      recurrenceRuleXml: BIWEEKLY_SUNDAY_XML,
      nextInstanceStartDate: "2026-07-15",
    });
    const items = upcomingView(fx.db, NOW, { horizon: 3 });
    expect(items.map((i) => [i.startDate, i.deadline])).toEqual([
      ["2026-07-15", null],
      ["2026-07-29", null],
      ["2026-08-12", null],
    ]);
    fx.close();
  });

  it("default horizon stays exactly the UI: one occurrence per template", () => {
    const fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "cpap",
      recurrenceRuleXml: BIWEEKLY_SUNDAY_XML,
      nextInstanceStartDate: "2026-07-15",
      deadline: "4001-01-01",
    });
    expect(upcomingView(fx.db, NOW).map((i) => i.startDate)).toEqual(["2026-07-15"]);
    fx.close();
  });
});
