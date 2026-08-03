/**
 * Container-scoped sandbox — the ONE membership relation, shared by reads,
 * writes, and reference resolution. Generalizes the `--area` post-filter
 * (`area-filter.ts`) from "one area" to "one container" (an area OR a project),
 * and adds the leak-critical SQL fragments the single-row / candidate paths and
 * the write ancestry check share so an out-of-scope item is indistinguishable
 * from a nonexistent one (the no-oracle guarantee — see
 * docs/design/container-scope.md).
 *
 * A scope is resolved ONCE at `openThings()` and pinned for the client's life
 * (never re-resolved per call — a deleted container becomes a safe empty jail,
 * a recreated same-named one never silently re-binds). Every read reaches the
 * consumer through `client.read.*` and every write through `runMutation`, so the
 * two forms below (the entity predicate `inScopeItem` and the SQL fragments) are
 * the only two places the relation is expressed.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AnyTask } from "../model/entities.ts";
import {
  EFFECTIVE_AREA,
  ReferenceResolutionError,
  resolveAreaUuid,
  resolveProjectUuid,
} from "./queries.ts";
import type { ListItem, SidebarSection, TodayView } from "./views.ts";
import type { IsoDate } from "../model/dates.ts";

/** Where a scope declaration came from — surfaced as `meta.scope.source`. */
export type ScopeSource = "flag" | "env" | "config";

/**
 * A resolved container scope: pinned at open, carried on the client. `kind`
 * distinguishes an area jail from a project jail; `uuid`/`title` name the
 * container; `areaUuid` is the containing area (the scope area itself for an
 * area scope; the project's own area — or null for an area-less project — for a
 * project scope), used to scope the `areas` view and area-ref resolution.
 */
export interface ResolvedScope {
  kind: "area" | "project";
  uuid: string;
  title: string;
  source: ScopeSource;
  /** The relevant area context (area scope: itself; project scope: the project's area, null if area-less). */
  areaUuid: string | null;
}

/** The `meta.scope` wire shape (a subset of {@link ResolvedScope}). */
export interface ScopeMeta {
  kind: "area" | "project";
  uuid: string;
  title: string;
  source: ScopeSource;
}

/**
 * Fail-closed if a requested scope is unresolvable — `things mcp --scope <bogus>`
 * refuses to start, a CLI invocation errors as usage — so the daemon never runs
 * unscoped when a scope was asked for. A subclass of {@link ReferenceResolutionError}
 * so existing usage-class handlers treat it uniformly.
 */
export class ScopeResolutionError extends ReferenceResolutionError {
  constructor(message: string, ref: string) {
    super(message, { code: "not-found", ref });
    this.name = "ScopeResolutionError";
  }
}

/**
 * Resolve a scope ref (uuid, uuid-prefix, or unique area/project name) to a
 * pinned {@link ResolvedScope}. Areas win over same-named projects (mirroring
 * `classifyShowTarget`). A to-do / heading / tag ref is a usage error — only an
 * area or a project can be a container. Fail-closed: an unresolvable ref throws
 * {@link ScopeResolutionError}.
 */
export function resolveScope(db: DatabaseSync, ref: string, source: ScopeSource): ResolvedScope {
  // Area first (an area outranks a same-named project, like the show router).
  try {
    const uuid = resolveAreaUuid(db, ref, { prefixTier: false });
    const row = db.prepare("SELECT title FROM TMArea WHERE uuid = ?").get(uuid) as
      | { title: string | null }
      | undefined;
    return { kind: "area", uuid, title: row?.title ?? "", source, areaUuid: uuid };
  } catch (err) {
    // An ambiguous area name is a real conflict — surface it. A plain not-found
    // falls through to project resolution.
    if (err instanceof RangeError && err.message.includes("matches")) {
      throw new ScopeResolutionError(`scope "${ref}" is ambiguous — ${err.message}`, ref);
    }
  }
  try {
    const uuid = resolveProjectUuid(db, ref, { prefixTier: false });
    const row = db.prepare("SELECT title, area FROM TMTask WHERE uuid = ?").get(uuid) as
      | { title: string | null; area: string | null }
      | undefined;
    return {
      kind: "project",
      uuid,
      title: row?.title ?? "",
      source,
      areaUuid: row?.area ?? null,
    };
  } catch (err) {
    if (err instanceof RangeError && err.message.includes("matches")) {
      throw new ScopeResolutionError(`scope "${ref}" is ambiguous — ${err.message}`, ref);
    }
  }
  throw new ScopeResolutionError(
    `scope "${ref}" matches no area or project — a scope must name a container (only areas and ` +
      "projects can be a container; to-dos, headings, and tags cannot)",
    ref,
  );
}

/** The `meta.scope` projection of a resolved scope (drops the internal `areaUuid`). */
export function scopeMeta(scope: ResolvedScope): ScopeMeta {
  return { kind: scope.kind, uuid: scope.uuid, title: scope.title, source: scope.source };
}

/**
 * The entity-level membership predicate — the SAME relation as
 * {@link scopeMembershipSql}, for an already-shaped view row. Area scope: the
 * row's EFFECTIVE area is the scope (its `area` Ref, which queries.ts already
 * resolves transitively). Project scope: the row IS the project, is a direct
 * child, or is nested under one of the project's headings.
 */
export function inScopeItem(item: ListItem | AnyTask, scope: ResolvedScope): boolean {
  if (scope.kind === "area") {
    const area = "area" in item ? item.area : null;
    return area != null && area.uuid === scope.uuid;
  }
  const p = scope.uuid;
  if (item.uuid === p) return true;
  const project = "project" in item ? item.project : null;
  if (project != null && project.uuid === p) return true;
  const hp = "headingProject" in item ? item.headingProject : undefined;
  if (hp != null && hp.uuid === p) return true;
  return false;
}

/**
 * The SQL fragment on alias `t` — the single membership source the leak-critical
 * query paths AND the write ancestry check share. Area: the effective-area
 * COALESCE equals the scope. Project: the row is the project, its direct child,
 * or a heading-nested child.
 */
export function scopeMembershipSql(scope: ResolvedScope): { where: string; binds: string[] } {
  if (scope.kind === "area") {
    return { where: `${EFFECTIVE_AREA} = ?`, binds: [scope.uuid] };
  }
  return {
    where:
      "(t.uuid = ? OR t.project = ? OR t.heading IN " +
      "(SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))",
    binds: [scope.uuid, scope.uuid, scope.uuid],
  };
}

/** True when the given uuid is an in-scope TMTask row (single-row leak paths, write parity). */
export function isUuidInScope(db: DatabaseSync, uuid: string, scope: ResolvedScope): boolean {
  const mem = scopeMembershipSql(scope);
  const row = db
    .prepare(`SELECT 1 AS ok FROM TMTask t WHERE t.uuid = ? AND ${mem.where} LIMIT 1`)
    .get(uuid, ...mem.binds) as { ok: number } | undefined;
  return row !== undefined;
}

/**
 * The membership clause for {@link resolveTaskUuidPrefix} (alias `t`): the same
 * fragment as {@link scopeMembershipSql}, so an out-of-scope uuid resolves to
 * "not found" through the identical code path a nonexistent one does.
 */
export function taskMembershipClause(scope: ResolvedScope): { where: string; binds: string[] } {
  return scopeMembershipSql(scope);
}

/**
 * The membership clause for {@link resolveNamedRef} over TMTask projects
 * (UNqualified columns — that resolver aliases nothing). A project carries its
 * area directly (no inheritance), so area scope compares `area`; project scope
 * pins the one project uuid.
 */
export function namedProjectClause(scope: ResolvedScope): { where: string; binds: string[] } {
  if (scope.kind === "area") return { where: "area = ?", binds: [scope.uuid] };
  return { where: "uuid = ?", binds: [scope.uuid] };
}

/**
 * The membership clause for {@link resolveNamedRef} over TMArea (UNqualified).
 * Area scope: the one scope area. Project scope: the project's own area (an
 * area-less project has none, so nothing resolves — `0`).
 */
export function namedAreaClause(scope: ResolvedScope): { where: string; binds: string[] } {
  if (scope.kind === "area") return { where: "uuid = ?", binds: [scope.uuid] };
  return scope.areaUuid === null
    ? { where: "0", binds: [] }
    : { where: "uuid = ?", binds: [scope.areaUuid] };
}

/** Filter a flat view (upcoming/logbook/trash/search/changes) to in-scope rows. */
export function filterListByScope<T extends ListItem>(items: T[], scope: ResolvedScope): T[] {
  return items.filter((i) => inScopeItem(i, scope));
}

/**
 * Filter the grouped sidebar catalogue (anytime/someday) to in-scope rows: each
 * section's items are filtered and empty sections drop, so the per-block caps
 * size the survivors.
 */
export function filterSectionsByScope(
  sections: SidebarSection[],
  scope: ResolvedScope,
): SidebarSection[] {
  return sections
    .map((s) => ({ area: s.area, items: s.items.filter((i) => inScopeItem(i, scope)) }))
    .filter((s) => s.items.length > 0);
}

/**
 * Filter the today view to in-scope rows, RECOMPUTING the counts over the
 * surviving OPEN members so they never count a dropped (out-of-scope) row — the
 * same treatment `filterTodayByArea` gives the area filter.
 */
export function filterTodayByScope(
  view: TodayView,
  scope: ResolvedScope,
  todayIso: IsoDate,
): TodayView {
  const items = view.items.filter((i) => inScopeItem(i, scope));
  const open = items.filter((i) => i.status === "open");
  const dueOrOverdue = open.filter((i) => i.deadline !== null && i.deadline <= todayIso).length;
  return { items, counts: { dueOrOverdue, other: open.length - dueOrOverdue } };
}
