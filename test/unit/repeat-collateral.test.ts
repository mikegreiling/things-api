/**
 * The collateral ATTRIBUTION MAP (CGRD1 guard 3), tested the way RRF1's assertion
 * builder is: the types make the map exhaustive, and these tests supply the
 * semantics the types cannot — that a requested field explains its own movement,
 * that each mapped co-mover explains the movement it claims to, and that an
 * `independent` field explains nothing no matter what was requested.
 */
import { describe, expect, it } from "vitest";

import type { RepeatRule } from "../../src/model/recurrence.ts";
import {
  collateralFindings,
  COLLATERAL_FIELD_PATHS,
  describeCollateral,
} from "../../src/write/repeat-collateral.ts";
import type { RuleFields } from "../../src/write/repeat-asserts.ts";

/** A decoded-rule pre-state bag over the whole watched vocabulary. */
function bag(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    "repeating.rule.type": "fixed",
    "repeating.rule.unit": "weekly",
    "repeating.rule.interval": 1,
    "repeating.rule.startOffsetDays": 0,
    "repeating.rule.anchorKey": "w1",
    "repeating.rule.endDate": null,
    "repeating.rule.occurrenceCount": null,
    "repeating.rule.version": 4,
    "repeating.deadlined": false,
    "repeating.nextOccurrence": "2026-07-13",
    "repeating.paused": false,
  };
  return { ...base, ...overrides };
}

const req = (...keys: (keyof RuleFields)[]): ReadonlySet<keyof RuleFields> => new Set(keys);

describe("collateral attribution — the watched vocabulary", () => {
  it("watches every decoded-rule field plus the template columns beside it", () => {
    // The mapped type makes this exhaustive at COMPILE time; this asserts the set
    // is what the write layer actually reads, so a silent path rename is caught.
    const ruleKeys: (keyof RepeatRule)[] = [
      "type",
      "unit",
      "interval",
      "startOffsetDays",
      "offsets",
      "endDate",
      "occurrenceCount",
      "version",
    ];
    expect(COLLATERAL_FIELD_PATHS).toHaveLength(ruleKeys.length + 3);
    for (const path of [
      "repeating.rule.type",
      "repeating.rule.unit",
      "repeating.rule.interval",
      "repeating.rule.startOffsetDays",
      // the calendar anchor is compared through its canonical order-insensitive key
      "repeating.rule.anchorKey",
      "repeating.rule.endDate",
      "repeating.rule.occurrenceCount",
      "repeating.rule.version",
      "repeating.deadlined",
      "repeating.nextOccurrence",
      "repeating.paused",
    ]) {
      expect(COLLATERAL_FIELD_PATHS).toContain(path);
    }
  });

  it("an unchanged rule yields nothing, whatever was requested", () => {
    expect(collateralFindings(req("frequency", "interval"), bag(), bag())).toEqual([]);
    expect(collateralFindings(req(), bag(), bag())).toEqual([]);
  });

  it("yields nothing when there is no pre-rule to diff (a freshly minted template)", () => {
    // make-repeating / add-repeating MINT the rule, so every field is new by
    // construction; reporting all of them as collateral would be nonsense.
    const pre = bag({ "repeating.rule.unit": null });
    expect(
      collateralFindings(req("frequency"), pre, bag({ "repeating.rule.unit": "daily" })),
    ).toEqual([]);
  });
});

describe("collateral attribution — requested fields explain themselves", () => {
  const cases: { param: keyof RuleFields; path: string; after: unknown }[] = [
    { param: "frequency", path: "repeating.rule.unit", after: "daily" },
    { param: "interval", path: "repeating.rule.interval", after: 4 },
    { param: "afterCompletion", path: "repeating.rule.type", after: "after-completion" },
    { param: "weekdays", path: "repeating.rule.anchorKey", after: "w3" },
    { param: "ends", path: "repeating.rule.occurrenceCount", after: 6 },
    { param: "ends", path: "repeating.rule.endDate", after: "2026-12-01" },
    { param: "startDaysEarlier", path: "repeating.rule.startOffsetDays", after: -2 },
    { param: "deadline", path: "repeating.deadlined", after: true },
    { param: "next", path: "repeating.nextOccurrence", after: "2026-08-01" },
  ];
  for (const c of cases) {
    it(`${c.path} moving is explained by requesting ${String(c.param)}`, () => {
      const post = bag({ [c.path]: c.after });
      expect(collateralFindings(req(c.param), bag(), post)).toEqual([]);
      // …and is NOT explained when nothing relevant was requested. `reminder` is
      // the control: it is the one rule-vocabulary key that attributes nothing (it
      // never reaches the rule blob — RRF1's written skip).
      const unexplained = collateralFindings(req("reminder"), bag(), post);
      expect(unexplained.map((f) => f.field)).toContain(c.path);
    });
  }
});

describe("collateral attribution — the mapped co-movers", () => {
  it("a frequency change explains the calendar anchor being rebuilt", () => {
    const post = bag({ "repeating.rule.unit": "monthly", "repeating.rule.anchorKey": "d1" });
    expect(collateralFindings(req("frequency"), bag(), post)).toEqual([]);
  });

  it("a first-occurrence request explains a DERIVED anchor (YANCH1 #493)", () => {
    const post = bag({ "repeating.rule.anchorKey": "d15" });
    expect(collateralFindings(req("next"), bag(), post)).toEqual([]);
  });

  it("an after-completion conversion explains the anchor resetting to nominal", () => {
    const post = bag({ "repeating.rule.type": "after-completion", "repeating.rule.anchorKey": "" });
    expect(collateralFindings(req("afterCompletion"), bag(), post)).toEqual([]);
  });

  it("a deadline request explains the start offset moving with it", () => {
    const post = bag({ "repeating.deadlined": true, "repeating.rule.startOffsetDays": -3 });
    expect(collateralFindings(req("deadline"), bag(), post)).toEqual([]);
  });

  it("a start-offset request explains the deadline flag being ticked (#492)", () => {
    const post = bag({ "repeating.deadlined": true, "repeating.rule.startOffsetDays": -3 });
    expect(collateralFindings(req("startDaysEarlier"), bag(), post)).toEqual([]);
  });

  it("any cadence or anchor change explains the next-occurrence cursor recomputing", () => {
    for (const param of [
      "frequency",
      "interval",
      "weekdays",
      "monthly",
      "yearly",
      "afterCompletion",
      "ends",
      "deadline",
      "startDaysEarlier",
    ] as (keyof RuleFields)[]) {
      const post = bag({ "repeating.nextOccurrence": "2026-09-09" });
      expect(collateralFindings(req(param), bag(), post)).toEqual([]);
    }
  });

  it("an ends change explains the cursor being CLEARED (an exhausted series, RRX1)", () => {
    const post = bag({ "repeating.nextOccurrence": null, "repeating.rule.occurrenceCount": 2 });
    expect(collateralFindings(req("ends"), bag(), post)).toEqual([]);
  });
});

describe("collateral attribution — independent fields are never explained away", () => {
  it("the paused flag is collateral no matter what was requested", () => {
    const post = bag({ "repeating.paused": true });
    for (const param of [
      "frequency",
      "interval",
      "ends",
      "deadline",
      "next",
      "afterCompletion",
    ] as (keyof RuleFields)[]) {
      const found = collateralFindings(req(param), bag(), post);
      expect(found.map((f) => f.field)).toEqual(["repeating.paused"]);
    }
  });

  it("the rule's storage-format version is collateral — the app changed under us", () => {
    const post = bag({ "repeating.rule.version": 5 });
    const found = collateralFindings(req("frequency", "interval"), bag(), post);
    expect(found.map((f) => f.field)).toEqual(["repeating.rule.version"]);
  });
});

describe("collateral attribution — the failure copy", () => {
  it("names each field with both values, and says a retry is the wrong move", () => {
    const post = bag({ "repeating.paused": true, "repeating.rule.version": 5 });
    const found = collateralFindings(req("frequency", "interval"), bag(), post);
    expect(found).toHaveLength(2);
    const text = describeCollateral(found);
    expect(text).toContain("the requested repeat rule was applied");
    expect(text).toContain("2 fields nobody asked to change also moved");
    expect(text).toContain("the paused flag went from false to true");
    expect(text).toContain("the rule's storage-format version went from 4 to 5");
    expect(text).toContain("a retry would repeat it");
  });

  it("reads a null as 'none' rather than leaking a literal null", () => {
    const found = collateralFindings(
      req("frequency"),
      bag({ "repeating.paused": true }),
      bag({ "repeating.paused": null }),
    );
    expect(describeCollateral(found)).toContain("went from true to none");
  });

  it("uses the singular when exactly one field moved", () => {
    const found = collateralFindings(req("frequency"), bag(), bag({ "repeating.paused": true }));
    expect(describeCollateral(found)).toContain("a field nobody asked to change also moved");
  });
});
