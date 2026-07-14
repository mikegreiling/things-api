/**
 * Glyph language pure functions: project-circle quantization and short-date
 * rules. Colors are OFF (non-TTY), so returns are the plain-text glyphs.
 */
import { describe, expect, it } from "vitest";

import type { Project, Todo } from "../../src/model/entities.ts";
import {
  deadlineDetail,
  deadlineToken,
  projectCircle,
  shortDate,
  todoBox,
  weekdayDate,
} from "../../src/cli/glyphs.ts";

const TODAY = "2026-07-05";

function project(overrides: Partial<Project>): Project {
  return {
    type: "project",
    status: "open",
    start: "active",
    startDate: null,
    untrashedLeafActionsCount: 0,
    openUntrashedLeafActionsCount: 0,
    repeating: { isTemplate: false, isInstance: false },
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

  it("seats ↻ inside the circle for a repeating project template", () => {
    expect(
      projectCircle(
        project({ repeating: { isTemplate: true, isInstance: false, templateUuid: null } }),
      ),
    ).toBe("(↻)");
  });
});

describe("todoBox — repeating templates", () => {
  it("seats ↻ inside the box (the rule row, not a checkable instance)", () => {
    expect(
      todoBox(todo({ repeating: { isTemplate: true, isInstance: false, templateUuid: null } })),
    ).toBe("[↻]");
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

  describe("compact form (iOS narrow-width oracle, 2026-07-14)", () => {
    it("shortens same-year month-day absolutes to M/D with NO zero-padding", () => {
      expect(deadlineToken("2026-09-16", TODAY, true)).toBe("⚑ 9/16");
      expect(deadlineToken("2026-05-04", TODAY, true)).toBe("⚑ 5/4"); // no zero-pad
      expect(deadlineToken("2026-08-12", TODAY, true)).toBe("⚑ 8/12");
      expect(deadlineToken("2026-12-31", TODAY, true)).toBe("⚑ 12/31");
    });

    it("shortens day-relatives to `Nd left` / `Nd ago` (singular gets no plural)", () => {
      expect(deadlineToken("2026-07-06", TODAY, true)).toBe("⚑ 1d left"); // iOS: 1d, no plural
      expect(deadlineToken("2026-07-19", TODAY, true)).toBe("⚑ 14d left");
      expect(deadlineToken("2026-07-04", TODAY, true)).toBe("⚑ 1d ago");
      expect(deadlineToken("2026-05-08", TODAY, true)).toBe("⚑ 58d ago");
      expect(deadlineToken("2026-05-07", TODAY, true)).toBe("⚑ 59d ago"); // -59 cutoff
    });

    it("keeps year-bearing far dates in the FULL form even when compact (deliberate)", () => {
      // `2/27` would be ambiguous with an M/D date; the oracle doesn't cover them.
      expect(deadlineToken("2027-02-10", TODAY, true)).toBe("⚑ Feb 2027");
      expect(deadlineToken("2025-03-01", TODAY, true)).toBe("⚑ Mar 2025");
    });

    it("leaves `⚑ today` unchanged (already minimal)", () => {
      expect(deadlineToken("2026-07-05", TODAY, true)).toBe("⚑ today");
    });
  });
});

describe("shortDate", () => {
  it("drops the year inside the current year, keeps it otherwise", () => {
    expect(shortDate("2026-07-31", TODAY)).toBe("Jul 31");
    expect(shortDate("2027-01-02", TODAY)).toBe("Jan 2 2027");
    expect(shortDate("2025-12-31", TODAY)).toBe("Dec 31 2025");
  });
});

describe("weekdayDate (detail-header date)", () => {
  it("prefixes the weekday; appends the year only when not the current year", () => {
    expect(weekdayDate("2026-08-28", TODAY)).toBe("Fri, Aug 28");
    expect(weekdayDate("2027-01-02", TODAY)).toBe("Sat, Jan 2 2027");
    expect(weekdayDate("2025-12-31", TODAY)).toBe("Wed, Dec 31 2025");
  });
});

describe("deadlineDetail (detail-card deadline value)", () => {
  // Colors are off (non-TTY) so styling collapses to plain text.
  it("renders the GUI weekday date plus a muted relative hint", () => {
    expect(deadlineDetail("2026-08-28", TODAY)).toBe("Fri, Aug 28 (54 days left)");
    expect(deadlineDetail("2026-07-06", TODAY)).toBe("Mon, Jul 6 (1 day left)");
  });

  it("says `due today` on the day and `n days overdue` once past", () => {
    expect(deadlineDetail(TODAY, TODAY)).toBe("Sun, Jul 5 (due today)");
    expect(deadlineDetail("2026-07-04", TODAY)).toBe("Sat, Jul 4 (1 day overdue)");
    expect(deadlineDetail("2026-06-05", TODAY)).toBe("Fri, Jun 5 (30 days overdue)");
  });
});
