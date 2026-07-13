/**
 * Loose reference classification for `things show` / the `open` commands:
 * anything a user might copy — a full uuid, a >=6-char uuid prefix, a
 * things:/// share link, or a unique area/project name — resolves to the
 * resource class that has a show view (an area wins over a same-named
 * project). Headings resolve to their CONTAINING PROJECT (they have no view
 * of their own); tags and checklist items are rejected (no show view; their
 * uuids simply never match TMTask/TMArea).
 */
import type { DatabaseSync } from "node:sqlite";

import {
  resolveAreaUuid,
  resolveProjectUuid,
  resolveTaskUuidPrefix,
  stripThingsUri,
} from "./queries.ts";

export interface ShowTarget {
  kind: "to-do" | "project" | "area";
  uuid: string;
  /** True when the ref was a HEADING resolved to its project — strict noun commands reject these. */
  viaHeading?: boolean;
}

export function classifyShowTarget(db: DatabaseSync, ref: string): ShowTarget {
  const stripped = stripThingsUri(ref);
  try {
    const uuid = resolveTaskUuidPrefix(db, stripped);
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
    return { kind: "area", uuid: resolveAreaUuid(db, stripped) };
  } catch {
    // fall through to project-name resolution
  }
  try {
    return { kind: "project", uuid: resolveProjectUuid(db, stripped) };
  } catch (err) {
    // An ambiguous project name lists its candidates — surface that verbatim.
    if (err instanceof RangeError && err.message.includes("ambiguous")) throw err;
    throw new RangeError(
      `no to-do, project, or area matches "${ref}" (tags and checklist items have no show view)`,
    );
  }
}
