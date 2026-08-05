/**
 * Resolution-timestamp orchestrators — the multi-leg engine behind the
 * `--completed-at` / `--created-at` flags on `complete`, `cancel`, and `update`
 * (plan §2, docs/design/resolution-timestamp-surface.md). Backdating a resolved
 * item has no single-shot headless surface: AppleScript `set completion date`
 * fires EXCLUSIVELY against a verified-completed row (the generalized WG-7 law),
 * so a canceled item is walked through the certified stopDate-preserving flip
 * legs (→completed · AS backdate · →canceled) — the "flip-dance". Every leg is
 * an ordinary cataloged op; this module sequences them, discloses the sequence
 * (result + dry-run), and groups them under one undoable txn summary.
 *
 * `add --completed-at/--created-at` is single-leg (json import) and needs NO
 * orchestrator — it folds into `todo.add` / `project.add` directly.
 */
import type { AuditRecord } from "../audit/schema.ts";
import type { IsoDate } from "../model/dates.ts";
import { resolveProjectWriteTarget, resolveTaskUuidPrefix } from "../read/queries.ts";
import { resolutionDeltaDate } from "./commands.ts";
import type { OperationKind } from "./operations.ts";
import { loadTarget, projectChildren } from "./pre-state.ts";
import {
  fingerprintLabel,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import type { DeltaSpec } from "./verify/delta.ts";

export type ResolutionKind = "todo" | "project";
export type CompleteChildren = "require-resolved" | "auto-complete";
export type CancelChildren = "require-resolved" | "auto-cancel";

/** One leg of a composite: an ordinary cataloged op pinned to its vector. */
interface Leg {
  op: OperationKind;
  params: Record<string, unknown>;
  vector: "url-scheme" | "applescript";
  /** Human description for disclosure + dry-run leg plan. */
  describe: string;
}

/** Dispatch a cataloged op with dynamic (op-erased) params. */
function exec(
  deps: WriteDeps,
  op: OperationKind,
  params: Record<string, unknown>,
  options: WriteOptions,
): Promise<MutationResult> {
  return runMutation(deps, op, params as never, options);
}

function newTxnId(now: Date): string {
  return `txn-${now.getTime().toString(36)}-${process.pid.toString(36)}`;
}

function legOptions(
  base: WriteOptions,
  txnId: string,
  vector: "url-scheme" | "applescript",
): WriteOptions {
  const out: WriteOptions = { txn: { id: txnId, role: "leg" }, vector };
  if (base.actor !== undefined) out.actor = base.actor;
  if (base.verifyTimeoutMs !== undefined) out.verifyTimeoutMs = base.verifyTimeoutMs;
  if (base.maxDisruption !== undefined) out.maxDisruption = base.maxDisruption;
  if (base.zone !== undefined) out.zone = base.zone;
  return out;
}

function blocked(op: OperationKind, detail: string, remediation: string): MutationResult {
  return { kind: "blocked", op, reason: "hazard", hazard: "H-BACKDATE-OPEN", detail, remediation };
}

function resolveTarget(deps: WriteDeps, kind: ResolutionKind, ref: string): string {
  return kind === "project"
    ? resolveProjectWriteTarget(deps.db, ref)
    : resolveTaskUuidPrefix(deps.db, ref, "to-do");
}

function statusOf(deps: WriteDeps, uuid: string): "open" | "completed" | "canceled" | null {
  const t = loadTarget(deps.db, uuid);
  return t !== null && t.type !== "heading" ? t.status : null;
}

/** A dry-run MutationResult that discloses the whole leg sequence. */
function dryRunComposite(
  summaryOp: OperationKind,
  uuid: string,
  legs: Leg[],
  delta: DeltaSpec,
): MutationResult {
  return {
    kind: "dry-run",
    op: summaryOp,
    plan: {
      op: summaryOp,
      vector: legs.some((l) => l.vector === "applescript") ? "applescript" : "url-scheme",
      tier: 0,
      invocation:
        `${legs.length}-leg sequence (not atomic): ` +
        legs.map((l, i) => `${i + 1}. ${l.describe}`).join(" → "),
      expectedDelta: delta,
      hazardsChecked: ["H-BACKDATE-OPEN", "H-UNKNOWN-DESTINATION"],
    },
  };
}

function appendSummary(
  deps: WriteDeps,
  args: { startedAt: Date; op: OperationKind; uuid: string; txnId: string; invocation: string },
): string {
  const fp = deps.fingerprint();
  const record: AuditRecord = {
    v: 1,
    ts: args.startedAt.toISOString(),
    actor: deps.config.actor,
    host: deps.config.host,
    op: args.op,
    uuid: args.uuid,
    vector: "applescript",
    disruption: 0,
    invocation: args.invocation,
    requested: {},
    txn: { id: args.txnId, role: "summary" },
    pre: null,
    observed: { uuid: args.uuid },
    result: "ok",
    verify: null,
    durationMs: (deps.now?.() ?? new Date()).getTime() - args.startedAt.getTime(),
    env: {
      pkg: deps.pkgVersion ?? "0.0.1",
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fingerprintLabel(fp, deps.config),
    },
  };
  deps.audit.append(record);
  return args.txnId;
}

/**
 * Execute a leg sequence: each leg one at a time (the mutation lock + verify
 * must never race), stopping on the first non-ok result and reporting the exact
 * recovery state. On success, append a txn SUMMARY and return an ok result whose
 * undoToken targets the summary (replayed leg-by-leg in reverse).
 */
async function runComposite(
  deps: WriteDeps,
  summaryOp: OperationKind,
  uuid: string,
  legs: Leg[],
  finalDelta: DeltaSpec,
  options: WriteOptions,
): Promise<MutationResult> {
  if (options.dryRun === true) return dryRunComposite(summaryOp, uuid, legs, finalDelta);

  const startedAt = deps.now?.() ?? new Date();
  const txnId = newTxnId(startedAt);
  const disclosure = legs.map((l, i) => `${i + 1}. ${l.describe}`).join(" → ");
  let last: MutationResult | null = null;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i] as Leg;
    const result = await exec(deps, leg.op, leg.params, legOptions(options, txnId, leg.vector));
    last = result;
    if (result.kind !== "ok") {
      const done = legs.slice(0, i).map((l) => l.describe);
      const recovery =
        done.length === 0
          ? "nothing was applied — the item is unchanged"
          : `applied so far: ${done.join("; ")} — leg ${i + 1} (${leg.describe}) failed; the item is left mid-sequence`;
      return {
        kind: "verify-failed",
        op: summaryOp,
        reason: result.kind === "verify-failed" ? result.reason : "mismatch",
        expected: finalDelta,
        observed: result.kind === "verify-failed" ? result.observed : null,
        detail: `${result.kind === "blocked" ? result.detail : "a leg did not verify"} — ${recovery}`,
      };
    }
  }
  appendSummary(deps, {
    startedAt,
    op: summaryOp,
    uuid,
    txnId,
    invocation: `${summaryOp} (${legs.length}-leg): ${disclosure}`,
  });
  const ok = last as Extract<MutationResult, { kind: "ok" }>;
  return {
    ...ok,
    op: summaryOp,
    uuid,
    undoToken: txnId,
    warnings: [...(ok.warnings ?? []), `applied as ${legs.length} non-atomic legs: ${disclosure}`],
  };
}

// ------------------------------------------------------------------ helpers

function completeOp(kind: ResolutionKind): OperationKind {
  return kind === "project" ? "project.complete" : "todo.complete";
}
function cancelOp(kind: ResolutionKind): OperationKind {
  return kind === "project" ? "project.cancel" : "todo.cancel";
}
function setDatesOp(kind: ResolutionKind): OperationKind {
  return kind === "project" ? "project.set-dates" : "todo.set-dates";
}

/** The children param a project complete/cancel leg needs; empty for to-dos. */
function childrenParam(
  kind: ResolutionKind,
  children: CompleteChildren | CancelChildren,
): Record<string, unknown> {
  return kind === "project" ? { children } : {};
}

function completeLeg(kind: ResolutionKind, uuid: string, children: CompleteChildren): Leg {
  return {
    op: completeOp(kind),
    params: { uuid, ...childrenParam(kind, children) },
    vector: "url-scheme",
    describe: `flip → completed (stopDate preserved)`,
  };
}
function cancelLeg(kind: ResolutionKind, uuid: string, children: CancelChildren): Leg {
  return {
    op: cancelOp(kind),
    params: { uuid, ...childrenParam(kind, children) },
    vector: "url-scheme",
    describe: `flip → canceled (stopDate preserved)`,
  };
}
function setDatesLeg(
  kind: ResolutionKind,
  uuid: string,
  dates: { completionDate?: string; creationDate?: string },
): Leg {
  const parts = [
    ...(dates.completionDate !== undefined ? [`completion=${dates.completionDate}`] : []),
    ...(dates.creationDate !== undefined ? [`creation=${dates.creationDate}`] : []),
  ];
  return {
    op: setDatesOp(kind),
    params: { uuid, ...dates },
    vector: "applescript",
    describe: `AS set ${parts.join(" + ")} (completed row)`,
  };
}

/** Refuse a project whose through-completed transit would strand open children. */
function projectOpenChildrenBlock(
  deps: WriteDeps,
  kind: ResolutionKind,
  uuid: string,
  op: OperationKind,
): MutationResult | null {
  if (kind !== "project") return null;
  const open = projectChildren(deps.db, uuid).filter((c) => c.status === "open");
  if (open.length === 0) return null;
  return blocked(
    op,
    `backdating this project requires flipping it through completed, which would complete its ${open.length} ` +
      "open child to-do(s) — a canceled/backdated project cannot leave them open",
    "resolve or cancel the open children first (e.g. `project cancel --children auto-cancel` without a timestamp), then backdate",
  );
}

function stopDelta(uuid: string, status: string, stoppedDate: IsoDate): DeltaSpec {
  return {
    mode: "state",
    uuid,
    assert: [
      { field: "status", equals: status },
      { field: "stoppedDate", equals: stoppedDate },
    ],
  };
}

// ------------------------------------------------------------------ entries

/**
 * `complete [--completed-at]` for both kinds (plan §2). No timestamp → a single
 * plain `complete` (unchanged). With a timestamp → reach completed (if not
 * already), then AS-backdate the completed row.
 */
export async function runCompleteWithDate(
  deps: WriteDeps,
  kind: ResolutionKind,
  ref: string,
  args: { completedAt?: string; children?: CompleteChildren },
  options: WriteOptions = {},
): Promise<MutationResult> {
  const children: CompleteChildren = args.children ?? "require-resolved";
  if (args.completedAt === undefined) {
    return exec(deps, completeOp(kind), { uuid: ref, ...childrenParam(kind, children) }, options);
  }
  const uuid = resolveTarget(deps, kind, ref);
  const status = statusOf(deps, uuid);
  const legs: Leg[] = [];
  if (status !== "completed") legs.push(completeLeg(kind, uuid, children));
  legs.push(setDatesLeg(kind, uuid, { completionDate: args.completedAt }));
  const delta = stopDelta(uuid, "completed", resolutionDeltaDate(args.completedAt, options.zone));
  return runComposite(deps, completeOp(kind), uuid, legs, delta, options);
}

/**
 * `cancel [--completed-at]` for both kinds (plan §2). No timestamp → a single
 * plain `cancel`. With a timestamp → end canceled with the backdated stopDate:
 * reach completed (unless already), AS-backdate, then flip back to canceled (the
 * flip-dance). Refuses a project whose transit would strand open children.
 */
export async function runCancelWithDate(
  deps: WriteDeps,
  kind: ResolutionKind,
  ref: string,
  args: { completedAt?: string; children?: CancelChildren },
  options: WriteOptions = {},
): Promise<MutationResult> {
  const children: CancelChildren = args.children ?? "require-resolved";
  if (args.completedAt === undefined) {
    return exec(deps, cancelOp(kind), { uuid: ref, ...childrenParam(kind, children) }, options);
  }
  const uuid = resolveTarget(deps, kind, ref);
  const status = statusOf(deps, uuid);
  const legs: Leg[] = [];
  if (status !== "completed") {
    // Cancel the OPEN children as the user asked BEFORE the completed transit —
    // otherwise refuse rather than silently completing them.
    if (status === "open") {
      const stranded = projectOpenChildrenBlock(deps, kind, uuid, cancelOp(kind));
      if (stranded !== null) return stranded;
    }
    legs.push(completeLeg(kind, uuid, "require-resolved"));
  }
  legs.push(setDatesLeg(kind, uuid, { completionDate: args.completedAt }));
  legs.push(cancelLeg(kind, uuid, "require-resolved"));
  const delta = stopDelta(uuid, "canceled", resolutionDeltaDate(args.completedAt, options.zone));
  return runComposite(deps, cancelOp(kind), uuid, legs, delta, options);
}

/**
 * `update --created-at/--completed-at` for both kinds (plan §2/§3). `--created-at`
 * is a status-safe single AS leg. `--completed-at` edits the timestamp of an
 * ALREADY-resolved item: on a completed item a single AS leg; on a canceled item
 * the 3-leg flip-dance preserving canceled; on an OPEN item it is REFUSED (the
 * open↔resolved boundary belongs to `complete`/`cancel`, not `update`).
 */
export async function runUpdateDates(
  deps: WriteDeps,
  kind: ResolutionKind,
  ref: string,
  args: { createdAt?: string; completedAt?: string },
  options: WriteOptions = {},
): Promise<MutationResult> {
  const op = kind === "project" ? "project.update" : "todo.update";
  const uuid = resolveTarget(deps, kind, ref);
  const status = statusOf(deps, uuid);

  if (args.completedAt === undefined) {
    // created-at only: status-safe single set-dates leg (own undo).
    return exec(deps, setDatesOp(kind), { uuid, creationDate: args.createdAt }, options);
  }

  if (status === "open") {
    return {
      kind: "blocked",
      op,
      reason: "hazard",
      hazard: "H-BACKDATE-OPEN",
      detail:
        "update edits an already-resolved item's completion timestamp — it never crosses the " +
        "open↔resolved boundary (the item here is open)",
      remediation:
        "use `complete --completed-at` to resolve-and-backdate it completed, or `cancel --completed-at` " +
        "to resolve-and-backdate it canceled",
    };
  }

  const dates = {
    completionDate: args.completedAt,
    ...(args.createdAt !== undefined && { creationDate: args.createdAt }),
  };

  if (status === "completed") {
    // Single AS leg: set both timestamps in place (own undo). Not composite.
    return exec(deps, setDatesOp(kind), { uuid, ...dates }, options);
  }

  // canceled: the 3-leg flip-dance, creation date riding the middle leg.
  const stranded = projectOpenChildrenBlock(deps, kind, uuid, op);
  if (stranded !== null) return stranded;
  const legs: Leg[] = [
    completeLeg(kind, uuid, "require-resolved"),
    setDatesLeg(kind, uuid, dates),
    cancelLeg(kind, uuid, "require-resolved"),
  ];
  const delta = stopDelta(uuid, "canceled", resolutionDeltaDate(args.completedAt, options.zone));
  return runComposite(deps, op, uuid, legs, delta, options);
}
