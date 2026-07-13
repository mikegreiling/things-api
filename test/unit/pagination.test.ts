/**
 * The shared list-view truncation: exact totals, mid-group cuts for the flat
 * shapes, and the per-block preview (area/project caps, "no header ever
 * dropped") for the grouped catalogues. Pure functions — no DB.
 */
import { describe, expect, it } from "vitest";

import {
  AREA_PREVIEW_LIMIT,
  DEFAULT_LIST_LIMIT,
  PROJECT_PREVIEW_LIMIT,
  paginateList,
  paginateToday,
  partitionSomedaySection,
  previewSections,
  previewSomedaySections,
  splitSectionBlocks,
} from "../../src/read/pagination.ts";
import type { ListItem, SidebarSection, TodayView } from "../../src/read/views.ts";

/** Minimal ListItem stand-ins — pagination only inspects type/uuid/refs. */
const items = (n: number, prefix = "u"): ListItem[] =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        uuid: `${prefix}${i}`,
        type: "to-do",
        project: null,
        headingProject: null,
      }) as unknown as ListItem,
  );

const project = (uuid: string, title: string): ListItem =>
  ({ uuid, title, type: "project", project: null, headingProject: null }) as unknown as ListItem;

const childOf = (uuid: string, projectUuid: string, projectTitle: string): ListItem =>
  ({
    uuid,
    type: "to-do",
    project: { uuid: projectUuid, title: projectTitle },
    headingProject: null,
  }) as unknown as ListItem;

describe("paginateList", () => {
  it("returns everything untruncated under the limit", () => {
    const { data, pagination } = paginateList(items(3), 50);
    expect(data).toHaveLength(3);
    expect(pagination).toEqual({ shown: 3, total: 3, limit: 50, truncated: false });
  });

  it("slices to the limit and reports the exact total", () => {
    const { data, pagination } = paginateList(items(1000), 50);
    expect(data).toHaveLength(50);
    expect(pagination).toEqual({ shown: 50, total: 1000, limit: 50, truncated: true });
  });

  it("limit null returns all rows, never truncated", () => {
    const { data, pagination } = paginateList(items(1000), null);
    expect(data).toHaveLength(1000);
    expect(pagination).toEqual({ shown: 1000, total: 1000, limit: null, truncated: false });
  });

  it("the exposed defaults are 50 flat / 30 per area / 3 per project", () => {
    expect(DEFAULT_LIST_LIMIT).toBe(50);
    expect(AREA_PREVIEW_LIMIT).toBe(30);
    expect(PROJECT_PREVIEW_LIMIT).toBe(3);
  });
});

describe("paginateToday", () => {
  const view = (todayN: number, eveningN: number): TodayView => ({
    today: items(todayN),
    evening: items(eveningN, "e"),
    badge: { dueOrOverdue: 1, other: 2 },
  });

  it("counts the cut across Today then This Evening in render order", () => {
    const { data, pagination } = paginateToday(view(4, 4), 6);
    expect(data.today).toHaveLength(4);
    expect(data.evening).toHaveLength(2);
    expect(pagination).toEqual({ shown: 6, total: 8, limit: 6, truncated: true });
    // The whole-view badge summary is preserved.
    expect(data.badge).toEqual({ dueOrOverdue: 1, other: 2 });
  });

  it("a limit smaller than Today trims Evening to nothing", () => {
    const { data, pagination } = paginateToday(view(10, 5), 3);
    expect(data.today).toHaveLength(3);
    expect(data.evening).toEqual([]);
    expect(pagination.total).toBe(15);
    expect(pagination.shown).toBe(3);
  });
});

describe("splitSectionBlocks", () => {
  it("splits direct to-dos from each project's followers", () => {
    const section: SidebarSection = {
      area: { uuid: "a", title: "Area" },
      items: [
        ...items(2), // direct (u0, u1)
        project("p1", "Proj 1"),
        ...items(3, "c"), // p1 children
        project("p2", "Proj 2"),
      ],
    };
    const { direct, projects } = splitSectionBlocks(section);
    expect(direct).toHaveLength(2);
    expect(projects).toHaveLength(2);
    expect(projects[0]?.items).toHaveLength(3);
    expect(projects[1]?.items).toHaveLength(0);
  });
});

describe("previewSections (anytime per-block preview)", () => {
  const grouped: SidebarSection = {
    area: { uuid: "a", title: "Hobbies" },
    items: [...items(10), project("p1", "Firmware"), ...items(8, "c")],
  };
  const loose: SidebarSection = { area: null, items: items(9, "l") };

  it("caps area blocks and project blocks with their own limits", () => {
    const { data, grouped: meta } = previewSections([loose, grouped], { area: 4, project: 3 });
    // Loose block: 4 of 9 direct.
    expect(data[0]?.items).toHaveLength(4);
    // Area section: 4 direct + the project row + 3 children = 8 rows.
    expect(data[1]?.items).toHaveLength(8);
    expect(data[1]?.items.some((i) => i.type === "project")).toBe(true);
    expect(meta.truncated).toBe(true);
    expect(meta.blocks).toEqual([
      { kind: "loose", uuid: null, title: null, shown: 4, total: 9, limit: 4 },
      { kind: "area", uuid: "a", title: "Hobbies", shown: 4, total: 10, limit: 4 },
      { kind: "project", uuid: "p1", title: "Firmware", shown: 3, total: 8, limit: 3 },
    ]);
  });

  it("null caps (--all) keep every item and report no truncation", () => {
    const { data, grouped: meta } = previewSections([grouped], { area: null, project: null });
    expect(data[0]?.items).toHaveLength(19); // 10 direct + project row + 8 children
    expect(meta.truncated).toBe(false);
    expect(meta.blocks.every((b) => b.shown === b.total && b.limit === null)).toBe(true);
  });

  it("empty blocks are omitted from the counts; project rows always survive", () => {
    const { data, grouped: meta } = previewSections(
      [{ area: null, items: [project("p", "Empty Proj")] }],
      { area: 3, project: 3 },
    );
    expect(meta.blocks).toEqual([]);
    expect(meta.truncated).toBe(false);
    expect(data[0]?.items).toHaveLength(1); // the project row itself
  });
});

describe("partitionSomedaySection", () => {
  it("separates own items (projects + direct to-dos) from per-project children", () => {
    const section: SidebarSection = {
      area: { uuid: "a", title: "Area" },
      items: [
        project("p1", "Proj 1"),
        ...items(2),
        childOf("k0", "p1", "Proj 1"),
        childOf("k1", "p1", "Proj 1"),
        childOf("k2", "p2", "Proj 2"),
      ],
    };
    const { own, children } = partitionSomedaySection(section);
    // Own = the project ROW + the 2 direct to-dos (project rows are items).
    expect(own.map((i) => i.uuid)).toEqual(["p1", "u0", "u1"]);
    expect(children).toHaveLength(2);
    expect(children[0]?.project).toEqual({ uuid: "p1", title: "Proj 1" });
    expect(children[0]?.items).toHaveLength(2);
    expect(children[1]?.project.uuid).toBe("p2");
  });
});

describe("previewSomedaySections", () => {
  const section: SidebarSection = {
    area: { uuid: "a", title: "Hobbies" },
    items: [
      project("p1", "Proj 1"),
      project("p2", "Proj 2"),
      ...items(6),
      childOf("k0", "p1", "Proj 1"),
      childOf("k1", "p1", "Proj 1"),
      childOf("k2", "p1", "Proj 1"),
    ],
  };

  it("area cap covers project rows + direct to-dos as one block; children cap per project", () => {
    const { data, grouped: meta } = previewSomedaySections([section], { area: 4, project: 2 });
    // 4 own (2 project rows + first 2 to-dos) + 2 children = 6.
    expect(data[0]?.items.map((i) => i.uuid)).toEqual(["p1", "p2", "u0", "u1", "k0", "k1"]);
    expect(meta.truncated).toBe(true);
    expect(meta.blocks).toEqual([
      { kind: "area", uuid: "a", title: "Hobbies", shown: 4, total: 8, limit: 4 },
      { kind: "project", uuid: "p1", title: "Proj 1", shown: 2, total: 3, limit: 2 },
    ]);
  });

  it("null project cap (bare show flag) keeps every child", () => {
    const { data, grouped: meta } = previewSomedaySections([section], { area: 50, project: null });
    expect(data[0]?.items).toHaveLength(11);
    expect(meta.truncated).toBe(false);
    expect(meta.blocks.find((b) => b.kind === "project")?.limit).toBeNull();
  });
});
