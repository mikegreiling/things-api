/**
 * Shared list-view truncation: turn a full, filtered result into the rows a
 * surface actually shows (default 50) plus the exact {@link Truncation}
 * metadata every surface reports so nothing is ever silently dropped. The
 * limit counts ITEMS in render order and truncates mid-group; grouped shapes
 * (the Today split, sidebar sections) drop the trailing groups that fall
 * entirely past the cut so no empty header survives. `limit === null` means
 * "all rows" (the caller passed --all / all: true).
 */
import type { BlockCount, GroupedTruncation, Truncation } from "../contracts.ts";
import type { AreaView } from "./area-view.ts";
import { AREA_PREVIEW_LIMIT, DEFAULT_LIST_LIMIT, PROJECT_PREVIEW_LIMIT } from "../surface-copy.ts";
import type { ListItem, SidebarSection, TodayView } from "./views.ts";
import { partitionSomedaySection, splitSectionBlocks, type GroupedLimits } from "./sections.ts";

// The per-block cap shape and the structural section splitters live in
// ./sections.ts (imported for capping here). Re-exported so existing importers
// — and the truncation unit test — keep one import site.
export { AREA_PREVIEW_LIMIT, DEFAULT_LIST_LIMIT, PROJECT_PREVIEW_LIMIT };
export { partitionSomedaySection, splitSectionBlocks, type GroupedLimits };

const whole = (total: number, limit: number | null): Truncation => ({
  shown: total,
  total,
  limit,
  truncated: false,
});

/** Flat list: slice to the limit; total is the full filtered length. */
export function truncateList<T>(
  items: T[],
  limit: number | null,
): { data: T[]; truncation: Truncation } {
  const total = items.length;
  if (limit === null || total <= limit) return { data: items, truncation: whole(total, limit) };
  return {
    data: items.slice(0, limit),
    truncation: { shown: limit, total, limit, truncated: true },
  };
}

/**
 * Today split: the cut runs across Today then This Evening in render order,
 * so a limit smaller than the Today block trims Evening to nothing. The badge
 * (a whole-view count summary) is preserved unchanged.
 */
export function truncateToday(
  view: TodayView,
  limit: number | null,
): { data: TodayView; truncation: Truncation } {
  const total = view.today.length + view.evening.length;
  if (limit === null || total <= limit) return { data: view, truncation: whole(total, limit) };
  const today = view.today.slice(0, limit);
  const evening = view.evening.slice(0, Math.max(0, limit - today.length));
  const shown = today.length + evening.length;
  return {
    data: { today, evening, badge: view.badge },
    truncation: { shown, total, limit, truncated: true },
  };
}

const takeUpTo = <T>(items: T[], limit: number | null): T[] =>
  limit === null ? items : items.slice(0, limit);

/**
 * Anytime: the block skeleton is ALWAYS complete — every area header and
 * every project row survives — and the caps apply INDEPENDENTLY to each
 * innermost item list: `limits.area` to the loose block and each area's
 * direct to-dos, `limits.project` to each project's to-dos. Returns the
 * per-block-truncated sections (project rows retained) plus the per-block
 * counts and a top-level `truncated` flag.
 */
export function previewSections(
  sections: SidebarSection[],
  limits: GroupedLimits,
): { data: SidebarSection[]; grouped: GroupedTruncation } {
  const outSections: SidebarSection[] = [];
  const blocks: BlockCount[] = [];
  let truncated = false;
  for (const section of sections) {
    const { direct, projects } = splitSectionBlocks(section);
    const shownDirect = takeUpTo(direct, limits.area);
    if (direct.length > 0) {
      if (direct.length > shownDirect.length) truncated = true;
      blocks.push({
        kind: section.area === null ? "loose" : "area",
        uuid: section.area?.uuid ?? null,
        title: section.area?.title ?? null,
        shown: shownDirect.length,
        total: direct.length,
        limit: limits.area,
      });
    }
    const items: ListItem[] = [...shownDirect];
    for (const { project, items: children } of projects) {
      const shownChildren = takeUpTo(children, limits.project);
      if (children.length > 0) {
        if (children.length > shownChildren.length) truncated = true;
        blocks.push({
          kind: "project",
          uuid: project.uuid,
          title: project.title,
          shown: shownChildren.length,
          total: children.length,
          limit: limits.project,
        });
      }
      items.push(project, ...shownChildren);
    }
    outSections.push({ area: section.area, items });
  }
  return { data: outSections, grouped: { truncated, blocks } };
}

/**
 * Someday preview: every group survives; `limits.area` (null = no cap)
 * applies independently to each section's own block (project rows + direct
 * to-dos are items alike there), `limits.project` to each active project's
 * child group (the show-active-project-items toggle). Sections keep their
 * capped children after the own block, still clustered per project.
 */
export function previewSomedaySections(
  sections: SidebarSection[],
  limits: GroupedLimits,
): { data: SidebarSection[]; grouped: GroupedTruncation } {
  const outSections: SidebarSection[] = [];
  const blocks: BlockCount[] = [];
  let truncated = false;
  for (const section of sections) {
    const { own, children } = partitionSomedaySection(section);
    const shownOwn = takeUpTo(own, limits.area);
    if (own.length > 0) {
      if (own.length > shownOwn.length) truncated = true;
      const totalProjects = own.filter((i) => i.type === "project").length;
      blocks.push({
        kind: section.area === null ? "loose" : "area",
        uuid: section.area?.uuid ?? null,
        title: section.area?.title ?? null,
        shown: shownOwn.length,
        total: own.length,
        limit: limits.area,
        totalProjects,
        totalTodos: own.length - totalProjects,
      });
    }
    const items: ListItem[] = [...shownOwn];
    for (const group of children) {
      const shown = takeUpTo(group.items, limits.project);
      if (group.items.length > shown.length) truncated = true;
      blocks.push({
        kind: "project",
        uuid: group.project.uuid,
        title: group.project.title,
        shown: shown.length,
        total: group.items.length,
        limit: limits.project,
      });
      items.push(...shown);
    }
    outSections.push({ area: section.area, items });
  }
  return { data: outSections, grouped: { truncated, blocks } };
}

/**
 * Sectioned cap for the `area show` detail view: its sections are containers,
 * so there is no strict total limit — instead `limits.project` bounds the
 * project-ROWS section and `limits.area` the direct-to-dos section (null =
 * uncapped). The toggled later/logged lists and the trashed bucket pass
 * through untouched. Counts ride the same grouped-block shape the sidebar
 * catalogues emit (kind "projects" = the project-rows section).
 */
export function capAreaSections(
  view: AreaView,
  limits: GroupedLimits,
): { data: AreaView; grouped: GroupedTruncation } {
  const blocks: BlockCount[] = [];
  let truncated = false;
  const projects = limits.project === null ? view.projects : view.projects.slice(0, limits.project);
  if (view.projects.length > 0) {
    if (projects.length < view.projects.length) truncated = true;
    blocks.push({
      kind: "projects",
      uuid: view.area.uuid,
      title: view.area.title,
      shown: projects.length,
      total: view.projects.length,
      limit: limits.project,
    });
  }
  const active = limits.area === null ? view.active : view.active.slice(0, limits.area);
  if (view.active.length > 0) {
    if (active.length < view.active.length) truncated = true;
    blocks.push({
      kind: "area",
      uuid: view.area.uuid,
      title: view.area.title,
      shown: active.length,
      total: view.active.length,
      limit: limits.area,
    });
  }
  return { data: { ...view, projects, active }, grouped: { truncated, blocks } };
}
