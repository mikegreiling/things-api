import { describe, expect, it } from "vitest";

import {
  decodeEpochReal,
  decodePackedDate,
  encodeEpochReal,
  encodePackedDate,
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
});
