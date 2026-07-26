/**
 * The `--area` view filter: a pure POST-FILTER applied to an already-computed
 * list view, restricting it to one area. It NEVER changes a view's membership
 * or ordering logic — it runs after the view is shaped and BEFORE any row cap /
 * truncation, so `--limit` (and the grouped per-block caps) size the filtered
 * result, not the raw one.
 *
 * KEEP RULE (transitive): a row survives when its EFFECTIVE area is the target —
 * its own `area`, or (for a to-do nested in a project, directly or via a
 * heading) its containing project's area. Project rows survive when the
 * project's own area is the target. Everything else is dropped: other areas,
 * area-less loose items, area-less projects and their children, and Inbox rows.
 * The entity's `area` Ref already IS this effective area (queries.ts
 * EFFECTIVE_AREA, surfaced by mappers.ts), so the rule is a single comparison.
 *
 * The filtering lives here in the library layer, not in the CLI/MCP consumers:
 * both surfaces enable it by passing an `area` ref, and the client applies it
 * uniformly across every shaped view (flat lists, the Today split, and the
 * grouped sidebar catalogues).
 */
import type { DatabaseSync } from "node:sqlite";

import type { IsoDate } from "../model/dates.ts";
import { resolveAreaUuid } from "./queries.ts";
import type { ListItem, SidebarSection, TodayView } from "./views.ts";

/**
 * The resolved target of an `area` filter — the area's uuid and title. Surfaced
 * as the additive `meta.filter.area` annotation so a consumer knows exactly
 * which area the returned rows were scoped to.
 */
export interface AreaFilterTarget {
  uuid: string;
  title: string;
}

/** The additive `meta.filter` annotation, emitted only when a filter is active. */
export interface ViewFilterMeta {
  area: AreaFilterTarget;
}

/** A per-read `area` scope accepted by the flat/grouped/Today view reads. */
export interface AreaScopedRead {
  /**
   * Restrict the computed view to one area (uuid or unique name): its direct
   * items and its projects' children (heading-nested included). Unresolvable
   * or ambiguous references throw {@link ReferenceResolutionError}, exactly like
   * every other ref argument.
   */
  area?: string;
}

/**
 * Resolve an area ref (uuid or unique name) to its uuid + title via the SAME
 * resolver the `things areas <ref>` view command uses, then read the title for
 * the {@link ViewFilterMeta} annotation. Throws on an unresolvable/ambiguous
 * ref, carrying the standard machine-readable candidate shape.
 */
export function resolveAreaFilter(db: DatabaseSync, ref: string): AreaFilterTarget {
  const uuid = resolveAreaUuid(db, ref);
  const row = db.prepare("SELECT title FROM TMArea WHERE uuid = ?").get(uuid) as
    | { title: string | null }
    | undefined;
  return { uuid, title: row?.title ?? "" };
}

/** The transitive keep-rule: the row's effective area is the target. */
export function itemInArea(item: ListItem, areaUuid: string): boolean {
  return item.area?.uuid === areaUuid;
}

/** Filter a flat view (upcoming) to the target area. */
export function filterListByArea<T extends ListItem>(items: T[], areaUuid: string): T[] {
  return items.filter((i) => itemInArea(i, areaUuid));
}

/**
 * Filter the grouped sidebar catalogue (anytime/someday) to the target area:
 * each section's items are filtered by the keep-rule and empty sections drop.
 * A section is already grouped by effective area, so at most one survives — but
 * the per-item pass keeps the rule identical to the flat/Today paths.
 */
export function filterSectionsByArea(
  sections: SidebarSection[],
  areaUuid: string,
): SidebarSection[] {
  return sections
    .map((s) => ({ area: s.area, items: s.items.filter((i) => itemInArea(i, areaUuid)) }))
    .filter((s) => s.items.length > 0);
}

/**
 * Filter the Today split to the target area. The badge is recomputed over the
 * surviving OPEN members so it reflects exactly the rows the view now returns —
 * the same treatment {@link todayView} gives its `eveningOnly` filter — never a
 * count that includes dropped rows.
 */
export function filterTodayByArea(view: TodayView, areaUuid: string, todayIso: IsoDate): TodayView {
  const today = view.today.filter((i) => itemInArea(i, areaUuid));
  const evening = view.evening.filter((i) => itemInArea(i, areaUuid));
  const open = [...today, ...evening].filter((i) => i.status === "open");
  const dueOrOverdue = open.filter((i) => i.deadline !== null && i.deadline <= todayIso).length;
  return { today, evening, badge: { dueOrOverdue, other: open.length - dueOrOverdue } };
}
