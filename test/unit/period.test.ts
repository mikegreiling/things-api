/**
 * The period grammar helpers that back the read views' `--since`/`--until`
 * bounds. Here: {@link doublePeriod}, the dumb count-doubler behind the
 * upcoming "wider window" suggestion.
 */
import { describe, expect, it } from "vitest";

import { doublePeriod, parsePeriodEnd, parsePeriodStart } from "../../src/cli/period.ts";
import { localToday } from "../../src/model/dates.ts";

describe("doublePeriod", () => {
  it("doubles the count of a relative period, unit preserved", () => {
    expect(doublePeriod("1m")).toBe("2m");
    expect(doublePeriod("2w")).toBe("4w");
    expect(doublePeriod("1y")).toBe("2y");
    expect(doublePeriod("3d")).toBe("6d");
  });

  it("normalizes the unit to lower case and trims", () => {
    expect(doublePeriod("2W")).toBe("4w");
    expect(doublePeriod("  1m  ")).toBe("2m");
  });

  it("leaves an absolute calendar period unchanged — nothing to double", () => {
    expect(doublePeriod("2026-09")).toBe("2026-09");
    expect(doublePeriod("2026")).toBe("2026");
    expect(doublePeriod("2026-09-15")).toBe("2026-09-15");
  });
});

describe("relative-period math honors the consumer zone", () => {
  // An instant spanning two calendars: Jul 2 in Tokyo (19:00 JST) but Jul 1 in
  // Midway (23:00 SST), so a `Nd` bound counted in each zone lands differently.
  const now = new Date("2026-07-02T10:00:00Z");

  it("counts `3d` forward from the consumer's today, not the host's", () => {
    const tokyo = parsePeriodEnd("3d", now, "Asia/Tokyo");
    const midway = parsePeriodEnd("3d", now, "Pacific/Midway");
    // Tokyo today is Jul 2 → +3d = Jul 5 (end-of-day in Tokyo).
    expect(localToday(tokyo, "Asia/Tokyo")).toBe("2026-07-05");
    // Midway today is Jul 1 → +3d = Jul 4 (end-of-day in Midway).
    expect(localToday(midway, "Pacific/Midway")).toBe("2026-07-04");
  });

  it("counts `2w` backward from the consumer's today", () => {
    const tokyo = parsePeriodStart("2w", now, "Asia/Tokyo");
    // Jul 2 − 14d = Jun 18, at start-of-day in Tokyo.
    expect(localToday(tokyo, "Asia/Tokyo")).toBe("2026-06-18");
    expect(tokyo.toISOString()).toBe("2026-06-17T15:00:00.000Z"); // 00:00 JST Jun 18
  });

  it("without a zone is byte-identical to the host math", () => {
    const rel = parsePeriodEnd("1m", now);
    const d = new Date(now);
    d.setMonth(d.getMonth() + 1);
    const expected = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    expect(rel.getTime()).toBe(expected.getTime());
  });

  it("absolute periods resolve to the consumer zone's day edges", () => {
    // Whole month of September 2026, in Tokyo.
    const start = parsePeriodStart("2026-09", now, "Asia/Tokyo");
    const end = parsePeriodEnd("2026-09", now, "Asia/Tokyo");
    expect(start.toISOString()).toBe("2026-08-31T15:00:00.000Z"); // 00:00 JST Sep 1
    expect(end.toISOString()).toBe("2026-09-30T14:59:59.999Z"); // 23:59:59.999 JST Sep 30
  });
});
