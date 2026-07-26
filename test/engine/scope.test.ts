/**
 * Container-scoped sandbox (docs/design/container-scope.md): the §7 fixture
 * matrix. Reads go through a scoped `openThings` client; writes through
 * `runMutation` with a resolved scope in the deps (a FakeVector applies effects
 * against the fixture DB — fine here, the no-direct-writes rule protects the
 * real DB). The crucial assertion is the no-oracle guarantee: an out-of-scope
 * ref is byte-indistinguishable from a nonexistent one.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import { openThings } from "../../src/client.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import {
  noUuidMatch,
  ReferenceResolutionError,
  resolveProjectWriteTarget,
} from "../../src/read/queries.ts";
import {
  namedProjectClause,
  resolveScope,
  ScopeResolutionError,
  taskMembershipClause,
  type ResolvedScope,
} from "../../src/read/scope.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

interface World {
  workArea: string;
  personalArea: string;
  workProj: string;
  personalProj: string;
  workTodo: string;
  personalTodo: string;
  workChild: string;
  personalChild: string;
  workHeading: string;
  workHeadingChild: string;
  roadmapWork: string;
  roadmapPersonal: string;
  personalTrashed: string;
}

function seedWorld(db: DatabaseSync): World {
  const workArea = seedArea(db, "Work", 0);
  const personalArea = seedArea(db, "Personal", 1);
  const workProj = seedProject(db, { title: "Work Project", area: workArea });
  const personalProj = seedProject(db, { title: "Personal Project", area: personalArea });
  const workTodo = seedTodo(db, { title: "work loose", area: workArea });
  const personalTodo = seedTodo(db, { title: "personal loose", area: personalArea });
  const workChild = seedTodo(db, { title: "work child", project: workProj });
  const personalChild = seedTodo(db, { title: "personal child", project: personalProj });
  const workHeading = seedHeading(db, { title: "Work Heading", project: workProj });
  const workHeadingChild = seedTodo(db, { title: "under work heading", heading: workHeading });
  const roadmapWork = seedProject(db, { title: "Roadmap", area: workArea });
  const roadmapPersonal = seedProject(db, { title: "Roadmap", area: personalArea });
  seedTodo(db, { title: "work trashed", area: workArea, trashed: true });
  const personalTrashed = seedTodo(db, {
    title: "personal trashed",
    area: personalArea,
    trashed: true,
  });
  return {
    workArea,
    personalArea,
    workProj,
    personalProj,
    workTodo,
    personalTodo,
    workChild,
    personalChild,
    workHeading,
    workHeadingChild,
    roadmapWork,
    roadmapPersonal,
    personalTrashed,
  };
}

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => {
  fixture.close();
});

// --------------------------------------------------------------- write deps

const MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.add", "todo.move", "tag.add", "project.update", "todo.complete", "todo.duplicate"].map(
    (op) => [op, { support: "yes", disruption: 0, validation: "validated" }],
  ),
) as VectorMatrix;

function fakeVector(
  effect?: (db: DatabaseSync) => void,
  id: WriteVector["id"] = "url-scheme",
  matrix: VectorMatrix = MATRIX,
): WriteVector {
  return {
    id,
    matrix,
    async execute() {
      effect?.(fixture.db);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "test-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  ui: { enabled: false },
  scope: null,
  host: "test-host",
};

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

function deps(scope: ResolvedScope | undefined, overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    db: fixture.db,
    vectors: [fakeVector()],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `scope-test-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    ...(scope !== undefined && { scope }),
    ...overrides,
  };
}

function areaScope(): ResolvedScope {
  return resolveScope(fixture.db, "Work", "flag");
}

/** The not-found message classifyShowTarget throws — shared by the parity assertions. */
const showNotFound = (ref: string): string =>
  `no to-do, project, or area matches "${ref}" (tags and checklist items have no show view)`;

// ------------------------------------------------------------------- reads

describe("scope resolution", () => {
  it("resolves an area ref, an area uuid, and a project ref", () => {
    const w = seedWorld(fixture.db);
    const byName = resolveScope(fixture.db, "Work", "flag");
    expect(byName).toMatchObject({ kind: "area", uuid: w.workArea, title: "Work", source: "flag" });
    const byUuid = resolveScope(fixture.db, w.workProj, "env");
    expect(byUuid).toMatchObject({ kind: "project", uuid: w.workProj, areaUuid: w.workArea });
  });

  it("rejects a to-do ref (only containers can be a scope)", () => {
    const w = seedWorld(fixture.db);
    expect(() => resolveScope(fixture.db, w.workTodo, "flag")).toThrow(ScopeResolutionError);
  });

  it("fails closed on an unresolvable ref", () => {
    seedWorld(fixture.db);
    expect(() => resolveScope(fixture.db, "Nonexistent", "flag")).toThrow(ScopeResolutionError);
  });
});

describe("reads under an area scope (Work)", () => {
  const open = () => openThings({ dbPath: fixture.path, scope: "Work", now: () => NOW });

  it("client.scope carries the meta.scope shape", () => {
    seedWorld(fixture.db);
    const c = open();
    try {
      expect(c.scope).toEqual({
        kind: "area",
        uuid: expect.any(String),
        title: "Work",
        source: "flag",
      });
    } finally {
      c.close();
    }
  });

  it("search returns only in-scope rows; Personal is invisible", () => {
    seedWorld(fixture.db);
    const c = open();
    try {
      const titles = c.read.search("loose").items.map((i) => i.title);
      expect(titles).toContain("work loose");
      expect(titles).not.toContain("personal loose");
    } finally {
      c.close();
    }
  });

  it("byUuid: an out-of-scope uuid is null, exactly like a nonexistent one", () => {
    const w = seedWorld(fixture.db);
    const c = open();
    try {
      expect(c.read.byUuid(w.personalTodo)).toBeNull();
      expect(c.read.byUuid("00000000-0000-0000-0000-000000000000")).toBeNull();
      expect(c.read.byUuid(w.workTodo)?.title).toBe("work loose");
    } finally {
      c.close();
    }
  });

  it("showTarget of an out-of-scope project throws the same not-found a nonexistent ref throws", () => {
    const w = seedWorld(fixture.db);
    const c = open();
    try {
      let outOfScope: Error | null = null;
      let nonexistent: Error | null = null;
      try {
        c.read.showTarget(w.personalProj);
      } catch (e) {
        outOfScope = e as Error;
      }
      try {
        c.read.showTarget("11111111-1111-1111-1111-111111111111");
      } catch (e) {
        nonexistent = e as Error;
      }
      expect(outOfScope).not.toBeNull();
      expect(nonexistent).not.toBeNull();
      // Parity: an out-of-scope ref takes the SAME not-found path a nonexistent
      // one does — the message is the identical template, differing only by the
      // ref the caller itself supplied (no oracle for existence).
      expect(outOfScope?.message).toBe(showNotFound(w.personalProj));
      expect(nonexistent?.message).toBe(showNotFound("11111111-1111-1111-1111-111111111111"));
    } finally {
      c.close();
    }
  });

  it("projects / areas are scoped; trash and changes hide Personal", () => {
    seedWorld(fixture.db);
    const c = open();
    try {
      expect(c.read.areas().map((a) => a.title)).toEqual(["Work"]);
      const projectTitles = c.read.projects().map((p) => p.title);
      expect(projectTitles).toContain("Work Project");
      expect(projectTitles).not.toContain("Personal Project");
      const trashTitles = c.read.trash().items.map((i) => i.title);
      expect(trashTitles).toContain("work trashed");
      expect(trashTitles).not.toContain("personal trashed");
      const changeTitles = c.read
        .changes({ since: new Date("2020-01-01") })
        .items.map((i) => i.title);
      expect(changeTitles).not.toContain("personal loose");
    } finally {
      c.close();
    }
  });

  it("composition with --area: an out-of-scope --area is not-found; the scope area intersects", () => {
    seedWorld(fixture.db);
    const c = open();
    try {
      // --area Personal under a Work scope resolves to not-found (parity).
      expect(() => c.read.anytime({ area: "Personal" })).toThrow(ReferenceResolutionError);
      // --area Work intersects with the scope and returns Work rows.
      const sections = c.read.anytime({ area: "Work" });
      const titles = sections.view.flatMap((s) => s.items.map((i) => i.title));
      expect(titles).toContain("work loose");
      expect(titles).not.toContain("personal loose");
    } finally {
      c.close();
    }
  });

  it("snapshot refuses under a scope", () => {
    seedWorld(fixture.db);
    const c = open();
    try {
      expect(() => c.read.snapshot()).toThrow(/whole-library dump/);
    } finally {
      c.close();
    }
  });

  it("areaView of another area is not-found; projectView of an out-of-scope project is not-found", () => {
    const w = seedWorld(fixture.db);
    const c = open();
    try {
      expect(() => c.read.areaView("Personal")).toThrow(ReferenceResolutionError);
      expect(() => c.read.projectView(w.personalProj)).toThrow(ReferenceResolutionError);
      expect(c.read.projectView(w.workProj).project.title).toBe("Work Project");
    } finally {
      c.close();
    }
  });
});

describe("reads honor THINGS_API_SCOPE env (and the flag outranks it)", () => {
  it("env scope jails reads", () => {
    seedWorld(fixture.db);
    const c = openThings({
      dbPath: fixture.path,
      now: () => NOW,
      env: { ...process.env, THINGS_API_SCOPE: "Work" },
    });
    try {
      expect(c.scope).toMatchObject({ title: "Work", source: "env" });
    } finally {
      c.close();
    }
  });

  it("the explicit flag outranks the env var", () => {
    seedWorld(fixture.db);
    const c = openThings({
      dbPath: fixture.path,
      scope: "Personal",
      now: () => NOW,
      env: { ...process.env, THINGS_API_SCOPE: "Work" },
    });
    try {
      expect(c.scope).toMatchObject({ title: "Personal", source: "flag" });
    } finally {
      c.close();
    }
  });
});

// ------------------------------------------------------------------ writes

describe("writes refused / redirected under an area scope (Work)", () => {
  it("add-redirect: a bare todo.add lands in the scope area", async () => {
    const w = seedWorld(fixture.db);
    const scope = areaScope();
    const result = await runMutation(deps(scope), "todo.add", { title: "fresh" }, { dryRun: true });
    expect(result.kind).toBe("dry-run");
    if (result.kind === "dry-run") {
      expect(result.plan.invocation).toContain(w.workArea);
    }
  });

  it("move to the Inbox and detach are structural scope refusals", async () => {
    const w = seedWorld(fixture.db);
    const scope = areaScope();
    const inbox = await runMutation(deps(scope), "todo.move", { uuid: w.workTodo, inbox: true });
    expect(inbox).toMatchObject({ kind: "blocked", reason: "scope" });
    const detach = await runMutation(deps(scope), "todo.move", { uuid: w.workTodo, detach: true });
    expect(detach).toMatchObject({ kind: "blocked", reason: "scope" });
  });

  it("area.add / trash.empty / tag.update / tag.delete are structural scope refusals", async () => {
    seedWorld(fixture.db);
    const scope = areaScope();
    for (const [op, params] of [
      ["area.add", { title: "New Area" }],
      ["trash.empty", {}],
      ["tag.update", { target: "whatever", title: "x" }],
      ["tag.delete", { target: "whatever" }],
    ] as const) {
      const r = await runMutation(deps(scope), op, params as never);
      expect(r).toMatchObject({ kind: "blocked", reason: "scope" });
    }
  });

  it("tag.add is allowed under a scope", async () => {
    seedWorld(fixture.db);
    const scope = areaScope();
    // tag.add compiles for the applescript vector.
    const asMatrix: VectorMatrix = {
      "tag.add": { support: "yes", disruption: 0, validation: "validated" },
    } as VectorMatrix;
    const d = deps(scope, { vectors: [fakeVector(undefined, "applescript", asMatrix)] });
    const r = await runMutation(d, "tag.add", { title: "newtag" }, { dryRun: true });
    expect(r.kind).toBe("dry-run");
  });

  it("moving a Work to-do to a Personal project is not-found (destination gated, parity)", async () => {
    const w = seedWorld(fixture.db);
    const scope = areaScope();
    const toPersonal = await runMutation(deps(scope), "todo.move", {
      uuid: w.workTodo,
      project: { uuid: w.personalProj },
    });
    const toNonexistent = await runMutation(deps(scope), "todo.move", {
      uuid: w.workTodo,
      project: { uuid: "22222222-2222-2222-2222-222222222222" },
    });
    expect(toPersonal.kind).toBe("blocked");
    expect(toNonexistent.kind).toBe("blocked");
    if (toPersonal.kind === "blocked" && toNonexistent.kind === "blocked") {
      // Byte-identical: an out-of-scope destination reads like a nonexistent one.
      expect(toPersonal.detail).toBe(toNonexistent.detail);
      expect(toPersonal.hazard).toBe(toNonexistent.hazard);
    }
  });

  it("todo.restore is a structural scope refusal (returns to the Inbox)", async () => {
    seedWorld(fixture.db);
    const scope = areaScope();
    // A trashed Work to-do: in scope, but restore leaves scope → structural refuse.
    const trashed = fixture.db
      .prepare("SELECT uuid FROM TMTask WHERE title = 'work trashed'")
      .get() as { uuid: string };
    const r = await runMutation(deps(scope), "todo.restore", { uuid: trashed.uuid });
    expect(r).toMatchObject({ kind: "blocked", reason: "scope" });
  });
});

describe("uuid-parity golden (the crucial oracle test)", () => {
  it("a write to an out-of-scope uuid throws BYTE-IDENTICAL to a nonexistent uuid", async () => {
    const w = seedWorld(fixture.db);
    const scope = areaScope();
    const capture = async (uuid: string): Promise<ReferenceResolutionError> => {
      try {
        await runMutation(deps(scope), "todo.complete", { uuid });
        throw new Error("expected a throw");
      } catch (e) {
        return e as ReferenceResolutionError;
      }
    };
    const outOfScope = await capture(w.personalTodo);
    const nonexistent = await capture("33333333-3333-3333-3333-333333333333");
    expect(outOfScope).toBeInstanceOf(ReferenceResolutionError);
    expect(nonexistent).toBeInstanceOf(ReferenceResolutionError);
    // Both take the shared noUuidMatch not-found path — identical modulo the
    // caller-supplied ref, and identical code + (empty) candidates.
    expect(outOfScope.message).toBe(noUuidMatch("to-do", w.personalTodo));
    expect(nonexistent.message).toBe(noUuidMatch("to-do", "33333333-3333-3333-3333-333333333333"));
    expect(outOfScope.code).toBe(nonexistent.code);
    expect(outOfScope.candidates).toEqual(nonexistent.candidates);
  });
});

describe("candidate parity (duplicate names across scopes)", () => {
  it("a name matching Work+Personal resolves to Work's with no ambiguity under a Work scope", () => {
    const w = seedWorld(fixture.db);
    const scope = resolveScope(fixture.db, "Work", "flag");
    const resolved = resolveProjectWriteTarget(fixture.db, "Roadmap", {
      task: taskMembershipClause(scope),
      named: namedProjectClause(scope),
    });
    expect(resolved).toBe(w.roadmapWork);
  });

  it("a name matching only Personal is not-found under a Work scope (empty candidates)", () => {
    seedWorld(fixture.db);
    const scope = resolveScope(fixture.db, "Work", "flag");
    try {
      resolveProjectWriteTarget(fixture.db, "Personal Project", {
        task: taskMembershipClause(scope),
        named: namedProjectClause(scope),
      });
      throw new Error("expected not-found");
    } catch (e) {
      expect(e).toBeInstanceOf(ReferenceResolutionError);
      expect((e as ReferenceResolutionError).code).toBe("not-found");
      expect((e as ReferenceResolutionError).candidates).toEqual([]);
    }
  });
});

describe("writes under a PROJECT scope", () => {
  const projectScope = (w: World) => resolveScope(fixture.db, w.workProj, "flag");

  it("project.add / convert-to-project / project.make-repeating are refused (result leaves the jail)", async () => {
    const w = seedWorld(fixture.db);
    const scope = projectScope(w);
    for (const [op, params] of [
      ["project.add", { title: "Sibling" }],
      ["todo.convert-to-project", { uuid: w.workChild }],
      ["project.make-repeating", { uuid: w.workProj, frequency: "weekly", interval: 1 }],
    ] as const) {
      const r = await runMutation(deps(scope), op, params as never);
      expect(r).toMatchObject({ kind: "blocked", reason: "scope" });
    }
  });

  it("a bare todo.add lands in the scope project", async () => {
    const w = seedWorld(fixture.db);
    const scope = projectScope(w);
    const r = await runMutation(deps(scope), "todo.add", { title: "fresh" }, { dryRun: true });
    expect(r.kind).toBe("dry-run");
    if (r.kind === "dry-run") expect(r.plan.invocation).toContain(w.workProj);
  });

  it("todo.duplicate of an in-scope child is allowed; of an out-of-scope item is not-found", async () => {
    const w = seedWorld(fixture.db);
    const scope = projectScope(w);
    const dup = await runMutation(
      deps(scope),
      "todo.duplicate",
      { uuid: w.workChild },
      { dryRun: true },
    );
    expect(dup.kind).toBe("dry-run");
    await expect(
      runMutation(deps(scope), "todo.duplicate", { uuid: w.personalChild }),
    ).rejects.toThrow(ReferenceResolutionError);
  });
});
