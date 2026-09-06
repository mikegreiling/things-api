/**
 * RAWAX1 — the compiler covers every recipe, and the merge lands where the fold
 * test says it should.
 *
 * Two properties, and the first is the one that keeps the port honest. The
 * compiler FAILS CLOSED on an address it cannot express, which is the right
 * behaviour and also the easy way to ship a port that quietly does nothing: if
 * one path went unregistered, that recipe would silently keep the AppleScript
 * transport and nobody would notice until a field trace came back slow. So this
 * walks every recipe `ui-recipes.ts` can emit, in both dialog shapes, and
 * requires the compile to SUCCEED.
 *
 * The second is the maintainer's fold ruling, asserted as structure: a hop
 * boundary survives only where node must DECIDE or SETTLE, so the frequency
 * selection (which carries DEPOBS3's `crossHopSettle`) and `settle-occurrences`
 * end their groups and everything between them folds into one.
 */
import { describe, expect, it } from "vitest";

import { compileRawAxGroups } from "../../src/write/vectors/ui-rawax-compile.ts";
import {
  makeRepeatingRecipe,
  projectMakeRepeatingRecipe,
  projectRescheduleRepeatRecipe,
  rescheduleRepeatRecipe,
  type RepeatRuleExtras,
} from "../../src/write/vectors/ui-recipes.ts";
import { setInstalledThingsVersion } from "../../src/write/vectors/ui-shape.ts";
import type { RepeatDialogShape, UiRecipe, UiStep } from "../../src/write/vectors/types.ts";

const FULL: RepeatRuleExtras = {
  weekdays: ["monday", "thursday"],
  monthly: { day: 20 },
  yearly: { month: 8, day: 20 },
  ends: { kind: "after", count: 5 },
  reminder: "09:00",
  deadline: true,
  startDaysEarlier: 14,
  next: "2026-08-20",
};

/** The seeded shape, so the pre-fill tags and the verify hop are generated. */
const SEEDED: RepeatRuleExtras = {
  weekdays: ["thursday"],
  reminder: "09:30",
  next: "2026-07-09",
  seed: { scheduled: "2026-07-09", today: "2026-07-05", deadline: null, reminder: "09:30" },
};

function everyRecipe(): UiRecipe[] {
  return [
    makeRepeatingRecipe("T-1", "yearly", 2, FULL),
    makeRepeatingRecipe("T-1", "weekly", 1, SEEDED),
    makeRepeatingRecipe("T-1", "monthly", 1, { monthly: { weekday: "monday", ordinal: 2 } }),
    makeRepeatingRecipe("T-1", "weekly", 1, { weekdays: ["sunday"] }),
    makeRepeatingRecipe("T-1", "daily", 1, { afterCompletion: true }),
    makeRepeatingRecipe("T-1", "daily", 3),
    // BATCH1 (#735): a NAMED zero offset is driven like any other value, so the
    // recipe emits the row-field step and the compiler has to express it.
    makeRepeatingRecipe("T-1", "weekly", 1, { deadline: true, startDaysEarlier: 0 }),
    makeRepeatingRecipe("T-1", "weekly", 1, { ends: { kind: "on-date", date: "2026-12-01" } }),
    rescheduleRepeatRecipe("T-1", "yearly", 1, FULL),
    projectMakeRepeatingRecipe("AREA-1", "P-1", "A project", "monthly", 1, FULL),
    projectRescheduleRepeatRecipe("P-1", "weekly", 1, FULL),
  ];
}

/** Resolve a recipe's steps for one shape, exactly as `drive()` does. */
function forShape(steps: readonly UiStep[], shape: RepeatDialogShape): UiStep[] {
  return steps
    .filter((s) => s.onlyShape === undefined || s.onlyShape === shape)
    .map((s) => (s.shaped === undefined ? s : Object.assign({}, s, s.shaped[shape])));
}

describe("the raw-AX compiler expresses every recipe (RAWAX1)", () => {
  // The manifest's version gate decides whether a cadence expectation exists at
  // all; pin it so the suite does not depend on the machine having Things.
  setInstalledThingsVersion("3.23");

  for (const shape of ["next-popup", "legacy"] as const) {
    for (const poll of [true, false]) {
      it(`compiles every dialog recipe · ${shape} · ${poll ? "polling" : "settled"}`, () => {
        const failures: string[] = [];
        for (const recipe of everyRecipe()) {
          // The compiler sees the recipe as the DRIVER sees it: shape-resolved.
          const compiled = compileRawAxGroups(forShape(recipe.steps, shape), poll);
          if (compiled === null) {
            failures.push(recipe.op);
            continue;
          }
          // A compile that produced no ops would "succeed" vacuously.
          const ops = compiled.groups.flatMap((g) => g.ops);
          if (ops.length === 0) failures.push(`${recipe.op} (no ops)`);
        }
        expect(
          failures,
          "a recipe could not be expressed structurally, so it would silently keep the " +
            "AppleScript transport. Register its address in ui-recipes.ts (DIALOG_REFS).",
        ).toEqual([]);
      });
    }
  }

  it("refuses the WHOLE recipe when one address is unregistered", () => {
    // Fail closed, and fail wholesale: a half-ported drive is worse than either.
    const recipe = makeRepeatingRecipe("T-1", "daily", 3);
    const poisoned = forShape(recipe.steps, "next-popup");
    for (const step of poisoned) {
      if (step.primitive === "select-popup") {
        step.pathCandidates = ["pop up button 99 of some unknown container"];
      }
    }
    expect(compileRawAxGroups(poisoned, true)).toBeNull();
  });
});

describe("the merge lands where the fold test says (RAWAX1 §3.2a)", () => {
  setInstalledThingsVersion("3.23");

  /** The full-vocabulary shape, which exercises every boundary at once. */
  function compiledFull() {
    const recipe = makeRepeatingRecipe("T-1", "yearly", 2, FULL);
    const compiled = compileRawAxGroups(forShape(recipe.steps, "next-popup"), false);
    expect(compiled).not.toBeNull();
    return compiled as NonNullable<typeof compiled>;
  }

  /**
   * THE BOUNDARY IS CONDITIONAL, AND BOTH HALVES ARE PINNED BELOW.
   *
   * `ui-recipes.ts` arms `crossHopSettle` only on the SEEDED make/add path,
   * because that is the only path where the announcement node waits for is
   * certain to come: DEFAULTS1 §2 measured a freshly minted seed's dialog
   * opening on `after completion, every 1 week` byte for byte, so any other
   * frequency is necessarily a CHANGE and `AXValueChanged` will fire. A
   * reschedule opens on an existing rule and proves nothing.
   *
   * So the fold has to track that, and these two cells are the contract. WITH
   * the marker the boundary survives — folding would put node's wait back inside
   * a script that cannot settle on a socket (#736). WITHOUT it the frequency
   * folds, and nothing is lost: node was never going to wait there, so the probe
   * polls in-script exactly as the AppleScript path does today.
   */
  function compiledSeeded() {
    const recipe = makeRepeatingRecipe("T-1", "weekly", 1, SEEDED);
    const compiled = compileRawAxGroups(forShape(recipe.steps, "next-popup"), true);
    expect(compiled).not.toBeNull();
    return compiled as NonNullable<typeof compiled>;
  }

  it("ends a group at the frequency selection when node will wait there (DEPOBS3)", () => {
    const { groups } = compiledSeeded();
    const first = groups[0];
    expect(first?.steps.at(-1)?.crossHopSettle).toBe("cadence-rebuild");
    expect(first?.steps.every((s) => s.primitive === "select-popup")).toBe(true);
    // And the probe is NOT in that group — it is the thing node's wait is for.
    expect(first?.ops.some((o) => o.op === "probe-shape")).toBe(false);
  });

  it("folds the frequency in when node will NOT wait there — nothing is lost", () => {
    // A reschedule (no seed) arms no cross-hop wait, so `nodeSettled` can never
    // carry `cadence-rebuild` and the probe was always going to poll. Folding
    // costs nothing and saves a spawn.
    const recipe = rescheduleRepeatRecipe("T-1", "yearly", 1, FULL);
    const compiled = compileRawAxGroups(forShape(recipe.steps, "next-popup"), true);
    const first = compiled?.groups[0];
    expect(first?.steps.at(-1)?.crossHopSettle).toBeUndefined();
    expect(first?.ops.some((o) => o.op === "probe-shape")).toBe(true);
    expect(first?.ops.some((o) => o.op === "select-popup")).toBe(true);
  });

  it("keeps settle-occurrences as its own node-side boundary, dispatching nothing", () => {
    const { groups } = compiledFull();
    const settle = groups.find((g) => g.steps[0]?.primitive === "settle-occurrences");
    expect(settle).toBeDefined();
    expect(settle?.ops).toEqual([]);
    expect(settle?.steps).toHaveLength(1);
  });

  it("folds everything else — the whole tail is ONE hop that commits", () => {
    const { groups } = compiledFull();
    const last = groups.at(-1);
    expect(last?.commits).toBe(true);
    // The tail carries the deadline checkbox, the offset, the ends bound and its
    // count, the occurrence pick, the reminder pair and the audit — one script.
    expect(last?.steps.length ?? 0).toBeGreaterThan(5);
    expect(last?.ops.some((o) => o.op === "audit")).toBe(true);
  });

  it("collapses the full vocabulary's dispatched hops into 2 scripts", () => {
    // The number the cost table is built on. Groups that dispatch a script are
    // the hops; the node-side settle is not one. This shape (a make-repeating
    // with no seed) arms no cross-hop wait, so its frequency selection folds and
    // the whole dialog entry is two scripts either side of `settle-occurrences`.
    const { groups } = compiledFull();
    const dispatching = groups.filter((g) => g.ops.length > 0);
    expect(dispatching).toHaveLength(2);
    expect(groups).toHaveLength(3);
  });

  it("costs the SEEDED path one more script, and that is the trade", () => {
    // The field's own shape keeps three rather than two, because DEPOBS3's
    // boundary is worth more on a routed host than the spawn it costs.
    const { groups } = compiledSeeded();
    expect(groups.filter((g) => g.ops.length > 0)).toHaveLength(3);
  });

  it("carries the shape fork as DATA so the probe can sit inside the merge", () => {
    const { groups } = compiledFull();
    const ops = groups.flatMap((g) => g.ops);
    const shaped = ops.filter((o) => o.shapedRef !== undefined || o.shapedBase !== undefined);
    expect(shaped.length).toBeGreaterThan(0);
    // And the probe is INSIDE a group rather than being a group of its own.
    const probeGroup = groups.find((g) => g.ops.some((o) => o.op === "probe-shape"));
    expect(probeGroup?.ops.length ?? 0).toBeGreaterThan(1);
  });

  it("emits a NAMED zero deadline offset (BATCH1 #735)", () => {
    // The promote leg now drives a named offset INCLUDING zero, because on a
    // seed carrying its own deadline "due on its start date" has to be typed to
    // be true. The compiler inherits it by consuming the recipe's own steps.
    const recipe = makeRepeatingRecipe("T-1", "weekly", 1, {
      deadline: true,
      startDaysEarlier: 0,
    });
    const compiled = compileRawAxGroups(forShape(recipe.steps, "next-popup"), false);
    const ops = (compiled?.groups ?? []).flatMap((g) => g.ops);
    const typed = ops.filter((o) => o.op === "type-into");
    expect(typed.some((o) => o.op === "type-into" && o.value === "0")).toBe(true);
  });
});
