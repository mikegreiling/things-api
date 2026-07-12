/**
 * Shared list-view truncation: turn a full, filtered result into the rows a
 * surface actually shows (default 50) plus the exact {@link Pagination}
 * metadata every surface reports so nothing is ever silently dropped. The
 * limit counts ITEMS in render order and truncates mid-group; grouped shapes
 * (the Today split, sidebar sections) drop the trailing groups that fall
 * entirely past the cut so no empty header survives. `limit === null` means
 * "all rows" (the caller passed --all / all: true).
 */
import type { BlockCount, GroupedPagination, Pagination } from "../contracts.ts";
import { DEFAULT_LIST_LIMIT, GROUPED_PREVIEW_LIMIT } from "../surface-copy.ts";
import type { ListItem, SidebarSection, TodayView } from "./views.ts";

export { DEFAULT_LIST_LIMIT, GROUPED_PREVIEW_LIMIT };

const whole = (total: number, limit: number | null): Pagination => ({
  shown: total,
  total,
  limit,
  truncated: false,
});

/** Flat list: slice to the limit; total is the full filtered length. */
export function paginateList<T>(
  items: T[],
  limit: number | null,
): { data: T[]; pagination: Pagination } {
  const total = items.length;
  if (limit === null || total <= limit) return { data: items, pagination: whole(total, limit) };
  return {
    data: items.slice(0, limit),
    pagination: { shown: limit, total, limit, truncated: true },
  };
}

/**
 * Today split: the cut runs across Today then This Evening in render order,
 * so a limit smaller than the Today block trims Evening to nothing. The badge
 * (a whole-view count summary) is preserved unchanged.
 */
export function paginateToday(
  view: TodayView,
  limit: number | null,
): { data: TodayView; pagination: Pagination } {
  const total = view.today.length + view.evening.length;
  if (limit === null || total <= limit) return { data: view, pagination: whole(total, limit) };
  const today = view.today.slice(0, limit);
  const evening = view.evening.slice(0, Math.max(0, limit - today.length));
  const shown = today.length + evening.length;
  return {
    data: { today, evening, badge: view.badge },
    pagination: { shown, total, limit, truncated: true },
  };
}

/**
 * Split one sidebar section into its innermost item blocks: the direct
 * to-dos that precede any project row, then one block per project (the
 * project row plus the to-dos that follow it until the next project).
 */
export interface SectionBlocks {
  direct: ListItem[];
  projects: Array<{ project: ListItem; items: ListItem[] }>;
}

export function splitSectionBlocks(section: SidebarSection): SectionBlocks {
  const direct: ListItem[] = [];
  const projects: Array<{ project: ListItem; items: ListItem[] }> = [];
  let cur: { project: ListItem; items: ListItem[] } | null = null;
  for (const item of section.items) {
    if (item.type === "project") {
      cur = { project: item, items: [] };
      projects.push(cur);
    } else if (cur === null) {
      direct.push(item);
    } else {
      cur.items.push(item);
    }
  }
  return { direct, projects };
}

/**
 * Grouped catalogues (anytime/someday): the block skeleton is ALWAYS complete
 * — every area header and every project row survives — and the `limit`
 * (null = no cap) is applied INDEPENDENTLY to each innermost item list (the
 * loose block, an area's direct to-dos, each project's to-dos). Returns the
 * per-block-truncated sections (project rows retained) plus the per-block
 * counts and a top-level `truncated` flag.
 */
export function previewSections(
  sections: SidebarSection[],
  limit: number | null,
): { data: SidebarSection[]; grouped: GroupedPagination } {
  const take = <T>(items: T[]): T[] => (limit === null ? items : items.slice(0, limit));
  const outSections: SidebarSection[] = [];
  const blocks: BlockCount[] = [];
  let truncated = false;
  for (const section of sections) {
    const { direct, projects } = splitSectionBlocks(section);
    const shownDirect = take(direct);
    if (direct.length > 0) {
      if (direct.length > shownDirect.length) truncated = true;
      blocks.push({
        kind: section.area === null ? "loose" : "area",
        uuid: section.area?.uuid ?? null,
        title: section.area?.title ?? null,
        shown: shownDirect.length,
        total: direct.length,
      });
    }
    const items: ListItem[] = [...shownDirect];
    for (const { project, items: children } of projects) {
      const shownChildren = take(children);
      if (children.length > 0) {
        if (children.length > shownChildren.length) truncated = true;
        blocks.push({
          kind: "project",
          uuid: project.uuid,
          title: project.title,
          shown: shownChildren.length,
          total: children.length,
        });
      }
      items.push(project, ...shownChildren);
    }
    outSections.push({ area: section.area, items });
  }
  return { data: outSections, grouped: { limit, truncated, blocks } };
}
