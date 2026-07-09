/**
 * write.reorder orchestrator — two strategies, both lab-derived:
 *
 * native  — one `_private_experimental_ reorder` AppleScript call through
 *           the standard pipeline (drift gate → guards → canary → execute →
 *           ordering verification). Scopes: today (bucket-0 members, O01/
 *           O03/O12), project/area (un-headed children, O04/O05/O09–O11).
 *           Gated by config.allowExperimental AND the sdef canary.
 *
 * bounce  — verified `when=` round-trips (O07/O08, P8e): re-scheduling an
 *           item away and back FRONT-INSERTS it in its section, so bouncing
 *           the requested uuids in reverse order places them top-first. Each
 *           leg is a full verified todo.update/project.update mutation;
 *           between items the live state is re-checked so a user editing
 *           Things concurrently causes a clean abort with partial-progress
 *           detail, never a fight. Scopes: today (fallback), evening (the
 *           ONLY way — O03), projects (top-level sidebar order via
 *           when=someday -> when=anytime — P8e, the ONLY way: every native
 *           sidebar spelling is dead, scf2 P6).
 *
 * The requested uuid list may be a subset of the scope: for native, the wire
 * list is extended with every remaining member in current order (placement
 * stays deterministic); for bounce, unrequested members simply stay put
 * below the bounced block (O07/O08: neighbors untouched).
 */
import type { AuditRecord } from "../audit/schema.ts";
import { localToday, encodePackedDate } from "../model/dates.ts";
import type { ReorderParams, ReorderStrategy } from "./operations.ts";
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
 * Bounce cost is 2 verified mutations per item; beyond this the today scope
 * should use the native strategy and the evening scope should be re-thought.
 */
export const BOUNCE_MAX_ITEMS = 10;

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
  return runBounce(deps, params, options);
}

function resolveStrategy(
  deps: WriteDeps,
  params: ReorderParams,
): { kind: "ok"; strategy: ReorderStrategy } | { kind: "blocked"; result: MutationResult } {
  const blocked = (
    detail: string,
    remediation: string,
  ): { kind: "blocked"; result: MutationResult } => ({
    kind: "blocked",
    result: {
      kind: "blocked",
      op: "reorder",
      reason: "hazard",
      hazard: "H-REORDER-SCOPE",
      detail,
      remediation,
    },
  });

  const nativeAvailable =
    deps.config.allowExperimental && (deps.sdefProbe ?? sdefDeclaresPrivateReorder)();

  if (params.strategy === "native") {
    if (params.scope === "evening") {
      return blocked(
        "evening reorder is bounce-only: the native command silently clears startBucket on " +
          "every listed item (O03)",
        "omit --strategy (evening defaults to bounce)",
      );
    }
    if (params.scope === "projects") {
      return blocked(
        "top-level sidebar order has NO native surface (every AppleScript spelling errors " +
          "and the private command no-ops — scf2 P6); only the when= bounce works (P8e)",
        "omit --strategy (projects defaults to bounce)",
      );
    }
    return { kind: "ok", strategy: "native" };
  }
  if (params.strategy === "bounce") {
    if (
      params.scope === "project" ||
      params.scope === "area" ||
      params.scope === "inbox" ||
      params.scope === "headings" ||
      params.scope === "someday"
    ) {
      return blocked(
        "bounce can only reorder the Today/Evening sections and top-level projects — its " +
          "primitive is a when= round-trip, which does not move this scope's order",
        "use the native strategy (requires `things config set allow-experimental true`)",
      );
    }
    return { kind: "ok", strategy: "bounce" };
  }

  // Default per scope.
  switch (params.scope) {
    case "evening":
    case "projects":
      return { kind: "ok", strategy: "bounce" };
    case "today":
      return { kind: "ok", strategy: nativeAvailable ? "native" : "bounce" };
    case "project":
    case "area":
    case "inbox":
    case "headings":
    case "someday":
      // Native-only scopes: let the pipeline explain precisely why native is
      // unavailable (planner: experimental gate; canary: sdef change).
      return { kind: "ok", strategy: "native" };
  }
}

// ------------------------------------------------------------------- bounce

async function runBounce(
  deps: WriteDeps,
  params: ReorderParams,
  options: WriteOptions,
): Promise<ReorderResult> {
  const startedAt = deps.now?.() ?? new Date();
  const now = deps.now ?? (() => new Date());
  const scope = params.scope as "today" | "evening" | "projects";
  const rankKey: "index" | "todayIndex" = scope === "projects" ? "index" : "todayIndex";
  const legOp = scope === "projects" ? ("project.update" as const) : ("todo.update" as const);

  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;
  // Scope/membership guard — same data the native path's guard uses.
  const pre = computeReorderPre(deps.db, params, resolveContainerUuid(deps, params), now());
  // Pre-ranks make the SUMMARY record the undoable unit (a single inverse
  // reorder restores the old relative order); legs are excluded from undo.
  const preRanks: Record<string, unknown> = {};
  for (const m of pre.members) preRanks[m.uuid] = m.rank;
  const problems: string[] = [];
  if (params.container !== undefined)
    problems.push("container is only valid for project/area/headings scopes");
  if (params.uuids.length === 0) problems.push("no uuids given");
  if (pre.duplicates.length > 0) problems.push(`duplicated uuid(s): ${pre.duplicates.join(", ")}`);
  for (const r of pre.rejected) problems.push(`${r.uuid} ${r.reason}`);
  if (scope !== "projects") {
    for (const uuid of pre.projectMembers) {
      problems.push(
        `${uuid} is a project — bounce re-schedules via todo.update, which is only validated ` +
          "for to-dos; use the native strategy for Today lists containing projects",
      );
    }
  }
  if (params.uuids.length > BOUNCE_MAX_ITEMS) {
    problems.push(
      `${params.uuids.length} items exceeds the bounce cap of ${BOUNCE_MAX_ITEMS} ` +
        "(each item costs two verified mutations)",
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
        `at most ${BOUNCE_MAX_ITEMS} for the bounce strategy`,
    };
    auditSummary(deps, params, startedAt, "blocked:H-REORDER-SCOPE", null, {
      pre: preRanks,
      txnId,
    });
    return result;
  }

  const away = scope === "today" ? "evening" : scope === "projects" ? "someday" : "today";
  const back = scope === "projects" ? "anytime" : scope;
  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op: "reorder",
      plan: {
        op: "reorder",
        vector: "url-scheme",
        tier: 0,
        invocation:
          `bounce ×${params.uuids.length} (reverse order): ` +
          `when=${away} → verified → when=${back} → verified; ` +
          "state re-checked between items",
        expectedDelta: { mode: "ordering", key: rankKey, sequence: params.uuids },
        hazardsChecked: ["H-REORDER-SCOPE"],
      },
    };
  }

  // Bounce in REVERSE: each round-trip front-inserts (O07/O08), so placing
  // the last item first leaves the requested order on top.
  const placed: string[] = [];
  for (let i = params.uuids.length - 1; i >= 0; i--) {
    const uuid = params.uuids[i] as string;

    // Concurrent-edit re-check: the item must still be an eligible member.
    const memberProblem = checkStillMember(deps, uuid, scope, now());
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
        { pre: preRanks, txnId },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail,
        placed: [...placed],
        remaining: params.uuids.slice(0, i + 1),
        cause: null,
      };
    }

    const leg1 = await runMutation(deps, legOp, { uuid, when: away }, legOptions(options, txnId));
    if (leg1.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail: `bounce leg 1 (when=${away}) failed for ${uuid} — the item was NOT moved`,
        placed: [...placed],
        remaining: params.uuids.slice(0, i + 1),
        cause: leg1,
      };
    }
    const leg2 = await runMutation(deps, legOp, { uuid, when: back }, legOptions(options, txnId));
    if (leg2.kind !== "ok") {
      auditSummary(
        deps,
        params,
        startedAt,
        "verify-failed:mismatch",
        { placed: [...placed] },
        { pre: preRanks, txnId },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail:
          `bounce leg 2 (when=${back}) failed for ${uuid} — THE ITEM IS STRANDED IN ` +
          `${away.toUpperCase()}; re-schedule it (when=${back}) or fix in the app`,
        placed: [...placed],
        remaining: params.uuids.slice(0, i + 1),
        cause: leg2,
      };
    }
    placed.unshift(uuid);

    // Placed-prefix invariant: everything bounced so far must read back in
    // requested relative order — anything else means a concurrent reshuffle.
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
        { pre: preRanks, txnId },
      );
      return {
        kind: "bounce-aborted",
        op: "reorder",
        detail:
          `placed items fell out of order after bouncing ${uuid} (concurrent edit?); ` +
          "re-run the reorder once Things is idle",
        placed: [...placed],
        remaining: params.uuids.slice(0, i),
        cause: null,
      };
    }
  }

  const reader = createDbReader(deps.db);
  const observed: Record<string, unknown> = {};
  for (const uuid of params.uuids) observed[uuid] = reader.rankOf(uuid, rankKey);
  auditSummary(deps, params, startedAt, "ok", observed, { pre: preRanks, txnId });
  return {
    kind: "ok",
    op: "reorder",
    uuid: null,
    observed,
    vector: "url-scheme",
    tier: 0,
  };
}

function legOptions(options: WriteOptions, txnId?: string): WriteOptions {
  const legs: WriteOptions = {};
  if (txnId !== undefined) legs.txn = { id: txnId, role: "leg" };
  if (options.maxDisruption !== undefined) legs.maxDisruption = options.maxDisruption;
  if (options.verifyTimeoutMs !== undefined) legs.verifyTimeoutMs = options.verifyTimeoutMs;
  if (options.actor !== undefined) legs.actor = options.actor;
  return legs;
}

function resolveContainerUuid(deps: WriteDeps, params: ReorderParams): string | null {
  if (params.scope === "project" || params.scope === "headings") {
    return resolveProject(deps.db, params.container ?? {}).resolved?.uuid ?? null;
  }
  if (params.scope === "area") {
    return resolveArea(deps.db, params.container ?? {}).resolved?.uuid ?? null;
  }
  return null;
}

/** null = still eligible; otherwise a human-readable problem. */
function checkStillMember(
  deps: WriteDeps,
  uuid: string,
  scope: "today" | "evening" | "projects",
  now: Date,
): string | null {
  const packedToday = encodePackedDate(localToday(now));
  const row = deps.db
    .prepare(
      "SELECT status, trashed, startBucket, startDate, start, type, area FROM TMTask WHERE uuid = ?",
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
      }
    | undefined;
  if (row === undefined) return "the item no longer exists";
  if (row.trashed !== 0) return "the item was trashed";
  if (row.status !== 0) return "the item is no longer open";
  if (scope === "projects") {
    if (row.type !== 1) return "the item is not a project";
    if (row.area !== null) return "the project moved into an area";
    if (row.start !== 1 || row.startDate !== null) {
      return "the project is no longer a plain Anytime project";
    }
    return null;
  }
  const inToday =
    row.startDate !== null && row.startDate <= packedToday && (row.start === 1 || row.start === 2);
  if (!inToday) return "the item left the Today list";
  if (scope === "today" && row.startBucket !== 0) return "the item moved to This Evening";
  if (scope === "evening" && (row.startBucket !== 1 || row.startDate !== packedToday)) {
    return "the item left This Evening";
  }
  return null;
}

function auditSummary(
  deps: WriteDeps,
  params: ReorderParams,
  startedAt: Date,
  result: AuditRecord["result"],
  observed: Record<string, unknown> | null,
  extras?: { pre?: Record<string, unknown>; txnId?: string },
): void {
  const fp = deps.fingerprint();
  const record: AuditRecord = {
    v: 1,
    ts: startedAt.toISOString(),
    actor: deps.config.actor,
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
