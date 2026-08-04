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
    certifiedAppVersion: null,
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
 * A native-reorder + membership harness: url-scheme fake for project.add +
 * todo.move (schedule preserved), applescript fake for the native container-day /
 * tomorrow reorder (todayIndex re-rank) + project.delete. Used by the single-
 * project container-day and one-call `tomorrow` routing tests (the SIT4 dated
 * `day` bounce uses {@link datedBounceMoveVectors} instead — no scratch project).
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

/**
 * The SIT4 dated `day` bounce harness for the move path: a url-scheme fake for the
 * todo.update / update-project when= legs that FRONT-inserts each row at the target
 * day+bucket's GLOBAL todayIndex min (to-dos AND area-less projects share ONE
 * axis). No scratch project, no experimental gate — just the when= round-trip; the
 * op recorded (todo.update vs project.update) proves the per-type leg dispatch.
 */
function datedBounceMoveVectors() {
  const calls: string[] = [];
  const apply = (uuid: string, when: string): void => {
    const at = when.indexOf("@");
    const base = at >= 0 ? when.slice(0, at) : when;
    let packed: number;
    let bucket: number;
    if (base === "evening") {
      packed = TODAY_PACKED;
      bucket = 1;
    } else if (base === "today") {
      packed = TODAY_PACKED;
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
    const startVal = packed > TODAY_PACKED ? 2 : 1;
    fixture.db
      .prepare(
        `UPDATE TMTask SET start = ?, startDate = ?, startBucket = ?, todayIndex = ?,
         userModificationDate = ? WHERE uuid = ?`,
      )
      .run(startVal, packed, bucket, (min.m ?? 0) - 1, modClock++, uuid);
  };
  const urlFake: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as { uuid: string; when?: string };
      if (inv.op === "todo.update" || inv.op === "project.update") apply(p.uuid, p.when ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vectors: [urlFake], calls };
}

/**
 * TMPLSORT/PTMPL template day-block harness: url-scheme when= legs (scheduled rows)
 * + an applescript reorder fake that models BOTH the `list "Tomorrow"` full-wire sort
 * (ascending ranks) and the single-id `list "Upcoming"` TO-DO-template front-insert
 * (todayIndex at the shared block min − 1). The block min spans scheduled ∪ forecast ∪
 * TEMPLATE rows (TMPLSORT-2), so a template and a scheduled row share ONE min-space.
 */
function templateDayMoveVectors() {
  const calls: string[] = [];
  const blockMin = (packed: number): number => {
    const r = fixture.db
      .prepare(
        `SELECT MIN(todayIndex) AS m FROM TMTask WHERE trashed = 0 AND status = 0 AND (
           (startBucket = 0 AND startDate = ?)
           OR (startDate IS NULL AND deadline = ? AND start IN (1, 2))
           OR (rt1_nextInstanceStartDate = ? AND (rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL)))`,
      )
      .get(packed, packed, packed) as { m: number | null };
    return r.m ?? 0;
  };
  const urlFake: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as { uuid: string; when?: string };
      const when = p.when ?? "";
      if (when === "") return { exitCode: 0, stdout: "", stderr: "" };
      const packed = when === "today" ? TODAY_PACKED : encodePackedDate(when);
      const startVal = packed > TODAY_PACKED ? 2 : 1;
      fixture.db
        .prepare(
          `UPDATE TMTask SET start=?, startDate=?, startBucket=0, todayIndex=?,
           userModificationDate=? WHERE uuid=?`,
        )
        .run(startVal, packed, blockMin(packed) - 1, modClock++, p.uuid);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const asFake: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
    },
    async execute(inv) {
      const p = inv.opParams as { scope: string; uuids: string[] };
      calls.push(inv.op === "reorder" ? `reorder:${p.scope}` : (inv.op ?? "?"));
      if (p.scope === "upcoming") {
        // Single-id TO-DO template front-insert: umd-silent (unchanged).
        const id = p.uuids[0] ?? "";
        const row = fixture.db
          .prepare("SELECT rt1_nextInstanceStartDate AS proj FROM TMTask WHERE uuid = ?")
          .get(id) as { proj: number | null };
        fixture.db
          .prepare("UPDATE TMTask SET todayIndex=? WHERE uuid=?")
          .run(blockMin(row.proj ?? 0) - 1, id);
      } else {
        // `list "Tomorrow"` (and any full-wire native reorder): exact sent order.
        let rank = 1;
        for (const uuid of p.uuids) {
          fixture.db
            .prepare("UPDATE TMTask SET todayIndex=?, userModificationDate=? WHERE uuid=?")
            .run(rank++, modClock++, uuid);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vectors: [urlFake, asFake], calls };
}

/**
 * GRNDINT combined harness (#393 gate fix): the FULL grand-interleave leg family
 * in one url+applescript pair — the when= bounce (scheduled to-dos AND projects),
 * the DLBNC deadline-cycle (forecast to-dos AND projects), and the single-id
 * `list "Upcoming"` TO-DO-template front-insert (umd-silent). `blockMin` spans
 * scheduled ∪ forecast ∪ TEMPLATE rows so every class shares ONE todayIndex
 * min-space (the union of {@link datedForecastMoveVectors} and
 * {@link templateDayMoveVectors}). A template row is NEVER handed a when=/deadline
 * leg by the compiler (the §1 crash-path lock); this harness would date it if one
 * arrived, so a surviving-NULL date/deadline assertion proves the lock held.
 */
function grandInterleaveMoveVectors() {
  const calls: string[] = [];
  const blockMin = (packed: number): number => {
    const r = fixture.db
      .prepare(
        `SELECT MIN(todayIndex) AS m FROM TMTask WHERE trashed = 0 AND status = 0 AND (
           (startBucket = 0 AND startDate = ?)
           OR (startDate IS NULL AND deadline = ? AND start IN (1, 2))
           OR (rt1_nextInstanceStartDate = ? AND (rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL)))`,
      )
      .get(packed, packed, packed) as { m: number | null };
    return r.m ?? 0;
  };
  const applyWhen = (uuid: string, when: string): void => {
    const packed = when === "today" ? TODAY_PACKED : encodePackedDate(when);
    const startVal = packed > TODAY_PACKED ? 2 : 1;
    fixture.db
      .prepare(
        `UPDATE TMTask SET start=?, startDate=?, startBucket=0, todayIndex=?, userModificationDate=? WHERE uuid=?`,
      )
      .run(startVal, packed, blockMin(packed) - 1, modClock++, uuid);
  };
  const applyDeadline = (uuid: string, deadline: string | null): void => {
    if (deadline === null || deadline === "") {
      fixture.db
        .prepare("UPDATE TMTask SET deadline=NULL, userModificationDate=? WHERE uuid=?")
        .run(modClock++, uuid);
      return;
    }
    const packed = encodePackedDate(deadline);
    fixture.db
      .prepare("UPDATE TMTask SET deadline=?, todayIndex=?, userModificationDate=? WHERE uuid=?")
      .run(packed, blockMin(packed) - 1, modClock++, uuid);
  };
  const urlFake: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as { uuid: string; when?: string; deadline?: string | null };
      if (inv.op === "todo.update" || inv.op === "project.update") {
        if (p.deadline !== undefined) applyDeadline(p.uuid, p.deadline);
        else applyWhen(p.uuid, p.when ?? "");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const asFake: WriteVector = {
    id: "applescript",
    matrix: {
      reorder: { support: "partial", disruption: 0, validation: "validated", experimental: true },
    },
    async execute(inv) {
      const p = inv.opParams as { scope: string; uuids: string[] };
      calls.push(inv.op === "reorder" ? `reorder:${p.scope}` : (inv.op ?? "?"));
      if (p.scope === "upcoming") {
        // Single-id TO-DO template front-insert: umd-silent (todayIndex only).
        const id = p.uuids[0] ?? "";
        const row = fixture.db
          .prepare("SELECT rt1_nextInstanceStartDate AS proj FROM TMTask WHERE uuid = ?")
          .get(id) as { proj: number | null };
        fixture.db
          .prepare("UPDATE TMTask SET todayIndex=? WHERE uuid=?")
          .run(blockMin(row.proj ?? 0) - 1, id);
      } else {
        let rank = 1;
        for (const uuid of p.uuids) {
          fixture.db
            .prepare("UPDATE TMTask SET todayIndex=?, userModificationDate=? WHERE uuid=?")
            .run(rank++, modClock++, uuid);
        }
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

describe("axis-aware anchor validity (global todayIndex scopes — BUG 3)", () => {
  // Today / Evening / day are ONE cross-container todayIndex axis: an anchor in a
  // different STRUCTURAL container is NOT a migration (the GUI permits the drag).
  // Anchor validity keys on the reorder TARGET, not the structural container; the
  // comparator and describer read the same key, so a refusal never renders the
  // self-contradictory identical-label message. Index-axis scopes are unchanged.

  it("Today: an area-child movee --after a project-child anchor COMPILES (cross-container)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const area = seedArea(fixture.db, "A");
    const areaMovee = seedTodo(fixture.db, {
      title: "am",
      area,
      startDate: "2026-07-05", // arrived today
      todayIndex: 10,
    });
    const projAnchor = seedTodo(fixture.db, {
      title: "pa",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 20,
    });
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [areaMovee], position: { after: projAnchor } },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=today");
  });

  it("Today: a loose movee --after an area'd anchor COMPILES (cross-container)", async () => {
    const area = seedArea(fixture.db, "A");
    const loose = seedTodo(fixture.db, { title: "loose", startDate: "2026-07-05", todayIndex: 10 });
    const areaAnchor = seedTodo(fixture.db, {
      title: "aa",
      area,
      startDate: "2026-07-05",
      todayIndex: 20,
    });
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [loose], position: { after: areaAnchor } },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=today");
  });

  it("Evening: a project-child movee --after a loose anchor COMPILES (bounce path)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const projEve = seedTodo(fixture.db, {
      title: "pe",
      project: proj,
      startDate: "2026-07-05",
      evening: true,
      todayIndex: 10,
    });
    const looseEve = seedTodo(fixture.db, {
      title: "le",
      startDate: "2026-07-05",
      evening: true,
      todayIndex: 20,
    });
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [projEve], position: { after: looseEve } },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=evening");
  });

  it("index-axis: an anytime movee --after another project's anytime item still REFUSES (differing labels)", async () => {
    const p1 = seedProject(fixture.db, { title: "P1" });
    const p2 = seedProject(fixture.db, { title: "P2" });
    const movee = seedTodo(fixture.db, { title: "m", project: p1, start: "active", index: 1 });
    const anchor = seedTodo(fixture.db, { title: "a", project: p2, start: "active", index: 1 });
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [movee],
      position: { after: anchor },
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.detail).toContain("an anchor positions, it never migrates");
      // The two container labels MUST differ (no self-contradiction).
      expect(r.detail).toContain(p1);
      expect(r.detail).toContain(p2);
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

/**
 * Inbox-return transport pin (regression). The `--inbox` destination compiles ONLY
 * to AppleScript (`move to do id X to list "Inbox"`; url-scheme `update` has no
 * Inbox target), yet BOTH vectors claim `todo.move` in the matrix and url-scheme
 * wins the tier-0 registry tie. So the membership leg must pin applescript — else
 * the planner routes the inbox leg to url-scheme and `spec.compile` throws the
 * "planner bug" unsupportedVector (the guest e2e's "move back to Inbox" step caught
 * this live). Two non-simulating fakes (both claiming todo.move, url-scheme FIRST so
 * it would win an unpinned tie) prove the leg lands on applescript.
 */
function inboxReturnVectors() {
  const calls: { vector: string; op: string | undefined }[] = [];
  const urlFake: WriteVector = {
    id: "url-scheme",
    matrix: { "todo.move": { support: "yes", disruption: 0, validation: "validated" } },
    async execute(inv) {
      calls.push({ vector: "url-scheme", op: inv.op });
      // url-scheme has no Inbox target — reaching here means the leg was NOT pinned.
      throw new Error("url-scheme received the inbox move — leg was not pinned to applescript");
    },
  };
  const asFake: WriteVector = {
    id: "applescript",
    matrix: { "todo.move": { support: "partial", disruption: 0, validation: "validated" } },
    async execute(inv) {
      calls.push({ vector: "applescript", op: inv.op });
      const p = inv.opParams as { uuid: string };
      fixture.db
        .prepare(
          "UPDATE TMTask SET start=0, startDate=NULL, project=NULL, area=NULL, heading=NULL, userModificationDate=? WHERE uuid=?",
        )
        .run(modClock++, p.uuid);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vectors: [urlFake, asFake], calls };
}

describe("inbox return — transport pin (regression: planner bug)", () => {
  it("routes the inbox leg to applescript, de-scheduling the to-do (never url-scheme)", async () => {
    const { vectors, calls } = inboxReturnVectors();
    const proj = seedProject(fixture.db, { title: "P" });
    const t = seedTodo(fixture.db, { title: "T", project: proj, start: "active" });
    const r = await runTodoMove(deps({ vectors }), {
      uuids: [t],
      destination: { kind: "inbox" },
    });
    expect(r.kind).toBe("move-ok");
    // Dispatched via applescript ONLY — url-scheme was never reached.
    expect(calls).toEqual([{ vector: "applescript", op: "todo.move" }]);
    const row = fixture.db
      .prepare("SELECT start, startDate, project, area, heading FROM TMTask WHERE uuid = ?")
      .get(t) as {
      start: number;
      startDate: number | null;
      project: string | null;
      area: string | null;
      heading: string | null;
    };
    expect(row.start).toBe(0);
    expect(row.startDate).toBeNull();
    expect(row.project).toBeNull();
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

  it("a loose FUTURE-day block is now GUARANTEED via the SIT4 dated `day` bounce", async () => {
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
    const { vectors, calls } = datedBounceMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("2026-07-20 day-group");
    }
    // Block a,b landed at the top of the day in selection order.
    expect(ascending(indexOrder([a, b], "todayIndex"))).toBe(true);
    // NO scratch project — the dated bounce is pure when= legs (todo.update).
    expect(calls).not.toContain("project.add");
    expect(calls.every((c) => c === "todo.update")).toBe(true);
    // Items stayed loose on their day (the round-trip preserves the container).
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
      // The mixed to-do+project set does not land on a global (Today/day) axis — the
      // project is off the Today bucket — so the index-kind refusal fires, naming the
      // kind of every movee.
      expect(r.detail).toContain("one kind at a time");
      expect(r.detail).toContain(`${proj} (project)`);
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

describe('ORDFIN2 TOMORROWLIST — the one-call `list "Tomorrow"` fast path (planner routing)', () => {
  // NOW = 2026-07-05, so tomorrow = 2026-07-06; a later day = 2026-07-20.
  const TOMORROW = "2026-07-06";
  const LATER = "2026-07-20";

  it("a loose tomorrow block routes to the native `tomorrow` scope, not the scratch-park compound", async () => {
    const a = seedTodo(fixture.db, {
      title: "a",
      start: "someday",
      startDate: TOMORROW,
      todayIndex: 20,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      start: "someday",
      startDate: TOMORROW,
      todayIndex: 10,
    });
    const { vectors, calls } = looseDayMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("tomorrow scope");
    expect(calls).not.toContain("project.add"); // native one-call — no scratch project
    expect(ascending(indexOrder([a, b], "todayIndex"))).toBe(true);
  });

  it("a LATER future day rides the SIT4 dated `day` bounce (not tomorrow, no scratch)", async () => {
    const a = seedTodo(fixture.db, {
      title: "a",
      start: "someday",
      startDate: LATER,
      todayIndex: 20,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      start: "someday",
      startDate: LATER,
      todayIndex: 10,
    });
    const { vectors, calls } = datedBounceMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("2026-07-20 day-group");
    expect(calls).not.toContain("project.add"); // pure when= bounce — no scratch project
    expect(calls.every((c) => c === "todo.update")).toBe(true);
  });

  it("a scheduled PROJECT row is ACCEPTED as a movee for tomorrow (O12 inline)", async () => {
    const p = seedProject(fixture.db, {
      title: "P",
      start: "someday",
      startDate: TOMORROW,
      todayIndex: 5,
    });
    const { vectors } = looseDayMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "project.move", {
      uuids: [p],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("tomorrow scope");
  });

  it("an area-less scheduled PROJECT row on a LATER day is now WIRED via the `day` bounce", async () => {
    // SIT4 DAYBNC: area-less project rows front-insert on the shared todayIndex
    // axis via update-project — the loose-scheduled-PROJECT-row cell flips to WIRED.
    const p1 = seedProject(fixture.db, {
      title: "P1",
      start: "someday",
      startDate: LATER,
      todayIndex: 20,
    });
    const p2 = seedProject(fixture.db, {
      title: "P2",
      start: "someday",
      startDate: LATER,
      todayIndex: 10,
    });
    const { vectors, calls } = datedBounceMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "project.move", {
      uuids: [p1, p2],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("2026-07-20 day-group");
    // Project rows dispatch through update-project (the per-type leg op).
    expect(calls.every((c) => c === "project.update")).toBe(true);
    expect(ascending(indexOrder([p1, p2], "todayIndex"))).toBe(true);
  });

  // TMPLSORT/PTMPL: a repeating template's projection routes by its projection day —
  // tomorrow → the native one-call wire; a LATER day → the `day` leg family.
  it("a TOMORROW template routes to the native `tomorrow` scope on the one-call wire", async () => {
    const t = seedTodo(fixture.db, {
      title: "t",
      start: "someday",
      startDate: TOMORROW,
      todayIndex: 20,
    });
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      start: "someday",
      startDate: null,
      todayIndex: 10,
      recurrenceRule: true,
      nextInstanceStartDate: TOMORROW,
    });
    const { vectors, calls } = templateDayMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [tmpl, t],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("tomorrow scope");
    // One native `list "Tomorrow"` wire carries the template — no per-template leg.
    expect(calls).toContain("reorder:tomorrow");
    expect(calls).not.toContain("reorder:upcoming");
  });

  it('a LATER-day template routes to the `day` leg family (single-id `list "Upcoming"` leg)', async () => {
    const s = seedTodo(fixture.db, {
      title: "s",
      start: "someday",
      startDate: LATER,
      todayIndex: 0,
    });
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      start: "someday",
      startDate: null,
      todayIndex: -5,
      recurrenceRule: true,
      nextInstanceStartDate: LATER,
    });
    const { vectors, calls } = templateDayMoveVectors();
    // Target: template on top of the scheduled row.
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [tmpl, s],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("2026-07-20 day-group");
    // The template rides the single-id `list "Upcoming"` native leg; the scheduled row a when= leg.
    expect(calls).toContain("reorder:upcoming");
    expect(calls).toContain("todo.update");
    expect(calls).not.toContain("reorder:tomorrow");
    expect(ascending(indexOrder([tmpl, s], "todayIndex"))).toBe(true);
  });
});

/**
 * Move-layer sim of the DLBNC deadline-cycle interleaved with the scheduled bounce.
 * A `when=` leg front-inserts at the combined block min (scheduled + forecast); a
 * `deadline=` (empty) clears; a `deadline=<ISO>` re-sets + front-inserts. One shared
 * todayIndex axis so a scheduled+forecast mix interleaves in one reverse-target pass.
 */
function datedForecastMoveVectors() {
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
  const applyWhen = (uuid: string, when: string): void => {
    const at = when.indexOf("@");
    const base = at >= 0 ? when.slice(0, at) : when;
    const packed = base === "today" ? TODAY_PACKED : encodePackedDate(base);
    const startVal = packed > TODAY_PACKED ? 2 : 1;
    fixture.db
      .prepare(
        `UPDATE TMTask SET start = ?, startDate = ?, startBucket = 0, todayIndex = ?,
         userModificationDate = ? WHERE uuid = ?`,
      )
      .run(startVal, packed, blockMin(packed) - 1, modClock++, uuid);
  };
  const applyDeadline = (uuid: string, deadline: string | null): void => {
    if (deadline === null || deadline === "") {
      fixture.db
        .prepare("UPDATE TMTask SET deadline = NULL, userModificationDate = ? WHERE uuid = ?")
        .run(modClock++, uuid);
      return;
    }
    const packed = encodePackedDate(deadline);
    fixture.db
      .prepare(
        "UPDATE TMTask SET deadline = ?, todayIndex = ?, userModificationDate = ? WHERE uuid = ?",
      )
      .run(packed, blockMin(packed) - 1, modClock++, uuid);
  };
  const urlFake: WriteVector = {
    id: "url-scheme",
    matrix: {
      "todo.update": { support: "yes", disruption: 0, validation: "validated" },
      "project.update": { support: "yes", disruption: 0, validation: "validated" },
    },
    async execute(inv) {
      calls.push(inv.op ?? "?");
      const p = inv.opParams as { uuid: string; when?: string; deadline?: string | null };
      if (inv.op === "todo.update" || inv.op === "project.update") {
        if (p.deadline !== undefined) applyDeadline(p.uuid, p.deadline);
        else applyWhen(p.uuid, p.when ?? "");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vectors: [urlFake], calls };
}

/** A deadline-forecast to-do: someday/anytime stage, NO startDate, future deadline. */
function seedForecast(
  title: string,
  deadline: string,
  todayIndex: number,
  index: number,
  extra: Partial<Parameters<typeof seedTodo>[1]> = {},
): string {
  return seedTodo(fixture.db, {
    title,
    start: "someday",
    startDate: null,
    deadline,
    todayIndex,
    index,
    ...extra,
  });
}

/** A deadline-forecast PROJECT (PROJDL / #385): someday stage, NO startDate, future deadline. */
function seedForecastProject(
  title: string,
  deadline: string,
  todayIndex: number,
  index: number,
  extra: Partial<Parameters<typeof seedProject>[1]> = {},
): string {
  return seedProject(fixture.db, {
    title,
    start: "someday",
    startDate: null,
    deadline,
    todayIndex,
    index,
    ...extra,
  });
}

describe("planner: DEADLINE-FORECAST rows route to the `day` scope (DLBNC / #383)", () => {
  it("loose forecast rows route to the `day` scope (deadline-cycle), not someday", async () => {
    const a = seedForecast("a", "2026-07-20", -100, 5);
    const b = seedForecast("b", "2026-07-20", -200, 9);
    const { vectors, calls } = datedForecastMoveVectors();
    // A same-day loose forecast set is dual-axis (the Upcoming day-block AND the
    // loose Someday index) — a BARE reorder now refuses; `--in upcoming` names the
    // day-block axis this test exercises.
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
      in: "upcoming",
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("2026-07-20 day-group");
    }
    expect(ascending(indexOrder([a, b], "todayIndex"))).toBe(true);
    // Deadline-cycle legs only (deadline= clear + re-set), no native reorder / scratch.
    expect(calls.every((c) => c === "todo.update")).toBe(true);
    // start=2 / startDate NULL preserved (never de-scheduled).
    for (const u of [a, b]) {
      const row = fixture.db
        .prepare("SELECT start, startDate, deadline FROM TMTask WHERE uuid = ?")
        .get(u) as { start: number; startDate: number | null; deadline: number };
      expect(row.start).toBe(2);
      expect(row.startDate).toBeNull();
      expect(row.deadline).toBe(encodePackedDate("2026-07-20"));
    }
  });

  it('a forecast deadline == TOMORROW still routes to `day` (never the re-dating `list "Tomorrow"` sort)', async () => {
    // list "Tomorrow" RE-DATES a forecast row (stamps startDate, UPCDL-5), so a
    // forecast group NEVER rides the native tomorrow sort — always the deadline-cycle.
    const a = seedForecast("a", "2026-07-06", -100, 3); // deadline == tomorrow
    const b = seedForecast("b", "2026-07-06", -200, 7);
    const { vectors, calls } = datedForecastMoveVectors();
    // `--in upcoming` names the day-block axis (the bare form is dual-axis-refused);
    // a forecast group still rides `day`, NEVER the re-dating `list "Tomorrow"` sort.
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
      in: "upcoming",
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.note).toContain("2026-07-06 day-group"); // the `day` scope, not "Tomorrow"
      expect(r.note).not.toContain("Tomorrow");
    }
    // deadline= legs, NOT a native `list "Tomorrow"` reorder.
    expect(calls.every((c) => c === "todo.update")).toBe(true);
  });

  it("a scheduled + forecast mix on ONE day interleaves via the `day` scope (one axis)", async () => {
    const s1 = seedTodo(fixture.db, {
      title: "s1",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: -50,
    });
    const f1 = seedForecast("f1", "2026-07-20", -150, 4);
    const { vectors } = datedForecastMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [s1, f1],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("2026-07-20 day-group");
    // The scheduled row kept its date; the forecast row kept its forecast state.
    const s1row = fixture.db
      .prepare("SELECT startDate, startBucket FROM TMTask WHERE uuid = ?")
      .get(s1) as { startDate: number; startBucket: number };
    expect(s1row.startDate).toBe(encodePackedDate("2026-07-20"));
    const f1row = fixture.db
      .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
      .get(f1) as { start: number; startDate: number | null };
    expect(f1row.start).toBe(2);
    expect(f1row.startDate).toBeNull();
  });

  it("axis-aware anchor: a forecast movee positions --before a SCHEDULED same-day row (one bucket)", async () => {
    // #342 axis-aware anchor: forecast + scheduled same-day rows are one bucket, so
    // a scheduled row is a valid anchor for a forecast movee (they share the axis).
    const sched = seedTodo(fixture.db, {
      title: "sched",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: -300,
    });
    const f1 = seedForecast("f1", "2026-07-20", -100, 2);
    const { vectors } = datedForecastMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [f1],
      position: { before: sched },
    });
    expect(r.kind).toBe("move-ok"); // anchor accepted (same day-block axis)
  });

  it("axis-aware anchor: an anchor on a DIFFERENT deadline day is refused (never migrates)", async () => {
    const f1 = seedForecast("f1", "2026-07-20", -100, 1);
    const other = seedForecast("other", "2026-07-21", -100, 2); // different day
    const { vectors } = datedForecastMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [f1],
      position: { before: other },
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.refusal).toBe("blocked");
  });

  it("a lone forecast PROJECT routes to the `day` scope via the update-project deadline-cycle (PROJDL / #385)", async () => {
    // PROJDL-2a/2b: a forecast project carries the block todayIndex axis and reorders
    // via the update-project deadline-cycle — `project reorder` must route it to `day`.
    const fp = seedForecastProject("fp", "2026-07-20", -100, 5);
    const { vectors, calls } = datedForecastMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "project.move", {
      uuids: [fp],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("2026-07-20 day-group");
    }
    // Per-type deadline-cycle: the project's legs went through update-project.
    expect(calls.every((c) => c === "project.update")).toBe(true);
    // PROJSTAR-safe: start=2 / startDate NULL / deadline preserved (never de-scheduled,
    // never accidentally starred — PROJDL-2b).
    const row = fixture.db
      .prepare("SELECT start, startDate, deadline, type FROM TMTask WHERE uuid = ?")
      .get(fp) as { start: number; startDate: number | null; deadline: number; type: number };
    expect(row.start).toBe(2);
    expect(row.startDate).toBeNull();
    expect(row.deadline).toBe(encodePackedDate("2026-07-20"));
    expect(row.type).toBe(1);
  });

  it("`todo reorder` intermixes a forecast to-do + forecast PROJECT on ONE day-block (PROJDL-2c)", async () => {
    // PROJDL-2c: projects + to-dos share the one deadline day-block axis and can be
    // interleaved to an exact target via a unified reverse-target pass — a project
    // movee on the `todo reorder` path is legal (not "homogeneous kinds"), routing to
    // `day` even though its display bucket is someday.
    const ft = seedForecast("ft", "2026-07-20", -50, 3);
    const fp = seedForecastProject("fp", "2026-07-20", -150, 8);
    const idxBefore = indexOrder([fp], `"index"`);
    const { vectors, calls } = datedForecastMoveVectors();
    // A MIXED to-do+project forecast set is single-axis (day only) — the two kinds do
    // not share a container index bucket, so a bare reorder auto-routes to the day-
    // block (no dual-axis refusal); `--in upcoming` names that same axis explicitly.
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [ft, fp],
      position: { at: "first" },
      in: "upcoming",
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("2026-07-20 day-group");
    // Interleaved to the requested order on the shared todayIndex axis.
    expect(ascending(indexOrder([ft, fp], "todayIndex"))).toBe(true);
    // Per-type legs: the project via update-project, the to-do via todo.update.
    expect(calls).toContain("project.update");
    expect(calls).toContain("todo.update");
    // The project's someday-bucket `index` is byte-identical (deadline-cycle never
    // touches it) and it stays a forecast project (start=2, startDate NULL).
    expect(indexOrder([fp], `"index"`)).toEqual(idxBefore);
    const row = fixture.db
      .prepare("SELECT start, startDate FROM TMTask WHERE uuid = ?")
      .get(fp) as { start: number; startDate: number | null };
    expect(row.start).toBe(2);
    expect(row.startDate).toBeNull();
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

  it("a loose FUTURE-day start=2 movee routes to the `day` bounce, NOT the someday protocol", async () => {
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
    const { vectors, calls } = datedBounceMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("2026-07-20 day-group");
    }
    // The dated `day` bounce ran — NOT a Someday when=anytime bounce (which would
    // clear the date). Every leg is a dated todo.update, no scratch project.
    expect(calls).not.toContain("project.add");
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
    // These loose arrived rows are now DUAL-AXIS (Today view + loose Anytime index
    // via the SIT6 LOOSEPARK protocol), so --in today names the view axis being
    // asserted (the point of this test is the arrived → today classification).
    const r = await runInPlaceReorder(
      deps({ vectors: [membershipVector(), reorderVector("todayIndex")] }),
      "todo.move",
      { uuids: [b, a], position: { at: "first" }, in: "today" },
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

  it("a dated direct-area movee routes to the SAFE `day` bounce, NEVER a de-scheduling bounce", async () => {
    // THE de-schedule hazard: the area-someday (and project-someday) reorder is a
    // when= bounce whose away leg `when=anytime` CLEARS a startDate — a dated
    // movee must NEVER reach it. A direct-area scheduled-day child now routes to
    // the SIT4 dated `day` bounce (a cross-DATE when= round-trip that preserves the
    // area FK and the date, no scratch project). The dry-run pins the classifier so
    // the planner never proposes the destructive someday bounce.
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
      expect(r.plan.placement).toContain("scope=day");
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

describe("regression: ARRIVED container children are Today members, not day-group members", () => {
  // BUG (2026-07-31): the dated branches of reorderTargetOf classified a row by
  // its date-GROUP without first checking arrived-ness, so an arrived container
  // child (startDate <= today) misrouted into a future day-group compound
  // (area-day / container-day / heading-day) instead of the shipped today/evening
  // scopes — the same class of bug #325 fixed in scheduleBucket. The GUI renders
  // arrived/today-dated rows in TODAY; the Upcoming day-groups hold STRICTLY
  // FUTURE dates only. NOW = 2026-07-05; "2026-07-03" is a 2-day-past arrival.

  /**
   * The reorder scope an in-place reorder of these movees routes to (dry-run). An
   * arrived container child is DUAL-AXIS (the view's todayIndex slot AND its
   * container's native index slot), so `--in <view>` disambiguates to the view axis
   * asserted here — the arrived-vs-day-group classification is exactly what it pins.
   */
  async function routedScope(uuids: string[], inTarget?: string): Promise<string> {
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids, ...(inTarget !== undefined && { in: inTarget }) },
      { dryRun: true },
    );
    if (r.kind !== "move-dry-run") throw new Error(`expected move-dry-run, got ${r.kind}`);
    return r.plan.placement;
  }

  it("an arrived (2-day-past) direct-area to-do routes to the today scope, NOT area-day", async () => {
    const area = seedArea(fixture.db, "A");
    const arrived = seedTodo(fixture.db, {
      title: "arrived",
      area,
      start: "someday", // app-true dated form (start=2 + a date)
      startDate: "2026-07-03",
      todayIndex: 1,
    });
    const placement = await routedScope([arrived], "today");
    expect(placement).toContain("scope=today");
    expect(placement).not.toContain("area-day");
  });

  it("an evening-flagged today-dated direct-area to-do routes to the evening scope", async () => {
    const area = seedArea(fixture.db, "A");
    const eve = seedTodo(fixture.db, {
      title: "eve",
      area,
      startDate: "2026-07-05", // today
      evening: true, // startBucket=1 → This Evening (live only while date == today, §9n)
      todayIndex: 1,
    });
    expect(await routedScope([eve], "evening")).toContain("scope=evening");
  });

  it("a today-dated project child routes to the today scope, NOT container-day", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const child = seedTodo(fixture.db, {
      title: "child",
      project: proj,
      start: "someday",
      startDate: "2026-07-05", // today (arrived)
      todayIndex: 1,
    });
    const placement = await routedScope([child], "today");
    expect(placement).toContain("scope=today");
    expect(placement).not.toContain("container-day");
  });

  it("an arrived headed child routes to the today scope, NOT heading-day", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const child = seedTodo(fixture.db, {
      title: "hc",
      heading,
      start: "someday",
      startDate: "2026-07-03", // arrived
      todayIndex: 1,
    });
    const placement = await routedScope([child]);
    expect(placement).toContain("scope=today");
    expect(placement).not.toContain("heading-day");
  });

  it("strictly-FUTURE dates are unchanged — each container child keeps its day-group scope", async () => {
    // The fix reroutes ONLY arrived rows; a future date keeps day-group routing.
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const area = seedArea(fixture.db, "A");
    const projChild = seedTodo(fixture.db, {
      title: "pc",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const headChild = seedTodo(fixture.db, {
      title: "hc",
      heading,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const areaChild = seedTodo(fixture.db, {
      title: "ac",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const looseRow = seedTodo(fixture.db, {
      title: "loose",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    // A single UNHEADED PROJECT container keeps the cheap native container-day
    // re-rank; every other future day-group rides the SIT4 dated `day` bounce.
    expect(await routedScope([projChild])).toContain("scope=container-day");
    expect(await routedScope([headChild])).toContain("scope=day");
    expect(await routedScope([areaChild])).toContain("scope=day");
    expect(await routedScope([looseRow])).toContain("scope=day");
  });
});

describe("regression: day-group refusal copy carries the ISO date (no self-contradiction)", () => {
  // BUG (2026-07-31): every day-group container label rendered WITHOUT its date,
  // so a cross-day anchor refusal read "the anchor … is in the loose future-day
  // group, not the movees' container (the loose future-day group)" — the same
  // label on both sides. A day-group's identity IS its day, so the label must
  // name the ISO date. NOW = 2026-07-05.

  it("a cross-day loose anchor refusal names BOTH dates and reads coherently", async () => {
    const movee = seedTodo(fixture.db, {
      title: "m",
      start: "someday",
      startDate: "2026-08-05",
      todayIndex: 1,
    });
    // The anchor is a loose scheduled PROJECT on a DIFFERENT future day (the repro
    // shape) — targetOf treats a loose row as a loose future-day member either way.
    const anchor = seedProject(fixture.db, {
      title: "P",
      start: "someday",
      startDate: "2026-08-07",
      todayIndex: 1,
    });
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [movee],
      position: { after: anchor },
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      // The dated `day` bounce validates the anchor by day-group membership: the
      // anchor lives on a DIFFERENT day, so it is not in the movee's group. The
      // refusal names the movee's day (its identity IS its date), never the old
      // date-less label that read identically on both sides.
      expect(r.detail).toContain("the 2026-08-05 day-group");
      expect(r.detail).not.toContain("the loose future-day group");
      expect(r.detail).toContain("an anchor positions, it never migrates");
    }
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
  /**
   * The reorder scope an in-place reorder of these movees routes to (dry-run). A
   * NATIVE-index child (project/area) that is an Evening member is DUAL-AXIS (the
   * evening view AND its container index), so `--in evening` disambiguates to the
   * view axis the evening tests assert; a HEADING child's index axis is a bounce
   * (not Today-flag-safe) so it is single-axis and needs no `--in`.
   */
  async function routedScope(uuids: string[], inTarget?: string): Promise<string> {
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids, ...(inTarget !== undefined && { in: inTarget }) },
      { dryRun: true },
    );
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

  it("a headed same-day SCHEDULED child routes to the `day` bounce (heading FK preserved, §9k rail)", async () => {
    // SIT4 DAYBNC: the dated when= round-trip preserves the heading FK, so a headed
    // same-day child just bounces — no unhead→re-head round-trip, and NEVER the
    // native container-day reorder (which RIPS the heading, §9k).
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
    expect(placement).toContain("scope=day");
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
    expect(await routedScope([e1], "evening")).toContain("scope=evening");
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
    expect(await routedScope([e1], "evening")).toContain("scope=evening");
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
    // --in evening resolves the dual-axis ambiguity (evening view vs the project
    // index) so the routing reaches the bounce-disabled degrade being asserted.
    const r = await runInPlaceReorder(
      noBounce,
      "todo.move",
      { uuids: [e1], in: "evening" },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("bounce");
  });
});

// ------------------ SIT4 dated `day` bounce planner routing (supersedes the
// former loose-day / area-day / upcoming-day / heading-day compounds)

describe("SIT4 dated `day` bounce planner routing", () => {
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

  it("a same-area future-day group routes to the `day` bounce (container-less global axis)", async () => {
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
    expect(await routedScope([a, b])).toContain("scope=day");
  });

  it("a CROSS-CONTAINER future-day group routes to the `day` bounce (not the span-refusal)", async () => {
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
    expect(await routedScope([projChild, areaChild])).toContain("scope=day");
  });

  it("a MIXED to-do + area-less project future-day group routes to the `day` bounce", async () => {
    // The first mixed-kind day-group: a loose to-do + an area-less project row on
    // one August day. `todo reorder` accepts the project intermixed (globalAxis).
    const todo = seedTodo(fixture.db, {
      title: "t",
      start: "someday",
      startDate: "2026-08-12",
      todayIndex: 10,
    });
    const proj = seedProject(fixture.db, {
      title: "P",
      start: "someday",
      startDate: "2026-08-12",
      todayIndex: 20,
    });
    expect(await routedScope([todo, proj])).toContain("scope=day");
  });

  it("a single UNHEADED project container still routes to the cheap native container-day", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    expect(await routedScope([a, b])).toContain("scope=container-day");
  });

  it("a cross-container group on DIFFERENT days still fails closed (span refusal)", async () => {
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

  it("runs the cross-container dated bounce end-to-end, preserving each FK and the order", async () => {
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
    const { vectors, calls } = datedBounceMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [loose, areaChild],
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.placementClass).toBe("guaranteed");
      expect(r.note).toContain("2026-07-20 day-group");
    }
    // NO scratch project — pure when= legs.
    expect(calls).not.toContain("project.add");
    expect(calls).not.toContain("project.delete");
    // The block landed at the top of the day in selection order.
    expect(ascending(indexOrder([loose, areaChild], "todayIndex"))).toBe(true);
    // Every FK is preserved by the round-trip (never re-homed).
    expect(containerOf(loose)).toMatchObject({ project: null, area: null, heading: null });
    expect(containerOf(projChild).project).toBe(proj);
    expect(containerOf(headedChild).heading).toBe(heading);
    expect(containerOf(areaChild).area).toBe(area);
  });

  it("an anchored --after a PROJECT row in the day group works (cross-kind anchor)", async () => {
    const loose = seedTodo(fixture.db, {
      title: "loose",
      start: "someday",
      startDate: "2026-08-12",
      todayIndex: 10,
    });
    const projRow = seedProject(fixture.db, {
      title: "P",
      start: "someday",
      startDate: "2026-08-12",
      todayIndex: 20,
    });
    const { vectors, calls } = datedBounceMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [loose],
      position: { after: projRow },
    });
    expect(r.kind).toBe("move-ok"); // the project row is a valid anchor (same day-group)
    expect(calls).not.toContain("project.add");
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

// ---------------------------------------------------------------------------
// Phase B: `reorder --in` axis disambiguation (dual-axis Today/Evening members)
// ---------------------------------------------------------------------------

describe("reorder --in axis disambiguation (dual-axis Today/Evening members)", () => {
  const dryReorder = (uuids: string[], inTarget?: string) =>
    runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids, ...(inTarget !== undefined && { in: inTarget }) },
      { dryRun: true },
    );

  it("refuses a dual-axis set (same-project Today members) with NO --in, naming both spellings", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 1,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 2,
    });
    const r = await dryReorder([a, b]);
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("blocked");
      expect(r.detail).toContain("ambiguous");
      expect(r.remediation).toContain("--in today");
      expect(r.remediation).toContain('--in "Work"');
    }
  });

  it("--in today and --in <project> compile DIFFERENT axes on the SAME rows", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 1,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 2,
    });
    const view = await dryReorder([a, b], "today");
    expect(view.kind).toBe("move-dry-run");
    if (view.kind === "move-dry-run") expect(view.plan.placement).toContain("scope=today");
    const index = await dryReorder([a, b], "Work");
    expect(index.kind).toBe("move-dry-run");
    if (index.kind === "move-dry-run") expect(index.plan.placement).toContain("scope=project");
  });

  it("--in naming a container the rows are NOT in is a usage error", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    seedProject(fixture.db, { title: "Other" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 1,
    });
    const r = await dryReorder([a], "Other");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("not in it");
    }
  });

  it("--in today when the items are NOT Today members is a clear error", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "active" }); // loose anytime
    const b = seedTodo(fixture.db, { title: "b", start: "active" });
    const r = await dryReorder([a, b], "today");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") expect(r.detail).toContain("not Today members");
  });

  it("a cross-container Today set is UNAMBIGUOUS (no --in needed) → today", async () => {
    const p1 = seedProject(fixture.db, { title: "P1" });
    const p2 = seedProject(fixture.db, { title: "P2" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: p1,
      startDate: "2026-07-05",
      todayIndex: 1,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: p2,
      startDate: "2026-07-05",
      todayIndex: 2,
    });
    const r = await dryReorder([a, b]);
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=today");
  });

  it("a loose-only Today set is now DUAL-AXIS (LOOSEPARK makes the anytime index honest) → ambiguous", async () => {
    // SIT6: the loose Anytime index axis is now a flag-safe alternative (LOOSEPARK),
    // so a loose Today set is genuinely ambiguous between the Today view and the
    // anytime index — refuse and offer BOTH spellings (was silently → today).
    const a = seedTodo(fixture.db, { title: "a", startDate: "2026-07-05", todayIndex: 1 });
    const b = seedTodo(fixture.db, { title: "b", startDate: "2026-07-05", todayIndex: 2 });
    const r = await dryReorder([a, b]);
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("blocked");
      expect(r.detail).toContain("ambiguous");
      expect(r.remediation).toContain("--in today");
      expect(r.remediation).toContain("--in anytime");
    }
  });

  it("--in <heading> on flagged members SWAPS to the flag-safe HEADMOVE (was refused)", async () => {
    // SIT6: forcing the heading index axis on a Today member is honest now — the
    // planner routes the flagged set through the unhead→re-head HEADMOVE protocol.
    const proj = seedProject(fixture.db, { title: "P" });
    const heading = seedHeading(fixture.db, { title: "H", project: proj });
    const a = seedTodo(fixture.db, {
      title: "a",
      heading,
      startDate: "2026-07-05",
      todayIndex: 1,
      index: 10,
    });
    const b = seedTodo(fixture.db, { title: "b", heading, start: "active", index: 20 });
    const r = await dryReorder([a, b], "H");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=heading");
  });

  it("--in anytime on loose flagged members SWAPS to the flag-safe LOOSEPARK (was refused)", async () => {
    // SIT6: the loose Anytime index axis is flag-safe (LOOSEPARK), so --in anytime
    // on a loose Today member is honored, not refused.
    const a = seedTodo(fixture.db, {
      title: "a",
      startDate: "2026-07-05",
      todayIndex: 1,
      index: 10,
    });
    const b = seedTodo(fixture.db, { title: "b", start: "active", index: 20 });
    const r = await dryReorder([a, b], "anytime");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=anytime");
  });

  it("--in loose is a usage error (a read view, not a reorder bucket)", async () => {
    const a = seedTodo(fixture.db, { title: "a", startDate: "2026-07-05", todayIndex: 1 });
    const r = await dryReorder([a], "loose");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("not valid");
    }
  });

  it("--in <project> RE-RANKS Today members on the container index, preserving the Today flag", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    const a = seedTodo(fixture.db, {
      title: "a",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 1,
      index: 10,
    });
    const b = seedTodo(fixture.db, {
      title: "b",
      project: proj,
      startDate: "2026-07-05",
      todayIndex: 2,
      index: 20,
    });
    // Put b before a on the PROJECT index axis (not the Today view).
    const r = await runInPlaceReorder(deps(), "todo.move", { uuids: [b, a], in: "Work" });
    expect(r.kind).toBe("move-ok");
    expect(indexOrder([b])[0]!).toBeLessThan(indexOrder([a])[0]!);
    // The Today flag survived (native index re-rank writes only "index").
    const arow = fixture.db
      .prepare("SELECT startDate, startBucket FROM TMTask WHERE uuid = ?")
      .get(a) as { startDate: number; startBucket: number };
    expect(arow.startBucket).toBe(0);
    expect(arow.startDate).toBe(TODAY_PACKED);
  });

  it("a plain anytime project child reorders with NO --in (single-axis, unchanged)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "active", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", project: proj, start: "active", index: 20 });
    const r = await dryReorder([a, b]);
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=project");
  });
});

// ---------------------------------------------------------------------------
// Phase B: `--in` day-axis tokens + forecast dual-axis + list-token tightening
// ---------------------------------------------------------------------------

describe("reorder --in day-axis tokens (<YYYY-MM-DD> / upcoming)", () => {
  const dry = (uuids: string[], inTarget?: string) =>
    runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids, ...(inTarget !== undefined && { in: inTarget }) },
      { dryRun: true },
    );

  it("--in <ISO-date> routes a shared-day forecast set to the day-block (deadline-cycle)", async () => {
    const a = seedForecast("a", "2026-07-20", -100, 5);
    const b = seedForecast("b", "2026-07-20", -200, 9);
    const { vectors } = datedForecastMoveVectors();
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: [a, b],
      position: { at: "first" },
      in: "2026-07-20",
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") expect(r.note).toContain("2026-07-20 day-group");
  });

  it("--in <ISO-date> routes a shared-day SCHEDULED set to the day-block (no container needed)", async () => {
    // Cross-container scheduled rows on one future day — the ISO token names the
    // ONE cross-container sortability bucket (no shared-container requirement).
    const proj = seedProject(fixture.db, { title: "P" });
    const area = seedArea(fixture.db, "A");
    const pc = seedTodo(fixture.db, {
      title: "pc",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const ac = seedTodo(fixture.db, {
      title: "ac",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    const r = await dry([pc, ac], "2026-07-20");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });

  it("--in <today-or-past date> refuses, pointing at --in today", async () => {
    const a = seedTodo(fixture.db, { title: "a", startDate: "2026-07-05", todayIndex: 1 });
    const r = await dry([a], "2026-07-05");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("not a future day");
      expect(r.detail).toContain("--in today");
    }
  });

  it("--in <ISO-date> refuses a movee not on that day, naming it", async () => {
    const on = seedForecast("on", "2026-07-20", -100, 3);
    const off = seedForecast("off", "2026-07-21", -100, 4);
    const r = await dry([on, off], "2026-07-20");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain(off);
      expect(r.detail).toContain("not on that day");
    }
  });

  it("--in <malformed date> is a usage error", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "active" });
    const r = await dry([a], "2026-13-40");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("not a valid calendar date");
    }
  });

  it("--in upcoming routes the single shared future day to the day-block", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const area = seedArea(fixture.db, "A");
    const pc = seedTodo(fixture.db, {
      title: "pc",
      project: proj,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 10,
    });
    const ac = seedTodo(fixture.db, {
      title: "ac",
      area,
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 20,
    });
    const r = await dry([pc, ac], "upcoming");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });

  it("--in upcoming refuses a set spanning days, listing the per-item days", async () => {
    const d1 = seedTodo(fixture.db, {
      title: "d1",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: 1,
    });
    const d2 = seedTodo(fixture.db, {
      title: "d2",
      start: "someday",
      startDate: "2026-07-21",
      todayIndex: 1,
    });
    const r = await dry([d1, d2], "upcoming");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("blocked");
      expect(r.detail).toContain("2026-07-20");
      expect(r.detail).toContain("2026-07-21");
    }
  });
});

describe("reorder forecast dual-axis refusal (§9o dual-citizen — bare reorder)", () => {
  const dry = (uuids: string[], inTarget?: string) =>
    runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids, ...(inTarget !== undefined && { in: inTarget }) },
      { dryRun: true },
    );

  it("refuses a bare same-day LOOSE forecast set, naming the real date + the list spelling", async () => {
    const a = seedForecast("a", "2026-07-20", -100, 3);
    const b = seedForecast("b", "2026-07-20", -200, 7);
    const r = await dry([a, b]);
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("blocked");
      expect(r.detail).toContain("ambiguous");
      expect(r.detail).toContain("2026-07-20");
      expect(r.remediation).toContain("--in 2026-07-20");
      expect(r.remediation).toContain("--in someday");
    }
  });

  it("refuses a bare same-day same-PROJECT forecast set, naming the container spelling", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    const a = seedForecast("a", "2026-07-20", -100, 3, { project: proj });
    const b = seedForecast("b", "2026-07-20", -200, 7, { project: proj });
    const r = await dry([a, b]);
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.remediation).toContain("--in 2026-07-20");
      expect(r.remediation).toContain('--in "Work"');
    }
  });

  it("a forecast set SPANNING containers is single-axis (day only) → auto-routes, no refusal", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedForecast("a", "2026-07-20", -100, 3, { project: proj });
    const b = seedForecast("b", "2026-07-20", -200, 7); // loose — different index bucket
    const r = await dry([a, b]);
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });

  it("a MIXED scheduled + forecast same-day set is single-axis (day only) → auto-routes", async () => {
    const sched = seedTodo(fixture.db, {
      title: "s",
      start: "someday",
      startDate: "2026-07-20",
      todayIndex: -50,
    });
    const fc = seedForecast("f", "2026-07-20", -150, 4);
    const r = await dry([sched, fc]);
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });
});

describe("reorder --in list-token bug-fix + tightening (spec rules 2/4)", () => {
  const dry = (uuids: string[], inTarget?: string) =>
    runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids, ...(inTarget !== undefined && { in: inTarget }) },
      { dryRun: true },
    );

  it("BUG-FIX: --in someday on a same-day forecast set compiles the INDEX re-rank, not the day bounce", async () => {
    // Requirement 2: an explicit index axis must never be overridden by the day
    // auto-route. Loose forecast someday rows → the someday list index re-rank.
    const a = seedForecast("a", "2026-07-20", -100, 3);
    const b = seedForecast("b", "2026-07-20", -200, 7);
    const r = await dry([a, b], "someday");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") {
      expect(r.plan.placement).toContain("scope=someday");
      expect(r.plan.placement).not.toContain("scope=day");
    }
  });

  it("--in <project> on a same-day forecast set compiles the project index re-rank, not the day bounce", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    const a = seedForecast("a", "2026-07-20", -100, 3, { project: proj });
    const b = seedForecast("b", "2026-07-20", -200, 7, { project: proj });
    const r = await dry([a, b], "Work");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") {
      expect(r.plan.placement).toContain("scope=project");
      expect(r.plan.placement).not.toContain("scope=day");
    }
  });

  it("--in someday accepts same-PROJECT someday children (shared direct container)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", project: proj, start: "someday", index: 20 });
    const r = await dry([a, b], "someday");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=project");
  });

  it("--in someday refuses movees in DIFFERENT containers, naming them", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const a = seedTodo(fixture.db, { title: "a", project: proj, start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "someday", index: 20 }); // loose
    const r = await dry([a, b], "someday");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("different containers");
      expect(r.detail).toContain(a);
      expect(r.detail).toContain(b);
    }
  });

  it("--in someday refuses a movee that is NOT someday-stage, naming it", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "someday", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", start: "active", index: 20 }); // anytime
    const r = await dry([a, b], "someday");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("someday-stage");
      expect(r.detail).toContain(b);
    }
  });

  it("--in inbox refuses a non-inbox movee", async () => {
    const a = seedTodo(fixture.db, { title: "a", start: "inbox", index: 1 });
    const b = seedTodo(fixture.db, { title: "b", start: "active", index: 2 });
    const r = await dry([a, b], "inbox");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("inbox-stage");
    }
  });

  it("--in anytime accepts a same-AREA anytime set (shared direct container)", async () => {
    const area = seedArea(fixture.db, "A");
    const a = seedTodo(fixture.db, { title: "a", area, start: "active", index: 10 });
    const b = seedTodo(fixture.db, { title: "b", area, start: "active", index: 20 });
    const r = await dry([a, b], "anytime");
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=area");
  });
});

// ---------------------------------------------------------------------------
// Index-axis SINGLE-KIND rule: an index bucket sorts each object KIND in its own
// rank space, so a to-do+project mix (or a heading, which has no index/day/view
// order at all) is refused on the stage-list and container `--in` tokens — even
// when the kinds share a container. The GLOBAL day/Today/Evening axes keep
// intermixing kinds. (Closes the #387 trap: a same-day forecast set's index token
// used to slip the bucket-only relaxation and silently munge the mixed set.)
// ---------------------------------------------------------------------------

describe("reorder index-axis single-kind rule (spec axis-isolation)", () => {
  const dry = (
    uuids: string[],
    inTarget?: string,
    op: "todo.move" | "project.move" = "todo.move",
  ) =>
    runInPlaceReorder(
      deps(),
      op,
      { uuids, ...(inTarget !== undefined && { in: inTarget }) },
      { dryRun: true },
    );

  it("--in someday refuses a mixed to-do + FORECAST project sharing a project (the #387 trap)", async () => {
    // The trap: both are same-day deadline-forecast rows in ONE project, so they
    // pass the shared-container + stage checks — but someday to-dos and someday
    // projects are DIFFERENT index buckets, so the mix is refused (formerly it
    // silently compiled the someday index re-rank).
    const proj = seedProject(fixture.db, { title: "Work" });
    const t = seedForecast("t", "2026-07-20", -100, 3, { project: proj });
    const p = seedForecastProject("p", "2026-07-20", -200, 7, { project: proj });
    const r = await dry([t, p], "someday");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("one kind at a time");
      expect(r.detail).toContain(`${t} (to-do)`);
      expect(r.detail).toContain(`${p} (project)`);
      // NOT a silent compile: no someday index re-rank leaked through.
      expect((r as { plan?: unknown }).plan).toBeUndefined();
    }
  });

  it("--in someday refuses a mixed NON-forecast to-do + project sharing an area", async () => {
    // Requirement 1's shared-container case without deadlines: an area's someday
    // to-do and someday project still refuse (different index buckets).
    const area = seedArea(fixture.db, "A");
    const t = seedTodo(fixture.db, { title: "t", area, start: "someday", index: 3 });
    const p = seedProject(fixture.db, { title: "p", area, start: "someday", index: 7 });
    const r = await dry([t, p], "someday");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("one kind at a time");
    }
  });

  it("--in anytime refuses a mixed to-do + project sharing an area", async () => {
    const area = seedArea(fixture.db, "A");
    const t = seedTodo(fixture.db, { title: "t", area, start: "active", index: 3 });
    const p = seedProject(fixture.db, { title: "p", area, start: "active", index: 7 });
    const r = await dry([t, p], "anytime");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("one kind at a time");
    }
  });

  it("--in <container> refuses a mixed forecast to-do + project in that project", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    const t = seedForecast("t", "2026-07-20", -100, 3, { project: proj });
    const p = seedForecastProject("p", "2026-07-20", -200, 7, { project: proj });
    const r = await dry([t, p], "Work");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("one kind at a time");
    }
  });

  it("--in inbox with a project gives a KIND refusal, not a confusing stage message (rule 2)", async () => {
    // A forecast project on `--in inbox` used to slip the bucket relaxation and hit
    // the stage check, refusing with "not inbox-stage — in the someday bucket". It
    // must refuse on KIND instead (a project is never an inbox reorder member).
    const t = seedTodo(fixture.db, { title: "t", start: "inbox", index: 1 });
    const p = seedForecastProject("p", "2026-07-20", -200, 7);
    const r = await dry([t, p], "inbox");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("one kind at a time");
      expect(r.detail).not.toContain("inbox-stage");
    }
  });

  it("a set of PROJECTS handed to `todo reorder --in someday` points at `things project move`", async () => {
    const a = seedProject(fixture.db, { title: "a", start: "someday", index: 3 });
    const b = seedProject(fixture.db, { title: "b", start: "someday", index: 7 });
    const r = await dry([a, b], "someday");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("every item is a project");
      expect(r.remediation).toContain("things project move");
    }
  });

  // Requirement 3 + 4: a HEADING movee is never a member of ANY reorder bucket — its
  // order is the project's heading axis — so it refuses on every `--in` token (stage,
  // container, day, and view) with the move-heading pointer.
  for (const token of [
    undefined,
    "anytime",
    "someday",
    "inbox",
    "today",
    "evening",
    "upcoming",
    "2026-07-20",
  ]) {
    it(`a heading movee refuses on --in ${token ?? "(bare)"} → points at move-heading`, async () => {
      const proj = seedProject(fixture.db, { title: "P" });
      const h = seedHeading(fixture.db, { title: "H", project: proj });
      const r = await dry([h], token);
      expect(r.kind).toBe("move-refused");
      if (r.kind === "move-refused") {
        expect(r.refusal).toBe("usage");
        expect(r.detail).toContain("heading");
        expect(r.remediation).toContain("things project move-heading");
      }
    });
  }

  it("a heading mixed with a Today to-do on --in today still refuses (heading is never a member)", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const h = seedHeading(fixture.db, { title: "H", project: proj });
    const t = seedTodo(fixture.db, { title: "t", startDate: "2026-07-05", todayIndex: 1 });
    const r = await dry([t, h], "today");
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.remediation).toContain("things project move-heading");
    }
  });
});

// ---------------------------------------------------------------------------
// Global-axis kind-intermix locks: the Today/Evening view and the Upcoming day-
// block sort to-dos and projects TOGETHER, so a mixed set on those tokens compiles
// (never a kind refusal). A cross-kind set is single-axis, so a BARE reorder auto-
// routes to its global axis rather than raising a bogus dual-axis container option.
// ---------------------------------------------------------------------------

describe("reorder global-axis kind intermix (day/Today/Evening — unchanged)", () => {
  it("--in today intermixes a Today to-do + Today project (no kind refusal)", async () => {
    const todo = seedTodo(fixture.db, { title: "t", startDate: "2026-07-05", todayIndex: 10 });
    const proj = seedProject(fixture.db, { title: "P", startDate: "2026-07-05", todayIndex: 20 });
    const r = await runInPlaceReorder(
      deps({ vectors: [membershipVector(), reorderVector("todayIndex")] }),
      "todo.move",
      { uuids: [proj, todo], position: { at: "first" }, in: "today" },
    );
    expect(r.kind).toBe("move-ok");
    expect(indexOrder([proj, todo], "todayIndex")).toEqual([1, 2]);
  });

  it("--in upcoming intermixes a forecast to-do + forecast project on one day-block", async () => {
    const t = seedForecast("t", "2026-07-20", -50, 3);
    const p = seedForecastProject("p", "2026-07-20", -150, 8);
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [t, p], position: { at: "first" }, in: "upcoming" },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });

  it("--in <ISO> intermixes a forecast to-do + forecast project on that day-block", async () => {
    const t = seedForecast("t", "2026-07-20", -50, 3);
    const p = seedForecastProject("p", "2026-07-20", -150, 8);
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [t, p], position: { at: "first" }, in: "2026-07-20" },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });

  it("a BARE mixed-kind forecast set is single-axis → auto-routes to the day-block (no dual-axis refusal)", async () => {
    // Coherence fix: a to-do + project forecast set on one day has no shared
    // container index, so the bare reorder auto-routes to the day-block instead of
    // refusing with a container spelling that would then kind-refuse.
    const t = seedForecast("t", "2026-07-20", -50, 3);
    const p = seedForecastProject("p", "2026-07-20", -150, 8);
    const r = await runInPlaceReorder(deps(), "todo.move", { uuids: [t, p] }, { dryRun: true });
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });

  it("a BARE mixed-kind forecast set sharing a PROJECT still auto-routes (no bogus container option)", async () => {
    const proj = seedProject(fixture.db, { title: "Work" });
    const t = seedForecast("t", "2026-07-20", -50, 3, { project: proj });
    const p = seedForecastProject("p", "2026-07-20", -150, 8, { project: proj });
    const r = await runInPlaceReorder(deps(), "todo.move", { uuids: [t, p] }, { dryRun: true });
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });
});

// ---------------------------------------------------------------------------
// GRNDINT — the mixed-KIND + repeating-template day-block interleave (#393 gate
// fix + refusal surfacing). Before the fix `globalAxisIntermix` gated only on
// scheduleBucket/forecastDeadlineDay, so a template row (startDate NULL, no
// deadline) failed the `.every()` predicate and the whole mixed-kind set was
// refused UPSTREAM with the "one kind at a time" index-kind error before the
// day-axis resolver (which #393 taught to admit templates) ever ran — blocking
// Mike's "both kinds + template, one op" interleave. The predicate now counts a
// strictly-future template projection as a day-group member, so the set falls
// through to the `day` resolver exactly like a template-free one.
// ---------------------------------------------------------------------------

describe("GRNDINT: mixed-kind day-block interleave WITH a repeating template (#393 gate)", () => {
  const DAY = "2026-07-20"; // a LATER day (not tomorrow) → the `day` leg family

  it("the FULL inventory (scheduled+forecast to-dos AND projects + a to-do template) sorts in ONE `--in <day>` op", async () => {
    // Every leg family in one set on 2026-07-20:
    //   scheduled to-do (loose) + scheduled PROJECT (area'd)  → when= bounce
    //   forecast to-do + forecast PROJECT                     → deadline-cycle
    //   a repeating TO-DO template (projects 2026-07-20)       → `list "Upcoming"`
    const sTodo = seedTodo(fixture.db, {
      title: "s-todo",
      start: "someday",
      startDate: DAY,
      todayIndex: -10,
    });
    const area = seedArea(fixture.db, "A");
    const sProj = seedProject(fixture.db, {
      title: "s-proj",
      start: "someday",
      startDate: DAY,
      todayIndex: -20,
      area,
    });
    const fTodo = seedForecast("f-todo", DAY, -30, 3);
    const fProj = seedForecastProject("f-proj", DAY, -40, 8);
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      start: "someday",
      startDate: null,
      todayIndex: -50,
      recurrenceRule: true,
      nextInstanceStartDate: DAY,
    });
    const tmplBefore = fixture.db
      .prepare(
        "SELECT start, startDate, deadline, rt1_recurrenceRule AS rule, rt1_nextInstanceStartDate AS proj, userModificationDate AS umd FROM TMTask WHERE uuid = ?",
      )
      .get(tmpl) as Record<string, unknown>;

    const { vectors, calls } = grandInterleaveMoveVectors();
    // Target order sTodo < sProj < tmpl < fTodo < fProj — a decisively non-default
    // arrangement that interleaves all three mechanisms and both kinds.
    const target = [sTodo, sProj, tmpl, fTodo, fProj];
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: target,
      position: { at: "first" },
      in: DAY,
    });

    expect(r.kind).toBe("move-ok"); // NOT refused "one kind at a time"
    if (r.kind === "move-ok") expect(r.note).toContain("2026-07-20 day-group");
    // Every leg family fired: to-do when=/deadline, project when=/deadline, template upcoming.
    expect(calls).toContain("todo.update");
    expect(calls).toContain("project.update");
    expect(calls).toContain("reorder:upcoming");
    expect(calls).not.toContain("reorder:tomorrow");
    // Landed the exact interleaved order on the shared todayIndex axis.
    expect(ascending(indexOrder(target, "todayIndex"))).toBe(true);

    // §1 crash-path lock: the template NEVER received a dated when=/deadline leg —
    // its start/startDate/deadline/rule/projection/umd are byte-identical; only its
    // todayIndex moved (the umd-silent `list "Upcoming"` front-insert).
    const tmplAfter = fixture.db
      .prepare(
        "SELECT start, startDate, deadline, rt1_recurrenceRule AS rule, rt1_nextInstanceStartDate AS proj, userModificationDate AS umd FROM TMTask WHERE uuid = ?",
      )
      .get(tmpl) as Record<string, unknown>;
    expect(tmplAfter).toEqual(tmplBefore);
    expect(tmplAfter.startDate).toBeNull();
    expect(tmplAfter.deadline).toBeNull();
  });

  it("REVERSED target — the interleave is decisively re-orderable, not a one-way collapse", async () => {
    const sTodo = seedTodo(fixture.db, {
      title: "s-todo",
      start: "someday",
      startDate: DAY,
      todayIndex: -10,
    });
    const sProj = seedProject(fixture.db, {
      title: "s-proj",
      start: "someday",
      startDate: DAY,
      todayIndex: -20,
    });
    const fTodo = seedForecast("f-todo", DAY, -30, 3);
    const fProj = seedForecastProject("f-proj", DAY, -40, 8);
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      start: "someday",
      startDate: null,
      todayIndex: -50,
      recurrenceRule: true,
      nextInstanceStartDate: DAY,
    });
    const { vectors } = grandInterleaveMoveVectors();
    // The reverse of the forward target.
    const reversed = [fProj, fTodo, tmpl, sProj, sTodo];
    const r = await runInPlaceReorder(deps({ vectors }), "todo.move", {
      uuids: reversed,
      position: { at: "first" },
      in: DAY,
    });
    expect(r.kind).toBe("move-ok");
    expect(ascending(indexOrder(reversed, "todayIndex"))).toBe(true);
  });

  it("dry-run: a mixed to-do + project + template set routes to scope=day (was refused pre-fix)", async () => {
    const todo = seedTodo(fixture.db, {
      title: "t",
      start: "someday",
      startDate: DAY,
      todayIndex: -10,
    });
    const proj = seedForecastProject("p", DAY, -20, 8);
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      start: "someday",
      startDate: null,
      todayIndex: -30,
      recurrenceRule: true,
      nextInstanceStartDate: DAY,
    });
    const r = await runInPlaceReorder(
      deps(),
      "todo.move",
      { uuids: [todo, proj, tmpl], position: { at: "first" }, in: DAY },
      { dryRun: true },
    );
    expect(r.kind).toBe("move-dry-run");
    if (r.kind === "move-dry-run") expect(r.plan.placement).toContain("scope=day");
  });

  it("the fix is scoped to the day axis — a mixed set + template on a forced INDEX axis still refuses", async () => {
    // `--in someday` forces the container index axis (kinds NEVER intermix there),
    // so a mixed to-do + project + template set is still the "one kind at a time"
    // refusal — the template disjunct must not leak the relaxation onto an index token.
    const todo = seedTodo(fixture.db, { title: "t", start: "someday" });
    const proj = seedProject(fixture.db, { title: "P", start: "someday" });
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      start: "someday",
      startDate: null,
      recurrenceRule: true,
      nextInstanceStartDate: DAY,
    });
    const r = await runInPlaceReorder(deps(), "todo.move", {
      uuids: [todo, proj, tmpl],
      in: "someday",
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("usage");
      expect(r.detail).toContain("one kind at a time");
    }
  });
});

describe("GRNDINT: H-REORDER-SCOPE placement blocks surface as the canonical top-level refusal", () => {
  const DAY = "2026-07-20";

  it("experimental-off template refusal HOISTS to move-refused (blocked + H-REORDER-SCOPE), not move-leg-failed", async () => {
    // A template-bearing day-group needs the native private reorder surface (a dated
    // when=/deadline leg CRASHES a template). With allow-experimental off the day
    // bounce refuses inside runBounce with the ratified H-REORDER-SCOPE copy. Because
    // nothing landed (pure reposition), that block must surface as the CANONICAL
    // top-level refusal (refusal=blocked → exit 4, named hazard) — NOT buried under a
    // generic move-leg-failed with a verify-failed code.
    const sTodo = seedTodo(fixture.db, {
      title: "s-todo",
      start: "someday",
      startDate: DAY,
      todayIndex: -10,
    });
    const tmpl = seedTodo(fixture.db, {
      title: "tmpl",
      start: "someday",
      startDate: null,
      todayIndex: -20,
      recurrenceRule: true,
      nextInstanceStartDate: DAY,
    });
    const { vectors } = templateDayMoveVectors();
    const r = await runInPlaceReorder(
      deps({ vectors, config: { ...config(), allowExperimental: false } }),
      "todo.move",
      { uuids: [tmpl, sTodo], position: { at: "first" }, in: DAY },
    );
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.refusal).toBe("blocked");
      expect(r.hazard).toBe("H-REORDER-SCOPE");
      expect(r.detail).toContain("allow-experimental is off");
      expect(r.detail).toContain(tmpl); // names the template
      expect(r.remediation).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase B: mixed-stage `todo move` position semantics (spec §4 rule 4)
// ---------------------------------------------------------------------------

describe("mixed-stage todo move position semantics", () => {
  it("--before/--after on a selection spanning stage sub-buckets is refused pre-move", async () => {
    const proj = seedProject(fixture.db, { title: "P" });
    const anchor = seedTodo(fixture.db, {
      title: "anchor",
      project: proj,
      start: "active",
      index: 5,
    });
    const anytimeItem = seedTodo(fixture.db, { title: "any", start: "active" });
    const todayItem = seedTodo(fixture.db, {
      title: "tod",
      startDate: "2026-07-05",
      todayIndex: 1,
    });
    const r = await runTodoMove(deps(), {
      uuids: [anytimeItem, todayItem],
      destination: { kind: "project", ref: { uuid: proj } },
      position: { after: anchor },
    });
    expect(r.kind).toBe("move-refused");
    if (r.kind === "move-refused") {
      expect(r.detail).toContain("spans stage sub-buckets");
    }
  });

  it("--first on a mixed-stage move places each stage-group in ITS bucket (per sub-bucket)", async () => {
    const area = seedArea(fixture.db, "A");
    // An anytime and a someday to-do moved into the area together: they land in
    // DIFFERENT sub-buckets (area index vs area-someday bounce), so --first applies
    // per sub-bucket. Pre-seed one resident in each bucket so the placement has a
    // bucket to sort into.
    seedTodo(fixture.db, { title: "resAny", area, start: "active", index: 100 });
    seedTodo(fixture.db, { title: "resSome", area, start: "someday", index: 200 });
    const anytimeItem = seedTodo(fixture.db, { title: "any", start: "active", index: 1 });
    const somedayItem = seedTodo(fixture.db, { title: "some", start: "someday", index: 2 });
    const r = await runTodoMove(deps(), {
      uuids: [anytimeItem, somedayItem],
      destination: { kind: "area", ref: { uuid: area } },
      position: { at: "first" },
    });
    expect(r.kind).toBe("move-ok");
    if (r.kind === "move-ok") {
      expect(r.note).toContain("PER sub-bucket");
      // Both landed in the area (membership) in their respective buckets.
      const any = fixture.db
        .prepare("SELECT area, start FROM TMTask WHERE uuid = ?")
        .get(anytimeItem) as { area: string; start: number };
      const some = fixture.db
        .prepare("SELECT area, start FROM TMTask WHERE uuid = ?")
        .get(somedayItem) as { area: string; start: number };
      expect(any.area).toBe(area);
      expect(some.area).toBe(area);
    }
  });
});
