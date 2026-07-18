import { describe, expect, it } from "vitest";

import type { Ref } from "../../src/model/entities.ts";
import { encodePackedDate } from "../../src/model/dates.ts";
import {
  EnumDomainError,
  mapHeading,
  mapProject,
  mapTodo,
  type TaskRow,
} from "../../src/model/mappers.ts";

const AREA: Ref = { uuid: "area-1", title: "LAB-AREA-A" };
const refs = (uuid: string | null): Ref | null => (uuid === "area-1" ? AREA : null);

// The default row is scheduled 2026-06-25; TODAY equals that day so the row is a
// Today member (startDate <= today). FUTURE/PAST bracket it for the gate tests.
const TODAY = encodePackedDate("2026-06-25");
const FUTURE = encodePackedDate("2026-07-10");
const PAST = encodePackedDate("2026-06-01");

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
    rt1_nextInstanceStartDate: null,
    rt1_instanceCreationPaused: null,
    index: -1731,
    todayIndex: 6000626,
    area: "area-1",
    // The entity's `area` Ref maps from effectiveArea (queries.ts EFFECTIVE_AREA);
    // for a direct-area to-do it equals `area`.
    effectiveArea: "area-1",
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
    const todo = mapTodo(row(), refs, [], TODAY);
    expect(todo.type).toBe("to-do");
    expect(todo.status).toBe("open");
    expect(todo.start).toBe("active");
    expect(todo.startDate).toBe("2026-06-25");
    expect(todo.todaySection).toBe("evening");
    expect(todo.area).toEqual(AREA);
    expect(todo.repeating).toEqual({ isTemplate: false, isInstance: false, templateUuid: null });
  });

  it("flags repeating templates and instances distinctly", () => {
    const template = mapTodo(row({ rt1_recurrenceRule: new Uint8Array([1]) }), refs, [], TODAY);
    expect(template.repeating.isTemplate).toBe(true);
    const instance = mapTodo(row({ rt1_repeatingTemplate: "tpl-1" }), refs, [], TODAY);
    expect(instance.repeating).toEqual({
      isTemplate: false,
      isInstance: true,
      templateUuid: "tpl-1",
    });
  });

  it("throws EnumDomainError on out-of-domain status instead of guessing", () => {
    expect(() => mapTodo(row({ status: 1 }), refs, [], TODAY)).toThrow(EnumDomainError);
  });

  it("maps canceled/completed with stop timestamps", () => {
    const done = mapTodo(row({ status: 3, stopDate: 1_780_000_200 }), refs, [], TODAY);
    expect(done.status).toBe("completed");
    expect(done.stopped?.getTime()).toBe(1_780_000_200_000);
  });
});

describe("mapTodaySection gate (Today members only)", () => {
  // An undated active to-do carries startBucket=0 in the DB (prod truth) but is
  // in Anytime, NOT Today — the field must be omitted, not reported "today".
  it("omits todaySection for an undated Anytime to-do", () => {
    const todo = mapTodo(row({ start: 1, startDate: null, startBucket: 0 }), refs, [], TODAY);
    expect(todo.start).toBe("active");
    expect(todo.todaySection).toBeNull();
  });

  // A future startDate (Upcoming) also carries startBucket=0; still not Today.
  it("omits todaySection for a future-scheduled (Upcoming) to-do", () => {
    const todo = mapTodo(row({ start: 1, startDate: FUTURE, startBucket: 0 }), refs, [], TODAY);
    expect(todo.todaySection).toBeNull();
  });

  // Overdue scheduled rows (startDate < today) DO sit in Today.
  it("keeps todaySection='today' for an overdue scheduled to-do", () => {
    const todo = mapTodo(row({ start: 1, startDate: PAST, startBucket: 0 }), refs, [], TODAY);
    expect(todo.todaySection).toBe("today");
  });

  // A dated Today member with startBucket=0 reports "today".
  it("reports todaySection='today' for a to-do scheduled today", () => {
    const todo = mapTodo(row({ start: 1, startDate: TODAY, startBucket: 0 }), refs, [], TODAY);
    expect(todo.todaySection).toBe("today");
  });

  // Inbox rows (start=0) are never in Today, whatever their raw startBucket.
  it("omits todaySection for an inbox to-do", () => {
    const todo = mapTodo(row({ start: 0, startDate: null, startBucket: 0 }), refs, [], TODAY);
    expect(todo.todaySection).toBeNull();
  });
});

describe("mapProject / mapHeading", () => {
  it("maps project child counts", () => {
    const project = mapProject(
      row({ type: 1, untrashedLeafActionsCount: 5, openUntrashedLeafActionsCount: 2 }),
      refs,
      [],
      TODAY,
    );
    expect(project.type).toBe("project");
    expect(project.openUntrashedLeafActionsCount).toBe(2);
  });

  it("maps headings minimally (plus archived-state status)", () => {
    const heading = mapHeading(row({ type: 2, title: "Phase 1", project: null }), refs);
    expect(heading).toEqual({
      uuid: "t-1",
      type: "heading",
      title: "Phase 1",
      status: "open",
      project: null,
    });
    const archived = mapHeading(row({ type: 2, title: "Done", project: null, status: 3 }), refs);
    expect(archived.status).toBe("completed");
  });
});
