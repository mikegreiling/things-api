/**
 * Color-ON assertions for the ratified render design language (2026-07-13,
 * docs/design/render-language.md). The rest of the render suite runs non-TTY
 * (styling collapses to identity, so it can only see the plain skeleton); the
 * deltas here are about WHICH escape a glyph/title carries — bold vs blue vs
 * dim — so this file forces color on.
 *
 * Mechanism: style.ts caches `colorEnabled()` in a module-level const at import
 * time, so we set FORCE_COLOR and `vi.resetModules()` before each dynamic
 * import to re-evaluate the whole render graph with color engaged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, Todo } from "../../src/model/entities.ts";

// SGR codes (see src/cli/style.ts). We assert on these rather than full strings
// because nested wraps produce compound sequences.
const BOLD = "[1m";
const DIM = "[2m";
const UNDERLINE = "[4m";
const STRIKE = "[9m";
const BLUE = "[34m";

let savedNoColor: string | undefined;
let savedForceColor: string | undefined;

beforeEach(() => {
  savedNoColor = process.env["NO_COLOR"];
  savedForceColor = process.env["FORCE_COLOR"];
  delete process.env["NO_COLOR"];
  process.env["FORCE_COLOR"] = "1";
  vi.resetModules();
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env["NO_COLOR"];
  else process.env["NO_COLOR"] = savedNoColor;
  if (savedForceColor === undefined) delete process.env["FORCE_COLOR"];
  else process.env["FORCE_COLOR"] = savedForceColor;
  vi.resetModules();
});

const glyphs = () => import("../../src/cli/glyphs.ts");
const render = () => import("../../src/cli/render.ts");

function todo(overrides: Partial<Todo>): Todo {
  return {
    type: "to-do",
    uuid: "todo0001",
    title: "T",
    notes: "",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    startDate: null,
    todaySection: null,
    deadline: null,
    reminder: null,
    area: null,
    tags: [],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    created: new Date(0),
    modified: new Date(0),
    stopped: null,
    project: null,
    heading: null,
    checklistItemsCount: 0,
    openChecklistItemsCount: 0,
    ...overrides,
  } as Todo;
}

function project(overrides: Partial<Project>): Project {
  return {
    type: "project",
    uuid: "proj0001",
    title: "P",
    notes: "",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    startDate: null,
    todaySection: null,
    deadline: null,
    reminder: null,
    area: null,
    tags: [],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    created: new Date(0),
    modified: new Date(0),
    stopped: null,
    untrashedLeafActionsCount: 0,
    openUntrashedLeafActionsCount: 0,
    ...overrides,
  } as Project;
}

describe("glyph styling (color on)", () => {
  it("delta 1: project titles are BOLD and default-colored, never blue (the single law)", async () => {
    const { projectTitleAccent } = await glyphs();
    const styled = projectTitleAccent("Website");
    expect(styled).toContain(BOLD);
    expect(styled).not.toContain(BLUE);
  });

  it("delta 2: a repeating project template circle is BLUE (still a project)", async () => {
    const { projectCircle } = await glyphs();
    const circle = projectCircle(
      project({ repeating: { isTemplate: true, isInstance: false, templateUuid: null } }),
    );
    expect(circle).toContain(BLUE);
    expect(circle).not.toContain(DIM);
    expect(circle).toContain("(↻)");
  });

  it("delta 3: a repeating to-do template box is PLAIN — no dim, no color", async () => {
    const { todoBox } = await glyphs();
    const box = todoBox(
      todo({ repeating: { isTemplate: true, isInstance: false, templateUuid: null } }),
    );
    expect(box).toBe("[↻]");
  });

  it("delta 4: a someday project circle is DIM, not blue (muted like a someday to-do)", async () => {
    const { projectCircle } = await glyphs();
    const circle = projectCircle(project({ start: "someday" }));
    expect(circle).toContain(DIM);
    expect(circle).not.toContain(BLUE);
    expect(circle).toContain("(~)");
  });

  it("an OPEN project circle stays blue (the list accent is unchanged)", async () => {
    const { projectCircle } = await glyphs();
    expect(projectCircle(project({}))).toContain(BLUE);
  });
});

describe("formatItem styling (color on)", () => {
  it("delta 1/5: a project row title is bold + default (someday projects included), never blue", async () => {
    const { formatItem } = await render();
    const open = formatItem(project({ title: "OpenProj" }), 8);
    expect(open).toContain(`${BOLD}OpenProj`);
    expect(open).not.toContain(`${BLUE}OpenProj`);
    const someday = formatItem(project({ title: "SomedayProj", start: "someday" }), 8);
    expect(someday).toContain(`${BOLD}SomedayProj`);
    expect(someday).not.toContain(`${BLUE}SomedayProj`);
  });

  it("delta 8: area-detail project ROWS are bold but NOT underlined; anytime HEADINGS keep the underline", async () => {
    const { formatItem } = await render();
    // Plain row (area detail / projects sidebar): no projectTitle opt.
    const row = formatItem(project({ title: "RowProj" }), 8);
    expect(row).toContain(`${BOLD}RowProj`);
    expect(row).not.toContain(UNDERLINE);
    // Heading role (anytime/someday): projectTitle underlines it.
    const heading = formatItem(project({ title: "HeadProj" }), 8, { projectTitle: true });
    expect(heading).toContain(UNDERLINE);
    expect(heading).toContain(BOLD);
  });

  it("delta 6: Logbook (resolvedNormal) renders completed PLAIN and canceled STRIKE-not-dim", async () => {
    const { formatItem } = await render();
    const completed = formatItem(todo({ title: "DoneWin", status: "completed" }), 8, {
      resolvedNormal: true,
    });
    // Title carries no dim wrap.
    expect(completed).not.toContain(`${DIM}DoneWin`);
    expect(completed).toContain("DoneWin");
    const canceled = formatItem(todo({ title: "Dropped", status: "canceled" }), 8, {
      resolvedNormal: true,
    });
    // Strike is kept; the dim is gone (strike sits directly on the title).
    expect(canceled).toContain(`${STRIKE}Dropped`);
    expect(canceled).not.toContain(`${DIM}${STRIKE}Dropped`);
  });

  it("delta 7: mixed contexts (no resolvedNormal) keep dim (completed) and dim+strike (canceled)", async () => {
    const { formatItem } = await render();
    const completed = formatItem(todo({ title: "OldWin", status: "completed" }), 8);
    expect(completed).toContain(`${DIM}OldWin`);
    const canceled = formatItem(todo({ title: "Abandoned", status: "canceled" }), 8);
    expect(canceled).toContain(`${DIM}${STRIKE}Abandoned`);
  });

  it("delta 6: a completed PROJECT row in the Logbook is bold (delta 1) without dim", async () => {
    const { formatItem } = await render();
    const line = formatItem(project({ title: "ShippedProj", status: "completed" }), 8, {
      resolvedNormal: true,
    });
    expect(line).toContain(`${BOLD}ShippedProj`);
    expect(line).not.toContain(`${DIM}ShippedProj`);
    // The blue (✓) mark stays.
    expect(line).toContain(BLUE);
  });

  it("delta 9: the repeat status word renders as a dim ‹chevron› chip", async () => {
    const { formatItem } = await render();
    const line = formatItem(
      todo({
        title: "Rule",
        repeating: { isTemplate: true, isInstance: false, templateUuid: null },
      }),
      8,
      { statusWord: "waiting" },
    );
    expect(line).toContain(`${DIM}‹waiting›`);
  });
});
