/**
 * Recurrence decoding (Phase 10b) — rule shapes mirror the 91-rule live
 * corpus (2026-07-04); the deadline model (startDate − ts) was validated
 * against the app's own spawned instances.
 */
import { describe, expect, it } from "vitest";

import { decodeRecurrenceRule, templateStatus } from "../../src/model/recurrence.ts";
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

// RRX1 (golden-v2 / 3.22.12, 2026-08-15) captured blobs, verbatim byte shapes:
// an --ends-after 3 daily rule writes rc=3 and OMITS the ed key entirely (the
// count is the configured total; it never decrements — rc stayed 3 through all
// three spawns AND past exhaustion).
const ENDS_AFTER_3_DAILY = ruleXml(`
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>16</integer>
  <key>of</key><array><dict><key>dy</key><integer>0</integer></dict></array>
  <key>rc</key><integer>3</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>0</integer>`);

// --ends-on 2026-07-08 (ed=1783468800), rc=0 (no count bound).
const ENDS_ON_DAILY = ruleXml(`
  <key>ed</key><real>1783468800</real>
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>16</integer>
  <key>of</key><array><dict><key>dy</key><integer>0</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>0</integer>`);

// --ends-on 2026-07-03 (ed=1783036800), a PAST date — a "born already ended"
// series (RRX1 EP: cursor NULL from creation, zero instances).
const ENDS_ON_PAST_DAILY = ruleXml(`
  <key>ed</key><real>1783036800</real>
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>16</integer>
  <key>of</key><array><dict><key>dy</key><integer>0</integer></dict></array>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>4</integer>
  <key>tp</key><integer>0</integer>
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
      occurrenceCount: null,
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

  it("decodes an --ends-after count as the immutable total occurrenceCount (RRX1)", () => {
    const rule = decodeRecurrenceRule(ENDS_AFTER_3_DAILY);
    expect(rule).toMatchObject({
      type: "fixed",
      unit: "daily",
      endDate: null, // ends-after omits the ed key
      occurrenceCount: 3, // the configured total, NOT a remaining tally
    });
  });

  it("decodes an --ends-on date as endDate with no count bound (RRX1)", () => {
    expect(decodeRecurrenceRule(ENDS_ON_DAILY)).toMatchObject({
      endDate: "2026-07-08",
      occurrenceCount: null,
    });
    // A past ends-on ("born already ended") decodes its date faithfully.
    expect(decodeRecurrenceRule(ENDS_ON_PAST_DAILY)).toMatchObject({
      endDate: "2026-07-03",
      occurrenceCount: null,
    });
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

describe("templateStatus — exhaustion is read from the cursor (RRX1)", () => {
  const endsAfter = decodeRecurrenceRule(ENDS_AFTER_3_DAILY);
  const endsOn = decodeRecurrenceRule(ENDS_ON_DAILY);
  const endsOnPast = decodeRecurrenceRule(ENDS_ON_PAST_DAILY);
  const afterCompletion = decodeRecurrenceRule(AFTER_COMPLETION_DAILY);
  const unlimited = decodeRecurrenceRule(BIWEEKLY_SUNDAY);

  it("an EXHAUSTED ends-after series (fixed, cursor cleared) is ended", () => {
    // The app stops an ends-after series by clearing the cursor once icCount
    // reaches the total; rc stays at the total (3), so the status MUST come from
    // the null cursor, not the count. This is the case the old
    // remainingCount===0 branch could never catch.
    expect(templateStatus({ rule: endsAfter, nextOccurrence: null }, "2026-07-08")).toBe("ended");
  });

  it("an ACTIVE ends-after series (cursor still set) is waiting", () => {
    expect(templateStatus({ rule: endsAfter, nextOccurrence: "2026-07-07" }, "2026-07-06")).toBe(
      "waiting",
    );
  });

  it("a past ends-on series is ended by its endDate even before the cursor clears", () => {
    expect(templateStatus({ rule: endsOnPast, nextOccurrence: "2026-07-04" }, "2026-07-05")).toBe(
      "ended",
    );
    // and once exhausted (cursor cleared) it is still ended
    expect(templateStatus({ rule: endsOnPast, nextOccurrence: null }, "2026-07-05")).toBe("ended");
  });

  it("an ACTIVE ends-on series (end date still ahead, cursor set) is waiting", () => {
    expect(templateStatus({ rule: endsOn, nextOccurrence: "2026-07-06" }, "2026-07-06")).toBe(
      "waiting",
    );
  });

  it("an after-completion rule resting with no next occurrence is waiting, NOT ended", () => {
    // A cleared cursor is a NORMAL resting state for after-completion rules
    // (the next date is unknown until the prior instance resolves), so the
    // cursor-exhaustion test is gated on fixed rules only.
    expect(templateStatus({ rule: afterCompletion, nextOccurrence: null }, "2026-07-08")).toBe(
      "waiting",
    );
  });

  it("paused wins over everything; an active unlimited fixed rule is waiting", () => {
    expect(
      templateStatus({ paused: true, rule: endsAfter, nextOccurrence: null }, "2026-07-08"),
    ).toBe("paused");
    expect(templateStatus({ rule: unlimited, nextOccurrence: "2026-07-19" }, "2026-07-06")).toBe(
      "waiting",
    );
  });
});

describe("upcoming occurrence synthesis", () => {
  const NOW = new Date(2026, 6, 2, 12, 0); // local 2026-07-02

  it("surfaces deadlined fixed templates at their next occurrence with the derived deadline", () => {
    const fx = buildFixtureDb();
    seedTodo(fx.db, { title: "plain-upcoming", start: "someday", startDate: "2026-07-10" });
    seedTodo(fx.db, {
      title: "cpap",
      recurrenceRuleXml: BIWEEKLY_SUNDAY,
      nextInstanceStartDate: "2026-07-15",
      // Deadlined (ts=-4 is only reachable via "Add deadlines"): its own
      // deadline column holds the 4001-01-01 sentinel (oddities §8a).
      deadline: "4001-01-01",
    });
    const items = upcomingView(fx.db, NOW);
    expect(items.map((i) => i.title)).toEqual(["plain-upcoming", "cpap"]);
    const occ = items[1];
    expect(occ?.startDate).toBe("2026-07-15");
    expect(occ?.deadline).toBe("2026-07-19"); // start − ts(-4)
    expect(occ?.repeating.isTemplate).toBe(true);
    expect(occ?.repeating.deadlined).toBe(true);
    fx.close();
  });

  it("deadline-less fixed templates surface with NO projected deadline (GUI default; UI1)", () => {
    const fx = buildFixtureDb();
    // Same rule, but no `deadline` column — the repeat editor's default. The
    // rule blob is byte-identical to the deadlined case, so only the column
    // tells them apart (oddities §8a).
    seedTodo(fx.db, {
      title: "cpap-nodl",
      recurrenceRuleXml: BIWEEKLY_SUNDAY,
      nextInstanceStartDate: "2026-07-15",
    });
    const occ = upcomingView(fx.db, NOW)[0];
    expect(occ?.startDate).toBe("2026-07-15");
    expect(occ?.deadline).toBe(null);
    expect(occ?.repeating.deadlined).toBe(false);
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
