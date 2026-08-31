import { describe, expect, it } from "vitest";

import { encodePackedDate } from "../../src/model/dates.ts";
import { isStaleEvening, todayPlacement } from "../../src/model/today-placement.ts";

// A fixed, INJECTED day — never `new Date()` and never a UTC ISO string, so the
// suite cannot flake on the runner's zone (#654).
const TODAY = encodePackedDate("2026-07-06");
const YESTERDAY = encodePackedDate("2026-07-05");
const TOMORROW = encodePackedDate("2026-07-07");

const at = (start: number, startDate: number | null, startBucket: number | null) =>
  todayPlacement({ start, startDate, startBucket }, TODAY);

describe("todayPlacement — the ONE Today/Evening law (STEV1, #657)", () => {
  it("an active row dated today is Today proper", () => {
    expect(at(1, TODAY, 0)).toBe("today");
  });

  it("an evening row dated today is This Evening", () => {
    expect(at(1, TODAY, 1)).toBe("evening");
  });

  it("a STALE evening row — bucket 1, day passed — is Today PROPER, not evening", () => {
    expect(at(1, YESTERDAY, 1)).toBe("today");
    expect(isStaleEvening({ start: 1, startDate: YESTERDAY, startBucket: 1 }, TODAY)).toBe(true);
  });

  it("an overdue daytime row is Today proper and is NOT stale-evening", () => {
    expect(at(1, YESTERDAY, 0)).toBe("today");
    expect(isStaleEvening({ start: 1, startDate: YESTERDAY, startBucket: 0 }, TODAY)).toBe(false);
  });

  it("a same-day evening row is not stale (its flag is still live)", () => {
    expect(isStaleEvening({ start: 1, startDate: TODAY, startBucket: 1 }, TODAY)).toBe(false);
  });

  it("a FUTURE-dated row is no Today member at all — evening flag or not", () => {
    expect(at(1, TOMORROW, 0)).toBeNull();
    expect(at(1, TOMORROW, 1)).toBeNull();
    expect(isStaleEvening({ start: 1, startDate: TOMORROW, startBucket: 1 }, TODAY)).toBe(false);
  });

  it("an undated row is no scheduled-arm member (the deadline arm is the reader's)", () => {
    expect(at(1, null, 0)).toBeNull();
    expect(at(2, null, 0)).toBeNull();
  });

  it("an Inbox row (start=0) is never a member, even dated", () => {
    expect(at(0, TODAY, 0)).toBeNull();
    expect(at(0, TODAY, 1)).toBeNull();
  });

  it("an ARRIVED someday-scheduled row buckets by date, exactly like an active one (#325)", () => {
    expect(at(2, TODAY, 0)).toBe("today");
    expect(at(2, TODAY, 1)).toBe("evening");
    expect(at(2, YESTERDAY, 1)).toBe("today");
  });

  it("a null startBucket reads as Today proper (the column is nullable)", () => {
    expect(at(1, TODAY, null)).toBe("today");
  });
});
