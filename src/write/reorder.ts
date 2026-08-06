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
import { addDaysIso, decodePackedDate, localToday, encodePackedDate } from "../model/dates.ts";
import type { ReorderParams, ReorderScope, WhenValue } from "./operations.ts";
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import { computeReorderPre, resolveArea, resolveProject, todayEveningFlagOf } from "./pre-state.ts";
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
  | "day"
  | "projects"
  | "heading"
  | "area-someday"
  | "anytime"
  | "project-someday"
  // SIT7 SOMEBACK — the non-experimental `someday`-scope fallback (front-insert).
  // The URL `anytime↔someday` `when=` round-trip front-inserts BOTH loose someday
  // to-dos AND area-less someday projects at the loose someday `index` min, so a
  // reverse-target dispatch lands the exact order (per-type leg op: todo.update /
  // update-project). Someday rows carry no Today star (the de-Today hazard is moot)
  // and a deadline-someday round-trip is byte-safe, so the cheap bounce is the
  // complete safe backup. Wired ONLY when the native anchor-stack (ORD-3) is
  // unavailable (allow-experimental off OR the sdef canary fails).
  | "someday";

interface BounceSpec {
  /**
   * The two `when=` legs (away then back). For a fixed-bucket bounce these are
   * scheduling keywords; for the DATED `day` bounce ({@link dated}) they are
   * computed per invocation from the movees' shared day (away = D+1, back = D),
   * so the spec leaves them null.
   */
  away: "today" | "evening" | "someday" | "anytime" | null;
  back: "today" | "evening" | "someday" | "anytime" | null;
  /**
   * SIT4 DAYBNC: the `day` bounce's legs are a cross-DATE round-trip (away = the
   * neighbour day D+1, back = the day D itself), computed from the movees' shared
   * startDate at dispatch — not a fixed bucket. Sequential URL legs only (the
   * things:///json when= reindex is unproven for dated placement, §9i).
   */
  dated: boolean;
  /** front = reverse-iterate (front-insert); back = forward-iterate (back-insert). */
  direction: "front" | "back";
  rankKey: "index" | "todayIndex";
  /**
   * The mutation op for each leg. `per-type` chooses todo.update for a to-do
   * (type=0) and update-project for a project (type=1) row-by-row — the first
   * MIXED-kind bounce (SIT4 DAYBNC dated groups + EVEORD evening groups both
   * front-insert to-dos and projects on ONE shared todayIndex axis).
   */
  legOp: "todo.update" | "project.update" | "per-type";
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
        dated: false,
        direction: "front",
        rankKey: "todayIndex",
        legOp: "todo.update",
        // todayIndex leg, not an anytime placement — json reindex unproven here.
        jsonCollapsible: false,
      };
    case "evening":
      // EVEORD: to-dos AND projects share ONE evening todayIndex axis; a project's
      // when=evening re-entry front-inserts at the group min just like a to-do
      // (×3). So the evening bounce accepts MIXED movees via a per-type leg op.
      // Caveat: when=evening CLEARS reminderTime for BOTH kinds (§9n / R07).
      return {
        away: "today",
        back: "evening",
        dated: false,
        direction: "front",
        rankKey: "todayIndex",
        legOp: "per-type",
        jsonCollapsible: false,
      };
    // SIT4 DAYBNC: the DATED BOUNCE for an arbitrary future day-group across all
    // containers — loose/project-child/headed/area-direct to-dos AND area-less
    // project rows front-insert at the day-D GLOBAL todayIndex min on the back
    // leg. away/back are the cross-date round-trip (D+1 → D), per-type legs,
    // reminder/deadline/heading-FK preserving (§2e/R21). Sequential URL only —
    // the json when= reindex is unproven for dated placement (§9i tested anytime).
    case "day":
      return {
        away: null,
        back: null,
        dated: true,
        direction: "front",
        rankKey: "todayIndex",
        legOp: "per-type",
        jsonCollapsible: false,
      };
    case "projects":
      return {
        away: "someday",
        back: "anytime",
        dated: false,
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
        dated: false,
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
        dated: false,
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
        dated: false,
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
        dated: false,
        direction: "back",
        rankKey: "index",
        legOp: "todo.update",
        jsonCollapsible: false,
      };
    // SIT7 SOMEBACK: loose someday to-dos AND area-less someday projects FRONT-insert
    // at the loose someday index min via the anytime↔someday round-trip (reverse-order
    // dispatch). Per-type leg op (todo.update / update-project) — the first MIXED-kind
    // fixed-bucket bounce, mirroring the day/evening per-type legs. Someday placement
    // leg -> json index-INERT (§9i b): URL loop only (never collapsible).
    case "someday":
      return {
        away: "anytime",
        back: "someday",
        dated: false,
        direction: "front",
        rankKey: "index",
        legOp: "per-type",
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

  // HEADSUB1 within-heading sub-bucket compound (headsub1-heading-subbuckets.md):
  // heading-someday re-heads the block in forward order (move-to-heading back-
  // insert). (The former heading-day unhead→container-day→re-head round-trip is
  // SUPERSEDED by the `day` dated bounce — SIT4 DAYBNC preserves the heading FK,
  // so a headed same-day child just bounces.)
  if (params.scope === "heading-someday") return runHeadingSomeday(deps, params, options);

  const strategy = resolveStrategy(deps, params);
  if (strategy.kind === "blocked") return strategy.result;

  if (strategy.strategy === "native") {
    return runMutation(deps, "reorder", params, { ...options, vector: "applescript" });
  }
  const result =
    strategy.strategy === "bounce"
      ? await runBounce(deps, params, strategy.bounceKind, options)
      : await runMoveFallback(deps, params, strategy.fallback, options);
  // SIT7 disclosure: when the private reorder surface is unavailable the scope
  // ran a degraded-but-guaranteed non-experimental fallback — say so, so the
  // caller never silently mistakes a fallback for the native placement.
  if (strategy.fallbackNote !== undefined && result.kind === "ok") {
    return { ...result, warnings: [...(result.warnings ?? []), strategy.fallbackNote] };
  }
  return result;
}

/** The three move-based SIT7 fallbacks (park + re-enter). See {@link runMoveFallback}. */
type FallbackKind = "inbox-park" | "proj-root" | "area-back";

type StrategyDecision =
  | { kind: "ok"; strategy: "native" }
  | { kind: "ok"; strategy: "bounce"; bounceKind: BounceKind; fallbackNote?: string }
  | { kind: "ok"; strategy: "fallback"; fallback: FallbackKind; fallbackNote: string }
  | { kind: "blocked"; result: MutationResult };

/**
 * Why the native `_private_experimental_ reorder` command is unavailable, for the
 * fallback disclosure note. Either the config gate is off or the sdef canary
 * failed — the two triggers {@link resolveStrategy} routes a fallback for.
 */
function nativeUnavailableReason(deps: WriteDeps): string {
  return deps.config.allowExperimental
    ? "the app no longer declares the private reorder command (sdef canary failed)"
    : "allow-experimental is off";
}

/** The fallback disclosure warning — which protocol ran, and why native could not. */
function fallbackNoteFor(deps: WriteDeps, protocol: string): string {
  return (
    `reordered via the non-experimental ${protocol} fallback because the native reorder ` +
    `is unavailable (${nativeUnavailableReason(deps)})`
  );
}

/** A blocked result for a move-based SIT7 fallback while the shared move gate is off. */
function moveFallbackDisabled(what: string): { kind: "blocked"; result: MutationResult } {
  return {
    kind: "blocked",
    result: {
      kind: "blocked",
      op: "reorder",
      reason: "environment",
      detail:
        `${what} falls back to a park + re-enter MOVE protocol (the native reorder is ` +
        "unavailable), which shares the bounce gate and is disabled (bounce-enabled=false) — " +
        "it was NOT attempted (no destructive or unverified fallback exists)",
      remediation:
        "re-enable it with `things config set bounce-enabled true`" +
        " (each moved item costs a park + re-enter leg), or turn allow-experimental back on",
    },
  };
}

/** Gate a move-based SIT7 fallback on bounce-enabled (the shared multi-leg move gate). */
function fallbackOk(
  deps: WriteDeps,
  what: string,
  kind: FallbackKind,
  protocol: string,
): StrategyDecision {
  if (!deps.config.bounceEnabled) return moveFallbackDisabled(what);
  return {
    kind: "ok",
    strategy: "fallback",
    fallback: kind,
    fallbackNote: fallbackNoteFor(deps, protocol),
  };
}

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

/**
 * A when=-bounce SIT7 fallback (SOMEBACK someday, or a dated `day` bounce standing
 * in for container-day/tomorrow): a bounce that ALSO carries the fallback disclosure
 * note, because it ran only because the native surface was unavailable.
 */
function bounceFallbackOk(
  deps: WriteDeps,
  what: string,
  kind: BounceKind,
  protocol: string,
): StrategyDecision {
  const d = bounceOk(deps, what, kind);
  if (d.kind !== "ok" || d.strategy !== "bounce") return d;
  return { ...d, fallbackNote: fallbackNoteFor(deps, protocol) };
}

/**
 * Whether the native `_private_experimental_ reorder` command is available — the
 * config gate is on AND the app still declares it in its sdef (the canary). The
 * `day`-scope template leg family gates on this too: a repeating TO-DO template's
 * only safe day-block placement is the native single-id `list "Upcoming"` front-
 * insert (a dated when= leg CRASHES a template, §1), so a day-group carrying any
 * template requires the native surface (else it refuses honestly, naming them).
 */
function nativeReorderAvailable(deps: WriteDeps): boolean {
  return deps.config.allowExperimental && (deps.sdefProbe ?? sdefDeclaresPrivateReorder)();
}

function resolveStrategy(deps: WriteDeps, params: ReorderParams): StrategyDecision {
  const nativeAvailable = nativeReorderAvailable(deps);

  // Scopes whose ONLY surface is the bounce (no native command reaches them).
  const bounceOnly: Partial<Record<ReorderScope, { kind: BounceKind; what: string }>> = {
    evening: { kind: "evening", what: "evening-section order" },
    day: { kind: "day", what: "an arbitrary future-day order" },
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
    // `someday` DOES have a when= bounce twin (SIT7 SOMEBACK) — route explicit
    // --strategy bounce to it. project/area/inbox have no when= surface (their
    // SIT7 fallbacks are MOVE protocols, planner-selected only).
    if (params.scope === "someday") {
      return bounceOk(deps, "loose someday order", "someday");
    }
    if (params.scope === "project" || params.scope === "area" || params.scope === "inbox") {
      return blocked(
        "bounce can only reorder the Today/Evening sections, top-level projects, within-heading, " +
          "area-someday, area-less anytime, and loose someday — its primitive is a when= round-trip, " +
          "which does not move this scope's order (use the native strategy, or omit --strategy to let " +
          "the non-experimental MOVE fallback run when native is unavailable)",
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
    // SIT7 AUTOMATIC FALLBACKS — every native-only reorder scope degrades to a
    // proven non-experimental protocol when the private surface is unavailable
    // (allow-experimental off OR the sdef canary fails), rather than fail-explain.
    case "project":
      // PROJROOT (fallback 3): park the unheaded children to a scratch project, then
      // re-home `list-id=<P>` in FORWARD target order (back-insert). One protocol for
      // ALL rows (flagged or not) — the move round-trip is proven flag-safe (SIT7).
      return nativeAvailable
        ? { kind: "ok", strategy: "native" }
        : fallbackOk(deps, "within-project child order", "proj-root", "PROJROOT");
    case "area":
      // AREABACK (fallback 4): park members out, re-home `list-id=`/`area-id=<area>`
      // in REVERSE target order (front-insert), area FK preserved. Flag-safe move.
      return nativeAvailable
        ? { kind: "ok", strategy: "native" }
        : fallbackOk(deps, "an area's member order", "area-back", "AREABACK");
    case "inbox":
      // INBOXBACK (fallback 1): park each row into a scratch project, then re-enter
      // via `move … to list "Inbox"` in REVERSE target order (front-insert, restores
      // start=0). A same-list `move … to "Inbox"` is a no-op, so park-first is required.
      return nativeAvailable
        ? { kind: "ok", strategy: "native" }
        : fallbackOk(deps, "Inbox order", "inbox-park", "INBOXBACK");
    case "someday":
      // SOMEBACK (fallback 2): the anytime↔someday when= bounce front-inserts loose
      // someday to-dos AND area-less someday projects (reverse-target, per-type leg).
      return nativeAvailable
        ? { kind: "ok", strategy: "native" }
        : bounceFallbackOk(deps, "loose someday order", "someday", "SOMEBACK");
    case "container-day":
    case "tomorrow":
      // Fallback 5: the dated `day` bounce (ORD-6 DAYBNC) reaches every same-day child
      // via a pure-URL cross-date round-trip — a non-experimental stand-in for both
      // the container-day native re-rank and the one-call `list "Tomorrow"` sort.
      return nativeAvailable
        ? { kind: "ok", strategy: "native" }
        : bounceFallbackOk(
            deps,
            params.scope === "tomorrow" ? "Tomorrow order" : "a container's scheduled-day order",
            "day",
            "dated-day-bounce",
          );
    // bounce-only scopes handled by bounceEntry above; unreachable here.
    case "evening":
    case "day":
    case "projects":
    case "heading":
    case "area-someday":
    case "anytime":
      return { kind: "ok", strategy: "native" };
    // heading-someday is intercepted in runReorder before resolveStrategy runs;
    // this case exists only for switch exhaustiveness.
    case "heading-someday":
      return { kind: "ok", strategy: "native" };
    // `upcoming` is an INTERNAL per-template front-insert leg (the `day` bounce
    // dispatches it via runMutation directly — TMPLSORT-1); it never reaches the
    // strategy resolver. Blocked here for exhaustiveness / defence in depth.
    case "upcoming":
      return blocked(
        "the `upcoming` scope is an internal per-template front-insert leg, not a user reorder scope",
        "reorder a template's day-block via `things todo reorder` on its day (the planner routes it)",
      );
  }
}

// (The SOMEBNC-project someday-only bounce fallback for the `project` scope is
// SUPERSEDED by PROJROOT — the SIT7 park + re-home MOVE round-trip that reorders
// ALL of a project's unheaded children flag-safely, one protocol for every row.
// The `project-someday` BounceKind survives as the §9i json-collapse classification
// pin, but it is no longer selected by resolveStrategy.)

// ----------------------------------------------------- compound leg options
//
// (The former park-sort-restore day compounds — loose-day / area-day / upcoming-
// day — and the heading-day unhead→re-head round-trip are DELETED: SIT4 DAYBNC
// proved the dated `day` bounce serves their whole population plus area-less
// project rows, reminder/deadline/heading-FK preserving, with NO scratch project
// and NO experimental gate. compoundLegOptions survives — heading-someday still
// uses it for its per-leg move sub-mutations.)

/** Leg options for a compound sub-mutation — each leg fully verified. */
function compoundLegOptions(options: WriteOptions, txnId: string): WriteOptions {
  const legs: WriteOptions = { txn: { id: txnId, role: "leg" } };
  if (options.maxDisruption !== undefined) legs.maxDisruption = options.maxDisruption;
  if (options.verifyTimeoutMs !== undefined) legs.verifyTimeoutMs = options.verifyTimeoutMs;
  if (options.actor !== undefined) legs.actor = options.actor;
  return legs;
}

// ----------------------------------------------------- heading sub-buckets
//
// HEADSUB1 (docs/lab/headsub1-heading-subbuckets.md) settled the per-class order
// of a heading's sub-buckets. heading-someday is wired here; the anytime sub-
// bucket rides the `heading` bounce, the EVENING sub-bucket rides the shipped
// `evening` bounce (Arm 2b — the heading FK survives the today↔evening round-
// trip), and a heading's same-day SCHEDULED children ride the `day` dated bounce
// (SIT4 DAYBNC — the cross-date round-trip preserves the heading FK, so the former
// unhead→container-day→re-head heading-day round-trip is no longer needed).
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

  const pre = computeReorderPre(deps.db, params, headingUuid, now(), { zone: deps.zone });
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
  const { direction, rankKey, legOp } = spec;
  const cap = deps.config.bounceMaxItems ?? BOUNCE_MAX_ITEMS;
  const containerUuid = resolveContainerUuid(deps, params);
  const wantsContainer =
    bounceKind === "heading" ||
    bounceKind === "area-someday" ||
    bounceKind === "project-someday" ||
    // SIT7 fallback routing: `container-day` degrades to the dated `day` bounce
    // (fallback 5) and legitimately carries its project/area container.
    params.scope === "container-day";

  // The two `when=` leg values. A fixed-bucket bounce uses the spec's keywords; the
  // DATED `day` bounce (SIT4 DAYBNC) derives them from the movees' shared day —
  // back = the day D, away = the neighbour day D+1 (a strictly-future staging day
  // ≠ D that keeps the transient visit out of Today). The day D is read off the
  // first requested uuid — its `startDate` when scheduled, else its `deadline` when
  // it is a deadline-forecast row (startDate NULL, start IN (1,2) — DLBNC/§9o). The
  // planner guarantees every movee shares D; an absent/malformed day yields an empty
  // member set and is rejected below before any dispatch, so the today fallback here
  // only keeps the WhenValue well-typed. (The `when=` values drive the SCHEDULED
  // rows' bounce legs; a forecast row ignores them — it rides the deadline-cycle.)
  let dayPacked: number | null = null;
  let awayValue: WhenValue;
  let backValue: WhenValue;
  if (spec.dated) {
    const firstUuid = params.uuids[0];
    const firstRow =
      firstUuid !== undefined
        ? (deps.db
            .prepare(
              "SELECT startDate, startBucket, deadline, start, rt1_nextInstanceStartDate AS proj, " +
                "(rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL) AS isTemplate " +
                "FROM TMTask WHERE uuid = ?",
            )
            .get(firstUuid) as
            | {
                startDate: number | null;
                startBucket: number;
                deadline: number | null;
                start: number;
                proj: number | null;
                isTemplate: number;
              }
            | undefined)
        : undefined;
    // The day D: a template's PROJECTION day (rt1_nextInstanceStartDate), else a
    // scheduled row's startDate, else a forecast row's deadline (mirrors
    // computeReorderPre so the when= legs and the member set agree on D).
    dayPacked =
      firstRow === undefined
        ? null
        : firstRow.isTemplate === 1
          ? firstRow.proj
          : firstRow.startDate !== null && firstRow.startBucket === 0
            ? firstRow.startDate
            : firstRow.startDate === null && (firstRow.start === 1 || firstRow.start === 2)
              ? firstRow.deadline
              : null;
    const iso = decodePackedDate(dayPacked);
    backValue = iso ?? localToday(now());
    awayValue = iso !== null ? addDaysIso(iso, 1) : localToday(now());
  } else {
    awayValue = spec.away as WhenValue;
    backValue = spec.back as WhenValue;
  }
  // A day-scope DEADLINE-FORECAST row (startDate NULL, deadline set) reorders by the
  // DLBNC deadline-cycle (URL `deadline=` clear + re-set of the SAME deadline —
  // byte-identical, front-inserts on the block's todayIndex axis) instead of the
  // scheduled `when=` bounce. Returns the decoded ISO to re-set, or null for a
  // scheduled row (which takes the `when=` legs). AppleScript `due date` is
  // certified-wrong here (lazy todayIndex, cannot clear) — URL only (DLBNC §9q).
  const forecastLegOf = (uuid: string): { iso: string } | null => {
    if (bounceKind !== "day") return null;
    const r = deps.db.prepare("SELECT startDate, deadline FROM TMTask WHERE uuid = ?").get(uuid) as
      | { startDate: number | null; deadline: number | null }
      | undefined;
    if (r === undefined || r.startDate !== null || r.deadline === null) return null;
    const iso = decodePackedDate(r.deadline);
    return iso === null ? null : { iso };
  };
  // Per-item leg op: the mixed-kind `day`/`evening` bounces pick update-project for
  // a project row (type=1) and todo.update for a to-do (type=0); every other bounce
  // uses one fixed op. (NEVER send a dated when= leg to a template — §1 crash — but
  // templates are already excluded from the member set, and a requested template
  // ref is refused by computeReorderPre, so no leg ever targets one.)
  const opForRow = (uuid: string): "todo.update" | "project.update" => {
    if (legOp !== "per-type") return legOp;
    const t = (
      deps.db.prepare("SELECT type FROM TMTask WHERE uuid = ?").get(uuid) as
        | { type: number }
        | undefined
    )?.type;
    return t === 1 ? "project.update" : "todo.update";
  };

  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;
  // Scope/membership guard — same data the native path's guard uses.
  const pre = computeReorderPre(deps.db, params, containerUuid, now(), { zone: deps.zone });
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

  // FLAG-AWARE protocol routing (SIT6). The three json-collapsible index bounces
  // (`heading` BOUNCE2-h, `anytime` ANYBNC, `projects` P8e) are when=someday →
  // when=anytime round-trips whose `when=` legs OVERWRITE the Today/Evening flag:
  // the someday leg nulls startDate (start 1→2), the anytime leg only flips start
  // back to 1, so a flagged movee is silently DE-Todayed (PROJSTAR de-star). Each
  // has a lab-proven flag-safe MOVE twin on the same `index` axis (SIT6): route
  // the WHOLE touched set through it whenever ANY touched row carries the flag —
  //   heading  → HEADMOVE  (unhead → re-head in forward target order; back-insert),
  //   anytime  → LOOSEPARK (park into a scratch PROJECT → unpark in reverse target;
  //                         front-insert),
  //   projects → PROJPARK  (park into a scratch AREA → detach in reverse target;
  //                         front-insert).
  // Every leg is a URL move (`list-id=`/`area-id=`), NO when= leg and NO private
  // reorder surface, so the flag / reminder / deadline / FKs all survive. An
  // all-UNFLAGGED touched set keeps the cheaper bounce below. Detection is
  // `todayEveningFlagOf` over the full touched set (the coBounce run), the same
  // single-source marker #351 used. This SUPERSEDES #351's `projects` de-Today
  // refusal for flagged movees; a refusal remains only when the protocol itself is
  // unavailable (cap exceeded), raised inside the protocol.
  if (bounceKind === "heading" || bounceKind === "anytime" || bounceKind === "projects") {
    const flagged = coBounce.some((uuid) => todayEveningFlagOf(deps.db, uuid, now()) !== null);
    if (flagged) {
      const ctx: SwapCtx = {
        coBounce,
        containerUuid,
        txnId,
        actor,
        touchedUnnamed,
        startedAt,
        options,
        cap,
      };
      if (bounceKind === "heading") return runHeadMove(deps, params, ctx);
      if (bounceKind === "anytime") return runLoosePark(deps, params, ctx);
      return runProjPark(deps, params, ctx);
    }
  }

  const problems: string[] = [];
  if (params.container !== undefined && !wantsContainer)
    problems.push("container is only valid for the heading / area-someday / project scopes");
  if (params.uuids.length === 0) problems.push("no uuids given");
  if (pre.duplicates.length > 0) problems.push(`duplicated uuid(s): ${pre.duplicates.join(", ")}`);
  // SIT7 SOMEBACK: the someday bounce is same-type only (loose to-dos front-insert on a
  // different axis than area-less projects — a mixed wire list is unprobed), mirroring
  // the native someday anchor-stack's same-type rule.
  if (pre.mixedTypes) {
    problems.push(
      "a someday reorder must be all to-dos OR all projects (same-type only) — a mixed member set " +
        "is unprobed",
    );
  }
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

  // TMPLSORT/PTMPL template leg families (the `day` scope only — the native
  // `tomorrow` one-call wire carries templates as ordinary members). A repeating
  // template's projection is a first-class day-block member, but a dated when=/
  // deadline leg CRASHES it (§1), so it NEVER receives one. Split per class:
  //   - TO-DO template: a single-id `list "Upcoming"` NATIVE front-insert leg
  //     (TMPLSORT-1), interleaved into the reverse-target dispatch on the shared
  //     block min-space (TMPLSORT-2). Needs the native surface.
  //   - PROJECT template: byte-UNTOUCHED under the SUFFIX RULE — it has no headless
  //     reach on an arbitrary future day (PTMPL-B: only `list "Tomorrow"` / a GUI
  //     drag place it), so every movable front-inserts ABOVE it. Accept only a wire
  //     where the project templates form a suffix in their CURRENT relative order;
  //     refuse otherwise, naming the one achievable arrangement.
  // The whole day dispatch is experimental-gated when ANY template is present.
  const memberInfo = new Map(pre.members.map((m) => [m.uuid, m] as const));
  const isTmpl = (u: string): boolean => memberInfo.get(u)?.isTemplate === true;
  const isProjectTemplate = (u: string): boolean => isTmpl(u) && memberInfo.get(u)?.type === 1;
  const templatesPresent = bounceKind === "day" && coBounce.some(isTmpl);
  let dispatchRun = coBounce;
  if (templatesPresent) {
    const dayIso = decodePackedDate(dayPacked) ?? "the target day";
    const templateRefusal = (detail: string, remediation: string): MutationResult => {
      const result: MutationResult = {
        kind: "blocked",
        op: "reorder",
        reason: "hazard",
        hazard: "H-REORDER-SCOPE",
        detail,
        remediation,
      };
      auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, {
        pre: preRanks,
        txnId,
        actor,
      });
      return result;
    };
    if (!nativeReorderAvailable(deps)) {
      // C(iii): refuse honestly, NAMING the templates — never a dated leg (crash),
      // never a silent skip, never a partial sort.
      const tmpls = coBounce.filter(isTmpl);
      return templateRefusal(
        `the ${dayIso} day-group contains repeating template(s) [${tmpls.join(", ")}] whose ` +
          "day-block placement needs the native private reorder surface (a dated when= leg CRASHES " +
          `a template — §1/§9e), but it is unavailable (${nativeUnavailableReason(deps)})`,
        "enable it with `things config set allow-experimental true` (and keep Things updated so the " +
          "sdef canary passes), or reorder the day-group without the template(s)",
      );
    }
    // PROJECT-template SUFFIX RULE.
    const projectTemplates = coBounce.filter(isProjectTemplate);
    if (projectTemplates.length > 0) {
      const suffix = coBounce.slice(coBounce.length - projectTemplates.length);
      const suffixContiguous = suffix.every(isProjectTemplate);
      // Their achievable order is their CURRENT todayIndex (render) order — untouched.
      const currentOrder = projectTemplates.toSorted(
        (a, b) => (memberInfo.get(a)?.rank ?? 0) - (memberInfo.get(b)?.rank ?? 0),
      );
      const orderPreserved = suffixContiguous && suffix.every((u, i) => u === currentOrder[i]);
      if (!orderPreserved) {
        const movables = coBounce.filter((u) => !isProjectTemplate(u));
        const achievable = [...movables, ...currentOrder];
        return templateRefusal(
          `a repeating PROJECT template cannot be placed above a movable item on the ${dayIso} ` +
            "day-block, and project templates cannot change their relative order there — an arbitrary " +
            "future day gives a project template no headless reach (PTMPL-B: only the Tomorrow one-call " +
            "sort, when the day is tomorrow, or a GUI drag place it). The only arrangement this " +
            `day-group can reach headlessly is: ${achievable.join(", ")} (every movable above the ` +
            "project template(s), which keep their current relative order)",
          "request that arrangement (place the project template(s) last, in their current order), or " +
            "drag the project template in the app; if the day is tomorrow, reorder on Tomorrow instead",
        );
      }
    }
    // Movables + to-do templates dispatch; project templates are the untouched suffix.
    dispatchRun = coBounce.filter((u) => !isProjectTemplate(u));
  }

  // Front-insert contexts (loose/area-direct) place last-first (reverse iterate,
  // unshift); back-insert contexts (heading/project children) place first-first
  // (forward iterate, push). Either way `placed` holds the current top-to-bottom
  // order of the bounced block. The SAME per-item order drives the json-array
  // collapse (array order == result index order for both directions).
  const order =
    direction === "front"
      ? dispatchRun.map((_, i) => dispatchRun.length - 1 - i)
      : dispatchRun.map((_, i) => i);

  // BOUNCEJSON collapse (§9i): when the placement (`back`) leg is when=anytime
  // into a loose/heading-container bucket, the whole N-item round-trip collapses
  // to ONE pre-validated `things:///json` array (2N ops, 1 dispatch, ~7×,
  // validate-first FULL-ABORT). Only against a REAL dispatch surface — under the
  // simulator (simulates=true, per-op appliers, no json-array applier) we keep
  // the proven sequential legs.
  // The json collapse is only ever eligible for a fixed-op, jsonCollapsible spec;
  // per-type (day/evening) and every dated bounce stay on the sequential URL loop.
  const dispatchVector =
    spec.jsonCollapsible && legOp !== "per-type" ? pickDispatchVector(deps, legOp) : undefined;
  const useJson =
    spec.jsonCollapsible && dispatchVector !== undefined && dispatchVector.simulates !== true;

  if (options.dryRun === true) {
    // Name the per-row-class legs. A `day` set may mix SCHEDULED rows (when= bounce)
    // and DEADLINE-FORECAST rows (the DLBNC deadline-cycle: deadline= clear + re-set),
    // so the plan discloses the leg family per class + count; every other bounce is a
    // single when= round-trip.
    let legNaming = `when=${awayValue} → when=${backValue}`;
    if (bounceKind === "day") {
      const ttN = coBounce.filter((u) => isTmpl(u) && !isProjectTemplate(u)).length;
      const ptN = coBounce.filter(isProjectTemplate).length;
      const fN = coBounce.filter((u) => !isTmpl(u) && forecastLegOf(u) !== null).length;
      const sN = coBounce.length - fN - ttN - ptN;
      const bits: string[] = [];
      if (sN > 0) bits.push(`${sN} scheduled via when=${awayValue} → when=${backValue}`);
      if (fN > 0)
        bits.push(`${fN} deadline-forecast via deadline-cycle (deadline= clear + re-set)`);
      if (ttN > 0)
        bits.push(
          `${ttN} to-do template(s) via single-id \`list "Upcoming"\` front-insert (umd-silent)`,
        );
      if (ptN > 0)
        bits.push(
          `${ptN} project template(s) left byte-untouched (suffix rule — no headless reach)`,
        );
      legNaming = bits.join("; ");
    }
    const invocation = useJson
      ? `json-collapse ×${coBounce.length} (${direction}-insert, ` +
        `${direction === "front" ? "reverse" : "forward"} array order, ` +
        (touchedUnnamed.length > 0 ? `touches ${touchedUnnamed.length} unnamed sibling(s), ` : "") +
        `1 dispatch / ${coBounce.length * 2} ops): ` +
        `${legNaming} interleaved per item; validate-first full-abort, ` +
        `one terminal order verify`
      : `bounce ×${coBounce.length} (${direction}-insert, ` +
        `${direction === "front" ? "reverse" : "forward"} order, ` +
        (touchedUnnamed.length > 0 ? `touches ${touchedUnnamed.length} unnamed sibling(s), ` : "") +
        `${coBounce.length * 2} legs): ` +
        `${legNaming}; one verify per item round-trip`;
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
    const uuid = dispatchRun[i] as string;
    const remainingBefore = () =>
      direction === "front" ? dispatchRun.slice(0, i + 1) : dispatchRun.slice(i);

    // Concurrent-edit re-check: the item must still be an eligible member.
    const memberProblem = checkStillMember(deps, uuid, bounceKind, containerUuid, now(), dayPacked);
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

    // A repeating TO-DO template rides ONE native single-id `list "Upcoming"` front-
    // insert leg (TMPLSORT-1) — NEVER a dated when=/deadline leg (§1 crash). It front-
    // inserts on the SAME shared block min-space as the when=/deadline families, so the
    // reverse-target dispatch interleaves it exactly (TMPLSORT-2). Project templates are
    // excluded from `dispatchRun` (the untouched suffix), so only to-do templates reach
    // this branch; the leg is umd-silent (§9r — disclosed in the result note).
    if (isTmpl(uuid)) {
      const tmplLeg = await runMutation(
        deps,
        "reorder",
        { scope: "upcoming", uuids: [uuid], named: [uuid] },
        legOptions(options, txnId),
      );
      if (tmplLeg.kind !== "ok") {
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
            `the native \`list "Upcoming"\` front-insert leg failed for repeating template ${uuid} ` +
            "— it was NOT moved (its position is unchanged)",
          placed: [...placed],
          remaining: remainingBefore(),
          cause: tmplLeg,
        };
      }
      if (direction === "front") placed.unshift(uuid);
      else placed.push(uuid);
      const tmplPrefix = await pollUntilVerified(
        () =>
          evaluateDelta(
            { mode: "ordering", key: rankKey, sequence: [...placed] },
            createDbReader(deps.db),
            { modDates: {}, fields: {} },
          ),
        options.verifyTimeoutMs ?? 4000,
        deps.poller ?? {},
      );
      if (tmplPrefix.kind !== "ok") {
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
            `placed items fell out of order after front-inserting template ${uuid} (concurrent ` +
            "edit?); re-run the reorder once Things is idle",
          placed: [...placed],
          remaining: direction === "front" ? dispatchRun.slice(0, i) : dispatchRun.slice(i + 1),
          cause: null,
        };
      }
      continue;
    }

    // leg 1 sends the item AWAY from its resting bucket; leg 2 returns it — the
    // return leg is what front-inserts (BOUNCE2 re-entry law). SCHEDULED rows use
    // the `when=` round-trip; a day-scope DEADLINE-FORECAST row (startDate NULL,
    // deadline set) uses the DLBNC deadline-cycle instead: leg 1 CLEARS the deadline
    // (transiently off the block), leg 2 RE-SETS the same deadline byte-identical
    // (front-inserts on the block todayIndex axis). BOTH classes pick the leg op PER
    // ROW TYPE — `todo.update` (→ `update?…`) for a to-do, `project.update` (→
    // `update-project?…`) for a project — so a forecast PROJECT rides the #385-
    // certified `update-project?deadline=` cycle (PROJDL-2b, PROJSTAR-safe). Both
    // classes front-insert at the day's global min, so one reverse-target pass
    // interleaves them exactly (o-suite forecast-cycle + mixed-interleave locks).
    const forecast = forecastLegOf(uuid);
    const rowLegOp = opForRow(uuid);
    const awayLabel = forecast !== null ? "deadline= clear" : `when=${awayValue}`;
    const backLabel = forecast !== null ? "deadline= re-set" : `when=${backValue}`;
    const leg1 =
      forecast !== null
        ? await runMutation(deps, rowLegOp, { uuid, deadline: null }, legOptions(options, txnId))
        : await runMutation(deps, rowLegOp, { uuid, when: awayValue }, legOptions(options, txnId));
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
        detail: `bounce leg 1 (${awayLabel}) failed for ${uuid} — the item was NOT moved`,
        placed: [...placed],
        remaining: remainingBefore(),
        cause: leg1,
      };
    }
    // leg 2 must follow leg 1's committed state for the same item before the next item's bounce begins
    const leg2 =
      forecast !== null
        ? await runMutation(
            deps,
            rowLegOp,
            { uuid, deadline: forecast.iso },
            legOptions(options, txnId),
          )
        : await runMutation(deps, rowLegOp, { uuid, when: backValue }, legOptions(options, txnId));
    if (leg2.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId, actor },
      );
      const strandedState =
        forecast !== null
          ? "left DEADLINE-LESS (transiently off the day-block)"
          : `STRANDED IN ${String(awayValue).toUpperCase()}`;
      const recover =
        forecast !== null
          ? `re-set its deadline (${forecast.iso})`
          : `re-schedule it (when=${backValue})`;
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail:
          `bounce leg 2 (${backLabel}) failed for ${uuid} — THE ITEM IS ${strandedState}; ` +
          `${recover} or fix in the app`,
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
        remaining: direction === "front" ? dispatchRun.slice(0, i) : dispatchRun.slice(i + 1),
        cause: null,
      };
    }
  }

  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of coBounce) observed[uuid] = reader.rankOf(uuid, rankKey);
  auditSummary(deps, params, startedAt, "ok", observed, { pre: preRanks, txnId, actor });
  // §9r disclosure: a template's `list "Upcoming"` front-insert leg is
  // userModificationDate-SILENT (a umd-diffing sync/watcher misses it), and a project
  // template left as the untouched suffix moved not at all — surface both so the caller
  // never mistakes a umd-silent placement for a no-op.
  const warnings: string[] = [];
  if (templatesPresent) {
    const tt = coBounce.filter((u) => isTmpl(u) && !isProjectTemplate(u));
    const pt = coBounce.filter(isProjectTemplate);
    if (tt.length > 0) {
      warnings.push(
        `${tt.length} repeating to-do template(s) were front-inserted via \`list "Upcoming"\` and ` +
          "are userModificationDate-SILENT (a umd-diffing sync/watcher will not see the move): " +
          tt.join(", "),
      );
    }
    if (pt.length > 0) {
      warnings.push(
        `${pt.length} repeating project template(s) were left byte-untouched as the day-block suffix ` +
          "(no headless reach on this day — every movable was placed above them): " +
          pt.join(", "),
      );
    }
  }
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
    ...(warnings.length > 0 && { warnings }),
    // Co-bounced siblings the anchor placement re-inserted (honest disclosure).
    ...(touchedUnnamed.length > 0 && { touched: touchedUnnamed }),
  };
}

// ------------------------------------------------ flag-safe MOVE protocols
//
// The de-Today-free twins of the three json-collapsible index bounces (SIT6,
// docs/lab/sit6-flagsafe-index-protocols.md). Each rides ONLY URL move legs
// (`list-id=`/`area-id=`) — no when= leg, no private reorder surface — so the
// Today/Evening flag + reminder + deadline + FKs survive the sort. The bounce
// orchestrator routes the WHOLE touched set (`coBounce`) through the matching
// protocol whenever ANY touched row carries the flag; otherwise the cheaper
// bounce runs. They share the bounce's gate (bounce-enabled) and cap
// (bounce-max-items) — the closest existing multi-leg-quiet-compound gate, since
// they are neither the native private surface nor a when= round-trip. Non-atomic
// like the heading-someday / former day compounds: a mid-protocol failure leaves
// rows in a disclosed transient state (unheaded in the project root, or parked in
// the NAMED scratch container) and fails loudly with placed/remaining detail.

/** Shared context the bounce orchestrator hands a flag-safe protocol. */
interface SwapCtx {
  /** The touched run in TARGET order (named movees + co-touched siblings). */
  coBounce: string[];
  /** The heading uuid for HEADMOVE; null for the loose/projects protocols. */
  containerUuid: string | null;
  txnId: string;
  actor: string;
  touchedUnnamed: string[];
  startedAt: Date;
  options: WriteOptions;
  cap: number;
}

/** A unique-enough scratch-container title suffix (opId-ish). */
function scratchSuffix(startedAt: Date): string {
  return `${startedAt.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/**
 * Pre-ranks over the FULL touched set on the `index` axis — the flag-carrying
 * movees are NOT scope members (a Today flag makes startDate non-null, so the
 * bounce's `pre.members` excludes them), so the undoable summary must capture
 * every coBounce row's prior `index` directly, not just `pre.members`.
 */
function captureIndexRanks(deps: WriteDeps, uuids: string[]): Record<string, unknown> {
  const reader = createDbReader(deps.db);
  const pre: Record<string, unknown> = {};
  for (const uuid of uuids) pre[uuid] = reader.rankOf(uuid, "index");
  return pre;
}

/** Abort payload for a flag-safe protocol (placed/remaining + recovery detail). */
function swapAborted(
  detail: string,
  placed: string[],
  remaining: string[],
  cause: MutationResult | null,
): ReorderResult {
  return { kind: "bounce-aborted", op: "reorder", detail, placed, remaining, cause };
}

/** A H-REORDER-SCOPE block from a flag-safe protocol (records the summary). */
function swapBlocked(
  deps: WriteDeps,
  params: ReorderParams,
  ctx: SwapCtx,
  preRanks: Record<string, unknown>,
  detail: string,
  remediation: string,
): MutationResult {
  const result: MutationResult = {
    kind: "blocked",
    op: "reorder",
    reason: "hazard",
    hazard: "H-REORDER-SCOPE",
    detail,
    remediation,
  };
  auditSummary(deps, params, ctx.startedAt, "blocked:H-REORDER-SCOPE", null, {
    pre: preRanks,
    txnId: ctx.txnId,
    actor: ctx.actor,
  });
  return result;
}

/** Terminal ordering verify over the touched run on the `index` axis. */
async function verifyIndexOrder(deps: WriteDeps, coBounce: string[], options: WriteOptions) {
  return pollUntilVerified(
    () =>
      evaluateDelta(
        { mode: "ordering", key: "index", sequence: coBounce },
        createDbReader(deps.db),
        {
          modDates: {},
          fields: {},
        },
      ),
    options.verifyTimeoutMs ?? 4000,
    deps.poller ?? {},
  );
}

/** The OK result shape shared by the three protocols. */
function swapOk(
  deps: WriteDeps,
  coBounce: string[],
  ctx: SwapCtx,
  warnings?: string[],
): MutationResult {
  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of coBounce) observed[uuid] = reader.rankOf(uuid, "index");
  return {
    kind: "ok",
    op: "reorder",
    uuid: null,
    observed,
    vector: "url-scheme",
    tier: 0,
    undoToken: ctx.txnId,
    ...(warnings !== undefined && warnings.length > 0 && { warnings }),
    ...(ctx.touchedUnnamed.length > 0 && { touched: ctx.touchedUnnamed }),
  };
}

/**
 * HEADMOVE (SIT6) — a heading's flag-carrying anytime children: UNHEAD the whole
 * touched run (clean — heading→NULL, `index` + flag preserved), then RE-HEAD it in
 * FORWARD target order — each now-loose row BACK-INSERTS past the heading-bucket
 * `index` max, so forward-order re-heads land the exact order (the shipped
 * `heading-someday` mechanism, now for the ANYTIME class + proven flag-safe). Two
 * `todo.move` URL legs per item (`list-id=<p>` then `list-id=<p>&heading=<h>`), no
 * when= leg, no json collapse. Non-atomic: a mid-fail leaves rows UNHEADED in the
 * project root, disclosed (same discipline as heading-someday).
 */
async function runHeadMove(
  deps: WriteDeps,
  params: ReorderParams,
  ctx: SwapCtx,
): Promise<ReorderResult> {
  const { coBounce, containerUuid, txnId, actor, touchedUnnamed, startedAt, options, cap } = ctx;
  const headingUuid = containerUuid;
  const projectUuid = headingProjectUuid(deps, headingUuid);
  const preRanks = captureIndexRanks(deps, coBounce);

  const problems: string[] = [];
  if (headingUuid === null || projectUuid === null) {
    problems.push("the heading did not resolve to a project (re-head needs the heading's project)");
  }
  if (coBounce.length > cap) {
    problems.push(
      `${coBounce.length} touched items exceed the cap of ${cap} (each costs an unhead + re-head leg` +
        (touchedUnnamed.length > 0
          ? `; ${touchedUnnamed.length} unnamed heading sibling(s) are co-moved to honor the order`
          : "") +
        ")",
    );
  }
  if (problems.length > 0) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      `within-heading flag-safe reorder rejected: ${problems.join("; ")}`,
      "reorder the anytime children of ONE heading (read the project first), " +
        `at most ${cap} touched (set with \`things config set bounce-max-items\`)`,
    );
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
          `HEADMOVE unhead ×${coBounce.length} → re-head ×${coBounce.length} (flag-safe back-insert, ` +
          `forward order${touchedUnnamed.length > 0 ? `, touches ${touchedUnnamed.length} unnamed sibling(s)` : ""}): ` +
          "a flagged movee's when= bounce would de-Today it, so each child is unheaded (index + flag " +
          "preserved) then re-headed to append at the heading-bucket end; one terminal order verify",
        expectedDelta: { mode: "ordering", key: "index", sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);

  // 1. UNHEAD each touched member (clean — heading→NULL, index + flag preserved).
  const unheaded: string[] = [];
  for (const uuid of coBounce) {
    const res = await runMutation(deps, "todo.move", { uuid, noHeading: true }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...unheaded] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `unheading ${uuid} failed — ${unheaded.length} item(s) are UNHEADED in project ` +
          `${projectUuid} and must be moved back under the heading manually`,
        unheaded,
        coBounce.slice(unheaded.length),
        res,
      );
    }
    unheaded.push(uuid);
  }

  // 2. RE-HEAD in forward target order (each now-loose row back-inserts at the end).
  const placed: string[] = [];
  for (const uuid of coBounce) {
    const res = await runMutation(
      deps,
      "todo.move",
      { uuid, project: { uuid: projectUuid as string }, heading: headingUuid as string },
      legOpts,
    );
    if (res.kind !== "ok") {
      const stillUnheaded = coBounce.filter((u) => !placed.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `re-heading ${uuid} failed — ${stillUnheaded.length} item(s) remain UNHEADED in project ` +
          `${projectUuid} (ordered) and must be moved back under the heading manually`,
        placed,
        stillUnheaded,
        res,
      );
    }
    placed.push(uuid);
  }

  const verify = await verifyIndexOrder(deps, coBounce, options);
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...placed] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      "the heading did not land the requested order after re-heading; re-run once Things is idle",
      placed,
      [],
      null,
    );
  }
  auditSummary(deps, params, startedAt, "ok", swapObserved(deps, coBounce), {
    pre: preRanks,
    txnId,
    actor,
  });
  return swapOk(deps, coBounce, ctx);
}

/**
 * LOOSEPARK (SIT6) — flag-carrying area-less loose anytime to-dos: create a scratch
 * PROJECT, PARK every touched row into it (any order), then UNPARK in REVERSE target
 * order — each unpark (`list-id=` empty) FRONT-INSERTS at the loose Anytime `index`
 * min in dispatch order, so a reverse-target dispatch lands the exact order (the
 * central SIT6 law; NO in-scratch reorder needed). Verify the scratch is EMPTY, then
 * TRASH it (shallow project trash). Non-atomic: a mid-fail leaves rows PARKED in the
 * NAMED scratch project (recovery text); the scratch is NEVER trashed while non-empty
 * (AREADEL — that would Trash the parked rows).
 */
async function runLoosePark(
  deps: WriteDeps,
  params: ReorderParams,
  ctx: SwapCtx,
): Promise<ReorderResult> {
  const { coBounce, txnId, actor, touchedUnnamed, startedAt, options, cap } = ctx;
  const preRanks = captureIndexRanks(deps, coBounce);

  if (coBounce.length > cap) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      `area-less loose anytime flag-safe reorder rejected: ${coBounce.length} touched items exceed ` +
        `the cap of ${cap} (each costs a park + unpark leg` +
        (touchedUnnamed.length > 0
          ? `; ${touchedUnnamed.length} co-touched loose sibling(s)`
          : "") +
        ")",
      `reorder at most ${cap} loose Anytime to-dos (set with \`things config set bounce-max-items\`)`,
    );
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
          `LOOSEPARK scratch project + park ×${coBounce.length} + unpark ×${coBounce.length} ` +
          `(flag-safe front-insert, reverse target order` +
          (touchedUnnamed.length > 0
            ? `, touches ${touchedUnnamed.length} unnamed sibling(s)`
            : "") +
          "; trash the empty scratch): a flagged movee's when= bounce would de-Today it, so each row " +
          "is parked into a scratch project then unparked to front-insert at the loose min; one terminal " +
          "order verify",
        expectedDelta: { mode: "ordering", key: "index", sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);
  const scratchTitle = `things-api reorder-anytime ${scratchSuffix(startedAt)}`;

  // 1. Create the scratch PROJECT.
  const add = await runMutation(deps, "project.add", { title: scratchTitle }, legOpts);
  if (add.kind !== "ok" || add.uuid === null) {
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
    return swapAborted(
      `could not create the scratch project "${scratchTitle}" — nothing was parked; no changes were made`,
      [],
      coBounce,
      add.kind === "ok" ? null : add,
    );
  }
  const scratch = add.uuid;

  // 2. PARK each touched row into the scratch project (any order).
  const parked: string[] = [];
  for (const uuid of coBounce) {
    const res = await runMutation(deps, "todo.move", { uuid, project: { uuid: scratch } }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...parked] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `parking ${uuid} into scratch project ${scratch} failed — ${parked.length} item(s) are PARKED ` +
          `there (${scratch}) and must be moved back to the loose Anytime list manually; the scratch ` +
          "project was NOT trashed",
        parked,
        coBounce.slice(parked.length),
        res,
      );
    }
    parked.push(uuid);
  }

  // 3. UNPARK in REVERSE target order — front-insert lands the target order.
  const dispatch = coBounce.toReversed();
  const unparked: string[] = [];
  for (const uuid of dispatch) {
    const res = await runMutation(deps, "todo.move", { uuid, loose: true }, legOpts);
    if (res.kind !== "ok") {
      const stillParked = dispatch.filter((u) => !unparked.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...unparked] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `unparking ${uuid} from scratch project ${scratch} failed — ${stillParked.length} item(s) ` +
          `remain PARKED in ${scratch} and must be moved back to the loose Anytime list manually; the ` +
          "scratch project was NOT trashed",
        unparked,
        stillParked,
        res,
      );
    }
    unparked.push(uuid);
  }

  // 4. Verify the scratch is EMPTY, then trash it (NEVER trash a non-empty scratch).
  const remaining = countProjectChildren(deps, scratch);
  if (remaining > 0) {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...unparked] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      `the scratch project ${scratch} still holds ${remaining} parked item(s) after unparking — ` +
        "refusing to trash it (trashing a non-empty scratch would send them to the Trash, AREADEL); " +
        `move them back to the loose Anytime list and delete ${scratch} manually`,
      unparked,
      [],
      null,
    );
  }
  const del = await runMutation(deps, "project.delete", { uuid: scratch }, legOpts);
  const scratchTrashed = del.kind === "ok";

  // 5. Terminal verify: the loose Anytime order matches the target.
  const verify = await verifyIndexOrder(deps, coBounce, options);
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...unparked] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      "the loose Anytime list did not land the requested order after unparking (scratch project " +
        `${scratch} was ${scratchTrashed ? "trashed" : "left in place"}); re-run once Things is idle`,
      unparked,
      [],
      null,
    );
  }

  auditSummary(deps, params, startedAt, "ok", swapObserved(deps, coBounce), {
    pre: preRanks,
    txnId,
    actor,
  });
  return swapOk(deps, coBounce, ctx, [
    `scratch project ${scratch} was created for the reorder and ` +
      (scratchTrashed
        ? "moved to the Trash (verified empty first — the protocol never trashes a non-empty scratch)"
        : `could NOT be trashed (${del.kind}) — it remains in your project list empty; delete it manually`),
  ]);
}

/**
 * PROJPARK (SIT6) — flag-carrying area-less sidebar projects: create a scratch AREA,
 * PARK each project into it (`area-id=` leg), then DETACH in REVERSE target order —
 * each detach (`area-id=` empty) FRONT-INSERTS at the area-less project `index` min in
 * dispatch order, so a reverse-target dispatch lands the exact order (stars intact).
 * Verify the scratch area is EMPTY, then DELETE it — the delete supplies its own
 * H-PERMANENT-DELETE acknowledgement INTERNALLY (this transaction created the area and
 * has just verified it empty); it NEVER deletes a non-empty area (AREADEL would Trash
 * the parked projects + shallow-trash their children). Replaces the #351 de-Today
 * refusal for flagged movees. Non-atomic: a mid-fail leaves projects PARKED in the
 * NAMED scratch area (recovery text).
 */
async function runProjPark(
  deps: WriteDeps,
  params: ReorderParams,
  ctx: SwapCtx,
): Promise<ReorderResult> {
  const { coBounce, txnId, actor, touchedUnnamed, startedAt, options, cap } = ctx;
  const preRanks = captureIndexRanks(deps, coBounce);

  if (coBounce.length > cap) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      `top-level projects flag-safe reorder rejected: ${coBounce.length} touched items exceed the cap ` +
        `of ${cap} (each costs a park + detach leg` +
        (touchedUnnamed.length > 0
          ? `; ${touchedUnnamed.length} co-touched sidebar sibling(s)`
          : "") +
        ")",
      `reorder at most ${cap} top-level projects (set with \`things config set bounce-max-items\`)`,
    );
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
          `PROJPARK scratch area + park ×${coBounce.length} + detach ×${coBounce.length} ` +
          `(flag-safe front-insert, reverse target order` +
          (touchedUnnamed.length > 0
            ? `, touches ${touchedUnnamed.length} unnamed sibling(s)`
            : "") +
          "; delete the empty scratch area): a flagged project's when= bounce would de-star it, so each " +
          "project is parked into a scratch area then detached to front-insert at the sidebar min; one " +
          "terminal order verify",
        expectedDelta: { mode: "ordering", key: "index", sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);
  const scratchTitle = `things-api reorder-projects ${scratchSuffix(startedAt)}`;

  // 1. Create the scratch AREA.
  const add = await runMutation(deps, "area.add", { title: scratchTitle }, legOpts);
  if (add.kind !== "ok" || add.uuid === null) {
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
    return swapAborted(
      `could not create the scratch area "${scratchTitle}" — nothing was parked; no changes were made`,
      [],
      coBounce,
      add.kind === "ok" ? null : add,
    );
  }
  const scratch = add.uuid;

  // 2. PARK each project into the scratch area (any order).
  const parked: string[] = [];
  for (const uuid of coBounce) {
    const res = await runMutation(deps, "project.move", { uuid, area: { uuid: scratch } }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...parked] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `parking project ${uuid} into scratch area ${scratch} failed — ${parked.length} project(s) are ` +
          `PARKED there (${scratch}) and must be moved back to the sidebar manually; the scratch area was ` +
          "NOT deleted",
        parked,
        coBounce.slice(parked.length),
        res,
      );
    }
    parked.push(uuid);
  }

  // 3. DETACH in REVERSE target order — front-insert lands the target order.
  const dispatch = coBounce.toReversed();
  const detached: string[] = [];
  for (const uuid of dispatch) {
    const res = await runMutation(deps, "project.move", { uuid, noArea: true }, legOpts);
    if (res.kind !== "ok") {
      const stillParked = dispatch.filter((u) => !detached.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...detached] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `detaching project ${uuid} from scratch area ${scratch} failed — ${stillParked.length} ` +
          `project(s) remain PARKED in ${scratch} and must be moved back to the sidebar manually; the ` +
          "scratch area was NOT deleted",
        detached,
        stillParked,
        res,
      );
    }
    detached.push(uuid);
  }

  // 4. Verify the scratch area is EMPTY, then delete it (NEVER delete a non-empty area).
  const remaining = countAreaMembers(deps, scratch);
  if (remaining > 0) {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...detached] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      `the scratch area ${scratch} still holds ${remaining} parked project(s) after detaching — ` +
        "refusing to delete it (deleting a non-empty area TRASHES its projects and shallow-trashes their " +
        `children, AREADEL); move them back to the sidebar and delete ${scratch} manually`,
      detached,
      [],
      null,
    );
  }
  // The delete supplies H-PERMANENT-DELETE internally (created + verified-empty this
  // txn); H-AREA-NOT-EMPTY does not trip on the verified-empty area. Never
  // acknowledge H-AREA-NOT-EMPTY — a non-empty area aborts above, never deletes.
  const del = await runMutation(
    deps,
    "area.delete",
    { target: scratch },
    { ...legOpts, dangerouslyPermanent: true },
  );
  const scratchDeleted = del.kind === "ok";

  // 5. Terminal verify: the sidebar order matches the target.
  const verify = await verifyIndexOrder(deps, coBounce, options);
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...detached] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      "the top-level projects did not land the requested order after detaching (scratch area " +
        `${scratch} was ${scratchDeleted ? "deleted" : "left in place"}); re-run once Things is idle`,
      detached,
      [],
      null,
    );
  }

  auditSummary(deps, params, startedAt, "ok", swapObserved(deps, coBounce), {
    pre: preRanks,
    txnId,
    actor,
  });
  return swapOk(deps, coBounce, ctx, [
    `scratch area ${scratch} was created for the reorder and ` +
      (scratchDeleted
        ? "deleted (verified empty first — the protocol never deletes a non-empty area)"
        : `could NOT be deleted (${del.kind}) — it remains in your sidebar empty; delete it manually`),
  ]);
}

/** Observed `index` ranks over the touched run (for the audit summary). */
function swapObserved(deps: WriteDeps, coBounce: string[]): Record<string, unknown> {
  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of coBounce) observed[uuid] = reader.rankOf(uuid, "index");
  return observed;
}

/** Live (open, non-trashed) direct child count of a project (scratch emptiness). */
function countProjectChildren(deps: WriteDeps, projectUuid: string): number {
  const row = deps.db
    .prepare(
      "SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 0 AND status = 0 AND " +
        "(project = ? OR heading IN (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))",
    )
    .get(projectUuid, projectUuid) as { n: number };
  return row.n;
}

/** Live member count of an area (direct to-dos + projects) — scratch emptiness. */
function countAreaMembers(deps: WriteDeps, areaUuid: string): number {
  const row = deps.db
    .prepare("SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 0 AND status = 0 AND area = ?")
    .get(areaUuid) as { n: number };
  return row.n;
}

/** A row's type (0 = to-do, 1 = project, 2 = heading), or null when it is gone. */
function rowTypeOf(deps: WriteDeps, uuid: string): number | null {
  const row = deps.db.prepare("SELECT type FROM TMTask WHERE uuid = ?").get(uuid) as
    | { type: number }
    | undefined;
  return row?.type ?? null;
}

// -------------------------------------------- SIT7 automatic MOVE fallbacks
//
// The non-experimental park + re-enter protocols the native-only reorder scopes
// degrade to when the private `_private_experimental_ reorder` command is
// unavailable (allow-experimental off OR the sdef canary fails) — the LIVE
// automatic backups SIT7 proved (docs/lab/sit7-backup-laws.md). Every leg is a
// URL/AppleScript MOVE (`list-id=`/`area-id=`/`move … to list "Inbox"`) — NO
// when= leg, NO private reorder surface — so the Today/Evening flag + reminder +
// deadline + FKs all survive the sort. Re-entry geometry follows the destination's
// CONTAINMENT class (SIT7's general law): LOOSE-like buckets FRONT-insert (reverse
// target dispatch), CONTAINERS BACK-insert (forward target dispatch):
//   - INBOXBACK (inbox): park each row into a scratch PROJECT, then re-enter
//       `move … to list "Inbox"` in REVERSE target order — FRONT-inserts and
//       RESTORES start=0 (a same-list `move … to "Inbox"` is a no-op, so park-first
//       is mandatory — the inbox cousin of §9l).
//   - PROJROOT (project): park each unheaded child into a scratch PROJECT, then
//       re-home `list-id=<P>` in FORWARD target order — BACK-inserts at the project-
//       root max (a project root behaves like a heading container). ONE protocol for
//       ALL rows (flagged or not) — the move round-trip is proven flag-safe.
//   - AREABACK (area): park each member OUT (a to-do into a scratch PROJECT, a project
//       into a scratch AREA), then re-home to the area in REVERSE target order —
//       FRONT-inserts at the area's member min (an area behaves like a loose bucket),
//       the area FK preserved.
// They share the SIT6 move family's gate (bounce-enabled) and cap (bounce-max-items),
// pre-ranks (undo via a single inverse reorder), named-scratch abort disclosure,
// verify-empty teardown (AREADEL — never trash/delete a non-empty scratch), and
// placement-honesty `touched` disclosure. Non-atomic: a mid-protocol failure leaves
// rows in a disclosed transient state and fails loudly with placed/remaining detail.

/**
 * Compute the touched run + build the {@link SwapCtx} for a SIT7 move fallback,
 * validate scope membership, and dispatch to the matching protocol. Unlike the
 * SIT6 flag-swap (whose movees are flag-EXCLUDED from `pre.members`), the SIT7
 * fallbacks operate on TRUE scope members, so duplicates/rejected/mixed-type are
 * validated here exactly as the bounce path validates them.
 */
async function runMoveFallback(
  deps: WriteDeps,
  params: ReorderParams,
  fallback: FallbackKind,
  options: WriteOptions,
): Promise<ReorderResult> {
  const startedAt = deps.now?.() ?? new Date();
  const now = deps.now ?? (() => new Date());
  const actor = options.actor ?? deps.config.actor;
  const cap = deps.config.bounceMaxItems ?? BOUNCE_MAX_ITEMS;
  const containerUuid = resolveContainerUuid(deps, params);
  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;
  const pre = computeReorderPre(deps.db, params, containerUuid, now(), { zone: deps.zone });

  // proj-root BACK-inserts (forward dispatch → suffix from the first named slot);
  // inbox/area FRONT-insert (reverse dispatch → prefix to the last named slot).
  const direction: "front" | "back" = fallback === "proj-root" ? "back" : "front";
  const targetOrder = pre.wireList;
  const named = new Set(params.named ?? params.uuids);
  const movedPositions = targetOrder.map((u, i) => (named.has(u) ? i : -1)).filter((i) => i >= 0);
  const firstMoved = movedPositions.length > 0 ? (movedPositions[0] as number) : 0;
  const lastMoved =
    movedPositions.length > 0 ? (movedPositions[movedPositions.length - 1] as number) : 0;
  const coBounce =
    direction === "back" ? targetOrder.slice(firstMoved) : targetOrder.slice(0, lastMoved + 1);
  const touchedUnnamed = coBounce.filter((u) => !named.has(u));
  const ctx: SwapCtx = {
    coBounce,
    containerUuid,
    txnId,
    actor,
    touchedUnnamed,
    startedAt,
    options,
    cap,
  };
  const preRanks = captureIndexRanks(deps, coBounce);

  const problems: string[] = [];
  if (params.uuids.length === 0) problems.push("no uuids given");
  if (pre.duplicates.length > 0) problems.push(`duplicated uuid(s): ${pre.duplicates.join(", ")}`);
  for (const r of pre.rejected) problems.push(`${r.uuid} ${r.reason}`);
  if (pre.mixedTypes) {
    problems.push(
      "an area reorder must be all to-dos OR all projects — a mixed member set is unprobed",
    );
  }
  if (problems.length > 0) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      `reorder request rejected: ${problems.join("; ")}`,
      "read the scope first and pass only its eligible members, at most " +
        `${cap} for the fallback protocol (set with \`things config set bounce-max-items\`)`,
    );
  }

  switch (fallback) {
    case "inbox-park":
      return runInboxPark(deps, params, ctx);
    case "proj-root":
      return runProjectRoot(deps, params, ctx);
    case "area-back":
      return runAreaBack(deps, params, ctx);
  }
}

/**
 * INBOXBACK (SIT7) — Inbox order without the private surface: create a scratch
 * PROJECT, PARK every touched row into it (`list-id=<scratch>` flips start 0→1
 * transiently), then re-enter `move to do id X to list "Inbox"` in REVERSE target
 * order — each re-entry FRONT-INSERTS at the inbox `index` min AND RESTORES start=0
 * (project→NULL), so a reverse-target dispatch lands the exact order. The inbox
 * return leg is AppleScript-only (`move … to list "Inbox"`; #356) — pinned here.
 * Verify the scratch is EMPTY, then TRASH it. Non-atomic: a mid-fail leaves rows
 * PARKED in the NAMED scratch project (recovery text); never trashes a non-empty
 * scratch (AREADEL).
 */
async function runInboxPark(
  deps: WriteDeps,
  params: ReorderParams,
  ctx: SwapCtx,
): Promise<ReorderResult> {
  const { coBounce, txnId, actor, touchedUnnamed, startedAt, options, cap } = ctx;
  const preRanks = captureIndexRanks(deps, coBounce);

  if (coBounce.length > cap) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      `Inbox order fallback rejected: ${coBounce.length} touched items exceed the cap of ${cap} ` +
        `(each costs a park + Inbox-return leg${touchedUnnamed.length > 0 ? `; ${touchedUnnamed.length} co-touched inbox sibling(s)` : ""})`,
      `reorder at most ${cap} inbox to-dos (set with \`things config set bounce-max-items\`)`,
    );
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
          `INBOXBACK scratch project + park ×${coBounce.length} + Inbox-return ×${coBounce.length} ` +
          `(front-insert, reverse target order${touchedUnnamed.length > 0 ? `, touches ${touchedUnnamed.length} unnamed sibling(s)` : ""}; ` +
          'trash the empty scratch): a same-list `move … to "Inbox"` is a no-op, so each row is ' +
          "parked into a scratch project then re-entered to the Inbox to front-insert (restoring " +
          "start=0); one terminal order verify",
        expectedDelta: { mode: "ordering", key: "index", sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);
  const scratchTitle = `things-api reorder-inbox ${scratchSuffix(startedAt)}`;

  // 1. Create the scratch PROJECT.
  const add = await runMutation(deps, "project.add", { title: scratchTitle }, legOpts);
  if (add.kind !== "ok" || add.uuid === null) {
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
    return swapAborted(
      `could not create the scratch project "${scratchTitle}" — nothing was parked; no changes were made`,
      [],
      coBounce,
      add.kind === "ok" ? null : add,
    );
  }
  const scratch = add.uuid;

  // 2. PARK each touched row into the scratch project (any order).
  const parked: string[] = [];
  for (const uuid of coBounce) {
    const res = await runMutation(deps, "todo.move", { uuid, project: { uuid: scratch } }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...parked] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `parking ${uuid} into scratch project ${scratch} failed — ${parked.length} item(s) are PARKED ` +
          `there (${scratch}) and must be moved back to the Inbox manually; the scratch project was ` +
          "NOT trashed",
        parked,
        coBounce.slice(parked.length),
        res,
      );
    }
    parked.push(uuid);
  }

  // 3. RE-ENTER `move … to list "Inbox"` (AppleScript-only, #356) in REVERSE target
  //    order — front-insert restores start=0 and lands the target order.
  const dispatch = coBounce.toReversed();
  const returned: string[] = [];
  for (const uuid of dispatch) {
    const res = await runMutation(
      deps,
      "todo.move",
      { uuid, inbox: true },
      { ...legOpts, vector: "applescript" },
    );
    if (res.kind !== "ok") {
      const stillParked = dispatch.filter((u) => !returned.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...returned] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `returning ${uuid} to the Inbox from scratch project ${scratch} failed — ${stillParked.length} ` +
          `item(s) remain PARKED in ${scratch} and must be moved back to the Inbox manually; the ` +
          "scratch project was NOT trashed",
        returned,
        stillParked,
        res,
      );
    }
    returned.push(uuid);
  }

  // 4. Verify the scratch is EMPTY, then trash it (NEVER trash a non-empty scratch).
  const remaining = countProjectChildren(deps, scratch);
  if (remaining > 0) {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...returned] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      `the scratch project ${scratch} still holds ${remaining} parked item(s) after the Inbox return — ` +
        "refusing to trash it (trashing a non-empty scratch would send them to the Trash, AREADEL); " +
        `move them back to the Inbox and delete ${scratch} manually`,
      returned,
      [],
      null,
    );
  }
  const del = await runMutation(deps, "project.delete", { uuid: scratch }, legOpts);
  const scratchTrashed = del.kind === "ok";

  // 5. Terminal verify: the inbox order matches the target.
  const verify = await verifyIndexOrder(deps, coBounce, options);
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...returned] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      "the Inbox did not land the requested order after the return (scratch project " +
        `${scratch} was ${scratchTrashed ? "trashed" : "left in place"}); re-run once Things is idle`,
      returned,
      [],
      null,
    );
  }

  auditSummary(deps, params, startedAt, "ok", swapObserved(deps, coBounce), {
    pre: preRanks,
    txnId,
    actor,
  });
  return swapOk(deps, coBounce, ctx, [
    `scratch project ${scratch} was created for the reorder and ` +
      (scratchTrashed
        ? "moved to the Trash (verified empty first — the protocol never trashes a non-empty scratch)"
        : `could NOT be trashed (${del.kind}) — it remains in your project list empty; delete it manually`),
  ]);
}

/**
 * PROJROOT (SIT7) — a project's unheaded children without the private surface: create
 * a scratch PROJECT, PARK every touched child into it (`list-id=<scratch>`), then
 * re-home to the original project (`list-id=<P>`, no heading) in FORWARD target order
 * — each re-home BACK-INSERTS at the project-root `index` max (a project root behaves
 * like a heading container), so a forward-target dispatch lands the exact order. ONE
 * protocol for ALL rows (flagged or not) — the move round-trip is proven flag-safe.
 * Verify the scratch is EMPTY, then TRASH it. Non-atomic: a mid-fail leaves children
 * PARKED in the NAMED scratch project (recovery text).
 */
async function runProjectRoot(
  deps: WriteDeps,
  params: ReorderParams,
  ctx: SwapCtx,
): Promise<ReorderResult> {
  const { coBounce, containerUuid, txnId, actor, touchedUnnamed, startedAt, options, cap } = ctx;
  const preRanks = captureIndexRanks(deps, coBounce);

  if (containerUuid === null) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      "the project did not resolve (the re-home leg needs the project container)",
      "pass the project by uuid or a unique title (`--project`)",
    );
  }
  if (coBounce.length > cap) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      `within-project order fallback rejected: ${coBounce.length} touched items exceed the cap of ${cap} ` +
        `(each costs a park + re-home leg${touchedUnnamed.length > 0 ? `; ${touchedUnnamed.length} co-touched child sibling(s)` : ""})`,
      `reorder at most ${cap} of a project's unheaded children (set with \`things config set bounce-max-items\`)`,
    );
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
          `PROJROOT scratch project + park ×${coBounce.length} + re-home ×${coBounce.length} ` +
          `(flag-safe back-insert, forward target order${touchedUnnamed.length > 0 ? `, touches ${touchedUnnamed.length} unnamed sibling(s)` : ""}; ` +
          "trash the empty scratch): the private reorder is unavailable, so each child is parked into a " +
          "scratch project then re-homed to the project root to back-insert at its end; one terminal " +
          "order verify",
        expectedDelta: { mode: "ordering", key: "index", sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);
  const scratchTitle = `things-api reorder-project ${scratchSuffix(startedAt)}`;

  // 1. Create the scratch PROJECT.
  const add = await runMutation(deps, "project.add", { title: scratchTitle }, legOpts);
  if (add.kind !== "ok" || add.uuid === null) {
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
    return swapAborted(
      `could not create the scratch project "${scratchTitle}" — nothing was parked; no changes were made`,
      [],
      coBounce,
      add.kind === "ok" ? null : add,
    );
  }
  const scratch = add.uuid;

  // 2. PARK each child into the scratch project (any order).
  const parked: string[] = [];
  for (const uuid of coBounce) {
    const res = await runMutation(deps, "todo.move", { uuid, project: { uuid: scratch } }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...parked] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `parking ${uuid} into scratch project ${scratch} failed — ${parked.length} child(ren) are PARKED ` +
          `there (${scratch}) and must be moved back to project ${containerUuid} manually; the scratch ` +
          "project was NOT trashed",
        parked,
        coBounce.slice(parked.length),
        res,
      );
    }
    parked.push(uuid);
  }

  // 3. RE-HOME to the project root in FORWARD target order — back-insert lands the target.
  const rehomed: string[] = [];
  for (const uuid of coBounce) {
    const res = await runMutation(
      deps,
      "todo.move",
      { uuid, project: { uuid: containerUuid } },
      legOpts,
    );
    if (res.kind !== "ok") {
      const stillParked = coBounce.filter((u) => !rehomed.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...rehomed] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `re-homing ${uuid} to project ${containerUuid} from scratch project ${scratch} failed — ` +
          `${stillParked.length} child(ren) remain PARKED in ${scratch} and must be moved back to ` +
          `project ${containerUuid} manually; the scratch project was NOT trashed`,
        rehomed,
        stillParked,
        res,
      );
    }
    rehomed.push(uuid);
  }

  // 4. Verify the scratch is EMPTY, then trash it (NEVER trash a non-empty scratch).
  const remaining = countProjectChildren(deps, scratch);
  if (remaining > 0) {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...rehomed] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      `the scratch project ${scratch} still holds ${remaining} parked child(ren) after re-homing — ` +
        "refusing to trash it (trashing a non-empty scratch would send them to the Trash, AREADEL); " +
        `move them back to project ${containerUuid} and delete ${scratch} manually`,
      rehomed,
      [],
      null,
    );
  }
  const del = await runMutation(deps, "project.delete", { uuid: scratch }, legOpts);
  const scratchTrashed = del.kind === "ok";

  // 5. Terminal verify: the project-root order matches the target.
  const verify = await verifyIndexOrder(deps, coBounce, options);
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...rehomed] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      "the project's children did not land the requested order after re-homing (scratch project " +
        `${scratch} was ${scratchTrashed ? "trashed" : "left in place"}); re-run once Things is idle`,
      rehomed,
      [],
      null,
    );
  }

  auditSummary(deps, params, startedAt, "ok", swapObserved(deps, coBounce), {
    pre: preRanks,
    txnId,
    actor,
  });
  return swapOk(deps, coBounce, ctx, [
    `scratch project ${scratch} was created for the reorder and ` +
      (scratchTrashed
        ? "moved to the Trash (verified empty first — the protocol never trashes a non-empty scratch)"
        : `could NOT be trashed (${del.kind}) — it remains in your project list empty; delete it manually`),
  ]);
}

/**
 * AREABACK (SIT7) — an area's members without the private surface. Park each member
 * OUT of the area (a to-do into a scratch PROJECT, a project into a scratch AREA),
 * then re-home to the area (`list-id=<area>` for a to-do, `area-id=<area>` for a
 * project) in REVERSE target order — each re-home FRONT-INSERTS at the area's member
 * `index` min (an area behaves like a loose bucket) with the area FK preserved, so a
 * reverse-target dispatch lands the exact order, flag-safe. The area scope is uniform-
 * type (mixed sets are rejected upstream), so the whole run is one kind. Verify the
 * scratch is EMPTY, then trash/delete it (the area delete supplies its own
 * H-PERMANENT-DELETE acknowledgement internally — created + verified-empty this txn).
 * Non-atomic: a mid-fail leaves members PARKED in the NAMED scratch container.
 */
async function runAreaBack(
  deps: WriteDeps,
  params: ReorderParams,
  ctx: SwapCtx,
): Promise<ReorderResult> {
  const { coBounce, containerUuid, txnId, actor, touchedUnnamed, startedAt, options, cap } = ctx;
  const preRanks = captureIndexRanks(deps, coBounce);

  if (containerUuid === null) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      "the area did not resolve (the re-home leg needs the area container)",
      "pass the area by uuid or a unique title (`--area`)",
    );
  }
  const isProjects = rowTypeOf(deps, coBounce[0] as string) === 1;
  const noun = isProjects ? "project" : "to-do";
  if (coBounce.length > cap) {
    return swapBlocked(
      deps,
      params,
      ctx,
      preRanks,
      `an area's member order fallback rejected: ${coBounce.length} touched items exceed the cap of ${cap} ` +
        `(each costs a park + re-home leg${touchedUnnamed.length > 0 ? `; ${touchedUnnamed.length} co-touched area sibling(s)` : ""})`,
      `reorder at most ${cap} of an area's members (set with \`things config set bounce-max-items\`)`,
    );
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
          `AREABACK scratch ${isProjects ? "area" : "project"} + park ×${coBounce.length} + re-home ×${coBounce.length} ` +
          `(flag-safe front-insert, reverse target order${touchedUnnamed.length > 0 ? `, touches ${touchedUnnamed.length} unnamed sibling(s)` : ""}; ` +
          `${isProjects ? "delete" : "trash"} the empty scratch): the private reorder is unavailable, so each ` +
          `${noun} is parked out then re-homed to the area to front-insert at its member min (area FK ` +
          "preserved); one terminal order verify",
        expectedDelta: { mode: "ordering", key: "index", sequence: coBounce },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  const legOpts = compoundLegOptions(options, txnId);
  const scratchTitle = `things-api reorder-area ${scratchSuffix(startedAt)}`;

  // 1. Create the scratch container (a PROJECT to hold to-dos / an AREA to hold projects).
  const add = isProjects
    ? await runMutation(deps, "area.add", { title: scratchTitle }, legOpts)
    : await runMutation(deps, "project.add", { title: scratchTitle }, legOpts);
  if (add.kind !== "ok" || add.uuid === null) {
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
    return swapAborted(
      `could not create the scratch ${isProjects ? "area" : "project"} "${scratchTitle}" — nothing was ` +
        "parked; no changes were made",
      [],
      coBounce,
      add.kind === "ok" ? null : add,
    );
  }
  const scratch = add.uuid;

  // 2. PARK each member OUT of the area into the scratch container (any order).
  const parked: string[] = [];
  for (const uuid of coBounce) {
    const res = isProjects
      ? await runMutation(deps, "project.move", { uuid, area: { uuid: scratch } }, legOpts)
      : await runMutation(deps, "todo.move", { uuid, project: { uuid: scratch } }, legOpts);
    if (res.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...parked] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `parking ${noun} ${uuid} into scratch ${isProjects ? "area" : "project"} ${scratch} failed — ` +
          `${parked.length} ${noun}(s) are PARKED there (${scratch}) and must be moved back to area ` +
          `${containerUuid} manually; the scratch was NOT ${isProjects ? "deleted" : "trashed"}`,
        parked,
        coBounce.slice(parked.length),
        res,
      );
    }
    parked.push(uuid);
  }

  // 3. RE-HOME to the area in REVERSE target order — front-insert lands the target.
  const dispatch = coBounce.toReversed();
  const rehomed: string[] = [];
  for (const uuid of dispatch) {
    const res = isProjects
      ? await runMutation(deps, "project.move", { uuid, area: { uuid: containerUuid } }, legOpts)
      : await runMutation(deps, "todo.move", { uuid, area: { uuid: containerUuid } }, legOpts);
    if (res.kind !== "ok") {
      const stillParked = dispatch.filter((u) => !rehomed.includes(u));
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...rehomed] },
        {
          pre: preRanks,
          txnId,
          actor,
        },
      );
      return swapAborted(
        `re-homing ${noun} ${uuid} to area ${containerUuid} from scratch ${scratch} failed — ` +
          `${stillParked.length} ${noun}(s) remain PARKED in ${scratch} and must be moved back to ` +
          `area ${containerUuid} manually; the scratch was NOT ${isProjects ? "deleted" : "trashed"}`,
        rehomed,
        stillParked,
        res,
      );
    }
    rehomed.push(uuid);
  }

  // 4. Verify the scratch is EMPTY, then trash/delete it (NEVER teardown a non-empty scratch).
  const remaining = isProjects
    ? countAreaMembers(deps, scratch)
    : countProjectChildren(deps, scratch);
  if (remaining > 0) {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...rehomed] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      `the scratch ${isProjects ? "area" : "project"} ${scratch} still holds ${remaining} parked ` +
        `${noun}(s) after re-homing — refusing to ${isProjects ? "delete" : "trash"} it (that would ` +
        `${isProjects ? "trash its members and shallow-trash their children" : "send them to the Trash"}, ` +
        `AREADEL); move them back to area ${containerUuid} and remove ${scratch} manually`,
      rehomed,
      [],
      null,
    );
  }
  // The area delete supplies H-PERMANENT-DELETE internally (created + verified-empty
  // this txn); H-AREA-NOT-EMPTY cannot trip (a non-empty scratch aborts above).
  const del = isProjects
    ? await runMutation(
        deps,
        "area.delete",
        { target: scratch },
        { ...legOpts, dangerouslyPermanent: true },
      )
    : await runMutation(deps, "project.delete", { uuid: scratch }, legOpts);
  const scratchRemoved = del.kind === "ok";

  // 5. Terminal verify: the area's member order matches the target.
  const verify = await verifyIndexOrder(deps, coBounce, options);
  if (verify.kind !== "ok") {
    auditSummary(
      deps,
      params,
      startedAt,
      "verify-failed:mismatch",
      { placed: [...rehomed] },
      {
        pre: preRanks,
        txnId,
        actor,
      },
    );
    return swapAborted(
      "the area's members did not land the requested order after re-homing (scratch " +
        `${scratch} was ${scratchRemoved ? (isProjects ? "deleted" : "trashed") : "left in place"}); ` +
        "re-run once Things is idle",
      rehomed,
      [],
      null,
    );
  }

  auditSummary(deps, params, startedAt, "ok", swapObserved(deps, coBounce), {
    pre: preRanks,
    txnId,
    actor,
  });
  return swapOk(deps, coBounce, ctx, [
    `scratch ${isProjects ? "area" : "project"} ${scratch} was created for the reorder and ` +
      (scratchRemoved
        ? `${isProjects ? "deleted" : "moved to the Trash"} (verified empty first — the protocol never ` +
          `${isProjects ? "deletes a non-empty area" : "trashes a non-empty scratch"})`
        : `could NOT be ${isProjects ? "deleted" : "trashed"} (${del.kind}) — it remains empty; remove it manually`),
  ]);
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
  const { rankKey } = spec;
  // The json collapse is only ever reached for a fixed-bucket, jsonCollapsible spec
  // (heading / anytime) — never a dated or per-type bounce — so away/back are the
  // concrete keywords the spec pins.
  const away = spec.away as WhenValue;
  const back = spec.back as WhenValue;
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
    const problem = checkStillMember(deps, uuid, bounceKind, containerUuid, now(), null);
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
  // heading / area-someday / container-day / heading-someday: the planner passes a
  // resolved uuid container directly (a heading uuid, an area uuid, or a project/
  // area uuid). The `day` bounce is container-less (a global cross-container axis).
  if (
    params.scope === "heading" ||
    params.scope === "area-someday" ||
    params.scope === "container-day" ||
    params.scope === "heading-someday"
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
  dayPacked: number | null,
): string | null {
  const packedToday = encodePackedDate(localToday(now));
  const row = deps.db
    .prepare(
      "SELECT status, trashed, startBucket, startDate, start, type, area, project, heading, deadline, " +
        "rt1_recurrenceRule AS rule, repeater, rt1_nextInstanceStartDate AS proj " +
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
        deadline: number | null;
        rule: unknown;
        repeater: unknown;
        proj: number | null;
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
    // SIT7 SOMEBACK: a loose someday to-do OR an area-less someday project. Both
    // front-insert on the shared loose someday index axis via the per-type bounce.
    case "someday":
      if (row.type !== 0 && row.type !== 1) return "the item is not a to-do or project";
      if (row.start !== 2 || row.startDate !== null) return "the item is no longer a Someday item";
      if (row.type === 0 && (row.project !== null || row.area !== null || row.heading !== null)) {
        return "the to-do is no longer a loose Someday item (it gained a container)";
      }
      if (row.type === 1 && row.area !== null) return "the project moved into an area";
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
    case "day": {
      // The dated bounce's members are SCHEDULED to-dos (any container) and scheduled
      // project rows (area-less OR area-direct — SIT5 AREAPROJDAY) sharing the day D
      // on the startBucket=0 axis, PLUS DEADLINE-FORECAST to-dos (startDate NULL,
      // start IN (1,2), deadline == D — DLBNC/§9o) on the SAME block todayIndex axis.
      // A concurrent edit that re-dates, de-schedules, evenings, clears the deadline,
      // or drops the row to the Inbox (start=0) ejects it from the group.
      if (row.type !== 0 && row.type !== 1) return "the item is not a to-do or project";
      // A repeating TEMPLATE stays a day-block member via its PROJECTION day
      // (rt1_nextInstanceStartDate — TMPLSORT/PTMPL), not startDate/deadline.
      if (row.rule !== null || row.repeater !== null) {
        return row.proj === dayPacked
          ? null
          : "the template's projection day changed (its recurrence rule was edited)";
      }
      const scheduled =
        row.startBucket === 0 && row.startDate !== null && row.startDate === dayPacked;
      const forecast =
        row.startDate === null &&
        (row.start === 1 || row.start === 2) &&
        row.deadline !== null &&
        row.deadline === dayPacked;
      if (!scheduled && !forecast) {
        return "the item left the day-group (re-dated, evening-ed, de-scheduled, or its deadline changed)";
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
