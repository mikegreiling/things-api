/**
 * DeltaSpec: what a mutation is expected to change, asserted against
 * DECODED entities (not raw rows) so one spec serves every vector.
 * Silent no-ops are first-class failures — `open` exit 0 proves nothing.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AnyTask, TaskType } from "../../model/entities.ts";
import { byUuid } from "../../read/detail.ts";

/** Dotted path into a decoded entity; see getField for computed paths. */
export interface FieldAssertion {
  field: string;
  equals: unknown;
}

export interface CreateProbe {
  title: string;
  type: Extract<TaskType, "to-do" | "project" | "heading">;
  /** Only rows created at/after this epoch-seconds instant qualify. */
  sinceEpoch: number;
  /**
   * Alternative discovery for rows whose creationDate is intentionally
   * BACKDATED (todo.add-logged): ignore sinceEpoch and instead exclude these
   * pre-existing same-title uuids.
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
   * Project conversions only: the count of source subtree rows (to-dos +
   * headings) — surfaced as `childrenReplaced`. Absent for to-do conversions.
   */
  subtreeCount?: number;
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
 *  - childrenReplaced — project conversions only: source subtree rows re-minted.
 */
export interface RepeatingDiscovery {
  templateUuid: string;
  instanceUuid: string | null;
  replacedUuid: string | null;
  childrenReplaced?: number;
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
    }
  | { mode: "create"; probe: CreateProbe; assert: FieldAssertion[] }
  | {
      mode: "state";
      uuid: string;
      assert: FieldAssertion[];
      cascade?: { uuid: string; assert: FieldAssertion[] }[];
    }
  | { mode: "gone"; entity: "area" | "tag"; uuid: string }
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
}

export interface VerifyReader {
  taskByUuid(uuid: string): AnyTask | null;
  areaExists(uuid: string): boolean;
  tagExists(uuid: string): boolean;
  areasByTitle(title: string): { uuid: string }[];
  tagsByTitle(title: string): { uuid: string; parent: string | null }[];
  rankOf(uuid: string, key: "index" | "todayIndex" | "area-index"): number | null;
  trashedCount(): number;
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
  modDateOf(uuid: string): number | null;
  /**
   * Assertable fields of a TMArea/TMTag row: title, tags (areas, sorted
   * titles), parent (tags, uuid or null), shortcut (tags). Null = row gone.
   */
  entityFields(entity: "area" | "tag", uuid: string): Record<string, unknown> | null;
}

/**
 * `now`/`zone` supply the evaluation clock the reader hands to `byUuid` (and thus
 * `mapTodaySection`) so a verified read-after-write gates `todaySection` on the
 * SAME injected clock the write planner used — never the wall clock. Under a
 * pinned `THINGS_NOW` (consumer-timezone / bench fence), an `evening`/`today`
 * item dated pinned-today would otherwise be judged future-dated by a real-clock
 * reader and lose its `todaySection`, failing the delta assertion (bench-caught
 * regression from the #211 todaySection gate). Defaults to the host clock so the
 * pure verify-reader tests and ordering call sites are unaffected.
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
    findCreated(probe) {
      const excluded = new Set(probe.excludeUuids ?? []);
      // The time-bound is dropped to 0 ONLY for a backdated create (add-logged):
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
 * Resolve an assertion path against a decoded entity. Computed paths:
 * `tags` → sorted direct-tag titles; `checklistTitles` → checklist titles
 * in order; otherwise a dotted walk (`area.uuid`, `project.title`, …).
 */
export function getField(entity: AnyTask, path: string): unknown {
  // Day-precision views of the stored timestamps (backdating asserts these;
  // Date objects never compare === so the raw fields are not assertable).
  if (path === "stoppedDate" && "stopped" in entity) {
    return entity.stopped === null ? null : localIsoDate(entity.stopped);
  }
  if (path === "createdDate" && "created" in entity) {
    return localIsoDate(entity.created);
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
    if (!valuesEqual(actual, a.equals)) pass = false;
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
      return {
        satisfied: false,
        movement: true,
        assertedMovement: true,
        observed: template ? checkAssertions(template, spec.assert).observed : null,
        terminal: true,
        detail:
          `discovery found ${passing.length} same-title repeating templates in the write window and ` +
          `${matches.length} of them match the source fingerprint (notes/tags/container/checklist) — ` +
          "refusing to guess which one the app just created",
      };
    }
  }
  if (template === undefined) {
    return { satisfied: false, movement: false, assertedMovement: false, observed: null };
  }

  // 2. Derive the instance via the template FK + resolve the source fate.
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
    ...(probe.subtreeCount !== undefined && { childrenReplaced: probe.subtreeCount }),
  };
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
      const entity = reader.taskByUuid(spec.uuid);
      const { pass, observed } = checkAssertions(entity, spec.assert);
      let satisfied = entity !== null && pass;
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
        observed: { ...observed, ...cascadeObserved },
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
      const exists =
        spec.entity === "area" ? reader.areaExists(spec.uuid) : reader.tagExists(spec.uuid);
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
      return {
        satisfied: sorted,
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
        if (!valuesEqual(actual, a.equals)) pass = false;
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
