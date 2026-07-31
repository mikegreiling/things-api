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
 *   5. placement honesty — "top of bucket" is GUARANTEED only where a lab-clean
 *      reorder protocol exists (REORDGAPS + BOUNCE2 + UPCORD1 + HEADSUB1): loose
 *      inbox/today/evening/someday/anytime, a project's unheaded anytime OR
 *      someday children, an area's anytime OR someday members, a heading's
 *      anytime/someday/same-day-scheduled children, any container child's evening
 *      sub-bucket, a container's same-day scheduled children, a loose future
 *      Upcoming day, area-less someday/anytime projects (see {@link
 *      reorderTargetOf} for the per-class protocol + gate). APP-DEFAULT (no
 *      protocol wired): a headed EVENING child (GUI-ambiguous axis), a direct-area
 *      scheduled-day child, a loose scheduled PROJECT row, repeating templates
 *      (§9e). The result states which class applied;
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
  /** Repeating TEMPLATE row: the private reorder no-ops on it (§9e addendum). */
  isTemplate: boolean;
}

function loadRow(db: DatabaseSync, uuid: string): MoveeRow | undefined {
  const row = db
    .prepare(
      "SELECT uuid, title, type, project, area, heading, start, startDate, startBucket, " +
        "rt1_recurrenceRule AS rule, repeater FROM TMTask WHERE uuid = ?",
    )
    .get(uuid) as (Omit<MoveeRow, "isTemplate"> & { rule: unknown; repeater: unknown }) | undefined;
  if (row === undefined) return undefined;
  const { rule, repeater, ...rest } = row;
  return { ...rest, isTemplate: rule !== null || repeater !== null };
}

const KIND_LABEL: Record<number, string> = { 0: "to-do", 1: "project", 2: "heading" };

/**
 * The display bucket a row sits in — the anchor single-bucket rule keys on it.
 *
 * DATE-FIRST precedence, mirroring the read layer's settled semantics
 * (src/read/stage.ts deriveStage, post-R10.2/R12): a `startDate` is classified
 * by its date BEFORE `start` is consulted, because the app's ONLY representation
 * of a future-scheduled item is `start=2` + a future `startDate` (UPC1 upcoming
 * cohort, BANNER1 scheduled arrivals; live prod scan 2026-07-30: 4/4
 * future-scheduled to-dos are start=2, zero are start=1+future). Classifying
 * `start===2 → someday` BEFORE the date check would mislabel every real
 * future-scheduled row as `someday` and route it to the someday protocols —
 * whose someday↔anytime bounce legs would CLEAR the item's date (a de-schedule).
 * So: inbox → dated (arrived → today/evening; future → scheduled:<date>) → then
 * `start===2` correctly means an UNDATED someday only → else anytime. An arrived
 * `start=2` (someday-scheduled, `startDate <= today`) is a Today+Anytime member,
 * so it buckets today/evening here, exactly as deriveStage derives `anytime`
 * with the Today marker.
 */
function scheduleBucket(row: MoveeRow, packedToday: number): string {
  if (row.start === 0) return "inbox";
  if (row.startDate !== null) {
    if (row.startDate <= packedToday) return row.startBucket === 1 ? "evening" : "today";
    return `scheduled:${row.startDate}`;
  }
  if (row.start === 2) return "someday";
  return "anytime";
}

/**
 * A placement target — which reorder protocol (if any) delivers "top of bucket"
 * for a row's current CONTAINER × display BUCKET, per the REORDGAPS verdicts
 * (docs/lab/reordgaps-results.md, spec §4 rule 5):
 *   - a `scope` → GUARANTEED (a lab-clean, non-destructive protocol exists);
 *   - `{ scope: null }` → APP-DEFAULT (no protocol wired for that bucket yet);
 *   - `prohibited` → a protocol exists but is DESTRUCTIVE (never attempt it).
 */
type ScopeTarget =
  | { scope: ReorderScope; container?: string }
  | { scope: null; reason: string; prohibited?: boolean };

/** An app-default target for a bounce-dependent placement while bounce is off. */
function bounceDisabledTarget(what: string): ScopeTarget {
  return {
    scope: null,
    reason:
      `${what} needs the when= bounce, which is disabled (bounce-enabled=false) — ` +
      "re-enable it with `things config set bounce-enabled true`",
  };
}

/**
 * The reorder protocol for a row's container × bucket, per the REORDGAPS +
 * BOUNCE2 verdicts (docs/lab/reordgaps-results.md, spec §4 rule 5). GUARANTEED:
 * loose inbox/today/evening/someday/anytime (ANYBNC bounce); a project's
 * unheaded anytime OR someday children (SOMEORD-b, native `index`); an area's
 * anytime members; an area's someday members (SOMEBNC-area bounce — was §9f-
 * prohibited); a heading's anytime children (BOUNCE2-h forward-order bounce); a
 * container's same-day scheduled children (DAYORD-b native todayIndex re-rank);
 * a loose FUTURE Upcoming day (UPCORD1 park-sort-unpark, scope `loose-day` —
 * gated like container-day); a heading's SOMEDAY children (HEADSUB1 heading-
 * someday re-head-in-order back-insert); a heading's same-day SCHEDULED children
 * (HEADSUB1 heading-day unhead→container-day→re-head, gated like container-day);
 * a container child's EVENING sub-bucket (HEADSUB1 Arm D — the shipped `evening`
 * bounce accepts project/area children unchanged); area-less someday projects;
 * top-level anytime projects. APP-DEFAULT: a headed EVENING child (display axis
 * GUI-ambiguous); a direct-area scheduled-DAY child (area specifier unprobed); a
 * loose scheduled PROJECT row (no surface); repeating TEMPLATE rows (§9e). When
 * bounce is DISABLED the bounce-dependent classes degrade to app-default naming
 * the flag — never a destructive or unverified fallback.
 */
function reorderTargetOf(
  row: MoveeRow,
  isTodo: boolean,
  packedToday: number,
  bounceEnabled: boolean,
): ScopeTarget {
  if (row.isTemplate) {
    return { scope: null, reason: "a repeating template (unreorderable — oddity §9e)" };
  }
  const bucket = scheduleBucket(row, packedToday);
  // A same-day (today-proper) or future scheduled day, startBucket=0 — the
  // DAYORD-b container todayIndex surface. The evening sub-bucket is distinct.
  const containerDay = bucket === "today" || bucket.startsWith("scheduled:");
  if (isTodo) {
    if (row.heading !== null) {
      // Within-heading order (HEADSUB1). anytime → the forward-order bounce
      // (BOUNCE2-h). someday → the re-head-in-order back-insert (heading-someday,
      // Arm B/C — pure URL move legs, no gate). same-day scheduled → the unhead →
      // container-day → re-head round-trip (heading-day, Arm C2 — gated like
      // container-day at runtime, since the direct native reorder RIPS the heading
      // FK, §9k). evening stays app-default (its display axis is GUI-ambiguous —
      // Arm B). --before/--after against an unmoved sibling rides these scopes'
      // co-touch (handled by the anchor path), not here.
      if (bucket === "anytime") {
        return bounceEnabled
          ? { scope: "heading", container: row.heading }
          : bounceDisabledTarget("within-heading order");
      }
      if (bucket === "someday") return { scope: "heading-someday", container: row.heading };
      if (containerDay) return { scope: "heading-day", container: row.heading };
      if (bucket === "evening") {
        return {
          scope: null,
          reason: "a heading's evening sub-bucket (display axis GUI-ambiguous — app-default)",
        };
      }
      return {
        scope: null,
        reason: `a heading's ${bucket} sub-bucket (no wired order surface for it)`,
      };
    }
    if (row.project !== null) {
      // Project unheaded: a same-day scheduled bucket re-ranks todayIndex via the
      // container specifier, date-preserving (DAYORD-b); the evening sub-bucket
      // stays app-default; everything else (anytime / someday / inbox) re-ranks
      // cleanly by index through the native project reorder (O04, SOMEORD-b).
      if (containerDay) return { scope: "container-day", container: row.project };
      if (bucket === "evening") {
        // HEADSUB1 Arm D: a container child's evening sub-bucket is the SAME front-
        // insert law as a loose evening item — the shipped `evening` bounce accepts
        // it unchanged (project FK + startBucket=1 + startDate preserved). Inherits
        // the R07 reminder-loss caveat the loose evening scope already carries.
        return bounceEnabled ? { scope: "evening" } : bounceDisabledTarget("evening-section order");
      }
      return { scope: "project", container: row.project };
    }
    if (row.area !== null) {
      // Area someday members: the SOMEBNC-area bounce (was §9f-prohibited via
      // the destructive area reorder command — the planner NEVER uses that).
      if (bucket === "someday") {
        return bounceEnabled
          ? { scope: "area-someday", container: row.area }
          : bounceDisabledTarget("an area's someday order");
      }
      if (bucket === "anytime") return { scope: "area", container: row.area };
      if (bucket === "evening") {
        // HEADSUB1 Arm D: a container child's evening sub-bucket rides the shipped
        // `evening` bounce (front-insert, container FK + startBucket=1 preserved);
        // an area-direct evening child is a container child too. R07 caveat inherited.
        return bounceEnabled ? { scope: "evening" } : bounceDisabledTarget("evening-section order");
      }
      // A direct-area to-do's scheduled bucket: only the PROJECT specifier is
      // lab-clean for a scheduled day (DAYORD-b); the AREA specifier's behavior
      // on dated children is unprobed (and de-somedays someday items, §9f), so
      // it stays app-default rather than risk it.
      return { scope: null, reason: "a direct-area to-do's scheduled bucket (app-default)" };
    }
    // loose:
    if (bucket === "inbox") return { scope: "inbox" };
    if (bucket === "someday") return { scope: "someday" };
    if (bucket === "today") return { scope: "today" };
    if (bucket === "evening") {
      return bounceEnabled ? { scope: "evening" } : bounceDisabledTarget("evening-section order");
    }
    if (bucket === "anytime") {
      // ANYBNC reverse-order bounce for area-less loose anytime to-dos.
      return bounceEnabled
        ? { scope: "anytime" }
        : bounceDisabledTarget("area-less loose anytime order");
    }
    // A loose FUTURE Upcoming day: the UPCORD1 park-sort-unpark protocol
    // (scratch PROJECT park → container-day reorder → unpark → trash). Gated by
    // allow-experimental like container-day (the pipeline / orchestrator explains
    // when the gate is off); NEVER routed through an area scratch (§9f).
    return { scope: "loose-day" };
  }
  // projects:
  if (row.area !== null) {
    return containerDay || bucket === "evening" || bucket === "someday"
      ? { scope: null, reason: "a scheduled/someday project inside an area (app-default)" }
      : { scope: "area", container: row.area };
  }
  if (bucket === "someday") return { scope: "someday" };
  if (bucket === "anytime") {
    // Top-level sidebar order is bounce-only (P8e).
    return bounceEnabled ? { scope: "projects" } : bounceDisabledTarget("top-level projects order");
  }
  return { scope: null, reason: "a scheduled day bucket (app-default)" };
}

/**
 * The STRUCTURAL container a row shares with its siblings — the rule-2 span key.
 * Distinct from the reorder target: two in-project to-dos with different
 * schedules share ONE structural container (their project) but different display
 * buckets (a rule-4 concern, not a rule-2 span).
 */
function structuralKey(row: MoveeRow, packedToday: number): string {
  if (row.heading !== null) return `heading:${row.heading}`;
  if (row.project !== null) return `project:${row.project}`;
  if (row.area !== null) return `area:${row.area}`;
  return `list:${scheduleBucket(row, packedToday)}`;
}

/** A stable key for a placement target (guaranteed scope, or its app/prohibited reason). */
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

  // Where the movees will LAND (computed pre-membership from the destination +
  // each movee's kept schedule) — drives the placement class and the pre-flight
  // anchor check.
  const landing = uniformLanding(
    rows.map((r) => todoLandedRow(deps, dest, r)),
    true,
    packedToday,
    deps.config.bounceEnabled,
  );
  // Fail-closed BEFORE any membership leg: an explicit --before/--after into a
  // destination bucket with no guaranteed protocol cannot be honored, so refuse
  // the whole move rather than move-then-drop-the-position (rule 5 honesty).
  const anchorRefusal = preflightAnchor(op, position, landing);
  if (anchorRefusal !== null) return anchorRefusal;

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

  return finishPlacement(deps, op, rows, landing, position, packedToday, options, membership);
}

/** Pre-flight refusal for an explicit anchor into a no-protocol destination bucket. */
function preflightAnchor(
  op: "todo.move" | "project.move",
  position: MovePosition | undefined,
  landing: ScopeTarget,
): MoveRefused | null {
  if (position === undefined || !("before" in position || "after" in position)) return null;
  // The ONLY remaining anchor refusal is a bucket with no reorder protocol at
  // all. Within-heading --before/--after IS supported now — the extended bounce
  // co-bounces the members between the block and the anchor (disclosed).
  if (landing.scope !== null) return null;
  return refused(
    op,
    landing.prohibited === true ? "blocked" : "unsupported",
    `--before/--after cannot be honored in the destination (${describeScope(landing)}) — ` +
      "no reorder protocol positions within that bucket",
    "use --first/--last, or omit the position (membership still lands)",
  );
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

/** The row a to-do BECOMES after a membership move (schedule kept unless it resets). */
function todoLandedRow(deps: WriteDeps, dest: TodoMoveDestination, row: MoveeRow): MoveeRow {
  switch (dest.kind) {
    case "project": {
      const p = resolveProject(deps.db, dest.ref);
      return {
        ...row,
        project: p.resolved?.uuid ?? null,
        area: null,
        heading: dest.heading !== undefined ? "landed-heading" : null,
      };
    }
    case "heading":
      // Under a heading — the exact heading uuid does not matter to the target
      // classifier (a heading bucket is app-default regardless); mark it headed.
      return { ...row, heading: "landed-heading", area: null };
    case "area": {
      const a = resolveArea(deps.db, dest.ref);
      return { ...row, area: a.resolved?.uuid ?? null, project: null, heading: null };
    }
    case "inbox":
      return { ...row, start: 0, startDate: null, project: null, area: null, heading: null };
    case "no-heading": {
      const container = row.project ?? headingProjectOf(deps.db, row.heading);
      return { ...row, project: container, area: null, heading: null };
    }
    case "loose":
      return { ...row, project: null, area: null, heading: null };
    default:
      return row;
  }
}

/** The uniform landing target across the movees (app-default when they diverge). */
function uniformLanding(
  landed: MoveeRow[],
  isTodo: boolean,
  packedToday: number,
  bounceEnabled: boolean,
): ScopeTarget {
  const targets = landed.map((r) => reorderTargetOf(r, isTodo, packedToday, bounceEnabled));
  const keys = new Set(targets.map(containerKey));
  return keys.size === 1
    ? (targets[0] as ScopeTarget)
    : {
        scope: null,
        reason: "the movees span display buckets in the destination (per-bucket app-default)",
      };
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

  const landedArea =
    dest.kind === "area" ? (resolveArea(deps.db, dest.ref).resolved?.uuid ?? null) : null;
  const landing = uniformLanding(
    rows.map((r) => ({ ...r, area: landedArea })),
    false,
    packedToday,
    deps.config.bounceEnabled,
  );
  const anchorRefusal = preflightAnchor(op, position, landing);
  if (anchorRefusal !== null) return anchorRefusal;

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

  return finishPlacement(deps, op, rows, landing, position, packedToday, options, membership);
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
  const targetOf = (r: MoveeRow): ScopeTarget =>
    reorderTargetOf(r, isTodo, packedToday, deps.config.bounceEnabled);

  // One shared STRUCTURAL container (rule 2 / the cross-container guard).
  const keys = new Set(rows.map((r) => structuralKey(r, packedToday)));
  if (keys.size !== 1) {
    const where = rows.map((r) => `${r.uuid} in ${describeScope(targetOf(r))}`).join("; ");
    return refused(
      op,
      "blocked",
      `the items span different containers (${where}), so they cannot be repositioned together`,
      verb === "move"
        ? "name an explicit destination (--to-project / --to-area / --no-heading / --loose) if you mean to MOVE them"
        : "reorder items that already share one container and bucket, or move them together first",
    );
  }
  const target = targetOf(rows[0] as MoveeRow);
  if (target.scope === null) {
    // A prohibited bucket has a destructive protocol we NEVER attempt (§9f); an
    // app-default bucket simply has no wired protocol. Both refuse a reorder
    // (an explicit rearrange we cannot honor honestly), but with distinct copy.
    return refused(
      op,
      target.prohibited === true ? "blocked" : "unsupported",
      target.prohibited === true
        ? `these items are ${describeScope(target)} — reordering them there is destructive, so it is refused`
        : `these items are in ${describeScope(target)} — no reorder protocol addresses that bucket yet`,
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
    if (structuralKey(anchorRow, packedToday) !== structuralKey(rows[0] as MoveeRow, packedToday)) {
      return refused(
        op,
        "blocked",
        `the anchor ${anchorUuid} is in ${describeScope(targetOf(anchorRow))}, not the movees' ` +
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
    named: movees,
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
        note: dryRunNote(placement, "in-place reorder within the shared container/bucket"),
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
    note:
      `reordered within ${describeScope(target)} (${target.scope} scope — placement guaranteed)` +
      touchedSuffix(placement),
  };
}

/** Honest disclosure suffix naming co-bounced siblings an anchor placement touched. */
function touchedSuffix(placement: ReorderResult): string {
  if (
    placement.kind !== "ok" ||
    placement.touched === undefined ||
    placement.touched.length === 0
  ) {
    return "";
  }
  return `; also re-inserted ${placement.touched.length} unnamed sibling(s) to honor the anchor: ${placement.touched.join(", ")}`;
}

/** Dry-run note that surfaces the planned co-bounce touch count. */
function dryRunNote(placement: ReorderResult, base: string): string {
  if (placement.kind === "dry-run") return `${base} — ${placement.plan.invocation}`;
  return base;
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
  // truth. When the destination bucket has no guaranteed protocol we now REFUSE
  // an explicit --before/--after (we KNOW no honest spelling exists there —
  // HEADORD-b/§9f) rather than silently app-default it.
  if (position !== undefined && ("before" in position || "after" in position)) {
    if (landing.scope === null) {
      return refused(
        op,
        landing.prohibited === true ? "blocked" : "unsupported",
        `moved into ${describeScope(landing)} — --before/--after cannot be honored there; ` +
          "no reorder protocol positions within that bucket",
        "use --first/--last, or omit the position (membership still lands)",
      );
    }
    const destStructural =
      landing.container !== undefined
        ? `${landing.scope}:${landing.container}`
        : `list:${landing.scope}`;
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
    if (anchorRow === undefined || structuralKey(anchorRow, packedToday) !== destStructural) {
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
    // Membership landed; the destination bucket has no guaranteed protocol (or a
    // prohibited/destructive one we never attempt) — app-default placement, honest.
    return {
      kind: "move-ok",
      op,
      movees: moveeTitles,
      membership,
      placement: null,
      placementClass: "app-default",
      note:
        `membership moved; landed in ${describeScope(landing)} — ` +
        (landing.prohibited === true
          ? "ordering there is destructive so it was NOT attempted (the app placed it); "
          : "no reorder protocol addresses that bucket yet; ") +
        "app-default placement (spec rule 5)",
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
      named: movees,
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
      note:
        `membership moved and placed top-of-bucket in ${describeScope(landing)} (guaranteed via the ${landing.scope} reorder protocol)` +
        touchedSuffix(placement),
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
  const members = bucketMembers(deps, target, movees[0]);
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
  const members = bucketMembers(deps, target, movees[0]);
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

/**
 * The current member order of a reorder bucket (for full re-rank builds). The
 * container-day and loose-day scopes read their day off the FIRST requested
 * uuid (a day-group is keyed by a movee's startDate, not by a container), so
 * `dayAnchor` (a movee) seeds the enumeration for them — without it those two
 * scopes enumerate nothing and an anchored (--last/--before/--after) placement
 * cannot splice against the real day order.
 */
function bucketMembers(deps: WriteDeps, target: ScopeTarget, dayAnchor?: string): string[] {
  if (target.scope === null) return [];
  const seedsDay = target.scope === "container-day" || target.scope === "loose-day";
  const params: ReorderParams = {
    scope: target.scope,
    uuids: seedsDay && dayAnchor !== undefined ? [dayAnchor] : [],
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
  if (target.scope === "loose-day") return "the loose future-day group";
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
