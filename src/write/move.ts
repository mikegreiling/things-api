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
 *      reorder protocol exists (REORDGAPS + BOUNCE2 + UPCORD1 + HEADSUB1 +
 *      ORDFIN1): loose inbox/today/evening/someday/anytime, a project's unheaded
 *      anytime OR someday children, an area's anytime OR someday members, a
 *      heading's anytime/someday/same-day-scheduled children, ANY container child's
 *      evening sub-bucket (project, area, OR headed — ORDFIN1 Arm 2b), a
 *      container's same-day scheduled children, a loose / direct-area (ORDFIN1 Arm
 *      3) / whole cross-container (ORDFIN1 Arm 4) future Upcoming day, area-less
 *      someday/anytime projects (see {@link reorderTargetOf} for the per-class
 *      protocol + gate). APP-DEFAULT (no protocol wired): a loose scheduled
 *      PROJECT row, repeating templates (§9e). The result states which class
 *      applied;
 *   6. compilation via the minimal-move planner (fewest legs; per-scope caps and
 *      bounce abort-honesty apply per leg).
 */
import type { DatabaseSync } from "node:sqlite";

import { addDaysIso, decodePackedDate, encodePackedDate, localToday } from "../model/dates.ts";
import { ReferenceResolutionError, resolveTaskUuidPrefix } from "../read/queries.ts";
import type { CandidateRef } from "../read/shape.ts";
import { taskMembershipClause } from "../read/scope.ts";
import { isLooseRef, LOOSE_TO_AREA_REFUSAL } from "../read/pseudo-area.ts";
import { computeReorderPre, resolveArea, resolveHeading, resolveProject } from "./pre-state.ts";
import type { ContainerRef, ReorderParams, ReorderScope, TodoMoveParams } from "./operations.ts";
import { type MutationResult, type WriteDeps, type WriteOptions } from "./pipeline.ts";
import type { VectorId } from "./vectors/types.ts";
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

/** A pure reposition (`things reorder` — the kind-neutral in-place verb). */
export interface ReorderRequest {
  uuids: string[];
  position?: MovePosition;
  /**
   * Axis / container disambiguation for a DUAL-AXIS reorder (`reorder --in`). A
   * Today/Evening member has a `todayIndex` slot in the Today view AND an `index`
   * slot in its container (a project/area/heading child, or the loose Anytime
   * bucket), so a bare reorder of a set coherent on BOTH axes is refused; `in`
   * names the axis:
   *   - `"today"` | `"evening"` — the view's cross-container `todayIndex` axis;
   *   - `"anytime"` | `"someday"` | `"inbox"` — a loose list axis;
   *   - a project/area/heading ref (uuid or unique title) — that container's
   *     `index` axis.
   * `"loose"` is NOT accepted (it is a read view, not a reorder bucket). Forcing
   * the container index axis on a Today member is honored ONLY where the native
   * project/area re-rank preserves the flag; a bounce-only index axis (a heading
   * child, the loose Anytime bucket) is refused (it would de-Today the row).
   */
  in?: string;
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
  candidates?: CandidateRef[];
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
  /** Packed `deadline` day — the deadline-forecast day-block axis key (DLBNC/§9o). */
  deadline: number | null;
  /** Repeating TEMPLATE row: the private reorder no-ops on it (§9e addendum). */
  isTemplate: boolean;
}

function loadRow(db: DatabaseSync, uuid: string): MoveeRow | undefined {
  const row = db
    .prepare(
      "SELECT uuid, title, type, project, area, heading, start, startDate, startBucket, deadline, " +
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
/**
 * The packed startDate of TOMORROW (the day after `packedToday`). Packed dates
 * are bit-fields, not integers, so tomorrow is NOT packedToday+1 across a month/
 * year boundary — decode → +1 calendar day → re-encode. Feeds the ORDFIN2
 * TOMORROWLIST fast path (a future day-group whose day == tomorrow rides the
 * native `list "Tomorrow"` one-call sort, not the scratch-park compound).
 */
function packedTomorrowOf(packedToday: number): number {
  const iso = decodePackedDate(packedToday);
  return iso === null ? packedToday : encodePackedDate(addDaysIso(iso, 1));
}

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
 * The packed future-deadline day of a DEADLINE-FORECAST row (DLBNC / #383, #385),
 * or null. The §9o forecast cohort: a to-do (type=0) OR project (type=1) with NO
 * `startDate`, someday/anytime stage (`start IN (1,2)`), and a strictly-FUTURE
 * `deadline` rests on that deadline day's ROOT Upcoming day-block on the shared
 * `todayIndex` axis (UPCDL-1a/§9o, GUI-confirmed DLBNC-1d; forecast PROJECTS carry
 * the axis identically — PROJDL-2a/2b/2c, #385). It reorders there via the deadline-
 * cycle (URL `deadline=` clear + re-set — `update` for a to-do, `update-project`
 * for a project), NOT the someday/anytime `index` lever — so the planner routes it
 * to the `day` scope keyed on the deadline. INBOX-stage rows (`start=0`) rest OFF
 * the axis (todayIndex=0) — excluded here; a today/past deadline is NOT a future
 * day-block (the row renders in its someday/anytime bucket with an overdue badge) —
 * excluded, matching the strictly-future gate scheduled rows use. Headings (type=2)
 * are excluded. PROJSTAR-safe: the project deadline-cycle never flips `start` to 1
 * (no accidental Today star) and preserves `index`/area-FK/tags (PROJDL-2b/2b').
 */
function forecastDeadlineDay(row: MoveeRow, packedToday: number): number | null {
  if (row.type !== 0 && row.type !== 1) return null;
  if (row.startDate !== null) return null;
  if (row.start !== 1 && row.start !== 2) return null;
  if (row.deadline === null || row.deadline <= packedToday) return null;
  return row.deadline;
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
  | { scope: ReorderScope; container?: string; day?: number }
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
 * container's UNHEADED same-day scheduled children (DAYORD-b native todayIndex re-
 * rank — the single-project degenerate case); ANY OTHER future day-group — loose,
 * direct-area, headed, cross-container, or any mix incl. AREA-LESS scheduled
 * PROJECT rows — via the SIT4 dated `day` bounce (cross-date re-when round-trip,
 * per-type legs, reminder/deadline/heading-FK preserving; the one-call `tomorrow`
 * sort when the day is tomorrow); a heading's SOMEDAY children (HEADSUB1 heading-
 * someday re-head-in-order back-insert); a container child's EVENING sub-bucket,
 * to-do OR project (HEADSUB1 Arm D + ORDFIN1 Arm 2b + SIT4 EVEORD — the shipped
 * `evening` bounce accepts project/area/HEADED movees, heading FK preserved,
 * projects share the evening axis); area-less someday projects; top-level anytime
 * projects. APP-DEFAULT: an AREA project's future-day cell (only area-less project
 * rows are proven — SIT4 DAYBNC); repeating TEMPLATE rows (§9e). When bounce is
 * DISABLED the bounce-dependent classes degrade to app-default naming the flag —
 * never a destructive or unverified fallback.
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
  // NB: for a to-do an ARRIVED day (today-proper) is intercepted at the top of
  // the isTodo block and routed to the today scope (it is a Today-view member,
  // not a day-group member); the today-proper disjunct here only bears on the
  // projects path below (where an arrived scheduled project stays app-default).
  const containerDay = bucket === "today" || bucket.startsWith("scheduled:");
  // The packed scheduled day, threaded into the future day-group targets so their
  // refusal / disclosure copy names the DATE — a day-group's identity IS its day
  // (two rows on different days are different groups). Reached only for strictly-
  // future scheduled rows below, so startDate is non-null there.
  const dayField: { day?: number } = row.startDate !== null ? { day: row.startDate } : {};
  // ORDFIN2 TOMORROWLIST: a row scheduled for TOMORROW (startBucket=0) rides the
  // native one-call `list "Tomorrow"` day-sort instead of the SIT4 dated `day`
  // bounce. It re-ranks the whole cross-container tomorrow group on todayIndex,
  // projects included, preserving startDate/FKs (no §9g re-date) — cheaper than
  // the 2N-leg bounce. The single-project container-day path keeps its own native
  // re-rank; HEADED children never ride the native sort (it RIPS a heading, §9k),
  // so they take the dated bounce even on tomorrow.
  const isTomorrow = row.startBucket === 0 && row.startDate === packedTomorrowOf(packedToday);
  if (isTodo) {
    // DEADLINE-FORECAST members route FIRST (DLBNC / #383). A someday/anytime-stage
    // to-do (no startDate) with a future deadline is a first-class member of that
    // deadline day's Upcoming block — it reorders on the block's todayIndex axis via
    // the deadline-cycle (URL deadline= clear + re-set), never the someday/anytime
    // index lever. ALWAYS the `day` scope keyed on the deadline — NEVER the native
    // `list "Tomorrow"` sort even when the deadline is tomorrow, because that surface
    // RE-DATES a forecast row (stamps a startDate, UPCDL-5), ejecting it from the
    // forecast cohort. The deadline-cycle is public-URL-only (no experimental gate).
    const fDay = forecastDeadlineDay(row, packedToday);
    if (fDay !== null) return { scope: "day", day: fDay };
    // ARRIVED Today-view members route DATE-FIRST, before any container branch.
    // A dated row whose day has landed (startDate <= today) is a Today member —
    // the GUI renders arrived/today-dated rows in the TODAY view; the Upcoming
    // day-groups hold STRICTLY FUTURE dates only. So it reorders via the shipped
    // cross-container today/evening scopes exactly like an undated Today member,
    // regardless of its container (loose, project-, heading-, or area-child).
    // `scheduleBucket` already classifies arrived rows date-first (#325 — arrived
    // → today/evening, future → scheduled:<date>), so route on its verdict
    // (single-source, no re-derive). Only strictly-future dates fall through to
    // the per-container day-groups below. This is the same class of bug #325 fixed
    // in `scheduleBucket`: classifying by date-group before checking arrived-ness
    // misrouted an arrived member into a future day-group compound.
    if (bucket === "today") return { scope: "today" };
    if (bucket === "evening") {
      // Evening flag is live (startBucket=1) only while startDate == today (§9n);
      // scheduleBucket already gates this — an arrived evening member front-inserts
      // via the shipped `evening` bounce (container FK + startBucket=1 preserved,
      // R07 reminder-loss caveat inherited). Same scope for loose and every child.
      return bounceEnabled ? { scope: "evening" } : bounceDisabledTarget("evening-section order");
    }
    if (row.heading !== null) {
      // Within-heading order (HEADSUB1). anytime → the forward-order bounce
      // (BOUNCE2-h). someday → the re-head-in-order back-insert (heading-someday,
      // Arm B/C — pure URL move legs, no gate). FUTURE same-day scheduled → the
      // SIT4 dated `day` bounce (it preserves the heading FK, §2e/R21 — no unhead/
      // re-head round-trip needed). --before/--after against an unmoved sibling
      // rides these scopes' co-touch (handled by the anchor path), not here.
      if (bucket === "anytime") {
        return bounceEnabled
          ? { scope: "heading", container: row.heading }
          : bounceDisabledTarget("within-heading order");
      }
      if (bucket === "someday") return { scope: "heading-someday", container: row.heading };
      // A heading's same-day SCHEDULED children ride the `day` dated bounce — SIT4
      // DAYBNC proved the cross-date round-trip preserves the heading FK byte-
      // identical and lands a headed child exactly, so the former heading-day
      // unhead→container-day→re-head round-trip is gone. Container-less: `day` is a
      // GLOBAL cross-container axis. Headed rows NEVER ride the native tomorrow
      // sort (the private reorder RIPS a headed child, §9k/O06), so even on tomorrow
      // a headed child bounces.
      if (containerDay) return { scope: "day", ...dayField };
      return {
        scope: null,
        reason: `a heading's ${bucket} sub-bucket (no wired order surface for it)`,
      };
    }
    if (row.project !== null) {
      // Project unheaded: a FUTURE same-day scheduled bucket re-ranks todayIndex via
      // the container specifier, date-preserving (DAYORD-b); everything else
      // (anytime / someday) re-ranks cleanly by index through the native project
      // reorder (O04, SOMEORD-b).
      if (containerDay) return { scope: "container-day", container: row.project, ...dayField };
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
      // A direct-area to-do's FUTURE scheduled DAY rides the `day` dated bounce
      // (SIT4 DAYBNC — the when= round-trip preserves the area FK and needs no
      // scratch project; container-less GLOBAL axis), or the one-call `list
      // "Tomorrow"` sort when the day is tomorrow.
      if (containerDay)
        return isTomorrow ? { scope: "tomorrow", ...dayField } : { scope: "day", ...dayField };
      return { scope: null, reason: "a direct-area to-do's scheduled bucket (app-default)" };
    }
    // loose:
    if (bucket === "inbox") return { scope: "inbox" };
    if (bucket === "someday") return { scope: "someday" };
    if (bucket === "anytime") {
      // ANYBNC reverse-order bounce for area-less loose anytime to-dos.
      return bounceEnabled
        ? { scope: "anytime" }
        : bounceDisabledTarget("area-less loose anytime order");
    }
    // A loose FUTURE Upcoming day rides the `day` dated bounce (SIT4 DAYBNC — the
    // reverse-target when= round-trip front-inserts on the global todayIndex axis,
    // no scratch project, no experimental gate), or the one-call `list "Tomorrow"`
    // sort when the day is tomorrow.
    return isTomorrow ? { scope: "tomorrow", ...dayField } : { scope: "day", ...dayField };
  }
  // projects:
  // ARRIVED Today-view members route DATE-FIRST (mirrors the to-do path, #341). An
  // arrived today-dated project is a Today member — the native Today reorder
  // accepts projects intermixed (O12); an arrived This-Evening project rides the
  // shipped `evening` bounce (SIT4 EVEORD — projects share the evening todayIndex
  // axis, R07 reminder-loss caveat inherited). Only STRICTLY-FUTURE project rows
  // fall through to the day-group / app-default routing below.
  if (bucket === "today") return { scope: "today" };
  if (bucket === "evening") {
    return bounceEnabled ? { scope: "evening" } : bounceDisabledTarget("evening-section order");
  }
  if (row.area !== null) {
    // A project INSIDE an area on a strictly-future day now rides the dated `day`
    // bounce (SIT5 AREAPROJDAY — the update-project when= legs preserve the area FK
    // and re-enter at the day's global todayIndex min), or the one-call Tomorrow
    // sort when the day is tomorrow. Someday stays app-default; anytime rides the
    // area's native index order.
    if (containerDay)
      return isTomorrow ? { scope: "tomorrow", ...dayField } : { scope: "day", ...dayField };
    return bucket === "someday"
      ? { scope: null, reason: "a someday project inside an area (app-default)" }
      : { scope: "area", container: row.area };
  }
  if (bucket === "someday") return { scope: "someday" };
  if (bucket === "anytime") {
    // Top-level sidebar order is bounce-only (P8e).
    return bounceEnabled ? { scope: "projects" } : bounceDisabledTarget("top-level projects order");
  }
  // An AREA-LESS scheduled PROJECT row on a strictly-future day: the dated `day`
  // bounce (SIT4 DAYBNC — DP rows front-insert on the shared todayIndex axis via
  // update-project), or the one-call `list "Tomorrow"` sort when the day is
  // tomorrow. This is the loose-scheduled-PROJECT-row cell, formerly app-default.
  if (containerDay)
    return isTomorrow ? { scope: "tomorrow", ...dayField } : { scope: "day", ...dayField };
  return { scope: null, reason: "a scheduled day bucket (app-default)" };
}

// ------------------------------------------------------ reorder axis (`--in`)
//
// A Today/Evening member is DUAL-AXIS: it has a `todayIndex` slot in the Today/
// Evening view AND an `index` slot in its container (a project/area/heading child)
// or the loose Anytime bucket. `things reorder` refuses a set coherent on BOTH
// axes unless `--in` picks one — replacing the old silent always-Today resolution.
//   today | evening        -> the view's cross-container `todayIndex` axis;
//   anytime|someday|inbox   -> a loose list axis (only for genuinely-loose members;
//                              forcing it on a Today member de-Todays it -> refused);
//   <project/area/heading>  -> that container's `index` axis. Honored on a Today
//                              member ONLY for the native project/area re-rank
//                              (Today-flag-safe: writes only `index`, sit3 EVEPROJ /
//                              DAYORD-b); a heading child's index axis is a when=
//                              bounce that de-Todays -> refused.

type InAxis = "today" | "evening" | "anytime" | "someday" | "inbox";
const IN_AXES: readonly InAxis[] = ["today", "evening", "anytime", "someday", "inbox"];

/**
 * The INDEX-axis reorder target of a row — the target it has through its CONTAINER
 * (a project/area/heading `index`, or the loose Anytime bucket), IGNORING any
 * Today/Evening membership. For a dual-axis row this is the alternative to its
 * view-axis (today/evening) target; computed by classifying the row as if it sat
 * in its container's ANYTIME bucket (start=1, no startDate — date-independent, so
 * the packedToday argument is irrelevant here).
 */
function indexAxisTargetOf(row: MoveeRow, bounceEnabled: boolean): ScopeTarget {
  const asAnytime: MoveeRow = { ...row, start: 1, startDate: null, startBucket: 0 };
  // Classify by the row's REAL kind — a project's index axis is its area / the
  // sidebar (`projects`), NOT the loose Anytime to-do list. Conflating them (an
  // isTodo=true hardcode) makes a mixed to-do+project Today block look like ONE
  // shared loose index bucket and spuriously "dual-axis ambiguous".
  return reorderTargetOf(asAnytime, row.type === 0, 0, bounceEnabled);
}

/**
 * The INDEX-axis reorder target of a DEADLINE-FORECAST row (§9o dual-citizen) —
 * its container's someday/anytime `index` order, the alternative to its Upcoming
 * day-block todayIndex axis. Classified by STRIPPING the deadline so
 * reorderTargetOf routes to the container index (someday/anytime/project/area/
 * heading-someday), never the `day` scope the forecast day-block routes to. Used
 * both to name the container spelling in the dual-axis refusal and to classify a
 * forecast row that an explicit `--in <container>` / `--in someday|anytime` forces
 * onto its index axis (the bug-fix: `--in` must never be overridden by the day
 * auto-route).
 */
function forecastIndexTargetOf(
  row: MoveeRow,
  packedToday: number,
  bounceEnabled: boolean,
): ScopeTarget {
  return reorderTargetOf({ ...row, deadline: null }, row.type === 0, packedToday, bounceEnabled);
}

/**
 * True when a row's INDEX-axis target preserves the Today/Evening flag. TWO
 * flag-safe families:
 *   - the NATIVE project/area `index` re-rank writes only `index` (startBucket/
 *     startDate kept — sit3 EVEPROJ / DAYORD-b);
 *   - the SIT6 flag-safe MOVE protocols route a FLAGGED touched set off the
 *     de-Today bounce onto the URL move family (heading→HEADMOVE, loose anytime→
 *     LOOSEPARK, area-less sidebar projects→PROJPARK), which preserve the flag +
 *     reminder + deadline. So the heading / anytime / projects index axes are now
 *     honest alternatives for a Today/Evening member too.
 * This is consulted only where the index target's scope is non-null; when bounce
 * is disabled those scopes degrade to `{ scope: null }` upstream, so no unsafe
 * bounce is ever offered.
 */
function indexAxisTodaySafe(target: ScopeTarget): boolean {
  return (
    target.scope === "project" ||
    target.scope === "area" ||
    target.scope === "heading" ||
    target.scope === "anytime" ||
    target.scope === "projects"
  );
}

/** A row's Today/Evening view, or null when it is not an arrived view member. */
function viewOf(row: MoveeRow, packedToday: number): "today" | "evening" | null {
  const b = scheduleBucket(row, packedToday);
  return b === "today" || b === "evening" ? b : null;
}

/** The container uuid a row's INDEX axis lives in (most-specific), or null (loose). */
function indexAxisContainerOf(row: MoveeRow): string | null {
  return row.heading ?? row.project ?? row.area ?? null;
}

/** A container's display title (for the `--in <title>` spelling), else its uuid. */
function containerLabel(deps: WriteDeps, uuid: string): string {
  const r = deps.db.prepare("SELECT title FROM TMTask WHERE uuid = ?").get(uuid) as
    | { title: string | null }
    | undefined;
  return r?.title ?? uuid;
}

/** The kind of a resolved `--in` container uuid. */
function containerKindOf(deps: WriteDeps, uuid: string): "project" | "area" | "heading" {
  const t = deps.db.prepare("SELECT type FROM TMTask WHERE uuid = ?").get(uuid) as
    | { type: number }
    | undefined;
  if (t?.type === 1) return "project";
  if (t?.type === 2) return "heading";
  return "area";
}

/** A short phrase naming the display bucket(s) the set currently sits in. */
function describeSetLocation(rows: MoveeRow[], packedToday: number): string {
  const buckets = [...new Set(rows.map((r) => scheduleBucket(r, packedToday)))];
  return `in the ${buckets.join(" / ")} bucket`;
}

/** The DIRECT container a row sits in, named for a refusal (its title, or "the loose list"). */
function describeDirectContainer(deps: WriteDeps, row: MoveeRow): string {
  const c = indexAxisContainerOf(row);
  return c === null ? "the loose list" : `"${containerLabel(deps, c)}"`;
}

/** Per-movee day membership (`uuid on YYYY-MM-DD`, or off-day), for the `--in upcoming` spread refusal. */
function describeDayMembership(rows: MoveeRow[], packedToday: number): string {
  return rows
    .map((r) => {
      const k = rowDayKey(r, packedToday);
      return k === null ? `${r.uuid} (not on a future day)` : `${r.uuid} on ${decodePackedDate(k)}`;
    })
    .join("; ");
}

type ParsedIn =
  | { axis: InAxis }
  // The DAY axis (the Upcoming day-block todayIndex axis) — the alternative to a
  // forecast row's container index (§9o dual-citizen). `day` is a specific block
  // (`--in YYYY-MM-DD`); `upcoming` is the proxy for the one future day the whole
  // set shares (derived via `sharedFutureDay`). Both route to `runDayGroupReposition`.
  | { day: number }
  | { upcoming: true }
  | { container: { uuid: string; kind: "project" | "area" | "heading" } }
  | { error: string };

/** Parse a raw `--in <target>` into a list axis, a day-axis token, or a container ref. */
function parseInTarget(deps: WriteDeps, raw: string, rows: MoveeRow[]): ParsedIn {
  const norm = raw.trim().toLowerCase();
  if ((IN_AXES as readonly string[]).includes(norm)) return { axis: norm as InAxis };
  // Day-axis tokens (checked before container resolution so an ISO date is never
  // read as a container title). `upcoming` is the shared-future-day proxy; a
  // YYYY-MM-DD names one exact Upcoming day-block.
  if (norm === "upcoming") return { upcoming: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
    try {
      return { day: encodePackedDate(norm) };
    } catch {
      return { error: `--in "${raw}" is not a valid calendar date (expected YYYY-MM-DD)` };
    }
  }
  if (norm === "loose") {
    return {
      error:
        '`--in loose` is not valid — "loose" is a read view, not a reorder bucket; ' +
        "use --in anytime / --in someday, or a project/area/heading ref",
    };
  }
  // A raw uuid that IS a movee's own container (project/area/heading).
  const ownContainers = new Set(
    rows.map(indexAxisContainerOf).filter((u): u is string => u !== null),
  );
  if (ownContainers.has(raw)) {
    return { container: { uuid: raw, kind: containerKindOf(deps, raw) } };
  }
  const p = resolveProject(deps.db, { title: raw });
  if (p.resolved?.uuid !== undefined) {
    return { container: { uuid: p.resolved.uuid, kind: "project" } };
  }
  const a = resolveArea(deps.db, { title: raw });
  if (a.resolved?.uuid !== undefined) {
    return { container: { uuid: a.resolved.uuid, kind: "area" } };
  }
  // A heading, resolved within the movees' shared project.
  const proj = rows[0]?.project ?? headingProjectOf(deps.db, rows[0]?.heading ?? null);
  if (proj !== null && proj !== undefined) {
    const h = resolveHeading(deps.db, proj, raw);
    if (h.resolved?.uuid !== undefined) {
      return { container: { uuid: h.resolved.uuid, kind: "heading" } };
    }
  }
  return {
    error:
      `--in "${raw}" did not resolve to a project, area, or heading ` +
      "(or one of today | evening | anytime | someday | inbox | upcoming | a YYYY-MM-DD day)",
  };
}

type AxisResolution =
  | { targetOf: (r: MoveeRow) => ScopeTarget; indexAxis?: boolean }
  // The DAY axis was named explicitly (`--in <YYYY-MM-DD>` / `--in upcoming`):
  // route straight to `runDayGroupReposition` on this packed day. Membership +
  // future-ness are already validated here.
  | { dayAxis: number }
  | { refused: MoveRefused };

/**
 * Resolve the reorder AXIS for a `things reorder` set per `--in` (the ratified
 * axis-disambiguation contract). Returns a per-row target classifier, or a
 * refusal. The `todo move` anchor-implied reposition (verb !== "reorder") keeps
 * its prior single-axis behavior — no `--in`, no ambiguity gate.
 */
function resolveReorderAxis(
  deps: WriteDeps,
  op: "todo.move" | "project.move",
  rows: MoveeRow[],
  inTarget: string | undefined,
  packedToday: number,
  verb: "move" | "reorder",
  position: MovePosition | undefined,
): AxisResolution {
  const isTodo = op === "todo.move";
  const bounceEnabled = deps.config.bounceEnabled;
  const base = (r: MoveeRow): ScopeTarget => reorderTargetOf(r, isTodo, packedToday, bounceEnabled);
  if (verb !== "reorder") return { targetOf: base };

  // The coherence set is the movees PLUS the anchor (spec: "the movee set AND
  // anchor is coherent on both axes"). A cross-container anchor breaks the index
  // axis (so the reorder is unambiguously the view axis); an unresolved anchor is
  // left to the downstream anchor validation.
  const anchorRow =
    position !== undefined && ("before" in position || "after" in position)
      ? (() => {
          const ar = resolveMovee(deps, "before" in position ? position.before : position.after);
          return ar instanceof ReferenceResolutionError ? undefined : loadRow(deps.db, ar.uuid);
        })()
      : undefined;
  const coherence = anchorRow !== undefined ? [...rows, anchorRow] : rows;

  // One shared Today/Evening view? (Mixed today+evening is caught downstream by the
  // single-bucket guard; view=null means "not a clean view set".)
  const views = new Set(coherence.map((r) => viewOf(r, packedToday)));
  const view = views.size === 1 ? [...views][0] : null;

  // An INDEX bucket sorts each object KIND in its OWN rank space (an area's someday
  // to-dos and someday projects are DIFFERENT index buckets — spec axis-isolation),
  // so a MIXED to-do+project movee set has NO shared container index: only its
  // GLOBAL axis (the Today/Evening view or the Upcoming day-block, both of which
  // intermix kinds) is coherent. Nulling the index target for a cross-kind set keeps
  // the dual-axis refusals (view + forecast) and the mixed auto-route from treating
  // it as container-sortable; it falls through to its global axis instead. (A wrong-
  // kind movee that ISN'T bound for a global axis was already refused upstream in
  // runInPlaceReorder, so the only cross-kind sets that reach here are global ones.)
  const sameKind = new Set(rows.map((r) => r.type)).size === 1;

  // The shared index-axis container target, if the whole coherence set has one
  // (classifying each row as though it sat in its container's anytime bucket).
  const indexTargets = coherence.map((r) => indexAxisTargetOf(r, bounceEnabled));
  const indexKeys = new Set(indexTargets.map(containerKey));
  const indexTarget =
    sameKind && indexKeys.size === 1 && indexTargets[0]?.scope != null
      ? (indexTargets[0] as ScopeTarget)
      : null;

  // Force the CONTAINER index axis for a dual-axis row, leaving single-axis rows on
  // their natural target (used when --in names a container or a loose stage list).
  // A Today/Evening member forces onto its container index (view axis stripped); a
  // DEADLINE-FORECAST row forces onto its someday/anytime container index (day-block
  // axis stripped, §9o) — without this a forecast row would classify to the `day`
  // scope and the explicit `--in` would be overridden by the day route.
  const indexClassifier = (r: MoveeRow): ScopeTarget => {
    if (viewOf(r, packedToday) !== null) return indexAxisTargetOf(r, bounceEnabled);
    if (forecastDeadlineDay(r, packedToday) !== null)
      return forecastIndexTargetOf(r, packedToday, bounceEnabled);
    return base(r);
  };

  if (inTarget !== undefined) {
    const parsed = parseInTarget(deps, inTarget, rows);
    if ("error" in parsed) return { refused: refused(op, "usage", parsed.error) };

    // `--in <YYYY-MM-DD>` — one exact Upcoming day-block (the day axis). The date
    // must be strictly future, and every movee must be a member of that day
    // (scheduled startDate == date, or a forecast deadline == date per §9o). No
    // shared-container requirement — a day-block is ONE cross-container axis.
    if ("day" in parsed) {
      const day = parsed.day;
      if (day <= packedToday) {
        return {
          refused: refused(
            op,
            "usage",
            `--in ${decodePackedDate(day)} is not a future day — that date is today or in the past; ` +
              "use --in today to reorder the Today view",
            "name a strictly-future YYYY-MM-DD day, or --in today for the Today view",
          ),
        };
      }
      const notMembers = rows.filter((r) => rowDayKey(r, packedToday) !== day);
      if (notMembers.length > 0) {
        return {
          refused: refused(
            op,
            "usage",
            `--in ${decodePackedDate(day)} but these items are not on that day: ` +
              notMembers.map((r) => r.uuid).join(", ") +
              " — a movee must be scheduled for it, or carry it as a deadline",
            "name the day the items actually share, or omit --in if they share one",
          ),
        };
      }
      return { dayAxis: day };
    }

    // `--in upcoming` — the single future day the whole set shares (the day axis),
    // derived via sharedFutureDay. Stage-agnostic across scheduled + forecast, no
    // container requirement; a set spanning days (or with an off-day member) refuses
    // with the per-item days listed.
    if ("upcoming" in parsed) {
      const day = sharedFutureDay(rows, packedToday);
      if (day === null) {
        return {
          refused: refused(
            op,
            "blocked",
            "--in upcoming needs every item on ONE shared future day, but they are not: " +
              describeDayMembership(rows, packedToday),
            "name the exact day with --in YYYY-MM-DD, or reorder one day at a time",
          ),
        };
      }
      return { dayAxis: day };
    }

    if ("axis" in parsed) {
      const axis = parsed.axis;
      if (axis === "today" || axis === "evening") {
        if (view === axis) return { targetOf: base };
        return {
          refused: refused(
            op,
            "blocked",
            `--in ${axis} but the items are ${describeSetLocation(rows, packedToday)} — they are ` +
              `not ${axis === "today" ? "Today" : "This Evening"} members`,
            "name the axis the items actually share, or omit --in if it is unambiguous",
          ),
        };
      }
      // anytime | someday | inbox — a loose list axis.
      // `--in anytime` on genuinely-LOOSE Today/Evening members is now HONEST: the
      // SIT6 LOOSEPARK protocol reorders the loose Anytime `index` axis via URL
      // move legs, preserving the flag (no de-Today). Route the whole (possibly
      // mixed flagged+plain) loose set to the anytime index scope. someday/inbox
      // have NO flag-safe twin, so a view member on those still de-Todays → refused.
      if (
        axis === "anytime" &&
        bounceEnabled &&
        rows.every((r) => indexAxisContainerOf(r) === null) &&
        rows.some((r) => viewOf(r, packedToday) !== null)
      ) {
        return { targetOf: indexClassifier, indexAxis: true };
      }
      if (view !== null) {
        return {
          refused: refused(
            op,
            "blocked",
            `--in ${axis} would order ${view === "today" ? "Today" : "This Evening"} members on ` +
              `the loose ${axis} axis, whose when= legs OVERWRITE the Today/Evening flag ` +
              "(de-Today hazard) — refused rather than silently stripping it" +
              (axis === "anytime"
                ? " (the flag-safe LOOSEPARK path needs every item genuinely loose and bounce-enabled)"
                : ""),
            `reorder them in the view with --in ${view}, or reschedule them off Today first`,
          ),
        };
      }
      // Sanity + membership (spec rule 4). Every movee must BE that stage; and for
      // anytime/someday every movee must share ONE direct container (same project,
      // heading, area, or all loose — the index bucket they re-rank in). inbox needs
      // only the stage check (inbox items are container-less by nature).
      const wrongStage = rows.filter((r) => scheduleBucket(r, packedToday) !== axis);
      if (wrongStage.length > 0) {
        return {
          refused: refused(
            op,
            "usage",
            `--in ${axis} but not every item is ${axis}-stage — ` +
              `${describeSetLocation(wrongStage, packedToday)}: ` +
              wrongStage.map((r) => r.uuid).join(", "),
            "omit --in and reorder the items where they are, or reschedule them first",
          ),
        };
      }
      if (axis !== "inbox") {
        const containers = new Set(rows.map((r) => structuralKey(r, packedToday)));
        if (containers.size > 1) {
          return {
            refused: refused(
              op,
              "usage",
              `--in ${axis} but the items are in different containers (` +
                rows.map((r) => `${r.uuid} in ${describeDirectContainer(deps, r)}`).join("; ") +
                `) — a single --in ${axis} reorder needs them all in one project, heading, or ` +
                "area, or all loose",
              "reorder within one container at a time, or move them together first",
            ),
          };
        }
      }
      // The stage list axis is an INDEX axis — it suppresses the day auto-route so a
      // forecast someday/anytime row re-ranks its container index here (the bug-fix:
      // `--in someday` on a same-day forecast set compiles the index re-rank, not the
      // deadline day bounce); indexClassifier strips the deadline for that.
      return { targetOf: indexClassifier, indexAxis: true };
    }

    // A container ref (project/area/heading).
    const container = parsed.container;
    const notIn = rows.filter((r) => indexAxisContainerOf(r) !== container.uuid);
    if (notIn.length > 0) {
      return {
        refused: refused(
          op,
          "usage",
          `--in "${inTarget}" (${container.kind} ${container.uuid}) but these items are not in it: ` +
            notIn.map((r) => r.uuid).join(", "),
          "name the container the items actually share, or omit --in",
        ),
      };
    }
    if (view !== null) {
      const forced = indexAxisTargetOf(rows[0] as MoveeRow, bounceEnabled);
      if (!indexAxisTodaySafe(forced)) {
        return {
          refused: refused(
            op,
            "blocked",
            `--in "${inTarget}" would order these ${view === "today" ? "Today" : "This Evening"} ` +
              `members on ${describeScope(forced)}, a when= bounce whose legs OVERWRITE the ` +
              "Today/Evening flag (de-Today hazard); no flag-safe protocol reaches that bucket, so it " +
              "is refused rather than silently stripping the flag",
            `reorder them in the view with --in ${view}, or reschedule them off Today first`,
          ),
        };
      }
    }
    return { targetOf: indexClassifier, indexAxis: true };
  }

  // No --in: refuse only when BOTH axes are honest — a shared view AND a flag-safe
  // container index (native project/area re-rank OR a SIT6 flag-safe MOVE protocol,
  // heading/anytime/projects). The two readings are genuinely ambiguous, so name
  // one with --in. This replaces the old silent always-Today resolution.
  if (
    rows.length >= 2 &&
    view !== null &&
    indexTarget !== null &&
    indexTarget.scope !== null &&
    indexAxisTodaySafe(indexTarget)
  ) {
    return {
      refused: refused(
        op,
        "blocked",
        `these items are ${view === "today" ? "Today" : "This Evening"} members that also share ` +
          `${describeScope(indexTarget)} — the reorder is ambiguous between the ${view} view ` +
          "(todayIndex slots) and the container (index slots); say which with --in",
        `--in ${view} to reorder the ${view} view, or ${inSpellingFor(deps, indexTarget)} to reorder within the container`,
      ),
    };
  }
  // A FORECAST set coherent on BOTH axes (§9o dual-citizen): every movee a deadline-
  // forecast member of ONE shared day AND all sharing one container index bucket.
  // Ambiguous between the day-block (todayIndex) and the container (index) — refuse,
  // echoing the REAL date and the container/list spelling. Forecast rows are never
  // Today/Evening members, so this is the forecast twin of the view-member refusal
  // above. (A forecast set spanning containers, or mixed with scheduled rows, is
  // coherent on only the day axis → it auto-routes to `day` below, no refusal.)
  const forecastDay = sharedForecastDay(rows, packedToday);
  if (rows.length >= 2 && view === null && forecastDay !== null) {
    const fTargets = rows.map((r) => forecastIndexTargetOf(r, packedToday, bounceEnabled));
    const fKeys = new Set(fTargets.map(containerKey));
    // A cross-kind forecast set has no shared container index (kinds isolate), so it
    // is coherent on ONLY the day-block axis — not dual-axis. Auto-route it there
    // (below) rather than offering a container spelling that would then kind-refuse.
    const fIndexTarget =
      sameKind && fKeys.size === 1 && fTargets[0]?.scope != null
        ? (fTargets[0] as ScopeTarget)
        : null;
    if (fIndexTarget !== null) {
      const date = decodePackedDate(forecastDay);
      return {
        refused: refused(
          op,
          "blocked",
          `these items are forecast members of the ${date} Upcoming day-block that also share ` +
            `${describeScope(fIndexTarget)} — the reorder is ambiguous between the day-block ` +
            "(todayIndex slots) and the container (index slots); say which with --in",
          `--in ${date} to reorder the day-block, or ${inSpellingFor(deps, fIndexTarget)} to reorder within the container`,
        ),
      };
    }
  }
  // A MIXED dual-axis set (some Today/Evening-flagged, some plain, all sharing one
  // flag-safe container index) is NOT ambiguous: the plain members are not view
  // members, so there is no shared view to reorder them in — the container index is
  // the only coherent reading. Auto-route it there (a flag-safe MOVE protocol keeps
  // the flagged members' flag). Without this the flagged members classify to the
  // today view while the plain ones classify to the container, and the set would
  // spuriously "span containers".
  if (
    rows.length >= 2 &&
    view === null &&
    indexTarget !== null &&
    indexTarget.scope !== null &&
    indexAxisTodaySafe(indexTarget) &&
    coherence.some((r) => viewOf(r, packedToday) !== null)
  ) {
    return { targetOf: indexClassifier, indexAxis: true };
  }
  return { targetOf: base };
}

/** The `--in` spelling that names an index target (a loose axis, or a container). */
function inSpellingFor(deps: WriteDeps, target: ScopeTarget): string {
  if (target.scope === null) return "--in <container>"; // unreachable: only real index targets reach here
  if (target.scope === "anytime") return "--in anytime";
  if (target.container !== undefined) return `--in "${containerLabel(deps, target.container)}"`;
  return `--in ${target.scope}`;
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
      // A leg-pinned vector is the fallback transport (inbox → applescript); an
      // explicit caller --vector still wins because legOptions spreads after it.
      ...(leg.vector !== undefined && { vector: leg.vector }),
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
  // A mixed-stage selection (movees span the destination's stage sub-buckets) is
  // the per-bucket anchor refusal (§4 rule 4): an anchor has no honest cross-bucket
  // meaning. Distinguished from a single bucket that simply has no protocol.
  const spansBuckets = landing.reason.includes("span display buckets");
  return refused(
    op,
    landing.prohibited === true ? "blocked" : "unsupported",
    spansBuckets
      ? "--before/--after cannot anchor a selection that spans stage sub-buckets in the " +
          "destination — every movee must share the anchor's sub-bucket"
      : `--before/--after cannot be honored in the destination (${describeScope(landing)}) — ` +
          "no reorder protocol positions within that bucket",
    spansBuckets
      ? "split the move by bucket, or drop the anchor (use --first/--last — they apply per sub-bucket)"
      : "use --first/--last, or omit the position (membership still lands)",
  );
}

interface MembershipPlan {
  // A leg may pin its transport when only ONE vector can compile its param shape:
  // the inbox return compiles solely to AppleScript (`move to do id X to list
  // "Inbox"`; the url-scheme `update` has no Inbox target), yet both vectors claim
  // `todo.move` in the matrix and url-scheme wins the tier-0 registry tie — so
  // without this pin the planner routes the inbox leg to url-scheme and its compile
  // throws the "planner bug" unsupportedVector. The loose / no-heading shapes need
  // no pin: they compile only to url-scheme, which is already the default winner.
  legs: { uuid: string; params: TodoMoveParams; vector?: VectorId }[];
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

  // `loose` is the reserved READ-only pseudo-area — never a move destination.
  // (Detaching a to-do to area-less is `--loose`, not `--to-area loose`.)
  if (dest.kind === "area" && isLooseRef(dest.ref.uuid ?? dest.ref.title ?? "")) {
    return { refused: refused(op, "usage", LOOSE_TO_AREA_REFUSAL) };
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
        // Inbox return compiles only to AppleScript — pin the transport so the
        // planner does not route it to url-scheme (the tier-0 registry-tie winner).
        legs.push({ uuid: r.uuid, params: { uuid: r.uuid, inbox: true }, vector: "applescript" });
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

  // `loose` is the reserved READ-only pseudo-area — never a move destination.
  // (A project leaves its area with `--no-area`, not `--to-area loose`.)
  if (dest.kind === "area" && isLooseRef(dest.ref.uuid ?? dest.ref.title ?? "")) {
    return refused(op, "usage", LOOSE_TO_AREA_REFUSAL);
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
/**
 * The single-KIND refusal for an INDEX-axis reorder (a stage list, or a project/
 * area/heading container `index`). An index bucket sorts each object KIND in its
 * OWN rank space, so a to-do+project mix cannot re-rank in one call — even when the
 * kinds share a container. A HEADING is never an index/day/view member at all: its
 * order is the project's heading axis. The GLOBAL day/Today/Evening axes intermix
 * kinds and never reach here. Copy is tailored per case, naming each movee's kind.
 */
function indexKindRefusal(op: "todo.move" | "project.move", rows: MoveeRow[]): MoveRefused {
  const headings = rows.filter((r) => r.type === 2);
  if (headings.length > 0) {
    return refused(
      op,
      "usage",
      "a heading has no stage, schedule, or day order of its own — it is never a Today/Evening, " +
        "day-block, or stage-list member; a heading's order is the project's heading axis, not a " +
        `to-do/project index bucket: ${headings.map((r) => r.uuid).join(", ")}`,
      "reorder a project's headings with `things project move-heading <project> <headings…>`",
    );
  }
  const want = op === "todo.move" ? 0 : 1;
  const named = rows.map((r) => `${r.uuid} (${KIND_LABEL[r.type] ?? "item"})`).join(", ");
  // A homogeneous set of the OTHER kind (e.g. all projects handed to `todo reorder`):
  // point at that kind's own reorder verb rather than the mixed-axis message.
  if (rows.every((r) => r.type !== want)) {
    return refused(
      op,
      "usage",
      `\`reorder\` on this path rearranges ${want === 0 ? "to-dos" : "projects"}, but every item ` +
        `is a ${want === 0 ? "project" : "to-do"}: ${named}`,
      want === 0
        ? "to rearrange projects use `things project move <refs…> --first/--last/--before/--after`"
        : "to rearrange to-dos use `things todo reorder <refs…>`",
    );
  }
  // A genuine to-do + project mix bound for an index bucket.
  return refused(
    op,
    "usage",
    "one kind at a time — an index bucket sorts to-dos and projects in separate order-spaces (a " +
      `shared container does not merge them), so a mixed set cannot re-rank in one call: ${named}`,
    "reorder the to-dos and the projects in separate calls; only the Today/Evening and day-block " +
      "axes (--in today | evening | upcoming | a YYYY-MM-DD day) sort both kinds together",
  );
}

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
  // Kind rule (spec: index-axis isolation). The GLOBAL todayIndex axes INTERMIX
  // object kinds in one reorder: `today` (O12 — `list "Today"` takes projects
  // inline), `evening` (SIT4 EVEORD — projects share the evening axis, per-type
  // bounce legs), and the future day-group scopes (`day`/`tomorrow`/`upcoming`/an
  // `<ISO>` day — SIT4 DAYBNC + TOMORROWLIST accept area-less project rows; DEADLINE-
  // FORECAST projects join that block via the update-project deadline-cycle, PROJDL-
  // 2a/2c #385). An INDEX axis (a stage list `anytime`/`someday`/`inbox`, or a
  // project/area/heading container `index`) sorts each KIND in its OWN rank space, so
  // it takes ONE kind only — an area's someday to-dos and someday projects are
  // DIFFERENT index buckets, so a shared container does not merge them.
  //
  // A movee kind mismatched to the reorder verb (a project/heading on `todo reorder`)
  // is therefore legal ONLY when the whole set lands on a GLOBAL axis. It lands there
  // when NO `--in` forces an index axis AND every movee is a today/evening/scheduled/
  // forecast member (the bare set then auto-routes to a day/today scope whose wire
  // list is type IN (0,1)). An explicit `--in anytime|someday|inbox|<container>`
  // forces the index axis regardless of bucket, so it NEVER intermixes — this is what
  // closes the #387-opened trap where a same-day forecast set's index token slipped
  // the bucket-only relaxation.
  const inNorm = request.in?.trim().toLowerCase();
  const inForcesIndex =
    inNorm !== undefined &&
    inNorm !== "today" &&
    inNorm !== "evening" &&
    inNorm !== "upcoming" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(inNorm);
  const globalAxisIntermix =
    isTodo &&
    rows.length > 0 &&
    !inForcesIndex &&
    rows.every((r) => {
      const b = scheduleBucket(r, packedToday);
      return (
        b === "today" ||
        b === "evening" ||
        b.startsWith("scheduled:") ||
        forecastDeadlineDay(r, packedToday) !== null
      );
    });
  if (wrongKind.length > 0 && !globalAxisIntermix) {
    return indexKindRefusal(op, rows);
  }

  return repositionInPlace(
    deps,
    op,
    rows,
    request.position,
    packedToday,
    options,
    "reorder",
    request.in,
  );
}

// ---------------------------------------------------------------- shared core

/**
 * The packed day a single row contributes to a shared future day-group, or null.
 * A SCHEDULED row (to-do or project) on a strictly-future startBucket=0 day
 * contributes its `startDate`; a DEADLINE-FORECAST to-do (startDate NULL, future
 * `deadline`, start IN (1,2) — DLBNC/§9o) contributes its `deadline` (they share the
 * one block todayIndex axis). Any other row (arrived, undated non-forecast, off the
 * Today axis) contributes null.
 */
function rowDayKey(row: MoveeRow, packedToday: number): number | null {
  if (
    row.startDate !== null &&
    row.startBucket === 0 &&
    row.startDate > packedToday &&
    (row.type === 0 || row.type === 1)
  ) {
    return row.startDate;
  }
  return forecastDeadlineDay(row, packedToday);
}

/**
 * The single STRICTLY-FUTURE day every movee shares, or null — the precondition for
 * the SIT4 dated `day` bounce (and the one-call `tomorrow` sort). Members are
 * SCHEDULED to-dos in ANY container AND scheduled PROJECT rows (area-less OR area-
 * direct — SIT5 AREAPROJDAY proved the update-project when= legs preserve the area
 * FK) sharing a future startBucket=0 `startDate`, PLUS DEADLINE-FORECAST to-dos
 * (DLBNC/§9o) whose future `deadline` equals that same day — all on the ONE Upcoming
 * day-block todayIndex axis, so a scheduled+forecast mix is one group. A row off the
 * day, a template, or an undated/arrived non-forecast row breaks the group and falls
 * through to the normal single-container guard. (Templates never reach here: both
 * `startDate` and `deadline` fail the strictly-future key for a resting template.)
 */
function sharedFutureDay(rows: MoveeRow[], packedToday: number): number | null {
  const first = rows[0];
  if (first === undefined) return null;
  const day = rowDayKey(first, packedToday);
  if (day === null) return null;
  for (const r of rows) {
    if (r.isTemplate) return null;
    if (rowDayKey(r, packedToday) !== day) return null;
  }
  return day;
}

/** Whether any row in the group is a deadline-forecast member (DLBNC/§9o). */
function hasForecastMember(rows: MoveeRow[], packedToday: number): boolean {
  return rows.some((r) => forecastDeadlineDay(r, packedToday) !== null);
}

/**
 * The single shared FORECAST deadline day when EVERY row is a deadline-forecast
 * member (§9o) of that one day, else null. Stricter than {@link sharedFutureDay}:
 * a scheduled row (or a forecast row on a different day) breaks it — so a
 * scheduled-only or scheduled+forecast-mixed set returns null (single-axis, day-
 * only). Gates the forecast dual-axis refusal: only an all-forecast, one-day set
 * has a coherent container-index alternative to the day-block.
 */
function sharedForecastDay(rows: MoveeRow[], packedToday: number): number | null {
  const first = rows[0];
  if (first === undefined) return null;
  const day = forecastDeadlineDay(first, packedToday);
  if (day === null) return null;
  for (const r of rows) if (forecastDeadlineDay(r, packedToday) !== day) return null;
  return day;
}

/**
 * Reposition a shared FUTURE day-group on the global todayIndex axis — the SIT4
 * dated `day` bounce (loose/direct-area/headed/cross-container to-dos + area-less
 * project rows, any mix), or the one-call native `list "Tomorrow"` sort when the
 * day is tomorrow. Both order the WHOLE cross-container day-group on ONE shared
 * axis, so the anchor (if any) is validated by DAY-GROUP membership (not the
 * structural container) — an anchor positions within the group, it never migrates.
 */
async function runDayGroupReposition(
  deps: WriteDeps,
  op: "todo.move" | "project.move",
  rows: MoveeRow[],
  position: MovePosition | undefined,
  options: WriteOptions,
  scope: "day" | "tomorrow",
  day: number,
): Promise<MoveResult> {
  const target: ScopeTarget = { scope, day };
  const movees = rows.map((r) => r.uuid);
  const members = bucketMembers(deps, target, movees[0]);

  // Anchor must share the movees' day-group (positions, never migrates) — an
  // AXIS-aware check (the day-group is one cross-container todayIndex axis, so a
  // different structural container is NOT a migration).
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
    if (!members.includes(ar.uuid)) {
      return refused(
        op,
        "blocked",
        `the anchor ${ar.uuid} is not in ${describeScope(target)} — an anchor positions, it never migrates`,
        "pick an anchor that shares the movees' day, or use --first/--last",
      );
    }
  }

  const reorderUuids =
    position === undefined
      ? earliestSlotOrder(deps, target, movees)
      : buildReorderOrder(deps, target, movees, position);
  const placement = await runReorder(
    deps,
    { scope, uuids: reorderUuids, named: movees },
    { ...legOptions(options), ...(options.dryRun === true && { dryRun: true }) },
  );
  const mechanism =
    scope === "tomorrow"
      ? 'cross-container Tomorrow day-group reorder (one-call `list "Tomorrow"` sort)'
      : "cross-container future day-group reorder (SIT4 dated when= bounce)";
  if (options.dryRun === true) {
    return {
      kind: "move-dry-run",
      op,
      plan: {
        movees,
        membership: "none (in-place reposition)",
        placement: `reorder scope=${scope} → ${describePosition(position)}`,
        placementClass: "guaranteed",
        note: dryRunNote(placement, mechanism),
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
      `reordered within ${describeScope(target)} (${scope} scope — placement guaranteed)` +
      touchedSuffix(placement),
  };
}

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
  inTarget?: string,
): Promise<MoveResult> {
  // Resolve the reorder AXIS (`reorder --in` disambiguation). The classifier maps
  // each row to its effective reorder target for the chosen axis: the view axis
  // (today/evening) leaves reorderTargetOf unchanged; a container index axis
  // reclassifies Today/Evening members by their container. A dual-axis set with no
  // --in is refused here (naming both --in spellings).
  const axis = resolveReorderAxis(deps, op, rows, inTarget, packedToday, verb, position);
  if ("refused" in axis) return axis.refused;
  // An explicit day-axis token (`--in <YYYY-MM-DD>` / `--in upcoming`) routes straight
  // to the cross-container day-group reposition — membership + future-ness were
  // validated in resolveReorderAxis. Mirror the auto-route's scope pick: the native
  // one-call `tomorrow` sort only for a non-forecast group whose day is tomorrow (that
  // surface re-dates a forecast row), else the dated `day` bounce.
  if ("dayAxis" in axis) {
    const day = axis.dayAxis;
    const scope =
      !hasForecastMember(rows, packedToday) && day === packedTomorrowOf(packedToday)
        ? "tomorrow"
        : "day";
    return runDayGroupReposition(deps, op, rows, position, options, scope, day);
  }
  const targetOf = axis.targetOf;
  // On a forced/auto INDEX axis (a dual-axis set reordered within its container),
  // the display-bucket coherence guards below are the WRONG check: the members
  // share ONE container `index` order even though a flagged member renders in the
  // Today/Evening view. The target-span guard still enforces the single shared
  // container; only the per-display-bucket splits are relaxed (a SIT6 flag-safe
  // protocol reorders the whole run, flag preserved).
  const indexAxis = axis.indexAxis === true;

  // A shared FUTURE day-group (single- OR cross-container) rides the global
  // todayIndex axis, not the normal single-container reorder: the SIT4 dated `day`
  // bounce (loose/direct-area/headed/cross-container to-dos + area-less project
  // rows + DEADLINE-FORECAST to-dos, any mix), or the one-call `list "Tomorrow"`
  // sort when the day is tomorrow. Two exceptions force the `day` scope (never the
  // native short-cuts): a group CONTAINING a forecast row NEVER rides `list
  // "Tomorrow"` (that surface re-dates a forecast row, UPCDL-5) NOR the single-
  // project container-day native re-rank (a forecast row has no startDate, so it is
  // not a container-day scheduled child) — the deadline-cycle `day` bounce is the
  // one surface that serves the mixed group. Otherwise a single UNHEADED PROJECT
  // container's same-day scheduled children ride the cheaper atomic native
  // container-day re-rank (fall through to reorderTargetOf → container-day).
  // Templates are excluded by sharedFutureDay. The auto-route NEVER fires on a
  // forced/auto INDEX axis (indexAxis === true): an explicit `--in someday` /
  // `--in anytime` / `--in <container>` on a same-day forecast set is the certified
  // container `index` re-rank, and must not be overridden by the day bounce.
  const structKeys = new Set(rows.map((r) => structuralKey(r, packedToday)));
  const sharedDay = sharedFutureDay(rows, packedToday);
  if (sharedDay !== null && !indexAxis) {
    const forecastInGroup = hasForecastMember(rows, packedToday);
    const soleStruct = structKeys.size === 1 ? (structKeys.values().next().value as string) : null;
    const singleProjectContainer =
      !forecastInGroup && (soleStruct?.startsWith("project:") ?? false);
    if (!singleProjectContainer) {
      const scope =
        !forecastInGroup && sharedDay === packedTomorrowOf(packedToday) ? "tomorrow" : "day";
      return runDayGroupReposition(deps, op, rows, position, options, scope, sharedDay);
    }
  }

  // One shared reorder TARGET (rule 2 span). Keyed by the reorder target, NOT the
  // structural container: a GLOBAL todayIndex bucket (today / evening) collapses
  // cross-container rows to ONE target, so they reorder together on that shared
  // axis (the GUI permits exactly that drag — nothing migrates); an INDEX-axis
  // bucket keeps its per-container key, so a genuine cross-container span still
  // refuses. The comparator and the describer read the SAME key, so an identical-
  // label refusal is structurally impossible.
  const targetKeys = new Set(rows.map((r) => containerKey(targetOf(r))));
  if (targetKeys.size !== 1) {
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

  // All movees must share ONE bucket (rule 4 single-bucket-strict) — EXCEPT on a
  // forced/auto index axis, where a dual-axis set legitimately spans display
  // buckets (a flagged member in Today + plain members in Anytime) yet shares one
  // container index order.
  const buckets = new Map<string, string[]>();
  for (const r of rows) {
    const b = scheduleBucket(r, packedToday);
    buckets.set(b, [...(buckets.get(b) ?? []), r.uuid]);
  }
  if (buckets.size > 1 && !indexAxis) {
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
    // AXIS-aware anchor validity: the anchor must share the movees' reorder TARGET,
    // not its structural container. For a GLOBAL todayIndex bucket (today/evening)
    // a different structural container is NOT a migration — both collapse to the
    // same target — so the anchor is valid; for an INDEX-axis bucket a cross-
    // container anchor genuinely implies migration and still refuses. Comparator
    // and describer read the SAME key (containerKey ⇔ describeScope), so the two
    // rendered labels can never be identical when the comparator refuses.
    const anchorTarget = targetOf(anchorRow);
    if (containerKey(anchorTarget) !== containerKey(target)) {
      return refused(
        op,
        "blocked",
        `the anchor ${anchorUuid} is in ${describeScope(anchorTarget)}, not ${describeScope(target)} — an anchor positions, it never migrates`,
        "move the items into the anchor's container explicitly, or pick an anchor that shares it",
      );
    }
    // On the index axis the anchor need only share the container (checked above via
    // containerKey) — display buckets legitimately differ for a dual-axis set.
    const anchorBucket = scheduleBucket(anchorRow, packedToday);
    const movBucket = [...buckets.keys()][0];
    if (!indexAxis && anchorBucket !== movBucket) {
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

  // Mixed-stage --first/--last (spec §4 rule 4): a selection that lands across
  // stage sub-buckets (anytime + scheduled + someday) places each stage-group at
  // the top/bottom of ITS bucket in the destination. Grouped off the RELOADED
  // post-move rows (real container uuids + true buckets), so it needs no dest
  // context and is correct for a heading landing too. Dry-run keeps the generic
  // path (no DB truth to reload).
  if (options.dryRun !== true && position !== undefined && "at" in position) {
    const reloaded = rows.map((r) => loadRow(deps.db, r.uuid) ?? r);
    const groups = groupByReorderTarget(deps, reloaded, packedToday);
    if (groups.length > 1) {
      return placePerBucket(deps, op, groups, position, moveeTitles, membership, options);
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

/** One stage sub-bucket of a mixed-stage landing: its reorder target + its rows. */
interface LandingGroup {
  target: ScopeTarget;
  rows: MoveeRow[];
}

/**
 * Partition rows by their reorder TARGET (the distinct placement protocol each
 * stage sub-bucket needs), preserving selection order within each group. Used for
 * per-sub-bucket --first/--last on a mixed-stage membership move.
 */
function groupByReorderTarget(
  deps: WriteDeps,
  rows: MoveeRow[],
  packedToday: number,
): LandingGroup[] {
  const groups = new Map<string, LandingGroup>();
  for (const r of rows) {
    const target = reorderTargetOf(r, r.type === 0, packedToday, deps.config.bounceEnabled);
    const key = containerKey(target);
    const g = groups.get(key);
    if (g !== undefined) g.rows.push(r);
    else groups.set(key, { target, rows: [r] });
  }
  return [...groups.values()];
}

/**
 * Place each stage-group of a mixed-stage membership move at the top/bottom of ITS
 * sub-bucket (spec §4 rule 4). Each group with a wired protocol runs its own
 * --first/--last reorder; a protocol-less group is honest app-default. The note
 * states every group's outcome (the rule-5 honesty surface).
 */
async function placePerBucket(
  deps: WriteDeps,
  op: "todo.move" | "project.move",
  groups: LandingGroup[],
  position: { at: "first" | "last" },
  moveeTitles: { uuid: string; title: string | null }[],
  membership: MutationResult[],
  options: WriteOptions,
): Promise<MoveResult> {
  const notes: string[] = [];
  const placements: ReorderResult[] = [];
  let anyGuaranteed = false;
  let anyDefault = false;
  for (const g of groups) {
    const count = g.rows.length;
    if (g.target.scope === null) {
      anyDefault = true;
      notes.push(`${describeScope(g.target)}: app-default (${count})`);
      continue;
    }
    const movees = g.rows.map((r) => r.uuid);
    const reorderUuids = buildReorderOrder(deps, g.target, movees, position);
    const placement = await runReorder(
      deps,
      {
        scope: g.target.scope,
        uuids: reorderUuids,
        named: movees,
        ...(g.target.container !== undefined && { container: { uuid: g.target.container } }),
      },
      legOptions(options),
    );
    placements.push(placement);
    if (placement.kind === "ok") {
      anyGuaranteed = true;
      notes.push(
        `${describeScope(g.target)}: ${position.at} (${count})${touchedSuffix(placement)}`,
      );
    } else {
      anyDefault = true;
      notes.push(
        `${describeScope(g.target)}: placement unavailable (${placement.kind}) — app-default`,
      );
    }
  }
  return {
    kind: "move-ok",
    op,
    movees: moveeTitles,
    membership,
    placement: placements[0] ?? null,
    placementClass: anyGuaranteed && !anyDefault ? "guaranteed" : "app-default",
    note:
      `membership moved; mixed-stage placement applied PER sub-bucket (--${position.at}): ` +
      notes.join("; "),
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
 * day-group scopes (container-day, `day`, tomorrow) read their day off the FIRST
 * requested uuid (a day-group is keyed by a movee's startDate, not by a
 * container), so `dayAnchor` (a movee) seeds the enumeration for them — without it
 * those scopes enumerate nothing and an anchored (--last/--before/--after)
 * placement cannot splice against the real day order.
 */
function bucketMembers(deps: WriteDeps, target: ScopeTarget, dayAnchor?: string): string[] {
  if (target.scope === null) return [];
  const seedsDay =
    target.scope === "container-day" || target.scope === "day" || target.scope === "tomorrow";
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
  // A day-group's identity IS its date — name it so cross-day refusals read
  // coherently (e.g. "the loose 2026-08-05 day-group" vs "…2026-08-07…"), never
  // the self-contradictory date-less "the loose future-day group" on both sides.
  const day = target.day !== undefined ? decodePackedDate(target.day) : null;
  if (target.scope === "day") {
    return day !== null ? `the ${day} day-group` : "the future day-group";
  }
  if (target.scope === "tomorrow") return "the Tomorrow day-group";
  if (target.scope === "container-day" && day !== null) {
    return `the container-day ${target.container} day-group (${day})`;
  }
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
