/**
 * Low-level row fetchers. Every SELECT names columns exclusively from the
 * schema manifest so removed columns fail loudly (drift), never silently.
 */
import type { DatabaseSync } from "node:sqlite";

import { q, selectList } from "../db/schema.ts";
import type { Ref } from "../model/entities.ts";
import type { ChecklistRow, TaskRow } from "../model/mappers.ts";

/** Rows that repeat via a template are normal; template rows are invisible in list views. */
export const NOT_TEMPLATE = "(t.rt1_recurrenceRule IS NULL AND t.repeater IS NULL)";

/**
 * One hop of the UI-faithful tag-inheritance chain. `exists(set)` emits the
 * hop's `EXISTS (…)` predicate; passing a placeholder SET restricts the hop to
 * those tag uuids (the positive `--tag` membership), while passing `null` drops
 * the tag-set restriction to mean "carries ANY tag by this hop" (the `untagged`
 * negation). Writing each hop ONCE — restricted and unrestricted from the same
 * body — is what keeps `--tag` and `--untagged` from silently diverging on what
 * "tagged" means; the four exports below are all DERIVED from this array, so an
 * inheritance fix lands in one place.
 */
interface InheritanceClause {
  readonly exists: (set: string | null) => string;
}

/** ` AND col IN (…)` for the restricted form; empty for the tag-agnostic form. */
const tagIn = (col: string, set: string | null): string =>
  set === null ? "" : ` AND ${col} IN ${set}`;

/**
 * Clause 1 — the item's OWN direct `TMTaskTag` assignments. Named apart from the
 * rest because it is ALSO the whole story for the CONTAINER `--tag`/`--untagged`
 * projections (see {@link directTagScopeSql} / {@link directUntaggedScopeSql}).
 */
const DIRECT_TAG_CLAUSE: InheritanceClause = {
  exists: (set) =>
    `EXISTS (SELECT 1 FROM TMTaskTag tt WHERE tt.tasks = t.uuid${tagIn("tt.tags", set)})`,
};

/**
 * The full direct+inherited membership relation, heading → project → area
 * (T18/U18/A13 — the same chain inheritedTagsFor() walks), written ONCE. Clause 1
 * is the direct assignment; clauses 2–6 are the five container-inheritance hops.
 */
const INHERITANCE_CLAUSES: readonly InheritanceClause[] = [
  // 1. the item's own direct tags.
  DIRECT_TAG_CLAUSE,
  // 2. inherited from the item's PROJECT's own direct tags.
  {
    exists: (set) =>
      `EXISTS (SELECT 1 FROM TMTaskTag tt WHERE tt.tasks = t.project${tagIn("tt.tags", set)})`,
  },
  // 3. inherited from the item's AREA's tags.
  {
    exists: (set) =>
      `EXISTS (SELECT 1 FROM TMAreaTag at WHERE at.areas = t.area${tagIn("at.tags", set)})`,
  },
  // 4. inherited from the item's PROJECT's AREA's tags.
  {
    exists: (set) =>
      `EXISTS (SELECT 1 FROM TMTask p JOIN TMAreaTag at ON at.areas = p.area
             WHERE p.uuid = t.project${tagIn("at.tags", set)})`,
  },
  // 5. inherited through the item's HEADING → that heading's project's direct tags.
  {
    exists: (set) =>
      `EXISTS (SELECT 1 FROM TMTask h JOIN TMTaskTag tt ON tt.tasks = h.project
             WHERE h.uuid = t.heading${tagIn("tt.tags", set)})`,
  },
  // 6. inherited through the item's HEADING → its project → that project's AREA's tags.
  {
    exists: (set) =>
      `EXISTS (SELECT 1 FROM TMTask h JOIN TMTask p ON p.uuid = h.project
             JOIN TMAreaTag at ON at.areas = p.area WHERE h.uuid = t.heading${tagIn("at.tags", set)})`,
  },
];

/** A `(?, ?, …)` placeholder list for a tag-uuid set of the given size. */
const placeholderSet = (uuidCount: number): string =>
  `(${Array.from({ length: uuidCount }, () => "?").join(", ")})`;

/**
 * UI-faithful tag membership for list filtering: direct tag, or inherited
 * through the ancestor chain heading → project → area — the OR of every
 * {@link INHERITANCE_CLAUSES} hop. Takes a SET of tag uuids (the target plus its
 * hierarchy descendants); each hop gets the full set, so callers bind
 * `uuids.length * INHERITANCE_CLAUSES.length` values via {@link tagScopeBinds}.
 */
export function tagScopeSql(uuidCount: number): string {
  const set = placeholderSet(uuidCount);
  return `(\n  ${INHERITANCE_CLAUSES.map((c) => c.exists(set)).join("\n  OR ")}\n)`;
}

/**
 * The bind list for {@link tagScopeSql}: the uuid set repeated once per hop, in
 * clause order. Derived from the clause count so the bind multiplicity can never
 * drift from the number of hops the SQL actually emits.
 */
export function tagScopeBinds(uuids: string[]): string[] {
  return Array.from({ length: INHERITANCE_CLAUSES.length }, () => uuids).flat();
}

/**
 * The DIRECT-ONLY projection of {@link tagScopeSql}: {@link DIRECT_TAG_CLAUSE}
 * alone — the item's own `TMTaskTag` assignments — WITHOUT the five container-
 * inheritance hops (project/area/heading). This is the SQL behind the CONTAINER
 * `--tag` (the `project show` / `area show` / `projects` list views): every
 * child inherits its container's tags, so the inheritance-inclusive relation is
 * vacuous there — matching a DIRECT assignment is the useful, GUI-faithful
 * behavior. It keeps tag-hierarchy descendant expansion (the uuid SET is still
 * the tag plus its descendants, OR-matched) but drops container inheritance, so
 * an item matches only when it is DIRECTLY tagged. Takes the uuid set once, so
 * callers bind `uuids` exactly one time (not `× 6`).
 */
export function directTagScopeSql(uuidCount: number): string {
  return DIRECT_TAG_CLAUSE.exists(placeholderSet(uuidCount));
}

/**
 * The negation of tag membership — the SQL behind the `untagged` filter (the
 * GUI's "No Tag"). It negates the SAME {@link INHERITANCE_CLAUSES} relation with
 * the tag-set restriction dropped: "carries ANY tag by any hop", wrapped in NOT.
 * An item is untagged iff NO possible `--tag X` could ever match it — so this
 * negates the whole membership relation, not merely the row's own direct
 * assignments. Takes no binds.
 */
export function untaggedScopeSql(): string {
  return `NOT (\n  ${INHERITANCE_CLAUSES.map((c) => c.exists(null)).join("\n  OR ")}\n)`;
}

/**
 * The DIRECT-ONLY counterpart of {@link untaggedScopeSql} — the SQL behind the
 * CONTAINER `--untagged` (the GUI's in-context "No Tag" inside a project/area
 * card). It negates only {@link DIRECT_TAG_CLAUSE} (the item's OWN direct
 * assignments), leaving container inheritance untouched: an item qualifies when
 * it carries no DIRECT tag, even if it inherits one from its project/area/
 * heading. Every child inherits the container's tags, so the whole-relation
 * {@link untaggedScopeSql} would exclude every row there — direct-only is the
 * useful negation. Takes no binds.
 */
export function directUntaggedScopeSql(): string {
  return `NOT ${DIRECT_TAG_CLAUSE.exists(null)}`;
}

/**
 * A tag plus every hierarchy descendant. Filtering by a parent tag matches
 * child-tagged items — DOCUMENTED app behavior (the UI's tag filter works
 * this way), not lab-oracled: the UI's filter clicks aren't automatable.
 * UNION (not UNION ALL): dedupes, so a parent cycle in TMTag data can't
 * recurse forever.
 */
export function tagWithDescendants(db: DatabaseSync, uuid: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE d(uuid) AS (
         SELECT ? UNION
         SELECT tg.uuid FROM TMTag tg JOIN d ON tg.parent = d.uuid
       ) SELECT uuid FROM d`,
    )
    .all(uuid) as { uuid: string }[];
  return rows.map((r) => r.uuid);
}

/** Resolve a tag reference (uuid or unique case-insensitive title) — loud on miss. */
/**
 * Resolve a full TMTask uuid from a uuid OR a unique prefix (>= 6 chars).
 * Exact matches win outright (a 21-char uuid can prefix a 22-char one);
 * otherwise an indexed range scan finds prefix matches — zero throws
 * not-found, several throw with the candidates listed. Uuid params across
 * the CLI/MCP/library accept prefixes through this.
 */
/**
 * Accept a Things share link wherever a uuid/ref is expected: the app's
 * right-click → Share → Copy Link yields `things:///show?id=<uuid>`. Strip
 * the URI to its `id` (or `query`) parameter so it pastes directly; non-URI
 * input passes through untouched (after trimming).
 */
export function stripThingsUri(ref: string): string {
  const s = ref.trim();
  if (!/^things:/i.test(s)) return s;
  const m = /[?&](?:id|query)=([^&]+)/i.exec(s);
  if (m?.[1] !== undefined) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return s;
}

/**
 * The single source for uuid-miss not-found copy. Reused by the read-side
 * resolvers, the write guards, and the MCP item lookups so a uuid/partial-uuid
 * that matches nothing reads identically wherever the miss is reported.
 */
export function noUuidMatch(entity: string, ref: string): string {
  return `no ${entity} matching uuid or partial-uuid "${ref}"`;
}

/** A disambiguation candidate for a reference-resolution failure. */
export interface RefCandidate {
  uuid: string;
  title: string;
  /** Optional context that distinguishes same-named candidates (area for a project, parent path for a tag). */
  context?: string;
}

/**
 * A reference (uuid / partial-uuid / name) that did not resolve to exactly one
 * entity. Extends RangeError so every existing `instanceof RangeError` handler
 * keeps treating it as a usage-class failure — but the surfaces that know about
 * it (CLI --json envelope, MCP tool result) additionally lift the structured
 * `candidates` onto `error.details.candidates` so an agent can self-correct
 * without re-parsing the prose message. `code` mirrors the envelope error code.
 */
export class ReferenceResolutionError extends RangeError {
  readonly code: "not-found" | "ambiguous";
  readonly ref: string;
  readonly candidates: RefCandidate[];
  constructor(
    message: string,
    opts: { code: "not-found" | "ambiguous"; ref: string; candidates?: RefCandidate[] },
  ) {
    super(message);
    this.name = "ReferenceResolutionError";
    this.code = opts.code;
    this.ref = opts.ref;
    this.candidates = opts.candidates ?? [];
  }
}

export function resolveTaskUuidPrefix(db: DatabaseSync, refRaw: string, entity = "to-do"): string {
  const ref = stripThingsUri(refRaw);
  const exact = db.prepare("SELECT uuid FROM TMTask WHERE uuid = ?").get(ref) as
    | { uuid: string }
    | undefined;
  if (exact !== undefined) return exact.uuid;
  if (ref.length < 6) {
    throw new RangeError(
      `${noUuidMatch(entity, ref)} (a partial-uuid needs at least 6 characters)`,
    );
  }
  const upper = ref.slice(0, -1) + String.fromCharCode(ref.charCodeAt(ref.length - 1) + 1);
  const rows = db
    .prepare("SELECT t.uuid, t.title FROM TMTask t WHERE t.uuid >= ? AND t.uuid < ? LIMIT 6")
    .all(ref, upper) as { uuid: string; title: string | null }[];
  if (rows.length === 0) {
    throw new ReferenceResolutionError(noUuidMatch(entity, ref), { code: "not-found", ref });
  }
  if (rows.length > 1) {
    const list = rows.map((r) => `${r.uuid} (${r.title ?? ""})`).join("; ");
    throw new ReferenceResolutionError(`partial-uuid "${ref}" is ambiguous — matches: ${list}`, {
      code: "ambiguous",
      ref,
      candidates: rows.map((r) => ({ uuid: r.uuid, title: r.title ?? "" })),
    });
  }
  return rows[0]?.uuid ?? ref;
}

/**
 * Fold a name to its match key: NFC + case-fold + strip all whitespace and
 * dashes/hyphens (ASCII hyphen, the U+2010–2015 dash block, U+2212 minus).
 * Nothing else is removed, so emoji/symbols stay significant — see
 * docs/design/reference-resolution.md.
 */
export function normalizeNameKey(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s‐-―−-]+/gu, "");
}

const BASE62 = /^[0-9A-Za-z]+$/;

export interface NamedResolution {
  resolved: { uuid: string; title: string } | null;
  /** 0 = not found, 1 = ok, >1 = ambiguous at the deciding tier. */
  matches: number;
  /**
   * The rows at the deciding tier when it was ambiguous (matches > 1) — the
   * candidates a fail-closed resolver lists so the caller can disambiguate by
   * uuid. Absent when resolved or not-found.
   */
  candidates?: { uuid: string; title: string }[];
}

/**
 * Tiered reference resolution (docs/design/reference-resolution.md): exact
 * uuid → exact title → case-insensitive title → normalized title → uuid
 * prefix. The FIRST tier with exactly one match wins; a tier with several is
 * ambiguous; no tier is not-found. Shared by the read-side `resolve*Uuid`
 * throwers and the write-side `resolve*` (ContainerResolution) helpers.
 */
export function resolveNamedRef(
  db: DatabaseSync,
  table: string,
  extraWhere: string,
  extraBinds: (string | number)[],
  refRaw: string,
  options?: { prefixTier?: boolean },
): NamedResolution {
  const ref = stripThingsUri(refRaw);
  type Row = { uuid: string; title: string };
  const sel = (cond: string, extra: (string | number)[] = []): Row[] =>
    db
      .prepare(`SELECT uuid, title FROM ${table} WHERE ${extraWhere} AND ${cond}`)
      .all(...extraBinds, ...extra) as unknown as Row[];

  const byId = sel("uuid = ?", [ref]);
  if (byId.length === 1) return { resolved: byId[0] ?? null, matches: 1 };

  for (const cond of ["title = ?", "title = ? COLLATE NOCASE"]) {
    const rows = sel(cond, [ref]);
    if (rows.length === 1) return { resolved: rows[0] ?? null, matches: 1 };
    if (rows.length > 1) return { resolved: null, matches: rows.length, candidates: rows };
  }

  const key = normalizeNameKey(ref);
  if (key !== "") {
    const hits = sel("title IS NOT NULL").filter((r) => normalizeNameKey(r.title) === key);
    if (hits.length === 1) return { resolved: hits[0] ?? null, matches: 1 };
    if (hits.length > 1) return { resolved: null, matches: hits.length, candidates: hits };
  }

  // The uuid-prefix tier is suppressed on the sugar routing path (bare-noun /
  // loose-show): there, a NAME subject resolves through exact/case/normalized
  // only, and the did-you-mean substring fallback supersedes prefix guessing.
  // Typed commands keep the historical tier.
  if (options?.prefixTier !== false && ref.length >= 6 && BASE62.test(ref)) {
    const upper = ref.slice(0, -1) + String.fromCharCode(ref.charCodeAt(ref.length - 1) + 1);
    const rows = sel("uuid >= ? AND uuid < ?", [ref, upper]);
    if (rows.length === 1) return { resolved: rows[0] ?? null, matches: 1 };
    if (rows.length > 1) return { resolved: null, matches: rows.length, candidates: rows };
  }

  return { resolved: null, matches: 0 };
}

/** The accepted-forms clause for a name-accepting resolver's not-found copy. */
function acceptedForms(prefixTier: boolean): string {
  return prefixTier ? "tried uuid, partial-uuid, and name" : "tried uuid and name";
}

function resolveUuidOrThrow(
  db: DatabaseSync,
  table: string,
  extraWhere: string,
  ref: string,
  kind: string,
  listCmd: string,
  options?: { prefixTier?: boolean },
): string {
  const r = resolveNamedRef(db, table, extraWhere, [], ref, options);
  if (r.resolved !== null) return r.resolved.uuid;
  if (r.matches === 0) {
    throw new ReferenceResolutionError(
      `no ${kind} matching "${ref}" — ${acceptedForms(options?.prefixTier !== false)} (list ${kind}s with \`${listCmd}\`)`,
      { code: "not-found", ref },
    );
  }
  throw new ReferenceResolutionError(
    `"${ref}" matches ${r.matches} ${kind}s — use the exact name or a uuid`,
    {
      code: "ambiguous",
      ref,
      candidates: (r.candidates ?? []).map((c) => ({ uuid: c.uuid, title: c.title })),
    },
  );
}

/**
 * Resolve a PROJECT write target from a uuid, partial-uuid, or unique name.
 * Project write verbs (`things project update <ref>`, etc.) accept names
 * through this; to-do and heading write targets stay uuid-only.
 *
 * A uuid / unique uuid-prefix resolves FIRST over every task (reusing
 * {@link resolveTaskUuidPrefix}), so a wrong-TYPE id — a to-do uuid handed to a
 * project verb — passes through to the op's own guard, which reports it with a
 * targeted "that is a to-do, not a project" message rather than a misleading
 * not-found. Otherwise the ref resolves as a project NAME through the SAME
 * tiered {@link resolveNamedRef} matching the read side uses (shared core, not
 * a fork) across projects (trashed included, for `project restore`), fail-
 * closed with a candidate listing on an ambiguous name so a duplicated project
 * title is disambiguated by uuid rather than guessed.
 */
export function resolveProjectWriteTarget(db: DatabaseSync, refRaw: string): string {
  const ref = stripThingsUri(refRaw);
  try {
    return resolveTaskUuidPrefix(db, ref, "project");
  } catch (err) {
    // An ambiguous uuid-prefix is a real conflict — surface it verbatim. A
    // plain not-found (or too-short) ref is not a uuid: fall to the name tiers.
    if (err instanceof RangeError && err.message.includes("ambiguous")) throw err;
  }
  const r = resolveNamedRef(db, "TMTask", "type = 1", [], ref, { prefixTier: false });
  if (r.resolved !== null) return r.resolved.uuid;
  if (r.matches === 0) {
    throw new ReferenceResolutionError(
      `no project matching "${ref}" — tried uuid, partial-uuid, and name (list projects with \`things projects\`)`,
      { code: "not-found", ref },
    );
  }
  const candidates = describeProjectCandidates(db, r.candidates ?? []);
  const lines = candidates
    .map(
      (c) =>
        `  ${c.uuid.slice(0, 8)} — ${c.title}${c.context !== undefined ? ` (in ${c.context})` : ""}`,
    )
    .join("\n");
  throw new ReferenceResolutionError(
    `"${ref}" matches ${r.matches} projects — disambiguate with a uuid or partial-uuid:\n${lines}`,
    { code: "ambiguous", ref, candidates },
  );
}

/** Short-uuid + area-context candidates for an ambiguous project name. */
function describeProjectCandidates(
  db: DatabaseSync,
  candidates: { uuid: string; title: string }[],
): RefCandidate[] {
  const areaStmt = db.prepare(
    "SELECT a.title AS title FROM TMTask p LEFT JOIN TMArea a ON a.uuid = p.area WHERE p.uuid = ?",
  );
  return candidates.map((c) => {
    const area = (areaStmt.get(c.uuid) as { title: string | null } | undefined)?.title ?? null;
    return { uuid: c.uuid, title: c.title, ...(area !== null && { context: area }) };
  });
}

export function resolveTagUuid(db: DatabaseSync, ref: string): string {
  return resolveUuidOrThrow(db, "TMTag", "1=1", ref, "tag", "things tags");
}

/**
 * Write destinations stay strict (a trashed project is not a valid target);
 * READ surfaces pass `trashed: true` so a project in the Trash can still be
 * viewed — its would-be-recovered children are only visible there.
 */
export function resolveProjectUuid(
  db: DatabaseSync,
  ref: string,
  options?: { trashed?: boolean; prefixTier?: boolean },
): string {
  return resolveUuidOrThrow(
    db,
    "TMTask",
    options?.trashed === true ? "type = 1" : "type = 1 AND trashed = 0",
    ref,
    "project",
    "things projects",
    options,
  );
}

export function resolveAreaUuid(
  db: DatabaseSync,
  ref: string,
  options?: { prefixTier?: boolean },
): string {
  return resolveUuidOrThrow(db, "TMArea", "1=1", ref, "area", "things areas", options);
}

/**
 * A row's EFFECTIVE area: its own `area` link, else the area of its project,
 * else the area of its heading's project. To-dos nested in a project (or under a
 * heading) carry `area = NULL` in the DB — the area lives on the container — so
 * this resolves the nearest area walking the SAME chain the tag-inheritance SQL
 * uses (t.area → t.project's area → t.heading's project's area). Projects carry
 * their area directly (project/heading are NULL), so COALESCE returns `t.area`
 * unchanged for them — areas are not inherited. Surfaced as the entity's `area`
 * Ref (mappers.ts); whether it is direct vs effective stays derivable from
 * whether `project`/`heading` is set. Emitted as the extra `effectiveArea`
 * column so the raw `t.area` (which tag inheritance and the write layer read)
 * stays available.
 */
export const EFFECTIVE_AREA = `COALESCE(
  t.area,
  (SELECT p.area FROM TMTask p WHERE p.uuid = t.project),
  (SELECT hp.area FROM TMTask h JOIN TMTask hp ON hp.uuid = h.project WHERE h.uuid = t.heading)
)`;

export function fetchTaskRows(db: DatabaseSync, where: string, params: unknown[] = []): TaskRow[] {
  const sql = `SELECT ${selectList("TMTask")
    .split(", ")
    .map((c) => `t.${c}`)
    .join(", ")}, ${EFFECTIVE_AREA} AS effectiveArea FROM TMTask t WHERE ${where}`;
  return db.prepare(sql).all(...(params as never[])) as unknown as TaskRow[];
}

export function fetchTaskByUuid(db: DatabaseSync, uuid: string): TaskRow | null {
  const rows = fetchTaskRows(db, "t.uuid = ?", [uuid]);
  return rows[0] ?? null;
}

export function fetchChecklistRows(db: DatabaseSync, taskUuid: string): ChecklistRow[] {
  const sql = `SELECT ${selectList("TMChecklistItem")} FROM TMChecklistItem WHERE task = ? ORDER BY ${q("index")} ASC`;
  return db.prepare(sql).all(taskUuid) as unknown as ChecklistRow[];
}

/**
 * Direct tags for a set of tasks, in one query. Returns uuid -> Ref[] in the
 * app's CANONICAL tag order.
 *
 * CANONICAL ORDER (ratified 2026-07-14; tiebreak corrected 2026-07-15 by
 * TAGORD1): `TMTag."index"` (INTEGER, often negative) is the user-draggable
 * order from the app's Tags window, and the GUI renders every multi-tag pill row
 * in ascending `index`. Live oracle: the `Replace CPAP mask & air filter` to-do
 * shows `#recurring #home #housekeeping`, matching the tags' indexes, NOT their
 * alphabetical order.
 *
 * TIEBREAK = `uuid`, NOT `title` (TAGORD1 lab oracle, docs/lab/taglab-probes.md).
 * Never-dragged tags ubiquitously tie at `index = 0`; the app breaks that tie by
 * the tag's UUID (ascending ASCII), NOT alphabetically. Proven across three
 * surfaces in a VM (Tags window, a to-do's multi-tag pill row — input-order
 * independent, and the list filter-bar chips): 8 tags seeded reverse-alpha all
 * tied at 0 displayed in exact uuid order, and `ORDER BY "index", uuid`
 * reproduced the whole Tags-window order byte-for-byte where `ORDER BY "index",
 * title` diverged. TMTag has no creation-date column, so creation order is not
 * even a candidate comparator.
 *
 * NESTED-TAG CAVEAT (open question, deliberately unsolved): child tags' indexes
 * interleave globally with top-level ones — CONFIRMED by TAGORD1: `TMTag."index"`
 * is a single GLOBAL space, not per-parent (a seeded child landed at -378 among
 * root tags at 0/-35/-67). So a flat-index sort can place a child BEFORE its
 * parent in a multi-tag row. No live item carries a nested tag alongside another
 * tag, so there is no GUI oracle for the interleaved case — flat ascending
 * `index` is the ratified comparator, isolated HERE. If a GUI oracle ever
 * contradicts it, the fix is a DFS-rank swap in this one ORDER BY (rank children
 * after parents).
 */
export function fetchTagsForTasks(db: DatabaseSync, taskUuids: string[]): Map<string, Ref[]> {
  const map = new Map<string, Ref[]>();
  if (taskUuids.length === 0) return map;
  const placeholders = taskUuids.map(() => "?").join(",");
  const sql = `SELECT tt.tasks AS task, tg.uuid AS uuid, tg.title AS title
               FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid = tt.tags
               WHERE tt.tasks IN (${placeholders})
               ORDER BY tg.${q("index")}, tg.uuid`;
  const rows = db.prepare(sql).all(...taskUuids) as unknown as Array<{
    task: string;
    uuid: string;
    title: string;
  }>;
  for (const row of rows) {
    const list = map.get(row.task) ?? [];
    list.push({ uuid: row.uuid, title: row.title });
    map.set(row.task, list);
  }
  return map;
}

/**
 * Lazy heading-uuid -> owning-project Ref resolver, cached per instance.
 * Heading-nested to-dos carry project = NULL in the DB (the heading holds
 * the link); list views use this to surface the GUI's container label.
 */
export function makeHeadingProjectResolver(db: DatabaseSync): (headingUuid: string) => Ref | null {
  const cache = new Map<string, Ref | null>();
  const stmt = db.prepare(
    "SELECT p.uuid AS uuid, p.title AS title FROM TMTask h JOIN TMTask p ON p.uuid = h.project WHERE h.uuid = ?",
  );
  return (headingUuid) => {
    const cached = cache.get(headingUuid);
    if (cached !== undefined) return cached;
    const hit = stmt.get(headingUuid) as { uuid: string; title: string | null } | undefined;
    const ref = hit ? { uuid: hit.uuid, title: hit.title ?? "" } : null;
    cache.set(headingUuid, ref);
    return ref;
  };
}

/** Lazy uuid -> Ref resolver over TMTask + TMArea titles, cached per instance. */
export function makeRefResolver(db: DatabaseSync): (uuid: string | null) => Ref | null {
  const cache = new Map<string, Ref | null>();
  const taskStmt = db.prepare("SELECT uuid, title FROM TMTask WHERE uuid = ?");
  const areaStmt = db.prepare("SELECT uuid, title FROM TMArea WHERE uuid = ?");
  return (uuid) => {
    if (uuid === null) return null;
    const cached = cache.get(uuid);
    if (cached !== undefined) return cached;
    const hit = (taskStmt.get(uuid) ?? areaStmt.get(uuid)) as
      | { uuid: string; title: string | null }
      | undefined;
    const ref = hit ? { uuid: hit.uuid, title: hit.title ?? "" } : null;
    cache.set(uuid, ref);
    return ref;
  };
}
