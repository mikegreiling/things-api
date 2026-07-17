/**
 * heading.convert-to-project (HEADCERT1). Covers `classifyHeadingConvert` (the
 * parent-project reveal + the POSITIONAL heading ordinal, and its refusals), the
 * recipe shape (reveal project → select-heading-row by ordinal → Convert to
 * Project… → confirm sheet), and the `select-heading-row` driver primitive
 * (ordinal-based walk, OK vs NOMATCH). Every vector is faked through the seam —
 * no `open` / osascript / System Events call ever fires (CLAUDE.md safety rails).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ThingsApiConfig } from "../../src/config.ts";
import { byUuid } from "../../src/read/detail.ts";
import { classifyHeadingConvert } from "../../src/write/pre-state.ts";
import { headingConvertToProjectRecipe } from "../../src/write/vectors/ui-recipes.ts";
import { createUiVector, type UiCommand, type UiRunResult } from "../../src/write/vectors/ui.ts";
import type { CompiledInvocation, UiRecipe } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => fixture.close());

function config(uiEnabled = true): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 1,
    actor: "mike",
    auditEnabled: true,
    acceptedFingerprint: null,
    allowExperimental: false,
    ui: { enabled: uiEnabled },
    host: "test-host",
  };
}

// ------------------------------------------------------ classifyHeadingConvert

describe("classifyHeadingConvert (HEADCERT1)", () => {
  it("returns the parent project + the heading's 0-based ordinal by index", () => {
    const area = seedArea(fixture.db, "A");
    const proj = seedProject(fixture.db, { title: "P", area });
    // Insert out of index order to prove the ordinal follows `index`, not rowid.
    const h2 = seedHeading(fixture.db, { title: "H2", project: proj, index: 0 });
    const h1 = seedHeading(fixture.db, { title: "H1", project: proj, index: -500 });
    expect(classifyHeadingConvert(fixture.db, byUuid(fixture.db, h1))).toEqual({
      kind: "ok",
      projectReveal: proj,
      ordinal: 0,
    });
    expect(classifyHeadingConvert(fixture.db, byUuid(fixture.db, h2))).toEqual({
      kind: "ok",
      projectReveal: proj,
      ordinal: 1,
    });
  });

  it("excludes trashed headings from the ordinal count", () => {
    const proj = seedProject(fixture.db, { title: "P" });
    seedHeading(fixture.db, { title: "Ht", project: proj, index: -900, trashed: true });
    const h = seedHeading(fixture.db, { title: "H", project: proj, index: -100 });
    expect(classifyHeadingConvert(fixture.db, byUuid(fixture.db, h))).toMatchObject({
      kind: "ok",
      ordinal: 0,
    });
  });

  it("refuses a non-heading target (null or a to-do)", () => {
    expect(classifyHeadingConvert(fixture.db, null)).toMatchObject({
      kind: "refuse",
      refusal: "not-a-heading",
    });
    const t = seedTodo(fixture.db, { title: "T" });
    expect(classifyHeadingConvert(fixture.db, byUuid(fixture.db, t))).toMatchObject({
      kind: "refuse",
      refusal: "not-a-heading",
    });
  });
});

// --------------------------------------------------------------- recipe shape

describe("headingConvertToProjectRecipe — shape (HEADCERT1)", () => {
  it("reveals the project, selects the heading row by ordinal, then Convert + confirm", () => {
    const recipe = headingConvertToProjectRecipe("PROJ-1", 1);
    expect(recipe.op).toBe("heading.convert-to-project");
    expect(recipe.targetUuid).toBe("PROJ-1");
    const reveal = recipe.steps[0];
    expect(reveal?.primitive).toBe("reveal");
    expect(reveal?.value).toBe("PROJ-1");
    const sel = recipe.steps.find((s) => s.primitive === "select-heading-row");
    expect(sel?.value).toBe("1"); // the 0-based ordinal, as a string
    expect(sel?.path).toContain("table");
    // Convert to Project… menu press (static — canary-resolvable).
    expect(
      recipe.steps.some((s) => s.primitive === "press" && s.path?.includes("Convert to Project")),
    ).toBe(true);
    // The confirm button is the locale-proof action-button-1 AXIdentifier.
    expect(
      recipe.steps.some(
        (s) => s.addressing === "axidentifier" && s.path?.includes("action-button-1"),
      ),
    ).toBe(true);
  });
});

// ------------------------------------------------- driver: select-heading-row

function invocation(recipe: UiRecipe): CompiledInvocation {
  return { vector: "ui", kind: "ui-drive", payload: "t", redactedPayload: "t", recipe };
}
function mockRunner(answer: (c: UiCommand) => UiRunResult): {
  run: (c: UiCommand, t: number) => Promise<UiRunResult>;
  commands: UiCommand[];
} {
  const commands: UiCommand[] = [];
  return { commands, run: async (c) => (commands.push(c), answer(c)) };
}
const ok = (stdout = ""): UiRunResult => ({ ok: true, stdout, stderr: "" });
const recipe = (): UiRecipe => headingConvertToProjectRecipe("PROJ-1", 1);

describe("ui driver — select-heading-row (HEADCERT1)", () => {
  it("emits an ordinal-based walk with empty-readback discriminator, and completes on OK", async () => {
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve") return ok("true"); // canary + candidate probes
      if (c.primitive === "select-heading-row") return ok("OK");
      if (c.primitive === "wait") return ok("true");
      return ok();
    });
    const res = await createUiVector(config(), run).execute(invocation(recipe()));
    expect(res.exitCode).toBe(0);
    const sel = commands.find((c) => c.primitive === "select-heading-row");
    expect(sel?.script).toContain("select (row i of theTable)");
    // A heading is the row that takes selection but reads back NO selected to-do.
    expect(sel?.script).toContain("name of selected to dos");
    expect(sel?.script).toContain("headingSeen is 1"); // the target ordinal
  });

  it("aborts (Escape) and reports partial state when no heading row exists at the ordinal (NOMATCH)", async () => {
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "select-heading-row") return ok("NOMATCH");
      return ok();
    });
    const res = await createUiVector(config(), run).execute(invocation(recipe()));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("no selectable heading row");
    expect(commands.some((c) => c.primitive === "key" && c.script?.includes("key code 53"))).toBe(
      true,
    );
    // Nothing past the selection ran — Convert was never pressed.
    expect(commands.some((c) => c.primitive === "press")).toBe(false);
  });
});
