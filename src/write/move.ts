/**
 * write.move / write.reorder orchestrators — the `todo move`, `todo reorder`,
 * and `project move` vocabulary (spec §4/§5). Neither introduces a new
 * OperationKind: they COMPILE onto the existing wire primitives through a
 * minimal-move planner —
 *
 *   - membership change  → the `todo.move` / `project.move` single-item ops;
 *   - placement          → the `reorder` op (native re-rank / anchor-stack /
 *                          bounce), through {@link runReorder}.
 *
 * The six ratified core rules (spec §4) live here:
 *   1. selection order = destination block order (per bucket);
 *   2. anchors POSITION, never MIGRATE — an anchor-only move that would cross a
 *      container fails closed;
 *   3. homogeneous movee kinds (one KIND per call);
 *   4. mixed-bucket = GUI parity — membership is always legal (each movee lands
 *      top-of-its-own-bucket in selection order); `--before`/`--after` require
 *      every movee in the anchor's bucket;
 *   5. placement honesty — "top of bucket" is GUARANTEED only where a reorder
 *      protocol exists for the destination bucket (the lab-locked scopes:
 *      inbox / today / evening / someday-view / project-unheaded / area); a
 *      heading bucket, an in-container someday bucket, or a scheduled day bucket
 *      is APP-DEFAULT (no HEADORD/SOMEORD/DAYORD verdict yet). The result states
 *      which class applied;
 *   6. compilation via the minimal-move planner (fewest legs; per-scope caps and
 *      bounce abort-honesty apply per leg).
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday } from "../model/dates.ts";
import {
  ReferenceResolutionError,
  resolveTaskUuidPrefix,
  type RefCandidate,
} from "../read/queries.ts";
import { taskMembershipClause } from "../read/scope.ts";
import { computeReorderPre, resolveArea, resolveHeading, resolveProject } from "./pre-state.ts";
import type { ContainerRef, ReorderParams, ReorderScope, TodoMoveParams } from "./operations.ts";
import { type MutationResult, type WriteDeps, type WriteOptions } from "./pipeline.ts";
import { runMutation } from "./pipeline.ts";
import { runReorder, type ReorderResult } from "./reorder.ts";

// --------------------------------------------------------------- request shapes

/** A destination for `todo move` (spec §4 destinations + §5 detach family). */
export type TodoMoveDestination =
  | { kind: "project"; ref: ContainerRef; heading?: string }
  | { kind: "heading"; sel: string; project?: ContainerRef }
  | { kind: "area"; ref: ContainerRef }
  | { kind: "inbox" }
  | { kind: "no-heading" }
  | { kind: "loose" }
  // teaching-only kinds: the surfaces accept the WRONG flag so the orchestrator
  // can raise the exact teaching error (§5/§7). None reaches a wire leg.
  | { kind: "no-area" }
  | { kind: "detach" };

/** A destination for `project move`. */
export type ProjectMoveDestination =
  | { kind: "area"; ref: ContainerRef }
  | { kind: "no-area" }
  // teaching-only:
  | { kind: "loose" }
  | { kind: "detach" };

/** An anchor/position for either verb. */
export type MovePosition = { at: "first" | "last" } | { before: string } | { after: string };

export interface TodoMoveRequest {
  uuids: string[];
  destination?: TodoMoveDestination;
  position?: MovePosition;
}

export interface ProjectMoveRequest {
  uuids: string[];
  destination?: ProjectMoveDestination;
  position?: MovePosition;
}

/** A pure reposition (`todo reorder` / `project reorder`). */
export interface ReorderRequest {
  uuids: string[];
  position?: MovePosition;
}

// ------------------------------------------------------------------- result

export type PlacementClass = "guaranteed" | "app-default";

export interface MoveOk {
  kind: "move-ok";
  op: "todo.move" | "project.move";
  movees: { uuid: string; title: string | null }[];
  /** Membership legs (empty for a pure reposition). */
  membership: MutationResult[];
  /** The placement reorder, when one ran. */
  placement: ReorderResult | null;
  placementClass: PlacementClass;
  /** Honest note about which placement class applied (spec §4 rule 5). */
  note: string;
}

export interface MoveRefused {
  kind: "move-refused";
  op: "todo.move" | "project.move";
  /** Maps to the CLI exit / MCP error code. */
  refusal: "usage" | "blocked" | "unsupported";
  detail: string;
  remediation?: string;
  candidates?: RefCandidate[];
}

export interface MoveLegFailed {
  kind: "move-leg-failed";
  op: "todo.move" | "project.move";
  detail: string;
  failed: MutationResult | ReorderResult;
  completed: MutationResult[];
}

export interface MoveDryRun {
  kind: "move-dry-run";
  op: "todo.move" | "project.move";
  plan: {
    movees: string[];
    membership: string;
    placement: string;
    placementClass: PlacementClass | "n/a";
    note: string;
  };
}

export type MoveResult = MoveOk | MoveRefused | MoveLegFailed | MoveDryRun;

// ------------------------------------------------------------- row helpers

interface MoveeRow {
  uuid: string;
  title: string | null;
  type: number;
  project: string | null;
  area: string | null;
  heading: string | null;
  start: number;
  startDate: number | null;
  startBucket: number;
}

function loadRow(db: DatabaseSync, uuid: string): MoveeRow | undefined {
  return db
    .prepare(
      "SELECT uuid, title, type, project, area, heading, start, startDate, startBucket " +
        "FROM TMTask WHERE uuid = ?",
    )
    .get(uuid) as MoveeRow | undefined;
}

const KIND_LABEL: Record<number, string> = { 0: "to-do", 1: "project", 2: "heading" };

/** The display bucket a row sits in — the anchor single-bucket rule keys on it. */
function scheduleBucket(row: MoveeRow, packedToday: number): string {
  if (row.start === 0) return "inbox";
  if (row.start === 2) return "someday";
  if (row.startDate === null) return "anytime";
  if (row.startDate <= packedToday) return row.startBucket === 1 ? "evening" : "today";
  return `scheduled:${row.startDate}`;
}

type ScopeTarget = { scope: ReorderScope; container?: string } | { scope: null; reason: string };

/** Where a to-do currently lives, as a reorder scope (or app-default). */
function todoReorderScope(row: MoveeRow, packedToday: number): ScopeTarget {
  if (row.heading !== null) return { scope: null, reason: "under a heading" };
  if (row.project !== null) return { scope: "project", container: row.project };
  if (row.area !== null) return { scope: "area", container: row.area };
  // loose:
  if (row.start === 0) return { scope: "inbox" };
  if (row.start === 2) return { scope: "someday" };
  if (row.startDate === null) return { scope: null, reason: "loose anytime" };
  if (row.startDate <= packedToday) return { scope: row.startBucket === 1 ? "evening" : "today" };
  return { scope: null, reason: "a future day bucket" };
}

/** Where a project currently lives, as a reorder scope (or app-default). */
function projectReorderScope(row: MoveeRow): ScopeTarget {
  if (row.area !== null) return { scope: "area", container: row.area };
  if (row.start === 2) return { scope: "someday" };
  if (row.startDate === null) return { scope: "projects" };
  return { scope: null, reason: "a scheduled day bucket" };
}

/** A stable key identifying the container a row shares with its siblings. */
function containerKey(target: ScopeTarget): string {
  if (target.scope === null) return `app:${target.reason}`;
  return target.container !== undefined ? `${target.scope}:${target.container}` : target.scope;
}

function refused(
  op: "todo.move" | "project.move",
  refusal: MoveRefused["refusal"],
  detail: string,
  remediation?: string,
): MoveRefused {
  return {
    kind: "move-refused",
    op,
    refusal,
    detail,
    ...(remediation !== undefined && { remediation }),
  };
}

// The ratified teaching errors (spec §4 bare-invocation block, §5, §7).
const BARE_TODO_MOVE =
  "`todo move` needs a destination or a position. To change what a to-do belongs to, name " +
  "one of --to-project / --to-heading / --to-area (or --no-heading / --loose to detach). To " +
  "rearrange to-dos that already share a container, use `todo reorder` (or pass --first / " +
  "--last / --before / --after here). A bare `todo move` has no meaning — it would move " +
  "nothing.";
const BARE_PROJECT_MOVE =
  "`project move` needs a destination or a position. Name --to-area (or --no-area to leave " +
  "the area) to change the project's area, or pass --first / --last / --before / --after to " +
  "reorder it among its siblings. A bare `project move` has no meaning.";

// ------------------------------------------------------------ scope-aware resolve

function resolveMovee(deps: WriteDeps, ref: string): { uuid: string } | ReferenceResolutionError {
  try {
    // Scope-aware (the no-oracle guarantee): an out-of-scope ref resolves to
    // not-found through the identical path a nonexistent one does (#276).
    const taskScope = deps.scope !== undefined ? taskMembershipClause(deps.scope) : undefined;
    return { uuid: resolveTaskUuidPrefix(deps.db, ref, "item", taskScope) };
  } catch (err) {
    if (err instanceof ReferenceResolutionError) return err;
    // A short/invalid prefix is a plain RangeError — wrap as not-found.
    return new ReferenceResolutionError(err instanceof Error ? err.message : String(err), {
      code: "not-found",
      ref,
    });
  }
}

// --------------------------------------------------------------- todo move

export async function runTodoMove(
  deps: WriteDeps,
  request: TodoMoveRequest,
  options: WriteOptions = {},
): Promise<MoveResult> {
  const op = "todo.move" as const;
  const now = deps.now?.() ?? new Date();
  const packedToday = encodePackedDate(localToday(now));

  if (request.uuids.length === 0) {
    return refused(op, "usage", "no to-dos given — name at least one to-do to move");
  }

  // Resolve movees + homogeneity (rule 3).
  const rows: MoveeRow[] = [];
  const wrongKind: { ref: string; kind: string }[] = [];
  for (const ref of request.uuids) {
    const r = resolveMovee(deps, ref);
    if (r instanceof ReferenceResolutionError) {
      return {
        kind: "move-refused",
        op,
        refusal: "usage",
        detail: r.message,
        candidates: r.candidates,
      };
    }
    const row = loadRow(deps.db, r.uuid);
    if (row === undefined) {
      return refused(op, "usage", `no to-do matches "${ref}"`);
    }
    if (row.type !== 0) wrongKind.push({ ref: r.uuid, kind: KIND_LABEL[row.type] ?? "item" });
    rows.push(row);
  }
  if (wrongKind.length > 0) {
    const list = wrongKind.map((w) => `${w.ref} (${w.kind})`).join(", ");
    return refused(
      op,
      "usage",
      `homogeneous movee kinds required — \`todo move\` moves to-dos only, but these are not to-dos: ${list}`,
      "move projects with `project move` and headings with `project move-heading`",
    );
  }

  const dest = request.destination;
  const position = request.position;

  // Detach-family teaching errors (§5/§7) before any wire leg.
  if (dest?.kind === "detach") {
    return refused(
      op,
      "usage",
      "`--detach` was removed. To leave the heading but stay in the project use --no-heading; " +
        "to leave the project, area, AND heading use --loose.",
    );
  }
  if (dest?.kind === "no-area") {
    // A to-do's area is inherited from its project (project child) or direct
    // (loose direct-area to-do). Neither takes --no-area (§5).
    const child = rows.some((r) => r.project !== null || r.heading !== null);
    return refused(
      op,
      "usage",
      child
        ? "`--no-area` does not apply to a to-do: its area comes from its project. Use --loose to " +
            "leave the project (and its area), or move the project with `project move --no-area`."
        : "`--no-area` does not apply to a to-do — for a to-do this is `--loose` (leaving a " +
            "direct-area to-do's area severs its only container). No duplicate spellings.",
    );
  }

  // Bare invocation (§4): the ratified teaching error.
  if (dest === undefined && position === undefined) {
    return refused(op, "usage", BARE_TODO_MOVE);
  }

  // No destination + a position → an anchor-implied reposition (rule 2): pure
  // positioning within the movees' current shared container. Delegate to the
  // reorder machinery, but with move's own cross-container teaching copy.
  if (dest === undefined) {
    return repositionInPlace(deps, op, rows, position, packedToday, options, "move");
  }

  // --no-heading / --loose validation against the movees' current containment.
  if (dest.kind === "no-heading") {
    const noProject = rows.filter((r) => r.project === null && r.heading === null);
    if (noProject.length > 0) {
      return refused(
        op,
        "usage",
        "--no-heading needs the to-do to be in a project — these are not in any project: " +
          noProject.map((r) => r.uuid).join(", "),
        "use --loose to detach a loose to-do's schedule-only state, or --to-project to place it",
      );
    }
  }

  // Membership legs (rule 1: selection order). Each movee gets one todo.move.
  const legParams = membershipLeg(deps, dest, rows, options);
  if ("refused" in legParams) return legParams.refused;

  const membership: MutationResult[] = [];
  for (const leg of legParams.legs) {
    const res = await runMutation(deps, "todo.move", leg.params, {
      ...legOptions(options),
      ...(options.dryRun === true && { dryRun: true }),
    });
    membership.push(res);
    if (res.kind !== "ok" && res.kind !== "dry-run") {
      return {
        kind: "move-leg-failed",
        op,
        detail: `moving ${leg.uuid} into the destination failed (${res.kind})`,
        failed: res,
        completed: membership.slice(0, -1),
      };
    }
  }

  // Placement (rules 4/5): reorder the movees within the destination bucket,
  // when a reorder protocol exists there; otherwise app-default with a note.
  const landing = todoLandingScope(deps, dest, rows, packedToday);
  return finishPlacement(deps, op, rows, landing, position, packedToday, options, membership);
}

interface MembershipPlan {
  legs: { uuid: string; params: TodoMoveParams }[];
}

/** Build one todo.move leg per movee for the requested destination. */
function membershipLeg(
  deps: WriteDeps,
  dest: TodoMoveDestination,
  rows: MoveeRow[],
  _options: WriteOptions,
): MembershipPlan | { refused: MoveRefused } {
  const op = "todo.move" as const;
  const legs: MembershipPlan["legs"] = [];
  // Resolve a shared project for a heading destination (rule: within
  // --to-project's project, else the movees' shared project).
  if (dest.kind === "heading") {
    let projectUuid: string | null = null;
    if (dest.project !== undefined) {
      const p = resolveProject(deps.db, dest.project);
      if (p.resolved === null) {
        return {
          refused: refused(op, "usage", "the --to-project for this heading did not resolve"),
        };
      }
      projectUuid = p.resolved.uuid;
    } else {
      // The movees' shared project (direct, or the heading's project).
      const projSet = new Set(rows.map((r) => r.project ?? headingProjectOf(deps.db, r.heading)));
      projSet.delete(null);
      if (projSet.size !== 1) {
        return {
          refused: refused(
            op,
            "usage",
            "the movees span projects (or none), so a --to-heading selector is ambiguous — " +
              "name --to-project <ref> to say which project's heading you mean",
          ),
        };
      }
      projectUuid = [...projSet][0] as string;
    }
    const h = resolveHeading(deps.db, projectUuid, dest.sel);
    if (h.resolved === null) {
      return {
        refused: {
          kind: "move-refused",
          op,
          refusal: "usage",
          detail:
            h.matches > 1
              ? `the heading selector "${dest.sel}" matches ${h.matches} headings — disambiguate with a uuid`
              : `no heading matching "${dest.sel}" in the destination project`,
        },
      };
    }
    for (const r of rows) {
      legs.push({
        uuid: r.uuid,
        params: { uuid: r.uuid, project: { uuid: projectUuid }, heading: h.resolved.uuid },
      });
    }
    return { legs };
  }

  for (const r of rows) {
    switch (dest.kind) {
      case "project":
        legs.push({
          uuid: r.uuid,
          params: {
            uuid: r.uuid,
            project: dest.ref,
            ...(dest.heading !== undefined && { heading: dest.heading }),
          },
        });
        break;
      case "area":
        legs.push({ uuid: r.uuid, params: { uuid: r.uuid, area: dest.ref } });
        break;
      case "inbox":
        legs.push({ uuid: r.uuid, params: { uuid: r.uuid, inbox: true } });
        break;
      case "no-heading":
        legs.push({ uuid: r.uuid, params: { uuid: r.uuid, noHeading: true } });
        break;
      case "loose":
        legs.push({ uuid: r.uuid, params: { uuid: r.uuid, loose: true } });
        break;
      default:
        break;
    }
  }
  return { legs };
}

/** The reorder scope the movees LAND in after a membership move. */
function todoLandingScope(
  deps: WriteDeps,
  dest: TodoMoveDestination,
  rows: MoveeRow[],
  packedToday: number,
): ScopeTarget {
  switch (dest.kind) {
    case "project": {
      if (dest.heading !== undefined) return { scope: null, reason: "under a heading" };
      const p = resolveProject(deps.db, dest.ref);
      return p.resolved !== null
        ? { scope: "project", container: p.resolved.uuid }
        : { scope: null, reason: "an unresolved project" };
    }
    case "heading":
      return { scope: null, reason: "under a heading" };
    case "area": {
      const a = resolveArea(deps.db, dest.ref);
      return a.resolved !== null
        ? { scope: "area", container: a.resolved.uuid }
        : { scope: null, reason: "an unresolved area" };
    }
    case "inbox":
      return { scope: "inbox" };
    case "no-heading": {
      // Lands in the CURRENT project's unheaded block.
      const container = rows[0]?.project ?? headingProjectOf(deps.db, rows[0]?.heading ?? null);
      return container !== null && container !== undefined
        ? { scope: "project", container }
        : { scope: null, reason: "no project" };
    }
    case "loose": {
      // Keeps the schedule; landing scope is schedule-based. Uniform → use it.
      const scopes = new Set(
        rows.map((r) => {
          const stripped: MoveeRow = { ...r, project: null, area: null, heading: null };
          return containerKey(todoReorderScope(stripped, packedToday));
        }),
      );
      if (scopes.size !== 1) return { scope: null, reason: "mixed loose buckets" };
      const stripped: MoveeRow = {
        ...(rows[0] as MoveeRow),
        project: null,
        area: null,
        heading: null,
      };
      return todoReorderScope(stripped, packedToday);
    }
    default:
      return { scope: null, reason: "app-default" };
  }
}

function headingProjectOf(db: DatabaseSync, headingUuid: string | null): string | null {
  if (headingUuid === null) return null;
  const r = db.prepare("SELECT project FROM TMTask WHERE uuid = ?").get(headingUuid) as
    | { project: string | null }
    | undefined;
  return r?.project ?? null;
}

// --------------------------------------------------------------- project move

export async function runProjectMove(
  deps: WriteDeps,
  request: ProjectMoveRequest,
  options: WriteOptions = {},
): Promise<MoveResult> {
  const op = "project.move" as const;
  const now = deps.now?.() ?? new Date();
  const packedToday = encodePackedDate(localToday(now));

  if (request.uuids.length === 0) {
    return refused(op, "usage", "no projects given — name at least one project to move");
  }

  const rows: MoveeRow[] = [];
  const wrongKind: { ref: string; kind: string }[] = [];
  for (const ref of request.uuids) {
    const r = resolveMovee(deps, ref);
    if (r instanceof ReferenceResolutionError) {
      return {
        kind: "move-refused",
        op,
        refusal: "usage",
        detail: r.message,
        candidates: r.candidates,
      };
    }
    const row = loadRow(deps.db, r.uuid);
    if (row === undefined) return refused(op, "usage", `no project matches "${ref}"`);
    if (row.type !== 1) wrongKind.push({ ref: r.uuid, kind: KIND_LABEL[row.type] ?? "item" });
    rows.push(row);
  }
  if (wrongKind.length > 0) {
    const list = wrongKind.map((w) => `${w.ref} (${w.kind})`).join(", ");
    return refused(
      op,
      "usage",
      `homogeneous movee kinds required — \`project move\` moves projects only, but these are not projects: ${list}`,
      "move to-dos with `todo move`",
    );
  }

  const dest = request.destination;
  const position = request.position;

  if (dest?.kind === "detach") {
    return refused(
      op,
      "usage",
      "`--detach` was removed. A project's detach is `--no-area` (a project has one containment level).",
    );
  }
  if (dest?.kind === "loose") {
    return refused(
      op,
      "usage",
      "`--loose` does not apply to a project — a project has a single containment level, so its " +
        "detach is `--no-area`. (`--loose` is a to-do's total sever.)",
    );
  }

  if (dest === undefined && position === undefined) {
    return refused(op, "usage", BARE_PROJECT_MOVE);
  }

  if (dest === undefined) {
    return repositionInPlace(deps, op, rows, position, packedToday, options, "move");
  }

  // Membership legs.
  const membership: MutationResult[] = [];
  for (const r of rows) {
    const params =
      dest.kind === "area"
        ? { uuid: r.uuid, area: dest.ref }
        : { uuid: r.uuid, noArea: true as const };
    const res = await runMutation(deps, "project.move", params, {
      ...legOptions(options),
      ...(options.dryRun === true && { dryRun: true }),
    });
    membership.push(res);
    if (res.kind !== "ok" && res.kind !== "dry-run") {
      return {
        kind: "move-leg-failed",
        op,
        detail: `moving ${r.uuid} failed (${res.kind})`,
        failed: res,
        completed: membership.slice(0, -1),
      };
    }
  }

  const landing = projectLandingScope(deps, dest, rows);
  return finishPlacement(deps, op, rows, landing, position, packedToday, options, membership);
}

function projectLandingScope(
  deps: WriteDeps,
  dest: ProjectMoveDestination,
  rows: MoveeRow[],
): ScopeTarget {
  if (dest.kind === "area") {
    const a = resolveArea(deps.db, dest.ref);
    return a.resolved !== null
      ? { scope: "area", container: a.resolved.uuid }
      : { scope: null, reason: "an unresolved area" };
  }
  // --no-area: the projects become area-less. Landing scope by schedule.
  const scopes = new Set(rows.map((r) => containerKey(projectReorderScope({ ...r, area: null }))));
  if (scopes.size !== 1) return { scope: null, reason: "mixed buckets" };
  return projectReorderScope({ ...(rows[0] as MoveeRow), area: null });
}

// ----------------------------------------------------------------- reorder verb

/**
 * `todo reorder` / `project reorder` — pure positioning within the movees'
 * CURRENT shared container+bucket. Bare (no position) assembles the movees as
 * a contiguous block at the EARLIEST movee's current slot, in argument order
 * (spec §4 — `--first` is NOT implied). Cross-container operands fail closed.
 */
export async function runInPlaceReorder(
  deps: WriteDeps,
  op: "todo.move" | "project.move",
  request: ReorderRequest,
  options: WriteOptions = {},
): Promise<MoveResult> {
  const now = deps.now?.() ?? new Date();
  const packedToday = encodePackedDate(localToday(now));
  const isTodo = op === "todo.move";

  if (request.uuids.length === 0) {
    return refused(op, "usage", "no items given — name at least one to reorder");
  }

  const rows: MoveeRow[] = [];
  const wrongKind: { ref: string; kind: string }[] = [];
  for (const ref of request.uuids) {
    const r = resolveMovee(deps, ref);
    if (r instanceof ReferenceResolutionError) {
      return {
        kind: "move-refused",
        op,
        refusal: "usage",
        detail: r.message,
        candidates: r.candidates,
      };
    }
    const row = loadRow(deps.db, r.uuid);
    if (row === undefined) return refused(op, "usage", `no item matches "${ref}"`);
    const want = isTodo ? 0 : 1;
    if (row.type !== want) wrongKind.push({ ref: r.uuid, kind: KIND_LABEL[row.type] ?? "item" });
    rows.push(row);
  }
  if (wrongKind.length > 0) {
    const list = wrongKind.map((w) => `${w.ref} (${w.kind})`).join(", ");
    return refused(
      op,
      "usage",
      `homogeneous kinds required — reorder ${isTodo ? "to-dos" : "projects"} only; not: ${list}`,
    );
  }

  return repositionInPlace(deps, op, rows, request.position, packedToday, options, "reorder");
}

// ---------------------------------------------------------------- shared core

/**
 * Reorder the given rows within their CURRENT shared container. Fails closed
 * when the rows span containers or (for --before/--after) the anchor lives
 * elsewhere or in another bucket.
 */
async function repositionInPlace(
  deps: WriteDeps,
  op: "todo.move" | "project.move",
  rows: MoveeRow[],
  position: MovePosition | undefined,
  packedToday: number,
  options: WriteOptions,
  verb: "move" | "reorder",
): Promise<MoveResult> {
  const isTodo = op === "todo.move";
  const scopeOf = (r: MoveeRow): ScopeTarget =>
    isTodo ? todoReorderScope(r, packedToday) : projectReorderScope(r);

  // One shared container (rule 2 / the cross-container guard).
  const keys = new Set(rows.map((r) => containerKey(scopeOf(r))));
  if (keys.size !== 1) {
    const where = rows.map((r) => `${r.uuid} in ${describeScope(scopeOf(r))}`).join("; ");
    return refused(
      op,
      "blocked",
      `the items span different containers (${where}), so they cannot be repositioned together`,
      verb === "move"
        ? "name an explicit destination (--to-project / --to-area / --no-heading / --loose) if you mean to MOVE them"
        : "reorder items that already share one container and bucket, or move them together first",
    );
  }
  const target = scopeOf(rows[0] as MoveeRow);
  if (target.scope === null) {
    return refused(
      op,
      "unsupported",
      `these items are in ${describeScope(target)} — no reorder protocol addresses that bucket yet`,
      "see the placement-honesty note in `things help move`",
    );
  }

  // All movees must share ONE bucket (rule 4 single-bucket-strict).
  const buckets = new Map<string, string[]>();
  for (const r of rows) {
    const b = scheduleBucket(r, packedToday);
    buckets.set(b, [...(buckets.get(b) ?? []), r.uuid]);
  }
  if (buckets.size > 1) {
    const listed = [...buckets.entries()].map(([b, u]) => `${b}: ${u.join(", ")}`).join("; ");
    return refused(
      op,
      "blocked",
      `the items are in different display buckets (${listed}) — a single reorder cannot span buckets`,
      "reorder within one bucket at a time, or use per-bucket --first/--last",
    );
  }

  // Anchor validation for --before/--after (rule 2/4).
  let anchorUuid: string | null = null;
  if (position !== undefined && ("before" in position || "after" in position)) {
    const anchorRef = "before" in position ? position.before : position.after;
    const ar = resolveMovee(deps, anchorRef);
    if (ar instanceof ReferenceResolutionError) {
      return {
        kind: "move-refused",
        op,
        refusal: "usage",
        detail: ar.message,
        candidates: ar.candidates,
      };
    }
    anchorUuid = ar.uuid;
    const anchorRow = loadRow(deps.db, anchorUuid);
    if (anchorRow === undefined)
      return refused(op, "usage", `the anchor "${anchorRef}" was not found`);
    if (containerKey(scopeOf(anchorRow)) !== containerKey(target)) {
      return refused(
        op,
        "blocked",
        `the anchor ${anchorUuid} is in ${describeScope(scopeOf(anchorRow))}, not the movees' ` +
          `container (${describeScope(target)}) — an anchor positions, it never migrates`,
        "move the items into the anchor's container explicitly, or pick an anchor that shares it",
      );
    }
    const anchorBucket = scheduleBucket(anchorRow, packedToday);
    const movBucket = [...buckets.keys()][0];
    if (anchorBucket !== movBucket) {
      return refused(
        op,
        "blocked",
        `the anchor is in the "${anchorBucket}" bucket but the movees are in "${movBucket}" — ` +
          "--before/--after require every movee to share the anchor's bucket",
        "use --first/--last (bucket-relative), or reorder within one bucket",
      );
    }
  }

  const movees = rows.map((r) => r.uuid);
  // Bare form (no position): assemble the block at the EARLIEST movee's current
  // slot in argument order (`--first` is NOT implied) — spec §4. A position
  // realizes first/last/before/after instead.
  const reorderUuids =
    position === undefined
      ? earliestSlotOrder(deps, target, movees)
      : buildReorderOrder(deps, target, movees, position);
  const reorderParams: ReorderParams = {
    scope: target.scope,
    uuids: reorderUuids,
    ...(target.container !== undefined && { container: { uuid: target.container } }),
  };
  const placement = await runReorder(deps, reorderParams, {
    ...legOptions(options),
    ...(options.dryRun === true && { dryRun: true }),
  });
  if (options.dryRun === true) {
    return {
      kind: "move-dry-run",
      op,
      plan: {
        movees,
        membership: "none (in-place reposition)",
        placement: `reorder scope=${target.scope}${target.container !== undefined ? ` container=${target.container}` : ""} → ${describePosition(position)}`,
        placementClass: "guaranteed",
        note: "in-place reorder within the shared container/bucket",
      },
    };
  }
  if (placement.kind !== "ok") {
    return {
      kind: "move-leg-failed",
      op,
      detail: `the reorder leg did not complete (${placement.kind})`,
      failed: placement,
      completed: [],
    };
  }
  return {
    kind: "move-ok",
    op,
    movees: rows.map((r) => ({ uuid: r.uuid, title: r.title })),
    membership: [],
    placement,
    placementClass: "guaranteed",
    note: `reordered within ${describeScope(target)} (${target.scope} scope — placement guaranteed)`,
  };
}

/**
 * The final placement step for a MEMBERSHIP move: reorder the movees within the
 * destination bucket when a protocol exists, else report app-default.
 */
async function finishPlacement(
  deps: WriteDeps,
  op: "todo.move" | "project.move",
  rows: MoveeRow[],
  landing: ScopeTarget,
  position: MovePosition | undefined,
  packedToday: number,
  options: WriteOptions,
  membership: MutationResult[],
): Promise<MoveResult> {
  const movees = rows.map((r) => r.uuid);
  const moveeTitles = rows.map((r) => ({ uuid: r.uuid, title: r.title }));

  // Anchor with a membership move: the anchor must be in the destination
  // (rule 2) and share the movees' bucket (rule 4). Validated against post-move
  // truth.
  if (position !== undefined && ("before" in position || "after" in position)) {
    if (landing.scope === null) {
      return {
        kind: "move-ok",
        op,
        movees: moveeTitles,
        membership,
        placement: null,
        placementClass: "app-default",
        note:
          `moved into ${describeScope(landing)}, which has no reorder protocol — --before/--after ` +
          "cannot be honored there; placement is app-default",
      };
    }
    const anchorRef = "before" in position ? position.before : position.after;
    const ar = resolveMovee(deps, anchorRef);
    if (ar instanceof ReferenceResolutionError) {
      return {
        kind: "move-refused",
        op,
        refusal: "usage",
        detail: `after moving, the anchor "${anchorRef}" did not resolve`,
        candidates: ar.candidates,
      };
    }
    const anchorRow = loadRow(deps.db, ar.uuid);
    const anchorScope =
      anchorRow === undefined
        ? null
        : op === "todo.move"
          ? containerKey(todoReorderScope(anchorRow, packedToday))
          : containerKey(projectReorderScope(anchorRow));
    if (anchorRow === undefined || anchorScope !== containerKey(landing)) {
      return refused(
        op,
        "blocked",
        `the anchor ${ar.uuid} is not in the destination container — an anchor positions, it never migrates`,
        "pick an anchor that lives in the destination, or use --first/--last",
      );
    }
    const anchorBucket = scheduleBucket(anchorRow, packedToday);
    const badBucket = rows.filter((r) => scheduleBucket(r, packedToday) !== anchorBucket);
    if (badBucket.length > 0) {
      const listed = rows.map((r) => `${r.uuid}: ${scheduleBucket(r, packedToday)}`).join("; ");
      return refused(
        op,
        "blocked",
        `--before/--after require every movee in the anchor's "${anchorBucket}" bucket, but: ${listed}`,
        "use --first/--last (per-bucket), or split the move by bucket",
      );
    }
  }

  if (landing.scope === null) {
    return {
      kind: "move-ok",
      op,
      movees: moveeTitles,
      membership,
      placement: null,
      placementClass: "app-default",
      note: `membership moved; landed in ${describeScope(landing)} — no reorder protocol addresses that bucket yet (app-default placement, see spec rule 5)`,
    };
  }

  if (options.dryRun === true) {
    return {
      kind: "move-dry-run",
      op,
      plan: {
        movees,
        membership: `${membership.length} membership leg(s)`,
        placement: `reorder scope=${landing.scope}${landing.container !== undefined ? ` container=${landing.container}` : ""} → ${describePosition(position)}`,
        placementClass: "guaranteed",
        note: "membership + top-of-bucket placement",
      },
    };
  }

  const reorderUuids = buildReorderOrder(deps, landing, movees, position);
  const placement = await runReorder(
    deps,
    {
      scope: landing.scope,
      uuids: reorderUuids,
      ...(landing.container !== undefined && { container: { uuid: landing.container } }),
    },
    legOptions(options),
  );
  if (placement.kind === "ok") {
    return {
      kind: "move-ok",
      op,
      movees: moveeTitles,
      membership,
      placement,
      placementClass: "guaranteed",
      note: `membership moved and placed top-of-bucket in ${describeScope(landing)} (guaranteed via the ${landing.scope} reorder protocol)`,
    };
  }
  // The membership already landed; the placement protocol was unavailable
  // (experimental off, or an app-side refusal). Honest degrade to app-default.
  return {
    kind: "move-ok",
    op,
    movees: moveeTitles,
    membership,
    placement,
    placementClass: "app-default",
    note:
      `membership moved into ${describeScope(landing)}, but the ${landing.scope} reorder protocol ` +
      `was unavailable (${placement.kind}${placement.kind === "blocked" ? `: ${placement.detail}` : ""}) — ` +
      "placement fell back to app-default; enable it with `things config set allow-experimental true`",
  };
}

/**
 * The full bucket order with the movees assembled as a contiguous block at the
 * EARLIEST movee's current slot (bare-reorder semantics, spec §4).
 */
function earliestSlotOrder(deps: WriteDeps, target: ScopeTarget, movees: string[]): string[] {
  const members = bucketMembers(deps, target);
  const moveeSet = new Set(movees);
  const earliest = members.findIndex((u) => moveeSet.has(u));
  if (earliest < 0) return movees;
  const before = members.slice(0, earliest).filter((u) => !moveeSet.has(u));
  const after = members.slice(earliest + 1).filter((u) => !moveeSet.has(u));
  return [...before, ...movees, ...after];
}

/** Build the reorder uuid list realizing the requested position. */
function buildReorderOrder(
  deps: WriteDeps,
  target: ScopeTarget,
  movees: string[],
  position: MovePosition | undefined,
): string[] {
  if (target.scope === null) return movees;
  // first / default → partial top-placement (reorder puts these at the top).
  if (position === undefined || ("at" in position && position.at === "first")) {
    return movees;
  }
  // last / before / after → a FULL re-rank: read the bucket order and splice.
  const members = bucketMembers(deps, target);
  const others = members.filter((u) => !movees.includes(u));
  if ("at" in position && position.at === "last") return [...others, ...movees];
  if ("before" in position || "after" in position) {
    const anchor = resolveMoveeUuid(deps, "before" in position ? position.before : position.after);
    const idx = others.indexOf(anchor);
    if (idx < 0) return [...others, ...movees];
    const insertAt = "before" in position ? idx : idx + 1;
    return [...others.slice(0, insertAt), ...movees, ...others.slice(insertAt)];
  }
  return movees;
}

function resolveMoveeUuid(deps: WriteDeps, ref: string): string {
  try {
    return resolveTaskUuidPrefix(deps.db, ref, "item");
  } catch {
    return ref;
  }
}

/** The current member order of a reorder bucket (for full re-rank builds). */
function bucketMembers(deps: WriteDeps, target: ScopeTarget): string[] {
  if (target.scope === null) return [];
  const params: ReorderParams = {
    scope: target.scope,
    uuids: [],
    ...(target.container !== undefined && { container: { uuid: target.container } }),
  };
  const containerUuid = target.container ?? null;
  const pre = computeReorderPre(deps.db, params, containerUuid, deps.now?.() ?? new Date());
  return pre.members.map((m) => m.uuid);
}

function legOptions(options: WriteOptions): WriteOptions {
  const legs: WriteOptions = {};
  if (options.maxDisruption !== undefined) legs.maxDisruption = options.maxDisruption;
  if (options.verifyTimeoutMs !== undefined) legs.verifyTimeoutMs = options.verifyTimeoutMs;
  if (options.actor !== undefined) legs.actor = options.actor;
  if (options.vector !== undefined) legs.vector = options.vector;
  if (options.acknowledgeProjectReopen !== undefined) {
    legs.acknowledgeProjectReopen = options.acknowledgeProjectReopen;
  }
  return legs;
}

function describeScope(target: ScopeTarget): string {
  if (target.scope === null) return target.reason;
  return target.container !== undefined
    ? `the ${target.scope} ${target.container}`
    : `the ${target.scope} list`;
}

function describePosition(position: MovePosition | undefined): string {
  if (position === undefined) return "top of bucket (default)";
  if ("at" in position) return position.at;
  if ("before" in position) return `before ${position.before}`;
  return `after ${position.after}`;
}
