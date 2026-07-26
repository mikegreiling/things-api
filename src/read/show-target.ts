/**
 * Loose reference classification for `things show` / the `open` commands:
 * anything a user might copy — a full uuid, a >=6-char uuid prefix, a
 * things:/// share link, or a unique area/project name — resolves to the
 * resource class that has a show view (an area wins over a same-named
 * project). Headings resolve to their CONTAINING PROJECT (they have no view
 * of their own); tags and checklist items are rejected (no show view; their
 * uuids simply never match TMTask/TMArea).
 *
 * NAME resolution on this loose/sugar path is deliberately narrower than the
 * typed commands' (docs/design/cli-grammar.md): only AREAS and PROJECTS
 * resolve by name (to-do TITLES never route here — a to-do is reachable only
 * by uuid/prefix/share-link, or from the did-you-mean list), and the
 * uuid-PREFIX tier is dropped (`prefixTier: false`) so the did-you-mean
 * substring fallback supersedes prefix guessing. Task uuid prefixes still
 * resolve up front via {@link resolveTaskUuidPrefix}.
 */
import type { DatabaseSync } from "node:sqlite";

import {
  resolveAreaUuid,
  resolveProjectUuid,
  resolveTaskUuidPrefix,
  stripThingsUri,
} from "./queries.ts";
import {
  namedAreaClause,
  namedProjectClause,
  taskMembershipClause,
  type ResolvedScope,
} from "./scope.ts";

export interface ShowTarget {
  kind: "to-do" | "project" | "area";
  uuid: string;
  /** True when the ref was a HEADING resolved to its project — strict noun commands reject these. */
  viaHeading?: boolean;
}

/**
 * Classify a loose show ref. Under an active container `scope`, every tier
 * resolves scope-aware: an out-of-scope task/project/area is invisible, so it
 * falls through to the SAME "no to-do, project, or area matches" not-found a
 * nonexistent ref throws (no oracle). Under a PROJECT scope an area is never
 * showable (broader than the jail), so area resolution is suppressed.
 */
export function classifyShowTarget(
  db: DatabaseSync,
  ref: string,
  scope?: ResolvedScope,
): ShowTarget {
  const stripped = stripThingsUri(ref);
  const taskClause = scope !== undefined ? taskMembershipClause(scope) : undefined;
  const projectClause = scope !== undefined ? namedProjectClause(scope) : undefined;
  // Area scope → only the scope area; project scope → no area is showable.
  const areaClause =
    scope === undefined
      ? undefined
      : scope.kind === "area"
        ? namedAreaClause(scope)
        : { where: "0", binds: [] as (string | number)[] };
  try {
    const uuid = resolveTaskUuidPrefix(db, stripped, "to-do", taskClause);
    const row = db.prepare("SELECT type, project FROM TMTask WHERE uuid = ?").get(uuid) as {
      type: number;
      project: string | null;
    };
    if (row.type === 1) return { kind: "project", uuid };
    if (row.type === 2) {
      if (row.project === null)
        throw new RangeError(`heading ${uuid} has no containing project to show`);
      return { kind: "project", uuid: row.project, viaHeading: true };
    }
    return { kind: "to-do", uuid };
  } catch (err) {
    // An ambiguous prefix lists its candidates — surface that verbatim.
    // Plain not-found (or a too-short ref, e.g. an area name like "Home")
    // falls through to area resolution.
    if (err instanceof RangeError && err.message.includes("ambiguous")) throw err;
    if (!(err instanceof RangeError)) throw err;
  }
  try {
    return {
      kind: "area",
      uuid: resolveAreaUuid(db, stripped, {
        prefixTier: false,
        ...(areaClause !== undefined && {
          scopeWhere: areaClause.where,
          scopeBinds: areaClause.binds,
        }),
      }),
    };
  } catch {
    // fall through to project-name resolution
  }
  try {
    return {
      kind: "project",
      uuid: resolveProjectUuid(db, stripped, {
        prefixTier: false,
        ...(projectClause !== undefined && {
          scopeWhere: projectClause.where,
          scopeBinds: projectClause.binds,
        }),
      }),
    };
  } catch (err) {
    // An ambiguous project name lists its candidates — surface that verbatim.
    if (err instanceof RangeError && err.message.includes("ambiguous")) throw err;
    throw new RangeError(
      `no to-do, project, or area matches "${ref}" (tags and checklist items have no show view)`,
    );
  }
}
