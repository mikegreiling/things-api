/**
 * Recurrence decoding (Phase 10b) — rule shapes mirror the 91-rule live
 * corpus (2026-07-04); the deadline model (startDate − ts) was validated
 * against the app's own spawned instances.
 */
import { describe, expect, it } from "vitest";

import { decodeRecurrenceRule } from "../../src/model/recurrence.ts";
import { byUuid } from "../../src/read/detail.ts";
import { upcomingView } from "../../src/read/views.ts";
import { buildFixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

function ruleXml(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>${entries}</dict>
</plist>`;
}

const BIWEEKLY_SUNDAY = ruleXml(`
  <key>ed</key><real>64092211200</real>
  <key>fa</key><integer>2</integer>
  <key>fu</key><integer>256</integer>
  <key>of</key><array><dict><key>wd</key><integer>0</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>-4</integer>`);

const YEARLY_BIRTHDAY = ruleXml(`
  <key>ed</key><real>64092211200</real>
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>4</integer>
  <key>of</key><array><dict><key>dy</key><integer>8</integer><key>mo</key><integer>10</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>0</integer>`);

const MONTHLY_LAST_FRIDAY = ruleXml(`
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>8</integer>
  <key>of</key><array><dict><key>wd</key><integer>5</integer><key>wdo</key><integer>-1</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>-14</integer>`);

const AFTER_COMPLETION_DAILY = ruleXml(`
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>16</integer>
  <key>of</key><array><dict><key>dy</key><integer>0</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>1</integer>
  <key>ts</key><integer>0</integer>`);

describe("decodeRecurrenceRule", () => {
  it("decodes every-2-weeks-on-Sunday with a 4-day-early start", () => {
    const rule = decodeRecurrenceRule(BIWEEKLY_SUNDAY);
    expect(rule).toMatchObject({
      type: "fixed",
      unit: "weekly",
      interval: 2,
      startOffsetDays: -4,
      offsets: [{ weekday: 0 }],
      endDate: null,
      remainingCount: null,
      version: 4,
    });
  });

  it("decodes a yearly date rule with 1-based month/day", () => {
    const rule = decodeRecurrenceRule(YEARLY_BIRTHDAY);
    expect(rule.unit).toBe("yearly");
    // plist dy=8/mo=10 are 0-based → November 9th.
    expect(rule.offsets).toEqual([{ day: 9, month: 11 }]);
  });

  it("decodes monthly last-Friday and after-completion daily", () => {
    expect(decodeRecurrenceRule(MONTHLY_LAST_FRIDAY).offsets).toEqual([
      { weekday: 5, weekdayOrdinal: -1 },
    ]);
    expect(decodeRecurrenceRule(AFTER_COMPLETION_DAILY)).toMatchObject({
      type: "after-completion",
      unit: "daily",
    });
  });

  it("fails loudly on unknown units and non-plist blobs", () => {
    expect(() => decodeRecurrenceRule(ruleXml("<key>fu</key><integer>99</integer>"))).toThrow();
    expect(() => decodeRecurrenceRule(new Uint8Array([0x62, 0x70]))).toThrow();
  });

  it("fails loudly on a rule-format version bump (rrv != 4) — the Things-update canary", () => {
    const V5 = ruleXml(`
      <key>fa</key><integer>1</integer>
      <key>fu</key><integer>16</integer>
      <key>rc</key><integer>0</integer>
      <key>rrv</key><integer>5</integer>
      <key>tp</key><integer>0</integer>
      <key>ts</key><integer>0</integer>`);
    expect(() => decodeRecurrenceRule(V5)).toThrow(/rrv=5/);
    // Missing rrv (version 0) is equally unvalidated — refuse, don't guess.
    const NO_VERSION = ruleXml(`
      <key>fa</key><integer>1</integer>
      <key>fu</key><integer>16</integer>
      <key>rc</key><integer>0</integer>
      <key>tp</key><integer>0</integer>
      <key>ts</key><integer>0</integer>`);
    expect(() => decodeRecurrenceRule(NO_VERSION)).toThrow(/rrv=0/);
  });
});

describe("upcoming occurrence synthesis", () => {
  const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02

  it("surfaces fixed templates at their next occurrence with the derived deadline", () => {
    const fx = buildFixtureDb();
    seedTodo(fx.db, { title: "plain-upcoming", start: "someday", startDate: "2026-07-10" });
    seedTodo(fx.db, {
      title: "cpap",
      recurrenceRuleXml: BIWEEKLY_SUNDAY,
      nextInstanceStartDate: "2026-07-15",
    });
    const items = upcomingView(fx.db, NOW);
    expect(items.map((i) => i.title)).toEqual(["plain-upcoming", "cpap"]);
    const occ = items[1];
    expect(occ?.startDate).toBe("2026-07-15");
    expect(occ?.deadline).toBe("2026-07-19"); // start − ts(-4)
    expect(occ?.repeating.isTemplate).toBe(true);
    fx.close();
  });

  it("appends paused/between-instances templates as no-date resting rows; repeats:false drops them", () => {
    const fx = buildFixtureDb();
    seedTodo(fx.db, {
      title: "paused",
      recurrenceRuleXml: BIWEEKLY_SUNDAY,
      nextInstanceStartDate: "2026-07-15",
      instanceCreationPaused: true,
    });
    seedTodo(fx.db, { title: "after-completion", recurrenceRuleXml: AFTER_COMPLETION_DAILY });
    seedTodo(fx.db, {
      title: "already-spawned",
      recurrenceRuleXml: BIWEEKLY_SUNDAY,
      nextInstanceStartDate: "2026-07-01",
    });
    seedTodo(fx.db, {
      title: "active",
      recurrenceRuleXml: MONTHLY_LAST_FRIDAY,
      nextInstanceStartDate: "2026-07-17",
    });
    // GUI parity: only "active" gets a dated occurrence; the paused,
    // between-instances (after-completion), and stale-next templates trail
    // as the Repeating To-Dos section — startDate null, rule attached.
    const items = upcomingView(fx.db, NOW);
    expect(items.map((i) => i.title)).toEqual([
      "active",
      "paused",
      "after-completion",
      "already-spawned",
    ]);
    const resting = items.slice(1);
    expect(resting.every((i) => i.startDate === null && i.repeating.isTemplate)).toBe(true);
    expect(resting.every((i) => i.repeating.rule !== undefined)).toBe(true);
    expect(upcomingView(fx.db, NOW, { repeats: false })).toEqual([]);
    fx.close();
  });

  it("byUuid exposes the decoded rule + next occurrence on templates", () => {
    const fx = buildFixtureDb();
    const uuid = seedTodo(fx.db, {
      title: "tmpl",
      recurrenceRuleXml: YEARLY_BIRTHDAY,
      nextInstanceStartDate: "2026-11-09",
    });
    const entity = byUuid(fx.db, uuid);
    expect(entity?.type).toBe("to-do");
    if (entity?.type === "to-do") {
      expect(entity.repeating.rule?.unit).toBe("yearly");
      expect(entity.repeating.nextOccurrence).toBe("2026-11-09");
      expect(entity.repeating.paused).toBe(false);
    }
    fx.close();
  });
});
