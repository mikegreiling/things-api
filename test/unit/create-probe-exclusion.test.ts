/**
 * Create-mode verification must never bind to a PRE-EXISTING same-title row.
 * These tests drive the real command specs (preRead → expectedDelta) against a
 * fixture, then evaluate the produced DeltaSpec with the live createDbReader —
 * proving the excludeUuids capture threads end to end. A pre-existing row is
 * seeded INSIDE the create-probe's trailing window (recent creationDate), so
 * without the exclusion it would be a false discovery candidate.
 */
import { describe, expect, it } from "vitest";

import { COMMANDS } from "../../src/write/commands.ts";
import { createDbReader, evaluateDelta } from "../../src/write/verify/delta.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW_EPOCH = Math.floor(Date.now() / 1000);
const CTX = { nowEpoch: NOW_EPOCH, todayIso: "2026-07-16" as const };
const EMPTY_PRE = { modDates: {}, fields: {} };

function withDb<T>(fn: (db: FixtureDb["db"]) => T): T {
  const fx = buildFixtureDb();
  try {
    return fn(fx.db);
  } finally {
    fx.close();
  }
}

describe("todo.add create-probe excludes pre-existing rows", () => {
  it("discovers only the newly-created row, skipping a recent same-title row", () => {
    withDb((db) => {
      // A same-title to-do already sitting inside the probe window (a concurrent
      // add / repeat spawn / sync insert) — the exact trap the fix guards.
      const preExisting = seedTodo(db, { title: "Buy milk", creationDate: NOW_EPOCH });

      const params = { title: "Buy milk" };
      const pre = COMMANDS["todo.add"].preRead(db, params, new Date());
      expect(pre.sameTitleUuids).toContain(preExisting);

      // The app write lands: a genuinely new row appears post-pre-read.
      const created = seedTodo(db, { title: "Buy milk", creationDate: NOW_EPOCH });

      const spec = COMMANDS["todo.add"].expectedDelta(pre, params, CTX);
      expect(spec.mode).toBe("create");
      if (spec.mode !== "create") throw new Error("unreachable");
      expect(spec.probe.excludeUuids).toEqual([preExisting]);

      const evaluation = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(evaluation.satisfied).toBe(true);
      expect(evaluation.discoveredUuid).toBe(created);
      expect(evaluation.discoveredUuid).not.toBe(preExisting);
    });
  });

  it("reports failure when ONLY the pre-existing row matches (silent write failure)", () => {
    withDb((db) => {
      // The app write silently failed: no new row. Only the pre-existing,
      // in-window same-title row remains. The old sinceEpoch-only probe would
      // discover it and report a false green; the exclusion makes it a failure.
      const preExisting = seedTodo(db, { title: "Buy milk", creationDate: NOW_EPOCH });

      const params = { title: "Buy milk" };
      const pre = COMMANDS["todo.add"].preRead(db, params, new Date());
      const spec = COMMANDS["todo.add"].expectedDelta(pre, params, CTX);
      if (spec.mode !== "create") throw new Error("unreachable");
      expect(spec.probe.excludeUuids).toEqual([preExisting]);

      const evaluation = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.movement).toBe(false);
      expect(evaluation.discoveredUuid).toBeUndefined();
    });
  });
});

describe("project.duplicate create-probe excludes the source project", () => {
  it("discovers the copy, never the original it was duplicated from", () => {
    withDb((db) => {
      const original = seedProject(db, {
        title: "Launch",
        notes: "plan",
        creationDate: NOW_EPOCH,
      });

      const params = { uuid: original };
      const pre = COMMANDS["project.duplicate"].preRead(db, params, new Date());
      // The source itself is the pre-existing same-title row that must be skipped.
      expect(pre.sameTitleUuids).toEqual([original]);

      const copy = seedProject(db, { title: "Launch", notes: "plan", creationDate: NOW_EPOCH });

      const spec = COMMANDS["project.duplicate"].expectedDelta(pre, params, CTX);
      if (spec.mode !== "create") throw new Error("unreachable");
      expect(spec.probe.excludeUuids).toEqual([original]);

      const evaluation = evaluateDelta(spec, createDbReader(db), EMPTY_PRE);
      expect(evaluation.satisfied).toBe(true);
      expect(evaluation.discoveredUuid).toBe(copy);
      expect(evaluation.discoveredUuid).not.toBe(original);
    });
  });
});
