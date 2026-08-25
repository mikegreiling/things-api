/**
 * The update-vocabulary registry (src/write/update-fields.ts) — the #491
 * exhaustive-map doctrine applied to the WIDEST multi-consumer vocabulary in the
 * write engine (`todo.update` / `project.update`).
 *
 * The types alone guarantee every field EARNS a wire leg, an assert leg, an undo
 * leg and a consumer-flag mapping (or a written skip). These tests are the
 * runtime laws the types cannot express:
 *
 *  - NO ACCEPTED-BUT-DROPPED: every requested field reaches the URL (or its
 *    value rides another parameter, which is asserted explicitly).
 *  - COHERENCE: the asserts built from a patch are SATISFIED against the state
 *    that patch produces.
 *  - DISCRIMINATION: for two patches sharing a requested-field footprint but
 *    differing in ≥1 value, the asserts from A are UNSATISFIED against the state
 *    from B — so a silent app no-op on any single field is a verify failure, not
 *    a shallow pass.
 *  - REQUESTED-FIELDS-ONLY: a leaner patch is not failed by an untouched field.
 *  - MAPPER COMPLETENESS: the consumer builder produces every field of the
 *    vocabulary, and refuses every contradictory flag pair instead of silently
 *    resolving it in favor of one flag.
 */
import { describe, expect, it } from "vitest";

import { localToday, type IsoDate } from "../../src/model/dates.ts";
import type { UpdateFields } from "../../src/write/operations.ts";
import { emptyPreState, loadTarget, type PreState } from "../../src/write/pre-state.ts";
import {
  buildUpdatePatch,
  CLI_UPDATE_LABELS,
  MCP_UPDATE_LABELS,
  updateAssertions,
  updateRestoreParams,
  updateWireParams,
} from "../../src/write/update-fields.ts";
import { createDbReader, evaluateDelta, type DeltaSpec } from "../../src/write/verify/delta.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const TODAY = localToday(NOW);

/**
 * The vocabulary, enumerated ONCE for the corpus. The exhaustive `Record` is the
 * compile-time backstop: a field added to {@link UpdateFields} breaks this file
 * until the corpus below covers it too.
 */
const VOCABULARY_FLAGS: Record<keyof UpdateFields, true> = {
  title: true,
  notes: true,
  appendNotes: true,
  prependNotes: true,
  when: true,
  reminder: true,
  deadline: true,
};
const VOCABULARY = Object.keys(VOCABULARY_FLAGS) as (keyof UpdateFields)[];

/** A patch bag; every corpus bag pins a DATED when (its assertions are exact). */
type Bag = UpdateFields;

/** A pre-state whose target is a seeded row (append/prepend + reminder-preserve). */
function preFor(db: FixtureDb, uuid: string | null): PreState {
  const pre = emptyPreState();
  pre.todayIso = TODAY;
  if (uuid !== null) pre.target = loadTarget(db.db, uuid);
  return pre;
}

/** Seed the row a patch LEAVES BEHIND (the post-update state it asserts about). */
function stateFor(db: FixtureDb, bag: Bag): string {
  const when = bag.when;
  const dated = typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when);
  return seedTodo(db.db, {
    title: bag.title ?? "base-title",
    notes: bag.notes ?? "",
    start: when === "someday" ? "someday" : "active",
    startDate: dated ? when : when === "today" || when === "evening" ? TODAY : null,
    evening: when === "evening",
    reminder: bag.reminder ?? null,
    deadline: bag.deadline ?? null,
  });
}

/** Does the assert set built from `bag` hold against the row `stateUuid`? */
function satisfies(db: FixtureDb, bag: Bag, stateUuid: string): boolean {
  const delta: DeltaSpec = {
    mode: "update",
    uuid: stateUuid,
    assert: updateAssertions(bag, preFor(db, null), { todayIso: TODAY }),
  };
  return evaluateDelta(delta, createDbReader(db.db, NOW), { modDates: {}, fields: {} }).satisfied;
}

// A fully-populated patch: every asserted field present, so a single-value
// mutation stays inside ONE requested-field footprint.
const BASE: Bag = {
  title: "base-title",
  notes: "base-notes",
  when: "2026-08-01" as IsoDate,
  reminder: "09:00",
  deadline: "2026-09-01" as IsoDate,
};

const MUTANTS: { label: string; bag: Bag }[] = [
  { label: "title", bag: { ...BASE, title: "other-title" } },
  { label: "notes", bag: { ...BASE, notes: "other-notes" } },
  { label: "when", bag: { ...BASE, when: "2026-08-02" as IsoDate } },
  { label: "reminder", bag: { ...BASE, reminder: "10:30" } },
  { label: "deadline", bag: { ...BASE, deadline: "2026-09-02" as IsoDate } },
];

describe("the registry is exhaustive over the vocabulary", () => {
  it("emits a URL parameter for every field the caller can set", () => {
    const db = buildFixtureDb();
    try {
      const wire = updateWireParams(BASE, preFor(db, null));
      // Every requested field lands on the wire under its own parameter...
      expect(wire["title"]).toBe("base-title");
      expect(wire["notes"]).toBe("base-notes");
      expect(wire["deadline"]).toBe("2026-09-01");
      // ...and the reminder — the ONE field with a wire skip — rides the `when`
      // value's @time suffix rather than being silently dropped.
      expect(wire["when"]).toMatch(/^2026-08-01@/);
    } finally {
      db.close();
    }
  });

  it("the append/prepend legs reach the wire under their own parameters", () => {
    const db = buildFixtureDb();
    try {
      const pre = preFor(db, null);
      expect(updateWireParams({ appendNotes: "tail" }, pre)["append-notes"]).toBe("tail");
      expect(updateWireParams({ prependNotes: "head" }, pre)["prepend-notes"]).toBe("head");
    } finally {
      db.close();
    }
  });

  it("EVERY field, requested alone, produces both a wire parameter and an assertion", () => {
    // The two halves of "accepted but dropped": a field that reaches no URL
    // parameter, and a field that nothing asserts (so a silent no-op verifies
    // ok). `reminder` is the one documented exception on the wire — it rides the
    // `when` value — and is covered by its own case above.
    const alone: Record<keyof UpdateFields, UpdateFields> = {
      title: { title: "x" },
      notes: { notes: "x" },
      appendNotes: { appendNotes: "x" },
      prependNotes: { prependNotes: "x" },
      when: { when: "someday" },
      reminder: { when: "today", reminder: "09:00" },
      deadline: { deadline: "2026-09-01" as IsoDate },
    };
    const db = buildFixtureDb();
    try {
      const pre = preFor(db, null);
      for (const key of VOCABULARY) {
        const patch = alone[key];
        const wire = Object.values(updateWireParams(patch, pre)).filter((v) => v !== undefined);
        expect(wire.length, `${key}: no URL parameter`).toBeGreaterThan(0);
        const asserts = updateAssertions(patch, pre, { todayIso: TODAY });
        expect(asserts.length, `${key}: nothing asserted`).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });

  it("a clear (null) is a first-class value on the wire and in the asserts", () => {
    const db = buildFixtureDb();
    try {
      const pre = preFor(db, null);
      // The URL spells a deadline clear as the EMPTY string, not a dropped param.
      expect(updateWireParams({ deadline: null }, pre)["deadline"]).toBe("");
      expect(updateAssertions({ deadline: null }, pre, { todayIso: TODAY })).toEqual([
        { field: "deadline", equals: null },
      ]);
      // A reminder clear rides a re-stated when= (R07) and is asserted as null.
      expect(
        updateAssertions({ when: "today", reminder: null }, pre, { todayIso: TODAY }),
      ).toContainEqual({ field: "reminder", equals: null });
    } finally {
      db.close();
    }
  });
});

describe("COHERENCE: asserts(patch) hold against the state that patch produces", () => {
  it("holds for the base patch and every single-field mutant", () => {
    const db = buildFixtureDb();
    try {
      expect(satisfies(db, BASE, stateFor(db, BASE))).toBe(true);
      for (const m of MUTANTS) {
        expect(satisfies(db, m.bag, stateFor(db, m.bag)), m.label).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("holds for the keyword schedules (today / evening / anytime / someday)", () => {
    const db = buildFixtureDb();
    try {
      for (const when of ["today", "evening", "anytime", "someday"] as const) {
        // anytime/someday carry no date for a reminder to attach to (the
        // H-REMINDER-SCOPE law), so those two are asserted schedule-only.
        const schedulable = when === "today" || when === "evening";
        const bag: Bag = schedulable ? { when, reminder: "07:45" } : { when };
        expect(satisfies(db, bag, stateFor(db, bag)), when).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});

describe("DISCRIMINATION: a single-field value change flips satisfaction", () => {
  it("asserts(base) UNSATISFIED against state(mutant), and the reverse", () => {
    const db = buildFixtureDb();
    try {
      const baseState = stateFor(db, BASE);
      for (const m of MUTANTS) {
        const mutantState = stateFor(db, m.bag);
        expect(satisfies(db, BASE, mutantState), `base vs ${m.label}`).toBe(false);
        expect(satisfies(db, m.bag, baseState), `${m.label} vs base`).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("a dropped reminder on an otherwise-correct write FAILS verification", () => {
    // The pre-registry hazard: the reminder rides the `when` parameter, so a
    // vector that carried the date but not the token would land a reminder-less
    // row. The reminder assertion is what makes that a verify failure.
    const db = buildFixtureDb();
    try {
      const landed = stateFor(db, {
        title: "base-title",
        notes: "base-notes",
        when: "2026-08-01" as IsoDate,
        deadline: "2026-09-01" as IsoDate,
      });
      expect(satisfies(db, BASE, landed)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("REQUESTED-FIELDS-ONLY: a leaner patch is not failed by an untouched field", () => {
  it("a title-only patch is satisfied by a richly-populated state", () => {
    const db = buildFixtureDb();
    try {
      const rich = stateFor(db, BASE);
      expect(satisfies(db, { title: "base-title" }, rich)).toBe(true);
      expect(satisfies(db, { title: "different" }, rich)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("the target's pre-state feeds the notes join and the reminder preserve", () => {
  it("append/prepend assert the RESULTING body, joined onto the current notes", () => {
    const db = buildFixtureDb();
    try {
      const uuid = seedTodo(db.db, { notes: "old" });
      const pre = preFor(db, uuid);
      expect(updateAssertions({ appendNotes: "tail" }, pre, { todayIso: TODAY })).toEqual([
        { field: "notes", equals: "old\ntail" },
      ]);
      expect(updateAssertions({ prependNotes: "head" }, pre, { todayIso: TODAY })).toEqual([
        { field: "notes", equals: "head\nold" },
      ]);
    } finally {
      db.close();
    }
  });

  it("a bare when= carries the target's LIVE reminder onto the wire and asserts it", () => {
    const db = buildFixtureDb();
    try {
      const uuid = seedTodo(db.db, { start: "active", startDate: TODAY, reminder: "08:15" });
      const pre = preFor(db, uuid);
      expect(updateWireParams({ when: "today" }, pre)["when"]).toMatch(/^today@/);
      expect(updateAssertions({ when: "today" }, pre, { todayIso: TODAY })).toContainEqual({
        field: "reminder",
        equals: "08:15",
      });
    } finally {
      db.close();
    }
  });
});

describe("the undo inverse is registry-derived", () => {
  it("restores exactly the per-field pre-values that were captured", () => {
    // The audit record captures the ASSERTED fields; the schedule axis is
    // restored by undo's schedule reconstructor, not per field (written skips).
    expect(
      updateRestoreParams({
        title: "was",
        notes: "before",
        deadline: "2026-01-01",
        startDate: "2026-02-02",
        reminder: "06:00",
      }),
    ).toEqual({ title: "was", notes: "before", deadline: "2026-01-01" });
  });

  it("restores a null (the field was empty before the update) but skips uncaptured fields", () => {
    expect(updateRestoreParams({ deadline: null })).toEqual({ deadline: null });
    expect(updateRestoreParams({})).toEqual({});
    expect(updateRestoreParams(null)).toEqual({});
  });
});

describe("buildUpdatePatch: the ONE consumer mapping (CLI + MCP)", () => {
  const full = {
    title: "t",
    notes: "n",
    when: "2026-08-01",
    reminder: "09:00",
    deadline: "2026-09-01",
    createdAt: "2026-01-01",
    completedAt: "2026-01-02",
    // Foreign keys from the surface's options bag are ignored.
    dryRun: true,
    json: true,
    uuid: "abc",
  };

  it("maps every field of the vocabulary (camelCase / commander spelling)", () => {
    const built = buildUpdatePatch(full);
    expect(built).toEqual({
      kind: "ok",
      patch: {
        title: "t",
        notes: "n",
        when: "2026-08-01",
        reminder: "09:00",
        deadline: "2026-09-01",
        createdAt: "2026-01-01",
        completedAt: "2026-01-02",
      },
    });
  });

  it("accepts the snake_case (MCP) spelling of every key", () => {
    const built = buildUpdatePatch({
      append_notes: "tail",
      created_at: "2026-01-01",
      clear_deadline: true,
    });
    expect(built).toEqual({
      kind: "ok",
      patch: { appendNotes: "tail", createdAt: "2026-01-01", deadline: null },
    });
  });

  it("the clear flags spell their field's null", () => {
    const built = buildUpdatePatch({ when: "today", clearReminder: true });
    expect(built).toEqual({ kind: "ok", patch: { when: "today", reminder: null } });
  });

  it("splits the @time sugar into when + reminder (both surfaces, both kinds)", () => {
    expect(buildUpdatePatch({ when: "2026-08-01@09:00" })).toEqual({
      kind: "ok",
      patch: { when: "2026-08-01", reminder: "09:00" },
    });
  });

  it("refuses the notes modes together, in each surface's vocabulary", () => {
    expect(buildUpdatePatch({ notes: "a", appendNotes: "b" })).toEqual({
      kind: "error",
      message: "--notes, --append-notes, --prepend-notes are exclusive",
    });
    expect(buildUpdatePatch({ notes: "a", prepend_notes: "b" }, MCP_UPDATE_LABELS)).toEqual({
      kind: "error",
      message: "notes, append_notes, prepend_notes are exclusive",
    });
  });

  it("refuses a set and a clear of the SAME field instead of silently clearing", () => {
    // The deadline pair was previously unchecked on the CLI: the `--deadline`
    // value was accepted and then overwritten by the clear, so a caller asking
    // for both silently lost the date they set.
    expect(buildUpdatePatch({ deadline: "2026-09-01", clearDeadline: true })).toEqual({
      kind: "error",
      message: "pass at most one of --deadline / --clear-deadline",
    });
    expect(buildUpdatePatch({ reminder: "09:00", clearReminder: true })).toEqual({
      kind: "error",
      message: "pass at most one of --reminder / --clear-reminder",
    });
    expect(
      buildUpdatePatch({ deadline: "2026-09-01", clear_deadline: true }, MCP_UPDATE_LABELS),
    ).toEqual({
      kind: "error",
      message: "pass at most one of deadline / clear_deadline",
    });
  });

  it("refuses a NON-string value instead of silently dropping the field (#580)", () => {
    // The silent-degradation genus, inside #491's own registry: a value of the
    // wrong type used to be skipped by the `typeof value === "string"` filter, so
    // the update reported success with that field untouched.
    expect(buildUpdatePatch({ notes: 42 })).toEqual({
      kind: "error",
      message: "--notes: expected a string — received number",
    });
    expect(buildUpdatePatch({ deadline: { date: "2026-09-01" } })).toEqual({
      kind: "error",
      message: "--deadline: expected a string — received an object",
    });
    expect(buildUpdatePatch({ notes: ["a", "b"] }, MCP_UPDATE_LABELS)).toEqual({
      kind: "error",
      message: "notes: expected a string — received an array",
    });
    // `title` has no flag label in the vocabulary — the key names itself.
    expect(buildUpdatePatch({ title: true })).toEqual({
      kind: "error",
      message: "title: expected a string — received boolean",
    });
  });

  it("refuses an @time suffix against BOTH reminder flags (the suffix IS a reminder)", () => {
    expect(buildUpdatePatch({ when: "today@09:00", reminder: "10:00" })).toEqual({
      kind: "error",
      message:
        '--when "today@09:00" carries an @time suffix and --reminder was also given — use one',
    });
    // Previously the suffix was split FIRST and then overwritten by the clear:
    // the requested 09:00 never reached the wire and nothing asserted it.
    expect(buildUpdatePatch({ when: "today@09:00", clearReminder: true })).toEqual({
      kind: "error",
      message:
        '--when "today@09:00" carries an @time suffix and --reminder was also given — use one',
    });
  });

  it("reports a malformed suffix in the calling surface's vocabulary", () => {
    expect(buildUpdatePatch({ when: "today@" }, MCP_UPDATE_LABELS)).toEqual({
      kind: "error",
      message:
        'invalid when "today@" — expected today | evening | anytime | someday | YYYY-MM-DD (set a reminder with reminder HH:mm)',
    });
  });

  it("an empty options bag produces an empty patch", () => {
    expect(buildUpdatePatch({ dryRun: true })).toEqual({ kind: "ok", patch: {} });
  });

  it("CLI and MCP labels differ only in spelling, never in which pairs are refused", () => {
    const contradictions: Record<string, unknown>[] = [
      { notes: "a", appendNotes: "b" },
      { reminder: "09:00", clearReminder: true },
      { deadline: "2026-09-01", clearDeadline: true },
      { when: "today@09:00", clearReminder: true },
    ];
    for (const input of contradictions) {
      expect(buildUpdatePatch(input, CLI_UPDATE_LABELS).kind).toBe("error");
      expect(buildUpdatePatch(input, MCP_UPDATE_LABELS).kind).toBe("error");
    }
  });
});
