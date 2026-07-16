/**
 * Tag-reference resolution for the tag-accepting write ops (todo.add,
 * todo.set-tags, project.set-tags, area.add, area.update).
 *
 * A tag value may be:
 *  - a TITLE (the historical form),
 *  - a UUID (resolved to its title before the name path), or
 *  - a PATH-qualified `parent/child` name.
 *
 * Precedence is LITERAL-OVER-PATH (TAGW1-d: `/` is a legal literal in a tag
 * title, `sl/ash` stored + matched literally): an exact literal title match
 * wins even when the ref contains `/`; only otherwise is the ref split on `/`
 * and resolved as a parent-child chain.
 *
 * Duplicate names are uncreatable through any app surface (TAGW1-c), so a
 * real duplicate-name pair is a Cloud-sync-only pathological state. When a ref
 * matches more than one tag the resolver REFUSES fail-closed and lists the
 * candidates (short uuid + parent-path); a uuid or a `parent/child` path is
 * the disambiguator.
 */
import type { DatabaseSync } from "node:sqlite";

import { normalizeNameKey, stripThingsUri } from "../read/queries.ts";

interface TagRow {
  uuid: string;
  title: string;
  parent: string | null;
}

export interface TagCandidate {
  uuid: string;
  title: string;
  /** Parent-path qualification, e.g. "Work/" for a child of Work; null when root. */
  parentPath: string | null;
}

export interface TagAmbiguity {
  ref: string;
  candidates: TagCandidate[];
}

export interface TagResolution {
  /**
   * Resolved leaf titles to apply, de-duplicated, in first-seen order. Only
   * COMPLETE (one per input ref) when both `missing` and `ambiguous` are empty;
   * on a refusal the guards block before these titles are used.
   */
  titles: string[];
  /** Refs that resolved to nothing (unknown tags). */
  missing: string[];
  /** Refs that matched more than one tag (duplicate-name pathological state). */
  ambiguous: TagAmbiguity[];
}

/** One creation step for `--create-tags`: a `make new tag`, optionally nested. */
export interface TagCreationStep {
  title: string;
  /** Existing (or already-planned) parent tag title to nest under. */
  parent?: string;
}

function allTags(db: DatabaseSync): TagRow[] {
  return db.prepare("SELECT uuid, title, parent FROM TMTag").all() as unknown as TagRow[];
}

/** A ref long enough and base62 enough to be a uuid, not a plausible tag name. */
const UUID_SHAPE = /^[0-9A-Za-z]{20,}$/;

/** Dedup key for a per-parent planned title (parent title + title). */
function planKey(parentTitle: string | undefined, title: string): string {
  return `${parentTitle ?? ""}${title}`;
}

/**
 * Title-match tiers within a candidate row set: exact -> case-insensitive ->
 * normalized (dash/space-forgiving). Returns the rows of the FIRST tier that
 * matches at all (so an ambiguous exact match is not masked by a looser tier).
 */
function titleMatches(rows: TagRow[], title: string): TagRow[] {
  const exact = rows.filter((r) => r.title === title);
  if (exact.length > 0) return exact;
  const lower = title.toLowerCase();
  const ci = rows.filter((r) => r.title.toLowerCase() === lower);
  if (ci.length > 0) return ci;
  const key = normalizeNameKey(title);
  if (key === "") return [];
  return rows.filter((r) => normalizeNameKey(r.title) === key);
}

function parentPathOf(byUuid: Map<string, TagRow>, row: TagRow): string | null {
  const segs: string[] = [];
  const seen = new Set<string>();
  let cur = row.parent;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const p = byUuid.get(cur);
    if (p === undefined) break;
    segs.unshift(p.title);
    cur = p.parent;
  }
  return segs.length === 0 ? null : `${segs.join("/")}/`;
}

function toCandidate(byUuid: Map<string, TagRow>, row: TagRow): TagCandidate {
  return { uuid: row.uuid, title: row.title, parentPath: parentPathOf(byUuid, row) };
}

type OneResolution =
  | { kind: "title"; title: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: TagCandidate[] };

function resolveOne(rows: TagRow[], byUuid: Map<string, TagRow>, refRaw: string): OneResolution {
  const ref = stripThingsUri(refRaw);

  // 1. Exact uuid -> title (uuids are unique, so never ambiguous).
  const byId = rows.filter((r) => r.uuid === ref);
  if (byId.length === 1) return { kind: "title", title: (byId[0] as TagRow).title };

  // 2. Literal title (literal-over-path: this matches `sl/ash` as a whole).
  const literal = titleMatches(rows, ref);
  if (literal.length === 1) return { kind: "title", title: (literal[0] as TagRow).title };
  if (literal.length > 1) {
    return { kind: "ambiguous", candidates: literal.map((r) => toCandidate(byUuid, r)) };
  }

  // 3. Path-qualified `parent/child` - resolve the chain from the root.
  if (ref.includes("/")) {
    const segs = ref.split("/").map((s) => s.trim());
    if (segs.some((s) => s === "")) return { kind: "missing" };
    let scope = rows.filter((r) => r.parent === null);
    let leaf: TagRow | null = null;
    for (let i = 0; i < segs.length; i++) {
      const hits = titleMatches(scope, segs[i] as string);
      if (hits.length === 0) return { kind: "missing" };
      if (hits.length > 1) {
        return { kind: "ambiguous", candidates: hits.map((r) => toCandidate(byUuid, r)) };
      }
      leaf = hits[0] as TagRow;
      scope = rows.filter((r) => r.parent === (leaf as TagRow).uuid);
    }
    if (leaf !== null) return { kind: "title", title: leaf.title };
  }

  return { kind: "missing" };
}

export function resolveTagRefs(db: DatabaseSync, refs: string[]): TagResolution {
  const rows = allTags(db);
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  const titles: string[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  const ambiguous: TagAmbiguity[] = [];
  for (const ref of refs) {
    const r = resolveOne(rows, byUuid, ref);
    if (r.kind === "title") {
      if (!seen.has(r.title)) {
        seen.add(r.title);
        titles.push(r.title);
      }
    } else if (r.kind === "missing") {
      missing.push(ref);
    } else {
      ambiguous.push({ ref, candidates: r.candidates });
    }
  }
  return { titles, missing, ambiguous };
}

/**
 * Ordered `make new tag` steps to satisfy `--create-tags`: only the tags that
 * are genuinely MISSING, with mkdir-p intermediates for a `parent/child` path
 * (parents first so each child's parent resolves). A ref that already resolves
 * yields no step (idempotent - the TAGW1-c coalesce also makes re-creation a
 * no-op). A non-resolving UUID-shaped ref yields no step (a uuid names an
 * EXISTING tag; a missing one cannot be created by id).
 */
export function planTagCreation(db: DatabaseSync, refs: string[]): TagCreationStep[] {
  const rows = allTags(db);
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  const steps: TagCreationStep[] = [];
  // Titles known to exist OR already planned this call, per hierarchy level,
  // so a repeated segment across refs is planned once.
  const planned = new Set<string>();

  for (const refRaw of refs) {
    const ref = stripThingsUri(refRaw);
    if (resolveOne(rows, byUuid, ref).kind === "title") continue;
    if (UUID_SHAPE.test(ref)) continue; // a missing uuid cannot be created by id

    if (ref.includes("/")) {
      const segs = ref.split("/").map((s) => s.trim());
      if (segs.some((s) => s === "")) continue;
      let scope = rows.filter((r) => r.parent === null);
      let parentTitle: string | undefined;
      for (const seg of segs) {
        const hits = titleMatches(scope, seg);
        if (hits.length === 1) {
          const hit = hits[0] as TagRow;
          parentTitle = hit.title;
          scope = rows.filter((r) => r.parent === hit.uuid);
        } else {
          // Missing (or, defensively, ambiguous) -> plan it and descend into a
          // now-empty scope so the remaining segments are all created too.
          const k = planKey(parentTitle, seg);
          if (!planned.has(k)) {
            planned.add(k);
            steps.push(
              parentTitle === undefined ? { title: seg } : { title: seg, parent: parentTitle },
            );
          }
          parentTitle = seg;
          scope = [];
        }
      }
    } else {
      const k = planKey(undefined, ref);
      if (!planned.has(k)) {
        planned.add(k);
        steps.push({ title: ref });
      }
    }
  }
  return steps;
}

/** A short, copy-safe uuid prefix for candidate listings (7 chars). */
export function shortUuid(uuid: string): string {
  return uuid.slice(0, 7);
}

/** One-line candidate rendering for a duplicate-name refusal message. */
export function formatTagCandidates(candidates: TagCandidate[]): string {
  return candidates.map((c) => `[${shortUuid(c.uuid)}] ${c.parentPath ?? ""}${c.title}`).join(", ");
}
