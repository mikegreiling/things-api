/**
 * The full-fidelity recurrence assert builder (src/write/repeat-asserts.ts) — the
 * semantic backstop for issue #491 (a reschedule that changed only the monthly
 * anchor / deadline offset / ends / cursor read back a FALSE idempotent no-op
 * because the assert set was unit+interval only).
 *
 * The types alone (the exhaustive RULE_ASSERT_MAP) guarantee every field EARNS an
 * assertion or a skip; these tests are the runtime law the types cannot express:
 *
 *  - COHERENCE: the asserts built from a bag are SATISFIED against that bag's own
 *    simulated template state.
 *  - DISCRIMINATION: for two bags sharing a requested-field footprint but differing
 *    in ≥1 value, the asserts from A are UNSATISFIED against the state from B — the
 *    exact property #491 lacked.
 *  - REQUESTED-FIELDS-ONLY: a bag that requests FEWER fields is not failed by an
 *    untouched field in a richer state (the law that keeps a bare `{frequency,
 *    interval}` reschedule from tripping on an unrelated ends bound).
 *  - reminder is out of scope by design (skip-reason: not stored in the rule blob)
 *    — it is deliberately excluded from the discrimination corpus.
 *
 * "Simulated state" is a real template row seeded from the bag's composed rule
 * blob + deadline column + cursor, read back through the production decode
 * (byUuid) and evaluated through the production `evaluateDelta` — the SAME call the
 * pre-drive idempotency check makes.
 */
import { describe, expect, it } from "vitest";

import type { RepeatRuleParams } from "../../src/write/operations.ts";
import { composeRepeatRuleSpec, ruleXml } from "../../src/write/recurrence-rule-blob.ts";
import { assertRepeatRule } from "../../src/write/repeat-rule.ts";
import { deriveFixedAnchor } from "../../src/write/repeat-anchor.ts";
import { expectedRuleAssertions } from "../../src/write/repeat-asserts.ts";
import { createDbReader, evaluateDelta, type DeltaSpec } from "../../src/write/verify/delta.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

type Bag = Omit<RepeatRuleParams, "uuid">;

/** A bag with `--when` removed — its purely STRUCTURAL vocabulary (see the validity test). */
const stripWhen = ({ next: _next, ...rest }: Bag): Bag => rest;

const NOW = new Date("2026-07-05T12:00:00Z");
/** A forward-dated cursor default (a Tuesday), used where a bag omits --when. */
const REF: string = "2026-09-22";

let seq = 0;

/** Seed a template row mirroring the state a reschedule-to-`bag` produces. */
function simulateTemplate(db: FixtureDb, bag: Bag): string {
  const deadlined = bag.deadline === true || (bag.startDaysEarlier ?? 0) > 0;
  const spec = composeRepeatRuleSpec({ uuid: "x", ...bag }, bag.next ?? REF, 0);
  return seedTodo(db.db, {
    title: `tmpl-${seq++}`,
    start: "someday",
    recurrenceRuleXml: ruleXml(spec),
    deadline: deadlined ? "4001-01-01" : null,
    // When a bag pins --when, the reschedule sets the cursor to it (asserted); else
    // leave a benign non-asserted cursor so the row is a well-formed template.
    nextInstanceStartDate: bag.next ?? REF,
  });
}

/** The sorted asserted-field paths a bag produces (reminder-skip assertion). */
function assertFields(bag: Bag): string[] {
  return expectedRuleAssertions(bag, { includeCursor: true })
    .map((x) => x.field)
    .toSorted();
}

/** A tiny deterministic LCG — no new deps, reproducible fuzz. */
function makeRng(seedN: number): () => number {
  let s = seedN >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Does the assert set built from `assertBag` hold against the state from `stateBag`? */
function satisfies(db: FixtureDb, assertBag: Bag, stateUuid: string): boolean {
  const delta: DeltaSpec = {
    mode: "update",
    uuid: stateUuid,
    assert: expectedRuleAssertions(assertBag, { includeCursor: true }),
  };
  const reader = createDbReader(db.db, NOW);
  return evaluateDelta(delta, reader, { modDates: {}, fields: {} }).satisfied;
}

// ---- corpus ---------------------------------------------------------------
//
// Fully-populated base bags (every asserted field present) per fixed frequency,
// so a single-VALUE mutation stays within one footprint. after-completion (which
// forbids anchors/ends) and cross-frequency unit changes are separate minimal
// footprints below.

const baseDaily: Bag = {
  frequency: "daily",
  interval: 3,
  ends: { kind: "after", count: 10 },
  deadline: true,
  startDaysEarlier: 2,
  next: REF,
};
const baseWeekly: Bag = {
  frequency: "weekly",
  interval: 2,
  weekdays: ["tuesday", "thursday"],
  ends: { kind: "after", count: 5 },
  deadline: true,
  startDaysEarlier: 7,
  next: REF,
};
const baseMonthly: Bag = {
  frequency: "monthly",
  interval: 1,
  monthly: { weekday: "tuesday", ordinal: 4 },
  ends: { kind: "on-date", date: "2030-06-30" },
  deadline: true,
  startDaysEarlier: 14,
  next: REF,
};
const baseYearly: Bag = {
  frequency: "yearly",
  interval: 1,
  yearly: { month: 12, weekday: "sunday", ordinal: "last" },
  ends: { kind: "after", count: 4 },
  deadline: true,
  startDaysEarlier: 3,
  next: REF,
};

/** One-value mutations of a base bag (same requested-field footprint). */
function singleFieldMutants(base: Bag): { label: string; bag: Bag }[] {
  const out: { label: string; bag: Bag }[] = [
    { label: "interval", bag: { ...base, interval: base.interval + 1 } },
    {
      label: "ends-count",
      bag: { ...base, ends: { kind: "after", count: 42 } },
    },
    {
      label: "ends-kind",
      bag: { ...base, ends: { kind: "on-date", date: "2029-01-15" } },
    },
    { label: "startDaysEarlier", bag: { ...base, startDaysEarlier: 25 } },
    { label: "next", bag: { ...base, next: "2026-10-01" } },
  ];
  if (base.frequency === "weekly") {
    out.push({ label: "weekdays", bag: { ...base, weekdays: ["monday"] } });
  }
  if (base.frequency === "monthly") {
    out.push({ label: "monthly-anchor", bag: { ...base, monthly: { day: "last" } } });
  }
  if (base.frequency === "yearly") {
    out.push({
      label: "yearly-anchor",
      bag: { ...base, yearly: { month: 6, day: 15 } },
    });
  }
  return out;
}

const BASES: { name: string; bag: Bag }[] = [
  { name: "daily", bag: baseDaily },
  { name: "weekly", bag: baseWeekly },
  { name: "monthly", bag: baseMonthly },
  { name: "yearly", bag: baseYearly },
];

describe("expectedRuleAssertions — validity of the corpus", () => {
  // The corpus generates template STATES (not necessarily valid reschedule
  // REQUESTS): a base pins `--when` (REF) AND a fixed anchor AND a deadline shift
  // so a single-field mutant stays inside one requested-field footprint. Freely
  // mutating `--when` / `startDaysEarlier` / the anchor moves the first occurrence
  // off the anchor grid — a combination the DACON1 anchor/when law refuses at
  // request time (tested in repeat-rule.test.ts). Such off-anchor states still
  // ARISE (the app itself parks an off-rule cursor), and the assert builder must
  // discriminate them — so here we validate the STRUCTURAL vocabulary (anchor /
  // ends / deadline shapes) with `next` stripped, which is exactly the request
  // the anchor-derivation path would accept.
  it("every generated bag is structurally valid (anchor/when coupling aside)", () => {
    for (const { bag } of BASES) {
      expect(() => assertRepeatRule(stripWhen(bag))).not.toThrow();
      for (const m of singleFieldMutants(bag)) {
        expect(() => assertRepeatRule(stripWhen(m.bag)), m.label).not.toThrow();
      }
    }
  });
});

describe("COHERENCE: asserts(bag) satisfied against its own simulated state", () => {
  it("holds for every base + single-field mutant", () => {
    const db = buildFixtureDb();
    try {
      for (const { bag } of BASES) {
        expect(satisfies(db, bag, simulateTemplate(db, bag))).toBe(true);
        for (const m of singleFieldMutants(bag)) {
          expect(satisfies(db, m.bag, simulateTemplate(db, m.bag)), m.label).toBe(true);
        }
      }
    } finally {
      db.close();
    }
  });
});

describe("DISCRIMINATION: a single-field value change flips satisfaction (#491)", () => {
  it("asserts(base) UNSATISFIED against state(mutant), and the reverse", () => {
    const db = buildFixtureDb();
    try {
      for (const { name, bag } of BASES) {
        const baseState = simulateTemplate(db, bag);
        for (const m of singleFieldMutants(bag)) {
          const mutantState = simulateTemplate(db, m.bag);
          expect(satisfies(db, bag, mutantState), `${name}: base vs ${m.label}`).toBe(false);
          expect(satisfies(db, m.bag, baseState), `${name}: ${m.label} vs base`).toBe(false);
        }
      }
    } finally {
      db.close();
    }
  });
});

describe("DISCRIMINATION: minimal-footprint axes (unit, type, deadline flag)", () => {
  it("frequency/unit is discriminated (cross-frequency, minimal footprint)", () => {
    const db = buildFixtureDb();
    try {
      const units: Bag[] = [
        { frequency: "daily", interval: 2 },
        { frequency: "weekly", interval: 2 },
        { frequency: "monthly", interval: 2 },
        { frequency: "yearly", interval: 2 },
      ];
      const states = units.map((u) => simulateTemplate(db, u));
      for (let i = 0; i < units.length; i++) {
        for (let j = 0; j < units.length; j++) {
          const bagI = units[i];
          const stateJ = states[j];
          if (bagI === undefined || stateJ === undefined) continue;
          expect(satisfies(db, bagI, stateJ)).toBe(i === j);
        }
      }
    } finally {
      db.close();
    }
  });

  it("rule TYPE (fixed vs after-completion) is discriminated", () => {
    const db = buildFixtureDb();
    try {
      const fixed: Bag = { frequency: "weekly", interval: 2 };
      const after: Bag = { frequency: "weekly", interval: 2, afterCompletion: true };
      const fixedState = simulateTemplate(db, fixed);
      const afterState = simulateTemplate(db, after);
      expect(satisfies(db, fixed, afterState)).toBe(false);
      expect(satisfies(db, after, fixedState)).toBe(false);
      expect(satisfies(db, fixed, fixedState)).toBe(true);
      expect(satisfies(db, after, afterState)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("the deadline FLAG is discriminated (minimal footprint)", () => {
    const db = buildFixtureDb();
    try {
      const deadlined: Bag = { frequency: "daily", interval: 1, deadline: true };
      const plain: Bag = { frequency: "daily", interval: 1, deadline: false };
      expect(satisfies(db, deadlined, simulateTemplate(db, plain))).toBe(false);
      expect(satisfies(db, plain, simulateTemplate(db, deadlined))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("DISCRIMINATION: derived calendar anchor closes the #493 verify-hole (YANCH1)", () => {
  // promote-clone derives the anchor from --when when none is given; the effective
  // params carry it, so the anchorKey assertion catches a DROPPED anchor — the
  // exact hole that let a January-1 yearly rule verify `ok` (#493).
  it("a --when-derived yearly Oct-16 anchor REJECTS a January-1 landing", () => {
    const db = buildFixtureDb();
    try {
      const requested: Bag = { frequency: "yearly", interval: 1 };
      const effective: Bag = { ...requested, ...deriveFixedAnchor(requested, "2027-10-16") };
      expect(effective.yearly).toEqual({ month: 10, day: 16 });
      // The #493 bug landing: the dialog's untouched January-1 default anchor.
      const janOne: Bag = { frequency: "yearly", interval: 1, yearly: { month: 1, day: 1 } };
      expect(satisfies(db, effective, simulateTemplate(db, janOne))).toBe(false);
      // ...and SATISFIED by the correctly-anchored Oct-16 state.
      expect(satisfies(db, effective, simulateTemplate(db, effective))).toBe(true);
    } finally {
      db.close();
    }
  });
  it("a --when-derived monthly day-16 anchor REJECTS a 1st-of-month landing", () => {
    const db = buildFixtureDb();
    try {
      const requested: Bag = { frequency: "monthly", interval: 1 };
      const effective: Bag = { ...requested, ...deriveFixedAnchor(requested, "2027-10-16") };
      expect(effective.monthly).toEqual({ day: 16 });
      const firstOfMonth: Bag = { frequency: "monthly", interval: 1, monthly: { day: 1 } };
      expect(satisfies(db, effective, simulateTemplate(db, firstOfMonth))).toBe(false);
      expect(satisfies(db, effective, simulateTemplate(db, effective))).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("REQUESTED-FIELDS-ONLY: a leaner bag is not failed by an untouched field", () => {
  it("bare {frequency, interval} is satisfied by a richly-configured state", () => {
    const db = buildFixtureDb();
    try {
      // The rich state carries an anchor, ends, deadline, offset, cursor — none of
      // which the bare bag requested. It must still read as satisfied.
      const rich = simulateTemplate(db, baseWeekly);
      expect(satisfies(db, { frequency: "weekly", interval: 2 }, rich)).toBe(true);
      // But a DIFFERENT interval still fails — the requested field is enforced.
      expect(satisfies(db, { frequency: "weekly", interval: 3 }, rich)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("a reminder-only difference does NOT change the assert set (skip-by-design)", () => {
    // reminder is not stored in the rule blob (RRX1 skip-reason), so it contributes
    // no assertion and is intentionally not discriminated here.
    const a: Bag = { frequency: "daily", interval: 1, reminder: "09:00" };
    const b: Bag = { frequency: "daily", interval: 1, reminder: "14:30" };
    expect(assertFields(a)).toEqual(assertFields(b));
    expect(assertFields(a).some((f) => f.includes("reminder"))).toBe(false);
  });
});

describe("DISCRIMINATION: random same-footprint pairs (fuzz)", () => {
  /** A canonical fully-populated weekly bag with randomized asserted values. */
  function randomWeekly(rng: () => number): Bag {
    const WD = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
    // A sorted (canonical) non-empty weekday subset so raw inequality ⇒ anchor
    // inequality (order-insensitive keys would otherwise collide).
    const picks = WD.filter(() => rng() < 0.5);
    const weekdays = (picks.length > 0 ? picks : [WD[Math.floor(rng() * WD.length)]!]).slice();
    const interval = 1 + Math.floor(rng() * 6);
    const startDaysEarlier = Math.floor(rng() * 20);
    const ends: Bag["ends"] =
      rng() < 0.5
        ? { kind: "after", count: 1 + Math.floor(rng() * 50) }
        : { kind: "on-date", date: `203${Math.floor(rng() * 9)}-06-15` };
    const nextDay = 10 + Math.floor(rng() * 18);
    return {
      frequency: "weekly",
      interval,
      weekdays,
      ends,
      deadline: true,
      startDaysEarlier,
      next: `2026-09-${nextDay}`,
    };
  }

  it("distinct canonical bags never satisfy each other's state; identical ones do", () => {
    const db = buildFixtureDb();
    try {
      const rng = makeRng(0xc0ffee);
      const bags = Array.from({ length: 24 }, () => randomWeekly(rng));
      const states = bags.map((b) => simulateTemplate(db, b));
      for (let i = 0; i < bags.length; i++) {
        for (let j = 0; j < bags.length; j++) {
          const bagI = bags[i];
          const bagJ = bags[j];
          const stateJ = states[j];
          if (bagI === undefined || bagJ === undefined || stateJ === undefined) continue;
          const equal = JSON.stringify(bagI) === JSON.stringify(bagJ);
          expect(satisfies(db, bagI, stateJ), `${i}->${j}`).toBe(equal);
        }
      }
    } finally {
      db.close();
    }
  });
});
