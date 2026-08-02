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
  deadNameMatchHint,
  readProjectNameVerdict,
  ReferenceResolutionError,
  resolveNamedRef,
  resolveTaskUuidPrefix,
  stripThingsUri,
  trashDisclosureTail,
} from "./queries.ts";
import { candidateRef, CANDIDATE_CAP } from "./shape.ts";
import { isLooseRef, LOOSE_REF } from "./pseudo-area.ts";
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
  // The reserved `loose` ref resolves to the NULL-area pseudo-area (READ only),
  // ALWAYS winning over a real area named "Loose". It lies outside any container
  // jail, so under a scope it falls through to the normal not-found (parity).
  // `uuid` carries the reserved word so `areaView` re-detects it downstream.
  if (scope === undefined && isLooseRef(stripped)) return { kind: "area", uuid: LOOSE_REF };
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
  // NAME phase — resolve across AREAS and PROJECTS (live pools). Precedence for a
  // UNIQUE winner is unchanged (uuid handled above → area → project). But when
  // the subject is AMBIGUOUS at one kind while another kind ALSO carries live
  // name matches, the refusal MERGES the live candidates across kinds: the
  // bare-shorthand's namespace spans to-dos, areas, AND projects, so it must
  // never show fewer options than the narrower namespaced command would.
  const areaRes = resolveNamedRef(db, "TMArea", "1=1", [], stripped, {
    prefixTier: false,
    ...(areaClause !== undefined && { scopeWhere: areaClause.where, scopeBinds: areaClause.binds }),
  });
  // An area that uniquely resolves wins outright (an area outranks a same-named
  // project — the documented chain).
  if (areaRes.resolved !== null) return { kind: "area", uuid: areaRes.resolved.uuid };

  const proj = readProjectNameVerdict(db, stripped, {
    prefixTier: false,
    ...(projectClause !== undefined && {
      scopeWhere: projectClause.where,
      scopeBinds: projectClause.binds,
    }),
  });
  const areaRows = areaRes.matches > 1 ? (areaRes.candidates ?? []) : [];

  // Area not ambiguous (zero live matches) → a UNIQUE project wins: a live twin,
  // or the reads-only unique-dead fallback (the render discloses a trashed one
  // via the card's own `(trashed)` marker / `stage: "trash"`).
  if (areaRows.length === 0 && proj.resolved !== null)
    return { kind: "project", uuid: proj.resolved.uuid };

  // Neither kind yields a unique winner. If ANY live candidates exist across the
  // two kinds, refuse with the merged list; a single kind reuses the per-kind
  // ambiguity copy, both kinds name the split.
  const areaN = areaRows.length;
  const projN = proj.liveRows.length;
  if (areaN + projN > 0) {
    const merged = [
      ...areaRows.map((r) => candidateRef("area", r)),
      ...proj.liveRows.map((r) => candidateRef("project", r)),
    ];
    const parts: string[] = [];
    if (areaN > 0) parts.push(`${areaN} area${areaN === 1 ? "" : "s"}`);
    if (projN > 0) parts.push(`${projN} project${projN === 1 ? "" : "s"}`);
    const capTail = merged.length > CANDIDATE_CAP ? `; first ${CANDIDATE_CAP} shown` : "";
    const disambig =
      areaN > 0 && projN > 0
        ? "use `things area show` / `things project show`, or a ref below"
        : "use the exact name or a uuid";
    throw new ReferenceResolutionError(
      `"${ref}" matches ${parts.join(" and ")}${capTail} — ${disambig}${trashDisclosureTail(proj.trashedMatches)}`,
      { code: "ambiguous", ref, candidates: merged.slice(0, CANDIDATE_CAP) },
    );
  }
  // Nothing matched by name. When only DEAD project twins matched (several — a
  // unique dead one resolves above), disclose them with the honest hint.
  throw new ReferenceResolutionError(
    `no to-do, project, or area matches "${ref}" (tags and checklist items have no show view)${deadNameMatchHint({ trashed: proj.trashedMatches })}`,
    { code: "not-found", ref },
  );
}
