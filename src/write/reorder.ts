/**
 * write.reorder orchestrator — two strategies, both lab-derived:
 *
 * native  — one `_private_experimental_ reorder` AppleScript call through
 *           the standard pipeline (drift gate → guards → canary → execute →
 *           ordering verification). Scopes: today (bucket-0 members, O01/
 *           O03/O12), project/area (un-headed children, O04/O05/O09–O11),
 *           container-day (a container's same-day scheduled children — a
 *           date-preserving todayIndex re-rank, DAYORD-b/O17). Gated by
 *           config.allowExperimental AND the sdef canary.
 *
 * bounce  — verified `when=` round-trips (REORDGAPS + BOUNCE2): re-scheduling
 *           an item away from and back into its resting bucket RE-INSERTS it,
 *           and the DIRECTION follows the containment context (the BOUNCE2
 *           re-entry law, oddities §9h):
 *             - loose / area-direct items FRONT-insert below the group min, so
 *               reverse-order legs land the target order (today, evening,
 *               projects, area-less loose anytime, an area's someday members);
 *             - strict-container children (heading / project children)
 *               BACK-insert at the bucket end, so forward-order legs land the
 *               target order (a heading's anytime children; a project's someday
 *               children — the SOMEBNC-project fallback when native is off).
 *           Each leg is a full verified todo.update/project.update mutation;
 *           between items the live state is re-checked so a user editing Things
 *           concurrently causes a clean abort with partial-progress detail,
 *           never a fight. Several bounce scopes are the ONLY surface that
 *           reaches their bucket (evening O03; top-level projects P8e/scf2 P6;
 *           within-heading order HEADORD-b; an area's someday order §9f).
 *
 * The requested uuid list may be a subset of the scope: for native, the wire
 * list is extended with every remaining member in current order (placement
 * stays deterministic); for bounce, unrequested members simply stay put below
 * the bounced block (neighbors untouched), except an anchored (`--before`/
 * `--after`) placement co-bounces the minimal contiguous run between the block
 * and the bucket edge (disclosed as `touched`).
 *
 * JSON collapse (BOUNCEJSON, oddities §9i): for the bounce classes whose
 * PLACEMENT (`back`) leg is `when=anytime` landing into a loose or heading-
 * container bucket, the whole N-item round-trip can collapse to ONE pre-
 * validated `things:///json` update array (2N ops, 1 dispatch, exact array
 * order, ~7×, validate-first FULL-ABORT). Eligibility is a per-BounceSpec flag
 * ({@link BounceSpec.jsonCollapsible}) keyed off that mechanism, NOT the front/
 * back direction — see the flag's doc for why a someday-placement or area-
 * direct class must NEVER collapse (json is index-inert there — a collapse
 * would silently fail to reorder).
 */
import { randomBytes } from "node:crypto";

import type { AuditRecord } from "../audit/schema.ts";
import { localToday, encodePackedDate } from "../model/dates.ts";
import type { ReorderParams, ReorderScope, TodoMoveParams } from "./operations.ts";
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import { computeReorderPre, resolveArea, resolveProject } from "./pre-state.ts";
import { sdefDeclaresPrivateReorder } from "./experimental.ts";
import {
  fingerprintLabel,
  readAuthToken,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import type { WriteVector } from "./vectors/types.ts";
import { createDbReader, evaluateDelta } from "./verify/delta.ts";
import { pollUntilVerified } from "./verify/poller.ts";

/**
 * DEFAULT bounce cap — 2 verified mutations per item (~110 ms/item guest-local,
 * BOUNCE2-t). The effective cap is `config.bounceMaxItems` (default 30); this
 * constant is the built-in fallback used when a caller supplies no config value,
 * and the figure surface copy cites.
 */
export const BOUNCE_MAX_ITEMS = 30;

/**
 * The bounce re-entry law (reordgaps-results.md, BOUNCE2). A `when=` round-trip
 * re-inserts the touched item; the DIRECTION depends on its containment context,
 * and the away/back legs depend on its resting bucket:
 *   - loose/area-direct items FRONT-insert (reverse-order legs land target order)
 *   - strict-container children (heading/project) BACK-insert (forward-order legs)
 * `away`/`back` are the two `when=` values of the round-trip; the resting bucket
 * is `back`.
 */
export type BounceKind =
  | "today"
  | "evening"
  | "projects"
  | "heading"
  | "area-someday"
  | "anytime"
  | "project-someday";

interface BounceSpec {
  away: "today" | "evening" | "someday" | "anytime";
  back: "today" | "evening" | "someday" | "anytime";
  /** front = reverse-iterate (front-insert); back = forward-iterate (back-insert). */
  direction: "front" | "back";
  rankKey: "index" | "todayIndex";
  legOp: "todo.update" | "project.update";
  /**
   * Whether the whole N-item round-trip may collapse to ONE pre-validated
   * `things:///json` update array (BOUNCEJSON, oddities §9i). The app's `json`
   * `when=` reindex fires ONLY when the PLACEMENT (`back`) leg is `anytime`
   * landing into a LOOSE or heading-CONTAINER bucket — so eligibility is keyed
   * off the placement-leg VALUE, NOT the front/back direction:
   *   - eligible: `heading` (back=anytime, container child — BJ-a back-insert)
   *     and `anytime` (back=anytime, area-less loose — BJ-0 front-insert); both
   *     are `todo.update` legs, the exact `type:"to-do"` json shape BJ-0/BJ-a
   *     validated. The array carries `[{when:away},{when:back}]` per item in the
   *     SAME per-item order the sequential loop iterates (reverse for the loose
   *     front-insert, forward for the heading back-insert), so array order == the
   *     resulting index order.
   *   - NOT eligible (json index-INERT — must stay on the sequential URL bounce):
   *     any `someday`-placement class (`area-someday`, `project-someday`) — §9i(b)
   *     measured `when=someday` leaves `index` untouched; and any area-DIRECT
   *     member — §9i(c) measured it index-FROZEN under both toggles. Collapsing
   *     either would SILENTLY not reorder. `today`/`evening` (todayIndex legs) and
   *     `projects` (project.update — the json when= reindex is unproven for a
   *     type=1 project) also stay on the URL loop.
   * The collapse is validate-first FULL-ABORT (§9i / BJ-c): one unresolvable id
   * rejects the ENTIRE array (nothing partial lands), so it needs no partial-
   * progress reconciliation — refs are pre-resolved in {@link runReorder}.
   *
   * Classified here so the split is explicit and evidence-locked (a regression
   * test pins the membership); the one-shot json dispatch itself is the wiring
   * that consumes this flag.
   */
  jsonCollapsible: boolean;
}

/**
 * The bounce kinds whose N-item round-trip is eligible for the `things:///json`
 * one-array collapse (BOUNCEJSON §9i) — exactly the classes whose placement
 * (`back`) leg is `when=anytime` into a loose/heading-container bucket. Exported
 * for the classification regression test (guards against "optimizing" a someday-
 * placement or area-direct class into json, which §9i proves is a silent no-op).
 */
export function bounceJsonCollapsible(kind: BounceKind): boolean {
  return bounceSpecOf(kind).jsonCollapsible;
}

function bounceSpecOf(kind: BounceKind): BounceSpec {
  switch (kind) {
    case "today":
      return {
        away: "evening",
        back: "today",
        direction: "front",
        rankKey: "todayIndex",
        legOp: "todo.update",
        // todayIndex leg, not an anytime placement — json reindex unproven here.
        jsonCollapsible: false,
      };
    case "evening":
      return {
        away: "today",
        back: "evening",
        direction: "front",
        rankKey: "todayIndex",
        legOp: "todo.update",
        jsonCollapsible: false,
      };
    case "projects":
      return {
        away: "someday",
        back: "anytime",
        direction: "front",
        rankKey: "index",
        legOp: "project.update",
        // project.update (type=1): the json when= reindex is unproven for a
        // project row — stays on the URL loop (§9i tested to-dos only).
        jsonCollapsible: false,
      };
    // Headed anytime children BACK-insert (BOUNCE2-h): forward-order bounce.
    // Placement leg = anytime into a heading container -> json-collapsible (BJ-a).
    case "heading":
      return {
        away: "someday",
        back: "anytime",
        direction: "back",
        rankKey: "index",
        legOp: "todo.update",
        jsonCollapsible: true,
      };
    // Area someday members FRONT-insert (SOMEBNC-area): reverse-order bounce.
    // Someday placement leg AND area-direct -> json index-INERT (§9i b+c): URL only.
    case "area-someday":
      return {
        away: "anytime",
        back: "someday",
        direction: "front",
        rankKey: "index",
        legOp: "todo.update",
        jsonCollapsible: false,
      };
    // Area-less loose anytime FRONT-insert (ANYBNC): reverse-order bounce.
    // Placement leg = anytime into a loose bucket -> json-collapsible (BJ-0).
    case "anytime":
      return {
        away: "someday",
        back: "anytime",
        direction: "front",
        rankKey: "index",
        legOp: "todo.update",
        jsonCollapsible: true,
      };
    // Project someday children BACK-insert (SOMEBNC-project): forward-order bounce.
    // Someday placement leg -> json index-INERT (§9i b): URL only, despite being
    // a back-insert (eligibility is the placement-leg value, not the direction).
    case "project-someday":
      return {
        away: "anytime",
        back: "someday",
        direction: "back",
        rankKey: "index",
        legOp: "todo.update",
        jsonCollapsible: false,
      };
  }
}

function blocked(detail: string, remediation: string): { kind: "blocked"; result: MutationResult } {
  return {
    kind: "blocked",
    result: {
      kind: "blocked",
      op: "reorder",
      reason: "hazard",
      hazard: "H-REORDER-SCOPE",
      detail,
      remediation,
    },
  };
}

export type ReorderResult =
  | MutationResult
  | {
      kind: "bounce-aborted";
      op: "reorder";
      detail: string;
      /** Uuids already placed (they ARE at the top, in requested order). */
      placed: string[];
      /** Uuids not yet placed (still in their prior positions). */
      remaining: string[];
      /** The failing leg's result when a mutation failed (null = state check). */
      cause: MutationResult | null;
    };

export async function runReorder(
  deps: WriteDeps,
  params: ReorderParams,
  options: WriteOptions = {},
): Promise<ReorderResult> {
  params = { ...params, uuids: params.uuids.map((u) => resolveTaskUuidPrefix(deps.db, u)) };

  // The park-sort-restore day compounds (neither a single native command nor a
  // when= bounce): a scratch project holds the whole day-group for ONE container-
  // day reorder, then each member is restored to its origin. loose-day (UPCORD1),
  // area-day (ORDFIN1 Arm 3), and upcoming-day (ORDFIN1 Arm 4) are the SAME
  // origin-aware compound — loose-day/area-day are the uniform-origin degenerate
  // cases (every member homes loose / to the area), upcoming-day the general one.
  if (
    params.scope === "loose-day" ||
    params.scope === "area-day" ||
    params.scope === "upcoming-day"
  ) {
    return runDayCompound(deps, params, options);
  }

  // HEADSUB1 within-heading sub-bucket compounds (headsub1-heading-subbuckets.md).
  // heading-someday re-heads the block in forward order (move-to-heading back-
  // insert); heading-day runs the unhead → container-day reorder → re-head round-
  // trip (the native container-day reorder alone RIPS the heading FK, §9k).
  if (params.scope === "heading-someday") return runHeadingSomeday(deps, params, options);
  if (params.scope === "heading-day") return runHeadingDay(deps, params, options);

  const strategy = resolveStrategy(deps, params);
  if (strategy.kind === "blocked") return strategy.result;

  if (strategy.strategy === "native") {
    return runMutation(deps, "reorder", params, { ...options, vector: "applescript" });
  }
  return runBounce(deps, params, strategy.bounceKind, options);
}

type StrategyDecision =
  | { kind: "ok"; strategy: "native" }
  | { kind: "ok"; strategy: "bounce"; bounceKind: BounceKind }
  | { kind: "blocked"; result: MutationResult };

/** A blocked result for a bounce-dependent placement while bounce is disabled. */
function bounceDisabled(what: string): { kind: "blocked"; result: MutationResult } {
  return {
    kind: "blocked",
    result: {
      kind: "blocked",
      op: "reorder",
      reason: "environment",
      detail:
        `${what} requires the when= bounce, which is disabled (bounce-enabled=false) — ` +
        "it was NOT attempted (no destructive or unverified fallback exists)",
      remediation:
        "re-enable it with `things config set bounce-enabled true`" +
        " (each bounced item costs two verified mutations)",
    },
  };
}

function bounceOk(deps: WriteDeps, what: string, kind: BounceKind): StrategyDecision {
  if (!deps.config.bounceEnabled) return bounceDisabled(what);
  return { kind: "ok", strategy: "bounce", bounceKind: kind };
}

function resolveStrategy(deps: WriteDeps, params: ReorderParams): StrategyDecision {
  const nativeAvailable =
    deps.config.allowExperimental && (deps.sdefProbe ?? sdefDeclaresPrivateReorder)();

  // Scopes whose ONLY surface is the bounce (no native command reaches them).
  const bounceOnly: Partial<Record<ReorderScope, { kind: BounceKind; what: string }>> = {
    evening: { kind: "evening", what: "evening-section order" },
    projects: { kind: "projects", what: "top-level projects order" },
    heading: { kind: "heading", what: "within-heading order" },
    "area-someday": { kind: "area-someday", what: "an area's someday order" },
    anytime: { kind: "anytime", what: "area-less loose anytime order" },
  };
  const bounceEntry = bounceOnly[params.scope];

  if (params.strategy === "native") {
    if (bounceEntry !== undefined) {
      return blocked(
        `${bounceEntry.what} has NO native surface — only the when= bounce reaches it`,
        "omit --strategy (it defaults to the bounce)",
      );
    }
    return { kind: "ok", strategy: "native" };
  }
  if (params.strategy === "bounce") {
    if (params.scope === "container-day") {
      return blocked(
        "a container's scheduled-day order is a native todayIndex re-rank (DAYORD-b), not a bounce",
        "omit --strategy (container-day defaults to native)",
      );
    }
    if (
      params.scope === "project" ||
      params.scope === "area" ||
      params.scope === "inbox" ||
      params.scope === "someday"
    ) {
      return blocked(
        "bounce can only reorder the Today/Evening sections, top-level projects, within-heading, " +
          "area-someday, and area-less anytime — its primitive is a when= round-trip, which does " +
          "not move this scope's order",
        "use the native strategy (requires `things config set allow-experimental true`)",
      );
    }
    if (bounceEntry !== undefined) return bounceOk(deps, bounceEntry.what, bounceEntry.kind);
    // today with explicit bounce.
    return bounceOk(deps, "Today-section order", "today");
  }

  // Default per scope.
  if (bounceEntry !== undefined) return bounceOk(deps, bounceEntry.what, bounceEntry.kind);
  switch (params.scope) {
    case "today":
      return nativeAvailable
        ? { kind: "ok", strategy: "native" }
        : bounceOk(deps, "Today-section order", "today");
    case "project":
      // SOMEORD-b native is primary; SOMEBNC-project forward-order bounce is the
      // documented ALTERNATE, used only when the native command is unavailable
      // and every requested member is a someday child (reordgaps-results.md).
      if (!nativeAvailable && somedayProjectChildren(deps, params)) {
        return bounceOk(deps, "within-project someday order", "project-someday");
      }
      return { kind: "ok", strategy: "native" };
    case "area":
    case "inbox":
    case "someday":
    case "container-day":
    case "tomorrow":
      // Native-only scopes: let the pipeline explain precisely why native is
      // unavailable (planner: experimental gate; canary: sdef change). `tomorrow`
      // is the ORDFIN2 one-call `list "Tomorrow"` day-sort (TOMORROWLIST).
      return { kind: "ok", strategy: "native" };
    // bounce-only scopes handled by bounceEntry above; unreachable here.
    case "evening":
    case "projects":
    case "heading":
    case "area-someday":
    case "anytime":
      return { kind: "ok", strategy: "native" };
    // loose-day / area-day / upcoming-day / heading-someday / heading-day are
    // intercepted in runReorder before resolveStrategy runs; these cases exist
    // only for switch exhaustiveness.
    case "loose-day":
    case "area-day":
    case "upcoming-day":
    case "heading-someday":
    case "heading-day":
      return { kind: "ok", strategy: "native" };
  }
}

/**
 * True when every requested uuid is an open, non-trashed, un-headed SOMEDAY
 * (start=2) child of the params' project container — the precondition for the
 * SOMEBNC-project forward-order bounce fallback.
 */
function somedayProjectChildren(deps: WriteDeps, params: ReorderParams): boolean {
  if (params.uuids.length === 0) return false;
  const projectUuid = resolveProject(deps.db, params.container ?? {}).resolved?.uuid;
  if (projectUuid === undefined) return false;
  for (const uuid of params.uuids) {
    const row = deps.db
      .prepare(
        "SELECT type, trashed, status, project, heading, start, startDate FROM TMTask WHERE uuid = ?",
      )
      .get(uuid) as
      | {
          type: number;
          trashed: number;
          status: number;
          project: string | null;
          heading: string | null;
          start: number;
          startDate: number | null;
        }
      | undefined;
    if (
      row === undefined ||
      row.type !== 0 ||
      row.trashed !== 0 ||
      row.status !== 0 ||
      row.project !== projectUuid ||
      row.heading !== null ||
      row.start !== 2 ||
      row.startDate !== null
    ) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------- park-sort-restore day compounds
//
// loose-day (UPCORD1, docs/lab/upcord1-loose-day-order.md Arm B), area-day
// (ORDFIN1 Arm 3), and upcoming-day (ORDFIN1 Arm 4) are ONE origin-aware compound.
// A future Upcoming day-group has no native or bounce surface — `list "Upcoming"`
// re-dates it (§9g), date-shaped `list` specifiers don't exist (−1728), and the
// AREA reorder specifier de-schedules dated members (§9f). The one clean, date/
// state-preserving path is a scratch PROJECT round-trip:
//   1. create a scratch PROJECT (unique synthetic title);
//   2. capture each day-group member's ORIGIN (loose / project / project+heading /
//      area) BEFORE parking, then PARK it into the scratch (URL list-id — preserves
//      startDate/start/todayIndex/reminder/deadline; parking a headed child clears
//      its heading, exactly like the unhead leg);
//   3. ONE container-day reorder against the scratch project, full day-group in
//      target order (the SHIPPED DAYORD-b native todayIndex re-rank);
//   4. RESTORE each member to its captured origin FK (loose ← empty list-id;
//      project child ← list-id=<P>; headed child ← list-id=<P>&heading=<H>; area
//      child ← list-id=<A>) — a membership move is a todayIndex no-op, so the
//      reorder alone fixes the order and restore-leg order is irrelevant (Arm 4);
//   5. TRASH the scratch project (delete-to-trash, NEVER permanent).
// loose-day / area-day are the uniform-origin degenerate cases (every member homes
// loose / to the area); upcoming-day the mixed-origin general one. The whole day-
// group is parked (not just the named block): the container-day leg only re-ranks
// the scratch project's OWN children, so an un-parked day member would keep a stale
// todayIndex and corrupt the result — every un-named member is a co-parked sibling
// (touched, disclosed, bounce co-bounce precedent). upcoming-day DISCLOSES a
// strand when the day carries an untouched scheduled PROJECT row (not parkable —
// UPCORD1): the block sorts to the TOP of the day and the project row(s) keep
// their prior relative order below it (ORDFIN2 PRJMIX), surfaced in `stranded`. A
// requested repeating TEMPLATE or a requested project movee is still refused
// (§9e / not parkable). Non-atomic like the bounce protocols: a mid-protocol
// failure leaves items PARKED in the scratch project and fails loudly with
// placed/remaining detail naming the scratch uuid.

/**
 * A day-group member's origin container, captured BEFORE parking so the restore
 * leg can re-home it (upcoming-day is origin-aware; loose-day/area-day are the
 * uniform-origin degenerate cases).
 */
type DayOrigin =
  | { kind: "loose" }
  | { kind: "project"; project: string }
  | { kind: "heading"; project: string; heading: string }
  | { kind: "area"; area: string };

/** Read a member's current origin container; error string if unrestorable. */
function captureDayOrigin(deps: WriteDeps, uuid: string): DayOrigin | { error: string } {
  const row = deps.db
    .prepare("SELECT project, area, heading FROM TMTask WHERE uuid = ?")
    .get(uuid) as
    | { project: string | null; area: string | null; heading: string | null }
    | undefined;
  if (row === undefined) return { error: `${uuid} no longer exists` };
  if (row.heading !== null) {
    const project = headingProjectUuid(deps, row.heading);
    if (project === null) {
      return { error: `${uuid} is under a heading with no owning project — cannot restore it` };
    }
    return { kind: "heading", project, heading: row.heading };
  }
  if (row.project !== null) return { kind: "project", project: row.project };
  if (row.area !== null) return { kind: "area", area: row.area };
  return { kind: "loose" };
}

/** The todo.move params that restore a member to its captured origin. */
function restoreLegParams(uuid: string, origin: DayOrigin): TodoMoveParams {
  switch (origin.kind) {
    case "loose":
      return { uuid, loose: true };
    case "project":
      return { uuid, project: { uuid: origin.project } };
    case "heading":
      return { uuid, project: { uuid: origin.project }, heading: origin.heading };
    case "area":
      return { uuid, area: { uuid: origin.area } };
  }
}

/** Human-readable scope label for the compound's messages. */
function dayScopeLabel(scope: "loose-day" | "area-day" | "upcoming-day"): string {
  return scope === "loose-day"
    ? "loose future-day"
    : scope === "area-day"
      ? "direct-area future-day"
      : "cross-container future-day";
}

/** Leg options for a compound sub-mutation — each leg fully verified. */
function compoundLegOptions(options: WriteOptions, txnId: string): WriteOptions {
  const legs: WriteOptions = { txn: { id: txnId, role: "leg" } };
  if (options.maxDisruption !== undefined) legs.maxDisruption = options.maxDisruption;
  if (options.verifyTimeoutMs !== undefined) legs.verifyTimeoutMs = options.verifyTimeoutMs;
  if (options.actor !== undefined) legs.actor = options.actor;
  return legs;
}

/** A fresh unique-enough scratch-project title suffix (opId-ish). */
function scratchSuffix(startedAt: Date): string {
  return `${startedAt.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Abort payload: items are PARKED in the scratch project — name it for recovery. */
function dayAborted(
  detail: string,
  placed: string[],
  remaining: string[],
  cause: MutationResult | null,
): ReorderResult {
  return { kind: "bounce-aborted", op: "reorder", detail, placed, remaining, cause };
}

/**
 * The origin-aware park-sort-restore compound: loose-day / area-day / upcoming-day.
 * Parks the WHOLE future day-group into a scratch project, runs ONE container-day
 * reorder, restores each member to its captured origin FK, then trashes the
 * scratch. loose-day/area-day are uniform-origin degenerate cases (every member
 * homes loose / to the area); upcoming-day the mixed-origin general case.
 */
async function runDayCompound(
  deps: WriteDeps,
  params: ReorderParams,
  options: WriteOptions,
): Promise<ReorderResult> {
  const scope = params.scope as "loose-day" | "area-day" | "upcoming-day";
  const startedAt = deps.now?.() ?? new Date();
  const now = deps.now ?? (() => new Date());
  const actor = options.actor ?? deps.config.actor;
  const cap = deps.config.bounceMaxItems ?? BOUNCE_MAX_ITEMS;
  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;
  // area-day homes into an area; loose-day/upcoming-day carry no container.
  const containerUuid = scope === "area-day" ? (params.container?.uuid ?? null) : null;

  // Gate: the container-day reorder leg needs the experimental native surface —
  // inherit the container-day gating EXACTLY, and fail BEFORE any side effect
  // (a scratch project) rather than half-way through the protocol.
  const nativeAvailable =
    deps.config.allowExperimental && (deps.sdefProbe ?? sdefDeclaresPrivateReorder)();
  if (!nativeAvailable) {
    const result: MutationResult = {
      kind: "blocked",
      op: "reorder",
      reason: "environment",
      detail:
        `${dayScopeLabel(scope)} ordering runs the ORDFIN1 park-sort-restore protocol, whose ` +
        "reorder leg is the experimental native container-day command — it is unavailable " +
        (deps.config.allowExperimental
          ? "(the installed Things no longer declares the private reorder command in its sdef)"
          : "(allow-experimental is off)") +
        ", so the protocol was NOT attempted (no scratch project was created)",
      remediation: deps.config.allowExperimental
        ? "check `things doctor`; the private surface was likely removed by an app update"
        : "enable it with `things config set allow-experimental true`",
    };
    auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, { txnId, actor });
    return result;
  }

  // Enumerate the day-group (whole group is parked as one unit).
  const pre = computeReorderPre(deps.db, params, containerUuid, now());
  const targetOrder = pre.wireList;
  const named = new Set(params.named ?? params.uuids);
  const touchedUnnamed = targetOrder.filter((u) => !named.has(u));

  // Capture each member's ORIGIN before parking (upcoming-day is origin-aware; the
  // others are uniform). An unrestorable member is a fail-closed problem.
  const origins = new Map<string, DayOrigin>();
  const originErrors: string[] = [];
  for (const uuid of targetOrder) {
    const o = captureDayOrigin(deps, uuid);
    if ("error" in o) originErrors.push(o.error);
    else origins.set(uuid, o);
  }

  const problems: string[] = [];
  if (scope === "area-day") {
    if (params.container?.uuid === undefined) {
      problems.push("area-day needs the area container (the reorder's home area)");
    }
  } else if (params.container !== undefined) {
    problems.push(`${scope} takes no container (the day is read off a movee)`);
  }
  if (params.uuids.length === 0) problems.push("no uuids given");
  if (pre.duplicates.length > 0) problems.push(`duplicated uuid(s): ${pre.duplicates.join(", ")}`);
  for (const r of pre.rejected) problems.push(`${r.uuid} ${r.reason}`);
  problems.push(...originErrors);
  // upcoming-day: a same-day scheduled PROJECT row (type=1) cannot be parked into
  // the scratch project (UPCORD1). ORDFIN2 PRJMIX proved the strand law is
  // deterministic — an untouched same-day project row keeps its todayIndex byte-
  // identical and the park-sorted block always lands ABOVE it (the block is re-
  // based below the GLOBAL day-group minimum across all containers). So instead of
  // refusing fail-closed we proceed with the to-do sort and DISCLOSE the stranded
  // project rows (a REQUESTED project movee stays refused by computeReorderPre —
  // it is unsortable here; only untouched project SIBLINGS strand). Templates are
  // still refused as movees (§9e, via computeReorderPre).
  const stranded: { uuid: string; title: string }[] = [];
  if (scope === "upcoming-day") {
    const firstUuid = params.uuids[0];
    const first =
      firstUuid !== undefined
        ? (deps.db
            .prepare("SELECT startDate, startBucket FROM TMTask WHERE uuid = ?")
            .get(firstUuid) as { startDate: number | null; startBucket: number } | undefined)
        : undefined;
    if (first?.startDate != null && first.startBucket === 0) {
      const requested = new Set(params.uuids);
      const projectRows = deps.db
        .prepare(
          "SELECT uuid, title FROM TMTask WHERE trashed = 0 AND status = 0 AND type = 1 " +
            'AND startBucket = 0 AND startDate = ? ORDER BY todayIndex ASC, "index" ASC',
        )
        .all(first.startDate) as { uuid: string; title: string | null }[];
      for (const r of projectRows) {
        if (!requested.has(r.uuid)) stranded.push({ uuid: r.uuid, title: r.title ?? "" });
      }
    }
  }
  if (targetOrder.length > cap) {
    problems.push(
      `${targetOrder.length} touched items exceed the cap of ${cap} (the whole day-group is ` +
        "parked as one unit; each item costs a park + restore leg" +
        (touchedUnnamed.length > 0
          ? `; ${touchedUnnamed.length} un-named day-group sibling(s) are co-parked too`
          : "") +
        ")",
    );
  }
  if (problems.length > 0) {
    const result: MutationResult = {
      kind: "blocked",
      op: "reorder",
      reason: "hazard",
      hazard: "H-REORDER-SCOPE",
      detail: `${scope} reorder rejected: ${problems.join("; ")}`,
      remediation:
        `reorder ${dayScopeLabel(scope)} to-dos that all share ONE future Upcoming day (mixed ` +
        "dates and templates are refused; a same-day scheduled project row is left in place below " +
        "the sorted block, not sorted), at most " +
        `${cap} in the day-group (set with \`things config set bounce-max-items\`)`,
    };
    auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, { txnId, actor });
    return result;
  }

  // Pre-ranks (todayIndex order of the whole day-group) make the SUMMARY the
  // undoable unit — the inverse re-runs this protocol with the prior order.
  const preRanks: Record<string, unknown> = {};
  for (const m of pre.members) preRanks[m.uuid] = m.rank;

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op: "reorder",
      plan: {
        op: "reorder",
        vector: "url-scheme",
        tier: 0,
        invocation:
          `${scope} park-sort-restore ×${targetOrder.length} ` +
          `(scratch project + ${targetOrder.length} park + 1 container-day reorder + ` +
          `${targetOrder.length} restore + trash; ` +
          (touchedUnnamed.length > 0 ? `${touchedUnnamed.length} co-parked sibling(s); ` : "") +
          "one terminal order verify)",
        expectedDelta: { mode: "ordering", key: "todayIndex", sequence: targetOrder },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);
  const scratchTitle = `things-api ${scope} ${scratchSuffix(startedAt)}`;

  // 1. Create the scratch PROJECT.
  const add = await runMutation(deps, "project.add", { title: scratchTitle }, legOpts);
  if (add.kind !== "ok" || add.uuid === null) {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [] },
      { pre: preRanks, txnId, actor },
    );
    return dayAborted(
      `could not create the scratch project "${scratchTitle}" — nothing was parked; ` +
        "no changes were made",
      [],
      targetOrder,
      add.kind === "ok" ? null : add,
    );
  }
  const scratch = add.uuid;

  // 2. PARK each day-group member into the scratch project (URL list-id).
  const parked: string[] = [];
  for (const uuid of targetOrder) {
    const res = await runMutation(deps, "todo.move", { uuid, project: { uuid: scratch } }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...parked] },
        { pre: preRanks, txnId, actor },
      );
      return dayAborted(
        `parking ${uuid} into scratch project ${scratch} failed — ${parked.length} item(s) are ` +
          `PARKED there (${scratch}) and must be restored to their origin manually; the scratch ` +
          "project was NOT trashed",
        parked,
        targetOrder.slice(parked.length),
        res,
      );
    }
    parked.push(uuid);
  }

  // 3. ONE container-day reorder against the scratch project, full order.
  const reordered = await runReorder(
    deps,
    {
      scope: "container-day",
      container: { uuid: scratch },
      uuids: targetOrder,
      ...(params.named !== undefined && { named: params.named }),
    },
    legOpts,
  );
  if (reordered.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...parked] },
      { pre: preRanks, txnId, actor },
    );
    return dayAborted(
      `the container-day reorder against scratch project ${scratch} did not complete ` +
        `(${reordered.kind}) — all ${parked.length} item(s) are PARKED in ${scratch} and must be ` +
        "restored to their origin manually; the scratch project was NOT trashed",
      parked,
      [],
      reordered.kind === "bounce-aborted" ? null : reordered,
    );
  }

  // 4. RESTORE each member to its captured origin FK (loose / project / heading /
  //    area). A membership move is a todayIndex no-op, so restore-leg order is
  //    irrelevant — the container-day reorder alone fixed the order (Arm 4).
  const restored: string[] = [];
  for (const uuid of targetOrder) {
    const origin = origins.get(uuid) ?? { kind: "loose" as const };
    const res = await runMutation(deps, "todo.move", restoreLegParams(uuid, origin), legOpts);
    if (res.kind !== "ok") {
      const stillParked = targetOrder.filter((u) => !restored.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...restored] },
        { pre: preRanks, txnId, actor },
      );
      return dayAborted(
        `restoring ${uuid} from scratch project ${scratch} failed — ${stillParked.length} item(s) ` +
          `remain PARKED in ${scratch} (ordered) and must be restored to their origin manually; the ` +
          "scratch project was NOT trashed",
        restored,
        stillParked,
        res,
      );
    }
    restored.push(uuid);
  }

  // 5. TRASH the scratch project (delete-to-trash, never permanent). A failure
  //    here does NOT undo the (already-correct) order — disclose it instead.
  const del = await runMutation(deps, "project.delete", { uuid: scratch }, legOpts);
  const scratchTrashed = del.kind === "ok";

  // 6. Terminal verify: the day-group order matches the target (todayIndex).
  const verify = await pollUntilVerified(
    () =>
      evaluateDelta(
        { mode: "ordering", key: "todayIndex", sequence: targetOrder },
        createDbReader(deps.db),
        { modDates: {}, fields: {} },
      ),
    options.verifyTimeoutMs ?? 4000,
    deps.poller ?? {},
  );
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...restored] },
      { pre: preRanks, txnId, actor },
    );
    return dayAborted(
      "the day-group did not land the requested order after restoring " +
        `(scratch project ${scratch} was ${scratchTrashed ? "trashed" : "left in place"}); ` +
        "re-run once Things is idle",
      restored,
      [],
      null,
    );
  }

  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of targetOrder) observed[uuid] = reader.rankOf(uuid, "todayIndex");
  auditSummary(deps, params, startedAt, "ok", observed, { pre: preRanks, txnId, actor });

  const warnings = [
    `scratch project ${scratch} was created for the reorder and ` +
      (scratchTrashed
        ? "moved to the Trash (empty; one per invocation — the protocol never hard-deletes it)"
        : `could NOT be trashed (${del.kind}) — it remains in your project list empty; delete it manually`),
  ];
  if (stranded.length > 0) {
    // Placement-honesty note (PRJMIX): the sorted block is at the TOP of the day;
    // the untouched project row(s) remain BELOW it in their prior relative order.
    warnings.push(
      `the day's to-dos were sorted and placed at the top of the day; ${stranded.length} same-day ` +
        `scheduled project row(s) are not parkable (UPCORD1) so they remain below the sorted block ` +
        `in their prior relative order: ${stranded.map((s) => s.uuid).join(", ")}`,
    );
  }
  return {
    kind: "ok",
    op: "reorder",
    uuid: null,
    observed,
    vector: "url-scheme",
    tier: 0,
    undoToken: txnId,
    warnings,
    ...(touchedUnnamed.length > 0 && { touched: touchedUnnamed }),
    ...(stranded.length > 0 && { stranded }),
  };
}

// ----------------------------------------------------- heading sub-buckets
//
// HEADSUB1 (docs/lab/headsub1-heading-subbuckets.md) settled the per-class order
// of a heading's sub-buckets. Two are wired here; the third (anytime) already
// rides the `heading` bounce, and the evening sub-bucket stays app-default (its
// display ordering axis is GUI-ambiguous — Arm B).
//
//   heading-someday: UNHEAD the block, then RE-HEAD it in FORWARD target order
//     (Arm B-someday / Arm C + HEADSUB2 Q1). A re-head of a row ALREADY under the
//     target heading is a same-heading NO-OP (HEADSUB2 Q1(b) — index untouched),
//     so the block MUST be unheaded FIRST (clean — heading→NULL, index/start=2
//     preserved, Arm C); the re-head then BACK-INSERTS each now-loose row at the
//     heading someday-bucket end (§9h renumber, Arm B), so forward-order re-heads
//     land the exact target order (HEADSUB2 q1fix), `start=2` preserved. Two URL
//     move legs per item (unhead + re-head), no json collapse (re-head is a list-
//     id move, not a when= reindex); needs neither the experimental surface nor
//     the bounce. (The earlier direct-re-head-only compile shipped in #327 was a
//     silent no-op — HEADSUB2 §Q1 — corrected here.)
//
//   heading-day: the unhead → container-day reorder → re-head round-trip (Arm
//     C2). The native container-day reorder RIPS a headed child's heading FK on
//     the todayIndex axis too (§9k / Arm A), so a headed row must NEVER be fed to
//     it directly — the protocol unheads the whole same-day headed sub-bucket
//     FIRST (clean, date/todayIndex-preserving), re-ranks the now-unheaded rows
//     via the shipped container-day scope, then re-heads each (todayIndex
//     preserved). Gated like container-day (allow-experimental); a mid-protocol
//     failure leaves items UNHEADED in the project root and fails loudly.

/** The project a heading belongs to (its re-head destination), or null. */
function headingProjectUuid(deps: WriteDeps, headingUuid: string | null): string | null {
  if (headingUuid === null) return null;
  const row = deps.db
    .prepare("SELECT project FROM TMTask WHERE uuid = ? AND type = 2 AND trashed = 0")
    .get(headingUuid) as { project: string | null } | undefined;
  return row?.project ?? null;
}

/** Abort payload for heading-someday: items are UNHEADED in the project root. */
function headingSomedayAborted(
  detail: string,
  placed: string[],
  remaining: string[],
  cause: MutationResult | null,
): ReorderResult {
  return { kind: "bounce-aborted", op: "reorder", detail, placed, remaining, cause };
}

/**
 * heading-someday: the unhead → re-head round-trip (HEADSUB1 Arm B-someday / Arm
 * C + HEADSUB2 Q1). A re-head of a row ALREADY under the target heading is a
 * same-heading NO-OP (HEADSUB2 Q1(b) — the app leaves `index` untouched), so the
 * block cannot be sorted by re-heading in place. The block is UNHEADED first
 * (clean — heading→NULL, `index`/`start=2` preserved, Arm C), then RE-HEADED in
 * forward target order — each now-loose row BACK-INSERTS at the heading someday-
 * bucket end (§9h renumber, Arm B), so forward-order re-heads land the exact
 * target order (HEADSUB2 q1fix). The block is the SUFFIX from the first named
 * movee's target slot to the bucket end; the untouched prefix stays headed above
 * (its `index` is below the re-inserted block), and unnamed siblings inside the
 * suffix are co-unheaded + co-re-headed (disclosed as `touched`). Two `todo.move`
 * legs per item (unhead + re-head), `start=2` preserved throughout; needs neither
 * the experimental surface nor the bounce, and there is no json collapse (re-head
 * is a list-id move). Non-atomic: a mid-protocol failure leaves items UNHEADED in
 * the project root and fails loudly with placed/remaining detail.
 */
async function runHeadingSomeday(
  deps: WriteDeps,
  params: ReorderParams,
  options: WriteOptions,
): Promise<ReorderResult> {
  const startedAt = deps.now?.() ?? new Date();
  const now = deps.now ?? (() => new Date());
  const actor = options.actor ?? deps.config.actor;
  const cap = deps.config.bounceMaxItems ?? BOUNCE_MAX_ITEMS;
  const headingUuid = params.container?.uuid ?? null;
  const projectUuid = headingProjectUuid(deps, headingUuid);
  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;

  const pre = computeReorderPre(deps.db, params, headingUuid, now());
  const preRanks: Record<string, unknown> = {};
  for (const m of pre.members) preRanks[m.uuid] = m.rank;

  // Back-insert (like the heading bounce): the SUFFIX from the first named movee's
  // target slot to the bucket end is unheaded then re-headed forward (each appends).
  const targetOrder = pre.wireList;
  const named = new Set(params.named ?? params.uuids);
  const movedPositions = targetOrder.map((u, i) => (named.has(u) ? i : -1)).filter((i) => i >= 0);
  const firstMoved = movedPositions.length > 0 ? (movedPositions[0] as number) : 0;
  const block = targetOrder.slice(firstMoved);
  const touchedUnnamed = block.filter((u) => !named.has(u));

  const problems: string[] = [];
  if (headingUuid === null || projectUuid === null) {
    problems.push("the heading did not resolve to a project (re-head needs the heading's project)");
  }
  if (params.uuids.length === 0) problems.push("no uuids given");
  if (pre.duplicates.length > 0) problems.push(`duplicated uuid(s): ${pre.duplicates.join(", ")}`);
  for (const r of pre.rejected) problems.push(`${r.uuid} ${r.reason}`);
  if (block.length > cap) {
    problems.push(
      `${block.length} touched items exceed the cap of ${cap} (each costs an unhead + re-head leg` +
        (touchedUnnamed.length > 0
          ? `; ${touchedUnnamed.length} unnamed heading sibling(s) are co-re-headed to honor the order`
          : "") +
        ")",
    );
  }
  if (problems.length > 0) {
    const result: MutationResult = {
      kind: "blocked",
      op: "reorder",
      reason: "hazard",
      hazard: "H-REORDER-SCOPE",
      detail: `within-heading someday reorder rejected: ${problems.join("; ")}`,
      remediation:
        "reorder the Someday children of ONE heading (read the project first), " +
        `at most ${cap} touched (set with \`things config set bounce-max-items\`)`,
    };
    auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, {
      pre: preRanks,
      txnId,
      actor,
    });
    return result;
  }

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op: "reorder",
      plan: {
        op: "reorder",
        vector: "url-scheme",
        tier: 0,
        invocation:
          `unhead ×${block.length} → re-head ×${block.length} (back-insert, forward order` +
          (touchedUnnamed.length > 0
            ? `, touches ${touchedUnnamed.length} unnamed sibling(s)`
            : "") +
          "): a same-heading re-head is a no-op (HEADSUB2 Q1), so the block is unheaded first; " +
          "each `list-id=<project>&heading=<heading>` then appends at the someday-bucket end; " +
          "one terminal order verify",
        expectedDelta: { mode: "ordering", key: "index", sequence: block },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);

  // 1. UNHEAD each block member (clean — heading→NULL, index/start=2 preserved).
  //    A same-heading re-head is a NO-OP (HEADSUB2 Q1(b)), so the block MUST be
  //    unheaded before it can be re-inserted in order.
  const unheaded: string[] = [];
  for (const uuid of block) {
    const res = await runMutation(deps, "todo.move", { uuid, noHeading: true }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...unheaded] },
        { pre: preRanks, txnId, actor },
      );
      return headingSomedayAborted(
        `unheading ${uuid} failed — ${unheaded.length} item(s) are UNHEADED in project ` +
          `${projectUuid} and must be moved back under the heading manually`,
        unheaded,
        block.slice(unheaded.length),
        res,
      );
    }
    unheaded.push(uuid);
  }

  // 2. RE-HEAD each in forward target order — each now-loose row BACK-INSERTS at
  //    the someday-bucket end (Arm B), so forward-order re-heads land the target.
  const placed: string[] = [];
  for (const uuid of block) {
    const res = await runMutation(
      deps,
      "todo.move",
      { uuid, project: { uuid: projectUuid as string }, heading: headingUuid as string },
      legOpts,
    );
    if (res.kind !== "ok") {
      const stillUnheaded = block.filter((u) => !placed.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId, actor },
      );
      return headingSomedayAborted(
        `re-heading ${uuid} failed — ${stillUnheaded.length} item(s) remain UNHEADED in project ` +
          `${projectUuid} (ordered) and must be moved back under the heading manually`,
        placed,
        stillUnheaded,
        res,
      );
    }
    placed.push(uuid);
  }

  // 3. Terminal verify: the block's index order matches the target.
  const verify = await pollUntilVerified(
    () =>
      evaluateDelta({ mode: "ordering", key: "index", sequence: block }, createDbReader(deps.db), {
        modDates: {},
        fields: {},
      }),
    options.verifyTimeoutMs ?? 4000,
    deps.poller ?? {},
  );
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...placed] },
      { pre: preRanks, txnId, actor },
    );
    return headingSomedayAborted(
      "the heading someday sub-bucket did not land the requested order after re-heading; " +
        "re-run once Things is idle",
      placed,
      [],
      null,
    );
  }

  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of block) observed[uuid] = reader.rankOf(uuid, "index");
  auditSummary(deps, params, startedAt, "ok", observed, { pre: preRanks, txnId, actor });
  return {
    kind: "ok",
    op: "reorder",
    uuid: null,
    observed,
    vector: "url-scheme",
    tier: 0,
    undoToken: txnId,
    ...(touchedUnnamed.length > 0 && { touched: touchedUnnamed }),
  };
}

/** Abort payload for heading-day: items are UNHEADED in the project root. */
function headingDayAborted(
  detail: string,
  placed: string[],
  remaining: string[],
  cause: MutationResult | null,
): ReorderResult {
  return { kind: "bounce-aborted", op: "reorder", detail, placed, remaining, cause };
}

/**
 * heading-day: the unhead → container-day reorder → re-head round-trip (HEADSUB1
 * Arm C2). The native container-day reorder RIPS a headed child's heading FK on
 * the todayIndex axis (§9k / Arm A), so the whole same-day headed sub-bucket is
 * unheaded FIRST (clean — heading→NULL, date/todayIndex/start preserved), re-
 * ranked via the shipped container-day scope against the real project, then re-
 * headed (todayIndex preserved). Gated like container-day (allow-experimental).
 * Non-atomic: a mid-protocol failure leaves items UNHEADED in the project root
 * and fails loudly with placed/remaining detail.
 */
async function runHeadingDay(
  deps: WriteDeps,
  params: ReorderParams,
  options: WriteOptions,
): Promise<ReorderResult> {
  const startedAt = deps.now?.() ?? new Date();
  const now = deps.now ?? (() => new Date());
  const actor = options.actor ?? deps.config.actor;
  const cap = deps.config.bounceMaxItems ?? BOUNCE_MAX_ITEMS;
  const headingUuid = params.container?.uuid ?? null;
  const projectUuid = headingProjectUuid(deps, headingUuid);
  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;

  // Gate: the container-day reorder leg needs the experimental native surface —
  // fail BEFORE any side effect (no half-unheaded sub-bucket).
  const nativeAvailable =
    deps.config.allowExperimental && (deps.sdefProbe ?? sdefDeclaresPrivateReorder)();
  if (!nativeAvailable) {
    const result: MutationResult = {
      kind: "blocked",
      op: "reorder",
      reason: "environment",
      detail:
        "within-heading day ordering runs the HEADSUB1 unhead → container-day reorder → re-head " +
        "round-trip, whose reorder leg is the experimental native container-day command — it is " +
        "unavailable " +
        (deps.config.allowExperimental
          ? "(the installed Things no longer declares the private reorder command in its sdef)"
          : "(allow-experimental is off)") +
        ", so the protocol was NOT attempted (nothing was unheaded)",
      remediation: deps.config.allowExperimental
        ? "check `things doctor`; the private surface was likely removed by an app update"
        : "enable it with `things config set allow-experimental true`",
    };
    auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, { txnId, actor });
    return result;
  }

  const pre = computeReorderPre(deps.db, params, headingUuid, now());
  const targetOrder = pre.wireList;
  const named = new Set(params.named ?? params.uuids);
  const touchedUnnamed = targetOrder.filter((u) => !named.has(u));

  const problems: string[] = [];
  if (headingUuid === null || projectUuid === null) {
    problems.push("the heading did not resolve to a project (re-head needs the heading's project)");
  }
  if (params.uuids.length === 0) problems.push("no uuids given");
  if (pre.duplicates.length > 0) problems.push(`duplicated uuid(s): ${pre.duplicates.join(", ")}`);
  for (const r of pre.rejected) problems.push(`${r.uuid} ${r.reason}`);
  if (targetOrder.length > cap) {
    problems.push(
      `${targetOrder.length} touched items exceed the cap of ${cap} (the whole same-day headed ` +
        `sub-bucket is unheaded + re-headed as one unit; each costs an unhead + re-head leg` +
        (touchedUnnamed.length > 0
          ? `; ${touchedUnnamed.length} unnamed same-day heading sibling(s) are co-unheaded too`
          : "") +
        ")",
    );
  }
  if (problems.length > 0) {
    const result: MutationResult = {
      kind: "blocked",
      op: "reorder",
      reason: "hazard",
      hazard: "H-REORDER-SCOPE",
      detail: `within-heading day reorder rejected: ${problems.join("; ")}`,
      remediation:
        "reorder same-day scheduled children of ONE heading that all share ONE day (mixed dates, " +
        `templates, and non-members are refused), at most ${cap} in the sub-bucket ` +
        "(set with `things config set bounce-max-items`)",
    };
    auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, {
      pre: captureRanks(pre),
      txnId,
      actor,
    });
    return result;
  }

  const preRanksMap = captureRanks(pre);

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op: "reorder",
      plan: {
        op: "reorder",
        vector: "url-scheme",
        tier: 0,
        invocation:
          `unhead ×${targetOrder.length} → container-day reorder → re-head ×${targetOrder.length} ` +
          (touchedUnnamed.length > 0 ? `(${touchedUnnamed.length} co-unheaded sibling(s); ` : "(") +
          "the native container-day leg RIPS a headed row, §9k, so the sub-bucket is unheaded " +
          "first; one terminal order verify)",
        expectedDelta: { mode: "ordering", key: "todayIndex", sequence: targetOrder },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);

  // 1. UNHEAD each same-day headed member (clean — heading→NULL, schedule kept).
  //    After this NO member is headed, so the container-day leg can never see a
  //    headed row (the §9k rail: computeReorderPre(container-day) also filters
  //    `heading IS NULL`, a second guard).
  const unheaded: string[] = [];
  for (const uuid of targetOrder) {
    const res = await runMutation(deps, "todo.move", { uuid, noHeading: true }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...unheaded] },
        {
          pre: preRanksMap,
          txnId,
          actor,
        },
      );
      return headingDayAborted(
        `unheading ${uuid} failed — ${unheaded.length} item(s) are UNHEADED in project ` +
          `${projectUuid} and must be moved back under the heading manually`,
        unheaded,
        targetOrder.slice(unheaded.length),
        res,
      );
    }
    unheaded.push(uuid);
  }

  // 2. ONE container-day reorder against the REAL project, full target order. The
  //    now-unheaded members re-rank date-preservingly (DAYORD-b); the project's
  //    OTHER same-day unheaded children are co-ranked below (relative order kept).
  const reordered = await runReorder(
    deps,
    {
      scope: "container-day",
      container: { uuid: projectUuid as string },
      uuids: targetOrder,
      ...(params.named !== undefined && { named: params.named }),
    },
    legOpts,
  );
  if (reordered.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...unheaded] },
      {
        pre: preRanksMap,
        txnId,
        actor,
      },
    );
    return headingDayAborted(
      `the container-day reorder against project ${projectUuid} did not complete ` +
        `(${reordered.kind}) — all ${unheaded.length} item(s) are UNHEADED in the project root and ` +
        "must be moved back under the heading manually",
      unheaded,
      [],
      reordered.kind === "bounce-aborted" ? null : reordered,
    );
  }

  // 3. RE-HEAD each (todayIndex preserved — the sorted key survives, Arm C2).
  const rehead: string[] = [];
  for (const uuid of targetOrder) {
    const res = await runMutation(
      deps,
      "todo.move",
      { uuid, project: { uuid: projectUuid as string }, heading: headingUuid as string },
      legOpts,
    );
    if (res.kind !== "ok") {
      const stillUnheaded = targetOrder.filter((u) => !rehead.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...rehead] },
        {
          pre: preRanksMap,
          txnId,
          actor,
        },
      );
      return headingDayAborted(
        `re-heading ${uuid} failed — ${stillUnheaded.length} item(s) remain UNHEADED in project ` +
          `${projectUuid} (ordered) and must be moved back under the heading manually`,
        rehead,
        stillUnheaded,
        res,
      );
    }
    rehead.push(uuid);
  }

  // 4. Terminal verify: the sub-bucket's todayIndex order matches the target.
  const verify = await pollUntilVerified(
    () =>
      evaluateDelta(
        { mode: "ordering", key: "todayIndex", sequence: targetOrder },
        createDbReader(deps.db),
        { modDates: {}, fields: {} },
      ),
    options.verifyTimeoutMs ?? 4000,
    deps.poller ?? {},
  );
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...rehead] },
      {
        pre: preRanksMap,
        txnId,
        actor,
      },
    );
    return headingDayAborted(
      "the heading sub-bucket did not land the requested order after re-heading; " +
        "re-run once Things is idle",
      rehead,
      [],
      null,
    );
  }

  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of targetOrder) observed[uuid] = reader.rankOf(uuid, "todayIndex");
  auditSummary(deps, params, startedAt, "ok", observed, { pre: preRanksMap, txnId, actor });
  return {
    kind: "ok",
    op: "reorder",
    uuid: null,
    observed,
    vector: "url-scheme",
    tier: 0,
    undoToken: txnId,
    ...(touchedUnnamed.length > 0 && { touched: touchedUnnamed }),
  };
}

/** todayIndex/index pre-ranks keyed by uuid (the undoable-summary capture). */
function captureRanks(pre: ReturnType<typeof computeReorderPre>): Record<string, unknown> {
  const ranks: Record<string, unknown> = {};
  for (const m of pre.members) ranks[m.uuid] = m.rank;
  return ranks;
}

// ------------------------------------------------------------------- bounce

async function runBounce(
  deps: WriteDeps,
  params: ReorderParams,
  bounceKind: BounceKind,
  options: WriteOptions,
): Promise<ReorderResult> {
  const startedAt = deps.now?.() ?? new Date();
  const now = deps.now ?? (() => new Date());
  const actor = options.actor ?? deps.config.actor;
  const spec = bounceSpecOf(bounceKind);
  const { away, back, direction, rankKey, legOp } = spec;
  const cap = deps.config.bounceMaxItems ?? BOUNCE_MAX_ITEMS;
  const containerUuid = resolveContainerUuid(deps, params);
  const wantsContainer =
    bounceKind === "heading" || bounceKind === "area-someday" || bounceKind === "project-someday";

  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;
  // Scope/membership guard — same data the native path's guard uses.
  const pre = computeReorderPre(deps.db, params, containerUuid, now());
  // Pre-ranks make the SUMMARY record the undoable unit (a single inverse
  // reorder restores the old relative order); legs are excluded from undo.
  const preRanks: Record<string, unknown> = {};
  for (const m of pre.members) preRanks[m.uuid] = m.rank;
  // The bounce re-inserts the MINIMAL contiguous run of `pre.wireList` (the full
  // target order the planner spliced) needed to realize the request, per the
  // BOUNCE2 laws:
  //   - back-insert (heading / project children): the SUFFIX from the first named
  //     movee's target slot to the bucket end, bounced FORWARD (each appends,
  //     ending at the bottom in order; the untouched prefix stays above);
  //   - front-insert (loose / area-direct): the PREFIX from the top to the last
  //     named movee's target slot, bounced REVERSE (each front-inserts, ending at
  //     the top in order; the untouched suffix stays below).
  // Everything ELSE in the run beyond the named block is a CO-BOUNCED sibling —
  // touched (mod bump, changes-feed entry, audit leg) and disclosed.
  const targetOrder = pre.wireList;
  const named = new Set(params.named ?? params.uuids);
  const movedPositions = targetOrder.map((u, i) => (named.has(u) ? i : -1)).filter((i) => i >= 0);
  const firstMoved = movedPositions.length > 0 ? (movedPositions[0] as number) : 0;
  const lastMoved =
    movedPositions.length > 0 ? (movedPositions[movedPositions.length - 1] as number) : 0;
  const coBounce =
    direction === "back" ? targetOrder.slice(firstMoved) : targetOrder.slice(0, lastMoved + 1);
  const touchedUnnamed = coBounce.filter((u) => !named.has(u));

  const problems: string[] = [];
  if (params.container !== undefined && !wantsContainer)
    problems.push("container is only valid for the heading / area-someday / project scopes");
  if (params.uuids.length === 0) problems.push("no uuids given");
  if (pre.duplicates.length > 0) problems.push(`duplicated uuid(s): ${pre.duplicates.join(", ")}`);
  for (const r of pre.rejected) problems.push(`${r.uuid} ${r.reason}`);
  if (legOp === "todo.update") {
    for (const uuid of pre.projectMembers) {
      problems.push(
        `${uuid} is a project — bounce re-schedules via todo.update, which is only validated ` +
          "for to-dos; use the native strategy for Today lists containing projects",
      );
    }
  }
  if (coBounce.length > cap) {
    problems.push(
      `${coBounce.length} touched items exceed the bounce cap of ${cap} ` +
        "(each costs two verified mutations" +
        (touchedUnnamed.length > 0
          ? `; the anchor placement re-inserts ${touchedUnnamed.length} unnamed sibling(s) too`
          : "") +
        ")",
    );
  }
  if (problems.length > 0) {
    const result: MutationResult = {
      kind: "blocked",
      op: "reorder",
      reason: "hazard",
      hazard: "H-REORDER-SCOPE",
      detail: `reorder request rejected: ${problems.join("; ")}`,
      remediation:
        "read the scope first (things today) and pass only its eligible members, " +
        `at most ${cap} for the bounce strategy (set with \`things config set bounce-max-items\`)`,
    };
    auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, {
      pre: preRanks,
      txnId,
      actor,
    });
    return result;
  }

  // Front-insert contexts (loose/area-direct) place last-first (reverse iterate,
  // unshift); back-insert contexts (heading/project children) place first-first
  // (forward iterate, push). Either way `placed` holds the current top-to-bottom
  // order of the bounced block. The SAME per-item order drives the json-array
  // collapse (array order == result index order for both directions).
  const order =
    direction === "front"
      ? coBounce.map((_, i) => coBounce.length - 1 - i)
      : coBounce.map((_, i) => i);

  // BOUNCEJSON collapse (§9i): when the placement (`back`) leg is when=anytime
  // into a loose/heading-container bucket, the whole N-item round-trip collapses
  // to ONE pre-validated `things:///json` array (2N ops, 1 dispatch, ~7×,
  // validate-first FULL-ABORT). Only against a REAL dispatch surface — under the
  // simulator (simulates=true, per-op appliers, no json-array applier) we keep
  // the proven sequential legs.
  const dispatchVector = pickDispatchVector(deps, legOp);
  const useJson =
    spec.jsonCollapsible && dispatchVector !== undefined && dispatchVector.simulates !== true;

  if (options.dryRun === true) {
    const invocation = useJson
      ? `json-collapse ×${coBounce.length} (${direction}-insert, ` +
        `${direction === "front" ? "reverse" : "forward"} array order, ` +
        (touchedUnnamed.length > 0 ? `touches ${touchedUnnamed.length} unnamed sibling(s), ` : "") +
        `1 dispatch / ${coBounce.length * 2} ops): ` +
        `when=${away} → when=${back} interleaved per item; validate-first full-abort, ` +
        `one terminal order verify`
      : `bounce ×${coBounce.length} (${direction}-insert, ` +
        `${direction === "front" ? "reverse" : "forward"} order, ` +
        (touchedUnnamed.length > 0 ? `touches ${touchedUnnamed.length} unnamed sibling(s), ` : "") +
        `${coBounce.length * 2} legs): ` +
        `when=${away} → when=${back}; one verify per item round-trip`;
    return {
      kind: "dry-run",
      op: "reorder",
      plan: {
        op: "reorder",
        vector: "url-scheme",
        tier: 0,
        invocation,
        expectedDelta: { mode: "ordering", key: rankKey, sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  if (useJson) {
    return runBounceJsonCollapse(deps, params, spec, {
      coBounce,
      order,
      bounceKind,
      containerUuid,
      preRanks,
      txnId,
      actor,
      touchedUnnamed,
      startedAt,
      options,
      vector: dispatchVector as WriteVector,
    });
  }

  const placed: string[] = [];
  for (let step = 0; step < order.length; step++) {
    const i = order[step] as number;
    const uuid = coBounce[i] as string;
    const remainingBefore = () =>
      direction === "front" ? coBounce.slice(0, i + 1) : coBounce.slice(i);

    // Concurrent-edit re-check: the item must still be an eligible member.
    const memberProblem = checkStillMember(deps, uuid, bounceKind, containerUuid, now());
    if (memberProblem !== null) {
      const detail =
        `aborted before bouncing ${uuid}: ${memberProblem} (Things was likely edited ` +
        "concurrently); already-placed items keep their new positions";
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId, actor },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail,
        placed: [...placed],
        remaining: remainingBefore(),
        cause: null,
      };
    }

    // leg 1 sends the item AWAY from its resting bucket; leg 2 returns it — the
    // return leg is what front/back-inserts (BOUNCE2 re-entry law).
    const leg1 = await runMutation(deps, legOp, { uuid, when: away }, legOptions(options, txnId));
    if (leg1.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId, actor },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail: `bounce leg 1 (when=${away}) failed for ${uuid} — the item was NOT moved`,
        placed: [...placed],
        remaining: remainingBefore(),
        cause: leg1,
      };
    }
    // leg 2 must follow leg 1's committed state for the same item before the next item's bounce begins
    const leg2 = await runMutation(deps, legOp, { uuid, when: back }, legOptions(options, txnId));
    if (leg2.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId, actor },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail:
          `bounce leg 2 (when=${back}) failed for ${uuid} — THE ITEM IS STRANDED IN ` +
          `${away.toUpperCase()}; re-schedule it (when=${back}) or fix in the app`,
        placed: [...placed],
        remaining: remainingBefore(),
        cause: leg2,
      };
    }
    if (direction === "front") placed.unshift(uuid);
    else placed.push(uuid);

    // Placed-prefix invariant: everything bounced so far must read back in
    // requested relative order — anything else means a concurrent reshuffle.
    // the placed-prefix must be verified after each item before bouncing the next, so a concurrent reshuffle is caught immediately rather than compounded
    const prefixCheck = await pollUntilVerified(
      () =>
        evaluateDelta(
          { mode: "ordering", key: rankKey, sequence: [...placed] },
          createDbReader(deps.db),
          { modDates: {}, fields: {} },
        ),
      options.verifyTimeoutMs ?? 4000,
      deps.poller ?? {},
    );
    if (prefixCheck.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId, actor },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail:
          `placed items fell out of order after bouncing ${uuid} (concurrent edit?); ` +
          "re-run the reorder once Things is idle",
        placed: [...placed],
        remaining: direction === "front" ? coBounce.slice(0, i) : coBounce.slice(i + 1),
        cause: null,
      };
    }
  }

  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of coBounce) observed[uuid] = reader.rankOf(uuid, rankKey);
  auditSummary(deps, params, startedAt, "ok", observed, { pre: preRanks, txnId, actor });
  return {
    kind: "ok",
    op: "reorder",
    uuid: null,
    observed,
    vector: "url-scheme",
    tier: 0,
    // A bounce reorder is a summary txn, so its token is the txn id (matches
    // the audit record's undoToken); pass it to `things undo --txn <token>`.
    undoToken: txnId,
    // Co-bounced siblings the anchor placement re-inserted (honest disclosure).
    ...(touchedUnnamed.length > 0 && { touched: touchedUnnamed }),
  };
}

/**
 * The url-scheme dispatch surface for a leg op — the vector the json collapse
 * opens its `things:///json` array through. In tests this is the injected fake
 * (id "url-scheme"); in production `createUrlSchemeVector`; under the simulator
 * fence the simulator (id "url-scheme", simulates=true) — which the caller then
 * rejects for the collapse (it has no json-array applier) and falls back to the
 * sequential per-leg bounce the simulator DOES model.
 */
function pickDispatchVector(
  deps: WriteDeps,
  legOp: "todo.update" | "project.update",
): WriteVector | undefined {
  return deps.vectors.find((v) => v.id === "url-scheme" && v.matrix[legOp]?.support === "yes");
}

interface JsonCollapseCtx {
  coBounce: string[];
  /** Per-item placement order (reverse target for front-insert, forward for back). */
  order: number[];
  bounceKind: BounceKind;
  containerUuid: string | null;
  preRanks: Record<string, unknown>;
  txnId: string;
  actor: string;
  touchedUnnamed: string[];
  startedAt: Date;
  options: WriteOptions;
  vector: WriteVector;
}

/**
 * The BOUNCEJSON collapse (§9i / BJ-a / BJ-c): dispatch the whole bounce as ONE
 * pre-validated `things:///json` update array carrying `[{when:away},{when:back}]`
 * per item, iterated in the SAME per-item order the sequential loop uses (so
 * array order == the resulting index order for both insert directions), then run
 * ONE terminal ordering verify. The app validates the entire array first and
 * applies it all-or-nothing, so a failed dispatch/verify means NOTHING landed —
 * there is no partial-progress state to reconcile (contrast the sequential
 * path's placed/remaining bookkeeping). Every id was already resolved in
 * {@link runReorder} (a single unresolvable ref would full-abort the batch).
 */
async function runBounceJsonCollapse(
  deps: WriteDeps,
  params: ReorderParams,
  spec: BounceSpec,
  ctx: JsonCollapseCtx,
): Promise<ReorderResult> {
  const {
    coBounce,
    order,
    bounceKind,
    containerUuid,
    preRanks,
    txnId,
    actor,
    touchedUnnamed,
    startedAt,
    options,
    vector,
  } = ctx;
  const { away, back, rankKey } = spec;
  const now = deps.now ?? (() => new Date());

  const abort = (detail: string): ReorderResult => {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return {
      kind: "bounce-aborted",
      op: "reorder",
      detail,
      placed: [],
      remaining: coBounce,
      cause: null,
    };
  };

  // Validate-first full-abort means nothing lands, so the concurrent-edit guard
  // checks EVERY member up front (not per item as the sequential loop does).
  for (const uuid of coBounce) {
    const problem = checkStillMember(deps, uuid, bounceKind, containerUuid, now());
    if (problem !== null) {
      return abort(
        `aborted before the json-collapsed bounce: ${uuid} ${problem} (Things was likely ` +
          "edited concurrently); NOTHING was applied",
      );
    }
  }

  // ONE json array, both legs interleaved per item, in placement order.
  const ops = order.flatMap((i) => {
    const uuid = coBounce[i] as string;
    return [
      { type: "to-do", operation: "update", id: uuid, attributes: { when: away } },
      { type: "to-do", operation: "update", id: uuid, attributes: { when: back } },
    ];
  });
  const token = readAuthToken(deps.db);
  const data = encodeURIComponent(JSON.stringify(ops));
  const payload = `things:///json?data=${data}${token !== null ? `&auth-token=${encodeURIComponent(token)}` : ""}`;
  const redactedPayload = `things:///json?data=${data}${token !== null ? "&auth-token=REDACTED" : ""}`;

  const exec = await vector.execute({
    vector: "url-scheme",
    kind: "open-url",
    payload,
    redactedPayload,
  });
  if (exec.exitCode !== 0 || exec.timedOut === true) {
    return abort(
      `the json-collapsed bounce dispatch failed (exit ${exec.exitCode ?? "?"}` +
        `${exec.timedOut === true ? ", timed out" : ""}) — the array is validate-first ` +
        "all-or-nothing, so NOTHING was applied",
    );
  }

  // ONE terminal ordering verify over the whole run.
  const verify = await pollUntilVerified(
    () =>
      evaluateDelta(
        { mode: "ordering", key: rankKey, sequence: coBounce },
        createDbReader(deps.db),
        {
          modDates: {},
          fields: {},
        },
      ),
    options.verifyTimeoutMs ?? 4000,
    deps.poller ?? {},
  );
  if (verify.kind !== "ok") {
    return abort(
      "the json-collapsed bounce did not land the requested order — the app validates the " +
        "whole array first and applies it all-or-nothing (§9i / BJ-c), so NOTHING was applied " +
        "(no partial-progress repair needed); re-run once Things is idle",
    );
  }

  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of coBounce) observed[uuid] = reader.rankOf(uuid, rankKey);
  auditSummary(deps, params, startedAt, "ok", observed, { pre: preRanks, txnId, actor });
  return {
    kind: "ok",
    op: "reorder",
    uuid: null,
    observed,
    vector: "url-scheme",
    tier: 0,
    undoToken: txnId,
    ...(touchedUnnamed.length > 0 && { touched: touchedUnnamed }),
  };
}

function legOptions(options: WriteOptions, txnId?: string): WriteOptions {
  const legs: WriteOptions = {};
  if (txnId !== undefined) legs.txn = { id: txnId, role: "leg" };
  if (options.maxDisruption !== undefined) legs.maxDisruption = options.maxDisruption;
  if (options.verifyTimeoutMs !== undefined) legs.verifyTimeoutMs = options.verifyTimeoutMs;
  if (options.actor !== undefined) legs.actor = options.actor;
  // One verify per item round-trip (BOUNCE2): the transient AWAY/BACK legs skip
  // their own state verify; the orchestrator's placed-position check after each
  // item is the single per-round-trip assertion. Transport fail-loud is retained.
  legs.skipVerify = true;
  return legs;
}

function resolveContainerUuid(deps: WriteDeps, params: ReorderParams): string | null {
  if (params.scope === "project") {
    return resolveProject(deps.db, params.container ?? {}).resolved?.uuid ?? null;
  }
  if (params.scope === "area") {
    return resolveArea(deps.db, params.container ?? {}).resolved?.uuid ?? null;
  }
  // heading / area-someday / container-day / heading-someday / heading-day: the
  // planner passes a resolved uuid container directly (a heading uuid, an area
  // uuid, or a project/area uuid).
  if (
    params.scope === "heading" ||
    params.scope === "area-someday" ||
    params.scope === "container-day" ||
    params.scope === "heading-someday" ||
    params.scope === "heading-day"
  ) {
    return params.container?.uuid ?? null;
  }
  return null;
}

/** null = still eligible; otherwise a human-readable problem. */
function checkStillMember(
  deps: WriteDeps,
  uuid: string,
  bounceKind: BounceKind,
  containerUuid: string | null,
  now: Date,
): string | null {
  const packedToday = encodePackedDate(localToday(now));
  const row = deps.db
    .prepare(
      "SELECT status, trashed, startBucket, startDate, start, type, area, project, heading " +
        "FROM TMTask WHERE uuid = ?",
    )
    .get(uuid) as
    | {
        status: number;
        trashed: number;
        startBucket: number;
        startDate: number | null;
        start: number;
        type: number;
        area: string | null;
        project: string | null;
        heading: string | null;
      }
    | undefined;
  if (row === undefined) return "the item no longer exists";
  if (row.trashed !== 0) return "the item was trashed";
  if (row.status !== 0) return "the item is no longer open";
  switch (bounceKind) {
    case "projects":
      if (row.type !== 1) return "the item is not a project";
      if (row.area !== null) return "the project moved into an area";
      if (row.start !== 1 || row.startDate !== null) {
        return "the project is no longer a plain Anytime project";
      }
      return null;
    case "heading":
      if (row.type !== 0) return "the item is not a to-do";
      if (row.heading !== containerUuid) return "the to-do left the heading";
      if (row.start !== 1 || row.startDate !== null) {
        return "the to-do is no longer a plain Anytime child of the heading";
      }
      return null;
    case "area-someday":
      if (row.type !== 0) return "the item is not a to-do";
      if (row.area !== containerUuid || row.heading !== null) return "the to-do left the area";
      if (row.start !== 2 || row.startDate !== null) return "the to-do is no longer a Someday item";
      return null;
    case "project-someday":
      if (row.type !== 0) return "the item is not a to-do";
      if (row.project !== containerUuid || row.heading !== null) {
        return "the to-do left the project";
      }
      if (row.start !== 2 || row.startDate !== null) return "the to-do is no longer a Someday item";
      return null;
    case "anytime":
      if (row.type !== 0) return "the item is not a to-do";
      if (row.project !== null || row.area !== null || row.heading !== null) {
        return "the to-do is no longer loose (it gained a container)";
      }
      if (row.start !== 1 || row.startDate !== null) {
        return "the to-do is no longer a plain Anytime item";
      }
      return null;
    case "today":
    case "evening": {
      const inToday =
        row.startDate !== null &&
        row.startDate <= packedToday &&
        (row.start === 1 || row.start === 2);
      if (!inToday) return "the item left the Today list";
      if (bounceKind === "today" && row.startBucket !== 0) return "the item moved to This Evening";
      if (bounceKind === "evening" && (row.startBucket !== 1 || row.startDate !== packedToday)) {
        return "the item left This Evening";
      }
      return null;
    }
  }
}

function auditSummary(
  deps: WriteDeps,
  params: ReorderParams,
  startedAt: Date,
  result: AuditRecord["result"],
  observed: Record<string, unknown> | null,
  extras?: { pre?: Record<string, unknown>; txnId?: string; actor?: string },
): void {
  const fp = deps.fingerprint();
  const record: AuditRecord = {
    v: 1,
    ts: startedAt.toISOString(),
    actor: extras?.actor ?? deps.config.actor,
    host: deps.config.host,
    op: "reorder",
    uuid: null,
    vector: "url-scheme",
    disruption: 0,
    invocation: `reorder(${params.scope}) ×${params.uuids.length}`,
    requested: params as unknown as Record<string, unknown>,
    pre: extras?.pre ?? null,
    ...(extras?.txnId !== undefined && { txn: { id: extras.txnId, role: "summary" as const } }),
    observed,
    result,
    verify: null,
    durationMs: (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
    env: {
      pkg: deps.pkgVersion ?? "0.0.1",
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fingerprintLabel(fp, deps.config),
    },
  };
  deps.audit.append(record);
}
