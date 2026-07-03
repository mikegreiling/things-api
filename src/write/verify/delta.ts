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
  type: Extract<TaskType, "to-do" | "project">;
  /** Only rows created at/after this epoch-seconds instant qualify. */
  sinceEpoch: number;
}

export type DeltaSpec =
  | { mode: "update"; uuid: string; assert: FieldAssertion[] }
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
    }
  | { mode: "trash-emptied" };

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
}

export interface VerifyReader {
  taskByUuid(uuid: string): AnyTask | null;
  areaExists(uuid: string): boolean;
  tagExists(uuid: string): boolean;
  areasByTitle(title: string): { uuid: string }[];
  tagsByTitle(title: string): { uuid: string; parent: string | null }[];
  trashedCount(): number;
  findCreated(probe: CreateProbe): AnyTask[];
  modDateOf(uuid: string): number | null;
}

export function createDbReader(db: DatabaseSync): VerifyReader {
  return {
    taskByUuid: (uuid) => byUuid(db, uuid),
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
    trashedCount() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 1").get() as {
        n: number;
      };
      return row.n;
    },
    findCreated(probe) {
      const rows = db
        .prepare(
          "SELECT uuid FROM TMTask WHERE title = ? AND type = ? AND creationDate >= ? " +
            "ORDER BY creationDate DESC LIMIT 5",
        )
        .all(probe.title, probe.type === "project" ? 1 : 0, probe.sinceEpoch) as {
        uuid: string;
      }[];
      const tasks: AnyTask[] = [];
      for (const r of rows) {
        const task = byUuid(db, r.uuid);
        if (task !== null) tasks.push(task);
      }
      return tasks;
    },
    modDateOf(uuid) {
      const row = db.prepare("SELECT userModificationDate FROM TMTask WHERE uuid = ?").get(uuid) as
        | { userModificationDate: number | null }
        | undefined;
      return row?.userModificationDate ?? null;
    },
  };
}

/**
 * Resolve an assertion path against a decoded entity. Computed paths:
 * `tags` → sorted direct-tag titles; `checklistTitles` → checklist titles
 * in order; otherwise a dotted walk (`area.uuid`, `project.title`, …).
 */
export function getField(entity: AnyTask, path: string): unknown {
  if (path === "tags" && "tags" in entity) {
    return entity.tags.map((t) => t.title).toSorted();
  }
  if (path === "checklistTitles" && entity.type === "to-do") {
    return (entity.checklist ?? []).map((c) => c.title);
  }
  let current: unknown = entity;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
      for (const candidate of candidates) {
        const { pass, observed } = checkAssertions(candidate, spec.assert);
        if (pass) {
          return {
            satisfied: true,
            movement: true,
            assertedMovement: true,
            observed,
            discoveredUuid: candidate.uuid,
          };
        }
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
      const match = fresh.find((r) => {
        if (spec.parentUuid === undefined || spec.entity === "area") return true;
        return (r.parent ?? null) === spec.parentUuid;
      });
      if (match !== undefined) {
        return {
          satisfied: true,
          movement: true,
          assertedMovement: true,
          observed: { uuid: match.uuid, title: spec.title },
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
