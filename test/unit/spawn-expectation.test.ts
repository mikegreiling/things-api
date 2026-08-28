/**
 * THE SPAWN-EXPECTATION MAP (#634) — completeness, citations, and the assertion
 * in both mismatch directions.
 *
 * The field failure this locks: a successful after-completion promote with a
 * future anchor warned "could not derive the spawned instance … (the app may not
 * have materialized the current occurrence)" — a shrug at the app's own measured
 * behavior. The map turns each (rule kind × anchor relation) cell into a stated
 * expectation with an evidence citation, and the assertion only speaks when
 * reality and the map DISAGREE, or to name the date the caller is waiting for.
 */
import { describe, expect, it } from "vitest";

import type { IsoDate } from "../../src/model/dates.ts";
import { DISCLOSURES } from "../../src/write/disclosures.ts";
import {
  SPAWN_EXPECTATIONS,
  anchorRelation,
  assertSpawnExpectation,
  spawnExpectation,
  spawnRuleKind,
  type AnchorRelation,
  type SpawnRuleKind,
} from "../../src/write/spawn-expectation.ts";

// The two axes, restated HERE as literal lists. The map is typed as a total
// Record over both, so the compiler already refuses a missing cell; these
// literals make the test fail too if an axis grows without its cells being
// thought about — belt and braces on an RRF1 exhaustive map.
const RULE_KINDS: SpawnRuleKind[] = ["fixed", "fixed-preserved", "after-completion"];
const RELATIONS: AnchorRelation[] = ["today", "future", "past", "unknown"];

const iso = (s: string): IsoDate => s as IsoDate;
const TODAY = iso("2026-07-05");

describe("the map is EXHAUSTIVE over rule kind × anchor relation", () => {
  it("has an explicit entry for every cell", () => {
    expect(Object.keys(SPAWN_EXPECTATIONS).toSorted()).toEqual(RULE_KINDS.toSorted());
    for (const kind of RULE_KINDS) {
      expect(Object.keys(SPAWN_EXPECTATIONS[kind]).toSorted(), `${kind} relations`).toEqual(
        RELATIONS.toSorted(),
      );
    }
  });

  it("every cell carries a verdict AND an evidence citation", () => {
    for (const kind of RULE_KINDS) {
      for (const relation of RELATIONS) {
        const cell = spawnExpectation(kind, relation);
        expect(
          ["materialized", "pending", "pending-until-completion", "unpinned"],
          `${kind}/${relation} verdict`,
        ).toContain(cell.verdict);
        // A cell with no citation is an opinion, not a measurement.
        expect(cell.evidence.length, `${kind}/${relation} evidence`).toBeGreaterThan(10);
        expect(cell.why.length, `${kind}/${relation} rationale`).toBeGreaterThan(30);
      }
    }
  });

  it("the pinned cells name a real campaign; the unpinned ones say so plainly", () => {
    // The load-bearing cells of the field report, with the campaigns that measured them.
    expect(spawnExpectation("after-completion", "future").evidence).toContain("VMRES1");
    expect(spawnExpectation("after-completion", "future").evidence).toContain("ACFUT1");
    expect(spawnExpectation("after-completion", "today").evidence).toContain("CNCAC1");
    expect(spawnExpectation("fixed", "today").evidence).toContain("FGRD1");
    expect(spawnExpectation("fixed", "future").evidence).toContain("ANCH1");
    expect(spawnExpectation("fixed-preserved", "future").evidence).toContain("DBLSPAWN1");
  });
});

describe("classifying a landed promote into a cell", () => {
  it("the source fate decides fixed vs fixed-preserved; the rule decides after-completion", () => {
    expect(spawnRuleKind({ afterCompletion: false, preserved: false })).toBe("fixed");
    expect(spawnRuleKind({ afterCompletion: false, preserved: true })).toBe("fixed-preserved");
    expect(spawnRuleKind({ afterCompletion: true, preserved: false })).toBe("after-completion");
    // After-completion wins: its cells already account for the source fate.
    expect(spawnRuleKind({ afterCompletion: true, preserved: true })).toBe("after-completion");
  });

  it("the anchor relation is a plain local-day comparison", () => {
    expect(anchorRelation(iso("2026-07-05"), TODAY)).toBe("today");
    expect(anchorRelation(iso("2026-07-06"), TODAY)).toBe("future");
    expect(anchorRelation(iso("2026-07-04"), TODAY)).toBe("past");
    expect(anchorRelation(null, TODAY)).toBe("unknown");
  });
});

describe("the assertion speaks only when it has something to say", () => {
  it("THE FIELD CASE: after-completion + future anchor + no instance = a matter-of-fact NOTE", () => {
    const assertion = assertSpawnExpectation({
      kind: "after-completion",
      relation: "future",
      firstOccurrence: iso("2026-08-04"),
      todayIso: TODAY,
      found: false,
    });
    expect(assertion).not.toBeNull();
    expect(assertion?.id).toBe("instance-pending");
    // The tier is decided by the registry, and it is NOT a warning.
    expect(DISCLOSURES["instance-pending"].tier).toBe("note");
    // It names the date and the distance — the whole point of the reshape.
    expect(assertion?.text).toContain("2026-08-04");
    expect(assertion?.text).toContain("in 30 days");
    // And it never says the old shrug.
    expect(assertion?.text).not.toContain("could not derive");
  });

  it("expected AND present: silence — the caller already holds the instance", () => {
    expect(
      assertSpawnExpectation({
        kind: "fixed",
        relation: "today",
        firstOccurrence: TODAY,
        todayIso: TODAY,
        found: true,
      }),
    ).toBeNull();
  });

  it("MISMATCH ↓ expected-and-missing is a real warning", () => {
    const assertion = assertSpawnExpectation({
      kind: "fixed",
      relation: "today",
      firstOccurrence: TODAY,
      todayIso: TODAY,
      found: false,
    });
    expect(assertion?.id).toBe("instance-missing");
    expect(DISCLOSURES["instance-missing"].tier).toBe("warning");
    expect(assertion?.text).toContain("FGRD1"); // it cites what it expected, and why
  });

  it("MISMATCH ↑ unexpected-found is a real warning too", () => {
    const assertion = assertSpawnExpectation({
      kind: "fixed",
      relation: "future",
      firstOccurrence: iso("2026-07-12"),
      todayIso: TODAY,
      found: true,
    });
    expect(assertion?.id).toBe("instance-unexpected");
    expect(DISCLOSURES["instance-unexpected"].tier).toBe("warning");
    expect(assertion?.text).toMatch(/double-book/);
  });

  it("an UNPINNED cell asserts nothing in EITHER direction", () => {
    for (const found of [true, false]) {
      expect(
        assertSpawnExpectation({
          kind: "fixed",
          relation: "past",
          firstOccurrence: iso("2026-07-01"),
          todayIso: TODAY,
          found,
        }),
        `found=${found}`,
      ).toBeNull();
    }
  });

  it("a cursor-less after-completion series is told it waits for a completion, not a date", () => {
    const assertion = assertSpawnExpectation({
      kind: "after-completion",
      relation: "unknown",
      firstOccurrence: null,
      todayIso: TODAY,
      found: false,
    });
    expect(assertion?.id).toBe("instance-pending");
    expect(assertion?.text).toContain("checked off");
    expect(assertion?.text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no invented date
  });

  it("names tomorrow and today in words rather than 'in 1 days'", () => {
    const phrase = (date: string): string =>
      assertSpawnExpectation({
        kind: "fixed",
        relation: "future",
        firstOccurrence: iso(date),
        todayIso: TODAY,
        found: false,
      })?.text ?? "";
    expect(phrase("2026-07-06")).toContain("(tomorrow)");
    expect(phrase("2026-07-08")).toContain("(in 3 days)");
  });
});
