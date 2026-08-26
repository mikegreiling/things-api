/**
 * DeltaSpec: what a mutation is expected to change, asserted against
 * DECODED entities (not raw rows) so one spec serves every vector.
 * Silent no-ops are first-class failures — `open` exit 0 proves nothing.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AnyTask, TaskType } from "../../model/entities.ts";
import { anchorKeyOfOffsets } from "../../model/recurrence.ts";
import { byUuid } from "../../read/detail.ts";
import {
  collateralFindings,
  COLLATERAL_FIELD_PATHS,
  type CollateralFinding,
} from "../repeat-collateral.ts";
import type { RuleFields } from "../repeat-asserts.ts";

/**
 * A JSON-serializable predicate an assertion may check IN PLACE OF equality.
 * `arrived-on-or-before` holds iff the decoded value is a NON-NULL ISO date on
 * or before `date` (day-precision `YYYY-MM-DD` string compare, which is
 * chronological). It exists for the symbolic `when: today` UPDATE verify (field
 * bug §0½.8): the app PRESERVES an item's already-arrived historical `startDate`
 * rather than rewriting the storage byte to today (arrived-date law), so exact
 * `startDate == today` false-fails a write that succeeded. The predicate accepts
 * any preserved arrived date while still REJECTING an undated deadline-only pull
 * (null `startDate`). Equality stays the check for adds and explicit ISO dates.
 */
export type FieldPredicate = { predicate: "arrived-on-or-before"; date: string };

/**
 * Dotted path into a decoded entity (see getField for computed paths) checked
 * either by exact equality (`equals`) or by a {@link FieldPredicate}
 * (`satisfies`) — exactly one is set. `equals` is the default/common form; every
 * existing assertion uses it.
 */
export interface FieldAssertion {
  field: string;
  equals?: unknown;
  /** When present, the field is checked by this predicate instead of `equals`. */
  satisfies?: FieldPredicate;
}

export interface CreateProbe {
  title: string;
  type: Extract<TaskType, "to-do" | "project" | "heading">;
  /** Only rows created at/after this epoch-seconds instant qualify. */
  sinceEpoch: number;
  /**
   * Alternative discovery for rows whose creationDate is intentionally
   * BACKDATED (an add with --created-at/--completed-at): ignore sinceEpoch and
   * instead exclude these pre-existing same-title uuids.
   */
  excludeUuids?: string[];
  /**
   * Make-repeating template discovery (RSIM-P2/RSIM-R). Its presence tells
   * `findCreated` to KEEP the `sinceEpoch` time-bound even though `excludeUuids`
   * is set (a minted template always carries a fresh write-time creationDate, so
   * the bound is safe and tightens the same-title gauntlet), and tells
   * `evaluateDelta` to disambiguate multiple surviving templates by the source
   * FINGERPRINT, derive the spawned instance via the template FK, and resolve
   * the source's fate — the enriched `repeating` block the caller returns.
   */
  repeating?: RepeatingProbe;
}

/**
 * The context a make-repeating create-probe carries to harden discovery and
 * enrich the result. Captured in the op's pre-read (the source row is gone or
 * relinked by verify time, so it must be snapshotted before the drive).
 */
export interface RepeatingProbe {
  /** The original item's uuid (the ref the caller passed to make-repeating). */
  sourceUuid: string;
  /**
   * Pre-write fingerprint of the source row. Used ONLY to break a tie between
   * multiple surviving same-title templates — deadline is deliberately excluded
   * (the template drops the source's deadline while the instance keeps it, so it
   * is asymmetric and unsafe to match on; RSIM-P2 B3).
   */
  fingerprint: RepeatingFingerprint;
  /**
   * Project conversions only: the uuids of the source subtree rows (to-dos +
   * headings) captured pre-write. `childrenReplaced` counts how many of these
   * are ABSENT post-op — dead uuids the caller may have held (the delete-remint
   * fate kills the whole subtree; the nested-repeater preserve fate typically
   * kills only the flattened nested-template row, the visible children surviving
   * with their uuids). Absent (undefined) for to-do conversions.
   */
  subtreeUuids?: string[];
  /**
   * The FULL-FIDELITY expected-rule assertion set the discovered template must
   * satisfy — the complete requested rule (type/unit/interval + calendar anchor +
   * ends bound + deadline offset), built by `expectedRuleAssertions` in
   * src/write/repeat-asserts.ts (includeCursor:false — the rule BLOB + deadline,
   * not the spawn-law cursor). A template minted with ANY wrong rule field (the
   * interval-field re-layout race §8l reverting interval to 1, OR a dropped
   * anchor / ends / deadline) is a `verify-failed:mismatch`, never a silent `ok`.
   * The check is SKIPPED when the rule cannot be decoded (a future Things rule
   * format) — discovery still succeeds, consistent with the read-side decoder's
   * fail-soft. It does NOT participate in candidate DISCOVERY (which stays
   * `isTemplate`-only, so a template with an unreadable rule is still found).
   */
  expectedRule?: FieldAssertion[];
}

/**
 * Source-row fingerprint for template disambiguation. Notes, tags, container
 * pointer, and checklist titles copy verbatim to the minted template; deadline
 * does NOT (see RepeatingProbe.fingerprint).
 */
export interface RepeatingFingerprint {
  notes: string;
  /** Direct tag titles, sorted. */
  tags: string[];
  /** Container pointer (project / heading / area uuid), null for a loose item. */
  container: string | null;
  /** Checklist item titles in order (to-dos; empty for projects). */
  checklistTitles: string[];
}

/**
 * The enriched make-repeating outcome derived post-write:
 *  - templateUuid  — the discovered repeating template (also the result `uuid`).
 *  - instanceUuid  — the current-occurrence instance, derived via the template
 *                    FK (null + a warning when it cannot be derived).
 *  - replacedUuid  — the original uuid when the source was destroyed (identity
 *                    replacement); null when the source was preserved AS the
 *                    instance (then instanceUuid === the original uuid).
 *  - childrenReplaced — project conversions only: how many pre-read child uuids
 *                    are now DEAD (dead-uuid signaling, like replacedUuid).
 */
export interface RepeatingDiscovery {
  templateUuid: string;
  instanceUuid: string | null;
  replacedUuid: string | null;
  childrenReplaced?: number;
}

/**
 * Which row a TEMPLATE-TARGET composite actually wrote (template-mutation.ts) —
 * the two-uuid answer, mirroring {@link RepeatingDiscovery}'s shape for
 * make/add-repeating:
 *  - templateUuid    — the series the caller named (never itself written).
 *  - occurrenceUuid  — the occurrence that was completed/canceled/changed; the
 *                      result's own `uuid`, restated here so the pair is one
 *                      object a caller can read without inferring anything.
 *  - minted          — TRUE when the composite brought that occurrence into
 *                      existence for this call, FALSE when the series already
 *                      had an open one and it was resolved directly. The two
 *                      differ in what undo can reach (a minted occurrence cannot
 *                      be un-minted), so the fact is stated, not implied.
 *  - date            — the occurrence's own date, null when it has none.
 */
export interface OccurrenceResolution {
  templateUuid: string;
  occurrenceUuid: string;
  minted: boolean;
  date: string | null;
}

/**
 * Build a source fingerprint from a decoded task for RepeatingProbe. Deadline is
 * intentionally omitted (asymmetric between template and instance).
 */
export function buildRepeatingFingerprint(task: AnyTask): RepeatingFingerprint {
  return {
    notes: task.type === "heading" ? "" : task.notes,
    tags: task.type === "heading" ? [] : task.tags.map((t) => t.title).toSorted(),
    container: containerKey(task),
    checklistTitles: task.type === "to-do" ? (task.checklist ?? []).map((c) => c.title) : [],
  };
}

/** DB `type` int for a probe task type (0=to-do, 1=project, 2=heading). */
function dbTypeOf(type: Extract<TaskType, "to-do" | "project" | "heading">): number {
  return type === "project" ? 1 : type === "heading" ? 2 : 0;
}

/** The container pointer a template inherits from its source (project→heading→area). */
function containerKey(task: AnyTask): string | null {
  if (task.type === "heading") return task.project?.uuid ?? null;
  if (task.type === "to-do") {
    return task.project?.uuid ?? task.heading?.uuid ?? task.area?.uuid ?? null;
  }
  return task.area?.uuid ?? null;
}

export type DeltaSpec =
  | {
      mode: "update";
      uuid: string;
      assert: FieldAssertion[];
      /**
       * Extra fields whose PRE-values are recorded in the audit trail but are
       * NOT asserted post-op — for an inverse that must reconstruct richer prior
       * state than the assertion captures (reschedule-repeat records the whole
       * decoded prior rule so undo can re-drive it faithfully).
       */
      capture?: { field: string }[];
      /**
       * UNEXPLAINED-DELTA DETECTION (CGRD1 guard 3), for the rule-writing verbs.
       * Once the requested assertions hold, diff the DECODED rule pre versus post
       * and require every CHANGED field to be attributable — to a requested field,
       * or to an explicitly mapped co-mover. An unattributable one is a
       * `verify-failed:collateral`: the requested change landed, but a field the
       * caller did not name also moved. `requested` is the rule-vocabulary keys the
       * caller actually set; see src/write/repeat-collateral.ts.
       */
      collateral?: { requested: string[] };
    }
  | { mode: "create"; probe: CreateProbe; assert: FieldAssertion[] }
  | {
      mode: "state";
      uuid: string;
      assert: FieldAssertion[];
      cascade?: { uuid: string; assert: FieldAssertion[] }[];
    }
  | { mode: "gone"; entity: "area" | "tag" | "task"; uuid: string }
  /**
   * Area/tag creation: TMArea/TMTag have no creationDate, so the probe is
   * "a row with this title exists whose uuid was not present pre-write".
   */
  | {
      mode: "entity-created";
      entity: "area" | "tag";
      title: string;
      excludeUuids: string[];
      /** For tags: expected parent uuid (null = must be root). */
      parentUuid?: string | null;
      /**
       * For areas created WITH tags (area.add): the sorted tag titles the
       * created row must carry. The app silently drops unknown tags, so a
       * created area is only a success when its tag set matches exactly.
       */
      assertTags?: string[];
    }
  | { mode: "trash-emptied" }
  /**
   * `log-now` (AppleScript `log completed now`): moves resolved-but-unlogged items
   * into the Logbook by advancing `TMSettings.manualLogDate`. Verified as a delta
   * on the singleton — NOT on task rows (the log-move sweep mutates zero rows,
   * plog1/A28/LOGNOW). `pending` is the pre-op count of resolvable items (the
   * result's disclosed "how many logged"); `manualLogDatePre` the pre-op stamp.
   * When `pending > 0` the stamp must advance; when `pending == 0` it is a clean
   * no-op (satisfied unconditionally — the verb advances only when there is
   * something to log).
   */
  | { mode: "logged-now"; pending: number; manualLogDatePre: number | null }
  /**
   * Ordering: the given uuids must read back in strictly ascending rank on
   * the named key (todayIndex for Today/Evening scopes, index elsewhere;
   * area-index reads TMArea."index" — sidebar area order).
   */
  | {
      mode: "ordering";
      key: "index" | "todayIndex" | "area-index";
      sequence: string[];
      /**
       * Uuids whose pre-op ranks are captured for the audit trail beyond the
       * asserted sequence (area.reorder records the FULL area order so undo
       * can restore the exact previous position). Defaults to
       * `sequence`.
       */
      capture?: string[];
      /**
       * The uuid the reorder MOVED (recorded as the audit record's subject —
       * ordering asserts have no single uuid otherwise).
       */
      subject?: string;
      /**
       * Per-row invariants that must hold UNCHANGED across the re-rank — the
       * LOGSORT ORD-13 byte-lock for an UNSWEPT-resolved to-do movee: the native
       * `index` re-rank is index-only + `userModificationDate`-silent, so a
       * PERMITTED resolved movee must read back still-resolved (`status`
       * completed/canceled, `stoppedDate` unchanged) with NO `umd` bump. A frozen
       * assertion failure (a reopen — status→open, stoppedDate→null — or a umd
       * bump) fails the whole ordering delta. Each row's asserted fields AND its
       * `userModificationDate` are captured pre-op and compared post-op.
       */
      frozen?: { uuid: string; assert: FieldAssertion[] }[];
      /**
       * The UNTOUCHED-SIBLINGS law (RRF1), for a re-rank that rewrites only the
       * rows it names: these uuids must read back with the EXACT rank they were
       * captured at, not merely in the right relative order. `sequence` alone
       * cannot express it — it asserts an ordering, and a protocol that
       * renumbers every row to achieve that ordering satisfies it.
       *
       * Its case is `project.move-heading` on the chord vector, whose whole
       * claim is that a move is a single-row `index` write: the moved heading
       * gets a new index slotted between its new neighbours and NOTHING else in
       * the project is renumbered (HEADORD1 §2). Listing every heading the
       * caller did NOT name turns that claim into a post-op assertion, so a
       * chord that landed on the wrong row — the one thing a positional
       * heading-row selection cannot rule out by readback — fails the delta
       * instead of passing on a coincidentally-correct order.
       *
       * Each uuid must also appear in `capture` (or `sequence`, which it
       * defaults to) so its pre-op rank is recorded.
       */
      unchanged?: string[];
    }
  /** Area/tag property updates (TMArea/TMTag rows aren't tasks). */
  | { mode: "entity-updated"; entity: "area" | "tag"; uuid: string; assert: FieldAssertion[] };

/** Movement tripwires captured by the pre-read, keyed by uuid. */
export type PreModDates = Record<string, number | null>;

export interface DeltaEvaluation {
  satisfied: boolean;
  /** Anything at all happened (userModificationDate moved, row appeared/vanished). */
  movement: boolean;
  /** An ASSERTED field moved away from its pre-state (partial/contrary write). */
  assertedMovement: boolean;
  /** Asserted-field subset observed (best effort). */
  observed: Record<string, unknown> | null;
  /** For create mode: uuid of the row that satisfied the probe. */
  discoveredUuid?: string;
  /** Make-repeating create-probe: the enriched template/instance/replaced block. */
  repeating?: RepeatingDiscovery;
  /** Advisory notes from the repeating derivation (underivable instance, etc.). */
  repeatingWarnings?: string[];
  /**
   * A PERMANENT verify failure the poller must not retry (e.g. an unbreakable
   * template ambiguity) — carries a distinct `detail` naming the cause.
   */
  terminal?: boolean;
  /** Custom failure detail surfaced by the pipeline in place of the generic one. */
  detail?: string;
  /**
   * The requested change LANDED, but these decoded-rule fields moved with nothing
   * to attribute them to (CGRD1 guard 3). Set only on an `update` spec carrying
   * `collateral`, and only once the requested assertions pass — so it is never a
   * mid-settle observation. Its presence makes the evaluation unsatisfied and
   * routes the pipeline to `verify-failed:collateral`.
   */
  collateral?: CollateralFinding[];
}

export interface VerifyReader {
  taskByUuid(uuid: string): AnyTask | null;
  areaExists(uuid: string): boolean;
  tagExists(uuid: string): boolean;
  areasByTitle(title: string): { uuid: string }[];
  tagsByTitle(title: string): { uuid: string; parent: string | null }[];
  rankOf(uuid: string, key: "index" | "todayIndex" | "area-index"): number | null;
  trashedCount(): number;
  /** The current `TMSettings.manualLogDate` (epoch seconds), or null — the `log-now` verify oracle. */
  manualLogDate(): number | null;
  findCreated(probe: CreateProbe): AnyTask[];
  /**
   * Non-trashed rows of the given DB type (0=to-do, 1=project, 2=heading)
   * whose `rt1_repeatingTemplate` FK points at the template — the exact,
   * time/title-free way to derive a spawned instance (RSIM-P2 B4).
   */
  instancesOfTemplate(templateUuid: string, dbType: number): string[];
  /**
   * The post-write fate of a make-repeating source row: whether it still
   * exists, and (if so) which template its `rt1_repeatingTemplate` points at.
   * A DELETE leaves it absent; a preserve relinks it to the new template.
   */
  repeatingSourceFate(uuid: string): { present: boolean; templateFk: string | null };
  /** How many of these uuids no longer exist as TMTask rows (dead-uuid count). */
  countAbsent(uuids: string[]): number;
  modDateOf(uuid: string): number | null;
  /**
   * Assertable fields of a TMArea/TMTag row: title, tags (areas, sorted
   * titles), parent (tags, uuid or null), shortcut (tags). Null = row gone.
   */
  entityFields(entity: "area" | "tag", uuid: string): Record<string, unknown> | null;
}

/**
 * `now`/`zone` supply the evaluation clock the reader hands to `byUuid` (and thus
 * the `today`/`evening` markers) so a verified read-after-write gates Today
 * placement on the SAME injected clock the write planner used — never the wall
 * clock. Under a pinned `THINGS_NOW` (consumer-timezone / bench fence), an
 * `evening`/`today` item dated pinned-today would otherwise be judged
 * future-dated by a real-clock reader and lose its markers, failing the delta
 * assertion (bench-caught regression from the #211 clock gate). Defaults to the
 * host clock so the pure verify-reader tests and ordering call sites are
 * unaffected.
 */
export function createDbReader(
  db: DatabaseSync,
  now: Date = new Date(),
  zone?: string,
): VerifyReader {
  return {
    taskByUuid: (uuid) => byUuid(db, uuid, now, zone),
    areaExists(uuid) {
      return db.prepare("SELECT 1 FROM TMArea WHERE uuid = ?").get(uuid) !== undefined;
    },
    tagExists(uuid) {
      return db.prepare("SELECT 1 FROM TMTag WHERE uuid = ?").get(uuid) !== undefined;
    },
    areasByTitle(title) {
      return db.prepare("SELECT uuid FROM TMArea WHERE title = ? COLLATE NOCASE").all(title) as {
        uuid: string;
      }[];
    },
    tagsByTitle(title) {
      return db
        .prepare("SELECT uuid, parent FROM TMTag WHERE title = ? COLLATE NOCASE")
        .all(title) as { uuid: string; parent: string | null }[];
    },
    rankOf(uuid, key) {
      const table = key === "area-index" ? "TMArea" : "TMTask";
      const column = key === "todayIndex" ? "todayIndex" : `"index"`;
      const row = db.prepare(`SELECT ${column} AS rank FROM ${table} WHERE uuid = ?`).get(uuid) as
        | { rank: number | null }
        | undefined;
      return row?.rank ?? null;
    },
    trashedCount() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 1").get() as {
        n: number;
      };
      return row.n;
    },
    manualLogDate() {
      const row = db.prepare("SELECT manualLogDate FROM TMSettings").get() as
        | { manualLogDate: number | null }
        | undefined;
      return row?.manualLogDate ?? null;
    },
    findCreated(probe) {
      const excluded = new Set(probe.excludeUuids ?? []);
      // The time-bound is dropped to 0 ONLY for a backdated create (add --created-at):
      // there `excludeUuids` is present but `creationDate` is intentionally in
      // the past, so a bound would filter the very row we seek. A make-repeating
      // template (`repeating` set) DOES carry a fresh write-time creationDate, so
      // its bound is restored even with `excludeUuids` — tightening discovery.
      const bound =
        probe.excludeUuids === undefined || probe.repeating !== undefined ? probe.sinceEpoch : 0;
      const rows = (
        db
          .prepare(
            "SELECT uuid FROM TMTask WHERE title = ? AND type = ? AND creationDate >= ? " +
              "ORDER BY creationDate DESC LIMIT 25",
          )
          .all(probe.title, dbTypeOf(probe.type), bound) as { uuid: string }[]
      ).filter((r) => !excluded.has(r.uuid));
      const tasks: AnyTask[] = [];
      for (const r of rows) {
        const task = byUuid(db, r.uuid, now, zone);
        if (task !== null) tasks.push(task);
      }
      return tasks;
    },
    instancesOfTemplate(templateUuid, dbType) {
      return (
        db
          .prepare(
            "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate = ? AND type = ? AND trashed = 0",
          )
          .all(templateUuid, dbType) as { uuid: string }[]
      ).map((r) => r.uuid);
    },
    repeatingSourceFate(uuid) {
      const row = db
        .prepare("SELECT rt1_repeatingTemplate AS fk FROM TMTask WHERE uuid = ?")
        .get(uuid) as { fk: string | null } | undefined;
      if (row === undefined) return { present: false, templateFk: null };
      return { present: true, templateFk: row.fk ?? null };
    },
    countAbsent(uuids) {
      if (uuids.length === 0) return 0;
      const stmt = db.prepare("SELECT 1 FROM TMTask WHERE uuid = ?");
      let absent = 0;
      for (const u of uuids) if (stmt.get(u) === undefined) absent += 1;
      return absent;
    },
    modDateOf(uuid) {
      const row = db.prepare("SELECT userModificationDate FROM TMTask WHERE uuid = ?").get(uuid) as
        | { userModificationDate: number | null }
        | undefined;
      return row?.userModificationDate ?? null;
    },
    entityFields(entity, uuid) {
      if (entity === "area") {
        const row = db.prepare("SELECT title FROM TMArea WHERE uuid = ?").get(uuid) as
          | { title: string | null }
          | undefined;
        if (row === undefined) return null;
        const tags = db
          .prepare(
            "SELECT t.title FROM TMAreaTag at JOIN TMTag t ON at.tags = t.uuid WHERE at.areas = ?",
          )
          .all(uuid) as { title: string }[];
        return { title: row.title ?? "", tags: tags.map((t) => t.title).toSorted() };
      }
      const row = db
        .prepare("SELECT title, parent, shortcut FROM TMTag WHERE uuid = ?")
        .get(uuid) as
        | { title: string | null; parent: string | null; shortcut: string | null }
        | undefined;
      if (row === undefined) return null;
      return { title: row.title ?? "", parent: row.parent, shortcut: row.shortcut };
    },
  };
}

/**
 * The internal derivation-substrate field names an assertion may reference by
 * their bare (stable) schedule-vocabulary name — they live on the entity's
 * nested `derived` bag (one-vocabulary Batch 2), so {@link getField} reads them
 * from there. The Today placement axis is the presence-keyed `today`/`evening`
 * markers (`todaySection` was deleted); `reminder` resolves to the RAW stored
 * byte on the substrate, the write engine's prediction/verification target.
 */
const DERIVED_ASSERT_FIELDS: ReadonlySet<string> = new Set([
  "start",
  "logged",
  "trashed",
  "today",
  "evening",
  "reminder",
]);

/**
 * Resolve an assertion path against a decoded entity. Computed paths:
 * `tags` → sorted direct-tag titles; `checklistTitles` → checklist titles
 * in order; the derivation-substrate names ({@link DERIVED_ASSERT_FIELDS}) read
 * from the nested `derived` bag; otherwise a dotted walk (`area.uuid`,
 * `project.title`, …). NOTE: the write-verify `reminder` assertion resolves to
 * the RAW stored byte `derived.reminder` (NOT the live-gated top-level
 * `reminder`) — a write must be verified against the byte the app actually
 * stored/cleared, which survives a stale schedule (§9n).
 */
export function getField(entity: AnyTask, path: string): unknown {
  // The substrate fields (start/logged/trashed/today/evening/reminder) live on
  // `entity.derived` — read them there under their stable schedule-vocabulary
  // name (a heading carries no substrate, so it has none). `reminder` here is
  // the RAW byte, the write engine's prediction/verification target.
  if (DERIVED_ASSERT_FIELDS.has(path) && "derived" in entity) {
    return (entity.derived as unknown as Record<string, unknown>)[path];
  }
  // Day-precision views of the stored timestamps (backdating asserts these;
  // Date objects never compare === so the raw fields are not assertable).
  if (path === "stoppedDate" && "stopped" in entity) {
    return entity.stopped === null ? null : localIsoDate(entity.stopped);
  }
  if (path === "createdDate" && "created" in entity) {
    return localIsoDate(entity.created);
  }
  // The canonical, order-insensitive key of a repeating template's calendar
  // anchor — the comparison surface for full-fidelity recurrence assertions
  // (src/write/repeat-asserts.ts). Computed from the decoded rule's offsets;
  // undefined when the row is not a template or its rule did not decode (an
  // equality assertion against a concrete key then correctly fails).
  if (path === "repeating.rule.anchorKey") {
    const rule = "repeating" in entity ? entity.repeating.rule : undefined;
    return rule === undefined ? undefined : anchorKeyOfOffsets(rule.offsets);
  }
  if (path === "tags" && "tags" in entity) {
    return entity.tags.map((t) => t.title).toSorted();
  }
  if (path === "checklistTitles" && entity.type === "to-do") {
    return (entity.checklist ?? []).map((c) => c.title);
  }
  if (path === "checklistStates" && entity.type === "to-do") {
    return (entity.checklist ?? []).map((c) => c.status);
  }
  let current: unknown = entity;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const p = (n: number): string => String(n).padStart(2, "0");

function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

/** Evaluate a {@link FieldPredicate} against a decoded field value. */
function predicateHolds(pred: FieldPredicate, actual: unknown): boolean {
  switch (pred.predicate) {
    case "arrived-on-or-before":
      // Non-null ISO date on or before the reference day. `YYYY-MM-DD` string
      // ordering is chronological, so a lexicographic <= is a day compare; a
      // null/undefined (undated) value is not a string and correctly fails.
      return typeof actual === "string" && actual <= pred.date;
  }
}

/** Does a decoded field value satisfy an assertion (predicate form or equality)? */
function assertionHolds(assertion: FieldAssertion, actual: unknown): boolean {
  if (assertion.satisfies !== undefined) return predicateHolds(assertion.satisfies, actual);
  return valuesEqual(actual, assertion.equals);
}

function checkAssertions(
  entity: AnyTask | null,
  assertions: FieldAssertion[],
): { pass: boolean; observed: Record<string, unknown> } {
  const observed: Record<string, unknown> = {};
  if (entity === null) return { pass: assertions.length === 0, observed };
  let pass = true;
  for (const a of assertions) {
    const actual = getField(entity, a.field);
    observed[a.field] = actual === undefined ? null : actual;
    if (!assertionHolds(a, actual)) pass = false;
  }
  return { pass, observed };
}

/** Does a candidate template carry the source's fingerprint (deadline excluded)? */
function matchesFingerprint(candidate: AnyTask, fp: RepeatingFingerprint): boolean {
  const c = buildRepeatingFingerprint(candidate);
  return (
    c.notes === fp.notes &&
    c.container === fp.container &&
    JSON.stringify(c.tags) === JSON.stringify(fp.tags) &&
    JSON.stringify(c.checklistTitles) === JSON.stringify(fp.checklistTitles)
  );
}

/** Pick the single FK-derived instance, warning on the zero/many cases (never hard-fails). */
function pickInstance(fkInstances: string[], warnings: string[]): string | null {
  if (fkInstances.length === 1) return fkInstances[0] ?? null;
  if (fkInstances.length === 0) {
    warnings.push(
      "could not derive the spawned instance: no row links back to the new repeating template " +
        "(the app may not have materialized the current occurrence)",
    );
    return null;
  }
  warnings.push(
    `derived ${fkInstances.length} rows linking to the new repeating template; the app's ` +
      "per-occurrence stamping is nondeterministic — using the first",
  );
  return fkInstances[0] ?? null;
}

/**
 * Derive the full make-repeating discovery for a chosen template: the spawned
 * instance (via the template FK) and the source fate (replaced vs preserved-as-
 * instance), plus `childrenReplaced` for project conversions. Shared by the
 * SUCCESS path and the rule-MISMATCH failure path — because the source uuid is
 * already destroyed by the time a mismatch is detected, so a mismatch verdict
 * must still hand back the new template's uuid (+ instance/replaced) for cleanup
 * (reschedule it to the intended rule, or delete it).
 */
function deriveRepeatingDiscovery(
  spec: Extract<DeltaSpec, { mode: "create" }>,
  template: AnyTask,
  probe: RepeatingProbe,
  reader: VerifyReader,
): { repeating: RepeatingDiscovery; warnings: string[] } {
  const dbType = dbTypeOf(spec.probe.type);
  const fkInstances = reader.instancesOfTemplate(template.uuid, dbType);
  const fate = reader.repeatingSourceFate(probe.sourceUuid);
  const warnings: string[] = [];

  let instanceUuid: string | null;
  let replacedUuid: string | null;
  if (fate.present && fate.templateFk === template.uuid) {
    // Source preserved AND relinked as the current-occurrence instance.
    instanceUuid = probe.sourceUuid;
    replacedUuid = null;
  } else if (!fate.present) {
    // Identity replacement: the source was destroyed; a fresh instance minted.
    replacedUuid = probe.sourceUuid;
    instanceUuid = pickInstance(fkInstances, warnings);
  } else {
    // Present but not linked to the new template — an unexpected post-op state.
    warnings.push(
      `the original item (${probe.sourceUuid}) is still present but not linked to the new ` +
        "repeating template — unexpected post-op state",
    );
    replacedUuid = null;
    instanceUuid = pickInstance(fkInstances, warnings);
  }

  const repeating: RepeatingDiscovery = {
    templateUuid: template.uuid,
    instanceUuid,
    replacedUuid,
    // How many pre-read child uuids are now DEAD (absent) — dead-uuid signaling,
    // matching replacedUuid: the whole subtree in the delete-remint fate, just
    // the flattened nested-template row in the preserve fate.
    ...(probe.subtreeUuids !== undefined && {
      childrenReplaced: reader.countAbsent(probe.subtreeUuids),
    }),
  };
  return { repeating, warnings };
}

/**
 * Resolve a make-repeating create-probe once at least one same-title template
 * has passed the `isTemplate` assertion: disambiguate by source fingerprint,
 * derive the spawned instance via the template FK, and resolve the source fate.
 */
function evaluateRepeatingCreate(
  spec: Extract<DeltaSpec, { mode: "create" }>,
  passing: AnyTask[],
  probe: RepeatingProbe,
  reader: VerifyReader,
): DeltaEvaluation {
  // 1. Disambiguate the template when more than one same-title template survives.
  let template = passing[0];
  if (passing.length > 1) {
    const matches = passing.filter((c) => matchesFingerprint(c, probe.fingerprint));
    if (matches.length === 1) {
      template = matches[0];
    } else {
      // Cannot disambiguate — but the caller still deserves the candidate list
      // (all same-title templates found in the write window) for inspection and
      // cleanup, even though we refuse to guess which one the app just created.
      // The uuids ride `observed` → the CLI/MCP error envelope's `detail.observed`.
      return {
        satisfied: false,
        movement: true,
        assertedMovement: true,
        observed: {
          ...(template ? checkAssertions(template, spec.assert).observed : {}),
          "repeating.candidateTemplateUuids": passing.map((c) => c.uuid),
        },
        terminal: true,
        detail:
          `discovery found ${passing.length} same-title repeating templates in the write window and ` +
          `${matches.length} of them match the source fingerprint (notes/tags/container/checklist) — ` +
          "refusing to guess which one the app just created; the candidate template uuids are " +
          "included for inspection/cleanup",
      };
    }
  }
  if (template === undefined) {
    return { satisfied: false, movement: false, assertedMovement: false, observed: null };
  }

  // 1b. Verify the LANDED rule matches the REQUESTED rule (type/unit/interval)
  // when it is decodable. A drive can create the template but mis-commit the
  // interval/frequency — the interval-field re-layout race (oddities §8l) reverts
  // the interval to 1 — and that must be a verify-failed:mismatch, never a silent
  // ok. Skipped when the rule cannot be decoded (a future Things rule format):
  // discovery still succeeds and doctor counts the undecodable template, matching
  // the read-side decoder's fail-soft. Discovery above is `isTemplate`-only, so
  // an unreadable-rule template is still found; only this verification is skipped.
  if (probe.expectedRule !== undefined && getField(template, "repeating.rule.type") !== undefined) {
    const { pass, observed: ruleObserved } = checkAssertions(template, probe.expectedRule);
    if (!pass) {
      // The template WAS created — derive its full discovery so the mismatch
      // verdict hands the caller the successor uuid(s) for cleanup (the source
      // uuid is already destroyed by now). The observed bag carries every asserted
      // rule field + its actual value, plus the successor uuids, which the CLI/MCP
      // surface as the error envelope's `detail.observed`.
      const { repeating } = deriveRepeatingDiscovery(spec, template, probe, reader);
      return {
        satisfied: false,
        movement: true,
        assertedMovement: true,
        observed: {
          ...ruleObserved,
          "repeating.templateUuid": repeating.templateUuid,
          "repeating.instanceUuid": repeating.instanceUuid,
          "repeating.replacedUuid": repeating.replacedUuid,
        },
        detail:
          "the repeating template was created but its rule does not match the request — a " +
          "frequency/interval, calendar anchor, ends bound, or deadline field did not commit to " +
          "the dialog (the interval-field re-layout race, oddities §8l, reverts interval to 1). The " +
          `template WAS created (uuid ${repeating.templateUuid}) and its uuid is included for ` +
          "cleanup: reschedule-repeat it to the intended rule, or delete it.",
      };
    }
  }

  // 2. Derive the instance via the template FK + resolve the source fate.
  const { repeating, warnings } = deriveRepeatingDiscovery(spec, template, probe, reader);
  return {
    satisfied: true,
    movement: true,
    assertedMovement: true,
    observed: checkAssertions(template, spec.assert).observed,
    discoveredUuid: template.uuid,
    repeating,
    ...(warnings.length > 0 && { repeatingWarnings: warnings }),
  };
}

/**
 * One verification poll: evaluate the spec against fresh reads.
 * `preModDates` and `preFields` come from the pipeline's pre-read and feed
 * the movement classification (timeout vs mismatch vs silent-noop).
 */
export function evaluateDelta(
  spec: DeltaSpec,
  reader: VerifyReader,
  pre: {
    modDates: PreModDates;
    fields: Record<string, Record<string, unknown>>;
    trashedCount?: number;
  },
): DeltaEvaluation {
  switch (spec.mode) {
    case "update":
    case "state": {
      // A reschedule-repeat mismatch needs NO successor discovery: reschedule is
      // identity-PRESERVED (the rule mutates in place on the same uuid), so the
      // caller already holds the target uuid (spec.uuid) for any cleanup/retry —
      // unlike make-repeating (create mode), where the source uuid is destroyed
      // and the new template uuid must be handed back on mismatch.
      const entity = reader.taskByUuid(spec.uuid);
      const { pass, observed } = checkAssertions(entity, spec.assert);
      let satisfied = entity !== null && pass;
      // UNEXPLAINED-DELTA DETECTION (CGRD1 guard 3). Run ONLY once the requested
      // assertions hold: before that the write may still be settling, and "a field
      // moved" is not yet meaningful. After that the row is written, so any watched
      // field that differs pre → post with no request and no mapped co-mover to
      // explain it is a real unrequested change — reported, never blessed.
      let collateral: CollateralFinding[] | undefined;
      if (spec.mode === "update" && spec.collateral !== undefined && satisfied && entity !== null) {
        const post: Record<string, unknown> = {};
        for (const path of COLLATERAL_FIELD_PATHS) post[path] = getField(entity, path) ?? null;
        const found = collateralFindings(
          new Set(spec.collateral.requested as (keyof RuleFields)[]),
          pre.fields[spec.uuid] ?? {},
          post,
        );
        if (found.length > 0) {
          collateral = found;
          satisfied = false;
        }
      }
      let cascadeObserved: Record<string, unknown> = {};
      if (spec.mode === "state" && spec.cascade !== undefined) {
        for (const c of spec.cascade) {
          const child = reader.taskByUuid(c.uuid);
          const result = checkAssertions(child, c.assert);
          if (child === null || !result.pass) satisfied = false;
          for (const [k, v] of Object.entries(result.observed)) {
            cascadeObserved[`${c.uuid}.${k}`] = v;
          }
        }
      }
      const movement = movedSince(spec.uuid, reader, pre);
      const preFields = pre.fields[spec.uuid] ?? {};
      const assertedMovement = Object.entries(observed).some(
        ([field, value]) => field in preFields && !valuesEqual(preFields[field], value),
      );
      return {
        satisfied,
        movement,
        assertedMovement,
        observed: {
          ...observed,
          ...cascadeObserved,
          // Surface the moved fields' post-values alongside the asserted ones, so
          // the failure's `observed` bag shows what actually changed.
          ...Object.fromEntries((collateral ?? []).map((c) => [c.field, c.post])),
        },
        ...(collateral !== undefined && { collateral }),
      };
    }
    case "create": {
      const candidates = reader.findCreated(spec.probe);
      const passing = candidates.filter((c) => checkAssertions(c, spec.assert).pass);
      const repeatingProbe = spec.probe.repeating;

      if (passing.length > 0 && repeatingProbe !== undefined) {
        return evaluateRepeatingCreate(spec, passing, repeatingProbe, reader);
      }

      const winner = passing[0];
      if (winner !== undefined) {
        return {
          satisfied: true,
          movement: true,
          assertedMovement: true,
          observed: checkAssertions(winner, spec.assert).observed,
          discoveredUuid: winner.uuid,
        };
      }
      const nearest = candidates[0];
      return {
        satisfied: false,
        movement: candidates.length > 0,
        assertedMovement: candidates.length > 0,
        observed: nearest ? checkAssertions(nearest, spec.assert).observed : null,
      };
    }
    case "gone": {
      // A hard-deleted task row (project.dissolve-heading — the heading is removed
      // from TMTask entirely, DISS1) reads back null from taskByUuid; area/tag
      // deletes use their own existence probes.
      const exists =
        spec.entity === "task"
          ? reader.taskByUuid(spec.uuid) !== null
          : spec.entity === "area"
            ? reader.areaExists(spec.uuid)
            : reader.tagExists(spec.uuid);
      return {
        satisfied: !exists,
        movement: !exists,
        assertedMovement: !exists,
        observed: { exists },
      };
    }
    case "entity-created": {
      const rows: { uuid: string; parent?: string | null }[] =
        spec.entity === "area" ? reader.areasByTitle(spec.title) : reader.tagsByTitle(spec.title);
      const fresh = rows.filter((r) => !spec.excludeUuids.includes(r.uuid));
      const tagsMatch = (uuid: string): boolean => {
        if (spec.assertTags === undefined) return true;
        const observedTags = (reader.entityFields(spec.entity, uuid)?.["tags"] ?? []) as string[];
        return valuesEqual(observedTags, spec.assertTags);
      };
      const match = fresh.find((r) => {
        if (spec.entity === "tag") {
          if (spec.parentUuid === undefined) return true;
          return (r.parent ?? null) === spec.parentUuid;
        }
        return tagsMatch(r.uuid);
      });
      if (match !== undefined) {
        return {
          satisfied: true,
          movement: true,
          assertedMovement: true,
          observed: {
            uuid: match.uuid,
            title: spec.title,
            ...(spec.assertTags !== undefined && {
              tags: reader.entityFields(spec.entity, match.uuid)?.["tags"] ?? [],
            }),
          },
          discoveredUuid: match.uuid,
        };
      }
      return {
        satisfied: false,
        movement: fresh.length > 0,
        assertedMovement: fresh.length > 0,
        observed: null,
      };
    }
    case "ordering": {
      const ranks = spec.sequence.map((uuid) => ({ uuid, rank: reader.rankOf(uuid, spec.key) }));
      const observed: Record<string, unknown> = {};
      for (const r of ranks) observed[r.uuid] = r.rank;
      const missing = ranks.some((r) => r.rank === null);
      let sorted = !missing;
      for (let i = 1; i < ranks.length && sorted; i++) {
        const prev = ranks[i - 1]?.rank;
        const curr = ranks[i]?.rank;
        if (
          prev === null ||
          prev === undefined ||
          curr === null ||
          curr === undefined ||
          prev >= curr
        ) {
          sorted = false;
        }
      }
      // Movement: any rank differs from the captured pre-state.
      const preRanks = pre.fields["__ordering__"] ?? {};
      const moved = ranks.some(
        (r) => preRanks[r.uuid] !== undefined && preRanks[r.uuid] !== r.rank,
      );
      // LOGSORT ORD-13 byte-lock: each frozen (unswept-resolved) movee must read
      // back with its asserted fields unchanged (status still closed, stoppedDate
      // intact — a reopen would flip both) AND with NO userModificationDate bump
      // (the native index re-rank is umd-silent for these rows). Any drift is a
      // reopen or a silent touch — the whole ordering delta fails.
      let frozenOk = true;
      for (const f of spec.frozen ?? []) {
        const entity = reader.taskByUuid(f.uuid);
        const { pass, observed: frozenObserved } = checkAssertions(entity, f.assert);
        for (const [field, value] of Object.entries(frozenObserved)) {
          observed[`${f.uuid}.${field}`] = value;
        }
        const preUmd = pre.modDates[f.uuid];
        const postUmd = reader.modDateOf(f.uuid);
        const umdSilent = preUmd === undefined || preUmd === postUmd;
        observed[`${f.uuid}.umd`] = postUmd;
        if (!pass || !umdSilent) frozenOk = false;
      }
      // RRF1 untouched-siblings law: every listed row must hold the EXACT rank it
      // was captured at. A row whose pre-rank was never captured cannot be judged,
      // so it fails closed (the spec is required to list it in `capture`).
      let unchangedOk = true;
      for (const uuid of spec.unchanged ?? []) {
        const now = reader.rankOf(uuid, spec.key);
        observed[`${uuid}.rank`] = now;
        if (!(uuid in preRanks) || preRanks[uuid] !== now) unchangedOk = false;
      }
      return {
        satisfied: sorted && frozenOk && unchangedOk,
        movement: moved,
        assertedMovement: moved,
        observed,
      };
    }
    case "entity-updated": {
      const fields = reader.entityFields(spec.entity, spec.uuid);
      const observed: Record<string, unknown> = {};
      let pass = fields !== null;
      for (const a of spec.assert) {
        const actual = fields?.[a.field];
        observed[a.field] = actual === undefined ? null : actual;
        if (!assertionHolds(a, actual)) pass = false;
      }
      // TMArea/TMTag carry no modification date: movement = any asserted
      // field departed from its captured pre-value.
      const preFields = pre.fields[spec.uuid] ?? {};
      const moved = Object.entries(observed).some(
        ([field, value]) => field in preFields && !valuesEqual(preFields[field], value),
      );
      return {
        satisfied: pass,
        movement: moved || fields === null,
        assertedMovement: moved,
        observed,
      };
    }
    case "trash-emptied": {
      const remaining = reader.trashedCount();
      const hadTrash = (pre.trashedCount ?? 0) > 0;
      return {
        satisfied: remaining === 0,
        movement: hadTrash ? remaining < (pre.trashedCount ?? 0) : true,
        assertedMovement: remaining !== (pre.trashedCount ?? remaining),
        observed: { trashedCount: remaining },
      };
    }
    case "logged-now": {
      const current = reader.manualLogDate();
      const advanced =
        current !== null && (spec.manualLogDatePre === null || current > spec.manualLogDatePre);
      // pending>0: the boundary MUST advance (manualLogDate stamped ~the completion
      // instant). pending==0: a clean no-op — `log completed now` advances only when
      // there are pending completions, so an unchanged stamp is the correct outcome.
      const satisfied = spec.pending > 0 ? advanced : true;
      return {
        satisfied,
        movement: advanced,
        assertedMovement: advanced,
        observed: { logged: spec.pending, manualLogDate: current },
      };
    }
    default: {
      const exhaustive: never = spec;
      throw new Error(`unknown delta mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function movedSince(uuid: string, reader: VerifyReader, pre: { modDates: PreModDates }): boolean {
  const now = reader.modDateOf(uuid);
  const before = pre.modDates[uuid];
  if (before === undefined) return now !== null; // row appeared
  if (now === null && before !== null) return true; // row vanished
  return now !== before;
}
