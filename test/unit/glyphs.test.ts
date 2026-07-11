/**
 * Glyph language pure functions: project-circle quantization and short-date
 * rules. Colors are OFF (non-TTY), so returns are the plain-text glyphs.
 */
import { describe, expect, it } from "vitest";

import type { Project, Todo } from "../../src/model/entities.ts";
import { deadlineToken, projectCircle, shortDate, todoBox } from "../../src/cli/glyphs.ts";

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
  return {
    type: "to-do",
    status: "open",
    start: "active",
    startDate: null,
    repeating: { isTemplate: false, isInstance: false },
    ...overrides,
  } as Todo;
}

describe("projectCircle", () => {
  it("uses the checkbox marks — progress lives in the ratio chip, not the circle", () => {
    expect(projectCircle(project({}))).toBe("( )");
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

describe("deadlineToken", () => {
  it("uses relative phrasing near the deadline, GUI cutoffs 14/59 days", () => {
    expect(deadlineToken("2026-07-05", TODAY)).toBe("⚑ today");
    expect(deadlineToken("2026-07-06", TODAY)).toBe("⚑ 1 day left");
    expect(deadlineToken("2026-07-19", TODAY)).toBe("⚑ 14 days left");
    expect(deadlineToken("2026-07-20", TODAY)).toBe("⚑ Jul 20"); // 15 out → date
    expect(deadlineToken("2026-07-04", TODAY)).toBe("⚑ 1 day ago");
    expect(deadlineToken("2026-05-07", TODAY)).toBe("⚑ 59 days ago");
    expect(deadlineToken("2026-05-06", TODAY)).toBe("⚑ May 6"); // 60 past → date
  });

  it("shortens far dates: day within the year, month+year beyond it", () => {
    expect(deadlineToken("2026-09-16", TODAY)).toBe("⚑ Sep 16");
    expect(deadlineToken("2027-02-10", TODAY)).toBe("⚑ Feb 2027");
    expect(deadlineToken("2025-03-01", TODAY)).toBe("⚑ Mar 2025");
  });
});

describe("shortDate", () => {
  it("drops the year inside the current year, keeps it otherwise", () => {
    expect(shortDate("2026-07-31", TODAY)).toBe("Jul 31");
    expect(shortDate("2027-01-02", TODAY)).toBe("Jan 2 2027");
    expect(shortDate("2025-12-31", TODAY)).toBe("Dec 31 2025");
  });
});
