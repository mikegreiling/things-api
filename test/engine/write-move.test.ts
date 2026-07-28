/**
 * write.move / write.reorder engine tests (spec §4/§5). The orchestrators
 * compile onto the todo.move / project.move / reorder wire primitives, so the
 * FakeVectors here simulate exactly those: a membership vector applies the
 * container change from the STRUCTURED op params (invocation.op/opParams — set
 * by the pipeline for every non-simulating vector), and a native-reorder vector
 * assigns ascending ranks to the wire id list. The six core rules, the detach
 * family teaching errors, homogeneity, anchor guards, and the placement-honesty
 * class are all exercised end-to-end through runTodoMove / runProjectMove /
 * runInPlaceReorder.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import type { ResolvedScope } from "../../src/read/scope.ts";
import { encodePackedDate } from "../../src/model/dates.ts";
import { runInPlaceReorder, runProjectMove, runTodoMove } from "../../src/write/move.ts";
import type { WriteDeps } from "../../src/write/pipeline.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const TODAY_PACKED = encodePackedDate("2026-07-05");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;
let modClock = 1_790_000_000;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => fixture.close());

function okFingerprint(): FingerprintStatus {
  return { kind: "ok", observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:t" } };
}

function config(): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 1,
    actor: "test-actor",
    auditEnabled: true,
    acceptedFingerprint: null,
    allowExperimental: true,
    bounceEnabled: true,
    bounceMaxItems: 30,
    ui: { enabled: false },
    host: "test-host",
  };
}

/**
 * Faithful index/todayIndex bounce sim for the when= legs (BOUNCE2 re-entry
 * law): a return leg FRONT-inserts a loose/area-direct item (min−1) and
 * BACK-inserts a heading/project child (max+1).
 */
function bounceLeg(uuid: string, when: string): void {
  const row = fixture.db
    .prepare("SELECT heading, project, area FROM TMTask WHERE uuid = ?")
    .get(uuid) as { heading: string | null; project: string | null; area: string | null };
  let start = 1;
  let startDate: number | null = null;
  let startBucket = 0;
  if (when === "someday") start = 2;
  else if (when === "today") startDate = TODAY_PACKED;
  else if (when === "evening") {
    startDate = TODAY_PACKED;
    startBucket = 1;
  }
  fixture.db
    .prepare(
      "UPDATE TMTask SET start=?, startDate=?, startBucket=?, userModificationDate=? WHERE uuid=?",
    )
    .run(start, startDate, startBucket, modClock++, uuid);
  let where: string | null = null;
  const binds: (string | number)[] = [];
  let back = false;
  let col = `"index"`;
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
  } else if (when === "anytime" && row.project == null && row.area == null && row.heading == null) {
    where =
      "project IS NULL AND area IS NULL AND heading IS NULL AND start = 1 AND startDate IS NULL";
  }
  if (where != null) {
    const sib = fixture.db
      .prepare(
        `SELECT MIN(${col}) AS mn, MAX(${col}) AS mx FROM TMTask
         WHERE trashed=0 AND status=0 AND type=0 AND uuid != ? AND ${where}`,
      )
      .get(uuid, ...binds) as { mn: number | null; mx: number | null };
    const next = back ? (sib.mx ?? 0) + 1 : (sib.mn ?? 0) - 1;
    fixture.db
      .prepare(`UPDATE TMTask SET ${col} = ?, userModificationDate = ? WHERE uuid = ?`)
      .run(next, modClock++, uuid);
  }
}

/** Membership vector: applies todo.move / project.move + bounce when= legs. */
function membershipVector(): WriteVector {
  return {
    id: "url-scheme",
    matrix: {
      "todo.move": { support: "yes", disruption: 0, validation: "validated" },
      "project.move": { support: "yes", disruption: 0, validation: "validated" },
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(invocation) {
      const p = invocation.opParams as Record<string, unknown>;
      const uuid = p["uuid"] as string;
      if (invocation.op === "todo.update" || invocation.op === "project.update") {
        bounceLeg(uuid, String(p["when"] ?? ""));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const set = (cols: string, ...binds: (string | number | null)[]) =>
        fixture.db
          .prepare(`UPDATE TMTask SET ${cols}, userModificationDate = ? WHERE uuid = ?`)
          .run(...binds, modClock++, uuid);
      const containerUuid = (ref: unknown): string | null => {
        const r = ref as { uuid?: string; title?: string } | undefined;
        if (r?.uuid !== undefined) {
          const byUuid = fixture.db
            .prepare("SELECT uuid FROM TMTask WHERE uuid = ?")
            .get(r.uuid) as { uuid: string } | undefined;
          if (byUuid !== undefined) return byUuid.uuid;
          const byUuidA = fixture.db
            .prepare("SELECT uuid FROM TMArea WHERE uuid = ?")
            .get(r.uuid) as { uuid: string } | undefined;
          if (byUuidA !== undefined) return byUuidA.uuid;
        }
        return r?.uuid ?? null;
      };
      if (invocation.op === "todo.move") {
        if (p["inbox"] === true)
          set("start = 0, startDate = NULL, project = NULL, area = NULL, heading = NULL");
        else if (p["loose"] === true) set("project = NULL, area = NULL, heading = NULL");
        else if (p["noHeading"] === true) {
          const row = fixture.db
            .prepare("SELECT project, heading FROM TMTask WHERE uuid = ?")
            .get(uuid) as {
            project: string | null;
            heading: string | null;
          };
          const cur =
            row.project ??
            (row.heading != null
              ? ((
                  fixture.db
                    .prepare("SELECT project FROM TMTask WHERE uuid = ?")
                    .get(row.heading) as {
                    project: string | null;
                  }
                )?.project ?? null)
              : null);
          set("heading = NULL, area = NULL, project = ?", cur);
        } else if (p["heading"] !== undefined) {
          set(
            "heading = ?, project = ?, area = NULL",
            p["heading"] as string,
            containerUuid(p["project"]),
          );
        } else if (p["project"] !== undefined) {
          set("project = ?, heading = NULL, area = NULL", containerUuid(p["project"]));
        } else if (p["area"] !== undefined) {
          set("area = ?, project = NULL, heading = NULL", containerUuid(p["area"]));
        }
      } else if (invocation.op === "project.move") {
        if (p["noArea"] === true) set("area = NULL");
        else if (p["area"] !== undefined) set("area = ?", containerUuid(p["area"]));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

/** Native reorder vector: assigns ascending ranks to the wire id list. */
function reorderVector(rankCol: `"index"` | "todayIndex" = `"index"`): WriteVector {
  return {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
    },
    async execute(invocation) {
      const matches = [...invocation.payload.matchAll(/with ids "([^"]+)"/g)];
      const ids = matches.at(-1)?.[1]?.split(",") ?? [];
      let rank = 1;
      for (const uuid of ids) {
        fixture.db
          .prepare(`UPDATE TMTask SET ${rankCol} = ?, userModificationDate = ? WHERE uuid = ?`)
          .run(rank++, modClock++, uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function deps(overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    db: fixture.db,
    vectors: [membershipVector(), reorderVector()],
    config: config(),
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-move-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    sdefProbe: () => true,
    ...overrides,
  };
}

function indexOrder(uuids: string[], col = `"index"`): number[] {
  return uuids.map(
    (u) =>
      (fixture.db.prepare(`SELECT ${col} AS r FROM TMTask WHERE uuid = ?`).get(u) as { r: number })
        .r,
  );
}
function ascending(nums: number[]): boolean {
  return nums.every((n, i) => i === 0 || (nums[i - 1] as number) < n);
}
function containerOf(uuid: string): {
  project: string | null;
  area: string | null;
  heading: string | null;
} {
  return fixture.db
    .prepare("SELECT project, area, heading FROM TMTask WHERE uuid = ?")
    .get(uuid) as { project: string | null; area: string | null; heading: string | null };
}

// ------------------------------------------------------------- core rules

describe("rule 1/4: membership move — selection order = landing order", () => {
  it("moves a block into a project unheaded, top-of-bucket, in argument order (guaranteed)", async () => {
    const dest = seedProject(fixture.db, { title: "Dest" });
    seedTodo(fixture.db, { title: "resident", project: dest, index: 100 });
    const t1 = seedTodo(fixture.db, { title: "T1", start: "inbox", index: 1 });
    const t2 = seedTodo(fixture.db, { title: "T2", start: "inbox", index: 2 });
    const t3 = seedTodo(fixture.db, { title: "T3", start: "inbox", index: 3 });
    const result = await runTodoMove(deps(), {
      uuids: [t3, t1, t2],
      destination: { kind: "project", ref: { uuid: dest } },
    });
    expect(result.kind).toBe("move-ok");
    if (result.kind === "move-ok") expect(result.placementClass).toBe("guaranteed");
    for (const t of [t1, t2, t3]) expect(containerOf(t).project).toBe(dest);
    // Landed at the top in selection order t3, t1, t2 (resident pushed below).
    expect(ascending(indexOrder([t3, t1, t2]))).toBe(true);
  });

  it("reversal costs nothing — naming them backwards reverses the landing order", async () => {
    // Naming d before c lands d above c (selection order = landing order).
    const dest2 = seedProject(fixture.db, { title: "Dest2" });
    const c = seedTodo(fixture.db, { title: "C", start: "inbox", index: 1 });
    const d = seedTodo(fixture.db, { title: "D", start: "inbox", index: 2 });
    await runTodoMove(deps(), {
      uuids: [d, c],
      destination: { kind: "project", ref: { uuid: dest2 } },
    });
    const [rd, rc] = indexOrder([d, c]);
    expect(rd).toBeLessThan(rc as number);
  });
});

describe("rule 5: placement honesty class in the result payload", () => {
  it("into a HEADING is app-default (no HEADORD protocol) — membership still lands", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const t = seedTodo(fixture.db, { title: "T", start: "inbox" });
    const result = await runTodoMove(deps(), {
      uuids: [t],
      destination: { kind: "heading", sel: heading, project: { uuid: proj } },
    });
    expect(result.kind).toBe("move-ok");
    if (result.kind === "move-ok") {
      expect(result.placementClass).toBe("app-default");
      expect(result.note).toContain("heading");
    }
    expect(containerOf(t).heading).toBe(heading);
  });

  it("without allow-experimental the project placement degrades to app-default (honest note)", async () => {
    const dest = seedProject(fixture.db, { title: "P" });
    const t = seedTodo(fixture.db, { title: "T", start: "inbox" });
    const result = await runTodoMove(deps({ config: { ...config(), allowExperimental: false } }), {
      uuids: [t],
      destination: { kind: "project", ref: { uuid: dest } },
    });
    expect(result.kind).toBe("move-ok");
    if (result.kind === "move-ok") {
      expect(result.placementClass).toBe("app-default");
      expect(result.note).toContain("allow-experimental");
    }
    expect(containerOf(t).project).toBe(dest); // membership always succeeds
  });
});

describe("rule 3: homogeneity", () => {
  it("mixing a project into a `todo move` is a usage error naming the offender", async () => {
    const t = seedTodo(fixture.db, { title: "T", start: "inbox" });
    const p = seedProject(fixture.db, { title: "P" });
    const result = await runTodoMove(deps(), {
      uuids: [t, p],
      destination: { kind: "area", ref: { uuid: seedArea(fixture.db, "A") } },
    });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.refusal).toBe("usage");
      expect(result.detail).toContain("homogeneous");
      expect(result.detail).toContain(p);
    }
  });

  it("a to-do handed to `project move` is a homogeneity usage error", async () => {
    const t = seedTodo(fixture.db, { title: "T", start: "inbox" });
    const result = await runProjectMove(deps(), {
      uuids: [t],
      destination: { kind: "area", ref: { uuid: seedArea(fixture.db, "A") } },
    });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") expect(result.detail).toContain("homogeneous");
  });
});

describe("bare invocation teaching errors (spec §4)", () => {
  it("bare `todo move` is the ratified teaching error", async () => {
    const t = seedTodo(fixture.db, { title: "T", start: "inbox" });
    const result = await runTodoMove(deps(), { uuids: [t] });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.refusal).toBe("usage");
      expect(result.detail).toContain("needs a destination or a position");
      expect(result.detail).toContain("todo reorder");
    }
  });

  it("bare `project move` is a teaching error", async () => {
    const p = seedProject(fixture.db, { title: "P" });
    const result = await runProjectMove(deps(), { uuids: [p] });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused")
      expect(result.detail).toContain("needs a destination or a position");
  });
});

describe("rule 2: anchors position, never migrate", () => {
  it("an anchor-only move across containers fails closed, pointing at the destination flags", async () => {
    const p1 = seedProject(fixture.db, { title: "P1" });
    const p2 = seedProject(fixture.db, { title: "P2" });
    const mover = seedTodo(fixture.db, { title: "mover", project: p1, index: 1 });
    const anchor = seedTodo(fixture.db, { title: "anchor", project: p2, index: 1 });
    const result = await runTodoMove(deps(), { uuids: [mover], position: { after: anchor } });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.refusal).toBe("blocked");
      expect(result.detail).toContain("an anchor positions, it never migrates");
    }
  });
});

describe("rule 4: anchor bucket-mismatch refusal", () => {
  it("--before across schedule buckets fails closed listing the buckets", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const anytime = seedTodo(fixture.db, {
      title: "anytime",
      project: proj,
      start: "active",
      index: 1,
    });
    const someday = seedTodo(fixture.db, {
      title: "someday",
      project: proj,
      start: "someday",
      index: 2,
    });
    const result = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [anytime],
      position: { before: someday },
    });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused") {
      expect(result.refusal).toBe("blocked");
      expect(result.detail).toContain("bucket");
    }
  });
});

describe("bare reorder — earliest-slot block assembly (spec §4)", () => {
  it("assembles the block at the earliest movee's slot in argument order (--first NOT implied)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, index: 1 });
    const b = seedTodo(fixture.db, { title: "b", project: proj, index: 2 });
    const c = seedTodo(fixture.db, { title: "c", project: proj, index: 3 });
    const d = seedTodo(fixture.db, { title: "d", project: proj, index: 4 });
    const e = seedTodo(fixture.db, { title: "e", project: proj, index: 5 });
    const result = await runInPlaceReorder(deps(), "todo.move", { uuids: [d, b] });
    expect(result.kind).toBe("move-ok");
    // Earliest movee is b (slot 2); block [d, b] lands there → a, d, b, c, e.
    const order = [a, d, b, c, e];
    expect(ascending(indexOrder(order))).toBe(true);
  });

  it("cross-container operands fail closed", async () => {
    const p1 = seedProject(fixture.db, { title: "P1" });
    const p2 = seedProject(fixture.db, { title: "P2" });
    const x = seedTodo(fixture.db, { title: "x", project: p1, index: 1 });
    const y = seedTodo(fixture.db, { title: "y", project: p2, index: 1 });
    const result = await runInPlaceReorder(deps(), "todo.move", { uuids: [x, y] });
    expect(result.kind).toBe("move-refused");
    if (result.kind === "move-refused")
      expect(result.detail).toContain("span different containers");
  });
});

describe("detach family teaching errors (spec §5/§7)", () => {
  it("--detach (removed) on a to-do names the replacement family", async () => {
    const t = seedTodo(fixture.db, { title: "T" });
    const r = await runTodoMove(deps(), { uuids: [t], destination: { kind: "detach" } });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.detail).toContain("--detach");
      expect(r.detail).toContain("--no-heading");
      expect(r.detail).toContain("--loose");
    }
  });

  it("--no-area on a PROJECT-CHILD to-do teaches the inherited-area rule", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const t = seedTodo(fixture.db, { title: "child", project: proj });
    const r = await runTodoMove(deps(), { uuids: [t], destination: { kind: "no-area" } });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.detail).toContain("its area comes from its project");
      expect(r.detail).toContain("--loose");
    }
  });

  it("--no-area on a DIRECT-AREA loose to-do points at --loose", async () => {
    const area = seedArea(fixture.db, "A");
    const t = seedTodo(fixture.db, { title: "direct", area });
    const r = await runTodoMove(deps(), { uuids: [t], destination: { kind: "no-area" } });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("`--loose`");
  });

  it("--loose on a project points at --no-area", async () => {
    const p = seedProject(fixture.db, { title: "P" });
    const r = await runProjectMove(deps(), { uuids: [p], destination: { kind: "loose" } });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("--no-area");
  });

  it("--detach on a project names --no-area", async () => {
    const p = seedProject(fixture.db, { title: "P" });
    const r = await runProjectMove(deps(), { uuids: [p], destination: { kind: "detach" } });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("--no-area");
  });
});

describe("detach family membership (spec §5)", () => {
  it("--no-heading leaves the heading but keeps the project", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const t = seedTodo(fixture.db, { title: "T", heading, index: 1 });
    const r = await runTodoMove(deps(), { uuids: [t], destination: { kind: "no-heading" } });
    expect(r.kind).toBe("move-ok");
    const c = containerOf(t);
    expect(c.heading).toBeNull();
    expect(c.project).toBe(proj);
  });

  it("--loose severs heading, project, AND area", async () => {
    const area = seedArea(fixture.db, "A");
    const proj = seedProject(fixture.db, { title: "P", area });
    const t = seedTodo(fixture.db, { title: "T", project: proj, index: 1 });
    const r = await runTodoMove(deps(), { uuids: [t], destination: { kind: "loose" } });
    expect(r.kind).toBe("move-ok");
    const c = containerOf(t);
    expect(c.project).toBeNull();
    expect(c.area).toBeNull();
    expect(c.heading).toBeNull();
  });
});

describe("mixed-bucket membership move (rule 4 — membership always legal)", () => {
  it("moves an anytime + a someday to-do into an area; both land (membership legal)", async () => {
    const area = seedArea(fixture.db, "Dest");
    const anytime = seedTodo(fixture.db, { title: "anytime", start: "active", index: 1 });
    const someday = seedTodo(fixture.db, { title: "someday", start: "someday", index: 2 });
    const r = await runTodoMove(deps(), {
      uuids: [anytime, someday],
      destination: { kind: "area", ref: { uuid: area } },
    });
    expect(r.kind).toBe("move-ok");
    expect(containerOf(anytime).area).toBe(area);
    expect(containerOf(someday).area).toBe(area);
  });
});

describe("rule 5 guaranteed/app-default/prohibited split (REORDGAPS verdicts)", () => {
  it("within-PROJECT someday reorder is GUARANTEED (SOMEORD-b — index, start=2 preserved)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "someday", index: 1 });
    const b = seedTodo(fixture.db, { title: "b", project: proj, start: "someday", index: 2 });
    const c = seedTodo(fixture.db, { title: "c", project: proj, start: "someday", index: 3 });
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [c, a],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.placementClass).toBe("guaranteed");
    expect(ascending(indexOrder([c, a, b]))).toBe(true);
  });

  it("within-AREA someday reorder is now GUARANTEED via the SOMEBNC-area bounce (was §9f-prohibited)", async () => {
    const area = seedArea(fixture.db, "A");
    const a = seedTodo(fixture.db, { title: "a", area, start: "someday", index: 1 });
    seedTodo(fixture.db, { title: "b", area, start: "someday", index: 2 });
    const c = seedTodo(fixture.db, { title: "c", area, start: "someday", index: 3 });
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [c, a],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.placementClass).toBe("guaranteed");
    // The area reorder command (destructive §9f) is NEVER used — the bounce is.
    expect(ascending(indexOrder([c, a]))).toBe(true);
    for (const u of [a, c]) {
      const row = fixture.db.prepare("SELECT start, area FROM TMTask WHERE uuid = ?").get(u) as {
        start: number;
        area: string;
      };
      expect(row.start).toBe(2); // still Someday (not de-somedayed)
      expect(row.area).toBe(area);
    }
  });

  it("a container's same-day scheduled bucket is now GUARANTEED via the DAYORD-b container reorder", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      start: "active",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "active",
      startDate: "2026-07-20",
      todayIndex: 2,
    });
    const r = await runInPlaceReorder(
      deps({ vectors: [membershipVector(), reorderVector("todayIndex")] }),
      "todo.move",
      { uuids: [b, a], position: { at: "first" } },
    );
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.placementClass).toBe("guaranteed");
    expect(ascending(indexOrder([b, a], "todayIndex"))).toBe(true);
    const day = encodePackedDate("2026-07-20");
    for (const u of [a, b]) {
      const row = fixture.db.prepare("SELECT startDate FROM TMTask WHERE uuid = ?").get(u) as {
        startDate: number;
      };
      expect(row.startDate).toBe(day); // date preserved
    }
  });

  it("a repeating TEMPLATE row is unreorderable — reorder refused, never silent (§9e)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      project: proj,
      recurrenceRule: true,
      index: 1,
    });
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [tmpl],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("template");
  });

  it("within-HEADING --before is now SUPPORTED via the extended bounce, co-bouncing siblings", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const h1 = seedTodo(fixture.db, { title: "h1", heading, index: 1 });
    const h2 = seedTodo(fixture.db, { title: "h2", heading, index: 2 });
    const h3 = seedTodo(fixture.db, { title: "h3", heading, index: 3 });
    // Move h3 before h1 → h3, h1, h2. h1 and h2 ride along (co-bounced).
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [h3],
      position: { before: h1 },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("unnamed sibling");
      if (r.placement?.kind === "ok") expect(r.placement.touched).toEqual([h1, h2]);
    }
    expect(ascending(indexOrder([h3, h1, h2]))).toBe(true);
  });

  it("a membership move UNDER a heading with --before is refused when the mover has no schedule (app-default bucket)", async () => {
    // An inbox mover keeps start=0 in the fixture → a headed INBOX sub-bucket,
    // which has no wired order surface, so the anchor is honestly refused.
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const existing = seedTodo(fixture.db, { title: "existing", heading, index: 1 });
    const mover = seedTodo(fixture.db, { title: "mover", start: "inbox" });
    const r = await runTodoMove(deps(), {
      uuids: [mover],
      destination: { kind: "heading", sel: heading, project: { uuid: proj } },
      position: { before: existing },
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("cannot be honored");
  });
});

describe("scope composition (#276): an out-of-scope anchor reads as not-found", () => {
  it("an anchor outside the pinned scope is byte-indistinguishable from a nonexistent one", async () => {
    const area = seedArea(fixture.db, "Work");
    const proj = seedProject(fixture.db, { title: "Scoped", area });
    const inScope = seedTodo(fixture.db, { title: "in", project: proj, index: 1 });
    const other = seedProject(fixture.db, { title: "Other" });
    const outOfScope = seedTodo(fixture.db, { title: "out", project: other, index: 1 });
    const scope: ResolvedScope = {
      kind: "project",
      uuid: proj,
      title: "Scoped",
      areaUuid: area,
      source: "flag",
    };
    const r = await runInPlaceReorder(deps({ scope }), "todo.move", {
      uuids: [inScope],
      position: { after: outOfScope },
    });
    // The out-of-scope anchor resolves to not-found — a usage refusal, never a
    // signal that the item exists elsewhere (the no-oracle guarantee).
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.refusal).toBe("usage");
  });
});
