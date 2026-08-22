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
import { ruleXml } from "../../src/write/recurrence-rule-blob.ts";
import { planUndo } from "../../src/write/undo.ts";
import type { ReorderParams } from "../../src/write/operations.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const TODAY_ISO = "2026-07-05";
const PACKED_TODAY = encodePackedDate(TODAY_ISO);

/**
 * The two LIVE database shapes a repeating template can carry — the placement
 * laws must read the SAME projection day out of both (DBV27):
 *
 *  - `cached`: Things ≤ 3.22 keeps `rt1_nextInstanceStartDate` on every live
 *    template (the shape every TMPLSORT/PTMPL probe was taken under);
 *  - `derived`: Things 3.23 RETIRED that column (the dbv-27 migration nulled it
 *    library-wide) and maintains only the `rt1_instanceCreationStartDate` spawn
 *    cursor, so the projection day comes from the decoded rule + that cursor.
 */
const TEMPLATE_SHAPES = [
  { shape: "cached (Things ≤3.22)", derived: false },
  { shape: "derived (Things 3.23 — cache retired)", derived: true },
] as const;

/**
 * A plain fixed DAILY rule: every calendar day is an occurrence, so the
 * projection day derived from a cursor is the cursor's own day.
 */
const DAILY_RULE_XML = ruleXml({ tp: 0, fu: 16, fa: 1, anchor: 1_783_000_000 });

/** Template columns for a projection on `iso`, in either live DB shape. */
function templateCols(iso: string, derived: boolean) {
  return derived
    ? { recurrenceRuleXml: DAILY_RULE_XML, instanceCreationStartDate: iso }
    : { recurrenceRule: true, nextInstanceStartDate: iso };
}

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
    certifiedAppVersion: null,
    allowExperimental,
    bounceEnabled: true,
    bounceMaxItems: 30,
    autoLaunch: true,
    helpersEnabled: false,
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

function seedToday(
  title: string,
  todayIndex: number,
  opts: { evening?: boolean; startDate?: string; cohort?: string } = {},
): string {
  return seedTodo(fixture.db, {
    title,
    start: "active",
    // A row scheduled on an OLDER day is still a Today member (startDate <= today);
    // its entry cohort is COALESCE(tiRef, startDate) — so `cohort` (an explicit
    // todayIndexReferenceDate) or an older `startDate` manufactures a distinct
    // cohort for the multi-cohort TODWIRE tests.
    startDate: opts.startDate ?? TODAY_ISO,
    todayIndex,
    ...(opts.cohort !== undefined && { todayIndexReferenceDate: opts.cohort }),
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
  it("today scope: sends the MINIMAL visible-order wire — names only what must move (TODWIRE)", async () => {
    // Single cohort A,B,C at visible order [A, B, C] (todayIndex 10,20,30).
    const a = seedToday("A", 10);
    const b = seedToday("B", 20);
    const c = seedToday("C", 30);
    const { vector, calls } = nativeVector();
    // Front-insert C then A: target visible [C, A, B]. Removing C leaves [A, B]
    // already in current relative order, so the MINIMAL wire names ONLY C — the OLD
    // full wire "C,A,B" would needlessly re-stamp A and B's entry cohorts.
    const result = await runReorder(deps([vector]), { scope: "today", uuids: [c, a] });
    expect(result.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`list "Today"`);
    expect(calls[0]).toContain(`with ids "${c}"`);
    // B (never named) is not in the wire.
    expect(calls[0]).not.toContain(b);
    const [rc, ra, rb] = ranks([c, a, b]);
    expect(rc).toBeLessThan(ra as number);
    expect(ra).toBeLessThan(rb as number);
    // A front-insert names only movees (which re-stamp inherently) — NO non-movee
    // re-stamp warning.
    if (result.kind === "ok") {
      expect(result.warnings?.some((w) => w.includes("re-stamp")) ?? false).toBe(false);
    }
  });

  it("today scope multi-cohort: a single-ID front-insert names ONLY the movee (unnamed cohorts untouched)", async () => {
    // Three cohorts (07-03/04/05 by startDate; tiRef defaults to startDate). Visible
    // order groups by cohort DESC then todayIndex ASC: [NEW, MID, OLD].
    const oldRow = seedToday("OLD", -100, { startDate: "2026-07-03" });
    const mid = seedToday("MID", -200, { startDate: "2026-07-04" });
    const neu = seedToday("NEW", -300, { startDate: "2026-07-05" });
    // The pre census computes the minimal wire directly.
    const pre = computeReorderPre(fixture.db, { scope: "today", uuids: [oldRow] }, null, NOW);
    // OLD front-inserts to the visible top; every other row keeps its cohort/order,
    // so the wire names ONLY OLD (not MID/NEW).
    expect(pre.todayWire).toEqual([oldRow]);
    expect(pre.todayVisibleOrder).toEqual([neu, mid, oldRow]);
    expect(pre.todayRestampNonMovees).toEqual([]); // only the movee re-stamps (inherent)
  });

  it("today scope multi-cohort: an anchored placement names the visible PREFIX + discloses the cohort re-stamp", async () => {
    // Visible order [NEW, MID, OLD]. Place OLD directly AFTER NEW → target visible
    // [NEW, OLD, MID]. The caller passes the FULL spliced target order (what
    // buildReorderOrder emits for --after), named = the movee (OLD).
    const oldRow = seedToday("OLD", -100, { startDate: "2026-07-03" });
    const mid = seedToday("MID", -200, { startDate: "2026-07-04" });
    const neu = seedToday("NEW", -300, { startDate: "2026-07-05" });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "today", uuids: [neu, oldRow, mid], named: [oldRow] },
      null,
      NOW,
    );
    // Because the native reorder can only RAISE a named row's cohort to today, the
    // minimal wire must name the visible prefix down through the insertion point
    // (NEW) plus the movee (OLD): [NEW, OLD]; MID (the untouched tail) stays out.
    expect(pre.todayWire).toEqual([neu, oldRow]);
    // NEW is a NON-movee that had to be named → its cohort re-stamps; disclosed.
    expect(pre.todayRestampNonMovees).toEqual([neu]);
  });

  it("today scope: an anchored reorder DISCLOSES the non-movee cohort re-stamp on the ok result", async () => {
    const oldRow = seedToday("OLD", -100, { startDate: "2026-07-03" });
    const mid = seedToday("MID", -200, { startDate: "2026-07-04" });
    const neu = seedToday("NEW", -300, { startDate: "2026-07-05" });
    const { vector } = nativeVector();
    const result = await runReorder(deps([vector]), {
      scope: "today",
      uuids: [neu, oldRow, mid],
      named: [oldRow],
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.warnings?.some((w) => w.includes("re-stamp"))).toBe(true);
    }
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

  it("excludes DERIVED-trashed children — a trashed project's Today child never enters the wire (MOVPLC / ORD-21)", () => {
    // The census must mirror the reader's CONTAINER_UNTRASHED exclusion: project
    // deletion is shallow (A24B), so a child keeps trashed=0 while its project row
    // flips trashed=1. Filtering the child's OWN trashed flag alone leaked it into
    // the native `list "Today"` reorder (a blind writer, §9p), which then mutated a
    // row the reader hides.
    const live = seedToday("LIVE", 10);
    const trashedProj = seedProject(fixture.db, { title: "TrashedProj", trashed: true });
    const derived = seedTodo(fixture.db, {
      title: "DERIVED",
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: 5,
      project: trashedProj,
      trashed: false,
    });
    const pre = computeReorderPre(fixture.db, { scope: "today", uuids: [live] }, null, NOW);
    expect(pre.wireList).toEqual([live]); // the derived-trashed child is NOT extended in
    expect(pre.members.map((m) => m.uuid)).not.toContain(derived);
    // A live child of a live project still counts.
    const liveProj = seedProject(fixture.db, { title: "LiveProj", trashed: false });
    const liveChild = seedTodo(fixture.db, {
      title: "LIVECHILD",
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: 20,
      project: liveProj,
    });
    const pre2 = computeReorderPre(fixture.db, { scope: "today", uuids: [live] }, null, NOW);
    // wire = requested [live] then remaining by todayIndex; derived (idx 5) is still
    // excluded, liveChild (idx 20) rides along.
    expect(pre2.wireList).toEqual([live, liveChild]);
    expect(pre2.members.map((m) => m.uuid)).toContain(liveChild);
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

  // SIT6 PROJPARK — the when=someday → when=anytime projects bounce OVERWRITES a
  // Today/Evening flag (someday nulls startDate; anytime leaves start=1, sd=NULL —
  // star gone). When ANY touched project carries the flag, the planner SWAPS the
  // bounce for the flag-safe park-into-scratch-AREA → detach protocol (replacing
  // #351's refusal); only a cap-exceeded set still refuses.
  it("routes a Today-flagged project movee through PROJPARK, star preserved (SIT6)", async () => {
    const pf = seedProject(fixture.db, {
      title: "PF",
      startDate: TODAY_ISO,
      index: 10,
      todayIndex: -5,
    });
    const p2 = seedProject(fixture.db, { title: "P2", index: 20 });
    const p3 = seedProject(fixture.db, { title: "P3", index: 30 });
    const { url, osa, calls } = flagSafeVectors();
    const result = await runReorder(deps([url, osa]), {
      scope: "projects",
      uuids: [p3, pf, p2],
      named: [p3, pf, p2],
    });
    expect(result.kind).toBe("ok");
    // Scratch AREA + park ×3 + detach ×3 + area delete — NO when= leg dispatched.
    expect(calls).toContain("area.add");
    expect(calls.filter((c) => c === "project.move")).toHaveLength(6);
    expect(calls).toContain("area.delete");
    // Exact target order on index, star (start=1, today startDate, todayIndex) intact.
    expect(ascending(ranks([p3, pf, p2], `"index"`))).toBe(true);
    const row = fixture.db
      .prepare("SELECT start, startDate, startBucket, todayIndex, area FROM TMTask WHERE uuid = ?")
      .get(pf) as {
      start: number;
      startDate: number | null;
      startBucket: number;
      todayIndex: number;
      area: string | null;
    };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
    expect(row.todayIndex).toBe(-5);
    expect(row.area).toBeNull();
    // The scratch area was verified empty then deleted — none linger.
    const areas = fixture.db.prepare("SELECT COUNT(*) AS n FROM TMArea").get() as { n: number };
    expect(areas.n).toBe(0);
  });

  it("routes a This-Evening-flagged project movee through PROJPARK (evening flag kept)", async () => {
    const pf = seedProject(fixture.db, {
      title: "PE",
      startDate: TODAY_ISO,
      evening: true,
      index: 10,
      todayIndex: -5,
    });
    const p2 = seedProject(fixture.db, { title: "P2", index: 20 });
    const { url, osa } = flagSafeVectors();
    const result = await runReorder(deps([url, osa]), {
      scope: "projects",
      uuids: [pf, p2],
      named: [pf, p2],
    });
    expect(result.kind).toBe("ok");
    const row = fixture.db
      .prepare("SELECT start, startDate, startBucket FROM TMTask WHERE uuid = ?")
      .get(pf) as { start: number; startDate: number | null; startBucket: number };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
    expect(row.startBucket).toBe(1); // still This Evening
  });

  it("swaps to PROJPARK when a co-bounced (unnamed) sibling carries the flag", async () => {
    // `named` is the requested subset; `uuids` is the full target order. A flagged
    // project the round-trip would re-enter as a co-bounced sibling triggers the swap.
    const pf = seedProject(fixture.db, {
      title: "PF",
      startDate: TODAY_ISO,
      index: 10,
      todayIndex: -5,
    });
    const p1 = seedProject(fixture.db, { title: "P1", index: 20 });
    const { url, osa, calls } = flagSafeVectors();
    const result = await runReorder(deps([url, osa]), {
      scope: "projects",
      uuids: [pf, p1],
      named: [p1],
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.touched).toEqual([pf]);
    expect(calls).toContain("area.add");
    const row = fixture.db
      .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
      .get(pf) as { start: number; startDate: number | null };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
  });

  it("an unrelated Today-flagged project keeps the plain set on the cheaper bounce", async () => {
    // A flagged project that is NOT touched (not a member, not requested) must not
    // trigger the swap — only the projects actually re-entered by the bounce matter.
    seedProject(fixture.db, { title: "PF", startDate: TODAY_ISO, index: 5, todayIndex: -5 });
    const p1 = seedProject(fixture.db, { title: "P1", index: 10 });
    const p2 = seedProject(fixture.db, { title: "P2", index: 20 });
    const p3 = seedProject(fixture.db, { title: "P3", index: 30 });
    const { vector, calls } = projectBounceVector();
    const result = await runReorder(deps([vector]), { scope: "projects", uuids: [p2, p3, p1] });
    expect(result.kind).toBe("ok");
    // Cheaper when= bounce (project.update legs), NOT the PROJPARK move family.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a cap-exceeded flagged set still refuses (PROJPARK unavailable)", async () => {
    const pf = seedProject(fixture.db, {
      title: "PF",
      startDate: TODAY_ISO,
      index: 10,
      todayIndex: -5,
    });
    const p2 = seedProject(fixture.db, { title: "P2", index: 20 });
    const p3 = seedProject(fixture.db, { title: "P3", index: 30 });
    const { url, osa, calls } = flagSafeVectors();
    const result = await runReorder(
      deps([url, osa], { config: { ...config(true), bounceMaxItems: 2 } }),
      { scope: "projects", uuids: [p3, pf, p2], named: [p3, pf, p2] },
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.hazard).toBe("H-REORDER-SCOPE");
      expect(result.detail).toContain("exceed the cap of 2");
    }
    // Fail-closed: no scratch area created, star intact.
    expect(calls).toHaveLength(0);
    const row = fixture.db
      .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
      .get(pf) as { start: number; startDate: number | null };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
  });

  it("dry-run describes the PROJPARK legs without executing", async () => {
    const pf = seedProject(fixture.db, {
      title: "PF",
      startDate: TODAY_ISO,
      index: 10,
      todayIndex: -5,
    });
    const p2 = seedProject(fixture.db, { title: "P2", index: 20 });
    const { url, osa, calls } = flagSafeVectors();
    const result = await runReorder(
      deps([url, osa]),
      { scope: "projects", uuids: [pf, p2], named: [pf, p2] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("PROJPARK");
      expect(result.plan.invocation).toContain("detach");
    }
    expect(calls).toHaveLength(0);
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

// ------------------------------------------------- SIT7 automatic MOVE fallbacks
//
// FAITHFUL SIT7 move sims: every leg is a URL/AppleScript MOVE preserving the flag +
// reminder + deadline + FKs (it never writes start/startDate/startBucket/todayIndex/
// reminderTime/deadline), the re-entry legs implementing the SIT7 index geometry.

/**
 * PROJROOT / project-root move sim (SIT7 PROJROOT): `todo.move project=X` BACK-INSERTS
 * the row at project X's root `index` max (a project root is a container). Models BOTH
 * the park-into-scratch AND the re-home-to-P legs with the ONE law (moving a to-do into
 * any project root back-inserts there). project.add mints the scratch; project.delete
 * trashes it.
 */
function projRootVectors() {
  const calls: string[] = [];
  const db = fixture.db;
  const nowEpoch = Math.floor(NOW.getTime() / 1000);
  const yes = { support: "yes" as const, disruption: 0 as const, validation: "validated" as const };
  const url: WriteVector = {
    id: "url-scheme",
    matrix: { "todo.move": { ...yes }, "project.add": { ...yes } },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      if (inv.op === "project.add") {
        const p = inv.opParams as { title: string };
        seedProject(db, {
          title: p.title,
          start: "active",
          creationDate: nowEpoch,
          modificationDate: nowEpoch,
        });
      } else if (inv.op === "todo.move") {
        const p = inv.opParams as { uuid: string; project?: { uuid: string } };
        if (p.project !== undefined) {
          const max = db
            .prepare(
              `SELECT MAX("index") AS m FROM TMTask WHERE project = ? AND heading IS NULL
               AND trashed = 0 AND status = 0 AND uuid != ?`,
            )
            .get(p.project.uuid, p.uuid) as { m: number | null };
          db.prepare(
            `UPDATE TMTask SET project = ?, heading = NULL, area = NULL, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
          ).run(p.project.uuid, (max.m ?? 0) + 1, modClock++, p.uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const osa: WriteVector = {
    id: "applescript",
    matrix: { "project.delete": { ...yes } },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      if (inv.op === "project.delete") {
        const p = inv.opParams as { uuid: string };
        db.prepare("UPDATE TMTask SET trashed = 1, userModificationDate = ? WHERE uuid = ?").run(
          modClock++,
          p.uuid,
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { url, osa, calls };
}

/**
 * INBOXBACK / AREABACK move sim (SIT7): models the re-entry front-inserts.
 *   - `todo.move inbox` FRONT-inserts at the inbox `index` min + RESTORES start=0.
 *   - `todo.move area=X` FRONT-inserts at area X's to-do member `index` min.
 *   - `project.move area=X` FRONT-inserts at area X's project member `index` min.
 *   - `todo.move project=X` / `project.move area=<scratch>` PARK (no index change beyond
 *     the container FK) — the park law is that scratch parking preserves relative order.
 * project.add / area.add mint the scratch; project.delete / area.delete remove it.
 */
function sit7BackVectors(opts: { failAt?: { op: string; nth: number } } = {}) {
  const calls: string[] = [];
  const db = fixture.db;
  const nowEpoch = Math.floor(NOW.getTime() / 1000);
  const yes = { support: "yes" as const, disruption: 0 as const, validation: "validated" as const };
  // Shared op counter across BOTH vectors — a leg's Nth occurrence fails on demand.
  const opCount = new Map<string, number>();
  const failNow = (op: string): boolean => {
    const n = (opCount.get(op) ?? 0) + 1;
    opCount.set(op, n);
    return opts.failAt !== undefined && opts.failAt.op === op && opts.failAt.nth === n;
  };
  const failExec = { exitCode: 1, stdout: "", stderr: "simulated leg failure" };
  const frontMinTodoInbox = (): number => {
    const r = db
      .prepare(
        `SELECT MIN("index") AS m FROM TMTask WHERE type = 0 AND trashed = 0 AND status = 0
         AND start = 0 AND project IS NULL AND area IS NULL AND heading IS NULL`,
      )
      .get() as { m: number | null };
    return (r.m ?? 0) - 1;
  };
  const frontMinAreaTodo = (area: string): number => {
    const r = db
      .prepare(
        `SELECT MIN("index") AS m FROM TMTask WHERE type = 0 AND trashed = 0 AND status = 0 AND area = ? AND heading IS NULL`,
      )
      .get(area) as { m: number | null };
    return (r.m ?? 0) - 1;
  };
  const frontMinAreaProj = (area: string): number => {
    const r = db
      .prepare(
        `SELECT MIN("index") AS m FROM TMTask WHERE type = 1 AND trashed = 0 AND status = 0 AND area = ?`,
      )
      .get(area) as { m: number | null };
    return (r.m ?? 0) - 1;
  };
  // Shared `todo.move` applier — registered on BOTH the url and applescript vectors,
  // because the INBOXBACK Inbox-return leg is PINNED to applescript (#356) while the
  // park / area-re-home legs route to url. Both surfaces model the same move law.
  const applyTodoMove = (inv: { opParams?: unknown }): void => {
    const p = inv.opParams as {
      uuid: string;
      project?: { uuid: string };
      area?: { uuid: string };
      inbox?: boolean;
    };
    if (p.inbox === true) {
      db.prepare(
        `UPDATE TMTask SET start = 0, startDate = NULL, startBucket = 0, project = NULL, area = NULL, heading = NULL, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
      ).run(frontMinTodoInbox(), modClock++, p.uuid);
    } else if (p.area !== undefined) {
      const areaUuid = p.area.uuid;
      db.prepare(
        `UPDATE TMTask SET area = ?, project = NULL, heading = NULL, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
      ).run(areaUuid, frontMinAreaTodo(areaUuid), modClock++, p.uuid);
    } else if (p.project !== undefined) {
      // Park into scratch (no index reindex — parking preserves relative order).
      db.prepare(
        `UPDATE TMTask SET project = ?, heading = NULL, area = NULL, userModificationDate = ? WHERE uuid = ?`,
      ).run(p.project.uuid, modClock++, p.uuid);
    }
  };
  const url: WriteVector = {
    id: "url-scheme",
    matrix: { "todo.move": { ...yes }, "project.move": { ...yes }, "project.add": { ...yes } },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      if (inv.op !== undefined && failNow(inv.op)) return failExec;
      if (inv.op === "project.add") {
        const p = inv.opParams as { title: string };
        seedProject(db, {
          title: p.title,
          start: "active",
          creationDate: nowEpoch,
          modificationDate: nowEpoch,
        });
      } else if (inv.op === "todo.move") {
        applyTodoMove(inv);
      } else if (inv.op === "project.move") {
        const p = inv.opParams as { uuid: string; area?: { uuid: string } };
        if (p.area !== undefined) {
          // Distinguish re-home to the target area (front-insert) from park to scratch.
          // Both set the area FK; the terminal verify only checks the re-home target.
          db.prepare(
            `UPDATE TMTask SET area = ?, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
          ).run(p.area.uuid, frontMinAreaProj(p.area.uuid), modClock++, p.uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const osa: WriteVector = {
    id: "applescript",
    matrix: {
      "todo.move": { ...yes },
      "area.add": { ...yes },
      "area.delete": { ...yes },
      "project.delete": { ...yes },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      if (inv.op !== undefined && failNow(inv.op)) return failExec;
      if (inv.op === "todo.move") {
        applyTodoMove(inv);
      } else if (inv.op === "area.add") {
        const p = inv.opParams as { title: string };
        seedArea(db, p.title);
      } else if (inv.op === "area.delete") {
        const p = inv.opParams as { target: string };
        db.prepare("DELETE FROM TMArea WHERE uuid = ?").run(p.target);
      } else if (inv.op === "project.delete") {
        const p = inv.opParams as { uuid: string };
        db.prepare("UPDATE TMTask SET trashed = 1, userModificationDate = ? WHERE uuid = ?").run(
          modClock++,
          p.uuid,
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { url, osa, calls };
}

describe("project scope: PROJROOT move fallback (SIT7 — native unavailable)", () => {
  it("park + re-home (forward, back-insert) lands the order for ALL rows, flag preserved", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "active", index: 10 });
    // b is Today-flagged + reminder + deadline (PROJROOT is one flag-safe protocol for all rows).
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: -9,
      reminder: "09:00",
      deadline: "2026-07-10",
      index: 20,
    });
    const c = seedTodo(fixture.db, { title: "c", project: proj, start: "active", index: 30 });
    const { url, osa, calls } = projRootVectors();
    const result = await runReorder(deps([url, osa], { config: config(false) }), {
      scope: "project",
      container: { uuid: proj },
      uuids: [c, a, b],
      named: [c, a, b],
    });
    expect(result.kind).toBe("ok");
    // scratch project + park ×3 + re-home ×3 + trash — NO when= leg.
    expect(calls).toContain("project.add");
    expect(calls.filter((op) => op === "todo.move")).toHaveLength(6);
    expect(calls).toContain("project.delete");
    expect(ascending(ranks([c, a, b], `"index"`))).toBe(true);
    const row = fixture.db
      .prepare(
        "SELECT start, startDate, todayIndex, reminderTime, deadline, project FROM TMTask WHERE uuid = ?",
      )
      .get(b) as {
      start: number;
      startDate: number | null;
      todayIndex: number;
      reminderTime: number | null;
      deadline: number | null;
      project: string;
    };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
    expect(row.todayIndex).toBe(-9);
    expect(row.reminderTime).not.toBeNull();
    expect(row.deadline).not.toBeNull();
    expect(row.project).toBe(proj);
    // Disclosure: the ok result names the non-experimental fallback.
    if (result.kind === "ok") {
      expect(result.warnings?.some((w) => w.includes("PROJROOT"))).toBe(true);
    }
  });

  it("dry-run describes the PROJROOT legs without executing", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "active", index: 10 });
    const { url, osa, calls } = projRootVectors();
    const result = await runReorder(
      deps([url, osa], { config: config(false) }),
      { scope: "project", container: { uuid: proj }, uuids: [a] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("PROJROOT");
      expect(result.plan.invocation).toContain("re-home");
    }
    expect(calls).toHaveLength(0);
  });

  it("caps the touched block by bounce-max-items", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "active", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", project: proj, start: "active", index: 20 });
    const c = seedTodo(fixture.db, { title: "c", project: proj, start: "active", index: 30 });
    const { url, osa, calls } = projRootVectors();
    const result = await runReorder(
      deps([url, osa], { config: { ...config(false), bounceMaxItems: 2 } }),
      { scope: "project", container: { uuid: proj }, uuids: [c, a, b], named: [c, a, b] },
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("cap of 2");
    expect(calls).toHaveLength(0);
  });

  it("aborts loudly if a re-home leg fails — children left PARKED in the scratch", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "active", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", project: proj, start: "active", index: 20 });
    const { url, osa, calls } = projRootVectors();
    // Fail the 3rd todo.move (2 parks done, first re-home fails).
    let n = 0;
    const failing: WriteVector = {
      ...url,
      async execute(inv) {
        if (inv.op === "todo.move" && ++n === 3) return { exitCode: 1, stdout: "", stderr: "fail" };
        return url.execute(inv);
      },
    };
    const result = await runReorder(deps([failing, osa], { config: config(false) }), {
      scope: "project",
      container: { uuid: proj },
      uuids: [a, b],
      named: [a, b],
    });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") expect(result.detail).toContain("PARKED");
    expect(calls).not.toContain("project.delete");
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

/**
 * Faithful sim of the DLBNC deadline-cycle + its interleave with the SIT4 scheduled
 * bounce on ONE Upcoming day-block todayIndex axis. The block for day D is every
 * SCHEDULED row (startBucket=0, startDate=D) AND every DEADLINE-FORECAST to-do
 * (startDate NULL, deadline=D, start IN (1,2)); its GLOBAL min spans both classes.
 *   - `deadline=` (empty) CLEARS the deadline: the row leaves the block, todayIndex
 *     inert, start/startDate untouched (DLBNC-3b).
 *   - `deadline=<ISO>` RE-SETS it: front-insert at the block's current global min,
 *     start=2/startDate NULL and `index` byte-identical (never touched) — DLBNC-3.
 *   - `when=<ISO>`/today (scheduled): front-insert at the same combined block min,
 *     deadline/FKs preserved (SIT4 DAYBNC).
 * So a reverse-target pass interleaves the two classes exactly (the #383 wiring claim).
 */
function datedForecastVector() {
  const calls: string[] = [];
  const blockMin = (packed: number): number => {
    const r = fixture.db
      .prepare(
        `SELECT MIN(todayIndex) AS m FROM TMTask WHERE trashed = 0 AND status = 0 AND (
           (startBucket = 0 AND startDate = ?) OR
           (startDate IS NULL AND deadline = ? AND start IN (1, 2)))`,
      )
      .get(packed, packed) as { m: number | null };
    return r.m ?? 0;
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
      const id = url.searchParams.get("id") ?? "";
      const deadline = url.searchParams.get("deadline");
      if (deadline !== null) {
        if (deadline === "") {
          fixture.db
            .prepare("UPDATE TMTask SET deadline = NULL, userModificationDate = ? WHERE uuid = ?")
            .run(modClock++, id);
        } else {
          const packed = encodePackedDate(deadline);
          fixture.db
            .prepare(
              "UPDATE TMTask SET deadline = ?, todayIndex = ?, userModificationDate = ? WHERE uuid = ?",
            )
            .run(packed, blockMin(packed) - 1, modClock++, id);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const base = url.searchParams.get("when") ?? "";
      const packed = base === "today" ? PACKED_TODAY : encodePackedDate(base);
      const startVal = packed > PACKED_TODAY ? 2 : 1;
      fixture.db
        .prepare(
          `UPDATE TMTask SET start = ?, startDate = ?, startBucket = 0, todayIndex = ?,
           userModificationDate = ? WHERE uuid = ?`,
        )
        .run(startVal, packed, blockMin(packed) - 1, modClock++, id);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

/** A deadline-forecast row: someday/anytime stage, NO startDate, future deadline D. */
function seedForecast(
  title: string,
  todayIndex: number,
  index: number,
  extra: Partial<Parameters<typeof seedTodo>[1]> = {},
): string {
  return seedTodo(fixture.db, {
    title,
    start: "someday",
    startDate: null,
    deadline: FUTURE_ISO,
    todayIndex,
    index,
    ...extra,
  });
}

/** A deadline-forecast PROJECT (PROJDL / #385): someday stage, NO startDate, future deadline D. */
function seedForecastProject(
  title: string,
  todayIndex: number,
  index: number,
  extra: Partial<Parameters<typeof seedProject>[1]> = {},
): string {
  return seedProject(fixture.db, {
    title,
    start: "someday",
    startDate: null,
    deadline: FUTURE_ISO,
    todayIndex,
    index,
    ...extra,
  });
}

describe("day scope: DEADLINE-FORECAST rows (DLBNC / #383 — the deadline-cycle)", () => {
  it("forecast-only: lands the exact target block order, someday `index` byte-identical", async () => {
    // DLBNC-3c protocol proof: scramble 3 forecast rows, deadline-cycle to a target.
    const f1 = seedForecast("F1", -100, 7);
    const f2 = seedForecast("F2", -200, 3);
    const f3 = seedForecast("F3", -300, 11);
    const idxBefore = ranks([f1, f2, f3], `"index"`);
    const target = [f2, f3, f1]; // scrambled vs resting todayIndex
    const { vector, calls } = datedForecastVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: target });
    expect(result.kind).toBe("ok");
    // Final ascending todayIndex == target order.
    const order = target.toSorted((a, b) => ranks([a])[0]! - ranks([b])[0]!);
    expect(order).toEqual(target);
    // `index` byte-identical (the deadline-cycle never touches it — DLBNC-3).
    expect(ranks([f1, f2, f3], `"index"`)).toEqual(idxBefore);
    // start=2 / startDate NULL / deadline restored on every row.
    for (const u of [f1, f2, f3]) {
      const row = fixture.db
        .prepare("SELECT start, startDate, deadline FROM TMTask WHERE uuid = ?")
        .get(u) as { start: number; startDate: number | null; deadline: number | null };
      expect(row.start).toBe(2);
      expect(row.startDate).toBeNull();
      expect(row.deadline).toBe(PACKED_FUTURE);
    }
    // Each forecast row: 2 URL legs (deadline= clear + re-set), NO when= leg.
    expect(calls.every((c) => c.includes("deadline=") && !c.includes("when="))).toBe(true);
    expect(calls).toHaveLength(6);
  });

  it("mixed wire: scheduled + forecast rows interleave to the exact target order (one axis)", async () => {
    // The #383 interleave claim: both leg families front-insert below the same
    // global day min, so a unified reverse-target pass lands the exact interleave.
    const s1 = seedDay("S1", -50); // scheduled (startDate=D)
    const f1 = seedForecast("F1", -150, 4); // forecast (deadline=D)
    const s2 = seedDay("S2", -250);
    const f2 = seedForecast("F2", -350, 9);
    const idxBefore = ranks([f1, f2], `"index"`);
    const target = [s1, f1, s2, f2]; // interleaved target
    const { vector, calls } = datedForecastVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: target });
    expect(result.kind).toBe("ok");
    const order = target.toSorted((a, b) => ranks([a])[0]! - ranks([b])[0]!);
    expect(order).toEqual(target); // exact interleave
    // Forecast rows: `index` byte-identical.
    expect(ranks([f1, f2], `"index"`)).toEqual(idxBefore);
    // Scheduled rows: dates preserved (startDate=D, startBucket=0).
    for (const u of [s1, s2]) {
      const row = fixture.db
        .prepare("SELECT startDate, startBucket FROM TMTask WHERE uuid = ?")
        .get(u) as { startDate: number; startBucket: number };
      expect(row.startDate).toBe(PACKED_FUTURE);
      expect(row.startBucket).toBe(0);
    }
    // Per-row-class legs: forecast rows via deadline=, scheduled via when=.
    const fLegs = calls.filter((c) => c.includes(`id=${f1}`) || c.includes(`id=${f2}`));
    const sLegs = calls.filter((c) => c.includes(`id=${s1}`) || c.includes(`id=${s2}`));
    expect(fLegs.every((c) => c.includes("deadline=") && !c.includes("when="))).toBe(true);
    expect(sLegs.every((c) => c.includes("when=") && !c.includes("deadline="))).toBe(true);
  });

  it("re-sets the SAME deadline byte-identical (never reformats)", async () => {
    const f1 = seedForecast("F1", -100, 1);
    const { vector, calls } = datedForecastVector();
    await runReorder(deps([vector]), { scope: "day", uuids: [f1] });
    // The re-set leg carries the decoded ISO of the original deadline (2026-07-19).
    expect(calls.some((c) => c.includes(`deadline=${FUTURE_ISO}`))).toBe(true);
    const row = fixture.db.prepare("SELECT deadline FROM TMTask WHERE uuid = ?").get(f1) as {
      deadline: number;
    };
    expect(row.deadline).toBe(PACKED_FUTURE);
  });

  it("REFUSES an INBOX-stage row with the day's deadline, naming §9o (unprobed off-axis)", async () => {
    const f1 = seedForecast("F1", -100, 1);
    const inbox = seedTodo(fixture.db, {
      title: "IB",
      start: "inbox",
      startDate: null,
      deadline: FUTURE_ISO,
    });
    const { vector, calls } = datedForecastVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: [f1, inbox] });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.detail).toContain("INBOX-stage");
      expect(result.detail).toContain("§9o");
    }
    expect(calls).toHaveLength(0);
  });

  it("dry-run names the deadline-cycle + leg count for a mixed group", async () => {
    const s1 = seedDay("S1", -50);
    const f1 = seedForecast("F1", -150, 2);
    const { vector, calls } = datedForecastVector();
    const result = await runReorder(
      deps([vector]),
      { scope: "day", uuids: [s1, f1] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("deadline-cycle");
      expect(result.plan.invocation).toContain("1 deadline-forecast");
      expect(result.plan.invocation).toContain("1 scheduled");
    }
    expect(calls).toHaveLength(0);
  });

  it("membership: computeReorderPre day admits start∈{1,2} forecast rows, excludes inbox+deadline", () => {
    const someday = seedForecast("SD", -100, 1); // start=2
    const anytime = seedForecast("AT", -200, 2, { start: "active" }); // start=1, no startDate
    const inbox = seedTodo(fixture.db, {
      title: "IB",
      start: "inbox",
      startDate: null,
      deadline: FUTURE_ISO,
    });
    const pre = computeReorderPre(
      fixture.db,
      { scope: "day", uuids: [someday, anytime, inbox] },
      null,
      NOW,
    );
    const memberIds = pre.members.map((m) => m.uuid);
    expect(memberIds).toContain(someday);
    expect(memberIds).toContain(anytime);
    expect(memberIds).not.toContain(inbox);
    expect(pre.rejected.some((r) => r.uuid === inbox && r.reason.includes("INBOX-stage"))).toBe(
      true,
    );
  });

  it("aborts on a concurrent deadline clear (forecast row left the block)", async () => {
    const f1 = seedForecast("F1", -100, 1);
    const f2 = seedForecast("F2", -200, 2);
    // f2's deadline is cleared out-of-band before its bounce runs.
    const { vector } = datedForecastVector();
    const hooked = deps([vector]);
    // Clear f2's deadline right away to simulate a concurrent edit.
    fixture.db.prepare("UPDATE TMTask SET deadline = NULL WHERE uuid = ?").run(f2);
    const result = await runReorder(hooked, { scope: "day", uuids: [f1, f2] });
    expect(result.kind).toBe("blocked"); // f2 is no longer a member → rejected pre-flight
  });

  it("dispatches a forecast PROJECT via the update-project deadline-cycle (per-type legs, #385)", async () => {
    // PROJDL-2b: a forecast project's cycle is `update-project?deadline=` clear + re-set.
    const fp = seedForecastProject("FP", -100, 5);
    const { vector, calls } = datedForecastVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: [fp] });
    expect(result.kind).toBe("ok");
    const projLegs = calls.filter((c) => c.includes(`id=${fp}`));
    expect(projLegs).toHaveLength(2); // deadline= clear + re-set
    expect(projLegs.every((c) => c.includes("update-project") && c.includes("deadline="))).toBe(
      true,
    );
    expect(projLegs.every((c) => !c.includes("when="))).toBe(true);
    // The re-set leg carries the SAME deadline byte-identical.
    expect(projLegs.some((c) => c.includes(`deadline=${FUTURE_ISO}`))).toBe(true);
    // PROJSTAR-safe: start=2 / startDate NULL / deadline restored / still a project.
    const row = fixture.db
      .prepare("SELECT start, startDate, deadline, type FROM TMTask WHERE uuid = ?")
      .get(fp) as { start: number; startDate: number | null; deadline: number; type: number };
    expect(row.start).toBe(2);
    expect(row.startDate).toBeNull();
    expect(row.deadline).toBe(PACKED_FUTURE);
    expect(row.type).toBe(1);
  });

  it("mixed forecast to-do + forecast PROJECT interleave to the exact target; project `index` byte-identical (PROJDL-2c)", async () => {
    const ft1 = seedForecast("FT1", -50, 3);
    const fp1 = seedForecastProject("FP1", -150, 4);
    const ft2 = seedForecast("FT2", -250, 7);
    const fp2 = seedForecastProject("FP2", -350, 9);
    const idxBefore = ranks([fp1, fp2], `"index"`);
    const target = [ft1, fp1, ft2, fp2]; // interleaved to-do/project target
    const { vector, calls } = datedForecastVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: target });
    expect(result.kind).toBe("ok");
    const order = target.toSorted((a, b) => ranks([a])[0]! - ranks([b])[0]!);
    expect(order).toEqual(target); // exact mixed interleave on the one axis
    // Project someday `index` byte-identical (the deadline-cycle never touches it).
    expect(ranks([fp1, fp2], `"index"`)).toEqual(idxBefore);
    // PROJSTAR-safe: projects stay start=2 / startDate NULL / type=1.
    for (const u of [fp1, fp2]) {
      const row = fixture.db
        .prepare("SELECT start, startDate, deadline, type FROM TMTask WHERE uuid = ?")
        .get(u) as { start: number; startDate: number | null; deadline: number; type: number };
      expect(row.start).toBe(2);
      expect(row.startDate).toBeNull();
      expect(row.deadline).toBe(PACKED_FUTURE);
      expect(row.type).toBe(1);
    }
    // Per-type legs: projects via update-project, to-dos via update.
    const pLegs = calls.filter((c) => c.includes(`id=${fp1}`) || c.includes(`id=${fp2}`));
    const tLegs = calls.filter((c) => c.includes(`id=${ft1}`) || c.includes(`id=${ft2}`));
    expect(pLegs.every((c) => c.includes("update-project"))).toBe(true);
    expect(tLegs.every((c) => !c.includes("update-project"))).toBe(true);
  });

  it("forecast PROJECT preserves its area FK across the deadline-cycle (PROJDL-2b')", async () => {
    const area = seedArea(fixture.db, "A");
    const fp = seedForecastProject("FP", -100, 5, { area });
    const { vector } = datedForecastVector();
    const result = await runReorder(deps([vector]), { scope: "day", uuids: [fp] });
    expect(result.kind).toBe("ok");
    const row = fixture.db
      .prepare("SELECT area, start, startDate, deadline FROM TMTask WHERE uuid = ?")
      .get(fp) as { area: string; start: number; startDate: number | null; deadline: number };
    expect(row.area).toBe(area); // area link orthogonal to the deadline-cycle
    expect(row.start).toBe(2);
    expect(row.startDate).toBeNull();
    expect(row.deadline).toBe(PACKED_FUTURE);
  });

  it("membership: computeReorderPre day admits a forecast PROJECT (type=1) as a block member (#385)", () => {
    const fp = seedForecastProject("FP", -100, 5);
    const ft = seedForecast("FT", -200, 2);
    const pre = computeReorderPre(fixture.db, { scope: "day", uuids: [fp, ft] }, null, NOW);
    const memberIds = pre.members.map((m) => m.uuid);
    expect(memberIds).toContain(fp);
    expect(memberIds).toContain(ft);
    expect(pre.projectMembers).toContain(fp); // typed as a project member
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

  it("falls back to the dated day bounce when experimental is off (SIT7 fallback 5)", async () => {
    const t1 = seedTomorrow("t1", 30);
    const t2 = seedTomorrow("t2", 10);
    const t3 = seedTomorrow("t3", 20);
    const { vector, calls } = datedBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "tomorrow",
      uuids: [t2, t3, t1],
      named: [t2, t3, t1],
    });
    // The native `list "Tomorrow"` surface is unavailable; the pure-URL dated day
    // bounce (ORD-6 DAYBNC) reaches the whole next-day group instead. Reverse-target
    // front-insert dispatch lands the exact order — NO native reorder call.
    expect(result.kind).toBe("ok");
    expect(calls.some((c) => c.includes('list "Tomorrow"'))).toBe(false);
    expect(calls.some((c) => c.includes("when=2026-07-06"))).toBe(true);
    expect(ascending(ranks([t2, t3, t1]))).toBe(true);
    if (result.kind === "ok") {
      expect(result.warnings?.some((w) => w.includes("dated-day-bounce"))).toBe(true);
    }
  });

  it('keeps the native `list "Tomorrow"` surface when experimental is on', async () => {
    const t1 = seedTomorrow("t1", 10);
    const { vector, calls } = nativeVector("todayIndex");
    const result = await runReorder(deps([vector]), { scope: "tomorrow", uuids: [t1] });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain('list "Tomorrow"');
  });

  // TMPLSORT-3c-Tomorrow / PTMPL-B5: a repeating template (to-do OR project) whose
  // projection == tomorrow is a first-class member of the one-call `list "Tomorrow"`
  // wire — placed at its EXACT sent slot, umd-silent, no crash. Native path (experimental
  // on) carries it as an ordinary wire id.
  it.each(TEMPLATE_SHAPES)(
    'carries a repeating to-do + project template on the one-call `list "Tomorrow"` wire [$shape]',
    async ({ derived }) => {
      const t1 = seedTomorrow("t1", 30);
      const tt = seedTomorrowTemplate("tt", 20, { derived });
      const pt = seedTomorrowTemplate("pt", 10, { project: true, derived });
      const { vector, calls } = nativeVector("todayIndex");
      // Sent top→bottom: tt (to-do template), pt (project template), t1 (scheduled).
      const result = await runReorder(deps([vector]), { scope: "tomorrow", uuids: [tt, pt, t1] });
      expect(result.kind).toBe("ok");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('list "Tomorrow"');
      // Both templates ride the SAME wire (exact sent order, list "Tomorrow" law).
      expect(calls[0]).toContain(`with ids "${tt},${pt},${t1}"`);
      expect(ascending(ranks([tt, pt, t1]))).toBe(true);
    },
  );
});

/**
 * The `day`-scope TEMPLATE leg family (TMPLSORT/PTMPL). Two fake vectors share the
 * fixture DB so their front-inserts see each other on ONE block min-space (TMPLSORT-2):
 *   - urlVector (url-scheme): the scheduled when= round-trip + forecast deadline-cycle,
 *     front-inserting at the day-D block min (scheduled ∪ forecast ∪ TEMPLATE rows).
 *   - tmplVector (applescript, experimental): the single-id `list "Upcoming"` NATIVE
 *     front-insert leg for a TO-DO template (TMPLSORT-1) — sets the template's todayIndex
 *     to the same shared block min − 1, userModificationDate UNCHANGED (umd-silent, §9r).
 * A PROJECT template is never dispatched (the suffix rule leaves it byte-untouched).
 */
function dayTemplateVectors() {
  const calls: string[] = [];
  const blockMin = (packed: number): number => {
    const r = fixture.db
      .prepare(
        `SELECT MIN(todayIndex) AS m FROM TMTask WHERE trashed = 0 AND status = 0 AND (
           (startBucket = 0 AND startDate = ?)
           OR (startDate IS NULL AND deadline = ? AND start IN (1, 2))
           OR (COALESCE(rt1_nextInstanceStartDate, rt1_instanceCreationStartDate) = ? AND (rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL)))`,
      )
      .get(packed, packed, packed) as { m: number | null };
    return r.m ?? 0;
  };
  const urlVector: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      const url = new URL(invocation.payload);
      const id = url.searchParams.get("id") ?? "";
      const deadline = url.searchParams.get("deadline");
      if (deadline !== null) {
        if (deadline === "") {
          fixture.db
            .prepare("UPDATE TMTask SET deadline = NULL, userModificationDate = ? WHERE uuid = ?")
            .run(modClock++, id);
        } else {
          const packed = encodePackedDate(deadline);
          fixture.db
            .prepare(
              "UPDATE TMTask SET deadline = ?, todayIndex = ?, userModificationDate = ? WHERE uuid = ?",
            )
            .run(packed, blockMin(packed) - 1, modClock++, id);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const base = url.searchParams.get("when") ?? "";
      const packed = base === "today" ? PACKED_TODAY : encodePackedDate(base);
      const startVal = packed > PACKED_TODAY ? 2 : 1;
      fixture.db
        .prepare(
          `UPDATE TMTask SET start = ?, startDate = ?, startBucket = 0, todayIndex = ?,
           userModificationDate = ? WHERE uuid = ?`,
        )
        .run(startVal, packed, blockMin(packed) - 1, modClock++, id);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const tmplVector: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
    },
    async execute(invocation) {
      calls.push(invocation.payload);
      // Single-id `list "Upcoming" with ids "<tmpl>"` front-insert: the template stays
      // on its projection day (rt1_nextInstanceStartDate) and its todayIndex drops below
      // the shared block min — umd UNCHANGED (TMPLSORT-1, umd-silent).
      const id = /with ids "([^"]+)"/.exec(invocation.payload)?.[1] ?? "";
      const row = fixture.db
        .prepare(
          "SELECT COALESCE(rt1_nextInstanceStartDate, rt1_instanceCreationStartDate) AS proj FROM TMTask WHERE uuid = ?",
        )
        .get(id) as { proj: number | null };
      const packed = row.proj ?? PACKED_FUTURE;
      fixture.db
        .prepare("UPDATE TMTask SET todayIndex = ? WHERE uuid = ?")
        .run(blockMin(packed) - 1, id);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { urlVector, tmplVector, calls };
}

/** A repeating TO-DO (or project) template whose projection == day D (FUTURE_ISO). */
function seedDayTemplate(
  title: string,
  todayIndex: number,
  opts: { project?: boolean; derived?: boolean } = {},
): string {
  const seed = opts.project === true ? seedProject : seedTodo;
  return seed(fixture.db, {
    title,
    start: "someday",
    startDate: null,
    todayIndex,
    ...templateCols(FUTURE_ISO, opts.derived === true),
  });
}

/** A repeating template whose projection == tomorrow (TOMORROW_ISO = 2026-07-06). */
function seedTomorrowTemplate(
  title: string,
  todayIndex: number,
  opts: { project?: boolean; derived?: boolean } = {},
): string {
  const seed = opts.project === true ? seedProject : seedTodo;
  return seed(fixture.db, {
    title,
    start: "someday",
    startDate: null,
    todayIndex,
    ...templateCols("2026-07-06", opts.derived === true),
  });
}

describe.each(TEMPLATE_SHAPES)(
  "day scope: repeating TEMPLATE members (TMPLSORT/PTMPL — the leg family) [$shape]",
  ({ derived }) => {
    it("a to-do template projecting to day D is a `day` member (pre-state)", () => {
      const s = seedDay("S", 0);
      const tt = seedDayTemplate("TT", -50, { derived });
      const pre = computeReorderPre(fixture.db, { scope: "day", uuids: [s, tt] }, null, NOW);
      const ids = pre.members.map((m) => m.uuid);
      expect(ids).toContain(tt);
      expect(ids).toContain(s);
      expect(pre.members.find((m) => m.uuid === tt)?.isTemplate).toBe(true);
      expect(pre.rejected).toHaveLength(0);
    });

    it('interleaves a to-do template (`list "Upcoming"` leg) with scheduled rows (when= legs)', async () => {
      const s1 = seedDay("S1", 0);
      const tt = seedDayTemplate("TT", -50, { derived });
      const { urlVector, tmplVector, calls } = dayTemplateVectors();
      // Target top→bottom: TT (template), S1 (scheduled).
      const result = await runReorder(deps([urlVector, tmplVector]), {
        scope: "day",
        uuids: [tt, s1],
        named: [tt, s1],
      });
      expect(result.kind).toBe("ok");
      // The template rode a `list "Upcoming"` native front-insert; the scheduled row a when= round-trip.
      expect(calls.some((c) => c.includes('list "Upcoming"') && c.includes(tt))).toBe(true);
      expect(calls.some((c) => c.includes(`id=${s1}`) && c.includes("when="))).toBe(true);
      // Landed order matches the target (template on top).
      expect(ascending(ranks([tt, s1]))).toBe(true);
    });

    it("CRASH-PATH LOCK: a template is NEVER compiled onto a when=/deadline leg (§1)", async () => {
      const s1 = seedDay("S1", 0);
      const f1 = seedForecast("F1", -20, 5);
      const tt = seedDayTemplate("TT", -50, { derived });
      const { urlVector, tmplVector, calls } = dayTemplateVectors();
      const result = await runReorder(deps([urlVector, tmplVector]), {
        scope: "day",
        uuids: [tt, s1, f1],
        named: [tt, s1, f1],
      });
      expect(result.kind).toBe("ok");
      // The template id appears ONLY in a `list "Upcoming"` leg — never in a URL leg
      // carrying when= or deadline= (the dated legs that CRASH a template).
      const templateUrlLegs = calls.filter(
        (c) => c.includes(tt) && (c.includes("when=") || c.includes("deadline=")),
      );
      expect(templateUrlLegs).toHaveLength(0);
      expect(calls.some((c) => c.includes('list "Upcoming"') && c.includes(tt))).toBe(true);
      // And never onto a `project id` / `list "Later Projects"` specifier (reparent / poison).
      expect(calls.some((c) => c.includes("project id") && c.includes(tt))).toBe(false);
      expect(calls.some((c) => c.includes('list "Later Projects"'))).toBe(false);
    });

    it("SUFFIX RULE accept: a project template stays byte-untouched as the suffix", async () => {
      const s1 = seedDay("S1", 0);
      const pt = seedDayTemplate("PT", -10, { project: true, derived });
      const beforeUmd = (
        fixture.db
          .prepare("SELECT userModificationDate AS u FROM TMTask WHERE uuid = ?")
          .get(pt) as {
          u: number;
        }
      ).u;
      const { urlVector, tmplVector, calls } = dayTemplateVectors();
      // Target: S1 (movable) ABOVE PT (project template) — the achievable suffix arrangement.
      const result = await runReorder(deps([urlVector, tmplVector]), {
        scope: "day",
        uuids: [s1, pt],
        named: [s1, pt],
      });
      expect(result.kind).toBe("ok");
      // No leg targeted the project template at all (byte-untouched).
      expect(calls.some((c) => c.includes(pt))).toBe(false);
      const ptRow = fixture.db
        .prepare("SELECT todayIndex AS t, userModificationDate AS u FROM TMTask WHERE uuid = ?")
        .get(pt) as { t: number; u: number };
      expect(ptRow.t).toBe(-10); // todayIndex byte-identical
      expect(ptRow.u).toBe(beforeUmd); // umd byte-identical
      // The movable landed ABOVE the untouched project template.
      expect(ranks([s1])[0]!).toBeLessThan(-10);
      if (result.kind === "ok") {
        expect(result.warnings?.some((w) => w.includes("project template"))).toBe(true);
      }
    });

    it("SUFFIX RULE refuse: a project template above a movable names the achievable arrangement", async () => {
      const s1 = seedDay("S1", 0);
      const pt = seedDayTemplate("PT", -10, { project: true, derived });
      const { urlVector, tmplVector, calls } = dayTemplateVectors();
      // Target: PT ABOVE S1 — unreachable (a project template has no headless reach on an
      // arbitrary day; every movable front-inserts above it).
      const result = await runReorder(deps([urlVector, tmplVector]), {
        scope: "day",
        uuids: [pt, s1],
        named: [pt, s1],
      });
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.detail).toContain("PROJECT template");
        expect(result.detail).toContain(`${s1}, ${pt}`); // the achievable arrangement
      }
      expect(calls).toHaveLength(0); // nothing dispatched
    });

    it("SUFFIX RULE refuse: project templates cannot change their relative order", async () => {
      const pt1 = seedDayTemplate("PT1", -20, { project: true, derived });
      const pt2 = seedDayTemplate("PT2", -10, { project: true, derived });
      const { urlVector, tmplVector, calls } = dayTemplateVectors();
      // Current render order (asc todayIndex): PT1, PT2. Target reverses them.
      const result = await runReorder(deps([urlVector, tmplVector]), {
        scope: "day",
        uuids: [pt2, pt1],
        named: [pt2, pt1],
      });
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.detail).toContain("relative order");
      expect(calls).toHaveLength(0);
    });

    it("experimental-OFF: refuses honestly, NAMING the template (never a dated leg)", async () => {
      const s1 = seedDay("S1", 0);
      const tt = seedDayTemplate("TT", -50, { derived });
      const { urlVector, tmplVector, calls } = dayTemplateVectors();
      const result = await runReorder(deps([urlVector, tmplVector], { config: config(false) }), {
        scope: "day",
        uuids: [tt, s1],
        named: [tt, s1],
      });
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.detail).toContain(tt); // names the template
        expect(result.detail).toContain("native private reorder");
      }
      expect(calls).toHaveLength(0); // nothing dispatched — never a crash-path leg
    });

    it("GUARD: a template requested in a `project` scope is refused (never onto `project id`)", async () => {
      const proj = seedProject(fixture.db, { title: "P" });
      const child = seedTodo(fixture.db, { title: "c", project: proj, start: "active", index: 10 });
      const tmpl = seedTodo(fixture.db, {
        title: "TMPL",
        project: proj,
        start: "someday",
        ...templateCols(FUTURE_ISO, derived),
      });
      const { vector, calls } = nativeVector(`"index"`);
      const result = await runReorder(deps([vector]), {
        scope: "project",
        uuids: [tmpl, child],
        container: { uuid: proj },
      });
      expect(result.kind).toBe("blocked");
      // The template never resolves onto a `project id ... with ids <template>` wire.
      expect(calls.some((c) => c.includes(tmpl))).toBe(false);
    });
  },
);

/**
 * FAIL-CLOSED contract for the DERIVED projection day (Things 3.23, DBV27). With
 * `rt1_nextInstanceStartDate` retired, a template whose projection is NOT soundly
 * derivable projects NOWHERE — exactly as a NULL column always meant. It is never
 * guessed onto a day, so it is not a day-block member and no leg is compiled for it.
 */
describe("day scope: an underivable template projection fails closed (DBV27)", () => {
  const seedUnprojectable = (title: string, cols: Record<string, unknown>): string =>
    seedTodo(fixture.db, {
      title,
      start: "someday",
      startDate: null,
      todayIndex: -50,
      instanceCreationStartDate: FUTURE_ISO,
      ...cols,
    });

  const cases: { name: string; cols: Record<string, unknown> }[] = [
    // An undecodable blob (or an rrv the decoder does not know — a format change).
    { name: "an undecodable recurrence rule", cols: { recurrenceRule: true } },
    // After-completion series have no calendar until the prior instance resolves.
    {
      name: "an after-completion rule",
      cols: { recurrenceRuleXml: ruleXml({ tp: 1, fu: 16, fa: 1, anchor: 1_783_000_000 }) },
    },
    // Pause clears the cursor column but RETAINS the anchor (SERDEL S3) — deriving
    // would resurrect a projection the app does not render.
    {
      name: "a PAUSED series",
      cols: { recurrenceRuleXml: DAILY_RULE_XML, instanceCreationPaused: true },
    },
    // Ends-after exhaustion: rc is the immutable configured total, icCount the tally (RRX1).
    {
      name: "an exhausted ends-after series",
      cols: {
        recurrenceRuleXml: ruleXml({ tp: 0, fu: 16, fa: 1, rc: 3, anchor: 1_783_000_000 }),
        instanceCreationCount: 3,
      },
    },
    // Ends-on: the rule's end date is already behind the cursor.
    {
      name: "an ends-on series past its end date",
      cols: {
        recurrenceRuleXml: ruleXml({
          tp: 0,
          fu: 16,
          fa: 1,
          ed: Math.floor(Date.UTC(2026, 5, 30) / 1000),
          anchor: 1_783_000_000,
        }),
      },
    },
    // A cursor the app never set: nothing to project from.
    {
      name: "no spawn cursor",
      cols: { recurrenceRuleXml: DAILY_RULE_XML, instanceCreationStartDate: null },
    },
  ];

  it.each(cases)("$name is not a day-block member", ({ cols }) => {
    const s = seedDay("S", 0);
    const tt = seedUnprojectable("TT", cols);
    const pre = computeReorderPre(fixture.db, { scope: "day", uuids: [s, tt] }, null, NOW);
    expect(pre.members.map((m) => m.uuid)).not.toContain(tt);
    expect(pre.rejected.map((r) => r.uuid)).toContain(tt);
  });

  it("a template projecting to a DIFFERENT day is not a member of day D", () => {
    const s = seedDay("S", 0);
    const other = seedTodo(fixture.db, {
      title: "OTHER",
      start: "someday",
      startDate: null,
      todayIndex: -50,
      recurrenceRuleXml: DAILY_RULE_XML,
      instanceCreationStartDate: "2026-07-21", // D + 2
    });
    const pre = computeReorderPre(fixture.db, { scope: "day", uuids: [s, other] }, null, NOW);
    expect(pre.members.map((m) => m.uuid)).not.toContain(other);
  });

  it("an underivable template requested ALONE yields no day and no members", () => {
    const tt = seedUnprojectable("TT", { recurrenceRule: true });
    const pre = computeReorderPre(fixture.db, { scope: "day", uuids: [tt] }, null, NOW);
    expect(pre.members).toHaveLength(0);
    expect(pre.rejected.map((r) => r.uuid)).toContain(tt);
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

/**
 * Flag-safe MOVE protocol sims (SIT6): FAITHFUL to the HEADMOVE / LOOSEPARK /
 * PROJPARK laws — every leg is a URL/AppleScript MOVE that preserves the flag +
 * reminder + deadline (it never writes start/startDate/startBucket/todayIndex/
 * reminderTime/deadline), and the re-entry legs implement the index geometry:
 *   - unpark (`todo.move loose`) FRONT-inserts at the loose Anytime index min;
 *   - detach (`project.move noArea`) FRONT-inserts at the area-less project min;
 *   - re-head (`todo.move project+heading`) BACK-inserts past the heading max;
 *   - unhead (`todo.move noHeading`) keeps index; park keeps index.
 * project.add mints the scratch project (creationDate stamped at NOW so the
 * create-probe finds it); area.add mints the scratch area; project.delete trashes;
 * area.delete removes the area row. Reads structured op/opParams, never the URL.
 */
function flagSafeVectors(
  opts: { failAt?: { op: string; nth: number }; strayAfterUnpark?: number } = {},
) {
  const calls: string[] = [];
  const db = fixture.db;
  const nowEpoch = Math.floor(NOW.getTime() / 1000);
  const okExec = { exitCode: 0, stdout: "", stderr: "" };
  const failExec = { exitCode: 1, stdout: "", stderr: "simulated leg failure" };
  const yes = {
    support: "yes" as const,
    disruption: 0 as const,
    validation: "validated" as const,
  };
  const opCount = new Map<string, number>();
  let scratchProject: string | null = null;
  let unparkCount = 0;
  const bump = (op: string): number => {
    const n = (opCount.get(op) ?? 0) + 1;
    opCount.set(op, n);
    return n;
  };
  const url: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.move": { ...yes },
      "project.move": { ...yes },
      "project.add": { ...yes },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      if (
        opts.failAt !== undefined &&
        inv.op === opts.failAt.op &&
        bump(inv.op) === opts.failAt.nth
      ) {
        return failExec;
      }
      if (inv.op === "project.add") {
        const p = inv.opParams as { title: string };
        scratchProject = seedProject(db, {
          title: p.title,
          start: "active",
          creationDate: nowEpoch,
          modificationDate: nowEpoch,
        });
      } else if (inv.op === "todo.move") {
        const p = inv.opParams as {
          uuid: string;
          project?: { uuid: string };
          heading?: string;
          loose?: boolean;
          noHeading?: boolean;
        };
        if (p.loose === true) {
          const min = db
            .prepare(
              `SELECT MIN("index") AS m FROM TMTask WHERE type = 0 AND trashed = 0 AND status = 0
               AND project IS NULL AND area IS NULL AND heading IS NULL`,
            )
            .get() as { m: number | null };
          db.prepare(
            `UPDATE TMTask SET project = NULL, area = NULL, heading = NULL, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
          ).run((min.m ?? 0) - 1, modClock++, p.uuid);
          unparkCount++;
          if (opts.strayAfterUnpark === unparkCount && scratchProject !== null) {
            // Simulate a concurrent edit that parks a foreign row into the scratch
            // AFTER all touched rows have unparked — the emptiness guard must catch it.
            seedTodo(db, {
              title: "STRAY",
              project: scratchProject,
              start: "active",
              index: 5,
            });
          }
        } else if (p.noHeading === true) {
          const cur = db.prepare("SELECT heading FROM TMTask WHERE uuid = ?").get(p.uuid) as {
            heading: string | null;
          };
          const proj =
            cur.heading !== null
              ? (
                  db.prepare("SELECT project FROM TMTask WHERE uuid = ?").get(cur.heading) as {
                    project: string | null;
                  }
                ).project
              : null;
          db.prepare(
            `UPDATE TMTask SET heading = NULL, project = ?, area = NULL, userModificationDate = ? WHERE uuid = ?`,
          ).run(proj, modClock++, p.uuid);
        } else if (p.heading !== undefined) {
          const max = db
            .prepare(
              `SELECT MAX("index") AS m FROM TMTask WHERE heading = ? AND trashed = 0 AND status = 0 AND uuid != ?`,
            )
            .get(p.heading, p.uuid) as { m: number | null };
          db.prepare(
            `UPDATE TMTask SET heading = ?, project = NULL, area = NULL, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
          ).run(p.heading, (max.m ?? 0) + 1, modClock++, p.uuid);
        } else if (p.project !== undefined) {
          db.prepare(
            `UPDATE TMTask SET project = ?, heading = NULL, area = NULL, userModificationDate = ? WHERE uuid = ?`,
          ).run(p.project.uuid, modClock++, p.uuid);
        }
      } else if (inv.op === "project.move") {
        const p = inv.opParams as { uuid: string; area?: { uuid: string }; noArea?: boolean };
        if (p.noArea === true) {
          const min = db
            .prepare(
              `SELECT MIN("index") AS m FROM TMTask WHERE type = 1 AND trashed = 0 AND status = 0 AND area IS NULL`,
            )
            .get() as { m: number | null };
          db.prepare(
            `UPDATE TMTask SET area = NULL, "index" = ?, userModificationDate = ? WHERE uuid = ?`,
          ).run((min.m ?? 0) - 1, modClock++, p.uuid);
        } else if (p.area !== undefined) {
          db.prepare(`UPDATE TMTask SET area = ?, userModificationDate = ? WHERE uuid = ?`).run(
            p.area.uuid,
            modClock++,
            p.uuid,
          );
        }
      }
      return okExec;
    },
  };
  const osa: WriteVector = {
    id: "applescript",
    matrix: {
      "area.add": { ...yes },
      "area.delete": { ...yes },
      "project.delete": { ...yes },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      if (
        opts.failAt !== undefined &&
        inv.op === opts.failAt.op &&
        bump(inv.op) === opts.failAt.nth
      ) {
        return failExec;
      }
      if (inv.op === "area.add") {
        const p = inv.opParams as { title: string };
        seedArea(db, p.title);
      } else if (inv.op === "area.delete") {
        const p = inv.opParams as { target: string };
        db.prepare("DELETE FROM TMArea WHERE uuid = ?").run(p.target);
      } else if (inv.op === "project.delete") {
        const p = inv.opParams as { uuid: string };
        db.prepare("UPDATE TMTask SET trashed = 1, userModificationDate = ? WHERE uuid = ?").run(
          modClock++,
          p.uuid,
        );
      }
      return okExec;
    },
  };
  return { url, osa, calls, scratch: () => scratchProject };
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

// ------------------------------- flag-safe MOVE protocols (SIT6 HEADMOVE/LOOSEPARK)
//
// When a touched set on one of the three json-collapsible index bounces carries a
// Today/Evening flag, the planner SWAPS the de-Today bounce for the lab-proven
// flag-safe MOVE twin (unhead→re-head / park→unpark / park→detach). The unflagged
// path keeps the cheaper bounce — proven by every existing bounce test above, which
// has no flagged rows and must NOT be grabbed by the swap. (PROJPARK is covered in
// the projects-scope block above.)

describe("HEADMOVE (SIT6 — flagged within-heading anytime children)", () => {
  function seedFlaggedHeading() {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const c1 = seedTodo(fixture.db, { title: "c1", heading, start: "active", index: 10 });
    // c2 is Today-flagged (start=1, startDate=today) + reminder + deadline.
    const c2 = seedTodo(fixture.db, {
      title: "c2",
      heading,
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: -9,
      reminder: "09:00",
      deadline: "2026-07-10",
      index: 20,
    });
    const c3 = seedTodo(fixture.db, { title: "c3", heading, start: "active", index: 30 });
    return { proj, heading, c1, c2, c3 };
  }

  it("routes a flagged mixed set through unhead→re-head, flag+reminder+deadline preserved", async () => {
    const { heading, c1, c2, c3 } = seedFlaggedHeading();
    const { url, osa, calls } = flagSafeVectors();
    const result = await runReorder(deps([url, osa]), {
      scope: "heading",
      container: { uuid: heading },
      uuids: [c2, c3, c1],
      named: [c2, c3, c1],
    });
    expect(result.kind).toBe("ok");
    // Unhead ×3 then re-head ×3 — six todo.move legs, NO when= / json leg.
    expect(calls).toEqual(Array(6).fill("todo.move"));
    expect(ascending(ranks([c2, c3, c1], `"index"`))).toBe(true);
    const row = fixture.db
      .prepare(
        "SELECT start, startDate, todayIndex, reminderTime, deadline, heading FROM TMTask WHERE uuid = ?",
      )
      .get(c2) as {
      start: number;
      startDate: number | null;
      todayIndex: number;
      reminderTime: number | null;
      deadline: number | null;
      heading: string | null;
    };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
    expect(row.todayIndex).toBe(-9);
    expect(row.reminderTime).not.toBeNull();
    expect(row.deadline).not.toBeNull();
    expect(row.heading).toBe(heading);
  });

  it("dry-run describes the HEADMOVE legs without executing", async () => {
    const { heading, c1, c2, c3 } = seedFlaggedHeading();
    const { url, osa, calls } = flagSafeVectors();
    const result = await runReorder(
      deps([url, osa]),
      { scope: "heading", container: { uuid: heading }, uuids: [c2, c3, c1], named: [c2, c3, c1] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("HEADMOVE");
      expect(result.plan.invocation).toContain("re-head");
    }
    expect(calls).toHaveLength(0);
  });

  it("aborts loudly if a re-head leg fails — rows left UNHEADED in the project root", async () => {
    const { heading, c1, c2, c3 } = seedFlaggedHeading();
    // Fail the 5th todo.move (3 unhead + rehead #2).
    const { url, osa } = flagSafeVectors({ failAt: { op: "todo.move", nth: 5 } });
    const result = await runReorder(deps([url, osa]), {
      scope: "heading",
      container: { uuid: heading },
      uuids: [c2, c3, c1],
      named: [c2, c3, c1],
    });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") {
      expect(result.detail).toContain("UNHEADED");
    }
    void c1;
  });
});

describe("LOOSEPARK (SIT6 — flagged area-less loose anytime to-dos)", () => {
  function seedFlaggedLoose() {
    const l1 = seedTodo(fixture.db, { title: "l1", start: "active", index: 10 });
    const l2 = seedTodo(fixture.db, {
      title: "l2",
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: -9,
      reminder: "09:00",
      deadline: "2026-07-10",
      index: 20,
    });
    const l3 = seedTodo(fixture.db, { title: "l3", start: "active", index: 30 });
    return { l1, l2, l3 };
  }

  it("routes a flagged set through park→unpark (reverse target), star preserved, scratch trashed", async () => {
    const { l1, l2, l3 } = seedFlaggedLoose();
    const { url, osa, calls } = flagSafeVectors();
    const result = await runReorder(deps([url, osa]), {
      scope: "anytime",
      uuids: [l3, l1, l2],
      named: [l3, l1, l2],
    });
    expect(result.kind).toBe("ok");
    // Scratch project + park ×3 + unpark ×3 + project trash — NO when= leg.
    expect(calls).toContain("project.add");
    expect(calls.filter((c) => c === "todo.move")).toHaveLength(6);
    expect(calls).toContain("project.delete");
    expect(ascending(ranks([l3, l1, l2], `"index"`))).toBe(true);
    const row = fixture.db
      .prepare(
        "SELECT start, startDate, todayIndex, reminderTime, deadline, project FROM TMTask WHERE uuid = ?",
      )
      .get(l2) as {
      start: number;
      startDate: number | null;
      todayIndex: number;
      reminderTime: number | null;
      deadline: number | null;
      project: string | null;
    };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
    expect(row.todayIndex).toBe(-9);
    expect(row.reminderTime).not.toBeNull();
    expect(row.deadline).not.toBeNull();
    expect(row.project).toBeNull(); // unparked back to loose
    if (result.kind === "ok") {
      expect(result.warnings?.some((w) => w.includes("Trash"))).toBe(true);
    }
  });

  it("refuses to trash a NON-empty scratch (teardown verify-empty; AREADEL guard)", async () => {
    const { l1, l2, l3 } = seedFlaggedLoose();
    // A concurrent edit parks a foreign row into the scratch after the 3rd unpark.
    const { url, osa, calls } = flagSafeVectors({ strayAfterUnpark: 3 });
    const result = await runReorder(deps([url, osa]), {
      scope: "anytime",
      uuids: [l3, l1, l2],
      named: [l3, l1, l2],
    });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") {
      expect(result.detail).toContain("still holds 1 parked item");
      expect(result.detail).toContain("refusing to trash");
    }
    // The scratch was NEVER trashed (no project.delete leg ran).
    expect(calls).not.toContain("project.delete");
  });

  it("aborts loudly if a park leg fails — rows left PARKED in the named scratch", async () => {
    const { l1, l2, l3 } = seedFlaggedLoose();
    // Fail the 2nd todo.move (park #2); parks precede unparks.
    const { url, osa, calls } = flagSafeVectors({ failAt: { op: "todo.move", nth: 2 } });
    const result = await runReorder(deps([url, osa]), {
      scope: "anytime",
      uuids: [l3, l1, l2],
      named: [l3, l1, l2],
    });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") {
      expect(result.detail).toContain("PARKED");
    }
    expect(calls).not.toContain("project.delete");
    void l1;
    void l2;
    void l3;
  });
});

describe("flag-safe protocol undo (pre-ranks invertible via re-run)", () => {
  it("LOOSEPARK undo restores the prior loose Anytime order", async () => {
    const l1 = seedTodo(fixture.db, { title: "l1", start: "active", index: 10 });
    const l2 = seedTodo(fixture.db, {
      title: "l2",
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: -9,
      index: 20,
    });
    const l3 = seedTodo(fixture.db, { title: "l3", start: "active", index: 30 });
    const fwd = await runReorder(deps(twoVectors()), {
      scope: "anytime",
      uuids: [l3, l1, l2],
      named: [l3, l1, l2],
    });
    expect(fwd.kind).toBe("ok");
    const summary = auditRecords.find((r) => r.op === "reorder" && r.txn?.role === "summary");
    const plan = planUndo(summary as NonNullable<typeof summary>, NOW);
    expect(plan.kind).toBe("invertible");
    const inv = await runReorder(
      deps(twoVectors()),
      plan.steps[0]?.params as unknown as ReorderParams,
    );
    expect(inv.kind).toBe("ok");
    // Restored to the original relative order l1 < l2 < l3.
    expect(ascending(ranks([l1, l2, l3], `"index"`))).toBe(true);
  });

  it("PROJPARK undo restores the prior sidebar order", async () => {
    const pf = seedProject(fixture.db, {
      title: "PF",
      startDate: TODAY_ISO,
      index: 10,
      todayIndex: -5,
    });
    const p2 = seedProject(fixture.db, { title: "P2", index: 20 });
    const p3 = seedProject(fixture.db, { title: "P3", index: 30 });
    const fwd = await runReorder(deps(twoVectors()), {
      scope: "projects",
      uuids: [p3, pf, p2],
      named: [p3, pf, p2],
    });
    expect(fwd.kind).toBe("ok");
    const summary = auditRecords.find((r) => r.op === "reorder" && r.txn?.role === "summary");
    const plan = planUndo(summary as NonNullable<typeof summary>, NOW);
    expect(plan.kind).toBe("invertible");
    const inv = await runReorder(
      deps(twoVectors()),
      plan.steps[0]?.params as unknown as ReorderParams,
    );
    expect(inv.kind).toBe("ok");
    expect(ascending(ranks([pf, p2, p3], `"index"`))).toBe(true);
  });
});

// -------------------------------------------- SIT7 SOMEBACK / INBOXBACK / AREABACK

/**
 * SOMEBACK someday-bounce sim (SIT7): the anytime↔someday `when=` round-trip. The
 * `when=someday` placement leg FRONT-inserts at the loose someday `index` min for the
 * row's KIND (loose to-do OR area-less project — per-type leg op), start=2 preserved;
 * `when=anytime` is the transient away leg (start=1, no reindex).
 */
function somedayBounceVector() {
  const calls: string[] = [];
  const db = fixture.db;
  const apply = (id: string, when: string): void => {
    const row = db.prepare("SELECT type FROM TMTask WHERE uuid = ?").get(id) as { type: number };
    const start = when === "someday" ? 2 : 1;
    db.prepare(
      "UPDATE TMTask SET start = ?, startDate = NULL, userModificationDate = ? WHERE uuid = ?",
    ).run(start, modClock++, id);
    if (when === "someday") {
      const where =
        row.type === 1
          ? "type = 1 AND area IS NULL AND start = 2 AND startDate IS NULL"
          : "type = 0 AND project IS NULL AND area IS NULL AND heading IS NULL AND start = 2 AND startDate IS NULL";
      const min = db
        .prepare(
          `SELECT MIN("index") AS m FROM TMTask WHERE trashed = 0 AND status = 0 AND uuid != ? AND ${where}`,
        )
        .get(id) as { m: number | null };
      db.prepare(`UPDATE TMTask SET "index" = ?, userModificationDate = ? WHERE uuid = ?`).run(
        (min.m ?? 0) - 1,
        modClock++,
        id,
      );
    }
  };
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.payload);
      const url = new URL(inv.payload);
      apply(url.searchParams.get("id") ?? "", url.searchParams.get("when") ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

describe("someday scope: SOMEBACK bounce fallback (SIT7 — native unavailable)", () => {
  it("front-inserts loose someday to-dos via a REVERSE-order anytime↔someday bounce", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "someday", index: 20 });
    const c = seedTodo(fixture.db, { title: "c", start: "someday", index: 30 });
    const { vector, calls } = somedayBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "someday",
      uuids: [c, a, b],
      named: [c, a, b],
    });
    expect(result.kind).toBe("ok");
    // Reverse (front-insert): first bounced is b, legs when=anytime→when=someday.
    expect(calls[0]).toContain(`id=${b}`);
    expect(calls[0]).toContain("when=anytime");
    expect(calls[1]).toContain("when=someday");
    expect(ascending(ranks([c, a, b], `"index"`))).toBe(true);
    for (const u of [a, b, c]) {
      const row = fixture.db
        .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
        .get(u) as {
        start: number;
        startDate: number | null;
      };
      expect(row.start).toBe(2);
      expect(row.startDate).toBeNull();
    }
    if (result.kind === "ok") {
      expect(result.warnings?.some((w) => w.includes("SOMEBACK"))).toBe(true);
    }
  });

  it("front-inserts area-less someday PROJECTS via the per-type (update-project) bounce", async () => {
    const p1 = seedProject(fixture.db, { title: "P1", start: "someday", index: 10 });
    const p2 = seedProject(fixture.db, { title: "P2", start: "someday", index: 20 });
    const p3 = seedProject(fixture.db, { title: "P3", start: "someday", index: 30 });
    const { vector } = somedayBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "someday",
      uuids: [p3, p1, p2],
      named: [p3, p1, p2],
    });
    expect(result.kind).toBe("ok");
    expect(ascending(ranks([p3, p1, p2], `"index"`))).toBe(true);
    for (const u of [p1, p2, p3]) {
      const row = fixture.db
        .prepare("SELECT start, type, area FROM TMTask WHERE uuid = ?")
        .get(u) as {
        start: number;
        type: number;
        area: string | null;
      };
      expect(row.start).toBe(2);
      expect(row.type).toBe(1);
      expect(row.area).toBeNull();
    }
  });

  it("explicit --strategy bounce routes to SOMEBACK too", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "someday", index: 20 });
    const { vector } = somedayBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "someday",
      strategy: "bounce",
      uuids: [b, a],
      named: [b, a],
    });
    expect(result.kind).toBe("ok");
    expect(ascending(ranks([b, a], `"index"`))).toBe(true);
  });

  it("rejects a mixed to-do + project someday set", async () => {
    const todo = seedTodo(fixture.db, { title: "t", start: "someday", index: 1 });
    const proj = seedProject(fixture.db, { title: "sp", start: "someday", index: 2 });
    const { vector } = somedayBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "someday",
      uuids: [todo, proj],
      named: [todo, proj],
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("same-type");
  });
});

describe("inbox scope: INBOXBACK move fallback (SIT7 — native unavailable)", () => {
  const seedInbox = (title: string, index: number) =>
    seedTodo(fixture.db, { title, start: "inbox", index });

  it("park + Inbox-return (reverse) front-inserts, restores start=0, lands the order", async () => {
    const a = seedInbox("a", 10);
    const b = seedInbox("b", 20);
    const c = seedInbox("c", 30);
    const { url, osa, calls } = sit7BackVectors();
    const result = await runReorder(deps([url, osa], { config: config(false) }), {
      scope: "inbox",
      uuids: [c, a, b],
      named: [c, a, b],
    });
    expect(result.kind).toBe("ok");
    // scratch project + park ×3 + Inbox-return ×3 + trash — NO when= leg.
    expect(calls).toContain("project.add");
    expect(calls.filter((op) => op === "todo.move")).toHaveLength(6);
    expect(calls).toContain("project.delete");
    expect(ascending(ranks([c, a, b], `"index"`))).toBe(true);
    for (const u of [a, b, c]) {
      const row = fixture.db
        .prepare("SELECT start, project, area, heading FROM TMTask WHERE uuid = ?")
        .get(u) as {
        start: number;
        project: string | null;
        area: string | null;
        heading: string | null;
      };
      expect(row.start).toBe(0); // start=0 restored
      expect(row.project).toBeNull();
      expect(row.area).toBeNull();
      expect(row.heading).toBeNull();
    }
    if (result.kind === "ok")
      expect(result.warnings?.some((w) => w.includes("INBOXBACK"))).toBe(true);
  });

  it("dry-run describes the INBOXBACK legs without executing", async () => {
    const a = seedInbox("a", 10);
    const { url, osa, calls } = sit7BackVectors();
    const result = await runReorder(
      deps([url, osa], { config: config(false) }),
      { scope: "inbox", uuids: [a] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("INBOXBACK");
      expect(result.plan.invocation).toContain("Inbox-return");
    }
    expect(calls).toHaveLength(0);
  });

  it("aborts cleanly if the scratch project cannot be created — nothing parked", async () => {
    const a = seedInbox("a", 10);
    const b = seedInbox("b", 20);
    const { url, osa, calls } = sit7BackVectors({ failAt: { op: "project.add", nth: 1 } });
    const result = await runReorder(deps([url, osa], { config: config(false) }), {
      scope: "inbox",
      uuids: [a, b],
      named: [a, b],
    });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") expect(result.detail).toContain("no changes were made");
    // No rows parked, no scratch trashed.
    expect(calls).not.toContain("todo.move");
    expect(calls).not.toContain("project.delete");
    // Inbox order untouched.
    expect(ranks([a, b], `"index"`)).toEqual([10, 20]);
  });

  it("aborts loudly if a park leg fails — rows left PARKED in the named scratch", async () => {
    const a = seedInbox("a", 10);
    const b = seedInbox("b", 20);
    // Fail the 2nd todo.move overall (park #2) — a park failure strands rows in the scratch.
    const { url, osa, calls } = sit7BackVectors({ failAt: { op: "todo.move", nth: 2 } });
    const result = await runReorder(deps([url, osa], { config: config(false) }), {
      scope: "inbox",
      uuids: [a, b],
      named: [a, b],
    });
    expect(result.kind).toBe("bounce-aborted");
    if (result.kind === "bounce-aborted") expect(result.detail).toContain("PARKED");
    expect(calls).not.toContain("project.delete");
  });
});

describe("area scope: AREABACK move fallback (SIT7 — native unavailable)", () => {
  it("to-dos: park to scratch project + re-home (reverse) front-inserts, area FK + flag kept", async () => {
    const area = seedArea(fixture.db, "Work");
    const a = seedTodo(fixture.db, { title: "a", area, start: "active", index: 10 });
    // b is Today-flagged + reminder + deadline (the move round-trip is flag-safe).
    const b = seedTodo(fixture.db, {
      title: "b",
      area,
      start: "active",
      startDate: TODAY_ISO,
      todayIndex: -9,
      reminder: "09:00",
      deadline: "2026-07-10",
      index: 20,
    });
    const c = seedTodo(fixture.db, { title: "c", area, start: "active", index: 30 });
    const { url, osa, calls } = sit7BackVectors();
    const result = await runReorder(deps([url, osa], { config: config(false) }), {
      scope: "area",
      container: { uuid: area },
      uuids: [c, a, b],
      named: [c, a, b],
    });
    expect(result.kind).toBe("ok");
    // scratch project + park ×3 + re-home ×3 + trash — NO when= leg.
    expect(calls).toContain("project.add");
    expect(calls.filter((op) => op === "todo.move")).toHaveLength(6);
    expect(calls).toContain("project.delete");
    expect(ascending(ranks([c, a, b], `"index"`))).toBe(true);
    const row = fixture.db
      .prepare(
        "SELECT start, startDate, todayIndex, reminderTime, deadline, area FROM TMTask WHERE uuid = ?",
      )
      .get(b) as {
      start: number;
      startDate: number | null;
      todayIndex: number;
      reminderTime: number | null;
      deadline: number | null;
      area: string;
    };
    expect(row.start).toBe(1);
    expect(row.startDate).toBe(PACKED_TODAY);
    expect(row.todayIndex).toBe(-9);
    expect(row.reminderTime).not.toBeNull();
    expect(row.deadline).not.toBeNull();
    expect(row.area).toBe(area);
    if (result.kind === "ok")
      expect(result.warnings?.some((w) => w.includes("AREABACK"))).toBe(true);
  });

  it("projects: park to scratch AREA + re-home (reverse) front-inserts, area FK kept, scratch deleted", async () => {
    const area = seedArea(fixture.db, "Work");
    const p1 = seedProject(fixture.db, { title: "P1", area, index: 10 });
    const p2 = seedProject(fixture.db, { title: "P2", area, index: 20 });
    const p3 = seedProject(fixture.db, { title: "P3", area, index: 30 });
    const { url, osa, calls } = sit7BackVectors();
    const result = await runReorder(deps([url, osa], { config: config(false) }), {
      scope: "area",
      container: { uuid: area },
      uuids: [p3, p1, p2],
      named: [p3, p1, p2],
    });
    expect(result.kind).toBe("ok");
    // scratch AREA + park ×3 + re-home ×3 + area delete — project.move legs.
    expect(calls).toContain("area.add");
    expect(calls.filter((op) => op === "project.move")).toHaveLength(6);
    expect(calls).toContain("area.delete");
    expect(ascending(ranks([p3, p1, p2], `"index"`))).toBe(true);
    for (const u of [p1, p2, p3]) {
      const row = fixture.db.prepare("SELECT area, type FROM TMTask WHERE uuid = ?").get(u) as {
        area: string;
        type: number;
      };
      expect(row.area).toBe(area);
      expect(row.type).toBe(1);
    }
  });

  it("dry-run describes the AREABACK legs without executing", async () => {
    const area = seedArea(fixture.db, "Work");
    const a = seedTodo(fixture.db, { title: "a", area, start: "active", index: 10 });
    const { url, osa, calls } = sit7BackVectors();
    const result = await runReorder(
      deps([url, osa], { config: config(false) }),
      { scope: "area", container: { uuid: area }, uuids: [a] },
      { dryRun: true },
    );
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain("AREABACK");
      expect(result.plan.invocation).toContain("re-home");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("container-day scope: dated day-bounce fallback (SIT7 — native unavailable)", () => {
  it("degrades to the pure-URL dated bounce when experimental is off", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      start: "someday",
      startDate: "2026-07-10",
      todayIndex: 30,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "someday",
      startDate: "2026-07-10",
      todayIndex: 10,
    });
    const c = seedTodo(fixture.db, {
      title: "c",
      project: proj,
      start: "someday",
      startDate: "2026-07-10",
      todayIndex: 20,
    });
    const { vector, calls } = datedBounceVector();
    const result = await runReorder(deps([vector], { config: config(false) }), {
      scope: "container-day",
      container: { uuid: proj },
      uuids: [b, c, a],
      named: [b, c, a],
    });
    expect(result.kind).toBe("ok");
    expect(calls.some((c2) => c2.includes("when=2026-07-10"))).toBe(true);
    expect(ascending(ranks([b, c, a]))).toBe(true);
    if (result.kind === "ok") {
      expect(result.warnings?.some((w) => w.includes("dated-day-bounce"))).toBe(true);
    }
  });
});

describe("SIT7 fallback routing (experimental on → native, off / canary-fail → fallback)", () => {
  it("inbox: experimental ON runs the native reorder command", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "inbox", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "inbox", index: 20 });
    const { vector, calls } = nativeVector(`"index"`);
    const result = await runReorder(deps([vector]), { scope: "inbox", uuids: [b, a] });
    expect(result.kind).toBe("ok");
    expect(calls[0]).toContain('list "Inbox"');
    expect(calls[0]).toContain("with ids");
  });

  it("inbox: sdef canary FAIL (experimental on) still routes to INBOXBACK", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "inbox", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "inbox", index: 20 });
    const { url, osa, calls } = sit7BackVectors();
    // allowExperimental=true but the sdef canary fails → native unavailable.
    const result = await runReorder(
      deps([url, osa], { config: config(true), sdefProbe: () => false }),
      {
        scope: "inbox",
        uuids: [b, a],
        named: [b, a],
      },
    );
    expect(result.kind).toBe("ok");
    expect(calls).toContain("project.add"); // INBOXBACK ran, not the native command
    expect(ascending(ranks([b, a], `"index"`))).toBe(true);
  });

  it("area: sdef canary FAIL routes to AREABACK", async () => {
    const area = seedArea(fixture.db, "Work");
    const a = seedTodo(fixture.db, { title: "a", area, start: "active", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", area, start: "active", index: 20 });
    const { url, osa, calls } = sit7BackVectors();
    const result = await runReorder(
      deps([url, osa], { config: config(true), sdefProbe: () => false }),
      {
        scope: "area",
        container: { uuid: area },
        uuids: [b, a],
        named: [b, a],
      },
    );
    expect(result.kind).toBe("ok");
    expect(calls).toContain("project.add");
    expect(ascending(ranks([b, a], `"index"`))).toBe(true);
  });

  it("the move fallbacks require bounce-enabled (shared move gate)", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "inbox", index: 10 });
    const { url, osa, calls } = sit7BackVectors();
    const result = await runReorder(
      deps([url, osa], { config: { ...config(false), bounceEnabled: false } }),
      { scope: "inbox", uuids: [a] },
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.detail).toContain("bounce-enabled=false");
    expect(calls).toHaveLength(0);
  });
});

describe("SIT7 fallback undo (pre-ranks invertible via re-run)", () => {
  it("INBOXBACK undo restores the prior inbox order", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "inbox", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "inbox", index: 20 });
    const c = seedTodo(fixture.db, { title: "c", start: "inbox", index: 30 });
    const fwd = await runReorder(deps(sit7Pair(), { config: config(false) }), {
      scope: "inbox",
      uuids: [c, a, b],
      named: [c, a, b],
    });
    expect(fwd.kind).toBe("ok");
    const summary = auditRecords.find((r) => r.op === "reorder" && r.txn?.role === "summary");
    const plan = planUndo(summary as NonNullable<typeof summary>, NOW);
    expect(plan.kind).toBe("invertible");
    const inv = await runReorder(
      deps(sit7Pair(), { config: config(false) }),
      plan.steps[0]?.params as unknown as ReorderParams,
    );
    expect(inv.kind).toBe("ok");
    expect(ascending(ranks([a, b, c], `"index"`))).toBe(true);
  });
});

/** A fresh SIT7 back-fake pair (helper for undo round-trips). */
function sit7Pair(): WriteVector[] {
  const { url, osa } = sit7BackVectors();
  return [url, osa];
}

/** Both flag-safe fake vectors as a fresh pair (helper for undo round-trips). */
function twoVectors(): WriteVector[] {
  const { url, osa } = flagSafeVectors();
  return [url, osa];
}
