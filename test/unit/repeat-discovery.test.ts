/**
 * Hardened make-repeating post-write discovery (RSIM-P2 / RSIM-R). Drives the
 * real command specs (preRead → expectedDelta) against a fixture, then evaluates
 * the produced DeltaSpec with the live createDbReader — proving end to end that
 * the `repeating` probe restores the template time-bound, disambiguates by
 * source fingerprint, derives the instance via the template FK, and resolves the
 * source fate (replaced vs preserved-as-instance). No app / VM is ever touched.
 */
import { describe, expect, it } from "vitest";

import { COMMANDS } from "../../src/write/commands.ts";
import { createDbReader, evaluateDelta } from "../../src/write/verify/delta.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const CTX = { nowEpoch: NOW_EPOCH, todayIso: "2026-07-05" as const };
const EMPTY_PRE = { modDates: {}, fields: {} };
const RULE = { frequency: "weekly" as const, interval: 1 };

function withDb<T>(fn: (db: FixtureDb["db"]) => T): T {
  const fx = buildFixtureDb();
  try {
    return fn(fx.db);
  } finally {
    fx.close();
  }
}

/** Run the to-do make-repeating spec end to end and evaluate it. */
function evalTodo(db: FixtureDb["db"], source: string, mutate: () => void) {
  const params = { uuid: source, ...RULE };
  const pre = COMMANDS["todo.make-repeating"].preRead(db, params, NOW);
  mutate();
  const spec = COMMANDS["todo.make-repeating"].expectedDelta(pre, params, CTX);
  if (spec.mode !== "create") throw new Error("unreachable");
  return { spec, evaluation: evaluateDelta(spec, createDbReader(db, NOW), EMPTY_PRE) };
}

describe("template discovery — restored time-bound (RSIM-R deliverable 3)", () => {
  it("excludes a same-title decoy template created PRE-WINDOW even with excludeUuids set", () => {
    withDb((db) => {
      const source = seedTodo(db, { title: "Chores", notes: "n", creationDate: NOW_EPOCH - 10 });
      const { evaluation } = evalTodo(db, source, () => {
        // Identity replacement: the source dies; the real template + instance appear.
        db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
        const template = seedTodo(db, {
          uuid: "TMPL-REAL",
          title: "Chores",
          notes: "n",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
        seedTodo(db, {
          uuid: "INST-REAL",
          title: "Chores",
          notes: "n",
          repeatingTemplate: template,
          creationDate: NOW_EPOCH,
        });
        // A mid-op sync insert: a DIFFERENT same-title template with the SAME
        // fingerprint but a pre-window creationDate. Only the time-bound saves us
        // (fingerprint cannot — it is identical). Without the bound both survive
        // and discovery is ambiguous.
        seedTodo(db, {
          uuid: "TMPL-DECOY",
          title: "Chores",
          notes: "n",
          recurrenceRule: true,
          creationDate: NOW_EPOCH - 5000,
        });
      });
      expect(evaluation.satisfied).toBe(true);
      expect(evaluation.discoveredUuid).toBe("TMPL-REAL");
      expect(evaluation.repeating?.templateUuid).toBe("TMPL-REAL");
      expect(evaluation.repeating?.instanceUuid).toBe("INST-REAL");
    });
  });
});

describe("template disambiguation — source fingerprint tiebreak", () => {
  it("picks the one template matching the source fingerprint when two survive", () => {
    withDb((db) => {
      const source = seedTodo(db, {
        title: "Chores",
        notes: "match",
        creationDate: NOW_EPOCH - 10,
      });
      const { evaluation } = evalTodo(db, source, () => {
        db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
        const template = seedTodo(db, {
          uuid: "TMPL-MATCH",
          title: "Chores",
          notes: "match",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
        seedTodo(db, {
          uuid: "INST",
          title: "Chores",
          notes: "match",
          repeatingTemplate: template,
          creationDate: NOW_EPOCH,
        });
        // A same-title template with a DIFFERENT fingerprint (a racer) in-window.
        seedTodo(db, {
          uuid: "TMPL-OTHER",
          title: "Chores",
          notes: "different",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
      });
      expect(evaluation.satisfied).toBe(true);
      expect(evaluation.discoveredUuid).toBe("TMPL-MATCH");
      expect(evaluation.repeating?.instanceUuid).toBe("INST");
    });
  });

  it("fails LOUDLY (terminal) when two same-title templates BOTH match the fingerprint", () => {
    withDb((db) => {
      const source = seedTodo(db, { title: "Chores", notes: "n", creationDate: NOW_EPOCH - 10 });
      const { evaluation } = evalTodo(db, source, () => {
        db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
        seedTodo(db, {
          uuid: "TMPL-A",
          title: "Chores",
          notes: "n",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
        seedTodo(db, {
          uuid: "TMPL-B",
          title: "Chores",
          notes: "n",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
      });
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.terminal).toBe(true);
      expect(evaluation.detail).toContain("refusing to guess");
      expect(evaluation.repeating).toBeUndefined();
      // The caller still gets the CANDIDATE template uuids for inspection/cleanup.
      expect(evaluation.observed?.["repeating.candidateTemplateUuids"]).toEqual(
        expect.arrayContaining(["TMPL-A", "TMPL-B"]),
      );
      expect(evaluation.detail).toContain("candidate template uuids");
    });
  });
});

describe("source-fate resolution (RSIM-R: absent OR relinked-as-instance)", () => {
  it("REPLACED: source destroyed → replacedUuid = original, instanceUuid = FK instance", () => {
    withDb((db) => {
      const source = seedTodo(db, { title: "Chores", creationDate: NOW_EPOCH - 10 });
      const { evaluation } = evalTodo(db, source, () => {
        db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
        const template = seedTodo(db, {
          uuid: "TMPL",
          title: "Chores",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
        seedTodo(db, {
          uuid: "INST",
          title: "Chores",
          repeatingTemplate: template,
          creationDate: NOW_EPOCH,
        });
      });
      expect(evaluation.repeating).toEqual({
        templateUuid: "TMPL",
        instanceUuid: "INST",
        replacedUuid: source,
      });
      expect(evaluation.repeatingWarnings).toBeUndefined();
    });
  });

  it("PRESERVED: source relinked as the instance → instanceUuid = original, replacedUuid = null", () => {
    withDb((db) => {
      const source = seedTodo(db, { title: "Chores", creationDate: NOW_EPOCH - 10 });
      const { evaluation } = evalTodo(db, source, () => {
        // Only the template is minted fresh; the source stays and is relinked.
        const template = seedTodo(db, {
          uuid: "TMPL",
          title: "Chores",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
        db.prepare("UPDATE TMTask SET rt1_repeatingTemplate = ? WHERE uuid = ?").run(
          template,
          source,
        );
      });
      expect(evaluation.repeating).toEqual({
        templateUuid: "TMPL",
        instanceUuid: source,
        replacedUuid: null,
      });
    });
  });

  it("warns (not fatal) when the FK instance cannot be derived", () => {
    withDb((db) => {
      const source = seedTodo(db, { title: "Chores", creationDate: NOW_EPOCH - 10 });
      const { evaluation } = evalTodo(db, source, () => {
        db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
        seedTodo(db, {
          uuid: "TMPL",
          title: "Chores",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
        });
        // No FK'd instance materialized.
      });
      expect(evaluation.satisfied).toBe(true);
      expect(evaluation.repeating?.instanceUuid).toBeNull();
      expect(evaluation.repeating?.replacedUuid).toBe(source);
      expect(evaluation.repeatingWarnings?.[0]).toContain("could not derive the spawned instance");
    });
  });

  // TRACE1 (#487) regression: the maintainer's proposed hang cause — that
  // make-repeating with a FUTURE-DATED first occurrence blocks polling for a
  // not-yet-spawned instance — is FALSIFIED here and locked so it can never
  // become true. A future-first-occurrence template has no live FK instance yet;
  // the discovery must tolerate that (instanceUuid: null) and the delta must be
  // SATISFIED (satisfied === true → the poller returns on its FIRST attempt, i.e.
  // promptly with clean JSON), never waiting for an instance that will not appear.
  it("future-dated first occurrence: instanceUuid null and the delta is satisfied promptly (#487)", () => {
    withDb((db) => {
      const source = seedTodo(db, { title: "Chores", creationDate: NOW_EPOCH - 10 });
      const { evaluation } = evalTodo(db, source, () => {
        db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
        // The minted template's next occurrence is in the future, so no instance
        // row exists yet — the exact shape that was theorized to hang.
        seedTodo(db, {
          uuid: "TMPL-FUTURE",
          title: "Chores",
          recurrenceRule: true,
          creationDate: NOW_EPOCH,
          startDate: "2026-07-19",
        });
      });
      expect(evaluation.satisfied).toBe(true); // prompt: poller returns on attempt 1
      expect(evaluation.discoveredUuid).toBe("TMPL-FUTURE");
      expect(evaluation.repeating?.instanceUuid).toBeNull();
    });
  });
});

/** A decodable weekly rule blob at the given interval + type. */
function weeklyRuleXml(interval: number, type: "fixed" | "after-completion" = "fixed"): string {
  return (
    `<?xml version="1.0"?><plist version="1.0"><dict>` +
    `<key>tp</key><integer>${type === "fixed" ? 0 : 1}</integer>` +
    `<key>fu</key><integer>256</integer><key>fa</key><integer>${interval}</integer>` +
    `<key>ts</key><integer>0</integer><key>rc</key><integer>0</integer>` +
    `<key>rrv</key><integer>4</integer>` +
    `<key>of</key><array><dict><key>wd</key><integer>1</integer></dict></array>` +
    `</dict></plist>`
  );
}

describe("make-repeating rule verification — the interval-field race guard (oddities §8l)", () => {
  /** make-repeating requesting weekly/interval-N, minting a template with `landedInterval`. */
  function evalInterval(requested: number, landedInterval: number) {
    return withDb((db) => {
      const source = seedTodo(db, { title: "Chores", creationDate: NOW_EPOCH - 10 });
      const params = { uuid: source, frequency: "weekly" as const, interval: requested };
      const pre = COMMANDS["todo.make-repeating"].preRead(db, params, NOW);
      db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
      const template = seedTodo(db, {
        uuid: "TMPL",
        title: "Chores",
        recurrenceRuleXml: weeklyRuleXml(landedInterval),
        creationDate: NOW_EPOCH,
      });
      seedTodo(db, {
        uuid: "INST",
        title: "Chores",
        repeatingTemplate: template,
        creationDate: NOW_EPOCH,
      });
      const spec = COMMANDS["todo.make-repeating"].expectedDelta(pre, params, CTX);
      if (spec.mode !== "create") throw new Error("unreachable");
      return evaluateDelta(spec, createDbReader(db, NOW), EMPTY_PRE);
    });
  }

  it("WRONG interval landed (2 requested, 1 minted) → NOT satisfied, mismatch, honest detail", () => {
    const evaluation = evalInterval(2, 1);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.assertedMovement).toBe(true); // → poller returns "mismatch", not silent-noop
    expect(evaluation.detail).toContain("does not match the request");
    expect(evaluation.observed?.["repeating.rule.interval"]).toBe(1);
  });

  it("mismatch failure carries the SUCCESSOR discovery for cleanup (template + instance + fate)", () => {
    // The source uuid is destroyed on an identity-replacement make-repeating, so
    // the mismatch verdict must hand back the new template + FK instance + the
    // replaced source so the caller can reschedule/delete the mis-configured one.
    const evaluation = withDb((db) => {
      const source = seedTodo(db, { title: "Chores", creationDate: NOW_EPOCH - 10 });
      const params = { uuid: source, frequency: "weekly" as const, interval: 2 };
      const pre = COMMANDS["todo.make-repeating"].preRead(db, params, NOW);
      db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source); // identity replacement
      const template = seedTodo(db, {
        uuid: "TMPL",
        title: "Chores",
        recurrenceRuleXml: weeklyRuleXml(1), // WRONG: interval 1, requested 2
        creationDate: NOW_EPOCH,
      });
      seedTodo(db, {
        uuid: "INST",
        title: "Chores",
        repeatingTemplate: template,
        creationDate: NOW_EPOCH,
      });
      const spec = COMMANDS["todo.make-repeating"].expectedDelta(pre, params, CTX);
      if (spec.mode !== "create") throw new Error("unreachable");
      return { source, evaluation: evaluateDelta(spec, createDbReader(db, NOW), EMPTY_PRE) };
    });
    const o = evaluation.evaluation.observed;
    expect(o?.["repeating.templateUuid"]).toBe("TMPL");
    expect(o?.["repeating.instanceUuid"]).toBe("INST"); // derived via the template FK
    expect(o?.["repeating.replacedUuid"]).toBe(evaluation.source); // the destroyed original
    expect(evaluation.evaluation.detail).toContain("uuid TMPL");
    expect(evaluation.evaluation.detail).toContain("included for cleanup");
  });

  it("CORRECT interval landed (2 requested, 2 minted) → satisfied", () => {
    const evaluation = evalInterval(2, 2);
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.repeating?.templateUuid).toBe("TMPL");
  });

  it("interval 1 requested + 1 landed → satisfied (the common base case)", () => {
    expect(evalInterval(1, 1).satisfied).toBe(true);
  });

  it("an UNDECODABLE rule (future format) is NOT blocked — discovery still succeeds", () => {
    // The `recurrenceRule: true` seed writes a non-plist blob that fails to
    // decode; the rule check must be skipped, not treated as a mismatch.
    const evaluation = withDb((db) => {
      const source = seedTodo(db, { title: "Chores", creationDate: NOW_EPOCH - 10 });
      const params = { uuid: source, frequency: "weekly" as const, interval: 2 };
      const pre = COMMANDS["todo.make-repeating"].preRead(db, params, NOW);
      db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
      const template = seedTodo(db, {
        uuid: "TMPL",
        title: "Chores",
        recurrenceRule: true, // undecodable "bp" blob
        creationDate: NOW_EPOCH,
      });
      seedTodo(db, {
        uuid: "INST",
        title: "Chores",
        repeatingTemplate: template,
        creationDate: NOW_EPOCH,
      });
      const spec = COMMANDS["todo.make-repeating"].expectedDelta(pre, params, CTX);
      if (spec.mode !== "create") throw new Error("unreachable");
      return evaluateDelta(spec, createDbReader(db, NOW), EMPTY_PRE);
    });
    expect(evaluation.satisfied).toBe(true);
  });
});

describe("project make-repeating — FK instance filtered by type + childrenReplaced", () => {
  it("DELETE-REMINT: every source subtree uuid is dead → childrenReplaced = full subtree", () => {
    withDb((db) => {
      const source = seedProject(db, {
        uuid: "PROJ-SRC",
        title: "Proj",
        start: "someday",
        creationDate: NOW_EPOCH - 10,
      });
      const childA = seedTodo(db, { title: "child A", project: source });
      const childB = seedTodo(db, { title: "child B", project: source });
      const section = seedHeading(db, { title: "Section", project: source });

      const params = { uuid: source, ...RULE };
      const pre = COMMANDS["project.make-repeating"].preRead(db, params, NOW);
      expect(pre.repeatSubtreeUuids?.toSorted()).toEqual([childA, childB, section].toSorted());

      // Delete-and-remint: the source project AND its whole subtree are destroyed;
      // template + instance projects are minted with a fresh (plain) subtree copy
      // — one of which ALSO links the template (defensive: child rows must be
      // excluded from the instance FK lookup by the type=1 filter).
      db.prepare("DELETE FROM TMTask WHERE uuid IN (?, ?, ?, ?)").run(
        source,
        childA,
        childB,
        section,
      );
      const template = seedProject(db, {
        uuid: "PROJ-TMPL",
        title: "Proj",
        recurrenceRule: true,
        creationDate: NOW_EPOCH,
      });
      seedProject(db, {
        uuid: "PROJ-INST",
        title: "Proj",
        repeatingTemplate: template,
        creationDate: NOW_EPOCH,
      });
      seedTodo(db, { title: "child A", repeatingTemplate: template, creationDate: NOW_EPOCH });

      const spec = COMMANDS["project.make-repeating"].expectedDelta(pre, params, CTX);
      if (spec.mode !== "create") throw new Error("unreachable");
      const evaluation = evaluateDelta(spec, createDbReader(db, NOW), EMPTY_PRE);

      expect(evaluation.repeating).toEqual({
        templateUuid: "PROJ-TMPL",
        instanceUuid: "PROJ-INST",
        replacedUuid: "PROJ-SRC",
        childrenReplaced: 3,
      });
    });
  });

  it("PRESERVE (nested repeater): only the flattened nested-template uuid dies → childrenReplaced = 1", () => {
    withDb((db) => {
      const source = seedProject(db, {
        uuid: "PROJ-SRC",
        title: "Proj",
        start: "someday",
        creationDate: NOW_EPOCH - 10,
      });
      const nestedTemplate = seedTodo(db, {
        title: "weekly chore",
        project: source,
        recurrenceRule: true,
      });
      const nestedInstance = seedTodo(db, {
        title: "weekly chore",
        project: source,
        repeatingTemplate: nestedTemplate,
      });

      const params = { uuid: source, ...RULE };
      const pre = COMMANDS["project.make-repeating"].preRead(db, params, NOW);
      expect(pre.repeatSubtreeUuids?.toSorted()).toEqual(
        [nestedTemplate, nestedInstance].toSorted(),
      );

      // Preserve-as-instance: the source project stays (relinked to the new
      // template), the nested repeater is FLATTENED in place — the nested
      // template row is hard-deleted, the visible nested instance survives
      // (demoted to plain, its uuid intact) — and only the template is minted.
      const template = seedProject(db, {
        uuid: "PROJ-TMPL",
        title: "Proj",
        recurrenceRule: true,
        creationDate: NOW_EPOCH,
      });
      db.prepare("UPDATE TMTask SET rt1_repeatingTemplate = ? WHERE uuid = ?").run(
        template,
        source,
      );
      db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(nestedTemplate);
      db.prepare("UPDATE TMTask SET rt1_repeatingTemplate = NULL WHERE uuid = ?").run(
        nestedInstance,
      );

      const spec = COMMANDS["project.make-repeating"].expectedDelta(pre, params, CTX);
      if (spec.mode !== "create") throw new Error("unreachable");
      const evaluation = evaluateDelta(spec, createDbReader(db, NOW), EMPTY_PRE);

      expect(evaluation.repeating).toEqual({
        templateUuid: "PROJ-TMPL",
        instanceUuid: "PROJ-SRC", // the preserved source IS the instance
        replacedUuid: null,
        childrenReplaced: 1, // only the flattened nested-template uuid is dead
      });
    });
  });
});
