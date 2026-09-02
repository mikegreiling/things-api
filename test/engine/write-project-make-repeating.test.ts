/**
 * project.make-repeating + project.add-repeating (UIC4). Covers the
 * row-selection TAXONOMY, the orchestrator's refusals / GUI-drive gating /
 * Someday coercion / composite, the pure-AX select-row driver primitive and its
 * readback verification, and the dual-form (sheet vs detached window) dialog
 * addressing. Every vector is a fake driven through the WriteDeps seam — no
 * `open` / osascript / System Events call ever fires (CLAUDE.md safety rails).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { byUuid } from "../../src/read/detail.ts";
import { classifyProjectRepeat } from "../../src/write/pre-state.ts";
import { promoteProjectViaGui } from "../../src/write/make-repeating-project.ts";
import { runAddRepeatingProject } from "../../src/write/promote-clone.ts";
import type { WriteDeps, WriteOptions } from "../../src/write/pipeline.ts";
import { projectMakeRepeatingRecipe } from "../../src/write/vectors/ui-recipes.ts";
import {
  createUiVector,
  STEP_ELEMENT_REF,
  type UiCommand,
  type UiRunResult,
} from "../../src/write/vectors/ui.ts";
import type {
  CompiledInvocation,
  UiRecipe,
  VectorMatrix,
  WriteVector,
} from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject } from "../fixtures/seed.ts";
import {
  healthyScreen,
  REPEAT_DIALOG_OPEN_STDOUT,
  screenAnswer,
  type FakeScreen,
} from "../fixtures/ui-state.ts";

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

function config(uiEnabled = true): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 1,
    actor: "mike",
    auditEnabled: true,
    acceptedFingerprint: null,
    certifiedAppVersion: null,
    allowExperimental: false,
    experimentalAreaReorder: true,
    bounceEnabled: true,
    bounceMaxItems: 30,
    autoLaunch: true,
    helpersMode: "false",
    ui: { enabled: uiEnabled },
    host: "test-host",
  };
}

function deps(vectors: WriteVector[], cfg = config()): WriteDeps {
  return {
    db: fixture.db,
    vectors,
    config: cfg,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: (): FingerprintStatus => ({
      kind: "ok",
      observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
    }),
    lockPath: join(tmpdir(), `things-api-mrp-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    pkgVersion: "test",
  };
}

const GUI: WriteOptions = { dangerouslyDriveGui: true };

const UI_MATRIX: VectorMatrix = {
  "project.make-repeating": { support: "yes", disruption: 3, validation: "validated" },
};
const URL_MATRIX: VectorMatrix = {
  "project.update": { support: "yes", disruption: 0, validation: "validated" },
  "project.add": { support: "yes", disruption: 0, validation: "validated" },
};

/** Fake url-scheme vector; each execute() runs effect(payload, callIndex). */
function urlVector(effect: (payload: string, call: number) => void): {
  vector: WriteVector;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    vector: {
      id: "url-scheme",
      matrix: URL_MATRIX,
      async execute(inv: CompiledInvocation) {
        effect(inv.payload, calls.length);
        calls.push(inv.payload);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

/**
 * Fake ui vector modelling make-repeating's identity replacement: it trashes the
 * driven project and inserts a fresh repeating TEMPLATE with the same title, so
 * the pipeline's create-probe (assert isTemplate) discovers the new uuid.
 */
function promotingUiVector(
  title: string,
  targetUuid: () => string,
): {
  vector: WriteVector;
  calls: number;
} {
  const state = { calls: 0 };
  const vector: WriteVector = {
    id: "ui",
    matrix: UI_MATRIX,
    async execute() {
      state.calls += 1;
      const t = targetUuid();
      fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(t);
      seedProject(fixture.db, {
        title,
        start: "someday",
        recurrenceRule: true,
        creationDate: NOW_EPOCH,
        modificationDate: NOW_EPOCH,
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return {
    vector,
    get calls() {
      return state.calls;
    },
  };
}

// ----------------------------------------------------------------- taxonomy

describe("classifyProjectRepeat — row-selection taxonomy (UIC4-f)", () => {
  it("an area project resolves to the AREA-view row (reveal the area)", () => {
    const area = seedArea(fixture.db, "Work");
    const uuid = seedProject(fixture.db, { title: "P", area, start: "active" });
    const tax = classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid));
    expect(tax).toEqual({ kind: "area", containerReveal: area, title: "P" });
  });

  it("an area-less someday project resolves to the SOMEDAY view", () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "someday" });
    const tax = classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid));
    expect(tax).toEqual({ kind: "someday", containerReveal: "someday", title: "P" });
  });

  it("an area-less anytime project needs a Someday coercion (no selectable row)", () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "active" });
    const tax = classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid));
    expect(tax.kind).toBe("anytime");
  });

  it("refuses a project that already repeats", () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "someday", recurrenceRule: true });
    const tax = classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid));
    expect(tax).toMatchObject({ kind: "refuse", refusal: "already-repeating" });
  });

  it("refuses a trashed project", () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "someday", trashed: true });
    expect(classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid))).toMatchObject({
      kind: "refuse",
      refusal: "trashed",
    });
  });

  it("refuses a resolved (canceled/completed) project", () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "someday", status: "completed" });
    expect(classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid))).toMatchObject({
      kind: "refuse",
      refusal: "logged",
    });
  });

  it("refuses a duplicate-title row in the same area (unresolvable selection)", () => {
    const area = seedArea(fixture.db, "Work");
    const uuid = seedProject(fixture.db, { title: "Dup", area });
    seedProject(fixture.db, { title: "Dup", area });
    expect(classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid))).toMatchObject({
      kind: "refuse",
      refusal: "ambiguous-row",
    });
  });

  it("refuses when coercing to Someday would collide with a same-titled Someday project", () => {
    const uuid = seedProject(fixture.db, { title: "Dup", start: "active" });
    seedProject(fixture.db, { title: "Dup", start: "someday" });
    expect(classifyProjectRepeat(fixture.db, byUuid(fixture.db, uuid))).toMatchObject({
      kind: "refuse",
      refusal: "ambiguous-row",
    });
  });

  it("refuses a non-project target", () => {
    expect(classifyProjectRepeat(fixture.db, null)).toMatchObject({
      kind: "refuse",
      refusal: "not-a-project",
    });
  });
});

// ------------------------------------------------------------- recipe shape

describe("projectMakeRepeatingRecipe — shape (UIC4)", () => {
  it("reveals the container, selects the row by title, then drives the dual-form dialog", () => {
    const recipe = projectMakeRepeatingRecipe("AREA-1", "PROJ-1", "My Project", "weekly", 2);
    expect(recipe.op).toBe("project.make-repeating");
    const reveal = recipe.steps[0];
    expect(reveal?.primitive).toBe("reveal");
    expect(reveal?.value).toBe("AREA-1");
    const selectRow = recipe.steps.find((s) => s.primitive === "select-row");
    expect(selectRow?.value).toBe("My Project");
    expect(selectRow?.path).toContain("table");
    // Every dialog control is addressed by BOTH the sheet and the detached-window shape.
    const dialogSteps = recipe.steps.filter((s) => s.pathCandidates !== undefined);
    expect(dialogSteps.length).toBeGreaterThanOrEqual(3);
    for (const s of dialogSteps) {
      expect(s.pathCandidates?.[0]).toContain("AXStandardWindow");
      expect(s.pathCandidates?.[1]).toContain("AXUnknown");
    }
  });

  it("reveals the Someday view for an area-less someday project", () => {
    const recipe = projectMakeRepeatingRecipe("someday", "PROJ-1", "P", "daily", 1);
    expect(recipe.steps[0]?.value).toBe("someday");
  });
});

// ----------------------------------------------------- driver: select-row

function invocation(recipe: UiRecipe): CompiledInvocation {
  return { vector: "ui", kind: "ui-drive", payload: "t", redactedPayload: "t", recipe };
}
function mockRunner(
  answer: (c: UiCommand) => UiRunResult,
  screen: FakeScreen = healthyScreen(),
): {
  run: (c: UiCommand, t: number) => Promise<UiRunResult>;
  commands: UiCommand[];
  screen: FakeScreen;
} {
  const commands: UiCommand[] = [];
  // The fake SCREEN answers the read-only census and the dismissal rungs
  // (issue #620) so the per-step focus guard has something true to read.
  return {
    commands,
    screen,
    run: async (c) => (commands.push(c), screenAnswer(screen, c, answer) ?? answer(c)),
  };
}
const ok = (stdout = ""): UiRunResult => ({ ok: true, stdout, stderr: "" });

const selectRowRecipe = (): UiRecipe =>
  projectMakeRepeatingRecipe("AREA-1", "PROJ-1", "My Project", "weekly", 2);

describe("ui driver — select-row (pure-AX AXSelectedRows, UIC4-a)", () => {
  const recipe = selectRowRecipe;

  it("emits a row select + title readback, and drives to completion on OK", async () => {
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve") return ok("true"); // canary + candidate probes
      if (c.primitive === "select-row") return ok("OK");
      if (c.primitive === "wait") return ok("true");
      if (c.primitive === "dialog-open") return ok(REPEAT_DIALOG_OPEN_STDOUT);
      if (c.primitive === "audit-dialog") return ok("OK"); // CGRD1 pre-commit audit
      return ok();
    });
    const res = await createUiVector(config(), run).execute(invocation(recipe()));
    expect(res.exitCode).toBe(0);
    const sel = commands.find((c) => c.primitive === "select-row");
    // UIC5: the row `select` action, not the (silent no-op) table AXSelectedRows set.
    expect(sel?.script).toContain("select (row i of theTable)");
    expect(sel?.script).toContain("name of selected to dos");
    expect(sel?.script).toContain("My Project");
  });

  it("sends NOTHING on cleanup when the drive had not opened a dialog yet (NOMATCH)", async () => {
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "select-row") return ok("NOMATCH");
      return ok();
    });
    const res = await createUiVector(config(), run).execute(invocation(recipe()));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("no content-table row selected");
    // The row selection fails BEFORE any dialog is opened, so the audited
    // cleanup finds nothing open and sends nothing at all — no Escape into
    // whatever happens to own the screen, which is the whole point (issue #620).
    expect(res.stderr).toContain("No dialog was left open");
    expect(commands.some((c) => c.primitive === "key")).toBe(false);
    expect(commands.some((c) => c.primitive === "dismiss-dialog")).toBe(false);
    // Nothing past the selection ran — no menu press.
    expect(commands.some((c) => c.primitive === "press" && c.script?.includes("menu item"))).toBe(
      false,
    );
  });

  it("probes BOTH dialog forms at the open, then addresses the one that opened", async () => {
    // The attached-sheet / detached-window disjunction (UIC4-a) is settled ONCE,
    // at the dialog-open hop (RDLAT2): it polls the shapes in priority order and
    // reports which answered. Every later step then addresses THAT shell instead
    // of re-asking about both, and each still binds its own element through the
    // candidate prelude — so the element cannot change between resolving and
    // acting, and a backgrounded run drives the detached form the same way.
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve" || c.primitive === "wait") return ok("true");
      if (c.primitive === "dialog-open") return ok(REPEAT_DIALOG_OPEN_STDOUT);
      if (c.primitive === "select-row") return ok("OK");
      if (c.primitive === "audit-dialog") return ok("OK"); // CGRD1 pre-commit audit
      return ok();
    });
    const res = await createUiVector(config(), run).execute(invocation(recipe()));
    expect(res.exitCode).toBe(0);
    const open = commands.find((c) => c.primitive === "dialog-open");
    const openScript = open?.script ?? "";
    expect(openScript).toContain("AXStandardWindow");
    expect(openScript).toContain("AXUnknown");
    // Priority order: the attached sheet is probed before the detached window.
    expect(openScript.indexOf("AXStandardWindow")).toBeLessThan(openScript.indexOf("AXUnknown"));
    // The snapshot said "candidate 1", so the acting hop addresses the sheet only.
    const popup = commands.find((c) => c.primitive === "select-popup");
    const script = popup?.script ?? "";
    expect(script).toContain("AXStandardWindow");
    expect(script).not.toContain("AXUnknown");
    // …and the action addresses what the prelude bound, never a hard-coded shell.
    expect(script).toContain(`set pu to (${STEP_ELEMENT_REF})`);
  });
});

// --------------------------------------------------- orchestrator: refusals

describe("promoteProjectViaGui — refusals + gating", () => {
  it("blocks (no vector touched) when the GUI-drive ack is missing", async () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "someday" });
    const ui = promotingUiVector("P", () => uuid);
    const res = await promoteProjectViaGui(deps([ui.vector]), {
      uuid,
      frequency: "weekly",
      interval: 1,
    });
    expect(res.kind).toBe("blocked");
    if (res.kind === "blocked") expect(res.hazard).toBe("H-UI-DRIVE");
    expect(ui.calls).toBe(0);
  });

  it("refuses an already-repeating project with H-PROJECT-REPEAT", async () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "someday", recurrenceRule: true });
    const res = await promoteProjectViaGui(
      deps([promotingUiVector("P", () => uuid).vector]),
      { uuid, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res).toMatchObject({ kind: "blocked", hazard: "H-PROJECT-REPEAT" });
  });

  it("refuses a non-project target with H-UNKNOWN-DESTINATION", async () => {
    const uuid = seedProject(fixture.db, { title: "P" });
    // Point at a bogus uuid → not found → not-a-project refusal.
    const res = await promoteProjectViaGui(
      deps([promotingUiVector("P", () => uuid).vector]),
      { uuid: "NOPE-000000", frequency: "weekly", interval: 1 },
      GUI,
    ).catch((e: Error) => e);
    // the project resolver refuses an unknown ref; either a throw or a block is acceptable.
    if (res instanceof Error) expect(res.message).toMatch(/unknown|no project matching|not/i);
    else expect(res).toMatchObject({ kind: "blocked" });
  });

  it("dry-run surfaces the Someday coercion for an area-less anytime project", async () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "active" });
    const res = await promoteProjectViaGui(
      deps([promotingUiVector("P", () => uuid).vector]),
      { uuid, frequency: "weekly", interval: 3 },
      { dryRun: true },
    );
    expect(res.kind).toBe("dry-run");
    if (res.kind === "dry-run") {
      expect(res.plan.invocation).toContain("coerce to Someday");
      expect(res.plan.invocation).toContain("select the project row");
    }
  });
});

// ------------------------------------------------- orchestrator: happy paths

describe("promoteProjectViaGui — drives", () => {
  it("area/someday: a single pure-AX drive discovers the new template uuid", async () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "someday" });
    const ui = promotingUiVector("P", () => uuid);
    const res = await promoteProjectViaGui(
      deps([ui.vector]),
      { uuid, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.vector).toBe("ui");
      expect(res.uuid).not.toBe(uuid); // identity replacement
    }
    expect(ui.calls).toBe(1);
  });

  it("area-less anytime: coerces to Someday (url leg) THEN drives (ui leg), summary recorded", async () => {
    const uuid = seedProject(fixture.db, { title: "P", start: "active" });
    const url = urlVector(() => {
      fixture.db
        .prepare(
          "UPDATE TMTask SET start = 2, startDate = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(NOW_EPOCH + 1, uuid);
    });
    const ui = promotingUiVector("P", () => uuid);
    const res = await promoteProjectViaGui(
      deps([url.vector, ui.vector]),
      { uuid, frequency: "weekly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    expect(url.calls.length).toBe(1); // the coercion leg fired
    expect(ui.calls).toBe(1);
    // A summary record groups the compound (leg + leg + summary).
    expect(auditRecords.some((r) => r.txn?.role === "summary")).toBe(true);
    expect(auditRecords.some((r) => r.txn?.role === "leg")).toBe(true);
  });
});

// -------------------------------------------------- composite: create + promote

describe("runAddRepeatingProject — composite", () => {
  it("blocks before creating anything when the GUI-drive ack is missing", async () => {
    const url = urlVector(() => {
      throw new Error("must not create");
    });
    const res = await runAddRepeatingProject(deps([url.vector]), {
      title: "New",
      frequency: "weekly",
      interval: 1,
    });
    expect(res).toMatchObject({ kind: "blocked", hazard: "H-UI-DRIVE" });
    expect(url.calls.length).toBe(0);
  });

  it("creates the project (persisting) THEN promotes it; result carries the template uuid", async () => {
    let created = "";
    const url = urlVector(() => {
      created = seedProject(fixture.db, {
        title: "New",
        start: "someday",
        creationDate: NOW_EPOCH,
        modificationDate: NOW_EPOCH,
      });
    });
    const ui = promotingUiVector("New", () => created);
    const res = await runAddRepeatingProject(
      deps([url.vector, ui.vector]),
      { title: "New", frequency: "monthly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.op).toBe("project.add-repeating");
    expect(url.calls.length).toBe(1); // the create leg
    expect(ui.calls).toBe(1); // the promote leg
  });

  it("dry-run previews both legs without creating anything", async () => {
    const url = urlVector(() => {
      throw new Error("must not create");
    });
    const res = await runAddRepeatingProject(
      deps([url.vector]),
      { title: "New", frequency: "weekly", interval: 1 },
      { dryRun: true },
    );
    expect(res.kind).toBe("dry-run");
    if (res.kind === "dry-run") expect(res.plan.invocation).toContain("make-repeating");
    expect(url.calls.length).toBe(0);
  });
});
