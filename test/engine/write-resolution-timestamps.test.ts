/**
 * Resolution-timestamp surface (plan §2/§5) — the multi-leg orchestrators behind
 * `--completed-at` / `--created-at` on complete/cancel/update, plus the date
 * normalization. Every row of the §2 semantics table is locked here by its LEG
 * PLAN (via dry-run disclosure): leg count, the flip-dance composition, the
 * refusals, and the idempotent single-op paths. One executed flip-dance validates
 * the txn summary + undo wiring. Normalization covers noon-in-zone including a
 * zone-shifted case.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { RESOLUTION_TIMESTAMP_EXPECTED } from "../../src/surface-copy.ts";
import { resolveResolutionInstant, resolutionDeltaDate } from "../../src/write/commands.ts";
import type { MutationResult, WriteDeps } from "../../src/write/pipeline.ts";
import {
  runCancelWithDate,
  runCompleteWithDate,
  runUpdateDates,
} from "../../src/write/resolution-timestamps.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
});

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "test-actor",
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

const OPS = [
  "todo.complete",
  "todo.cancel",
  "todo.reopen",
  "project.complete",
  "project.cancel",
  "project.reopen",
];
const URL_MATRIX: VectorMatrix = Object.fromEntries(
  OPS.map((op) => [op, { support: "yes", disruption: 0, validation: "validated" }]),
) as VectorMatrix;
const AS_MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.set-dates", "project.set-dates"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function fakeVector(
  id: WriteVector["id"],
  matrix: VectorMatrix,
  effect: ((payload: string) => void) | null,
) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id,
    matrix,
    async execute(invocation) {
      calls.push(invocation.payload);
      effect?.(invocation.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function deps(vectors: WriteVector[]): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-rt-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

/** The dry-run leg disclosure (drives no vector). */
function plan(r: MutationResult): { op: string; invocation: string; delta: unknown } {
  if (r.kind !== "dry-run") throw new Error(`expected dry-run, got ${r.kind}`);
  return { op: r.op, invocation: r.plan.invocation, delta: r.plan.expectedDelta };
}
function legCount(inv: string): number {
  const m = /^(\d+)-leg sequence/.exec(inv);
  return m === null ? 1 : Number(m[1]);
}

const dry = { dryRun: true } as const;
const dryUrl = () => deps([fakeVector("url-scheme", URL_MATRIX, null).vector]);
const dryBoth = () =>
  deps([
    fakeVector("url-scheme", URL_MATRIX, null).vector,
    fakeVector("applescript", AS_MATRIX, null).vector,
  ]);

// -------------------------------------------------------- §5 normalization

describe("resolution-timestamp normalization (§5)", () => {
  it("a date-only value is NOON in the effective zone (host when unspecified)", () => {
    const inst = resolveResolutionInstant("2025-01-15");
    expect(inst.getHours()).toBe(12); // host-local noon
    expect(inst.getDate()).toBe(15);
    expect(resolutionDeltaDate("2025-01-15")).toBe("2025-01-15");
  });

  it("noon-in-zone is NOT noon-UTC: a +14h zone shifts the instant to the prior UTC day", () => {
    const utc = resolveResolutionInstant("2025-01-15", "UTC");
    expect(utc.getUTCHours()).toBe(12);
    expect(utc.getUTCDate()).toBe(15);
    // noon at UTC+14 == 22:00 UTC the PREVIOUS day — noon still decodes to the
    // 15th in the caller's zone, which is the whole point of choosing noon.
    const ahead = resolveResolutionInstant("2025-01-15", "Etc/GMT-14");
    expect(ahead.getUTCHours()).toBe(22);
    expect(ahead.getUTCDate()).toBe(14);
  });

  it("a datetime carries its wall-clock time (not coerced to noon)", () => {
    const inst = resolveResolutionInstant("2025-01-15T09:30");
    expect(inst.getHours()).toBe(9);
    expect(inst.getMinutes()).toBe(30);
    const withSecs = resolveResolutionInstant("2025-01-15T09:30:45", "UTC");
    expect(withSecs.getUTCHours()).toBe(9);
    expect(withSecs.getUTCSeconds()).toBe(45);
  });

  // #612 ride-along: `--completed-at "2026-08-19 09:30"` used to be refused for
  // want of the ISO `T`. The space is now an accepted SPELLING of the same
  // instant at both layers (the parameter schema and this resolver), so the two
  // forms are interchangeable everywhere a resolution timestamp is taken.
  it("a space between date and time reads the same instant as the T spelling (#612)", () => {
    for (const zone of [undefined, "UTC", "America/Chicago"]) {
      expect(resolveResolutionInstant("2025-01-15 09:30", zone).getTime()).toBe(
        resolveResolutionInstant("2025-01-15T09:30", zone).getTime(),
      );
      expect(resolveResolutionInstant("2025-01-15 09:30:45", zone).getTime()).toBe(
        resolveResolutionInstant("2025-01-15T09:30:45", zone).getTime(),
      );
    }
    const spaced = resolveResolutionInstant("2025-01-15 09:30", "UTC");
    expect(spaced.getUTCHours()).toBe(9);
    expect(spaced.getUTCMinutes()).toBe(30);
    expect(resolutionDeltaDate("2025-01-15 09:30")).toBe(resolutionDeltaDate("2025-01-15T09:30"));
  });

  it("a malformed value is rejected, naming both accepted spellings (#612)", () => {
    expect(() => resolveResolutionInstant("15/01/2025")).toThrow(/invalid timestamp/);
    // Only ONE separator, and only a space: neither a tab nor a doubled space
    // is a datetime, and the refusal names the exact grammar it wanted.
    for (const bad of ["2025-01-15  09:30", "2025-01-15\t09:30", "2025-01-15X09:30"]) {
      expect(() => resolveResolutionInstant(bad)).toThrow(
        new RegExp(RESOLUTION_TIMESTAMP_EXPECTED.replace(/[()]/g, "\\$&")),
      );
    }
  });
});

// -------------------------------------------------------- §2 complete rows

describe("complete --completed-at (§2 to-do rows)", () => {
  it("open + backdate → 2 legs: flip → completed, then AS backdate", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "open" });
    const p = plan(
      await runCompleteWithDate(dryUrl(), "todo", uuid, { completedAt: "2025-01-15" }, dry),
    );
    expect(legCount(p.invocation)).toBe(2);
    expect(p.invocation).toContain("flip → completed");
    expect(p.invocation).toContain("AS set completion=2025-01-15");
    expect(p.delta).toMatchObject({
      assert: [
        { field: "status", equals: "completed" },
        { field: "stoppedDate", equals: "2025-01-15" },
      ],
    });
  });

  it("completed + backdate → 1 leg: AS backdate only (no redundant flip)", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "completed" });
    const p = plan(
      await runCompleteWithDate(dryUrl(), "todo", uuid, { completedAt: "2025-01-15" }, dry),
    );
    expect(legCount(p.invocation)).toBe(1);
    expect(p.invocation).not.toContain("flip");
  });

  it("canceled + backdate → 2 legs: flip → completed, then AS backdate", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "canceled" });
    const p = plan(
      await runCompleteWithDate(dryUrl(), "todo", uuid, { completedAt: "2025-01-15" }, dry),
    );
    expect(legCount(p.invocation)).toBe(2);
    expect(p.invocation).toContain("flip → completed");
  });

  it("no timestamp → a single plain complete (idempotent on already-completed)", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "completed" });
    const r = await runCompleteWithDate(dryUrl(), "todo", uuid, {}, dry);
    expect(r.kind).toBe("dry-run");
    if (r.kind === "dry-run") expect(r.op).toBe("todo.complete");
  });
});

// -------------------------------------------------------- §2 cancel rows

describe("cancel --completed-at (§2 to-do rows)", () => {
  it("open + backdate → 3-leg flip-dance: → completed, AS backdate, → canceled", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "open" });
    const p = plan(
      await runCancelWithDate(dryUrl(), "todo", uuid, { completedAt: "2025-01-15" }, dry),
    );
    expect(legCount(p.invocation)).toBe(3);
    expect(p.invocation).toContain("flip → completed");
    expect(p.invocation).toContain("AS set completion=2025-01-15");
    expect(p.invocation).toContain("flip → canceled");
    expect(p.delta).toMatchObject({
      assert: [
        { field: "status", equals: "canceled" },
        { field: "stoppedDate", equals: "2025-01-15" },
      ],
    });
  });

  it("completed + backdate → 2 legs: AS backdate (while completed), then flip → canceled", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "completed" });
    const p = plan(
      await runCancelWithDate(dryUrl(), "todo", uuid, { completedAt: "2025-01-15" }, dry),
    );
    expect(legCount(p.invocation)).toBe(2);
    expect(p.invocation).toContain("AS set completion");
    expect(p.invocation).toContain("flip → canceled");
    expect(p.invocation).not.toContain("flip → completed");
  });

  it("canceled + backdate → 3-leg flip-dance (idempotent status, backdated stop)", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "canceled" });
    const p = plan(
      await runCancelWithDate(dryUrl(), "todo", uuid, { completedAt: "2025-01-15" }, dry),
    );
    expect(legCount(p.invocation)).toBe(3);
  });

  it("no timestamp → a single plain cancel", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "open" });
    const r = await runCancelWithDate(dryUrl(), "todo", uuid, {}, dry);
    if (r.kind === "dry-run") expect(r.op).toBe("todo.cancel");
  });
});

// -------------------------------------------------------- §2/§3 update rows

describe("update --completed-at/--created-at (§2/§3)", () => {
  it("completed-at on an OPEN item is REFUSED, pointing at complete/cancel", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "open" });
    const r = await runUpdateDates(dryBoth(), "todo", uuid, { completedAt: "2025-01-15" }, dry);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.hazard).toBe("H-BACKDATE-OPEN");
      expect(r.remediation).toContain("complete --completed-at");
      expect(r.remediation).toContain("cancel --completed-at");
    }
  });

  it("completed-at on a COMPLETED item → a single set-dates leg (not a composite)", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "completed" });
    const r = await runUpdateDates(dryBoth(), "todo", uuid, { completedAt: "2025-01-15" }, dry);
    if (r.kind === "dry-run") expect(r.op).toBe("todo.set-dates");
  });

  it("completed-at on a CANCELED item → the 3-leg flip-dance preserving canceled", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "canceled" });
    const p = plan(
      await runUpdateDates(dryBoth(), "todo", uuid, { completedAt: "2025-01-15" }, dry),
    );
    expect(legCount(p.invocation)).toBe(3);
    expect(p.delta).toMatchObject({
      assert: [
        { field: "status", equals: "canceled" },
        { field: "stoppedDate", equals: "2025-01-15" },
      ],
    });
  });

  it("created-at alone is status-safe → a single set-dates leg on an OPEN item", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "open" });
    const r = await runUpdateDates(dryBoth(), "todo", uuid, { createdAt: "2024-06-01" }, dry);
    if (r.kind === "dry-run") expect(r.op).toBe("todo.set-dates");
  });

  it("both dates on a CANCELED item → creation rides the middle backdate leg", async () => {
    const uuid = seedTodo(fixture.db, { title: "t", status: "canceled" });
    const p = plan(
      await runUpdateDates(
        dryBoth(),
        "todo",
        uuid,
        { completedAt: "2025-01-15", createdAt: "2024-06-01" },
        dry,
      ),
    );
    expect(legCount(p.invocation)).toBe(3);
    expect(p.invocation).toContain("completion=2025-01-15 + creation=2024-06-01");
  });
});

// -------------------------------------------------------- project guards

describe("project resolution timestamps (guards)", () => {
  it("cancel --completed-at on an open project with OPEN children is refused (strand guard)", async () => {
    const proj = seedProject(fixture.db, { title: "P", status: "open" });
    seedTodo(fixture.db, { title: "open child", project: proj, status: "open" });
    const r = await runCancelWithDate(
      dryBoth(),
      "project",
      proj,
      { children: "auto-cancel", completedAt: "2025-01-15" },
      dry,
    );
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.detail).toContain("open child");
  });

  it("a project WITHOUT open children backdates through the flip-dance", async () => {
    const proj = seedProject(fixture.db, { title: "P", status: "canceled" });
    const p = plan(
      await runCancelWithDate(
        dryBoth(),
        "project",
        proj,
        { children: "require-resolved", completedAt: "2025-01-15" },
        dry,
      ),
    );
    expect(legCount(p.invocation)).toBe(3);
  });
});

// -------------------------------------------------------- executed flip-dance

describe("executed flip-dance (txn summary + undo wiring)", () => {
  it("cancel --completed-at on a canceled to-do runs 3 legs, discloses them, and mints an undo token", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "t",
      status: "canceled",
      stopDate: Math.floor(new Date("2026-06-01T12:00:00Z").getTime() / 1000),
    });
    const stampDay = resolutionDeltaDate("2025-01-15");
    const noonEpoch = Math.floor(resolveResolutionInstant("2025-01-15").getTime() / 1000);
    const url = fakeVector("url-scheme", URL_MATRIX, (payload) => {
      if (payload.includes("completed=true"))
        fixture.db.prepare("UPDATE TMTask SET status=3 WHERE uuid=?").run(uuid);
      if (payload.includes("canceled=true"))
        fixture.db.prepare("UPDATE TMTask SET status=2 WHERE uuid=?").run(uuid);
    });
    const as = fakeVector("applescript", AS_MATRIX, () => {
      fixture.db
        .prepare("UPDATE TMTask SET status=3, stopDate=? WHERE uuid=?")
        .run(noonEpoch, uuid);
    });
    const d = deps([url.vector, as.vector]);
    const r = await runCancelWithDate(d, "todo", uuid, { completedAt: "2025-01-15" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.op).toBe("todo.cancel");
      expect(r.undoToken).toBeDefined();
      expect((r.warnings ?? []).join(" ")).toContain("3 non-atomic legs");
    }
    // 3 URL/AS calls total (2 URL flips + 1 AS backdate) and a summary audit record.
    expect(url.calls.length + as.calls.length).toBe(3);
    expect(auditRecords.some((a) => a.txn?.role === "summary" && a.op === "todo.cancel")).toBe(
      true,
    );
    // Ends canceled with the backdated stop date.
    const row = fixture.db
      .prepare("SELECT status, stopDate FROM TMTask WHERE uuid=?")
      .get(uuid) as {
      status: number;
      stopDate: number;
    };
    expect(row.status).toBe(2);
    expect(row.stopDate).toBe(noonEpoch);
    expect(stampDay).toBe("2025-01-15");
  });
});
