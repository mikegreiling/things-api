/**
 * Regression: symbolic `when: today` UPDATE verification must ACCEPT an
 * already-arrived `startDate` the app preserved, while adds and explicit ISO
 * dates keep exact equality (field bug §0½.8; docs/research/project-update-
 * today-verify-mismatch.md).
 *
 * The field report: `update --when today` on an item already in Today makes the
 * app PRESERVE its historical (arrived) `startDate` instead of rewriting it to
 * today. The old verifier asserted exact `startDate == today`, so a successful
 * update false-failed as `verify-failed:mismatch`. The fix asserts an
 * arrived-date PREDICATE (`startDate != null && startDate <= today`) for the
 * symbolic-Today UPDATE, which still rejects an undated deadline-only pull.
 *
 * These cases run the REAL command specs (COMMANDS[op].preRead /
 * expectedDelta) and the REAL verifier (evaluateDelta) against fixture DBs whose
 * rows are seeded in the exact OBSERVED post-write state, for BOTH `todo.update`
 * and `project.update` (and both add ops for the exact-today add case). Seeding
 * the observed state directly is what lets case 1 reproduce the preserved-date
 * outcome the simulator (which normalizes to today) cannot.
 */
import { describe, expect, it } from "vitest";

import { addDaysIso, localToday } from "../../src/model/dates.ts";
import { COMMANDS, type CommandSpec } from "../../src/write/commands.ts";
import type { OperationParamsMap } from "../../src/write/operations.ts";
import {
  createDbReader,
  evaluateDelta,
  type DeltaSpec,
  type FieldAssertion,
} from "../../src/write/verify/delta.ts";
import { buildFixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo, type SeedTaskOpts } from "../fixtures/seed.ts";

const NOW = new Date("2026-08-11T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const TODAY = localToday(NOW);
const PAST = addDaysIso(TODAY, -10);
const FUTURE_DATE = addDaysIso(TODAY, 9);

const UPDATE_OPS = ["todo.update", "project.update"] as const;
const ADD_OPS = ["todo.add", "project.add"] as const;

type UpdateOp = (typeof UPDATE_OPS)[number];
type AddOp = (typeof ADD_OPS)[number];

function seedFor(
  op: UpdateOp | AddOp,
  db: ReturnType<typeof buildFixtureDb>["db"],
  opts: SeedTaskOpts,
) {
  return op.startsWith("project") ? seedProject(db, opts) : seedTodo(db, opts);
}

/** The startDate assertion inside a compiled delta (there is exactly one). */
function startDateAssertion(delta: DeltaSpec): FieldAssertion | undefined {
  return "assert" in delta ? delta.assert.find((a) => a.field === "startDate") : undefined;
}

/**
 * Seed a row in its OBSERVED post-write state, then run the op's real
 * expectedDelta + evaluateDelta against it. Returns the verdict and the compiled
 * delta so a test can also inspect the emitted assertion shape.
 */
function verifyUpdate(
  op: UpdateOp,
  observed: SeedTaskOpts,
  params: Partial<OperationParamsMap[UpdateOp]>,
): { satisfied: boolean; delta: DeltaSpec } {
  const fx = buildFixtureDb();
  try {
    const uuid = seedFor(op, fx.db, observed);
    const full = { uuid, ...params } as OperationParamsMap[UpdateOp];
    const spec = COMMANDS[op] as CommandSpec<UpdateOp>;
    const pre = spec.preRead(fx.db, full, NOW);
    const delta = spec.expectedDelta(pre, full, {
      nowEpoch: NOW_EPOCH,
      todayIso: TODAY,
    });
    const result = evaluateDelta(delta, createDbReader(fx.db, NOW), { modDates: {}, fields: {} });
    return { satisfied: result.satisfied, delta };
  } finally {
    fx.close();
  }
}

/**
 * Add-op create-mode verify: preRead on the pre-add DB (no same-title rows),
 * then seed the "created" row in its observed state and evaluate discovery. The
 * add path keeps EXACT `startDate == today`.
 */
function verifyAdd(op: AddOp, createdStartDate: string): { satisfied: boolean; delta: DeltaSpec } {
  const fx = buildFixtureDb();
  try {
    const title = "When-today add probe";
    const full = { title, when: "today" } as OperationParamsMap[AddOp];
    const spec = COMMANDS[op] as CommandSpec<AddOp>;
    const pre = spec.preRead(fx.db, full, NOW);
    seedFor(op, fx.db, {
      title,
      start: "active",
      startDate: createdStartDate,
      creationDate: NOW_EPOCH,
    });
    const delta = spec.expectedDelta(pre, full, { nowEpoch: NOW_EPOCH, todayIso: TODAY });
    const result = evaluateDelta(delta, createDbReader(fx.db, NOW), { modDates: {}, fields: {} });
    return { satisfied: result.satisfied, delta };
  } finally {
    fx.close();
  }
}

describe.each(UPDATE_OPS)("symbolic when:today verification — %s", (op) => {
  it("CASE 1: preserved historical arrived startDate on an already-Today item SUCCEEDS", () => {
    const { satisfied, delta } = verifyUpdate(
      op,
      { start: "active", startDate: PAST },
      {
        when: "today",
      },
    );
    expect(satisfied).toBe(true);
    // The fix's mechanism: the symbolic-Today UPDATE emits the predicate form,
    // not exact equality (which would false-fail on the preserved past date).
    expect(startDateAssertion(delta)).toMatchObject({
      satisfies: { predicate: "arrived-on-or-before", date: TODAY },
    });
  });

  it("CASE 2: future/anytime/someday → today transition (observed startDate today) verifies", () => {
    // The transition RESULT the app lands on: startDate normalized to today,
    // active, Today marker set, not evening.
    expect(
      verifyUpdate(op, { start: "active", startDate: TODAY }, { when: "today" }).satisfied,
    ).toBe(true);
  });

  it("CASE 3: undated deadline-pulled item (null startDate) FAILS — a silent no-op is not accepted", () => {
    // In Today via a due deadline only, with startDate still null: today:true but
    // the requested schedule never landed → the predicate rejects it.
    expect(
      verifyUpdate(op, { start: "active", startDate: null, deadline: TODAY }, { when: "today" })
        .satisfied,
    ).toBe(false);
  });

  it("CASE 4: explicit ISO update keeps EXACT equality — a different observed date still fails", () => {
    const mismatch = verifyUpdate(
      op,
      { start: "active", startDate: addDaysIso(TODAY, 20) },
      {
        when: FUTURE_DATE,
      },
    );
    expect(mismatch.satisfied).toBe(false);
    expect(startDateAssertion(mismatch.delta)).toEqual({ field: "startDate", equals: FUTURE_DATE });
    // Positive control: the matching date verifies.
    expect(
      verifyUpdate(op, { start: "active", startDate: FUTURE_DATE }, { when: FUTURE_DATE })
        .satisfied,
    ).toBe(true);
  });
});

describe.each(ADD_OPS)("when:today ADD keeps exact today — %s", (op) => {
  it("CASE 5: an add whose created row carries a PAST arrived startDate FAILS (exact today required)", () => {
    const { satisfied, delta } = verifyAdd(op, PAST);
    expect(satisfied).toBe(false);
    expect(startDateAssertion(delta)).toEqual({ field: "startDate", equals: TODAY });
  });

  it("CASE 5 (control): an add whose created row is dated exactly today verifies", () => {
    expect(verifyAdd(op, TODAY).satisfied).toBe(true);
  });
});
