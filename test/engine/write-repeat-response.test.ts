/**
 * Response enrichment for make-repeating conversions: the ok MutationResult
 * carries a `repeating` block (template + instance + replaced uuids, plus
 * childrenReplaced for projects), and — being irreversible — NO undoToken.
 * Every vector is a fake driven through the WriteDeps seam; no app is touched.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMakeRepeatingProject } from "../../src/write/make-repeating-project.ts";
import { runMutation, type WriteDeps, type WriteOptions } from "../../src/write/pipeline.ts";
import type {
  CompiledInvocation,
  VectorMatrix,
  WriteVector,
} from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => fixture.close());

function config(): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 3,
    actor: "mike",
    auditEnabled: true,
    acceptedFingerprint: null,
    allowExperimental: false,
    ui: { enabled: true },
    host: "test-host",
  };
}

function deps(vectors: WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: config(),
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-repeat-resp-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    pkgVersion: "test",
  };
}

const UI_MATRIX: VectorMatrix = {
  "todo.make-repeating": { support: "yes", disruption: 3, validation: "validated" },
  "project.make-repeating": { support: "yes", disruption: 3, validation: "validated" },
};

const GUI: WriteOptions = { dangerouslyDriveGui: true, maxDisruption: 3, vector: "ui" };

/** A ui vector whose execute() applies `effect` to the fixture DB, then reports success. */
function uiVector(effect: () => void): WriteVector {
  return {
    id: "ui",
    matrix: UI_MATRIX,
    async execute(_inv: CompiledInvocation) {
      effect();
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("todo.make-repeating — repeating block + undoToken suppression", () => {
  it("REPLACED fate: returns template/instance/replaced and NO undoToken", async () => {
    const source = seedTodo(fixture.db, { title: "Water plants", creationDate: NOW_EPOCH - 10 });
    const vector = uiVector(() => {
      fixture.db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
      const template = seedTodo(fixture.db, {
        uuid: "TMPL",
        title: "Water plants",
        recurrenceRule: true,
        creationDate: NOW_EPOCH,
      });
      seedTodo(fixture.db, {
        uuid: "INST",
        title: "Water plants",
        repeatingTemplate: template,
        creationDate: NOW_EPOCH,
      });
    });
    const res = await runMutation(
      deps([vector]),
      "todo.make-repeating",
      { uuid: source, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.uuid).toBe("TMPL"); // data.uuid stays the template
    expect(res.repeating).toEqual({
      templateUuid: "TMPL",
      instanceUuid: "INST",
      replacedUuid: source,
    });
    expect(res.repeating).not.toHaveProperty("childrenReplaced"); // to-do
    expect(res.undoToken).toBeUndefined(); // irreversible → no token
  });

  it("PRESERVED fate: instanceUuid = original, replacedUuid = null", async () => {
    const source = seedTodo(fixture.db, { title: "Standup", creationDate: NOW_EPOCH - 10 });
    const vector = uiVector(() => {
      const template = seedTodo(fixture.db, {
        uuid: "TMPL2",
        title: "Standup",
        recurrenceRule: true,
        creationDate: NOW_EPOCH,
      });
      fixture.db
        .prepare("UPDATE TMTask SET rt1_repeatingTemplate = ? WHERE uuid = ?")
        .run(template, source);
    });
    const res = await runMutation(
      deps([vector]),
      "todo.make-repeating",
      { uuid: source, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.repeating).toEqual({
      templateUuid: "TMPL2",
      instanceUuid: source,
      replacedUuid: null,
    });
  });
});

describe("project.make-repeating — repeating block with childrenReplaced", () => {
  it("carries childrenReplaced and suppresses the undoToken", async () => {
    const source = seedProject(fixture.db, {
      uuid: "PROJ",
      title: "Weekly review",
      start: "someday",
      creationDate: NOW_EPOCH - 10,
    });
    seedTodo(fixture.db, { title: "a", project: source });
    seedTodo(fixture.db, { title: "b", project: source });
    const vector = uiVector(() => {
      fixture.db.prepare("DELETE FROM TMTask WHERE uuid = ?").run(source);
      const template = seedProject(fixture.db, {
        uuid: "PTMPL",
        title: "Weekly review",
        recurrenceRule: true,
        creationDate: NOW_EPOCH,
      });
      seedProject(fixture.db, {
        uuid: "PINST",
        title: "Weekly review",
        repeatingTemplate: template,
        creationDate: NOW_EPOCH,
      });
    });
    const res = await runMakeRepeatingProject(
      deps([vector]),
      { uuid: source, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.repeating).toEqual({
      templateUuid: "PTMPL",
      instanceUuid: "PINST",
      replacedUuid: "PROJ",
      childrenReplaced: 2,
    });
    expect(res.undoToken).toBeUndefined();
  });
});
