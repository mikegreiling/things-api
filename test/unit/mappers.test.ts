import { describe, expect, it } from "vitest";

import type { Ref } from "../../src/model/entities.ts";
import {
  EnumDomainError,
  mapHeading,
  mapProject,
  mapTodo,
  type TaskRow,
} from "../../src/model/mappers.ts";

const AREA: Ref = { uuid: "area-1", title: "LAB-AREA-A" };
const refs = (uuid: string | null): Ref | null => (uuid === "area-1" ? AREA : null);

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    uuid: "t-1",
    type: 0,
    status: 0,
    stopDate: null,
    trashed: 0,
    title: "Buy milk",
    notes: "",
    creationDate: 1_780_000_000.5,
    userModificationDate: 1_780_000_100,
    start: 1,
    startDate: 132803712, // 2026-06-25, live-verified vector
    startBucket: 1,
    reminderTime: null,
    deadline: null,
    index: -1731,
    todayIndex: 6000626,
    area: "area-1",
    project: null,
    heading: null,
    untrashedLeafActionsCount: null,
    openUntrashedLeafActionsCount: null,
    checklistItemsCount: 2,
    openChecklistItemsCount: 1,
    rt1_repeatingTemplate: null,
    rt1_recurrenceRule: null,
    repeater: null,
    ...overrides,
  };
}

describe("mapTodo", () => {
  it("maps a scheduled This Evening to-do", () => {
    const todo = mapTodo(row(), refs, []);
    expect(todo.type).toBe("to-do");
    expect(todo.status).toBe("open");
    expect(todo.start).toBe("active");
    expect(todo.startDate).toBe("2026-06-25");
    expect(todo.todaySection).toBe("evening");
    expect(todo.area).toEqual(AREA);
    expect(todo.todayIndex).toBe(6000626); // sparse rank exposed raw
    expect(todo.repeating).toEqual({ isTemplate: false, isInstance: false, templateUuid: null });
  });

  it("flags repeating templates and instances distinctly", () => {
    const template = mapTodo(row({ rt1_recurrenceRule: new Uint8Array([1]) }), refs, []);
    expect(template.repeating.isTemplate).toBe(true);
    const instance = mapTodo(row({ rt1_repeatingTemplate: "tpl-1" }), refs, []);
    expect(instance.repeating).toEqual({
      isTemplate: false,
      isInstance: true,
      templateUuid: "tpl-1",
    });
  });

  it("throws EnumDomainError on out-of-domain status instead of guessing", () => {
    expect(() => mapTodo(row({ status: 1 }), refs, [])).toThrow(EnumDomainError);
  });

  it("maps canceled/completed with stop timestamps", () => {
    const done = mapTodo(row({ status: 3, stopDate: 1_780_000_200 }), refs, []);
    expect(done.status).toBe("completed");
    expect(done.stopped?.getTime()).toBe(1_780_000_200_000);
  });
});

describe("mapProject / mapHeading", () => {
  it("maps project child counts", () => {
    const project = mapProject(
      row({ type: 1, untrashedLeafActionsCount: 5, openUntrashedLeafActionsCount: 2 }),
      refs,
      [],
    );
    expect(project.type).toBe("project");
    expect(project.openUntrashedLeafActionsCount).toBe(2);
  });

  it("maps headings minimally", () => {
    const heading = mapHeading(row({ type: 2, title: "Phase 1", project: null }), refs);
    expect(heading).toEqual({
      uuid: "t-1",
      type: "heading",
      title: "Phase 1",
      project: null,
      index: -1731,
    });
  });
});
