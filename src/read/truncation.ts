/**
 * Shared list-view truncation: turn a full, filtered result into the rows a
 * surface actually shows (default 50) plus the exact {@link Truncation}
 * metadata every surface reports so nothing is ever silently dropped. The
 * limit counts ITEMS in render order and truncates mid-group; grouped shapes
 * (the Today split, sidebar sections) drop the trailing groups that fall
 * entirely past the cut so no empty header survives. `limit === null` means
 * "all rows" (the caller passed --all / all: true).
 */
import type { GroupBlock, GroupedTruncation, SectionCount, Truncation } from "../contracts.ts";
import { localToday } from "../model/dates.ts";
import { isActiveProjectRow, type AreaView } from "./area-view.ts";
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
 * (a whole-view count summary) is preserved unchanged. The truncation carries
 * a per-section (`today`/`evening`) shown/total breakdown so a renderer can
 * keep This Evening honest under the single global cap without a pre-cap copy.
 */
export function truncateToday(
  view: TodayView,
  limit: number | null,
): { data: TodayView; truncation: Truncation } {
  const todayTotal = view.today.length;
  const eveningTotal = view.evening.length;
  const total = todayTotal + eveningTotal;
  const sections = (shownToday: number, shownEvening: number): SectionCount[] => [
    { key: "today", shown: shownToday, total: todayTotal },
    { key: "evening", shown: shownEvening, total: eveningTotal },
  ];
  if (limit === null || total <= limit) {
    return {
      data: view,
      truncation: { ...whole(total, limit), sections: sections(todayTotal, eveningTotal) },
    };
  }
  const today = view.today.slice(0, limit);
  const evening = view.evening.slice(0, Math.max(0, limit - today.length));
  const shown = today.length + evening.length;
  return {
    data: { today, evening, badge: view.badge },
    truncation: {
      shown,
      total,
      limit,
      truncated: true,
      sections: sections(today.length, evening.length),
    },
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
  const blocks: GroupBlock[] = [];
  let truncated = false;
  for (const section of sections) {
    const { direct, projects } = splitSectionBlocks(section);
    const shownDirect = takeUpTo(direct, limits.area);
    if (direct.length > shownDirect.length) truncated = true;
    // Project item-lists nest inside their area/loose block.
    const children: GroupBlock[] = [];
    const items: ListItem[] = [...shownDirect];
    for (const { project, items: kids } of projects) {
      const shownChildren = takeUpTo(kids, limits.project);
      if (kids.length > 0) {
        if (kids.length > shownChildren.length) truncated = true;
        children.push({
          kind: "project",
          ref: project.uuid,
          title: project.title,
          shown: shownChildren.length,
          total: kids.length,
          limit: limits.project,
        });
      }
      items.push(project, ...shownChildren);
    }
    if (direct.length > 0 || children.length > 0) {
      blocks.push({
        kind: section.area === null ? "loose" : "area",
        ref: section.area?.uuid ?? null,
        title: section.area?.title ?? null,
        shown: shownDirect.length,
        total: direct.length,
        limit: limits.area,
        ...(children.length > 0 && { children }),
      });
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
  const blocks: GroupBlock[] = [];
  let truncated = false;
  for (const section of sections) {
    const { own, children } = partitionSomedaySection(section);
    const shownOwn = takeUpTo(own, limits.area);
    if (own.length > shownOwn.length) truncated = true;
    // The active-project child groups nest inside this section's own block.
    const childBlocks: GroupBlock[] = [];
    const items: ListItem[] = [...shownOwn];
    for (const group of children) {
      const shown = takeUpTo(group.items, limits.project);
      if (group.items.length > shown.length) truncated = true;
      childBlocks.push({
        kind: "project",
        ref: group.project.uuid,
        title: group.project.title,
        shown: shown.length,
        total: group.items.length,
        limit: limits.project,
      });
      items.push(...shown);
    }
    if (own.length > 0 || childBlocks.length > 0) {
      const totalProjects = own.filter((i) => i.type === "project").length;
      blocks.push({
        kind: section.area === null ? "loose" : "area",
        ref: section.area?.uuid ?? null,
        title: section.area?.title ?? null,
        shown: shownOwn.length,
        total: own.length,
        limit: limits.area,
        totalProjects,
        totalTodos: own.length - totalProjects,
        ...(childBlocks.length > 0 && { children: childBlocks }),
      });
    }
    outSections.push({ area: section.area, items });
  }
  return { data: outSections, grouped: { truncated, blocks } };
}

/**
 * Sectioned cap for the `area show` detail view: its sections are containers,
 * so there is no strict total limit — instead `limits.project` bounds the
 * ACTIVE project-ROWS section and `limits.area` the direct-to-dos section
 * (null = uncapped). The cap is render-aware: only the area's ACTIVE project
 * rows are capped, while its future-scheduled and someday project rows always
 * survive (the card renders them under its uncapped Upcoming/Someday sections),
 * so the human view derives entirely from this bounded shape. The toggled
 * later/logged lists and the trashed bucket pass through untouched. Counts ride
 * the same grouped-block shape the sidebar catalogues emit (kind "projects" =
 * the active project-rows section). `now` classifies the schedule split.
 */
export function capAreaSections(
  view: AreaView,
  limits: GroupedLimits,
  now?: Date,
  zone?: string,
): { data: AreaView; grouped: GroupedTruncation } {
  const todayIso = localToday(now, zone);
  const blocks: GroupBlock[] = [];
  let truncated = false;
  // Cap the ACTIVE project rows in place; scheduled/someday rows always survive.
  const activeTotal = view.projects.filter((p) => isActiveProjectRow(p, todayIso)).length;
  const shownActive = limits.project === null ? activeTotal : Math.min(activeTotal, limits.project);
  let activeSeen = 0;
  const projects = view.projects.filter((p) => {
    if (!isActiveProjectRow(p, todayIso)) return true;
    activeSeen += 1;
    return limits.project === null || activeSeen <= limits.project;
  });
  if (activeTotal > 0) {
    if (shownActive < activeTotal) truncated = true;
    blocks.push({
      kind: "projects",
      ref: view.area.uuid,
      title: view.area.title,
      shown: shownActive,
      total: activeTotal,
      limit: limits.project,
    });
  }
  const active = limits.area === null ? view.active : view.active.slice(0, limits.area);
  if (view.active.length > 0) {
    if (active.length < view.active.length) truncated = true;
    blocks.push({
      kind: "area",
      ref: view.area.uuid,
      title: view.area.title,
      shown: active.length,
      total: view.active.length,
      limit: limits.area,
    });
  }
  return { data: { ...view, projects, active }, grouped: { truncated, blocks } };
}
