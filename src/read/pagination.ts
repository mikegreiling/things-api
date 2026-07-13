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
import type { Ref } from "../model/entities.ts";
import type { AreaView } from "./area-view.ts";
import type { ProjectView } from "./project-view.ts";
import { AREA_PREVIEW_LIMIT, DEFAULT_LIST_LIMIT, PROJECT_PREVIEW_LIMIT } from "../surface-copy.ts";
import type { ListItem, SidebarSection, TodayView } from "./views.ts";

export { AREA_PREVIEW_LIMIT, DEFAULT_LIST_LIMIT, PROJECT_PREVIEW_LIMIT };

/**
 * Per-block caps for the grouped catalogues: `area` bounds each area-direct
 * block (and the leading loose block), `project` each project's to-do list.
 * `null` = uncapped (the caller passed --all / all: true, or — for someday's
 * active-projects section — asked for every item).
 */
export interface GroupedLimits {
  area: number | null;
  project: number | null;
}

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
): { data: SidebarSection[]; grouped: GroupedPagination } {
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
 * Someday sections split differently from anytime: PROJECT rows there are
 * plain ITEMS (a someday project stands for itself — its children are never
 * inline), so a section's "own" block is its project rows + container-less
 * to-dos together, and the to-dos that DO carry a project reference (the
 * activeProjectItems toggle) form separate per-project child groups.
 */
export interface SomedayPartition {
  /** Project rows + direct to-dos, in section order. */
  own: ListItem[];
  /** Someday to-dos inside active projects, clustered per project. */
  children: Array<{ project: Ref; items: ListItem[] }>;
}

export function partitionSomedaySection(section: SidebarSection): SomedayPartition {
  const own: ListItem[] = [];
  const byProject = new Map<string, { project: Ref; items: ListItem[] }>();
  for (const item of section.items) {
    const container = item.type === "to-do" ? (item.project ?? item.headingProject ?? null) : null;
    if (container === null) {
      own.push(item);
      continue;
    }
    let group = byProject.get(container.uuid);
    if (group === undefined) {
      group = { project: container, items: [] };
      byProject.set(container.uuid, group);
    }
    group.items.push(item);
  }
  return { own, children: [...byProject.values()] };
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
): { data: SidebarSection[]; grouped: GroupedPagination } {
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

/** Budget-slicer over successive lists: takes up to the remaining cap. */
function makeTaker(limit: number | null): { take: <T>(rows: T[]) => T[]; shown: () => number } {
  let budget = limit;
  let count = 0;
  return {
    take<T>(rows: T[]): T[] {
      const out = budget === null ? rows : rows.slice(0, Math.max(0, budget));
      if (budget !== null) budget -= out.length;
      count += out.length;
      return out;
    },
    shown: () => count,
  };
}

/**
 * Detail-view cap for `project show`-shaped payloads: one TOTAL item-row cap
 * across every list, consumed in render order — active, heading members,
 * later (scheduled/repeating/someday), logged, trashed. Structure survives
 * the cut: heading entries keep their metadata (items sliced, possibly to
 * empty); emptied scheduled date-groups are dropped. The project card itself
 * is content, not a row — never counted.
 */
export function capProjectView(
  view: ProjectView,
  limit: number | null,
): { data: ProjectView; pagination: Pagination } {
  const total =
    view.active.length +
    view.headings.reduce((n, g) => n + g.items.length, 0) +
    view.later.scheduled.reduce((n, g) => n + g.items.length, 0) +
    view.later.repeating.length +
    view.later.someday.length +
    view.logged.length +
    view.trashed.length;
  if (limit === null || total <= limit) {
    return { data: view, pagination: { shown: total, total, limit, truncated: false } };
  }
  const { take, shown } = makeTaker(limit);
  const data: ProjectView = {
    project: view.project,
    active: take(view.active),
    headings: view.headings.map((g) => ({ heading: g.heading, items: take(g.items) })),
    later: {
      scheduled: view.later.scheduled
        .map((g) => ({ date: g.date, items: take(g.items) }))
        .filter((g) => g.items.length > 0),
      repeating: take(view.later.repeating),
      someday: take(view.later.someday),
    },
    logged: take(view.logged),
    trashed: take(view.trashed),
  };
  return { data, pagination: { shown: shown(), total, limit, truncated: true } };
}

/**
 * Detail-view cap for `area show`-shaped payloads: same total item-row cap,
 * consumed in render order — projects, direct to-dos, later, logged, trashed.
 * The area card is content, never counted.
 */
export function capAreaView(
  view: AreaView,
  limit: number | null,
): { data: AreaView; pagination: Pagination } {
  const total =
    view.projects.length +
    view.active.length +
    view.later.scheduled.reduce((n, g) => n + g.items.length, 0) +
    view.later.repeating.length +
    view.later.someday.length +
    view.logged.length +
    view.trashed.length;
  if (limit === null || total <= limit) {
    return { data: view, pagination: { shown: total, total, limit, truncated: false } };
  }
  const { take, shown } = makeTaker(limit);
  const data: AreaView = {
    area: view.area,
    projects: take(view.projects),
    active: take(view.active),
    later: {
      scheduled: view.later.scheduled
        .map((g) => ({ date: g.date, items: take(g.items) }))
        .filter((g) => g.items.length > 0),
      repeating: take(view.later.repeating),
      someday: take(view.later.someday),
    },
    logged: take(view.logged),
    trashed: take(view.trashed),
  };
  return { data, pagination: { shown: shown(), total, limit, truncated: true } };
}
