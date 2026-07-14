/**
 * Sidebar-order arrangement for the grouped views (anytime/someday). Takes an
 * already-materialized flat list and reproduces the UI's sidebar layout:
 * the area-less block first, then each area by its sidebar index; inside a
 * block, direct to-dos first, then each project followed by its members.
 *
 * Type-only imports from views.ts (ListItem, SidebarSection) are erased at
 * runtime, so the sole runtime edge is views.ts → sidebar-order.ts.
 */
import type { DatabaseSync } from "node:sqlite";

import type { ListItem, SidebarSection } from "./views.ts";

/** `?, ?, …` SQL placeholder list of length n. */
const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Arranges view members into the UI's flat sidebar-mirroring order: the
 * area-less block first (direct to-dos, then each top-level project followed
 * by its members), then each area by its sidebar index (direct to-dos, then
 * its projects). Project and area order here mirrors the sidebar exactly —
 * both read the same "index" columns.
 */
export function groupBySidebar(db: DatabaseSync, items: ListItem[]): SidebarSection[] {
  if (items.length === 0) return [];

  // Headed children: resolve heading -> project.
  const headingUuids = [
    ...new Set(
      items.flatMap((i) => (i.type === "to-do" && i.heading !== null ? [i.heading.uuid] : [])),
    ),
  ];
  const headingProject = new Map<string, string | null>();
  if (headingUuids.length > 0) {
    for (const row of db
      .prepare(`SELECT uuid, project FROM TMTask WHERE uuid IN (${inList(headingUuids.length)})`)
      .all(...headingUuids) as Array<{ uuid: string; project: string | null }>) {
      headingProject.set(row.uuid, row.project);
    }
  }
  const effProject = (i: ListItem): string | null =>
    i.type !== "to-do"
      ? null
      : (i.project?.uuid ??
        (i.heading !== null ? (headingProject.get(i.heading.uuid) ?? null) : null));

  // Sidebar rank + title for areas; index + area for every referenced project
  // (a tag-filtered list can contain a child whose project row didn't match).
  const areaRows = db
    .prepare(`SELECT uuid, title, "index" FROM TMArea ORDER BY "index" ASC, uuid ASC`)
    .all() as Array<{ uuid: string; title: string | null }>;
  const areaRank = new Map(areaRows.map((a, rank) => [a.uuid, rank]));
  const areaTitle = new Map(areaRows.map((a) => [a.uuid, a.title ?? ""]));
  const projectUuids = [
    ...new Set([
      ...items.flatMap((i) => (i.type === "project" ? [i.uuid] : [])),
      ...items.flatMap((i) => {
        const p = effProject(i);
        return p === null ? [] : [p];
      }),
    ]),
  ];
  const projectMeta = new Map<string, { index: number; area: string | null }>();
  if (projectUuids.length > 0) {
    for (const row of db
      .prepare(
        `SELECT uuid, "index", area FROM TMTask WHERE uuid IN (${inList(projectUuids.length)})`,
      )
      .all(...projectUuids) as Array<{ uuid: string; index: number | null; area: string | null }>) {
      projectMeta.set(row.uuid, { index: row.index ?? 0, area: row.area });
    }
  }

  // items arrive in SQL "index" order, so array position IS the per-container
  // rank (the internal index is no longer exposed on the entity).
  const sortKey = (i: ListItem, pos: number) => {
    const project = i.type === "project" ? i.uuid : effProject(i);
    const meta = project === null ? undefined : projectMeta.get(project);
    const area = i.area?.uuid ?? meta?.area ?? null;
    return {
      areaRank: area === null ? -1 : (areaRank.get(area) ?? areaRows.length),
      area: area ?? "",
      inProject: project === null ? 0 : 1,
      projectIndex: meta?.index ?? 0,
      project: project ?? "",
      headerFirst: i.type === "project" ? 0 : 1,
      pos,
      uuid: i.uuid,
    };
  };
  const keyed = items.map((item, pos) => ({ item, k: sortKey(item, pos) }));
  keyed.sort(
    (a, b) =>
      a.k.areaRank - b.k.areaRank ||
      a.k.area.localeCompare(b.k.area) ||
      a.k.inProject - b.k.inProject ||
      a.k.projectIndex - b.k.projectIndex ||
      a.k.project.localeCompare(b.k.project) ||
      a.k.headerFirst - b.k.headerFirst ||
      a.k.pos - b.k.pos ||
      a.k.uuid.localeCompare(b.k.uuid),
  );

  const sections: SidebarSection[] = [];
  for (const { item, k } of keyed) {
    const areaUuid = k.area === "" ? null : k.area;
    const last = sections.at(-1);
    if (last === undefined || (last.area?.uuid ?? null) !== areaUuid) {
      sections.push({
        area: areaUuid === null ? null : { uuid: areaUuid, title: areaTitle.get(areaUuid) ?? "" },
        items: [],
      });
    }
    sections.at(-1)?.items.push(item);
  }
  return sections;
}
