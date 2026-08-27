/**
 * Batch STATIC preflight × the per-operation parameter schema (#580).
 *
 * The bug this locks down: a bare uuid STRING supplied for `params.project`
 * failed the engine's destination duck-test, was read as "no destination given",
 * compiled an invocation with no `list-id` and an expectedDelta with no placement
 * assertion — so the to-do landed in the Inbox, verification passed, and the
 * batch reported ok=1, failed=0, exit 0.
 *
 * What must hold now: the whole batch is refused at preflight, nothing is
 * dispatched, no audit record is written, and --dry-run takes the identical pass.
 * `--continue-on-error` is orthogonal (it governs RUNTIME failures) and cannot
 * smuggle a structurally invalid line into execution.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runBatch, type BatchOp } from "../../src/write/batch.ts";
import { OPERATION_KINDS } from "../../src/write/operations.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { allInjections, validParams } from "../fixtures/param-matrix.ts";
import { seedProject } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let executed: number;
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
  executed = 0;
});
afterEach(() => fixture.close());

const MATRIX: VectorMatrix = Object.fromEntries(
  [...OPERATION_KINDS].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function countingVector(): WriteVector {
  return {
    id: "url-scheme",
    matrix: MATRIX,
    async execute() {
      executed += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "batch-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  certifiedAppVersion: null,
  allowExperimental: false,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  helpersMode: "false",
  ui: { enabled: false },
  host: "test-host",
};

function deps(): WriteDeps {
  return {
    db: fixture.db,
    vectors: [countingVector()],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-batch-schema-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

/** The compounds are refused for a different (earlier) reason — see BATCH_UNSUPPORTED_COMPOUND. */
const COMPOUNDS = new Set([
  "todo.make-repeating",
  "project.make-repeating",
  "todo.add-repeating",
  "project.add-repeating",
]);

describe("the #580 repro", () => {
  it("a bare-string project refuses the batch: nonzero, zero writes, zero audit records", async () => {
    const project = seedProject(fixture.db, { title: "Synthetic Project" });
    const ops: BatchOp[] = [
      {
        op: "todo.add",
        params: { title: "Synthetic child", project },
        opId: "malformed-project-probe",
      },
    ];
    const { results, undoToken } = await runBatch(deps(), ops);
    expect(results.map((r) => r.outcome.kind)).toEqual(["invalid"]);
    const detail = results[0]?.outcome.kind === "invalid" ? results[0].outcome.detail : "";
    expect(detail).toContain("params.project");
    expect(detail).toContain("expected a container reference object");
    expect(detail).toContain("received a string");
    expect(detail).toContain(`{"uuid": "${project}"}`);
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
    expect(undoToken).toBeUndefined();
  });

  it("the control (the object form) still plans a placement + a placement assertion", async () => {
    const project = seedProject(fixture.db, { title: "Synthetic Project" });
    const { results } = await runBatch(
      deps(),
      [
        {
          op: "todo.add",
          params: { title: "Synthetic child control", project: { uuid: project } },
        },
      ],
      { dryRun: true },
    );
    const outcome = results[0]?.outcome;
    expect(outcome?.kind).toBe("dry-run");
    const plan = outcome?.kind === "dry-run" ? outcome.plan : undefined;
    expect(plan?.invocation).toContain(`list-id=${project}`);
    const delta = plan?.expectedDelta;
    expect(delta?.mode).toBe("create");
    expect(delta !== undefined && "assert" in delta ? delta.assert : []).toContainEqual({
      field: "project.uuid",
      equals: project,
    });
  });

  it('the temp-ID variant ("project": "$proj") is refused too — no bare uuid is written back', async () => {
    const ops: BatchOp[] = [
      { op: "project.add", params: { title: "Synthetic Project" }, tempId: "project1" },
      { op: "todo.add", params: { title: "Synthetic Child", project: "$project1" } },
    ];
    const { results } = await runBatch(deps(), ops);
    expect(results.map((r) => r.outcome.kind)).toEqual(["skipped", "invalid"]);
    const detail = results[1]?.outcome.kind === "invalid" ? results[1].outcome.detail : "";
    expect(detail).toContain("params.project");
    expect(detail).toContain('{"uuid": "$project1"}');
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
  });

  it("--dry-run takes the identical pass", async () => {
    const project = seedProject(fixture.db, { title: "Synthetic Project" });
    const ops: BatchOp[] = [{ op: "todo.add", params: { title: "Synthetic child", project } }];
    const wet = await runBatch(deps(), ops);
    const dry = await runBatch(deps(), ops, { dryRun: true });
    expect(dry.results.map((r) => r.outcome.kind)).toEqual(wet.results.map((r) => r.outcome.kind));
    expect(dry.results[0]?.outcome.kind === "invalid" ? dry.results[0].outcome.detail : "").toEqual(
      wet.results[0]?.outcome.kind === "invalid" ? wet.results[0].outcome.detail : "x",
    );
    expect(executed).toBe(0);
  });

  it("--continue-on-error cannot smuggle a structurally invalid line into execution", async () => {
    const project = seedProject(fixture.db, { title: "Synthetic Project" });
    const { results } = await runBatch(
      deps(),
      [
        { op: "todo.add", params: { title: "Fine" } },
        { op: "todo.add", params: { title: "Malformed", project } },
      ],
      { continueOnError: true },
    );
    expect(results.map((r) => r.outcome.kind)).toEqual(["skipped", "invalid"]);
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
  });
});

describe("the generated parameter-type matrix, through the batch preflight", () => {
  const matrix = allInjections().filter((c) => !COMPOUNDS.has(c.op));

  it("every injection refuses the whole batch, naming its own JSON path", async () => {
    // ONE submission carrying every malformed line: the whole-batch refusal
    // enumerates each one, so a single run covers the matrix and simultaneously
    // proves that nothing dispatches when ANY line is malformed.
    const ops = matrix.map((c) => ({ op: c.op, params: c.params }) as BatchOp);
    const { results, undoToken } = await runBatch(deps(), ops);
    const survivors: string[] = [];
    results.forEach((result, i) => {
      const injection = matrix[i]!;
      const detail = result.outcome.kind === "invalid" ? result.outcome.detail : null;
      if (detail === null || !detail.startsWith(injection.path)) {
        survivors.push(`${injection.op} ${injection.kind} ${injection.field}: ${detail ?? "n/a"}`);
      }
    });
    expect(survivors).toEqual([]);
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
    expect(undoToken).toBeUndefined();
  });

  it("a valid bag for every op clears the preflight (the matrix is not vacuous)", async () => {
    // Preflight only — these bags name uuids that do not exist, so they are
    // planned as a dry-run and fail LATER (or not at all); what matters here is
    // that none is refused STATICALLY.
    const ops = [...OPERATION_KINDS]
      .filter((op) => !COMPOUNDS.has(op))
      .map((op) => ({ op, params: validParams(op) }) as BatchOp);
    const { results } = await runBatch(deps(), ops, { dryRun: true });
    const staticallyRefused = results
      .filter((r) => r.outcome.kind === "invalid" && r.outcome.detail.startsWith("params."))
      .map((r) => `${r.op}: ${r.outcome.kind === "invalid" ? r.outcome.detail : ""}`);
    expect(staticallyRefused).toEqual([]);
  });
});

/**
 * The retroactive 0.17.0-dev field report (#612), pinned at the shape it was
 * actually submitted in: a migration batch of ONE `project.add` carrying a
 * tempId followed by THIRTEEN `todo.add` lines whose container reference was
 * the bare string `"$proj"`. Under 0.17.0-dev that batch reported ok=14 with a
 * populated tempIdMapping while every to-do landed in the Inbox — the container
 * bind was silently dropped. The two cases below are the issue's own checkboxes.
 */
describe("#612 — the 0.17.0-dev migration-batch report", () => {
  it("the 14-op bare-string batch is refused WHOLE, with zero writes and no mapping", async () => {
    const ops: BatchOp[] = [
      { op: "project.add", params: { title: "Synthetic Migration" }, tempId: "proj" },
      ...Array.from({ length: 13 }, (_, i) => ({
        op: "todo.add" as const,
        params: { title: `Synthetic migrated ${i + 1}`, project: "$proj" },
        opId: `migrated-${i + 1}`,
      })),
    ];
    const { results, undoToken, tempIdMapping } = await runBatch(deps(), ops);

    // Nothing ran: the ONE well-formed line is skipped rather than executed,
    // and all thirteen malformed lines are refused statically.
    expect(results).toHaveLength(14);
    expect(results[0]?.outcome.kind).toBe("skipped");
    expect(results.slice(1).map((r) => r.outcome.kind)).toEqual(Array(13).fill("invalid"));
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
    expect(undoToken).toBeUndefined();
    // No temp id was ever minted, so no "valid tempIdMapping" can imply success.
    expect(tempIdMapping).toEqual({});

    // Every refusal names its own line's path and steers to the object form.
    for (const result of results.slice(1)) {
      const detail = result.outcome.kind === "invalid" ? result.outcome.detail : "";
      expect(detail).toContain("params.project");
      expect(detail).toContain("expected a container reference object");
      expect(detail).toContain("received a string");
      expect(detail).toContain('{"uuid": "$proj"}');
    }
  });

  it('todo.update with {"id": …} is refused naming params.id, and lists uuid', async () => {
    const { results } = await runBatch(deps(), [
      {
        op: "todo.update",
        params: { id: "todo-uuid-0001", title: "Synthetic new title" },
      } as unknown as BatchOp,
    ]);
    expect(results[0]?.outcome.kind).toBe("invalid");
    const detail = results[0]?.outcome.kind === "invalid" ? results[0].outcome.detail : "";
    // The key is named — not swallowed into an internal SQLite bind error.
    expect(detail).toContain("params.id");
    expect(detail).toContain('not a parameter of "todo.update"');
    // …and the accepted set is enumerated, which is where `uuid` is found.
    expect(detail).toContain("accepted parameters are uuid");
    expect(detail).not.toContain("SQLite parameter");
    expect(executed).toBe(0);
    expect(auditRecords).toHaveLength(0);
  });
});

describe("line-level keys", () => {
  it("an unrecognized field on the line refuses the batch", async () => {
    const { results } = await runBatch(deps(), [
      { op: "todo.add", params: { title: "Sample" }, tmpId: "typo" } as unknown as BatchOp,
    ]);
    expect(results[0]?.outcome.kind).toBe("invalid");
    expect(results[0]?.outcome.kind === "invalid" && results[0].outcome.detail).toContain("tmpId");
    expect(executed).toBe(0);
  });

  it("an unrecognized per-line option refuses the batch", async () => {
    const { results } = await runBatch(deps(), [
      {
        op: "todo.add",
        params: { title: "Sample" },
        options: { dangerously_permanent: true },
      } as unknown as BatchOp,
    ]);
    expect(results[0]?.outcome.kind).toBe("invalid");
    expect(results[0]?.outcome.kind === "invalid" && results[0].outcome.detail).toContain(
      "options.dangerously_permanent",
    );
    expect(executed).toBe(0);
  });
});
