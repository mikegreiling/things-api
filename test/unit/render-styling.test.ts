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
import { stripSgr, visibleWidth } from "../../src/cli/width.ts";

// SGR codes (see src/cli/style.ts). We assert on these rather than full strings
// because nested wraps produce compound sequences.
const BOLD = "[1m";
const DIM = "[2m";
const UNDERLINE = "[4m";
const STRIKE = "[9m";
const BLUE = "[34m";
const GREEN = "[32m";

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
const width = () => import("../../src/cli/width.ts");

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

  it("inherited chips render DIM (secondary metadata), never GREEN like the item's own tags", async () => {
    const { inheritedChips } = await glyphs();
    const styled = inheritedChips([
      { tag: { uuid: "t1", title: "home" }, source: { type: "area", uuid: "a1", title: "Home" } },
    ]);
    expect(styled).toContain(DIM);
    expect(styled).not.toContain(GREEN);
    expect(styled).toContain("#home ‹area Home›");
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

  // The today render path is a mixed context (open rows are the norm), so a
  // checked-but-unswept row must pick up the delta-7 resolved styling
  // automatically — no new render option (GUI-parity ruling 2026-07-14).
  it("render path: today applies dim (completed) / dim+strike (canceled) to checked-unswept rows", async () => {
    const { renderToday } = await render();
    const view = {
      today: [
        todo({ title: "StillOpen" }),
        todo({ title: "CheckedWin", status: "completed", stopped: new Date() }),
        todo({ title: "CheckedDrop", status: "canceled", stopped: new Date() }),
      ],
      evening: [],
      badge: { dueOrOverdue: 0, other: 1 },
    };
    const out = renderToday(view, view, "things today").join("\n");
    expect(out).toContain(`${DIM}CheckedWin`);
    expect(out).toContain(`${DIM}${STRIKE}CheckedDrop`);
    // The open row carries none of the resolved wraps on its title.
    expect(out).not.toContain(`${DIM}StillOpen`);
    expect(out).not.toContain(`${STRIKE}StillOpen`);
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

  it("delta 9: a template with no next date derives its dim ‹chevron› status chip", async () => {
    const { formatItem } = await render();
    // No nextOccurrence and no rule → after-completion template → ‹waiting›,
    // derived inside formatItem so EVERY list view inherits it (the area-show
    // Upcoming section regression, 2026-07-14).
    const line = formatItem(
      todo({
        title: "Rule",
        repeating: { isTemplate: true, isInstance: false, templateUuid: null },
      }),
      8,
    );
    expect(line).toContain(`${DIM}‹waiting›`);
  });
});

describe("width fitting + styling interplay (color on)", () => {
  it("truncates inside the SGR run — the clip/ellipsis boundary never splits an escape", async () => {
    const w = await width();
    w.setFitWidth(40); // clamps up to COMPACT_FIT_FLOOR; a long project title truncates
    const { formatItem, COMPACT_FIT_FLOOR } = await render();
    const line = formatItem(project({ title: "Z".repeat(120) }), 8);
    w.setFitWidth(null);
    // The bold title wrap survives truncation: the ellipsis sits INSIDE the run
    // (styled), with the reset immediately after it — no escape was cut.
    expect(line).toContain(`…${String.fromCharCode(27)}[22m`);
    expect(line).toContain(BOLD);
    // Stripping SGR leaves clean text (a split escape would strand an ESC byte).
    expect(stripSgr(line)).not.toContain(String.fromCharCode(27));
    expect(stripSgr(line)).toContain("…");
    // And the fitted, styled row respects the effective width.
    expect(visibleWidth(line)).toBeLessThanOrEqual(COMPACT_FIT_FLOOR);
  });
});
