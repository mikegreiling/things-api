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
import {
  runInPlaceReorder,
  runProjectMove,
  runTodoMove,
  type MovePosition,
} from "../../src/write/move.ts";
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
      // BOUNCEJSON collapse (§9i): a raw things:///json array carries no op/
      // opParams — apply each element's when leg in array order (the same bounce
      // reindex law the per-leg branch uses).
      if (invocation.op === undefined && invocation.payload.includes("/json?")) {
        const arr = JSON.parse(new URL(invocation.payload).searchParams.get("data") ?? "[]") as {
          id: string;
          attributes: { when: string };
        }[];
        for (const el of arr) bounceLeg(el.id, el.attributes.when);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
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

/**
 * The full UPCORD1 loose-day protocol harness: url-scheme fake for the scratch
 * project.add + park/unpark todo.move legs (schedule preserved), applescript
 * fake for the native container-day reorder (todayIndex re-rank) + project.delete
 * trash. Both read invocation.op/opParams. Returns the two vectors + a call log.
 */
interface LooseDayOpParams {
  title?: string;
  uuid: string;
  project?: { uuid: string };
  loose?: boolean;
  uuids?: string[];
}

function looseDayMoveVectors() {
  const calls: string[] = [];
  const urlFake: WriteVector = {
    id: "url-scheme",
    matrix: {
      "project.add": { support: "yes", disruption: 0, validation: "validated" },
      "todo.move": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as LooseDayOpParams;
      if (inv.op === "project.add") {
        seedProject(fixture.db, {
          title: p.title ?? "",
          creationDate: Math.floor(NOW.getTime() / 1000),
        });
      } else if (inv.op === "todo.move") {
        if (p.project !== undefined) {
          fixture.db
            .prepare(
              "UPDATE TMTask SET project=?, area=NULL, heading=NULL, userModificationDate=? WHERE uuid=?",
            )
            .run(p.project.uuid, modClock++, p.uuid);
        } else if (p.loose === true) {
          fixture.db
            .prepare(
              "UPDATE TMTask SET project=NULL, area=NULL, heading=NULL, userModificationDate=? WHERE uuid=?",
            )
            .run(modClock++, p.uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const asFake: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
      "project.delete": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as LooseDayOpParams;
      if (inv.op === "reorder") {
        let rank = 1;
        for (const uuid of p.uuids ?? []) {
          fixture.db
            .prepare("UPDATE TMTask SET todayIndex=?, userModificationDate=? WHERE uuid=?")
            .run(rank++, modClock++, uuid);
        }
      } else if (inv.op === "project.delete") {
        fixture.db
          .prepare("UPDATE TMTask SET trashed=1, userModificationDate=? WHERE uuid=?")
          .run(modClock++, p.uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vectors: [urlFake, asFake], calls };
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
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "someday", // app-true future-scheduled (start=2 + future date)
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

  it("a loose FUTURE-day block is now GUARANTEED via the UPCORD1 loose-day protocol", async () => {
    const a = seedTodo(fixture.db, {
      title: "a",
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const { vectors, calls } = looseDayMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("loose future-day group");
    }
    // Block a,b landed at the top of the day in selection order.
    expect(ascending(indexOrder([a, b], "todayIndex"))).toBe(true);
    // The protocol ran (scratch project.add + park + reorder + unpark + trash).
    expect(calls).toContain("project.add");
    expect(calls).toContain("project.delete");
    // Items are loose again on their day.
    for (const u of [a, b]) {
      expect(containerOf(u).project).toBeNull();
      const row = fixture.db.prepare("SELECT startDate FROM TMTask WHERE uuid = ?").get(u) as {
        startDate: number;
      };
      expect(row.startDate).toBe(encodePackedDate("2026-07-20"));
    }
  });

  it("mixed future dates are refused — a single reorder cannot span days", async () => {
    const a = seedTodo(fixture.db, {
      title: "a",
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-21",
      todayIndex: 10,
    });
    const { vectors, calls } = looseDayMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", { uuids: [a, b] });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.refusal).toBe("blocked");
    expect(calls).toHaveLength(0); // never created a scratch project
  });

  it("a non-loose (project-child) future-day movee routes to container-day, not loose-day", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "someday", // app-true future-scheduled (start=2 + future date)
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const { vectors, calls } = looseDayMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("container-day");
    // container-day is a single native reorder — NO scratch project machinery.
    expect(calls).not.toContain("project.add");
    expect(ascending(indexOrder([a, b], "todayIndex"))).toBe(true);
  });

  it("`todo reorder` reranks a MIXED to-do+project Today block (O12 — the native Today list intermixes types)", async () => {
    // Two LOOSE Today-bucket rows: a to-do and a project (startBucket=0, dated
    // today). O12: the native `list "Today"` reorder accepts project uuids
    // intermixed with to-dos, so `todo reorder <todo> <project>` must compile the
    // mixed wire list, not refuse "homogeneous kinds".
    const todo = seedTodo(fixture.db, {
      title: "t",
      start: "active",
      startDate: "2026-07-05",
      todayIndex: 10,
    });
    const proj = seedProject(fixture.db, {
      title: "P",
      start: "active",
      startDate: "2026-07-05",
      todayIndex: 20,
    });
    const r = await runInPlaceReorder(
      deps({ vectors: [membershipVector(), reorderVector("todayIndex")] }),
      "todo.move",
      { uuids: [proj, todo], position: { at: "first" } },
    );
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.placementClass).toBe("guaranteed");
    // Both reranked on the Today (todayIndex) axis, in the requested order — the
    // mixed wire list [project, to-do] was compiled and sent.
    expect(indexOrder([proj, todo], "todayIndex")).toEqual([1, 2]);
  });

  it("the mixed-kind relaxation is Today-only — a project OUTSIDE the Today bucket still refuses", async () => {
    const todo = seedTodo(fixture.db, {
      title: "t",
      start: "active",
      startDate: "2026-07-05",
      todayIndex: 10,
    });
    // An anytime (undated) project — NOT a Today member.
    const proj = seedProject(fixture.db, { title: "P", start: "active" });
    const r = await runInPlaceReorder(deps(), "todo.move", { uuids: [todo, proj] });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("homogeneous kinds");
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

describe("regression: dated start=2 rows classify as scheduled, never someday", () => {
  // The app's ONLY representation of a future-scheduled to-do is start=2
  // (someday) + a FUTURE startDate — a plain active start=1 is always undated
  // (UPC1 / BANNER1; live prod scan 2026-07-30: 4/4 future-scheduled to-dos are
  // start=2, ZERO are start=1+future). Before the scheduleBucket date-ordering
  // fix the planner tested start===2 BEFORE the date and classified EVERY such
  // row as a Someday-bucket member, routing it to the Someday-family reorder
  // protocols. For a direct-area/project someday member that protocol is the
  // when= bounce whose AWAY leg is `when=anytime`, which CLEARS a startDate (a
  // de-schedule). These pin the app-true representation end-to-end through the
  // planner so the misroute cannot silently return.

  it("a loose FUTURE-day start=2 movee routes to loose-day, NOT the someday protocol", async () => {
    const a = seedTodo(fixture.db, {
      title: "a",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const { vectors, calls } = looseDayMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("loose future-day group");
    }
    // The UPCORD1 park-sort-unpark protocol ran — NOT a Someday when= bounce.
    expect(calls).toContain("project.add");
    // De-schedule guard: start=2 + the future date are preserved (never toggled).
    for (const u of [a, b]) {
      const row = fixture.db
        .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
        .get(u) as {
        start: number;
        startDate: number;
      };
      expect(row.start).toBe(2);
      expect(row.startDate).toBe(encodePackedDate("2026-07-20"));
    }
  });

  it("a project-child future-day start=2 movee routes to container-day (date-preserving)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 2,
    });
    const r = await runInPlaceReorder(
      deps({ vectors: [membershipVector(), reorderVector("todayIndex")] }),
      "todo.move",
      { uuids: [b, a], position: { at: "first" } },
    );
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("container-day");
    }
    expect(ascending(indexOrder([b, a], "todayIndex"))).toBe(true);
    for (const u of [a, b]) {
      const row = fixture.db
        .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
        .get(u) as {
        start: number;
        startDate: number;
      };
      expect(row.start).toBe(2); // start preserved — not de-somedayed
      expect(row.startDate).toBe(encodePackedDate("2026-07-20")); // date preserved
    }
  });

  it("an UNDATED start=2 movee still routes to its someday scope", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "someday", index: 1 });
    const b = seedTodo(fixture.db, { title: "b", start: "someday", index: 2 });
    // dry-run reads the routed scope without running the two-call Someday stack.
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [b, a], position: { at: "first" } },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") {
      expect(r.plan.placement).toContain("scope=someday");
      expect(r.plan.placementClass).toBe("guaranteed");
    }
    // The date-first classifier keeps these in Someday (undated start=2).
    for (const u of [a, b]) {
      const row = fixture.db
        .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
        .get(u) as {
        start: number;
        startDate: number | null;
      };
      expect(row.start).toBe(2);
      expect(row.startDate).toBeNull();
    }
  });

  it("an ARRIVED start=2 movee (someday-scheduled, date today) routes to today", async () => {
    // An arrived someday-scheduled row (start=2, startDate <= today) is a
    // Today + Anytime member (deriveStage → anytime via the Today marker), so it
    // buckets today here — the same date-first branch, not someday.
    const a = seedTodo(fixture.db, {
      title: "a",
      start: "someday",
      startDate: "2026-07-05",
      todayIndex: 1,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      start: "someday",
      startDate: "2026-07-05",
      todayIndex: 2,
    });
    const r = await runInPlaceReorder(
      deps({ vectors: [membershipVector(), reorderVector("todayIndex")] }),
      "todo.move",
      { uuids: [b, a], position: { at: "first" } },
    );
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("today");
    for (const u of [a, b]) {
      const row = fixture.db
        .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
        .get(u) as {
        start: number;
        startDate: number;
      };
      expect(row.start).toBe(2);
      expect(row.startDate).toBe(encodePackedDate("2026-07-05"));
    }
  });

  it("an ARRIVED start=2 EVENING movee routes to the evening scope (date-first, not someday)", async () => {
    const t = seedTodo(fixture.db, {
      title: "t",
      start: "someday",
      startDate: "2026-07-05",
      evening: true, // startBucket = 1 → This Evening
    });
    // dry-run reads the routed scope without running the evening bounce.
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [t], position: { at: "first" } },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=evening");
  });

  it("the single-bucket rule separates a dated start=2 row from an undated someday sibling", async () => {
    // Both loose, both start=2, but different display buckets post-fix: the dated
    // row is in its scheduled day-group, the undated one in Someday. A joint
    // reorder is refused (spans containers) — pre-fix both read "someday" and the
    // misroute proceeded.
    const dated = seedTodo(fixture.db, {
      title: "dated",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const undated = seedTodo(fixture.db, { title: "undated", start: "someday", index: 1 });
    const r = await runInPlaceReorder(deps(), "todo.move", { uuids: [dated, undated] });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("blocked");
      expect(r.detail).toContain("span different containers");
    }
  });

  it("a dated direct-area movee routes to the SAFE area-day compound, NEVER a de-scheduling bounce", async () => {
    // THE de-schedule hazard: the area-someday (and project-someday) reorder is a
    // when= bounce whose away leg `when=anytime` CLEARS a startDate — a dated
    // movee must NEVER reach it. A direct-area scheduled-day child now routes to
    // the ORDFIN1 Arm 3 `area-day` park-sort-restore compound (park into a scratch
    // PROJECT → container-day reorder → restore to the area), which preserves the
    // date. The dry-run pins the classifier so the planner never proposes the
    // destructive bounce.
    const area = seedArea(fixture.db, "A");
    const dated = seedTodo(fixture.db, {
      title: "dated",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [dated], position: { at: "first" } },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") {
      expect(r.plan.placement).toContain("scope=area-day");
      expect(r.plan.placement).not.toContain("someday");
    }
    // Untouched by the dry-run: still start=2 + its future date.
    const row = fixture.db
      .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
      .get(dated) as {
      start: number;
      startDate: number;
    };
    expect(row.start).toBe(2);
    expect(row.startDate).toBe(encodePackedDate("2026-07-20"));
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

describe("HEADSUB1 planner routing (heading sub-buckets + child evening)", () => {
  /** The reorder scope an in-place reorder of these movees routes to (dry-run). */
  async function routedScope(uuids: string[]): Promise<string> {
    const r = await runInPlaceReorder(deps(), "todo.move", { uuids }, { dryRun: true });
    if (r.kind !== "move-dry-run") throw new Error(`expected move-dry-run, got ${r.kind}`);
    return r.plan.placement;
  }

  it("a headed SOMEDAY child routes to heading-someday", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const s1 = seedTodo(fixture.db, { title: "s1", heading, start: "someday", index: 10 });
    const s2 = seedTodo(fixture.db, { title: "s2", heading, start: "someday", index: 20 });
    expect(await routedScope([s1, s2])).toContain("scope=heading-someday");
  });

  it("a headed same-day SCHEDULED child routes to heading-day, NEVER container-day (§9k rail)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const d1 = seedTodo(fixture.db, {
      title: "d1",
      heading,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const d2 = seedTodo(fixture.db, {
      title: "d2",
      heading,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    const placement = await routedScope([d1, d2]);
    expect(placement).toContain("scope=heading-day");
    expect(placement).not.toContain("container-day");
  });

  it("a headed EVENING child routes to the shipped evening bounce (ORDFIN1 Arm 2b)", async () => {
    // ORDFIN1 Arm 2b: the today↔evening bounce preserves a headed child's heading
    // FK byte-identical, so the `evening` scope orders it unchanged — no new
    // machinery, no display-axis ambiguity. (Was previously app-default-refused.)
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const e1 = seedTodo(fixture.db, {
      title: "e1",
      heading,
      startDate: "2026-07-05",
      evening: true,
      todayIndex: 10,
    });
    expect(await routedScope([e1])).toContain("scope=evening");
  });

  it("a headed EVENING child degrades to app-default when bounce is disabled (never destructive)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const e1 = seedTodo(fixture.db, {
      title: "e1",
      heading,
      startDate: "2026-07-05",
      evening: true,
      todayIndex: 10,
    });
    const noBounce = deps({ config: { ...config(), bounceEnabled: false } });
    const r = await runInPlaceReorder(noBounce, "todo.move", { uuids: [e1] }, { dryRun: true });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("bounce");
  });

  it("a PROJECT-child evening item routes to the shipped evening bounce (Arm D)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const e1 = seedTodo(fixture.db, {
      title: "e1",
      project: proj,
      startDate: "2026-07-05",
      evening: true,
      todayIndex: 10,
    });
    expect(await routedScope([e1])).toContain("scope=evening");
  });

  it("an AREA-child evening item routes to the shipped evening bounce (Arm D)", async () => {
    const area = seedArea(fixture.db, "A");
    const e1 = seedTodo(fixture.db, {
      title: "e1",
      area,
      startDate: "2026-07-05",
      evening: true,
      todayIndex: 10,
    });
    expect(await routedScope([e1])).toContain("scope=evening");
  });

  it("child-evening degrades to app-default when bounce is disabled (never a destructive fallback)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const e1 = seedTodo(fixture.db, {
      title: "e1",
      project: proj,
      startDate: "2026-07-05",
      evening: true,
      todayIndex: 10,
    });
    const noBounce = deps({ config: { ...config(), bounceEnabled: false } });
    const r = await runInPlaceReorder(noBounce, "todo.move", { uuids: [e1] }, { dryRun: true });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("bounce");
  });
});

// ------------------ ORDFIN1 planner routing (area-day + upcoming-day compounds)

/**
 * The full ORDFIN1 park-sort-restore harness for the move planner: url-scheme fake
 * for the scratch project.add + origin-aware park/restore todo.move legs (schedule
 * preserved, FK re-homed, todayIndex NEVER touched on a restore), applescript fake
 * for the native container-day reorder (todayIndex re-rank) + project.delete trash.
 */
function dayCompoundMoveVectors() {
  const calls: string[] = [];
  const urlFake: WriteVector = {
    id: "url-scheme",
    matrix: {
      "project.add": { support: "yes", disruption: 0, validation: "validated" },
      "todo.move": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as {
        title?: string;
        uuid: string;
        project?: { uuid: string };
        area?: { uuid: string };
        heading?: string;
        loose?: boolean;
      };
      if (inv.op === "project.add") {
        seedProject(fixture.db, {
          title: p.title ?? "",
          creationDate: Math.floor(NOW.getTime() / 1000),
        });
      } else if (inv.op === "todo.move") {
        if (p.heading !== undefined) {
          fixture.db
            .prepare(
              "UPDATE TMTask SET heading=?, project=NULL, area=NULL, userModificationDate=? WHERE uuid=?",
            )
            .run(p.heading, modClock++, p.uuid);
        } else if (p.project !== undefined) {
          fixture.db
            .prepare(
              "UPDATE TMTask SET project=?, area=NULL, heading=NULL, userModificationDate=? WHERE uuid=?",
            )
            .run(p.project.uuid, modClock++, p.uuid);
        } else if (p.area !== undefined) {
          fixture.db
            .prepare(
              "UPDATE TMTask SET area=?, project=NULL, heading=NULL, userModificationDate=? WHERE uuid=?",
            )
            .run(p.area.uuid, modClock++, p.uuid);
        } else if (p.loose === true) {
          fixture.db
            .prepare(
              "UPDATE TMTask SET project=NULL, area=NULL, heading=NULL, userModificationDate=? WHERE uuid=?",
            )
            .run(modClock++, p.uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const asFake: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
      "project.delete": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as { uuid: string; uuids?: string[] };
      if (inv.op === "reorder") {
        let rank = 1;
        for (const uuid of p.uuids ?? []) {
          fixture.db
            .prepare("UPDATE TMTask SET todayIndex=?, userModificationDate=? WHERE uuid=?")
            .run(rank++, modClock++, uuid);
        }
      } else if (inv.op === "project.delete") {
        fixture.db
          .prepare("UPDATE TMTask SET trashed=1, userModificationDate=? WHERE uuid=?")
          .run(modClock++, p.uuid);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vectors: [urlFake, asFake], calls };
}

describe("ORDFIN1 planner routing (area-day + upcoming-day)", () => {
  async function routedScope(uuids: string[], position?: MovePosition): Promise<string> {
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      position !== undefined ? { uuids, position } : { uuids },
      { dryRun: true },
    );
    if (r.kind !== "move-dry-run") throw new Error(`expected move-dry-run, got ${r.kind}`);
    return r.plan.placement;
  }

  it("a same-area future-day group routes to area-day (single-container path)", async () => {
    const area = seedArea(fixture.db, "A");
    const a = seedTodo(fixture.db, {
      title: "a",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    expect(await routedScope([a, b])).toContain("scope=area-day");
  });

  it("a CROSS-CONTAINER future-day group routes to upcoming-day (not the span-refusal)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const area = seedArea(fixture.db, "A");
    const projChild = seedTodo(fixture.db, {
      title: "pc",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const areaChild = seedTodo(fixture.db, {
      title: "ac",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    expect(await routedScope([projChild, areaChild])).toContain("scope=upcoming-day");
  });

  it("a cross-container group on DIFFERENT days still fails closed (span refusal, not upcoming-day)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const area = seedArea(fixture.db, "A");
    const projChild = seedTodo(fixture.db, {
      title: "pc",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const areaChild = seedTodo(fixture.db, {
      title: "ac",
      area,
      start: "someday",
      startDate: "2026-07-21", // a DIFFERENT future day
      todayIndex: 20,
    });
    const r = await runInPlaceReorder(deps(), "todo.move", { uuids: [projChild, areaChild] });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("span different containers");
  });

  it("runs the cross-container upcoming-day compound end-to-end, restoring each FK and the order", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const area = seedArea(fixture.db, "A");
    const loose = seedTodo(fixture.db, {
      title: "loose",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 40,
    });
    const projChild = seedTodo(fixture.db, {
      title: "pc",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 30,
    });
    const headedChild = seedTodo(fixture.db, {
      title: "hc",
      heading,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    const areaChild = seedTodo(fixture.db, {
      title: "ac",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const { vectors, calls } = dayCompoundMoveVectors();
    // Place the block loose,areaChild at the TOP in selection order.
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [loose, areaChild],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("Upcoming day-group");
    }
    // The protocol ran (scratch project.add + park + reorder + restore + trash).
    expect(calls).toContain("project.add");
    expect(calls).toContain("project.delete");
    // The block landed at the top of the day in selection order.
    expect(ascending(indexOrder([loose, areaChild], "todayIndex"))).toBe(true);
    // Every FK round-tripped to its origin.
    expect(containerOf(loose)).toMatchObject({ project: null, area: null, heading: null });
    expect(containerOf(projChild).project).toBe(proj);
    expect(containerOf(headedChild).heading).toBe(heading);
    expect(containerOf(areaChild).area).toBe(area);
  });

  it("a --before anchor OUTSIDE the day-group is refused (positions, never migrates)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const area = seedArea(fixture.db, "A");
    const projChild = seedTodo(fixture.db, {
      title: "pc",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const areaChild = seedTodo(fixture.db, {
      title: "ac",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    // An anchor on a DIFFERENT day is not a member of the group.
    const offDay = seedTodo(fixture.db, {
      title: "off",
      start: "someday",
      startDate: "2026-07-21",
      todayIndex: 1,
    });
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [projChild, areaChild],
      position: { before: offDay },
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("day-group");
  });
});
