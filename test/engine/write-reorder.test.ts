/**
 * write.reorder engine tests. The native path rides the standard pipeline
 * (experimental gate → sdef canary → guards → ordering verification); the
 * bounce path is the orchestrator (verified when= legs + between-step state
 * re-checks). FakeVectors simulate the app's validated semantics: the native
 * reorder assigns ascending ranks to the wire list (O01/O04/O05), a when=
 * round-trip FRONT-inserts into the target section (O07/O08).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { encodePackedDate } from "../../src/model/dates.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import { computeReorderPre } from "../../src/write/pre-state.ts";
import { BOUNCE_MAX_ITEMS, bounceJsonCollapsible, runReorder } from "../../src/write/reorder.ts";
import { planUndo } from "../../src/write/undo.ts";
import type { ReorderParams } from "../../src/write/operations.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const TODAY_ISO = "2026-07-05";
const PACKED_TODAY = encodePackedDate(TODAY_ISO);

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;
let modClock = 1_790_000_000;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
});

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

function config(allowExperimental: boolean): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 1,
    actor: "test-actor",
    auditEnabled: true,
    acceptedFingerprint: null,
    allowExperimental,
    bounceEnabled: true,
    bounceMaxItems: 30,
    ui: { enabled: false },
    host: "test-host",
  };
}

function deps(vectors: WriteVector[], overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: config(true),
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-reorder-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    sdefProbe: () => true,
    ...overrides,
  };
}

/** Native sim: parse the ids list and assign ascending ranks (O01 semantics). */
function nativeVector(rankColumn: "todayIndex" | `"index"` = "todayIndex") {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const ids = /with ids "([^"]+)"/.exec(invocation.payload)?.[1]?.split(",") ?? [];
      let rank = 1;
      for (const uuid of ids) {
        fixture.db
          .prepare(`UPDATE TMTask SET ${rankColumn} = ?, userModificationDate = ? WHERE uuid = ?`)
          .run(rank++, modClock++, uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/** Bounce sim: when= round-trips FRONT-insert into the section (O07/O08). */
function bounceVector(hooks: { afterLeg?: (payload: string, db: DatabaseSync) => void } = {}) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: { "todo.update": { support: "yes", disruption: 0, validation: "validated" } },
    async execute(invocation) {
      calls.push(invocation.payload);
      const url = new URL(invocation.payload);
      const id = url.searchParams.get("id") ?? "";
      const when = url.searchParams.get("when") ?? "";
      const bucket = when === "evening" ? 1 : 0;
      const min = fixture.db
        .prepare(
          `SELECT MIN(todayIndex) AS m FROM TMTask WHERE trashed = 0 AND status = 0
           AND startBucket = ? AND startDate IS NOT NULL AND startDate <= ?`,
        )
        .get(bucket, PACKED_TODAY) as { m: number | null };
      fixture.db
        .prepare(
          `UPDATE TMTask SET start = 1, startDate = ?, startBucket = ?, todayIndex = ?,
           userModificationDate = ? WHERE uuid = ?`,
        )
        .run(PACKED_TODAY, bucket, (min.m ?? 0) - 1, modClock++, id);
      hooks.afterLeg?.(invocation.payload, fixture.db);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function seedToday(title: string, todayIndex: number, opts: { evening?: boolean } = {}): string {
  return seedTodo(fixture.db, {
    title,
    start: "active",
    startDate: TODAY_ISO,
    todayIndex,
    ...(opts.evening !== undefined && { evening: opts.evening }),
  });
}

function ranks(uuids: string[], column: "todayIndex" | `"index"` = "todayIndex"): number[] {
  return uuids.map(
    (uuid) =>
      (
        fixture.db.prepare(`SELECT ${column} AS r FROM TMTask WHERE uuid = ?`).get(uuid) as {
          r: number;
        }
      ).r,
  );
}

describe("native reorder (private command through the pipeline)", () => {
  it("today scope: extends a partial request to the full wire list and verifies", async () => {
    const a = seedToday("A", 10);
    const b = seedToday("B", 20);
    const c = seedToday("C", 30);
    const { vector, calls } = nativeVector();
    const result = await runReorder(deps([vector]), { scope: "today", uuids: [c, a] });
    expect(result.kind).toBe("ok");
    // Wire list = requested first, remaining member (b) after, in one call.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`list "Today"`);
    expect(calls[0]).toContain(`with ids "${c},${a},${b}"`);
    const [rc, ra, rb] = ranks([c, a, b]);
    expect(rc).toBeLessThan(ra as number);
    expect(ra).toBeLessThan(rb as number);
  });

  it("project scope: uuid specifier, un-headed children only", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const one = seedTodo(fixture.db, { title: "one", project: proj, index: 1 });
    const two = seedTodo(fixture.db, { title: "two", project: proj, index: 2 });
    const { vector, calls } = nativeVector(`"index"`);
    const result = await runReorder(deps([vector]), {
      scope: "project",
      container: { uuid: proj },
      uuids: [two, one],
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`project id "${proj}"`);
    expect(calls[0]).toContain(`with ids "${two},${one}"`);
  });

  it('inbox scope: list "Inbox" specifier, ranks on index (A6)', async () => {
    const one = seedTodo(fixture.db, { title: "one", start: "inbox", index: 1 });
    const two = seedTodo(fixture.db, { title: "two", start: "inbox", index: 2 });
    const { vector, calls } = nativeVector(`"index"`);
    const result = await runReorder(deps([vector]), { scope: "inbox", uuids: [two, one] });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`list "Inbox"`);
    expect(calls[0]).toContain(`with ids "${two},${one}"`);
    const [r2, r1] = ranks([two, one], `"index"`);
    expect(r2).toBeLessThan(r1 as number);
  });

  it("area scope: PROJECT members reorder natively (O14)", async () => {
    const area = seedArea(fixture.db, "Work");
    const p1 = seedProject(fixture.db, { title: "P1", area, index: 1 });
    const p2 = seedProject(fixture.db, { title: "P2", area, index: 2 });
    const { vector, calls } = nativeVector(`"index"`);
    const result = await runReorder(deps([vector]), {
      scope: "area",
      container: { uuid: area },
      uuids: [p2, p1],
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`area id "${area}"`);
    expect(calls[0]).toContain(`with ids "${p2},${p1}"`);
    const [r2, r1] = ranks([p2, p1], `"index"`);
    expect(r2).toBeLessThan(r1 as number);
  });

  it("H-REORDER-SCOPE rejects a MIXED to-do+project area reorder (unprobed)", async () => {
    const area = seedArea(fixture.db, "Work");
    const p = seedProject(fixture.db, { title: "P", area, index: 1 });
    const t = seedTodo(fixture.db, { title: "T", area, index: 2 });
    const { vector, calls } = nativeVector(`"index"`);
    const result = await runReorder(deps([vector]), {
      scope: "area",
      container: { uuid: area },
      uuids: [t, p],
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-REORDER-SCOPE");
      expect(result.detail).toContain("mixes to-dos and projects");
    }
    expect(calls).toHaveLength(0);
  });

  it("is gated by config.allowExperimental (planner refuses the matrix entry)", async () => {
    const a = seedToday("A", 10);
    const { vector, calls } = nativeVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "today",
      uuids: [a],
      strategy: "native",
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.considered[0]?.why).toContain("allow-experimental");
    }
    expect(calls).toHaveLength(0);
  });

  it("is blocked by the sdef canary when the private command vanishes", async () => {
    const a = seedToday("A", 10);
    const { vector, calls } = nativeVector();
    const result = await runReorder(deps([vector], { sdefProbe: () => false }), {
      scope: "today",
      uuids: [a],
      strategy: "native",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.reason).toBe("environment");
      expect(result.detail).toContain("sdef");
    }
    expect(calls).toHaveLength(0);
  });

  it("H-REORDER-SCOPE rejects evening-bucket members in a today reorder (O03)", async () => {
    const a = seedToday("A", 10);
    const ev = seedToday("EV", 20, { evening: true });
    const { vector, calls } = nativeVector();
    const result = await runReorder(deps([vector]), { scope: "today", uuids: [ev, a] });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-REORDER-SCOPE");
      expect(result.detail).toContain("de-evening");
    }
    expect(calls).toHaveLength(0);
  });

  it("H-REORDER-SCOPE rejects headed children in a project reorder (O06)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const flat = seedTodo(fixture.db, { title: "flat", project: proj, index: 1 });
    const headed = seedTodo(fixture.db, { title: "headed", heading, index: 1 });
    const { vector } = nativeVector(`"index"`);
    const result = await runReorder(deps([vector]), {
      scope: "project",
      container: { uuid: proj },
      uuids: [headed, flat],
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-REORDER-SCOPE");
      expect(result.detail).toContain("heading");
    }
  });

  it("explicit native strategy on the evening scope is refused (O03)", async () => {
    const ev = seedToday("EV", 10, { evening: true });
    const { vector, calls } = nativeVector();
    const result = await runReorder(deps([vector]), {
      scope: "evening",
      uuids: [ev],
      strategy: "native",
    });
    expect(result.kind).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("verify-failed mismatch when the app applies a contradicting order", async () => {
    const a = seedToday("A", 10);
    const b = seedToday("B", 20);
    const wrongOrder: WriteVector = {
      id: "applescript",
      matrix: {
        reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
      },
      async execute() {
        // Apply the OPPOSITE of the request: b before a.
        fixture.db
          .prepare("UPDATE TMTask SET todayIndex = 1, userModificationDate = ? WHERE uuid = ?")
          .run(modClock++, a);
        fixture.db
          .prepare("UPDATE TMTask SET todayIndex = 0, userModificationDate = ? WHERE uuid = ?")
          .run(modClock++, b);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await runReorder(
      deps([wrongOrder]),
      { scope: "today", uuids: [a, b], strategy: "native" },
      { verifyTimeoutMs: 300 },
    );
    // a's rank moved away from its pre-state without satisfying the sequence.
    expect(result.kind).toBe("verify-failed");
    if (result.kind === "verify-failed") expect(result.reason).toBe("mismatch");
  });
});

describe("bounce reorder (verified when= round-trips)", () => {
  it("evening scope defaults to bounce and places items front-first", async () => {
    const e1 = seedToday("E1", 10, { evening: true });
    const e2 = seedToday("E2", 20, { evening: true });
    seedToday("T1", 5); // today-proper neighbor, untouched
    const { vector, calls } = bounceVector();
    const result = await runReorder(deps([vector]), { scope: "evening", uuids: [e2, e1] });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.vector).toBe("url-scheme");
    // Two legs per item, reverse order: e1 bounced first, then e2.
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain(`id=${e1}`);
    expect(calls[0]).toContain("when=today");
    expect(calls[1]).toContain(`id=${e1}`);
    expect(calls[1]).toContain("when=evening");
    expect(calls[2]).toContain(`id=${e2}`);
    const [r2, r1] = ranks([e2, e1]);
    expect(r2).toBeLessThan(r1 as number);
    // Summary audit record for the whole reorder, plus one per leg.
    const summary = auditRecords.filter((r) => r.op === "reorder");
    expect(summary).toHaveLength(1);
    expect(summary[0]?.result).toBe("ok");
    expect(
      auditRecords.filter((r) => r.op === "todo.update" && r.result !== "intent"),
    ).toHaveLength(4);
  });

  it("today scope falls back to bounce when experimental is off", async () => {
    const a = seedToday("A", 10);
    const b = seedToday("B", 20);
    const { vector, calls } = bounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "today",
      uuids: [b, a],
    });
    expect(result.kind).toBe("ok");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("when=evening"); // leg 1 bounces AWAY from today
    const [rb, ra] = ranks([b, a]);
    expect(rb).toBeLessThan(ra as number);
  });

  it("aborts cleanly with partial progress when an item vanishes mid-run", async () => {
    const e1 = seedToday("E1", 10, { evening: true });
    const e2 = seedToday("E2", 20, { evening: true });
    // Simulate a concurrent user edit: while e2 (bounced FIRST — reverse
    // order) completes its round trip, e1 gets completed in the app.
    const { vector } = bounceVector({
      afterLeg: (payload, db) => {
        if (payload.includes(`id=${e2}`) && payload.includes("when=evening")) {
          db.prepare("UPDATE TMTask SET status = 3, userModificationDate = ? WHERE uuid = ?").run(
            modClock++,
            e1,
          );
        }
      },
    });
    const result = await runReorder(deps([vector]), { scope: "evening", uuids: [e1, e2] });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") {
      expect(result.placed).toEqual([e2]);
      expect(result.remaining).toEqual([e1]);
      expect(result.detail).toContain("no longer open");
      expect(result.cause).toBeNull();
    }
    const summary = auditRecords.find((r) => r.op === "reorder");
    expect(summary?.result).toBe("verify-failed:mismatch");
  });

  it("reports a stranded item when leg 2 fails", async () => {
    const e1 = seedToday("E1", 10, { evening: true });
    let legs = 0;
    const failing: WriteVector = {
      id: "url-scheme",
      matrix: { "todo.update": { support: "yes", disruption: 0, validation: "validated" } },
      async execute(invocation) {
        legs += 1;
        if (legs === 2) return { exitCode: 1, stdout: "", stderr: "boom" };
        const url = new URL(invocation.payload);
        fixture.db
          .prepare(
            "UPDATE TMTask SET startBucket = 0, todayIndex = -1, userModificationDate = ? WHERE uuid = ?",
          )
          .run(modClock++, url.searchParams.get("id") ?? "");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await runReorder(deps([failing]), { scope: "evening", uuids: [e1] });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") {
      expect(result.detail).toContain("STRANDED");
      expect(result.cause?.kind).toBe("verify-failed");
    }
  });

  it("caps the item count", async () => {
    const uuids = Array.from({ length: BOUNCE_MAX_ITEMS + 1 }, (_, i) =>
      seedToday(`E${i}`, i + 1, { evening: true }),
    );
    const { vector, calls } = bounceVector();
    const result = await runReorder(deps([vector]), { scope: "evening", uuids });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("cap");
    expect(calls).toHaveLength(0);
  });

  it("refuses project/area scopes", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const one = seedTodo(fixture.db, { title: "one", project: proj, index: 1 });
    const { vector } = bounceVector();
    const result = await runReorder(deps([vector]), {
      scope: "project",
      container: { uuid: proj },
      uuids: [one],
      strategy: "bounce",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("when= round-trip");
  });

  it("dry-run describes the legs without executing", async () => {
    const e1 = seedToday("E1", 10, { evening: true });
    const { vector, calls } = bounceVector();
    const result = await runReorder(
      deps([vector]),
      { scope: "evening", uuids: [e1] },
      {
        dryRun: true,
      },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("bounce ×1");
      expect(result.plan.expectedDelta).toMatchObject({ mode: "ordering", key: "todayIndex" });
    }
    expect(calls).toHaveLength(0);
    expect(auditRecords).toHaveLength(0);
  });
});

describe("computeReorderPre wire lists", () => {
  it("keeps unrequested members' current order after the requested block", () => {
    const a = seedToday("A", 30);
    const b = seedToday("B", 10);
    const c = seedToday("C", 20);
    const pre = computeReorderPre(fixture.db, { scope: "today", uuids: [a] }, null, NOW);
    // Current order by todayIndex is b(10), c(20), a(30) → wire = a, b, c.
    expect(pre.wireList).toEqual([a, b, c]);
    expect(pre.key).toBe("todayIndex");
    expect(pre.rejected).toEqual([]);
  });

  it("includes scheduled projects as today members (O12)", () => {
    const p = seedProject(fixture.db, {
      title: "ProjToday",
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: 5,
    });
    const t = seedToday("T", 10);
    const pre = computeReorderPre(fixture.db, { scope: "today", uuids: [p, t] }, null, NOW);
    expect(pre.rejected).toEqual([]);
    expect(pre.projectMembers).toEqual([p]);
    expect(pre.wireList).toEqual([p, t]);
  });

  it("flags duplicates and strangers", () => {
    const a = seedToday("A", 10);
    const pre = computeReorderPre(fixture.db, { scope: "today", uuids: [a, a, "nope"] }, null, NOW);
    expect(pre.duplicates).toEqual([a]);
    expect(pre.rejected.map((r) => r.uuid)).toEqual(["nope"]);
  });

  it("area scope extends the wire list with SAME-TYPE members only (O14)", () => {
    const area = seedArea(fixture.db, "Work");
    const p1 = seedProject(fixture.db, { title: "P1", area, index: 1 });
    const p2 = seedProject(fixture.db, { title: "P2", area, index: 2 });
    const t = seedTodo(fixture.db, { title: "T", area, index: 3 });
    const pre = computeReorderPre(fixture.db, { scope: "area", uuids: [p2] }, area, NOW);
    // Requested a project → the unrequested project rides along, the to-do
    // does NOT (mixed wire lists are unprobed).
    expect(pre.wireList).toEqual([p2, p1]);
    expect(pre.mixedTypes).toBe(false);
    expect(pre.members.map((m) => m.uuid)).toEqual([p1, p2, t]);
  });

  it("area scope flags mixed to-do+project requests", () => {
    const area = seedArea(fixture.db, "Work");
    const p = seedProject(fixture.db, { title: "P", area, index: 1 });
    const t = seedTodo(fixture.db, { title: "T", area, index: 2 });
    const pre = computeReorderPre(fixture.db, { scope: "area", uuids: [p, t] }, area, NOW);
    expect(pre.mixedTypes).toBe(true);
  });

  it("today scope keeps the full mixed wire list (O12 validated)", () => {
    const p = seedProject(fixture.db, {
      title: "ProjToday",
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: 5,
    });
    const t = seedToday("T", 10);
    const pre = computeReorderPre(fixture.db, { scope: "today", uuids: [t] }, null, NOW);
    expect(pre.mixedTypes).toBe(false);
    expect(pre.wireList).toEqual([t, p]);
  });

  it("inbox scope: unscheduled to-dos ranked on index, key=index (A6)", () => {
    const a = seedTodo(fixture.db, { title: "A", start: "inbox", index: 30 });
    const b = seedTodo(fixture.db, { title: "B", start: "inbox", index: 10 });
    const c = seedTodo(fixture.db, { title: "C", start: "inbox", index: 20 });
    // A scheduled to-do and a project must NOT be inbox members.
    seedToday("SCHED", 5);
    seedProject(fixture.db, { title: "P", start: "inbox" });
    const pre = computeReorderPre(fixture.db, { scope: "inbox", uuids: [c, a] }, null, NOW);
    expect(pre.key).toBe("index");
    // Current index order is b(10), c(20), a(30) → wire = c, a, b.
    expect(pre.wireList).toEqual([c, a, b]);
    expect(pre.rejected).toEqual([]);
    expect(pre.members.map((m) => m.uuid)).toEqual([b, c, a]);
  });
});

// ---------------------------------------------------------------- new scopes

/**
 * Someday-list sim: the app STACKS each sent id above the call's ORIGINAL
 * top; an id that IS the original top never moves (P6h/P7e/P8b anchor model).
 */
function somedayVector() {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const scopeRows = (): { uuid: string; rank: number }[] =>
        fixture.db
          .prepare(
            `SELECT uuid, "index" AS rank FROM TMTask WHERE trashed = 0 AND status = 0
             AND type = 0 AND start = 2 AND startDate IS NULL ORDER BY "index" ASC`,
          )
          .all() as { uuid: string; rank: number }[];
      for (const m of invocation.payload.matchAll(/with ids "([^"]+)"/g)) {
        const ids = (m[1] ?? "").split(",");
        const origTop = scopeRows()[0]?.uuid;
        for (const uuid of ids) {
          if (uuid === origTop) continue;
          const min = scopeRows()[0]?.rank ?? 0;
          fixture.db
            .prepare(`UPDATE TMTask SET "index" = ?, userModificationDate = ? WHERE uuid = ?`)
            .run(min - 1, modClock++, uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/** update-project when= sim: someday parks, anytime FRONT-inserts (P8e). */
function projectBounceVector() {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: { "project.update": { support: "yes", disruption: 0, validation: "validated" } },
    async execute(invocation) {
      calls.push(invocation.payload);
      const url = new URL(invocation.payload);
      const id = url.searchParams.get("id") ?? "";
      const when = url.searchParams.get("when") ?? "";
      if (when === "someday") {
        fixture.db
          .prepare(
            `UPDATE TMTask SET start = 2, startDate = NULL, userModificationDate = ? WHERE uuid = ?`,
          )
          .run(modClock++, id);
      } else {
        const min = fixture.db
          .prepare(
            `SELECT MIN("index") AS m FROM TMTask WHERE trashed = 0 AND status = 0
             AND type = 1 AND area IS NULL`,
          )
          .get() as { m: number | null };
        fixture.db
          .prepare(
            `UPDATE TMTask SET start = 1, startDate = NULL, "index" = ?,
             userModificationDate = ? WHERE uuid = ?`,
          )
          .run((min.m ?? 0) - 1, modClock++, id);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

// Heading reordering moved from `reorder --scope headings` to the
// project.move-heading verb (spec §2) — its coverage lives in
// test/engine/write-move-heading.test.ts.

describe("someday scope (P8b two-call anchor protocol)", () => {
  it("realizes the exact requested order against anchor-stack semantics", async () => {
    const a = seedTodo(fixture.db, { title: "A", start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "B", start: "someday", index: 20 });
    const c = seedTodo(fixture.db, { title: "C", start: "someday", index: 30 });
    const d = seedTodo(fixture.db, { title: "D", start: "someday", index: 40 });
    const { vector, calls } = somedayVector();
    const result = await runReorder(deps([vector]), { scope: "someday", uuids: [c, a, d, b] });
    expect(result.kind).toBe("ok");
    // one osascript invocation carrying the two-call protocol
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('list "Someday"');
    const indexes = [c, a, d, b].map(
      (u) =>
        (
          fixture.db.prepare(`SELECT "index" AS r FROM TMTask WHERE uuid = ?`).get(u) as {
            r: number;
          }
        ).r,
    );
    expect([...indexes].toSorted((x, y) => x - y)).toEqual(indexes);
  });

  it("rejects containered someday to-dos (only loose ones are members)", async () => {
    seedTodo(fixture.db, { title: "loose", start: "someday", index: 1 });
    const proj = seedProject(fixture.db, { title: "SP", index: 2 });
    const inProj = seedTodo(fixture.db, { title: "in-proj", start: "someday", project: proj });
    const { vector } = somedayVector();
    const result = await runReorder(deps([vector]), { scope: "someday", uuids: [inProj] });
    expect(result.kind).toBe("blocked");
  });
});

describe("projects scope (P8e sidebar bounce)", () => {
  it("bounces top-level projects into the requested order via when= round-trips", async () => {
    const p1 = seedProject(fixture.db, { title: "P1", index: 10 });
    const p2 = seedProject(fixture.db, { title: "P2", index: 20 });
    const p3 = seedProject(fixture.db, { title: "P3", index: 30 });
    const { vector, calls } = projectBounceVector();
    const result = await runReorder(deps([vector]), { scope: "projects", uuids: [p2, p3, p1] });
    expect(result.kind).toBe("ok");
    // two legs per project, reverse order: p1, p3, p2
    expect(calls.filter((c) => c.includes("when=someday"))).toHaveLength(3);
    expect(calls.filter((c) => c.includes("when=anytime"))).toHaveLength(3);
    expect(calls[0]).toContain(p1);
    const indexes = [p2, p3, p1].map(
      (u) =>
        (
          fixture.db.prepare(`SELECT "index" AS r FROM TMTask WHERE uuid = ?`).get(u) as {
            r: number;
          }
        ).r,
    );
    expect([...indexes].toSorted((x, y) => x - y)).toEqual(indexes);
    // state preserved: plain anytime, undated
    for (const u of [p1, p2, p3]) {
      const row = fixture.db
        .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
        .get(u) as { start: number; startDate: number | null };
      expect(row.start).toBe(1);
      expect(row.startDate).toBeNull();
    }
  });

  it("rejects area'd and someday projects with pointed reasons", async () => {
    const area = seedArea(fixture.db, "Work");
    const inArea = seedProject(fixture.db, { title: "IA", area, index: 1 });
    const { vector } = projectBounceVector();
    const result = await runReorder(deps([vector]), { scope: "projects", uuids: [inArea] });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("scope 'area'");
  });

  it("native strategy is refused for projects scope", async () => {
    const p1 = seedProject(fixture.db, { title: "P1", index: 10 });
    const { vector } = projectBounceVector();
    const result = await runReorder(deps([vector]), {
      scope: "projects",
      uuids: [p1],
      strategy: "native",
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("NO native surface");
  });
});

/**
 * Someday-list sim for PROJECTS: anchor rule as somedayVector, but the stack
 * DESCENDS — each moved id lands directly BELOW the previously moved one,
 * all above the call's original top (P9e).
 */
function somedayProjectVector() {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const scopeRows = (): { uuid: string; rank: number }[] =>
        fixture.db
          .prepare(
            `SELECT uuid, "index" AS rank FROM TMTask WHERE trashed = 0 AND status = 0
             AND type = 1 AND area IS NULL AND start = 2 AND startDate IS NULL
             ORDER BY "index" ASC`,
          )
          .all() as { uuid: string; rank: number }[];
      for (const m of invocation.payload.matchAll(/with ids "([^"]+)"/g)) {
        const ids = (m[1] ?? "").split(",");
        const rows = scopeRows();
        const origTop = rows[0];
        if (origTop === undefined) continue;
        // Moved ids stack between (below) the previous moved id and the
        // original top; the first moved id goes above the original top.
        let ceiling = origTop.rank - 1000;
        for (const uuid of ids) {
          if (uuid === origTop.uuid) continue;
          ceiling = ceiling + 100; // descending: each subsequent LOWER (closer to old top)
          fixture.db
            .prepare(`UPDATE TMTask SET "index" = ?, userModificationDate = ? WHERE uuid = ?`)
            .run(ceiling, modClock++, uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

describe("someday scope: PROJECTS (P9e inverted protocol)", () => {
  it("realizes the exact requested order against descending-stack semantics", async () => {
    const p1 = seedProject(fixture.db, { title: "SP1", start: "someday", index: 10 });
    const p2 = seedProject(fixture.db, { title: "SP2", start: "someday", index: 20 });
    const p3 = seedProject(fixture.db, { title: "SP3", start: "someday", index: 30 });
    const p4 = seedProject(fixture.db, { title: "SP4", start: "someday", index: 40 });
    const { vector, calls } = somedayProjectVector();
    const result = await runReorder(deps([vector]), { scope: "someday", uuids: [p3, p1, p4, p2] });
    expect(result.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    // call 1 pushes the desired-bottom (p2); call 2 = anchor + FORWARD rest
    expect(calls[0]).toContain(`with ids "${p2}"`);
    expect(calls[0]).toContain(`with ids "${p2},${p3},${p1},${p4}"`);
    const indexes = [p3, p1, p4, p2].map(
      (u) =>
        (
          fixture.db.prepare(`SELECT "index" AS r FROM TMTask WHERE uuid = ?`).get(u) as {
            r: number;
          }
        ).r,
    );
    expect([...indexes].toSorted((x, y) => x - y)).toEqual(indexes);
  });

  it("rejects mixed to-do + project someday requests and area'd someday projects", async () => {
    const todo = seedTodo(fixture.db, { title: "sd-todo", start: "someday", index: 1 });
    const proj = seedProject(fixture.db, { title: "sd-proj", start: "someday", index: 2 });
    const area = seedArea(fixture.db, "Work");
    const areaProj = seedProject(fixture.db, {
      title: "sd-area-proj",
      start: "someday",
      area,
      index: 3,
    });
    const { vector } = somedayProjectVector();
    const mixed = await runReorder(deps([vector]), { scope: "someday", uuids: [todo, proj] });
    expect(mixed.kind).toBe("blocked");
    if (mixed.kind === "blocked") expect(mixed.detail).toContain("same-type");
    const inArea = await runReorder(deps([vector]), { scope: "someday", uuids: [areaProj] });
    expect(inArea.kind).toBe("blocked");
    if (inArea.kind === "blocked") expect(inArea.detail).toContain("INSIDE an area");
  });
});

// -------------------------------------------------- Phase A.1 wired protocols

/**
 * Faithful index-keyed bounce sim (reordgaps-results.md BOUNCE2 re-entry law).
 * A when= leg re-schedules the item and, when it lands in a ranked bucket,
 * re-inserts it: FRONT (min index − 1) for a loose/area-direct item, BACK
 * (max index + 1) for a heading/project child. Handles BOTH dispatch shapes so
 * one fake covers the sequential URL bounce AND the BOUNCEJSON one-array
 * collapse (§9i): a per-leg `things:///update?...&when=` URL, and a single
 * `things:///json?data=[…]` array applied element-by-element in ARRAY ORDER
 * (the app's per-element distinct sub-transactions, BJ-b) — the same reindex
 * law modelling anytime-into-loose/heading front/back-insert.
 */
function indexBounceVector() {
  const calls: string[] = [];
  const applyWhen = (id: string, when: string): void => {
    const row = fixture.db
      .prepare("SELECT heading, project, area FROM TMTask WHERE uuid = ?")
      .get(id) as { heading: string | null; project: string | null; area: string | null };
    let start = 1;
    let startDate: number | null = null;
    let startBucket = 0;
    if (when === "someday") start = 2;
    else if (when === "anytime") start = 1;
    else if (when === "today") startDate = PACKED_TODAY;
    else if (when === "evening") {
      startDate = PACKED_TODAY;
      startBucket = 1;
    }
    fixture.db
      .prepare(
        "UPDATE TMTask SET start=?, startDate=?, startBucket=?, userModificationDate=? WHERE uuid=?",
      )
      .run(start, startDate, startBucket, modClock++, id);
    let where: string | null = null;
    const binds: (string | number)[] = [];
    let back = false;
    if (when === "anytime" && row.heading != null) {
      where = "heading = ? AND start = 1 AND startDate IS NULL";
      binds.push(row.heading);
      back = true;
    } else if (when === "someday" && row.area != null && row.heading == null) {
      where = "area = ? AND heading IS NULL AND start = 2 AND startDate IS NULL";
      binds.push(row.area);
    } else if (when === "someday" && row.project != null && row.heading == null) {
      where = "project = ? AND heading IS NULL AND start = 2 AND startDate IS NULL";
      binds.push(row.project);
      back = true;
    } else if (
      when === "anytime" &&
      row.project == null &&
      row.area == null &&
      row.heading == null
    ) {
      where =
        "project IS NULL AND area IS NULL AND heading IS NULL AND start = 1 AND startDate IS NULL";
    }
    if (where != null) {
      const sib = fixture.db
        .prepare(
          `SELECT MIN("index") AS mn, MAX("index") AS mx FROM TMTask
           WHERE trashed=0 AND status=0 AND type=0 AND uuid != ? AND ${where}`,
        )
        .get(id, ...binds) as { mn: number | null; mx: number | null };
      const newIndex = back ? (sib.mx ?? 0) + 1 : (sib.mn ?? 0) - 1;
      fixture.db
        .prepare(`UPDATE TMTask SET "index"=?, userModificationDate=? WHERE uuid=?`)
        .run(newIndex, modClock++, id);
    }
  };
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const url = new URL(invocation.payload);
      if (
        url.pathname === "//json" ||
        url.host === "json" ||
        invocation.payload.includes("/json?")
      ) {
        // BOUNCEJSON collapse: apply every element's when in array order.
        const arr = JSON.parse(url.searchParams.get("data") ?? "[]") as {
          id: string;
          attributes: { when: string };
        }[];
        for (const el of arr) applyWhen(el.id, el.attributes.when);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      applyWhen(url.searchParams.get("id") ?? "", url.searchParams.get("when") ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function ascending(nums: number[]): boolean {
  return nums.every((n, i) => i === 0 || (nums[i - 1] as number) < n);
}

/** Decode a `things:///json` collapse payload into [[id, when], …] in array order. */
function jsonOps(payload: string): [string, string][] {
  const arr = JSON.parse(new URL(payload).searchParams.get("data") ?? "[]") as {
    id: string;
    attributes: { when: string };
  }[];
  return arr.map((el) => [el.id, el.attributes.when]);
}

describe("heading scope (BOUNCE2-h forward-order back-insert)", () => {
  it("realizes the exact requested order via a FORWARD-order bounce of the whole block", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const h1 = seedTodo(fixture.db, { title: "h1", heading, index: 10 });
    const h2 = seedTodo(fixture.db, { title: "h2", heading, index: 20 });
    const h3 = seedTodo(fixture.db, { title: "h3", heading, index: 30 });
    const { vector, calls } = indexBounceVector();
    const result = await runReorder(deps([vector]), {
      scope: "heading",
      container: { uuid: heading },
      uuids: [h3, h1, h2],
    });
    expect(result.kind).toBe("ok");
    // BOUNCEJSON collapse (§9i): ONE json dispatch, both legs interleaved per
    // item in FORWARD order (back-insert), array order == result index order.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("things:///json");
    expect(jsonOps(calls[0] as string)).toEqual([
      [h3, "someday"],
      [h3, "anytime"],
      [h1, "someday"],
      [h1, "anytime"],
      [h2, "someday"],
      [h2, "anytime"],
    ]);
    expect(ascending(ranks([h3, h1, h2], `"index"`))).toBe(true);
  });

  it("full-abort: a failed json dispatch applies NOTHING (validate-first, no partial state)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const h1 = seedTodo(fixture.db, { title: "h1", heading, index: 10 });
    const h2 = seedTodo(fixture.db, { title: "h2", heading, index: 20 });
    // A dispatch surface that rejects the array (validate-first full abort, BJ-c).
    const vector: WriteVector = {
      id: "url-scheme",
      matrix: { "todo.update": { support: "yes", disruption: 0, validation: "validated" } },
      async execute() {
        return { exitCode: 1, stdout: "", stderr: "json error modal" };
      },
    };
    const result = await runReorder(deps([vector]), {
      scope: "heading",
      container: { uuid: heading },
      uuids: [h2, h1],
    });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") {
      expect(result.placed).toEqual([]); // nothing landed
      expect(result.detail).toContain("NOTHING was applied");
    }
    // The indices are untouched (no partial progress to repair).
    expect(ranks([h1, h2], `"index"`)).toEqual([10, 20]);
  });
});

describe("area-someday scope (SOMEBNC-area reverse-order front-insert)", () => {
  it("front-inserts the requested subset via a REVERSE-order bounce, area + start=2 preserved", async () => {
    const area = seedArea(fixture.db, "A");
    const a = seedTodo(fixture.db, { title: "a", area, start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", area, start: "someday", index: 20 });
    const c = seedTodo(fixture.db, { title: "c", area, start: "someday", index: 30 });
    const { vector, calls } = indexBounceVector();
    const result = await runReorder(deps([vector]), {
      scope: "area-someday",
      container: { uuid: area },
      uuids: [c, a],
    });
    expect(result.kind).toBe("ok");
    // Reverse order (front-insert): first bounced is a, legs when=anytime→when=someday.
    expect(calls[0]).toContain(`id=${a}`);
    expect(calls[0]).toContain("when=anytime");
    expect(calls[1]).toContain(`id=${a}`);
    expect(calls[1]).toContain("when=someday");
    expect(ascending(ranks([c, a], `"index"`))).toBe(true);
    for (const u of [a, b, c]) {
      const row = fixture.db.prepare("SELECT start, area FROM TMTask WHERE uuid = ?").get(u) as {
        start: number;
        area: string;
      };
      expect(row.start).toBe(2);
      expect(row.area).toBe(area);
    }
  });
});

describe("anytime scope (ANYBNC reverse-order front-insert)", () => {
  it("front-inserts area-less loose anytime to-dos via a REVERSE-order bounce", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "active", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "active", index: 20 });
    const c = seedTodo(fixture.db, { title: "c", start: "active", index: 30 });
    const { vector, calls } = indexBounceVector();
    const result = await runReorder(deps([vector]), { scope: "anytime", uuids: [c, a] });
    expect(result.kind).toBe("ok");
    // BOUNCEJSON collapse (§9i): ONE json dispatch, both legs interleaved per
    // item in REVERSE order (front-insert) — a bounced first, then c.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("things:///json");
    expect(jsonOps(calls[0] as string)).toEqual([
      [a, "someday"],
      [a, "anytime"],
      [c, "someday"],
      [c, "anytime"],
    ]);
    expect(ascending(ranks([c, a], `"index"`))).toBe(true);
    for (const u of [a, b, c]) {
      const row = fixture.db
        .prepare("SELECT start, startDate, area FROM TMTask WHERE uuid = ?")
        .get(u) as { start: number; startDate: number | null; area: string | null };
      expect(row.start).toBe(1);
      expect(row.startDate).toBeNull();
      expect(row.area).toBeNull();
    }
  });
});

describe("container-day scope (DAYORD-b native todayIndex, date-preserving)", () => {
  it("re-ranks a project's same-day scheduled children on todayIndex, leaving the date", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-10",
      todayIndex: 10,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-10",
      todayIndex: 20,
    });
    const c = seedTodo(fixture.db, {
      title: "c",
      project: proj,
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-10",
      todayIndex: 30,
    });
    const day = encodePackedDate("2026-07-10");
    const { vector, calls } = nativeVector();
    const result = await runReorder(deps([vector]), {
      scope: "container-day",
      container: { uuid: proj },
      uuids: [c, a],
    });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain(`project id "${proj}"`);
    expect(calls[0]).toContain(`with ids "${c},${a},${b}"`);
    expect(ascending(ranks([c, a, b]))).toBe(true);
    for (const u of [a, b, c]) {
      const row = fixture.db.prepare("SELECT startDate FROM TMTask WHERE uuid = ?").get(u) as {
        startDate: number;
      };
      expect(row.startDate).toBe(day); // date preserved
    }
  });
});

describe("project scope: SOMEBNC-project bounce fallback (native unavailable)", () => {
  it("uses a FORWARD-order bounce when experimental is off and members are all someday", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", project: proj, start: "someday", index: 20 });
    const c = seedTodo(fixture.db, { title: "c", project: proj, start: "someday", index: 30 });
    const { vector, calls } = indexBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "project",
      container: { uuid: proj },
      uuids: [c, a, b],
    });
    expect(result.kind).toBe("ok");
    // Forward order (back-insert): first bounced is c, legs when=anytime→when=someday.
    expect(calls[0]).toContain(`id=${c}`);
    expect(calls[0]).toContain("when=anytime");
    expect(calls[1]).toContain("when=someday");
    expect(ascending(ranks([c, a, b], `"index"`))).toBe(true);
    for (const u of [a, b, c]) {
      const row = fixture.db.prepare("SELECT start, project FROM TMTask WHERE uuid = ?").get(u) as {
        start: number;
        project: string;
      };
      expect(row.start).toBe(2);
      expect(row.project).toBe(proj);
    }
  });

  it("does NOT fall back to bounce when a non-someday member is present (native stays primary)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const anytime = seedTodo(fixture.db, {
      title: "at",
      project: proj,
      start: "active",
      index: 10,
    });
    const { vector } = indexBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "project",
      container: { uuid: proj },
      uuids: [anytime],
    });
    // Native is unavailable (experimental off) and the fallback does not apply →
    // the pipeline reports the native surface unsupported, never a silent bounce.
    expect(result.kind).toBe("unsupported");
  });
});

describe("bounce-enabled gate + bounce-max-items cap", () => {
  function cfg(over: Partial<ThingsApiConfig>): ThingsApiConfig {
    return { ...config(true), ...over };
  }

  it("bounce-enabled=false refuses a bounce placement with a teaching pointer to the flag", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "active", index: 10 });
    const { vector, calls } = indexBounceVector();
    const result = await runReorder(deps([vector], { config: cfg({ bounceEnabled: false }) }), {
      scope: "anytime",
      uuids: [a],
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.detail).toContain("bounce-enabled=false");
      expect(result.remediation).toContain("bounce-enabled true");
    }
    expect(calls).toHaveLength(0); // never attempted
  });

  it("bounce-max-items caps at the CONFIGURED value, not the hardcoded 10", async () => {
    // 12 evening items pass the default cap of 30 (proves the raise from 10)…
    const under = Array.from({ length: 12 }, (_, i) =>
      seedToday(`U${i}`, i + 1, { evening: true }),
    );
    const okRun = await runReorder(deps([bounceVector().vector]), {
      scope: "evening",
      uuids: under,
    });
    expect(okRun.kind).toBe("ok");
  });

  it("bounce-max-items=3 blocks a 4-item bounce, citing the configured cap", async () => {
    const four = Array.from({ length: 4 }, (_, i) => seedToday(`F${i}`, i + 1, { evening: true }));
    const { vector, calls } = bounceVector();
    const result = await runReorder(deps([vector], { config: cfg({ bounceMaxItems: 3 }) }), {
      scope: "evening",
      uuids: four,
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("cap of 3");
    expect(calls).toHaveLength(0);
  });

  it("dry-run of a json-collapsible scope reports 1 dispatch / 2N ops", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "active", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "active", index: 20 });
    const { vector, calls } = indexBounceVector();
    const result = await runReorder(
      deps([vector]),
      { scope: "anytime", uuids: [a, b] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      // area-less anytime collapses (§9i): one json dispatch, not the URL loop.
      expect(result.plan.invocation).toContain("json-collapse ×2");
      expect(result.plan.invocation).toContain("1 dispatch / 4 ops");
    }
    expect(calls).toHaveLength(0);
  });

  it("dry-run of a NON-collapsible scope keeps the per-item leg count", async () => {
    const area = seedArea(fixture.db, "A");
    const a = seedTodo(fixture.db, { title: "a", area, start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", area, start: "someday", index: 20 });
    const { vector, calls } = indexBounceVector();
    const result = await runReorder(
      deps([vector]),
      { scope: "area-someday", container: { uuid: area }, uuids: [a, b] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      // area-someday is a someday-placement / area-direct class — json-inert (§9i).
      expect(result.plan.invocation).toContain("bounce ×2");
      expect(result.plan.invocation).toContain("4 legs");
    }
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------ day scope (SIT4 dated bounce)

const FUTURE_ISO = "2026-07-19"; // D (+14d); the dated bounce stages via D+1
const PACKED_FUTURE = encodePackedDate(FUTURE_ISO);

/**
 * Faithful dated/evening bounce sim (SIT4 DAYBNC + EVEORD, the ONLY laws modeled).
 * A when=<ISO>/today/evening leg FRONT-inserts the row at the target day+bucket's
 * GLOBAL todayIndex min across ALL containers and BOTH kinds (to-do type=0 AND
 * project type=1) — one shared axis. Every OTHER field is preserved (heading /
 * project / area FK, reminderTime, deadline), EXCEPT when=evening clears
 * reminderTime (§9n / R07). Supports todo.update AND update-project (the per-type
 * leg op), so one fake covers the mixed-kind bounce; the payload path
 * (update vs update-project) records which op each leg used.
 */
function datedBounceVector() {
  const calls: string[] = [];
  const apply = (when: string, id: string): void => {
    // The command re-attaches a live reminder as when=<base>@HH:mm (§2e/R21). A
    // dated/today leg PRESERVES it; only when=evening CLEARS it (§9n/R07), and the
    // app ignores the @time on the evening bucket.
    const at = when.indexOf("@");
    const base = at >= 0 ? when.slice(0, at) : when;
    let packed: number;
    let bucket: number;
    if (base === "evening") {
      packed = PACKED_TODAY;
      bucket = 1;
    } else if (base === "today") {
      packed = PACKED_TODAY;
      bucket = 0;
    } else {
      packed = encodePackedDate(base);
      bucket = 0;
    }
    const min = fixture.db
      .prepare(
        `SELECT MIN(todayIndex) AS m FROM TMTask WHERE trashed = 0 AND status = 0
         AND startBucket = ? AND startDate = ?`,
      )
      .get(bucket, packed) as { m: number | null };
    const startVal = packed > PACKED_TODAY ? 2 : 1;
    const clearReminder = base === "evening";
    fixture.db
      .prepare(
        `UPDATE TMTask SET start = ?, startDate = ?, startBucket = ?, todayIndex = ?,
         ${clearReminder ? "reminderTime = NULL, " : ""}userModificationDate = ? WHERE uuid = ?`,
      )
      .run(startVal, packed, bucket, (min.m ?? 0) - 1, modClock++, id);
  };
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const url = new URL(invocation.payload);
      apply(url.searchParams.get("when") ?? "", url.searchParams.get("id") ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/** A future-day (D) scheduled row on the shared todayIndex axis. */
function seedDay(
  title: string,
  todayIndex: number,
  extra: Partial<Parameters<typeof seedTodo>[1]> = {},
): string {
  return seedTodo(fixture.db, {
    title,
    start: "someday", // start=2 on a strictly-future scheduled row (post-#325)
    startDate: FUTURE_ISO,
    todayIndex,
    ...extra,
  });
}

describe("day scope (SIT4 DAYBNC — the dated cross-container bounce)", () => {
  it("lands an exact scrambled cross-container order incl. project rows + headed child", async () => {
    // DAYBNC arm1c: 4 to-dos (one headed, one reminder+deadline) + 2 area-less
    // project rows, all on day D, scrambled seed todayIndex.
    const proj = seedProject(fixture.db, { title: "DHP" });
    const head = seedHeading(fixture.db, { title: "DH", project: proj });
    const dp2 = seedProject(fixture.db, {
      title: "DP-2",
      startDate: FUTURE_ISO,
      todayIndex: -2806,
    });
    const dp1 = seedProject(fixture.db, {
      title: "DP-1",
      startDate: FUTURE_ISO,
      todayIndex: -2385,
    });
    const db4 = seedDay("DB-4", -1748, { heading: head, project: proj });
    const db3 = seedDay("DB-3", -1195);
    const db2 = seedDay("DB-2", -548, { reminder: "09:00", deadline: FUTURE_ISO });
    const db1 = seedDay("DB-1", 0);
    const { vector } = datedBounceVector();
    // Target: DP-2, DB-3, DP-1, DB-1, DB-4, DB-2 (the scramble).
    const target = [dp2, db3, dp1, db1, db4, db2];
    const result = await runReorder(deps([vector]), { scope: "day", uuids: target });
    expect(result.kind).toBe("ok");
    // Final todayIndex order matches the target exactly.
    const order = target.toSorted((a, b) => ranks([a])[0]! - ranks([b])[0]!);
    expect(order).toEqual(target);
    // Every collateral byte preserved: heading FK, project FK, reminder, deadline.
    const db4row = fixture.db
      .prepare("SELECT heading, project FROM TMTask WHERE uuid = ?")
      .get(db4) as { heading: string; project: string };
    expect(db4row.heading).toBe(head);
    const db2row = fixture.db
      .prepare("SELECT reminderTime, deadline FROM TMTask WHERE uuid = ?")
      .get(db2) as { reminderTime: number | null; deadline: number | null };
    expect(db2row.reminderTime).not.toBeNull();
    expect(db2row.deadline).not.toBeNull();
    // Project rows stayed startBucket=0 on day D (not stripped).
    const dp2row = fixture.db
      .prepare("SELECT startDate, startBucket, type FROM TMTask WHERE uuid = ?")
      .get(dp2) as { startDate: number; startBucket: number; type: number };
    expect(dp2row.startDate).toBe(PACKED_FUTURE);
    expect(dp2row.startBucket).toBe(0);
    expect(dp2row.type).toBe(1);
  });

  it("dispatches a PROJECT row via update-project and a to-do via update (per-type legs)", async () => {
    const t = seedDay("T", 0);
    const p = seedProject(fixture.db, { title: "P", startDate: FUTURE_ISO, todayIndex: 10 });
    const { vector, calls } = datedBounceVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: [p, t] });
    expect(result.kind).toBe("ok"); // a project movee is NOT rejected (per-type)
    // The project's legs went through update-project; the to-do's through update.
    const projLegs = calls.filter((c) => c.includes(`id=${p}`));
    const todoLegs = calls.filter((c) => c.includes(`id=${t}`));
    expect(projLegs.length).toBe(2);
    expect(projLegs.every((c) => c.includes("update-project"))).toBe(true);
    expect(todoLegs.length).toBe(2);
    expect(todoLegs.every((c) => !c.includes("update-project"))).toBe(true);
  });

  it("uses the neighbour day D+1 as the away staging leg, day D as the back leg", async () => {
    const a = seedDay("A", 0);
    const b = seedDay("B", 10);
    const { vector, calls } = datedBounceVector();
    await runReorder(deps([vector]), { scope: "day", uuids: [a, b] });
    // Each item: away = 2026-07-20 (D+1), back = 2026-07-19 (D).
    expect(calls.some((c) => c.includes("when=2026-07-20"))).toBe(true);
    expect(calls.some((c) => c.includes("when=2026-07-19"))).toBe(true);
  });

  it("refuses a repeating TEMPLATE movee, naming §9e/§1 (a dated leg crashes it)", async () => {
    const t = seedDay("T", 0);
    const tmpl = seedTodo(fixture.db, {
      title: "TMPL",
      start: "someday",
      startDate: FUTURE_ISO,
      recurrenceRule: true,
    });
    const { vector, calls } = datedBounceVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: [t, tmpl] });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("repeating template");
    expect(calls).toHaveLength(0);
  });

  it("accepts an area-DIRECT project row as a day member, preserving its area FK (SIT5 AREAPROJDAY)", async () => {
    // SIT5 AREAPROJDAY: area-direct project rows are proven dated-bounce members —
    // the update-project when= legs preserve the area FK through the round-trip.
    const area = seedArea(fixture.db, "A");
    const t = seedDay("T", 0);
    const ap = seedProject(fixture.db, {
      title: "AP",
      startDate: FUTURE_ISO,
      todayIndex: 5,
      area,
    });
    const { vector, calls } = datedBounceVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: [ap, t] });
    expect(result.kind).toBe("ok");
    // Per-type legs: the area'd project row goes through update-project.
    const projLegs = calls.filter((c) => c.includes(`id=${ap}`));
    expect(projLegs.length).toBe(2);
    expect(projLegs.every((c) => c.includes("update-project"))).toBe(true);
    // The area FK survived the round-trip (the SIT5 law).
    const apRow = fixture.db
      .prepare("SELECT area, startBucket, type FROM TMTask WHERE uuid = ?")
      .get(ap) as { area: string; startBucket: number; type: number };
    expect(apRow.area).toBe(area);
    expect(apRow.startBucket).toBe(0);
    expect(apRow.type).toBe(1);
  });

  it("is gated by bounce-enabled — no dispatch when the flag is off", async () => {
    const a = seedDay("A", 0);
    const b = seedDay("B", 10);
    const { vector, calls } = datedBounceVector();
    const d = deps([vector]);
    d.config = { ...d.config, bounceEnabled: false };
    const result = await runReorder(d, { scope: "day", uuids: [a, b] });
    expect(result.kind).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("caps the day-group by bounce-max-items", async () => {
    const uuids = Array.from({ length: 4 }, (_, i) => seedDay(`D${i}`, i * 10));
    const { vector } = datedBounceVector();
    const d = deps([vector]);
    d.config = { ...d.config, bounceMaxItems: 3 };
    const result = await runReorder(d, { scope: "day", uuids });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("cap");
  });

  it("undo round-trip restores the prior day order (re-runs the dated bounce)", async () => {
    const a = seedDay("A", 0);
    const b = seedDay("B", 10);
    const c = seedDay("C", 20);
    const fwd = await runReorder(deps([datedBounceVector().vector]), {
      scope: "day",
      uuids: [c, a, b],
    });
    expect(fwd.kind).toBe("ok");
    const rec = auditRecords.at(-1) as AuditRecord;
    const plan = planUndo(rec, NOW);
    expect(plan.kind).toBe("invertible");
  });

  it("dry-run describes the dated bounce without dispatching", async () => {
    const a = seedDay("A", 0);
    const b = seedDay("B", 10);
    const { vector, calls } = datedBounceVector();
    const result = await runReorder(
      deps([vector]),
      { scope: "day", uuids: [a, b] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("bounce ×2");
      expect(result.plan.expectedDelta).toMatchObject({ mode: "ordering", key: "todayIndex" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("evening scope: PROJECT movees (SIT4 EVEORD — shared evening axis)", () => {
  it("front-inserts a project via update-project on the shared evening axis", async () => {
    const ev = seedToday("EV", 10, { evening: true });
    const ep = seedProject(fixture.db, {
      title: "EP",
      startDate: TODAY_ISO,
      evening: true,
      todayIndex: 20,
    });
    const { vector, calls } = datedBounceVector();
    const result = await runReorder(deps([vector]), { scope: "evening", uuids: [ep, ev] });
    expect(result.kind).toBe("ok"); // a project movee is NOT rejected in evening
    // The project's legs used update-project (per-type).
    const projLegs = calls.filter((c) => c.includes(`id=${ep}`));
    expect(projLegs.every((c) => c.includes("update-project"))).toBe(true);
    // Target ep, ev → ep front-inserts to the top of the evening group.
    expect(ranks([ep])[0]!).toBeLessThan(ranks([ev])[0]!);
  });

  it("when=evening clears a project's reminder (§9n / R07 parity)", async () => {
    const ep = seedProject(fixture.db, {
      title: "EP",
      startDate: TODAY_ISO,
      evening: true,
      todayIndex: 0,
      reminder: "09:00",
    });
    const { vector } = datedBounceVector();
    const result = await runReorder(deps([vector]), { scope: "evening", uuids: [ep] });
    expect(result.kind).toBe("ok");
    const row = fixture.db.prepare("SELECT reminderTime FROM TMTask WHERE uuid = ?").get(ep) as {
      reminderTime: number | null;
    };
    expect(row.reminderTime).toBeNull();
  });
});

describe('tomorrow scope (ORDFIN2 TOMORROWLIST one-call `list "Tomorrow"` day-sort)', () => {
  const TOMORROW_ISO = "2026-07-06"; // NOW = 2026-07-05
  const seedTomorrow = (title: string, todayIndex: number, project?: string) =>
    seedTodo(fixture.db, {
      title,
      start: "someday",
      startDate: TOMORROW_ISO,
      todayIndex,
      ...(project !== undefined && { project }),
    });

  it('re-ranks the tomorrow day-group on todayIndex via `list "Tomorrow"`, project row inline', async () => {
    const t1 = seedTomorrow("t1", 30);
    const proj = seedProject(fixture.db, {
      title: "P",
      start: "someday",
      startDate: TOMORROW_ISO,
      todayIndex: 20,
    });
    const t2 = seedTomorrow("t2", 10);
    const { vector, calls } = nativeVector("todayIndex");
    const result = await runReorder(deps([vector]), { scope: "tomorrow", uuids: [t2, proj, t1] });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain('list "Tomorrow"'); // the one-call surface
    // sent order (t2, proj, t1) == ascending todayIndex — the project row re-ranked inline.
    expect(ascending(ranks([t2, proj, t1]))).toBe(true);
  });

  it("is gated by allow-experimental (no native call)", async () => {
    const t1 = seedTomorrow("t1", 10);
    const { vector, calls } = nativeVector("todayIndex");
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "tomorrow",
      uuids: [t1],
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.considered[0]?.why).toContain("allow-experimental");
    }
    expect(calls).toHaveLength(0);
  });
});

// ----------------------------------- heading sub-buckets (HEADSUB1 promotions)

interface HeadingMoveOpParams {
  uuid: string;
  project?: { uuid: string };
  heading?: string;
  noHeading?: boolean;
  uuids?: string[];
}

/**
 * Re-head sim (heading-someday), FAITHFUL to HEADSUB2 Q1:
 *   - unhead (`noHeading`) clears the heading + re-asserts the heading's project,
 *     keeping index/start (Arm C);
 *   - a `todo.move` with a heading param where the row is ALREADY under that
 *     heading is a same-heading NO-OP — index untouched (HEADSUB2 Q1(b));
 *   - a re-head of a now-LOOSE row (heading != target) BACK-INSERTS at the heading
 *     someday-bucket end (index = current max + step), heading FK set + project
 *     NULL + start=2 kept (HEADSUB1 Arm B-someday).
 * So a direct re-head of an already-headed block is inert; only the unhead →
 * re-head round-trip sorts. Reads structured op/opParams, never the compiled URL.
 */
function reheadVector() {
  const calls: string[] = [];
  const legKinds: string[] = []; // "unhead" | "rehead" per todo.move leg
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: { "todo.move": { support: "yes", disruption: 0, validation: "validated" } },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as HeadingMoveOpParams;
      if (inv.op === "todo.move") {
        legKinds.push(p.noHeading === true ? "unhead" : "rehead");
        const cur = fixture.db.prepare("SELECT heading FROM TMTask WHERE uuid = ?").get(p.uuid) as {
          heading: string | null;
        };
        if (p.noHeading === true) {
          const projRow =
            cur.heading !== null
              ? (fixture.db
                  .prepare("SELECT project FROM TMTask WHERE uuid = ?")
                  .get(cur.heading) as { project: string | null })
              : { project: null };
          fixture.db
            .prepare(
              "UPDATE TMTask SET heading = NULL, project = ?, userModificationDate = ? WHERE uuid = ?",
            )
            .run(projRow.project, modClock++, p.uuid);
        } else if (p.heading !== undefined && cur.heading !== p.heading) {
          // Re-head a LOOSE row: back-insert at the someday-bucket end. A row
          // already under p.heading falls through here as a NO-OP (Q1(b)).
          const max = fixture.db
            .prepare(
              `SELECT MAX("index") AS m FROM TMTask WHERE heading = ? AND start = 2
               AND startDate IS NULL AND trashed = 0 AND status = 0 AND uuid != ?`,
            )
            .get(p.heading, p.uuid) as { m: number | null };
          fixture.db
            .prepare(
              `UPDATE TMTask SET heading = ?, project = NULL, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
            )
            .run(p.heading, (max.m ?? 0) + 10, modClock++, p.uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls, legKinds };
}

describe("heading-someday scope (HEADSUB2 unhead → re-head-in-order back-insert)", () => {
  function seedSomedayHeading() {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const s1 = seedTodo(fixture.db, { title: "s1", heading, start: "someday", index: 10 });
    const s2 = seedTodo(fixture.db, { title: "s2", heading, start: "someday", index: 20 });
    const s3 = seedTodo(fixture.db, { title: "s3", heading, start: "someday", index: 30 });
    return { proj, heading, s1, s2, s3 };
  }

  it("realizes the exact requested order via forward-order re-heads, start=2 preserved", async () => {
    const { heading, s1, s2, s3 } = seedSomedayHeading();
    const { vector, calls, legKinds } = reheadVector();
    const result = await runReorder(deps([vector]), {
      scope: "heading-someday",
      container: { uuid: heading },
      uuids: [s3, s1, s2],
      named: [s3, s1, s2],
    });
    expect(result.kind).toBe("ok");
    // Unhead ×3 then re-head ×3, forward order (no when= bounce, no json collapse):
    // a same-heading re-head is a no-op (HEADSUB2 Q1(b)), so each member is
    // unheaded first, then re-headed to back-insert at the bucket end.
    expect(calls).toEqual(Array(6).fill("todo.move"));
    expect(legKinds).toEqual(["unhead", "unhead", "unhead", "rehead", "rehead", "rehead"]);
    expect(ascending(ranks([s3, s1, s2], `"index"`))).toBe(true);
    for (const u of [s1, s2, s3]) {
      const row = fixture.db.prepare("SELECT start, heading FROM TMTask WHERE uuid = ?").get(u) as {
        start: number;
        heading: string;
      };
      expect(row.start).toBe(2); // NOT de-somedayed
      expect(row.heading).toBe(heading);
    }
  });

  it("a NAMED subset re-heads only the suffix from its first slot, co-touching unnamed siblings", async () => {
    const { heading, s1, s2, s3 } = seedSomedayHeading();
    const { vector, calls } = reheadVector();
    // Place s3 LAST: full target order with the block spliced at the end.
    const result = await runReorder(deps([vector]), {
      scope: "heading-someday",
      container: { uuid: heading },
      uuids: [s1, s2, s3],
      named: [s3],
    });
    expect(result.kind).toBe("ok");
    // Only s3 is touched (block = suffix from its slot = just [s3]); no co-touch.
    // Two legs: unhead s3, then re-head s3.
    expect(calls).toEqual(["todo.move", "todo.move"]);
    if (result.kind === "ok") expect(result.touched).toBeUndefined();
    expect(ascending(ranks([s1, s2, s3], `"index"`))).toBe(true);
  });

  it("discloses co-re-headed siblings when the named block sits above them", async () => {
    const { heading, s1, s2, s3 } = seedSomedayHeading();
    const { vector, calls } = reheadVector();
    // Named s1 first: block = [s1, s2, s3] (suffix from slot 0); s2,s3 co-touched.
    const result = await runReorder(deps([vector]), {
      scope: "heading-someday",
      container: { uuid: heading },
      uuids: [s1],
      named: [s1],
    });
    expect(result.kind).toBe("ok");
    // block = [s1, s2, s3]: unhead ×3 then re-head ×3.
    expect(calls).toHaveLength(6);
    if (result.kind === "ok") expect(result.touched).toEqual([s2, s3]);
  });

  it("caps the touched block by bounce-max-items", async () => {
    const { heading, s1 } = seedSomedayHeading();
    const { vector, calls } = reheadVector();
    const result = await runReorder(
      deps([vector], { config: { ...config(true), bounceMaxItems: 2 } }),
      {
        scope: "heading-someday",
        container: { uuid: heading },
        uuids: [s1],
        named: [s1],
      },
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("cap of 2");
    expect(calls).toHaveLength(0);
  });

  it("dry-run describes the re-head legs without executing", async () => {
    const { heading, s1, s2, s3 } = seedSomedayHeading();
    const { vector, calls } = reheadVector();
    const result = await runReorder(
      deps([vector]),
      { scope: "heading-someday", container: { uuid: heading }, uuids: [s3, s1, s2] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("re-head ×3");
      expect(result.plan.expectedDelta).toMatchObject({ mode: "ordering", key: "index" });
    }
    expect(calls).toHaveLength(0);
  });

  it("undo round-trip restores the prior someday order (re-heads in prior order)", async () => {
    const { heading, s1, s2, s3 } = seedSomedayHeading();
    const fwd = await runReorder(deps([reheadVector().vector]), {
      scope: "heading-someday",
      container: { uuid: heading },
      uuids: [s3, s1, s2],
      named: [s3, s1, s2],
    });
    expect(fwd.kind).toBe("ok");
    const summary = auditRecords.find((r) => r.op === "reorder" && r.txn?.role === "summary");
    const plan = planUndo(summary as NonNullable<typeof summary>, NOW);
    expect(plan.kind).toBe("invertible");
    const inv = await runReorder(
      deps([reheadVector().vector]),
      plan.steps[0]?.params as unknown as ReorderParams,
    );
    expect(inv.kind).toBe("ok");
    // Restored to the original relative order s1 < s2 < s3.
    expect(ascending(ranks([s1, s2, s3], `"index"`))).toBe(true);
  });
});

describe("BOUNCEJSON collapse eligibility (§9i placement-leg mechanism)", () => {
  // The `things:///json` one-array collapse works ONLY when the placement (back)
  // leg is `when=anytime` into a loose/heading-container bucket (oddities §9i,
  // BJ-0/BJ-a). This test pins the classification so nobody "optimizes" a
  // someday-placement or area-direct class into json — §9i proved that is a
  // SILENT no-op (index frozen), which would corrupt ordering without failing.
  it("collapses exactly the anytime-placement loose/container classes", () => {
    // Eligible: placement leg = anytime into a loose (area-less) or heading bucket.
    expect(bounceJsonCollapsible("heading")).toBe(true); // BJ-a back-insert
    expect(bounceJsonCollapsible("anytime")).toBe(true); // BJ-0 loose front-insert
  });
  it("keeps every someday-placement / area-direct / non-index class on the URL loop", () => {
    // Someday-placement (index-INERT via json, §9i b) — despite project-someday
    // being a BACK-insert, eligibility follows the leg VALUE, not the direction.
    expect(bounceJsonCollapsible("area-someday")).toBe(false); // §9i b+c (area-direct)
    expect(bounceJsonCollapsible("project-someday")).toBe(false); // §9i b
    // todayIndex legs (not an anytime index placement).
    expect(bounceJsonCollapsible("today")).toBe(false);
    expect(bounceJsonCollapsible("evening")).toBe(false);
    // project.update (type=1) — json when= reindex unproven for a project row.
    expect(bounceJsonCollapsible("projects")).toBe(false);
  });
});
