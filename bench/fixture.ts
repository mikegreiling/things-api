/**
 * Per-run fixture builder. Reuses the `test/fixtures` schema + typed seed builders
 * (same package — allowed across the consumer air gap since this is neither
 * `src/cli` nor `src/mcp`), applies a task's declarative SeedSpecs, then snapshots a
 * content hash of the on-disk DB for the db-unchanged safety check.
 *
 * NOTE: buildFixtureDb seeds the Meta row; the `benchFixture=1` marker is opt-in and
 * this builder always opts in — the simulator fence requires it, and a marked DB can
 * never be paired with real write transports (defaultVectors fails closed).
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { buildFixtureDb } from "../test/fixtures/build-db.ts";
import {
  seedArea,
  seedChecklistItem,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagArea,
  tagTask,
  type SeedTaskOpts,
} from "../test/fixtures/seed.ts";
import type { SeedSpec, TaskSeedFields } from "./types.ts";
import { applyWorld, type WorldOptions } from "./world.ts";

export interface BenchFixture {
  /** Absolute path to the fixture DB (used as THINGS_DB for every child process). */
  path: string;
  /** Content hash of the DB at build time (pre-run baseline for db-unchanged). */
  snapshotHash: string;
  /** Release the on-disk fixture. */
  cleanup: () => void;
}

function normalizeCell(value: unknown): string {
  if (typeof value === "bigint") return `b:${value}`;
  // Buffer is a Uint8Array subclass, so this catches all BLOBs.
  if (value instanceof Uint8Array) return `x:${Buffer.from(value).toString("hex")}`;
  return `j:${JSON.stringify(value)}`;
}

function stableRow(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(row)
      .toSorted()
      .map((k) => [k, normalizeCell(row[k])]),
  );
}

/**
 * Hash the LOGICAL content of the DB (every user table's rows, order-independent),
 * not the raw file bytes. A raw byte/WAL hash false-positives on pure reads — merely
 * opening a WAL-mode DB can trigger a benign checkpoint that rewrites `-wal`/main and
 * bumps the header change counter without any data change. Row content is invariant
 * under checkpoints, so this stays stable across read-only workloads while detecting
 * any real write. See NOTES.md.
 */
export function hashDbFiles(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const hash = createHash("sha256");
    for (const { name } of tables) {
      hash.update(`\n#${name}\n`);
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
      for (const serialized of rows.map(stableRow).toSorted()) hash.update(serialized);
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

function taskOpts(spec: TaskSeedFields): SeedTaskOpts {
  const opts: SeedTaskOpts = {};
  if (spec.title !== undefined) opts.title = spec.title;
  if (spec.notes !== undefined) opts.notes = spec.notes;
  if (spec.status !== undefined) opts.status = spec.status;
  if (spec.start !== undefined) opts.start = spec.start;
  if (spec.startDate !== undefined) opts.startDate = spec.startDate;
  if (spec.deadline !== undefined) opts.deadline = spec.deadline;
  if (spec.reminder !== undefined) opts.reminder = spec.reminder;
  if (spec.evening !== undefined) opts.evening = spec.evening;
  if (spec.trashed !== undefined) opts.trashed = spec.trashed;
  if (spec.index !== undefined) opts.index = spec.index;
  return opts;
}

/** Apply the seeds in a dependency-respecting order onto an open DB. */
function applySeeds(db: DatabaseSync, seeds: SeedSpec[]): void {
  const uuidByKey = new Map<string, string>();
  const kindByKey = new Map<string, SeedSpec["kind"]>();
  const tagUuidByTitle = new Map<string, string>();

  const ensureTag = (title: string): string => {
    const existing = tagUuidByTitle.get(title);
    if (existing !== undefined) return existing;
    const uuid = seedTag(db, title);
    tagUuidByTitle.set(title, uuid);
    return uuid;
  };

  const container = (key: string | undefined): SeedTaskOpts => {
    if (key === undefined) return {};
    const uuid = uuidByKey.get(key);
    const kind = kindByKey.get(key);
    if (uuid === undefined || kind === undefined) {
      throw new Error(`seed container references unknown key: ${key}`);
    }
    switch (kind) {
      case "area":
        return { area: uuid };
      case "project":
        return { project: uuid };
      case "heading":
        return { heading: uuid };
      default:
        throw new Error(`seed key ${key} (kind ${kind}) is not a valid container`);
    }
  };

  const attachTags = (taskUuid: string, tags: string[] | undefined): void => {
    for (const title of tags ?? []) tagTask(db, taskUuid, ensureTag(title));
  };

  // Group by kind so containers/parents always exist before their dependents.
  // areas → tags → projects → headings → todos → checklist-items.
  const order: SeedSpec["kind"][] = ["area", "tag", "project", "heading", "todo", "checklist-item"];
  const byKind = new Map<SeedSpec["kind"], SeedSpec[]>();
  for (const s of seeds) {
    const bucket = byKind.get(s.kind) ?? [];
    bucket.push(s);
    byKind.set(s.kind, bucket);
  }

  for (const kind of order) {
    for (const s of byKind.get(kind) ?? []) {
      let uuid: string;
      switch (s.kind) {
        case "area":
          uuid = seedArea(db, s.title, s.index ?? 0);
          // Area tags live in TMAreaTag, not TMTaskTag — attachTags (tagTask)
          // is the wrong table for areas, so seed them here via tagArea. Without
          // this, area-inherited tags never reach the DB and inheritedTagsFor
          // can only ever return project/own tags.
          for (const title of s.tags ?? []) tagArea(db, uuid, ensureTag(title));
          break;
        case "tag": {
          const parentUuid = s.parent !== undefined ? (uuidByKey.get(s.parent) ?? null) : null;
          uuid = seedTag(db, s.title, parentUuid, s.index ?? 0);
          tagUuidByTitle.set(s.title, uuid);
          break;
        }
        case "project":
          uuid = seedProject(db, { ...taskOpts(s), ...container(s.container) });
          attachTags(uuid, s.tags);
          break;
        case "heading":
          uuid = seedHeading(db, { ...taskOpts(s), ...container(s.container) });
          attachTags(uuid, s.tags);
          break;
        case "todo":
          uuid = seedTodo(db, { ...taskOpts(s), ...container(s.container) });
          attachTags(uuid, s.tags);
          break;
        case "checklist-item": {
          const parent = uuidByKey.get(s.container);
          if (parent === undefined) {
            throw new Error(`checklist-item ${s.key} references unknown todo: ${s.container}`);
          }
          const opts: { status?: "open" | "canceled" | "completed"; index?: number } = {};
          if (s.status !== undefined) opts.status = s.status;
          if (s.index !== undefined) opts.index = s.index;
          uuid = seedChecklistItem(db, parent, s.title, opts);
          break;
        }
      }
      uuidByKey.set(s.key, uuid);
      kindByKey.set(s.key, s.kind);
    }
  }
}

/**
 * Build a fresh fixture DB — the evergreen world profile first (when given),
 * the task's own seeds layered on top — and snapshot its baseline hash.
 * applyWorld validates the world invariants (no Today/overdue contribution,
 * corpus-collision fence, decodable recurrence blobs) before task seeds land.
 * benchMarker brands the DB as a bench fixture: the simulator fence requires
 * it, and defaultVectors refuses to pair a marked DB with real transports.
 */
export function buildBenchFixture(seeds: SeedSpec[], world?: WorldOptions): BenchFixture {
  const fixture = buildFixtureDb({ benchMarker: true });
  if (world !== undefined) applyWorld(fixture.db, world);
  applySeeds(fixture.db, seeds);
  // Close flushes WAL to disk so the child process opens a consistent file and the
  // baseline hash reflects the committed seed state.
  fixture.close();
  return {
    path: fixture.path,
    snapshotHash: hashDbFiles(fixture.path),
    cleanup: () => {
      // Best-effort: node:sqlite already closed the handle; leave file removal to the
      // OS tmp reaper (the fixtures live under os.tmpdir()).
    },
  };
}
