/**
 * Container scope, leak surface 7 (the undo trail). Under a scope, the undo
 * selection path must filter candidate records BEFORE any listing, selection, or
 * result shaping — an out-of-scope record's uuid/title must never surface, and a
 * `--txn` token naming an out-of-scope record must fail IDENTICALLY to an unknown
 * token (no already-undone / out-of-scope distinction). The per-leg gate already
 * refuses APPLYING an out-of-scope inverse; this closes the LISTING oracle.
 *
 * runUndo's result is what both consumer surfaces serialize verbatim (the CLI
 * renders the UndoItemResult[]; the MCP undo tool returns it), so asserting the
 * result excludes out-of-scope data is asserting neither surface can emit it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { undoToken, type AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { resolveScope, type ResolvedScope } from "../../src/read/scope.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { runUndo } from "../../src/write/undo.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditDir: string;
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditDir = mkdtempSync(join(tmpdir(), "scope-undo-audit-"));
});
afterEach(() => {
  fixture.close();
  rmSync(auditDir, { recursive: true, force: true });
});

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "mike",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  bounceEnabled: true,
  bounceMaxItems: 30,
  ui: { enabled: false },
  scope: null,
  host: "test-host",
};

const MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.reopen", "todo.complete", "todo.update"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function fakeVector(): WriteVector {
  return {
    id: "url-scheme",
    matrix: MATRIX,
    async execute() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function auditRecord(partial: Partial<AuditRecord>): AuditRecord {
  return {
    v: 1,
    ts: "2026-07-05T10:00:00.000Z",
    actor: "mike",
    host: "test-host",
    op: "todo.complete",
    uuid: null,
    vector: "url-scheme",
    disruption: 0,
    invocation: "x",
    requested: {},
    pre: null,
    observed: null,
    result: "ok",
    verify: null,
    durationMs: 1,
    env: { pkg: "0.1.0", dbVersion: 26, fingerprint: "ok" },
    ...partial,
  };
}

function writeAudit(records: AuditRecord[]): void {
  writeFileSync(join(auditDir, "2026-07.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
}

function deps(scope?: ResolvedScope): WriteDeps {
  return {
    db: fixture.db,
    vectors: [fakeVector()],
    config: CONFIG,
    audit: { append: () => {} },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `scope-undo-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    ...(scope !== undefined && { scope }),
  };
}

interface Trail {
  workUuid: string;
  personalUuid: string;
  personalSecretTitle: string;
  records: AuditRecord[];
}

/** Seed a Work item + a Personal item, and a trail with an ok record for each. */
function seedTrail(): Trail {
  const work = seedArea(fixture.db, "Work", 0);
  const personal = seedArea(fixture.db, "Personal", 1);
  const workUuid = seedTodo(fixture.db, { title: "work item", area: work, status: "completed" });
  const personalSecretTitle = "personal secret plan";
  const personalUuid = seedTodo(fixture.db, {
    title: personalSecretTitle,
    area: personal,
    status: "completed",
  });
  const records = [
    auditRecord({
      ts: "2026-07-05T10:00:00.000Z",
      op: "todo.complete",
      uuid: personalUuid,
      requested: { uuid: personalUuid, title: personalSecretTitle },
      pre: { status: "open" },
    }),
    auditRecord({
      ts: "2026-07-05T10:01:00.000Z",
      op: "todo.complete",
      uuid: workUuid,
      requested: { uuid: workUuid, title: "work item" },
      pre: { status: "open" },
    }),
  ];
  return { workUuid, personalUuid, personalSecretTitle, records };
}

describe("undo trail under a container scope (leak surface 7)", () => {
  it("listing/selection surfaces only in-scope records; the out-of-scope title never appears", async () => {
    const t = seedTrail();
    writeAudit(t.records);
    const scope = resolveScope(fixture.db, "Work", "flag");
    // default selection reaches back over the whole trail (last: 10)
    const items = await runUndo(deps(scope), auditDir, { last: 10, dryRun: true });
    const targetUuids = items.map((i) => i.plan.target.uuid);
    expect(targetUuids).toContain(t.workUuid);
    expect(targetUuids).not.toContain(t.personalUuid);
    // Nothing in the serialized result (the exact bytes both surfaces render)
    // may carry the out-of-scope uuid or its title.
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain(t.personalUuid);
    expect(serialized).not.toContain(t.personalSecretTitle);
  });

  it("unscoped: BOTH records are selectable (control)", async () => {
    const t = seedTrail();
    writeAudit(t.records);
    const items = await runUndo(deps(), auditDir, { last: 10, dryRun: true });
    const targetUuids = items.map((i) => i.plan.target.uuid);
    expect(targetUuids).toContain(t.workUuid);
    expect(targetUuids).toContain(t.personalUuid);
  });

  it("--txn parity: an out-of-scope token fails BYTE-IDENTICALLY to an unknown token", async () => {
    const t = seedTrail();
    writeAudit(t.records);
    const scope = resolveScope(fixture.db, "Work", "flag");
    const personalToken = undoToken(t.records[0] as AuditRecord);

    const capture = async (txn: string): Promise<string> => {
      try {
        await runUndo(deps(scope), auditDir, { txn });
        throw new Error("expected a throw");
      } catch (e) {
        return (e as Error).message;
      }
    };
    const outOfScope = await capture(personalToken);
    const unknown = await capture("undo-nonexistent-token-000000");
    // The out-of-scope token reads exactly like a token that never existed —
    // no "already-undone" or "out-of-scope" distinction leaks its existence.
    expect(outOfScope).toBe(unknown.replace("undo-nonexistent-token-000000", personalToken));
    expect(outOfScope).toContain("no undoable mutation has undo token");
    expect(outOfScope).not.toContain("already been undone");
  });

  it("--txn of an in-scope token still resolves under scope", async () => {
    const t = seedTrail();
    writeAudit(t.records);
    const scope = resolveScope(fixture.db, "Work", "flag");
    const workToken = undoToken(t.records[1] as AuditRecord);
    const items = await runUndo(deps(scope), auditDir, { txn: workToken, dryRun: true });
    expect(items).toHaveLength(1);
    expect(items[0]?.plan.target.uuid).toBe(t.workUuid);
  });

  it("--txn parity holds even when the out-of-scope token was already undone", async () => {
    const t = seedTrail();
    const personalToken = undoToken(t.records[0] as AuditRecord);
    // Append an inverse for the Personal record (an undo:<actor> reopen).
    const inverse = auditRecord({
      ts: "2026-07-05T10:02:00.000Z",
      actor: "undo:mike",
      op: "todo.reopen",
      uuid: t.personalUuid,
      undoOf: personalToken,
    });
    writeAudit([...t.records, inverse]);
    const scope = resolveScope(fixture.db, "Work", "flag");
    let message = "";
    try {
      await runUndo(deps(scope), auditDir, { txn: personalToken });
    } catch (e) {
      message = (e as Error).message;
    }
    // Must NOT reveal the already-undone state (which would confirm existence).
    expect(message).toContain("no undoable mutation has undo token");
    expect(message).not.toContain("already been undone");
  });
});
