/**
 * Glyph language pure functions: project-circle quantization and short-date
 * rules. Colors are OFF (non-TTY), so returns are the plain-text glyphs.
 */
import { describe, expect, it } from "vitest";

import type { Project, Todo } from "../../src/model/entities.ts";
import { projectCircle, shortDate, todoBox } from "../../src/cli/glyphs.ts";

const TODAY = "2026-07-05";

function project(overrides: Partial<Project>): Project {
  return {
    type: "project",
    status: "open",
    start: "active",
    startDate: null,
    untrashedLeafActionsCount: 0,
    openUntrashedLeafActionsCount: 0,
    ...overrides,
  } as Project;
}

function todo(overrides: Partial<Todo>): Todo {
  return { type: "to-do", status: "open", start: "active", startDate: null, ...overrides } as Todo;
}

describe("projectCircle", () => {
  it("quantizes completion to quarters", () => {
    const at = (total: number, open: number) =>
      projectCircle(
        project({ untrashedLeafActionsCount: total, openUntrashedLeafActionsCount: open }),
      );
    expect(at(0, 0)).toBe("( )"); // childless
    expect(at(4, 4)).toBe("( )"); // nothing done
    expect(at(4, 3)).toBe("(◔)"); // 1/4 done
    expect(at(2, 1)).toBe("(◑)"); // 1/2 done
    expect(at(4, 1)).toBe("(◕)"); // 3/4 done
    expect(at(4, 0)).toBe("(◉)"); // all children done, project still open
  });

  it("carries the project's own terminal state over progress", () => {
    expect(projectCircle(project({ status: "completed" }))).toBe("(✓)");
    expect(projectCircle(project({ status: "canceled" }))).toBe("(×)");
    expect(projectCircle(project({ start: "someday" }))).toBe("(~)");
  });
});

describe("todoBox", () => {
  it("keeps the plain box for DATED someday rows (the chip carries the state)", () => {
    expect(todoBox(todo({ start: "someday" }))).toBe("[~]");
    expect(todoBox(todo({ start: "someday", startDate: "2026-08-01" }))).toBe("[ ]");
  });
});

describe("shortDate", () => {
  it("drops the year inside the current year, keeps it otherwise", () => {
    expect(shortDate("2026-07-31", TODAY)).toBe("Jul 31");
    expect(shortDate("2027-01-02", TODAY)).toBe("Jan 2 2027");
    expect(shortDate("2025-12-31", TODAY)).toBe("Dec 31 2025");
  });
});
