/**
 * The shared list-view truncation: exact totals, mid-group cuts, and the
 * "no empty header survives" rule for grouped shapes. Pure functions — no DB.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIST_LIMIT,
  GROUPED_PREVIEW_LIMIT,
  paginateList,
  paginateToday,
  previewSections,
  splitSectionBlocks,
} from "../../src/read/pagination.ts";
import type { ListItem, SidebarSection, TodayView } from "../../src/read/views.ts";

/** Minimal ListItem stand-ins — pagination never inspects item fields beyond type/uuid. */
const items = (n: number): ListItem[] =>
  Array.from({ length: n }, (_, i) => ({ uuid: `u${i}`, type: "to-do" }) as unknown as ListItem);

const project = (uuid: string, title: string): ListItem =>
  ({ uuid, title, type: "project" }) as unknown as ListItem;

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

  it("the exposed default is 50", () => {
    expect(DEFAULT_LIST_LIMIT).toBe(50);
  });
});

describe("paginateToday", () => {
  const view = (todayN: number, eveningN: number): TodayView => ({
    today: items(todayN),
    evening: items(eveningN),
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
        ...items(3), // p1 children
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

describe("previewSections (grouped per-block preview)", () => {
  const grouped: SidebarSection = {
    area: { uuid: "a", title: "Hobbies" },
    items: [...items(10), project("p1", "Firmware"), ...items(8)],
  };
  const loose: SidebarSection = { area: null, items: items(9) };

  it("the exposed grouped default is 3", () => {
    expect(GROUPED_PREVIEW_LIMIT).toBe(3);
  });

  it("caps each block independently and keeps every project row", () => {
    const { data, grouped: meta } = previewSections([loose, grouped], 3);
    // Loose block: 3 of 9 direct.
    expect(data[0]?.items).toHaveLength(3);
    // Area section: 3 direct + the project row + 3 children = 7 rows.
    expect(data[1]?.items).toHaveLength(7);
    expect(data[1]?.items.some((i) => i.type === "project")).toBe(true);
    expect(meta.truncated).toBe(true);
    expect(meta.blocks).toEqual([
      { kind: "loose", uuid: null, title: null, shown: 3, total: 9 },
      { kind: "area", uuid: "a", title: "Hobbies", shown: 3, total: 10 },
      { kind: "project", uuid: "p1", title: "Firmware", shown: 3, total: 8 },
    ]);
  });

  it("--all (null) keeps every item and reports no truncation", () => {
    const { data, grouped: meta } = previewSections([grouped], null);
    expect(data[0]?.items).toHaveLength(19); // 10 direct + project row + 8 children
    expect(meta.truncated).toBe(false);
    expect(meta.blocks.every((b) => b.shown === b.total)).toBe(true);
  });

  it("empty blocks are omitted from the counts", () => {
    const { grouped: meta } = previewSections(
      [{ area: null, items: [project("p", "Empty Proj")] }],
      3,
    );
    // A project with no children contributes no block entry.
    expect(meta.blocks).toEqual([]);
    expect(meta.truncated).toBe(false);
  });
});
