/**
 * Tag-reference resolution for the tag-accepting write ops (todo.add,
 * todo.set-tags, project.set-tags, area.add, area.update).
 *
 * A tag value is a NAME — either a plain TITLE or a PATH-qualified
 * `parent/child` name. Tag uuids are a fully internal implementation detail
 * (like checklist ids) and are neither accepted here nor surfaced anywhere.
 *
 * Precedence is LITERAL-OVER-PATH (TAGW1-d: `/` is a legal literal in a tag
 * title, `sl/ash` stored + matched literally): an exact literal title match
 * wins even when the ref contains `/`; only otherwise is the ref split on `/`
 * and resolved as a parent-child chain.
 *
 * The resolver's only job is an EXISTENCE check. Tags are applied by passing
 * the NAME to the app's own write vector (`tags=Name` / `set tag names`), so
 * the APP resolves the name exactly as its GUI does — we never pick a uuid. A
 * name matching ≥1 tag is "known" (the name passes through); a name matching
 * none is reported as missing (the H-UNKNOWN-TAG guard refuses on it). A
 * duplicate-name pair (a Cloud-sync-only pathological state we delegate to the
 * app, matching the GUI) needs no special handling — both share the name.
 */
import type { DatabaseSync } from "node:sqlite";

import { normalizeNameKey, stripThingsUri } from "../read/queries.ts";

interface TagRow {
  uuid: string;
  title: string;
  parent: string | null;
}

export interface TagResolution {
  /**
   * Resolved leaf titles to apply, de-duplicated, in first-seen order. Only
   * COMPLETE (one per input ref) when `missing` is empty; on a refusal the
   * H-UNKNOWN-TAG guard blocks before these titles are used.
   */
  titles: string[];
  /** Refs that resolved to nothing (unknown tags). */
  missing: string[];
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

/** Dedup key for a per-parent planned title (parent title + title). */
function planKey(parentTitle: string | undefined, title: string): string {
  return `${parentTitle ?? ""}${title}`;
}

/**
 * Title-match tiers within a candidate row set: exact -> case-insensitive ->
 * normalized (dash/space-forgiving). Returns the rows of the FIRST tier that
 * matches at all.
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

type OneResolution = { kind: "title"; title: string } | { kind: "missing" };

function resolveOne(rows: TagRow[], refRaw: string): OneResolution {
  const ref = stripThingsUri(refRaw);

  // Literal title (literal-over-path: this matches `sl/ash` as a whole). A name
  // matching ≥1 tag is "known" — pass the NAME through; the app resolves it.
  const literal = titleMatches(rows, ref);
  if (literal.length >= 1) return { kind: "title", title: (literal[0] as TagRow).title };

  // Path-qualified `parent/child` — resolve the chain from the root. Duplicate
  // names never refuse: descend into the first match at each level.
  if (ref.includes("/")) {
    const segs = ref.split("/").map((s) => s.trim());
    if (segs.some((s) => s === "")) return { kind: "missing" };
    let scope = rows.filter((r) => r.parent === null);
    let leaf: TagRow | null = null;
    for (const seg of segs) {
      const hits = titleMatches(scope, seg);
      if (hits.length === 0) return { kind: "missing" };
      leaf = hits[0] as TagRow;
      scope = rows.filter((r) => r.parent === (leaf as TagRow).uuid);
    }
    if (leaf !== null) return { kind: "title", title: leaf.title };
  }

  return { kind: "missing" };
}

export function resolveTagRefs(db: DatabaseSync, refs: string[]): TagResolution {
  const rows = allTags(db);
  const titles: string[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const ref of refs) {
    const r = resolveOne(rows, ref);
    if (r.kind === "title") {
      if (!seen.has(r.title)) {
        seen.add(r.title);
        titles.push(r.title);
      }
    } else {
      missing.push(ref);
    }
  }
  return { titles, missing };
}

/**
 * Ordered `make new tag` steps to satisfy `--create-tags`: only the tags that
 * are genuinely MISSING, with mkdir-p intermediates for a `parent/child` path
 * (parents first so each child's parent resolves). A ref that already resolves
 * yields no step (idempotent — the TAGW1-c coalesce also makes re-creation a
 * no-op).
 */
export function planTagCreation(db: DatabaseSync, refs: string[]): TagCreationStep[] {
  const rows = allTags(db);
  const steps: TagCreationStep[] = [];
  // Titles known to exist OR already planned this call, per hierarchy level,
  // so a repeated segment across refs is planned once.
  const planned = new Set<string>();

  for (const refRaw of refs) {
    const ref = stripThingsUri(refRaw);
    if (resolveOne(rows, ref).kind === "title") continue;

    if (ref.includes("/")) {
      const segs = ref.split("/").map((s) => s.trim());
      if (segs.some((s) => s === "")) continue;
      let scope = rows.filter((r) => r.parent === null);
      let parentTitle: string | undefined;
      for (const seg of segs) {
        const hits = titleMatches(scope, seg);
        if (hits.length >= 1) {
          const hit = hits[0] as TagRow;
          parentTitle = hit.title;
          scope = rows.filter((r) => r.parent === hit.uuid);
        } else {
          // Missing -> plan it and descend into a now-empty scope so the
          // remaining segments are all created too.
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
