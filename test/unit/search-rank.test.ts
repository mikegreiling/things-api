/**
 * The pure search-ranking comparator (src/read/search-rank.ts): a
 * deterministic composite — match field, then type, then status, then
 * most-recently-modified. Documented in docs/design/cli-grammar.md.
 */
import { describe, expect, it } from "vitest";

import type { Project, Todo } from "../../src/model/entities.ts";
import {
  compareSearchMatches,
  fieldRank,
  matchStatus,
  statusRank,
  typeRank,
  type MatchField,
  type SearchMatch,
} from "../../src/read/search-rank.ts";
import type { ListItem } from "../../src/read/views.ts";

function todo(overrides: Partial<Todo>): Todo {
  return {
    type: "to-do",
    uuid: "u",
    title: "t",
    status: "open",
    start: "active",
    startDate: null,
    trashed: false,
    modified: new Date("2026-01-01"),
    repeating: { isTemplate: false, isInstance: false },
    ...overrides,
  } as Todo;
}
function project(overrides: Partial<Project>): Project {
  return { ...(todo({}) as unknown as Project), type: "project", ...overrides } as Project;
}
function match(item: ListItem, field: MatchField): SearchMatch {
  return { item, field };
}

describe("rank keys", () => {
  it("field: title < notes < heading < checklist", () => {
    expect(fieldRank("title")).toBeLessThan(fieldRank("notes"));
    expect(fieldRank("notes")).toBeLessThan(fieldRank("heading"));
    expect(fieldRank("heading")).toBeLessThan(fieldRank("checklist"));
  });

  it("type: containers before to-dos", () => {
    expect(typeRank("project")).toBeLessThan(typeRank("to-do"));
    expect(typeRank("area")).toBeLessThan(typeRank("to-do"));
  });

  it("status: active < someday < logged < trashed", () => {
    expect(statusRank("active")).toBeLessThan(statusRank("someday"));
    expect(statusRank("someday")).toBeLessThan(statusRank("logged"));
    expect(statusRank("logged")).toBeLessThan(statusRank("trashed"));
  });

  it("matchStatus derives the bucket from item state", () => {
    expect(matchStatus(todo({ status: "open", start: "active" }))).toBe("active");
    expect(matchStatus(todo({ status: "open", start: "someday" }))).toBe("someday");
    expect(matchStatus(todo({ status: "completed" }))).toBe("logged");
    expect(matchStatus(todo({ trashed: true }))).toBe("trashed");
  });
});

describe("compareSearchMatches", () => {
  it("field trumps status: a someday TITLE match outranks an active NOTES match", () => {
    const somedayTitle = match(todo({ uuid: "a", start: "someday" }), "title");
    const activeNotes = match(todo({ uuid: "b", start: "active" }), "notes");
    expect(
      [activeNotes, somedayTitle].toSorted(compareSearchMatches).map((m) => m.item.uuid),
    ).toEqual(["a", "b"]);
  });

  it("within a field, projects rank above to-dos", () => {
    const p = match(project({ uuid: "p" }), "title");
    const t = match(todo({ uuid: "t" }), "title");
    expect([t, p].toSorted(compareSearchMatches).map((m) => m.item.uuid)).toEqual(["p", "t"]);
  });

  it("ties break by most-recently-modified, then uuid", () => {
    const older = match(todo({ uuid: "old", modified: new Date("2026-01-01") }), "title");
    const newer = match(todo({ uuid: "new", modified: new Date("2026-06-01") }), "title");
    expect([older, newer].toSorted(compareSearchMatches).map((m) => m.item.uuid)).toEqual([
      "new",
      "old",
    ]);
  });

  it("heading-via-project ranks below notes but above to-do title? no — field is absolute", () => {
    // A heading-credited PROJECT (field heading) sits below any notes match,
    // even a to-do notes match, because field is the first key.
    const headingProject = match(project({ uuid: "hp" }), "heading");
    const todoNotes = match(todo({ uuid: "tn" }), "notes");
    expect(
      [headingProject, todoNotes].toSorted(compareSearchMatches).map((m) => m.item.uuid),
    ).toEqual(["tn", "hp"]);
  });
});
