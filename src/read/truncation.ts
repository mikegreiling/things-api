/**
 * Shared list-view truncation: turn a full, filtered result into the rows a
 * surface actually shows (default 50) plus the exact {@link Truncation}
 * metadata every surface reports so nothing is ever silently dropped. The
 * limit counts ITEMS in render order and truncates mid-group; grouped shapes
 * (the Today split, sidebar sections) drop the trailing groups that fall
 * entirely past the cut so no empty header survives. `limit === null` means
 * "all rows" (the caller passed --all / all: true).
 */
import type { GroupBlock, Truncation } from "../contracts.ts";
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

/**
 * Roll a grouped view's per-block counts up into the WHOLE-VIEW {@link Truncation}
 * rollup: `shown`/`total` sum every block's own rows plus its nested children,
 * `limit` is null (a grouped view's caps are per-block, not a single row cap),
 * and `truncated` is the OR across the blocks (computed by the caller). The
 * identity-bearing `blocks` are returned SEPARATELY (internal render plumbing) —
 * they never ride the wire `Truncation` (doctrine v2 PR 5: the sidecar retired;
 * each bucket's completeness rides its inline `total`, R1).
 */
function groupedTruncation(
  blocks: GroupBlock[],
  truncated: boolean,
): { truncation: Truncation; blocks: GroupBlock[] } {
  let shown = 0;
  let total = 0;
  for (const b of blocks) {
    shown += b.shown;
    total += b.total;
    for (const c of b.children ?? []) {
      shown += c.shown;
      total += c.total;
    }
  }
  return { truncation: { shown, total, limit: null, truncated }, blocks };
}

/**
 * Pre-cap sidebar-section sizes (anytime/someday global catalogues), keyed by the
 * section's area uuid (or `null` for the loose section), returned alongside the
 * per-block-capped sections so {@link src/read/shape.ts} `withSectionTotals` can
 * stamp each capped section's inline `total` (read-shape v2 R1, PR 5 — no
 * `blocks[]` sidecar). Each value is the FULL (pre-cap) count of that section's
 * flattened `items` (direct/own rows + project rows + shown-project children);
 * `total` is emitted downstream iff `items.length < total`.
 */
export type SectionTotals = ReadonlyMap<string | null, number>;

/** The area-uuid key (or `null` for the loose section) of one sidebar section. */
const sectionKey = (section: SidebarSection): string | null => section.area?.uuid ?? null;

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
 * Pre-cap Today / This-Evening bucket sizes, returned alongside a truncated
 * {@link TodayView} so a consumer can (a) render the This-Evening honesty hint
 * without a pre-cap copy of the view and (b) emit each `children` bucket's inline
 * `total` — present iff that bucket was capped (read-shape v2 R1, no sidecar
 * join). These are the FULL bucket sizes; the returned `data.today`/`data.evening`
 * are the shown (possibly sliced) rows.
 */
export interface TodayBucketTotals {
  today: number;
  evening: number;
}

/**
 * Pre-cap area-view bucket sizes, returned alongside a bounded {@link AreaView}
 * so the wire can emit each capped scope's inline `total` (read-shape v2 R1, no
 * `blocks[]` sidecar join — PR 3). `anytime` is the pre-cap count of the area's
 * direct to-dos (the `--area-limit` scope, which map onto `children.anytime`);
 * `projects` is the pre-cap count of ALL the area's project rows (the
 * `--project-limit` scope caps the ACTIVE ones in place, so a capped active-rows
 * slice makes `projects.items.length < projects.total`). The scheduled/someday
 * direct to-dos and the scheduled/someday project rows are never capped, so their
 * buckets carry no `total`.
 */
export interface AreaBucketTotals {
  /** Pre-cap count of the direct to-dos (the `children.anytime` scope). */
  anytime: number;
  /** Pre-cap count of ALL project rows (the `projects` record scope). */
  projects: number;
}

/**
 * Pre-cap global-`upcoming` day-block sizes, keyed by each block's `when` (an ISO
 * date, or `null` for the trailing resting block), returned alongside the flat
 * {@link truncateList} slice so the wire can stamp each capped day block's inline
 * `total` (read-shape v2 R1, PR 4 — no `blocks[]` sidecar). The flat row cap cuts
 * across the day-ordered stream, so at most one block is straddled (its shown rows
 * fewer than its pre-cap `total`); blocks fully past the cut never appear. The key
 * mirrors the emit-boundary {@link src/read/shape.ts} `upcomingBlockKey` and the
 * renderer's `groupDate` so the counts line up block-for-block.
 */
export type UpcomingBlockTotals = ReadonlyMap<string | null, number>;

/**
 * The pre-cap day-block key for one upcoming row: its `startDate`; else, for a
 * NON-template, its `deadline` (a deadline-forecast row); else `null` (a date-less
 * recurring template → the resting block). Identical to the emit-boundary
 * `upcomingBlockKey` — one grouping law, three call sites (wire, totals, render).
 */
const upcomingBlockKey = (i: ListItem): string | null =>
  i.startDate ?? (i.repeating.isTemplate ? null : (i.deadline ?? null));

/**
 * Count the FULL (pre-cap) upcoming stream into per-day-block totals (R1, PR 4).
 * Computed on the unbounded, in-scope, area-filtered stream BEFORE the flat row
 * cap slices it, so {@link src/read/shape.ts} `withUpcomingBlockTotals` can mark
 * the one straddled block's `total`. Resting templates aggregate under the `null`
 * key.
 */
export function upcomingBlockTotals(items: ListItem[]): UpcomingBlockTotals {
  const totals = new Map<string | null, number>();
  for (const i of items) {
    const key = upcomingBlockKey(i);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return totals;
}

/**
 * Today view: the cut runs across Today then This Evening in render order, so a
 * limit smaller than the Today block trims Evening to nothing. The library keeps
 * the internal Today/Evening grouping (the two reorder scopes); the whole-view
 * `counts` aggregate is preserved unchanged. `totals` carries the pre-cap bucket
 * sizes — the renderer keeps This Evening honest under the single global cap, and
 * the wire emits each bucket's inline `total` when it was capped.
 */
export function truncateToday(
  view: TodayView,
  limit: number | null,
): { data: TodayView; truncation: Truncation; totals: TodayBucketTotals } {
  const todayTotal = view.today.length;
  const eveningTotal = view.evening.length;
  const total = todayTotal + eveningTotal;
  const totals: TodayBucketTotals = { today: todayTotal, evening: eveningTotal };
  if (limit === null || total <= limit) {
    return { data: view, truncation: whole(total, limit), totals };
  }
  const today = view.today.slice(0, limit);
  const evening = view.evening.slice(0, Math.max(0, limit - today.length));
  const shown = today.length + evening.length;
  return {
    data: { today, evening, counts: view.counts },
    truncation: { shown, total, limit, truncated: true },
    totals,
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
): {
  data: SidebarSection[];
  truncation: Truncation;
  blocks: GroupBlock[];
  totals: SectionTotals;
} {
  const outSections: SidebarSection[] = [];
  const blocks: GroupBlock[] = [];
  const totals = new Map<string | null, number>();
  let truncated = false;
  for (const section of sections) {
    const { direct, projects } = splitSectionBlocks(section);
    const shownDirect = takeUpTo(direct, limits.area);
    if (direct.length > shownDirect.length) truncated = true;
    // Project item-lists nest inside their area/loose block.
    const children: GroupBlock[] = [];
    const items: ListItem[] = [...shownDirect];
    // The section's FULL (pre-cap) flattened size for its inline `total` (R1):
    // direct rows + every project row + all its children.
    let sectionTotal = direct.length;
    for (const { project, items: kids } of projects) {
      const shownChildren = takeUpTo(kids, limits.project);
      sectionTotal += 1 + kids.length;
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
    totals.set(sectionKey(section), sectionTotal);
    outSections.push({ area: section.area, items });
  }
  return { data: outSections, ...groupedTruncation(blocks, truncated), totals };
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
): {
  data: SidebarSection[];
  truncation: Truncation;
  blocks: GroupBlock[];
  totals: SectionTotals;
} {
  const outSections: SidebarSection[] = [];
  const blocks: GroupBlock[] = [];
  const totals = new Map<string | null, number>();
  let truncated = false;
  for (const section of sections) {
    const { own, children } = partitionSomedaySection(section);
    const shownOwn = takeUpTo(own, limits.area);
    if (own.length > shownOwn.length) truncated = true;
    // The active-project child groups nest inside this section's own block.
    const childBlocks: GroupBlock[] = [];
    const items: ListItem[] = [...shownOwn];
    // The section's FULL (pre-cap) flattened size for its inline `total` (R1):
    // the own rows plus every active-project child.
    let sectionTotal = own.length;
    for (const group of children) {
      const shown = takeUpTo(group.items, limits.project);
      sectionTotal += group.items.length;
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
    totals.set(sectionKey(section), sectionTotal);
    outSections.push({ area: section.area, items });
  }
  return { data: outSections, ...groupedTruncation(blocks, truncated), totals };
}

/**
 * Sectioned cap for the `area show` detail view: its sections are containers,
 * so there is no strict total limit — instead `limits.project` bounds the
 * ACTIVE project-ROWS section and `limits.area` the direct-to-dos section
 * (null = uncapped). The cap is render-aware: only the area's ACTIVE project
 * rows are capped, while its future-scheduled and someday project rows always
 * survive (the card renders them under its uncapped Upcoming/Someday sections),
 * so the human view derives entirely from this bounded shape. The toggled
 * later list passes through untouched (the area carries no logged/trashed
 * buckets — the logbook is `things logbook --area`, trash is `things trash`).
 * Counts ride
 * the same grouped-block shape the sidebar catalogues emit (kind "projects" =
 * the active project-rows section). `now` classifies the schedule split.
 */
export function capAreaSections(
  view: AreaView,
  limits: GroupedLimits,
  now?: Date,
  zone?: string,
): { data: AreaView; truncation: Truncation; blocks: GroupBlock[]; totals: AreaBucketTotals } {
  const todayIso = localToday(now, zone);
  // Pre-cap scope sizes for the wire's inline `total` (R1): the direct to-dos
  // (`children.anytime`) and ALL project rows (`projects` record). Captured
  // before the caps slice below.
  const totals: AreaBucketTotals = { anytime: view.active.length, projects: view.projects.length };
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
      ref: view.area?.uuid ?? null,
      title: view.area?.title ?? null,
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
      ref: view.area?.uuid ?? null,
      title: view.area?.title ?? null,
      shown: active.length,
      total: view.active.length,
      limit: limits.area,
    });
  }
  return {
    data: { ...view, projects, active },
    ...groupedTruncation(blocks, truncated),
    totals,
  };
}
