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
import type { AuditRecord } from "../audit/schema.ts";
import { localToday, encodePackedDate } from "../model/dates.ts";
import type { ReorderParams, ReorderScope } from "./operations.ts";
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import { computeReorderPre, resolveArea, resolveProject } from "./pre-state.ts";
import { sdefDeclaresPrivateReorder } from "./experimental.ts";
import {
  fingerprintLabel,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
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
      // Native-only scopes: let the pipeline explain precisely why native is
      // unavailable (planner: experimental gate; canary: sdef change).
      return { kind: "ok", strategy: "native" };
    // bounce-only scopes handled by bounceEntry above; unreachable here.
    case "evening":
    case "projects":
    case "heading":
    case "area-someday":
    case "anytime":
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

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op: "reorder",
      plan: {
        op: "reorder",
        vector: "url-scheme",
        tier: 0,
        invocation:
          `bounce ×${coBounce.length} (${direction}-insert, ` +
          `${direction === "front" ? "reverse" : "forward"} order, ` +
          (touchedUnnamed.length > 0
            ? `touches ${touchedUnnamed.length} unnamed sibling(s), `
            : "") +
          `${coBounce.length * 2} legs): ` +
          `when=${away} → when=${back}; one verify per item round-trip`,
        expectedDelta: { mode: "ordering", key: rankKey, sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  // Front-insert contexts (loose/area-direct) place last-first (reverse iterate,
  // unshift); back-insert contexts (heading/project children) place first-first
  // (forward iterate, push). Either way `placed` holds the current top-to-bottom
  // order of the bounced block, verified after each leg-pair.
  const order =
    direction === "front"
      ? coBounce.map((_, i) => coBounce.length - 1 - i)
      : coBounce.map((_, i) => i);
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
  // heading / area-someday / container-day: the planner passes a resolved uuid
  // container directly (a heading uuid, an area uuid, or a project/area uuid).
  if (
    params.scope === "heading" ||
    params.scope === "area-someday" ||
    params.scope === "container-day"
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
    invocation: `bounce(${params.scope}) ×${params.uuids.length}`,
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
