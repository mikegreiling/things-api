/**
 * The consumer-zone `when` normalization the write pipeline applies before
 * dispatch (normalize-before-dispatch): `today` becomes the consumer-zone
 * calendar date, and a cross-date `evening` is refused fail-closed.
 */
import { describe, expect, it } from "vitest";

import { calendarDateInZone, localToday } from "../../src/model/dates.ts";
import { normalizeConsumerWhen } from "../../src/write/pipeline.ts";

// Instant spanning two calendars: Jul 3 in Kiritimati (UTC+14) and Jul 1 in
// Midway (UTC-11). The HOST date for it is whatever the runner's zone is, so
// the tests assert the RELATIONSHIP to the host date rather than a fixed value.
const instant = new Date("2026-07-02T10:00:00Z");
const FAR_ZONES = ["Pacific/Kiritimati", "Pacific/Midway"] as const;

describe("normalizeConsumerWhen", () => {
  it("rewrites `today` to the consumer-zone date (incl. past → overdue-start)", () => {
    const hostToday = localToday(instant);
    let rewritten = 0;
    for (const zone of FAR_ZONES) {
      const consumerToday = calendarDateInZone(instant, zone);
      const res = normalizeConsumerWhen({ title: "x", when: "today" }, instant, zone);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      if (consumerToday === hostToday) {
        expect(res.params["when"]).toBe("today"); // byte-identical dispatch
      } else {
        expect(res.params["when"]).toBe(consumerToday); // explicit date (may be past)
        rewritten += 1;
      }
    }
    // The two zones are two days apart, so at least one always differs from host.
    expect(rewritten).toBeGreaterThanOrEqual(1);
  });

  it("refuses `evening` fail-closed when the consumer's today differs from the host's", () => {
    // At least one of these zones is guaranteed to differ from the host's date
    // for this instant (they are a day apart from each other).
    const kiritimati = normalizeConsumerWhen({ when: "evening" }, instant, "Pacific/Kiritimati");
    const midway = normalizeConsumerWhen({ when: "evening" }, instant, "Pacific/Midway");
    const refused = [kiritimati, midway].filter((r) => !r.ok);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const r of refused) {
      if (!r.ok) {
        expect(r.detail).toMatch(/This Evening/i);
        expect(r.remediation).toMatch(/when=\d{4}-\d{2}-\d{2}/);
        expect(r.remediation).toMatch(/time zone/i);
      }
    }
  });

  it("leaves non-clock tokens untouched", () => {
    for (const when of ["anytime", "someday", "2026-08-15"]) {
      const res = normalizeConsumerWhen({ when }, instant, "Asia/Tokyo");
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.params["when"]).toBe(when);
    }
  });

  it("is a no-op when the consumer's today equals the host's (same-zone-as-host)", () => {
    // Using the host's own resolved zone makes consumer-today == host-today, so
    // `today` is left as the literal token (byte-identical dispatch) and
    // `evening` is allowed through.
    const hostZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = normalizeConsumerWhen({ when: "today" }, instant, hostZone);
    expect(today.ok).toBe(true);
    if (today.ok) expect(today.params["when"]).toBe("today");
    expect(normalizeConsumerWhen({ when: "evening" }, instant, hostZone).ok).toBe(true);
  });
});
