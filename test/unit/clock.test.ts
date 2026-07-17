import { describe, expect, it } from "vitest";

import { ClockError, clockMeta, resolveClock } from "../../src/model/clock.ts";

describe("resolveClock", () => {
  it("returns the host clock (no meta) when nothing is set", () => {
    const clock = resolveClock({ env: {} });
    expect(clock.zone).toBeUndefined();
    expect(clock.explicit).toBe(false);
    expect(clockMeta(clock)).toBeUndefined();
  });

  it("reads THINGS_TZ and pins THINGS_NOW", () => {
    const clock = resolveClock({
      env: { THINGS_TZ: "Asia/Tokyo", THINGS_NOW: "2026-07-02T11:00:00Z" },
    });
    expect(clock.zone).toBe("Asia/Tokyo");
    expect(clock.explicit).toBe(true);
    expect(clock.now().toISOString()).toBe("2026-07-02T11:00:00.000Z");
    expect(clockMeta(clock)).toEqual({ timezone: "Asia/Tokyo", today: "2026-07-02" });
  });

  it("a pinned now with no zone still emits meta (host zone, pinned today)", () => {
    const clock = resolveClock({ env: { THINGS_NOW: "2026-07-02T11:00:00Z" } });
    expect(clock.zone).toBeUndefined();
    expect(clock.explicit).toBe(true);
    const meta = clockMeta(clock);
    expect(meta).not.toBeUndefined();
    expect(typeof meta?.timezone).toBe("string");
  });

  it("an injected now WITHOUT env knobs stays non-explicit (no meta)", () => {
    const pinned = new Date("2026-07-02T11:00:00Z");
    const clock = resolveClock({ env: {}, now: () => pinned });
    expect(clock.explicit).toBe(false);
    expect(clockMeta(clock)).toBeUndefined();
  });

  it("a per-call tz overrides THINGS_TZ and re-scopes clockMeta", () => {
    const clock = resolveClock({
      env: { THINGS_TZ: "Asia/Tokyo", THINGS_NOW: "2026-07-02T10:00:00Z" },
    });
    // Same instant, evaluated in Midway (UTC-11): the prior day.
    expect(clockMeta(clock, "Pacific/Midway")).toEqual({
      timezone: "Pacific/Midway",
      today: "2026-07-01",
    });
  });

  it("clockMeta with a per-call zone is explicit even off a host clock", () => {
    const clock = resolveClock({ env: {}, now: () => new Date("2026-07-02T11:00:00Z") });
    expect(clockMeta(clock, "Pacific/Kiritimati")).toEqual({
      timezone: "Pacific/Kiritimati",
      today: "2026-07-03",
    });
  });

  it("fails closed on an invalid THINGS_TZ", () => {
    expect(() => resolveClock({ env: { THINGS_TZ: "Not/AZone" } })).toThrow(ClockError);
    expect(() => resolveClock({ env: { THINGS_TZ: "Not/AZone" } })).toThrow(/THINGS_TZ/);
  });

  it("fails closed on an invalid per-call tz", () => {
    expect(() => resolveClock({ env: {}, tz: "Bogus/Zone" })).toThrow(ClockError);
    expect(() => resolveClock({ env: {}, tz: "Bogus/Zone" })).toThrow(/^.*tz .*valid IANA/);
  });

  it("fails closed on an unparseable THINGS_NOW", () => {
    expect(() => resolveClock({ env: { THINGS_NOW: "not-an-instant" } })).toThrow(ClockError);
    expect(() => resolveClock({ env: { THINGS_NOW: "not-an-instant" } })).toThrow(/THINGS_NOW/);
  });

  it("ignores blank env values (treated as unset)", () => {
    const clock = resolveClock({ env: { THINGS_TZ: "   ", THINGS_NOW: "" } });
    expect(clock.zone).toBeUndefined();
    expect(clock.explicit).toBe(false);
  });
});
