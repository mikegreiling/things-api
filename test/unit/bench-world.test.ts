/**
 * Evergreen world-profile tests (bench/world.ts): invariants hold across
 * seeds, the build is deterministic for a fixed (seed, clock), recurrence
 * blobs decode with the REAL read-path decoder into the intended shapes, and
 * the shape stays inside the survey-derived targets.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { buildBenchFixture } from "../../bench/fixture.ts";
import { applyWorld, dayIso, ruleXml } from "../../bench/world.ts";
import { decodeRecurrenceRule } from "../../src/model/recurrence.ts";
import { buildFixtureDb } from "../fixtures/build-db.ts";

const CLOCK = { now: "2026-07-20T09:00:00-05:00", tz: "America/Chicago" };

describe("bench world profile", () => {
  it("holds its invariants across five rotation seeds (validateWorld throws otherwise)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const fixture = buildFixtureDb();
      // applyWorld runs validateWorld internally — a violation throws here.
      const summary = applyWorld(fixture.db, { seed, clock: CLOCK });
      expect(summary.areas).toBeGreaterThanOrEqual(7);
      expect(summary.projects).toBeGreaterThanOrEqual(15);
      expect(summary.todos).toBeGreaterThan(250);
      expect(summary.templates).toBe(9);
      expect(summary.instances).toBeGreaterThanOrEqual(18);
      expect(summary.checklistItems).toBeGreaterThan(0);
      fixture.close();
    }
  });

  it("is deterministic: same (seed, clock) → identical DB content hash", () => {
    const a = buildBenchFixture([], { seed: 7, clock: CLOCK });
    const b = buildBenchFixture([], { seed: 7, clock: CLOCK });
    const c = buildBenchFixture([], { seed: 8, clock: CLOCK });
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.snapshotHash).not.toBe(c.snapshotHash);
    a.cleanup();
    b.cleanup();
    c.cleanup();
  });

  it("dates ride the clock: shifting the clock shifts the calendar, so nothing goes stale", () => {
    const later = { now: "2027-03-05T09:00:00-06:00", tz: "America/Chicago" };
    expect(dayIso(CLOCK, 0)).toBe("2026-07-20");
    expect(dayIso(later, 0)).toBe("2027-03-05");
    // A world built under a much later clock still validates (no staleness).
    const fixture = buildFixtureDb();
    expect(() => applyWorld(fixture.db, { seed: 1, clock: later })).not.toThrow();
    fixture.close();
  });

  it("composes recurrence blobs the real decoder reads back faithfully", () => {
    // The marquee nth-weekday shape: last Sunday of December, yearly, fixed.
    const rule = decodeRecurrenceRule(
      ruleXml({ tp: 0, fu: 4, fa: 1, of: [{ mo: 11, wd: 0, wdo: -1 }], anchor: 1_780_000_000 }),
    );
    expect(rule.type).toBe("fixed");
    expect(rule.unit).toBe("yearly");
    expect(rule.offsets).toEqual([{ month: 12, weekday: 0, weekdayOrdinal: -1 }]);
    expect(rule.endDate).toBeNull(); // forever sentinel
    expect(rule.remainingCount).toBeNull();

    const after = decodeRecurrenceRule(
      ruleXml({ tp: 1, fu: 8, fa: 1, of: [{ dy: -1 }], anchor: 1_780_000_000 }),
    );
    expect(after.type).toBe("after-completion");
    expect(after.unit).toBe("monthly");
    expect(after.offsets).toEqual([{ day: -1 }]);
  });

  it("keeps Today's task-seed exactness: a world fixture layers under seeds without touching Today", () => {
    const fixture = buildBenchFixture(
      [
        {
          kind: "todo",
          key: "t",
          title: "Zebra placeholder task",
          start: "active",
          startDate: "2026-07-20",
        },
      ],
      { seed: 3, clock: CLOCK },
    );
    // The ONLY open row scheduled today-or-earlier is the task seed itself.
    const db = new DatabaseSync(fixture.path, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT title FROM TMTask
         WHERE status = 0 AND trashed = 0 AND rt1_recurrenceRule IS NULL
           AND startDate IS NOT NULL AND startDate <= 132807168`,
      )
      .all() as { title: string }[];
    db.close();
    fixture.cleanup();
    expect(rows.map((r) => r.title)).toEqual(["Zebra placeholder task"]);
  });
});
