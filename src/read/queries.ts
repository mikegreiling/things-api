/**
 * Low-level row fetchers. Every SELECT names columns exclusively from the
 * schema manifest so removed columns fail loudly (drift), never silently.
 */
import type { DatabaseSync } from "node:sqlite";

import { q, selectList } from "../db/schema.ts";
import { TASK_TYPE_FROM_DB, type Ref } from "../model/entities.ts";
import type { ChecklistRow, TaskRow } from "../model/mappers.ts";
import {
  candidateRef,
  CANDIDATE_CAP,
  type CandidateRef,
  type CandidateType,
  type RefKind,
  type RefPromoter,
} from "./shape.ts";

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

/**
 * A reference (uuid / partial-uuid / name) that did not resolve to exactly one
 * entity. Extends RangeError so every existing `instanceof RangeError` handler
 * keeps treating it as a usage-class failure — but the surfaces that know about
 * it (CLI --json envelope, MCP tool result) additionally lift the structured
 * `candidates` onto `error.detail.candidates` so an agent can self-correct
 * without re-parsing the prose message. `code` mirrors the envelope error code.
 *
 * PUBLIC API — exported from src/index.ts. This is the one error the consumer
 * surfaces catch to render structured disambiguation; its `code`
 * ("not-found" | "ambiguous") and `candidates` ({@link CandidateRef}[], the ONE
 * fixed candidate shape) are the documented machine shape
 * (docs/design/architecture.md, Consumer boundary). The list is capped at
 * {@link CANDIDATE_CAP}; on overflow the `message` states the total.
 */
export class ReferenceResolutionError extends RangeError {
  readonly code: "not-found" | "ambiguous";
  readonly ref: string;
  readonly candidates: CandidateRef[];
  constructor(
    message: string,
    opts: { code: "not-found" | "ambiguous"; ref: string; candidates?: CandidateRef[] },
  ) {
    super(message);
    this.name = "ReferenceResolutionError";
    this.code = opts.code;
    this.ref = opts.ref;
    this.candidates = opts.candidates ?? [];
  }
}

/**
 * An optional membership clause (on alias `t`) restricting a resolver to
 * in-scope rows — the container-scope no-oracle mechanism. When supplied, an
 * out-of-scope row resolves to "not found" through the IDENTICAL code path a
 * nonexistent one does, so the two are byte-indistinguishable. Built by
 * `src/read/scope.ts`; queries.ts treats it as opaque SQL to avoid a runtime
 * import cycle.
 */
export interface ScopeClause {
  where: string;
  binds: (string | number)[];
}

export function resolveTaskUuidPrefix(
  db: DatabaseSync,
  refRaw: string,
  entity = "to-do",
  scope?: ScopeClause,
): string {
  const ref = stripThingsUri(refRaw);
  const scopeCond = scope !== undefined ? ` AND ${scope.where}` : "";
  const scopeBinds = scope?.binds ?? [];
  const exact = db
    .prepare(`SELECT t.uuid FROM TMTask t WHERE t.uuid = ?${scopeCond}`)
    .get(ref, ...scopeBinds) as { uuid: string } | undefined;
  if (exact !== undefined) return exact.uuid;
  if (ref.length < 6) {
    throw new RangeError(
      `${noUuidMatch(entity, ref)} (a partial-uuid needs at least 6 characters)`,
    );
  }
  const upper = ref.slice(0, -1) + String.fromCharCode(ref.charCodeAt(ref.length - 1) + 1);
  // No LIMIT: a >=6-char shared prefix makes the uuid range inherently tiny, so
  // the full match set is cheap to fetch and its length is the exact total.
  const rows = db
    .prepare(
      `SELECT t.uuid, t.title, t.type FROM TMTask t WHERE t.uuid >= ? AND t.uuid < ?${scopeCond}`,
    )
    .all(ref, upper, ...scopeBinds) as { uuid: string; title: string | null; type: number }[];
  if (rows.length === 0) {
    throw new ReferenceResolutionError(noUuidMatch(entity, ref), { code: "not-found", ref });
  }
  if (rows.length > 1) {
    const shown = rows.slice(0, CANDIDATE_CAP);
    const list = shown.map((r) => `${r.uuid} (${r.title ?? ""})`).join("; ");
    const more = rows.length > CANDIDATE_CAP ? `; … ${rows.length - CANDIDATE_CAP} more` : "";
    throw new ReferenceResolutionError(
      `partial-uuid "${ref}" is ambiguous — ${rows.length} matches: ${list}${more} — use a full uuid`,
      {
        code: "ambiguous",
        ref,
        candidates: shown.map((r) =>
          candidateRef(TASK_TYPE_FROM_DB[r.type] ?? "to-do", {
            uuid: r.uuid,
            title: r.title ?? "",
          }),
        ),
      },
    );
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

/**
 * The DECORATED-REF form `Title [ref]` — a bare title with the machine-stable
 * uuid/partial-uuid pinned in trailing brackets (the fused form every TTY
 * candidate renders, `Title [8charPrefix]`). The title half is a COMMENT
 * (ignored), so a stale copy still resolves after a rename; the bracket is the
 * ref, resolved through the uuid/partial-uuid tier. Greedy `.*` so the LAST
 * bracket wins (`"Family [Sub] [TC9yozLk]"` → `TC9yozLk`). The empty-title form
 * `" [J2kPq9Ws]"` (a titleless heading) is legal — `(.*)` matches empty. Because
 * `$`-anchored so the LAST bracket always wins. The space before `[` is OPTIONAL
 * because {@link stripThingsUri} trims the ref first, so the empty-title form
 * `" [J2kPq9Ws]"` (a titleless heading) arrives as the bare `[J2kPq9Ws]` — both
 * resolve. The bracket is 4–22 base62 chars; a segment shorter than the 6-char
 * partial-uuid floor simply fails to resolve (the FORM is recognized, the
 * resolution is the real uuid/partial-uuid tier's).
 */
const DECORATED_REF = /^(.*?) ?\[([0-9A-Za-z]{4,22})\]$/;

/** The fused TTY ref form `Title [8charPrefix]` — the round-trippable decorated ref every candidate renders. */
export const REF_PREFIX_LEN = 8;
export function fusedRef(title: string, uuid: string): string {
  return `${title} [${uuid.slice(0, REF_PREFIX_LEN)}]`;
}

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
  options?: {
    prefixTier?: boolean;
    scopeWhere?: string;
    scopeBinds?: (string | number)[];
    /**
     * An extra clause AND-ed into the NAME tiers ONLY (exact/case-insensitive/
     * normalized title) — never the uuid-exact or uuid-prefix tiers. Lets a
     * resolver narrow name resolution (e.g. project write targets to OPEN rows)
     * while a UUID / partial-uuid — explicit intent — still reaches every row.
     */
    nameExtraWhere?: string;
  },
): NamedResolution {
  const ref = stripThingsUri(refRaw);
  // Container scope: an extra UNqualified membership clause AND-ed into every
  // tier, so an out-of-scope row is invisible to resolution — the same rows a
  // nonexistent ref matches (none), keeping the not-found path byte-identical.
  const scopeCond = options?.scopeWhere !== undefined ? ` AND ${options.scopeWhere}` : "";
  const scopeBinds = options?.scopeBinds ?? [];
  // The name-tier narrowing (open-only, etc.) — carries no binds, so it never
  // shifts the placeholder order.
  const nameCond = options?.nameExtraWhere !== undefined ? ` AND ${options.nameExtraWhere}` : "";
  type Row = { uuid: string; title: string };
  const run = (where: string, cond: string, extra: (string | number)[]): Row[] =>
    db
      .prepare(
        `SELECT uuid, title FROM ${table} WHERE ${extraWhere}${where} AND ${cond}${scopeCond}`,
      )
      .all(...extraBinds, ...extra, ...scopeBinds) as unknown as Row[];
  // uuid tiers use the base predicate; name tiers additionally honor nameCond.
  const sel = (cond: string, extra: (string | number)[] = []): Row[] => run("", cond, extra);
  const selName = (cond: string, extra: (string | number)[] = []): Row[] =>
    run(nameCond, cond, extra);

  const byId = sel("uuid = ?", [ref]);
  if (byId.length === 1) return { resolved: byId[0] ?? null, matches: 1 };

  for (const cond of ["title = ?", "title = ? COLLATE NOCASE"]) {
    const rows = selName(cond, [ref]);
    if (rows.length === 1) return { resolved: rows[0] ?? null, matches: 1 };
    if (rows.length > 1) return { resolved: null, matches: rows.length, candidates: rows };
  }

  const key = normalizeNameKey(ref);
  if (key !== "") {
    const hits = selName("title IS NOT NULL").filter((r) => normalizeNameKey(r.title) === key);
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

  // The DECORATED-REF tier — LAST, after exact/case/normalized title and the
  // uuid/partial-uuid tiers all miss. `Title [ref]`: the title is ignored and the
  // bracketed segment resolves through the uuid/partial-uuid tier (uuid-exact,
  // then a >=6-char partial-uuid prefix). Runs regardless of `prefixTier` — the
  // bracket is EXPLICIT ref intent (a rendered fused ref), like a bare uuid. A
  // literal title `Title [ref]` outranks this by construction (exact-title is an
  // earlier tier). Scope/extraWhere apply (uuid-tier `sel`, not the name tiers).
  const decorated = DECORATED_REF.exec(ref);
  if (decorated !== null) {
    const inner = decorated[2] ?? "";
    const exactRows = sel("uuid = ?", [inner]);
    if (exactRows.length === 1) return { resolved: exactRows[0] ?? null, matches: 1 };
    if (inner.length >= 6) {
      const upper =
        inner.slice(0, -1) + String.fromCharCode(inner.charCodeAt(inner.length - 1) + 1);
      const rows = sel("uuid >= ? AND uuid < ?", [inner, upper]);
      if (rows.length === 1) return { resolved: rows[0] ?? null, matches: 1 };
      if (rows.length > 1) return { resolved: null, matches: rows.length, candidates: rows };
    }
  }

  return { resolved: null, matches: 0 };
}

/** The accepted-forms clause for a name-accepting resolver's not-found copy. */
function acceptedForms(prefixTier: boolean): string {
  return prefixTier ? "tried uuid, partial-uuid, and name" : "tried uuid and name";
}

/**
 * The single-kind ambiguous-name refusal copy shared by the read resolvers
 * (`"X" matches N projects — use the exact name or a uuid`). `kind` is the
 * singular noun; the plural `s` is appended here so the count agrees.
 */
function ambiguousNameMessage(ref: string, count: number, kind: string, capped: boolean): string {
  return `"${ref}" matches ${count} ${kind}s${capped ? `; first ${CANDIDATE_CAP} shown` : ""} — use the exact name or a uuid`;
}

function resolveUuidOrThrow(
  db: DatabaseSync,
  table: string,
  extraWhere: string,
  ref: string,
  kind: string,
  listCmd: string,
  options?: { prefixTier?: boolean; scopeWhere?: string; scopeBinds?: (string | number)[] },
): string {
  const r = resolveNamedRef(db, table, extraWhere, [], ref, options);
  if (r.resolved !== null) return r.resolved.uuid;
  if (r.matches === 0) {
    throw new ReferenceResolutionError(
      `no ${kind} matching "${ref}" — ${acceptedForms(options?.prefixTier !== false)} (list ${kind}s with \`${listCmd}\`)`,
      { code: "not-found", ref },
    );
  }
  const all = r.candidates ?? [];
  throw new ReferenceResolutionError(
    ambiguousNameMessage(ref, r.matches, kind, all.length > CANDIDATE_CAP),
    {
      code: "ambiguous",
      ref,
      candidates: all.slice(0, CANDIDATE_CAP).map((c) => candidateRef(kind as CandidateType, c)),
    },
  );
}

/**
 * The honest tail appended to a not-found message when a NAME resolves to ZERO
 * LIVE entities but one or more DEAD rows (trashed, or swept to the logbook) DO
 * match it. It tells the caller a dead row of that name exists — and where to
 * find it — WITHOUT listing it as a candidate, so no dangling-ref operation is
 * invited against a dead row (candidate pools stay domain-scoped to live rows).
 * Empty when nothing dead matched; a count renders only when it is > 0.
 */
// "1 item matches" / "2 items match" — noun plural on >1, verb plural on ==1.
function deadMatchPhrase(n: number, where: string, cmd: string): string {
  return `${n} ${where} item${n === 1 ? "" : "s"} match${n === 1 ? "es" : ""} this name — see \`${cmd}\``;
}

export function deadNameMatchHint(counts: {
  trashed?: number;
  logbook?: number;
  completed?: number;
}): string {
  const parts: string[] = [];
  const t = counts.trashed ?? 0;
  const l = counts.logbook ?? 0;
  const c = counts.completed ?? 0;
  if (t > 0) parts.push(deadMatchPhrase(t, "trashed", "things trash"));
  if (l > 0) parts.push(deadMatchPhrase(l, "logbook", "things logbook"));
  // A completed/canceled (but not trashed) project is excluded from write-target
  // NAME resolution — placing an open child in it strands the child (PLOG1) — but
  // stays reachable by its uuid (explicit intent), which is the guidance here.
  if (c > 0)
    parts.push(
      `${c} completed project${c === 1 ? "" : "s"} match${c === 1 ? "es" : ""} this name — target it by uuid if intended`,
    );
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
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
 * a fork).
 *
 * The NAME pool is LIVE + OPEN-scoped by default (`trashed = 0 AND status = 0`)
 * — a trashed OR completed/canceled project never resolves-by-name or appears as
 * an ambiguity candidate for an ordinary write verb. A completed project is
 * excluded deliberately (broader than "logged", which needs the log-boundary
 * clock this pure resolver lacks): placing an open child in it strands the child
 * one sweep later (PLOG1). A name that matches ONLY non-open/trashed rows fails
 * not-found with an honest hint (`things trash` / target-by-uuid) rather than a
 * dead candidate. A UUID / partial-uuid resolves FIRST (via
 * {@link resolveTaskUuidPrefix}, status-blind), so explicit-uuid intent still
 * reaches a completed/logged project. `includeNonOpen` (the `project.reopen`
 * verb — its whole point is a non-open target) widens the name pool to
 * completed/canceled rows; `includeTrashed` (the trash-domain `project.restore`
 * op) widens it to trashed rows so a restore-by-name can disambiguate them.
 * Fail-closed with a candidate listing on an ambiguous name.
 */
export function resolveProjectWriteTarget(
  db: DatabaseSync,
  refRaw: string,
  scope?: { task: ScopeClause; named: { where: string; binds: (string | number)[] } },
  includeTrashed = false,
  includeNonOpen = false,
): string {
  const ref = stripThingsUri(refRaw);
  try {
    return resolveTaskUuidPrefix(db, ref, "project", scope?.task);
  } catch (err) {
    // An ambiguous uuid-prefix is a real conflict — surface it verbatim. A
    // plain not-found (or too-short) ref is not a uuid: fall to the name tiers.
    if (err instanceof RangeError && err.message.includes("ambiguous")) throw err;
  }
  const liveWhere = includeTrashed
    ? "type = 1"
    : includeNonOpen
      ? "type = 1 AND trashed = 0"
      : "type = 1 AND trashed = 0 AND status = 0";
  const r = resolveNamedRef(db, "TMTask", liveWhere, [], ref, {
    prefixTier: false,
    ...(scope !== undefined && { scopeWhere: scope.named.where, scopeBinds: scope.named.binds }),
  });
  if (r.resolved !== null) return r.resolved.uuid;
  if (r.matches === 0) {
    // Zero live+open matches: if the name matches only trashed OR completed rows,
    // say so (honest hint) instead of dangling a dead candidate. Skipped when the
    // pool already includes those rows — a miss there is a genuine miss.
    const dead =
      includeTrashed || includeNonOpen
        ? {}
        : {
            trashed: resolveNamedRef(db, "TMTask", "type = 1 AND trashed = 1", [], ref, {
              prefixTier: false,
            }).matches,
            completed: resolveNamedRef(
              db,
              "TMTask",
              "type = 1 AND trashed = 0 AND status != 0",
              [],
              ref,
              { prefixTier: false },
            ).matches,
          };
    throw new ReferenceResolutionError(
      `no project matching "${ref}" — tried uuid, partial-uuid, and name (list projects with \`things projects\`)${deadNameMatchHint(dead)}`,
      { code: "not-found", ref },
    );
  }
  const all = describeProjectCandidates(db, r.candidates ?? []);
  const shown = all.slice(0, CANDIDATE_CAP);
  // The fused ref form `Title [8charPrefix]` — the bracketed prefix pastes back
  // as a decorated ref that resolves straight to this project.
  const lines = shown
    .map((c) => `  ${fusedRef(c.title, c.uuid)}${c.area !== undefined ? ` (in ${c.area})` : ""}`)
    .join("\n");
  const more = all.length > CANDIDATE_CAP ? `\n  … ${all.length - CANDIDATE_CAP} more` : "";
  throw new ReferenceResolutionError(
    `"${ref}" matches ${r.matches} projects — disambiguate with a ref below:\n${lines}${more}`,
    { code: "ambiguous", ref, candidates: shown },
  );
}

/** Fixed-shape candidates for an ambiguous project name, each with its area container hint. */
function describeProjectCandidates(
  db: DatabaseSync,
  candidates: { uuid: string; title: string }[],
): CandidateRef[] {
  const areaStmt = db.prepare(
    "SELECT a.title AS title FROM TMTask p LEFT JOIN TMArea a ON a.uuid = p.area WHERE p.uuid = ?",
  );
  return candidates.map((c) => {
    const area = (areaStmt.get(c.uuid) as { title: string | null } | undefined)?.title ?? null;
    return candidateRef("project", { uuid: c.uuid, title: c.title, area });
  });
}

export function resolveTagUuid(db: DatabaseSync, ref: string): string {
  return resolveUuidOrThrow(db, "TMTag", "1=1", ref, "tag", "things tags");
}

/** Options shared by the read-side project resolvers (a name-tier narrowing subset). */
interface ReadProjectOptions {
  prefixTier?: boolean;
  scopeWhere?: string;
  scopeBinds?: (string | number)[];
}

/** Count (and, when unique, resolve) a NAME against the TRASHED project pool only. */
function trashedProjectNameMatches(
  db: DatabaseSync,
  ref: string,
  options?: ReadProjectOptions,
): NamedResolution {
  return resolveNamedRef(db, "TMTask", "type = 1 AND trashed = 1", [], ref, {
    prefixTier: false,
    ...(options?.scopeWhere !== undefined && {
      scopeWhere: options.scopeWhere,
      scopeBinds: options.scopeBinds,
    }),
  });
}

/**
 * A read-side PROJECT NAME resolution verdict under the liveness law (never
 * throws) — the shared core behind the throwing {@link resolveProjectUuid}
 * (`project show`) and the cross-kind {@link classifyShowTarget} router.
 *
 * The uuid / partial-uuid tiers reach EVERY project row (explicit intent stays
 * able to view a trashed project by id); the NAME tiers resolve against LIVE
 * (untrashed) rows only, so a dead twin never shadows a live one nor inflates
 * an ambiguity count. When the live pool is empty, the TRASHED pool is consulted
 * for the reads-only ergonomic fallback: a UNIQUELY-named trashed project still
 * resolves by name (the render discloses it — the card's own `(trashed)` marker
 * / `stage: "trash"`), while several dead twins report honestly instead.
 */
export interface ReadProjectVerdict {
  /** The resolved winner — a live unique, a uuid/partial-uuid, or the unique-dead fallback; else null. */
  resolved: { uuid: string; title: string } | null;
  /** ALL live name-matching rows at the deciding tier (0, 1, or many). */
  liveRows: { uuid: string; title: string }[];
  /** 0 / 1 / >1 — the LIVE match count (the ambiguity count when > 1). */
  liveMatches: number;
  /** Count of TRASHED-name twins — feeds the disclosure tail / dead-hint. */
  trashedMatches: number;
}

export function readProjectNameVerdict(
  db: DatabaseSync,
  ref: string,
  options?: ReadProjectOptions,
): ReadProjectVerdict {
  // uuid/partial-uuid tiers span every project (`type = 1`); name tiers narrow
  // to LIVE rows via `nameExtraWhere` — the same split the write side uses.
  const live = resolveNamedRef(db, "TMTask", "type = 1", [], ref, {
    ...options,
    nameExtraWhere: "trashed = 0",
  });
  if (live.resolved !== null)
    return {
      resolved: live.resolved,
      liveRows: [live.resolved],
      liveMatches: 1,
      trashedMatches: 0,
    };
  if (live.matches > 1)
    return {
      resolved: null,
      liveRows: live.candidates ?? [],
      liveMatches: live.matches,
      // Disclose extra trashed twins WITHOUT folding them into the count.
      trashedMatches: trashedProjectNameMatches(db, ref, options).matches,
    };
  // Zero live name/uuid matches: the trashed pool decides the ergonomic fallback.
  const dead = trashedProjectNameMatches(db, ref, options);
  if (dead.resolved !== null)
    return { resolved: dead.resolved, liveRows: [], liveMatches: 0, trashedMatches: dead.matches };
  return { resolved: null, liveRows: [], liveMatches: 0, trashedMatches: dead.matches };
}

/**
 * Write destinations stay strict (a trashed project is not a valid target);
 * READ surfaces pass `trashed: true` so a project in the Trash can still be
 * viewed. Under `trashed: true` the read-side liveness law applies: an explicit
 * uuid / partial-uuid reaches any project, but a NAME resolves against LIVE rows
 * only (a dead same-name twin never shadows a live one), with the reads-only
 * unique-dead fallback + trash disclosure ({@link readProjectNameVerdict}).
 */
export function resolveProjectUuid(
  db: DatabaseSync,
  ref: string,
  options?: {
    trashed?: boolean;
    prefixTier?: boolean;
    scopeWhere?: string;
    scopeBinds?: (string | number)[];
  },
): string {
  if (options?.trashed !== true) {
    // The non-widening read pool: name AND uuid tiers are LIVE-only (a trashed
    // project is invisible even by uuid here) — the filter/scope/write-target
    // callers, unchanged.
    return resolveUuidOrThrow(
      db,
      "TMTask",
      "type = 1 AND trashed = 0",
      ref,
      "project",
      "things projects",
      options,
    );
  }
  const v = readProjectNameVerdict(db, ref, options);
  if (v.resolved !== null) return v.resolved.uuid;
  if (v.liveMatches > 1) {
    const shown = v.liveRows.slice(0, CANDIDATE_CAP);
    throw new ReferenceResolutionError(
      ambiguousNameMessage(ref, v.liveMatches, "project", v.liveRows.length > CANDIDATE_CAP) +
        trashDisclosureTail(v.trashedMatches),
      { code: "ambiguous", ref, candidates: shown.map((c) => candidateRef("project", c)) },
    );
  }
  // Zero live matches (a unique dead row would have resolved above), so a
  // non-empty trash count here is always the several-dead-twins case.
  throw new ReferenceResolutionError(
    `no project matching "${ref}" — ${acceptedForms(options.prefixTier !== false)} (list projects with \`things projects\`)${deadNameMatchHint({ trashed: v.trashedMatches })}`,
    { code: "not-found", ref },
  );
}

/**
 * The disclosure tail appended to a read-side project ambiguity when the
 * uuid-reachable pool holds additional TRASHED twins of the ambiguous name. The
 * ambiguity COUNT stays over live rows (coherent with the rendered candidate
 * list); the dead ones are disclosed separately rather than inflating it. Empty
 * when none are trashed.
 */
export function trashDisclosureTail(deadCount: number): string {
  return deadCount === 0
    ? ""
    : `; also matched: ${deadCount} in the trash — \`things trash\` lists them, a uuid reaches one directly`;
}

export function resolveAreaUuid(
  db: DatabaseSync,
  ref: string,
  options?: { prefixTier?: boolean; scopeWhere?: string; scopeBinds?: (string | number)[] },
): string {
  return resolveUuidOrThrow(db, "TMArea", "1=1", ref, "area", "things areas", options);
}

/**
 * Resolve a HEADING SELECTOR (spec §2) inside one project through the SAME
 * tiered core every other ref uses: exact title, or uuid (partial-uuid too).
 * There is deliberately NO index/ordinal form — the "reindex hazard" makes an
 * ordinal silently re-target a different heading after any reorder. An
 * empty-string selector is a legal literal query (the app creates titleless
 * headings); duplicates (or several titleless headings) are a resolution
 * PRECONDITION, not an invariant, so ambiguity fails closed with uuid-bearing
 * candidates (the H-DUPLICATE-TAG precedent). Shared by `todo add/move
 * --heading` (via {@link resolveHeadingRef} → the H-AMBIGUOUS-HEADING guard)
 * and by every project heading verb (via the thrower below).
 */
export function resolveHeadingRef(
  db: DatabaseSync,
  projectUuid: string,
  refRaw: string,
): NamedResolution {
  return resolveNamedRef(
    db,
    "TMTask",
    "type = 2 AND trashed = 0 AND project = ?",
    [projectUuid],
    refRaw,
  );
}

/** Render a heading selector for an error (the empty title reads as a phrase). */
function headingSelLabel(ref: string): string {
  return ref === "" ? "the empty-title heading" : `"${ref}"`;
}

/**
 * Resolve a heading selector to its uuid+title within a project, throwing a
 * {@link ReferenceResolutionError} (with uuid candidates on ambiguity) the
 * consumer surfaces render as a usage error. The project-scoped heading verbs
 * and the MCP heading tool resolve through this.
 */
export function resolveHeadingUuid(
  db: DatabaseSync,
  projectUuid: string,
  refRaw: string,
): { uuid: string; title: string } {
  const r = resolveHeadingRef(db, projectUuid, refRaw);
  if (r.resolved !== null) return r.resolved;
  const label = headingSelLabel(refRaw);
  if (r.matches === 0) {
    throw new ReferenceResolutionError(
      `no heading matching ${label} in this project — a heading selector is an exact title or a uuid (list them with \`things project-view <project>\`)`,
      { code: "not-found", ref: refRaw },
    );
  }
  const all = r.candidates ?? [];
  const shown = all.slice(0, CANDIDATE_CAP);
  // The fused ref form `Title [8charPrefix]` per candidate — a titleless heading
  // reads ` [prefix]`, which pastes back as its decorated ref.
  const lines = shown.map((c) => `  ${fusedRef(c.title, c.uuid)}`).join("\n");
  const more = all.length > CANDIDATE_CAP ? `\n  … ${all.length - CANDIDATE_CAP} more` : "";
  throw new ReferenceResolutionError(
    `${label} matches ${r.matches} headings in this project — disambiguate with a ref below:\n${lines}${more}`,
    {
      code: "ambiguous",
      ref: refRaw,
      candidates: shown.map((c) => candidateRef("heading", c)),
    },
  );
}

/**
 * Resolve a container ref's bare TITLE through the REAL resolver for its kind,
 * returning the sole resolved uuid or null (not-found OR ambiguous → null). This
 * is the emit-side promotion judgment behind the JSON round-trip law (the flat
 * `area`/`project`/`heading` refs promote a `*Uuid` sibling exactly when their
 * bare title would NOT round-trip): it is the RESOLVER'S OWN judgment, not a
 * re-derived uniqueness query, so it inherits every quirk of the write path —
 * notably projects resolve through {@link resolveProjectWriteTarget} (the
 * uuid-prefix tier runs FIRST, over the live+open write-target pool, so a title
 * that is a valid unique uuid-prefix of ANOTHER task resolves to that task, not
 * this project → does not round-trip → promotes; logged/trashed/completed
 * same-titled twins never resolve by name, so they never trigger promotion).
 * Areas resolve over all areas ({@link resolveAreaUuid}); headings within their
 * project ({@link resolveHeadingRef}, `type = 2 AND trashed = 0 AND project = ?`).
 * A thrown {@link ReferenceResolutionError} (not-found / ambiguous) is caught and
 * read as "did not resolve" → null.
 */
function resolveTitleForRoundTrip(
  db: DatabaseSync,
  kind: RefKind,
  title: string,
  projectUuid?: string,
): string | null {
  try {
    if (kind === "area") return resolveAreaUuid(db, title);
    if (kind === "project") return resolveProjectWriteTarget(db, title);
    if (projectUuid === undefined) return null; // heading round-trip needs its project scope
    return resolveHeadingRef(db, projectUuid, title).resolved?.uuid ?? null;
  } catch {
    return null;
  }
}

/**
 * Does a container ref's bare TITLE round-trip through its own resolver, in its
 * own scope, back to THIS entity's uuid? The single predicate the emit boundary
 * consults for the JSON round-trip law — true only when the sole resolution is
 * `entityUuid` (not-found / ambiguous / a different entity all → false, i.e. the
 * title must promote its uuid sibling). See {@link resolveTitleForRoundTrip}.
 */
export function titleRoundTrips(
  db: DatabaseSync,
  kind: RefKind,
  title: string,
  entityUuid: string,
  projectUuid?: string,
): boolean {
  return resolveTitleForRoundTrip(db, kind, title, projectUuid) === entityUuid;
}

/**
 * Build the {@link RefPromoter} the read-shaping transform ({@link shapeReadPayload})
 * consults to decide flat-ref uuid promotion, memoized per (kind, title, scope)
 * for ONE response emission so a large view never re-runs a resolution it has
 * already made. A fresh promoter (fresh memo) per response — the consumer
 * surfaces build one via the client. The memo caches the RESOLVED uuid (or null),
 * independent of the comparison target, so twin entities sharing a title share
 * the one resolution.
 */
export function makeRefPromoter(db: DatabaseSync): RefPromoter {
  const memo = new Map<string, string | null>();
  const resolve = (kind: RefKind, title: string, projectUuid?: string): string | null => {
    const key = `${kind}\x00${projectUuid ?? ""}\x00${title}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    const uuid = resolveTitleForRoundTrip(db, kind, title, projectUuid);
    memo.set(key, uuid);
    return uuid;
  };
  return {
    roundTrips: (kind, title, entityUuid, projectUuid) =>
      resolve(kind, title, projectUuid) === entityUuid,
  };
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

/**
 * The uuid of a repeating template's LATEST spawned instance, or null when the
 * template has none. The GUI-verified "Show Latest" law (SL1,
 * docs/lab/sl1-show-latest.md, 2026-07-29): the pick is `max(creationDate)`
 * among the template's instances — the most recently spawned occurrence — and
 * NOTHING else. It is INDEPENDENT of `startDate`, `userModificationDate`,
 * `stopDate`, and completion `status`: a completed newest-spawned instance is
 * still the latest (the SL1 D1 case). No status filter; spans both to-do and
 * project instances (`rt1_repeatingTemplate` points at the template regardless
 * of type). `creationDate` is the occurrence midnight and unique per occurrence
 * for a normal series, so ties are not expected.
 *
 * TRASHED instances are EXCLUDED (SL2, docs/lab/sl2-trash-dynamics.md, law L1):
 * the GUI Show Latest never selects a trashed instance — it skips to the newest
 * UNTRASHED one, and re-resolves live after an empty-trash. Only `trashed` is
 * filtered; `status` is NOT (a COMPLETED newest-spawned instance is still the
 * latest — SL1 D1). A template with no untrashed instances derives `null`.
 */
export function latestInstanceUuid(db: DatabaseSync, templateUuid: string): string | null {
  const row = db
    .prepare(
      "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate = ? AND trashed = 0 ORDER BY creationDate DESC LIMIT 1",
    )
    .get(templateUuid) as { uuid: string } | undefined;
  return row?.uuid ?? null;
}

/**
 * The live (untrashed) instances of a repeating series: how many exist and which
 * is the current occurrence (the newest-spawned untrashed one, per the Show
 * Latest law — {@link latestInstanceUuid}). Used to DISCLOSE what a template
 * delete leaves behind: trashing a template is SHALLOW (SERDEL S1/S2) — the
 * series stops generating but its live instances are NOT co-trashed, so the
 * disclosure names the count and the current occurrence uuid.
 */
export function liveSeriesInstances(
  db: DatabaseSync,
  templateUuid: string,
): { count: number; currentUuid: string | null } {
  const count = (
    db
      .prepare("SELECT COUNT(*) AS n FROM TMTask WHERE rt1_repeatingTemplate = ? AND trashed = 0")
      .get(templateUuid) as { n: number }
  ).n;
  return { count, currentUuid: latestInstanceUuid(db, templateUuid) };
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
 * Stamps the repeating-template flag on a resolved container ref when the
 * TMTask row it came from carries recurrence columns (`rt1_recurrenceRule` /
 * `repeater` non-null) — the disambiguator the CLI renders as the ↻ prefix on
 * a muted container label. Area rows carry neither column, so an area ref is
 * never marked. The flag is set ONLY when true (omit-when-false; the entity
 * emit boundary keeps `false`/`0` but not an absent key — see entities.Ref).
 */
function markTemplate(ref: Ref, recurrenceRule: unknown, repeater: unknown): Ref {
  if (recurrenceRule != null || repeater != null) ref.isRepeatingTemplate = true;
  return ref;
}

/**
 * Lazy heading-uuid -> owning-project Ref resolver, cached per instance.
 * Heading-nested to-dos carry project = NULL in the DB (the heading holds
 * the link); list views use this to surface the GUI's container label. The
 * owning project's recurrence columns ride along so a to-do nested under a
 * heading of a repeating-template project inherits the template mark.
 */
export function makeHeadingProjectResolver(db: DatabaseSync): (headingUuid: string) => Ref | null {
  const cache = new Map<string, Ref | null>();
  const stmt = db.prepare(
    "SELECT p.uuid AS uuid, p.title AS title, p.rt1_recurrenceRule AS rt1_recurrenceRule, p.repeater AS repeater FROM TMTask h JOIN TMTask p ON p.uuid = h.project WHERE h.uuid = ?",
  );
  return (headingUuid) => {
    const cached = cache.get(headingUuid);
    if (cached !== undefined) return cached;
    const hit = stmt.get(headingUuid) as
      | { uuid: string; title: string | null; rt1_recurrenceRule: unknown; repeater: unknown }
      | undefined;
    const ref = hit
      ? markTemplate(
          { uuid: hit.uuid, title: hit.title ?? "" },
          hit.rt1_recurrenceRule,
          hit.repeater,
        )
      : null;
    cache.set(headingUuid, ref);
    return ref;
  };
}

/** Lazy uuid -> Ref resolver over TMTask + TMArea titles, cached per instance. */
export function makeRefResolver(db: DatabaseSync): (uuid: string | null) => Ref | null {
  const cache = new Map<string, Ref | null>();
  // The recurrence columns ride along so a to-do whose container PROJECT is a
  // repeating template resolves a marked ref (TMArea has no such columns, so an
  // area ref — same resolver — is never marked).
  const taskStmt = db.prepare(
    "SELECT uuid, title, rt1_recurrenceRule, repeater FROM TMTask WHERE uuid = ?",
  );
  const areaStmt = db.prepare("SELECT uuid, title FROM TMArea WHERE uuid = ?");
  return (uuid) => {
    if (uuid === null) return null;
    const cached = cache.get(uuid);
    if (cached !== undefined) return cached;
    const hit = (taskStmt.get(uuid) ?? areaStmt.get(uuid)) as
      | { uuid: string; title: string | null; rt1_recurrenceRule?: unknown; repeater?: unknown }
      | undefined;
    const ref = hit
      ? markTemplate(
          { uuid: hit.uuid, title: hit.title ?? "" },
          hit.rt1_recurrenceRule,
          hit.repeater,
        )
      : null;
    cache.set(uuid, ref);
    return ref;
  };
}
