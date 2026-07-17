import { describe, expect, it } from "vitest";

import {
  calendarDateInZone,
  dayBoundInstant,
  decodeEpochReal,
  decodePackedDate,
  encodeEpochReal,
  encodePackedDate,
  isValidTimeZone,
  localToday,
} from "../../src/model/dates.ts";

describe("packed date codec", () => {
  it("decodes the live-verified example", () => {
    // Verified against production DB 2026-07-02: startDate=132803712 renders as 2026-06-25.
    expect(decodePackedDate(132803712)).toBe("2026-06-25");
  });

  it("round-trips across representative dates", () => {
    for (const iso of ["1999-01-01", "2026-07-02", "2026-12-31", "2031-02-28"]) {
      expect(decodePackedDate(encodePackedDate(iso))).toBe(iso);
    }
  });

  it("treats null and 0 as absent", () => {
    expect(decodePackedDate(null)).toBeNull();
    expect(decodePackedDate(0)).toBeNull();
  });

  it("throws on out-of-domain packed values rather than fabricating dates", () => {
    // month 15 is impossible; a value like this signals schema drift or corruption
    expect(() => decodePackedDate((2026 << 16) | (15 << 12) | (5 << 7))).toThrow(RangeError);
  });

  it("rejects malformed ISO input", () => {
    expect(() => encodePackedDate("2026-7-2")).toThrow(RangeError);
    expect(() => encodePackedDate("2026-13-01")).toThrow(RangeError);
  });
});

describe("epoch real codec", () => {
  it("round-trips with fractional seconds", () => {
    const d = new Date("2026-07-02T14:31:22.500Z");
    expect(decodeEpochReal(encodeEpochReal(d))?.toISOString()).toBe(d.toISOString());
  });

  it("null passes through", () => {
    expect(decodeEpochReal(null)).toBeNull();
  });
});

describe("localToday", () => {
  it("formats the injected now in local time", () => {
    // construct a local-time date so the test is TZ-independent
    const now = new Date(2026, 6, 2, 23, 59);
    expect(localToday(now)).toBe("2026-07-02");
  });

  it("computes the calendar date in an explicit zone (antimeridian split)", () => {
    // One instant, three calendars spanning two days: 2026-07-02T10:00Z is
    // already Jul 3 in Kiritimati (UTC+14) but still Jul 1 in Midway (UTC-11).
    const instant = new Date("2026-07-02T10:00:00Z");
    expect(localToday(instant, "Pacific/Kiritimati")).toBe("2026-07-03");
    expect(localToday(instant, "Pacific/Midway")).toBe("2026-07-01");
    expect(localToday(instant, "UTC")).toBe("2026-07-02");
  });

  it("is DST-correct at a spring-forward boundary", () => {
    // US DST began 2026-03-08 02:00 local. An instant just after New York's
    // local midnight is still Mar 7 in Los Angeles (3h behind).
    const instant = new Date("2026-03-08T05:30:00Z"); // 00:30 EST / 21:30 PST prev day
    expect(calendarDateInZone(instant, "America/New_York")).toBe("2026-03-08");
    expect(calendarDateInZone(instant, "America/Los_Angeles")).toBe("2026-03-07");
  });
});

describe("dayBoundInstant", () => {
  it("resolves a zone's day edges through its offset (host-independent)", () => {
    // Tokyo is UTC+9 year-round: start-of-day 00:00 JST = 15:00 UTC the day before.
    expect(dayBoundInstant("2026-07-02", "start", "Asia/Tokyo").toISOString()).toBe(
      "2026-07-01T15:00:00.000Z",
    );
    expect(dayBoundInstant("2026-07-02", "end", "Asia/Tokyo").toISOString()).toBe(
      "2026-07-02T14:59:59.999Z",
    );
  });

  it("without a zone matches a bare host-local day edge (byte-identical)", () => {
    expect(dayBoundInstant("2026-07-02", "start").getTime()).toBe(
      new Date(2026, 6, 2, 0, 0, 0, 0).getTime(),
    );
    expect(dayBoundInstant("2026-07-02", "end").getTime()).toBe(
      new Date(2026, 6, 2, 23, 59, 59, 999).getTime(),
    );
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(isValidTimeZone("EST5EDTX")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
