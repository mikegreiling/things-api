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
import type { IsoDate } from "../model/dates.ts";
import { resolveProjectWriteTarget, resolveTaskUuidPrefix } from "../read/queries.ts";
import { taskMembershipClause } from "../read/scope.ts";
import { resolutionDeltaDate } from "./commands.ts";
import { disclose, disclosuresOf, tiers } from "./disclosures.ts";
import type { OperationKind } from "./operations.ts";
import { isRepeatingTemplate, loadTarget, projectChildren } from "./pre-state.ts";
import { replayIfApplied } from "./opid.ts";
import {
  appendCompositeSummary,
  runComposite as runLockedComposite,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import { restoreModDates, type PreserveModifiedFailure } from "./preserve-modified.ts";
import { runTemplateStatusWrite } from "./template-mutation.ts";
import { createDbReader, type DeltaSpec } from "./verify/delta.ts";

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

/**
 * Execute a leg sequence: each leg one at a time (the mutation lock + verify
 * must never race), stopping on the first non-ok result and reporting the exact
 * recovery state. On success, append a txn SUMMARY and return an ok result whose
 * undoToken targets the summary (replayed leg-by-leg in reverse). A leg that
 * TIMED OUT writes the summary too, in its ambiguous shape — see below.
 *
 * NESTED case: when the caller has already grouped this call into a transaction
 * (`--completed-at` aimed at a REPEATING to-do — the template composite runs the
 * flip-dance as its status leg), this sequence JOINS that transaction instead of
 * opening one of its own. Its legs carry the outer txn id and it writes no
 * second summary, so the outer summary stays the single undoable unit and its
 * leg lookup finds every flip. Two nested summaries would leave the outer one
 * looking leg-less — i.e. not undoable — which is precisely the state the outer
 * result promises against.
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
  const inheritedTxn = options.txn?.role === "leg" ? options.txn.id : null;
  const txnId = inheritedTxn ?? newTxnId(startedAt);

  // COMPOSITE LOCK (#639). The flip-dance used to serialize only leg by leg, so
  // another writer could land between the complete and the cancel — and, worse,
  // the key's lookback had no acquisition point to be re-checked at, which is
  // what let a same-key retry wait out the legs and then run the whole dance
  // again. One lock across the sequence gives both: leg acquisitions inside are
  // reentrant no-ops, and the keyed gate double-checks under it. A NESTED run
  // (this dance as the template composite's status leg) is already inside the
  // outer hold and carries no key, so it passes straight through.
  //
  // The in-flight marker carries this composite's OWN final assertion as its
  // oracle — a uuid-keyed state check on the one item every leg touches, so a
  // holder that dies mid-dance leaves a retry able to settle the question either
  // way, exactly as the ambiguous summary does for a timeout.
  return runLockedComposite(deps, summaryOp, () => danceBody(), {
    options,
    startedAt,
    txnId,
    uuid,
    requested: { uuid },
    expected: finalDelta,
  });

  async function danceBody(): Promise<MutationResult> {
    // --preserve-modified: capture the target's umd BEFORE the first leg (each flip
    // bumps it) and restore ONCE after the last (never per-leg — the leg options
    // strip the flag). Single-target by construction (the resolution-timestamp
    // compounds operate on one to-do/project).
    const preUmd =
      options.preserveModified === true
        ? createDbReader(deps.db, deps.now?.() ?? new Date(), deps.zone).modDateOf(uuid)
        : null;

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
        const reason = result.kind === "verify-failed" ? result.reason : "mismatch";
        // A TIMED-OUT leg leaves the sequence ambiguous — the flip may or may not
        // have landed — so a KEYED call records the AMBIGUOUS summary in the same
        // shape the promote compounds use: result `verify-failed:timeout` carrying
        // the assertion a resubmission re-evaluates. Without it a retry on the same
        // key would find no record and walk the whole dance again. The oracle is
        // this composite's OWN final assertion (`finalDelta`) — a uuid-keyed state
        // check on the one item every leg touches, so it settles the question
        // either way; and re-running is safe when it says the change is absent,
        // because the dance creates nothing. NESTED runs write no summary at all
        // (the outer composite owns the record) and carry no key to record.
        if (inheritedTxn === null && reason === "timeout") {
          appendCompositeSummary(deps, {
            startedAt,
            op: summaryOp,
            uuid,
            txnId,
            invocation: `${summaryOp} (${legs.length}-leg): ${disclosure} — unconfirmed`,
            options,
            ambiguous: finalDelta,
          });
        }
        return {
          kind: "verify-failed",
          op: summaryOp,
          reason,
          expected: finalDelta,
          observed: result.kind === "verify-failed" ? result.observed : null,
          detail: `${result.kind === "blocked" ? result.detail : "a leg did not verify"} — ${recovery}`,
        };
      }
    }
    if (inheritedTxn === null) {
      appendCompositeSummary(deps, {
        startedAt,
        op: summaryOp,
        uuid,
        txnId,
        invocation: `${summaryOp} (${legs.length}-leg): ${disclosure}`,
        // The summary is the ONE record this composite's idempotency key belongs
        // on (the legs run with the key stripped), so a resubmission matches the
        // whole sequence rather than one flip of it.
        options,
      });
    }
    const ok = last as Extract<MutationResult, { kind: "ok" }>;

    // Restore the captured umd once, after the last leg (best-effort, per row).
    let preserve: { restored: number; failures: PreserveModifiedFailure[] } | null = null;
    if (options.preserveModified === true && preUmd !== null) {
      const post = createDbReader(deps.db, deps.now?.() ?? new Date(), deps.zone).modDateOf(uuid);
      const targets = post !== null && post > preUmd ? [{ uuid, preUmd }] : [];
      preserve = await restoreModDates(deps.db, deps.vectors, targets);
    }

    const bag = disclosuresOf(ok);
    disclose(
      bag,
      "resolution-non-atomic-legs",
      `applied as ${legs.length} non-atomic legs: ${disclosure}`,
    );
    return {
      ...ok,
      op: summaryOp,
      uuid,
      undoToken: txnId,
      ...(preserve !== null &&
        (preserve.restored > 0 || preserve.failures.length > 0) && {
          preservedModified: preserve.restored,
        }),
      ...(preserve !== null &&
        preserve.failures.length > 0 && { preserveFailures: preserve.failures }),
      ...tiers(bag),
    };
  }
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
  dates: { completedAt?: string; createdAt?: string },
): Leg {
  const parts = [
    ...(dates.completedAt !== undefined ? [`completion=${dates.completedAt}`] : []),
    ...(dates.createdAt !== undefined ? [`creation=${dates.createdAt}`] : []),
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

/**
 * A status write aimed at a repeating TO-DO resolves the series' CURRENT
 * occurrence, not the series (ruling 2026-08-24, docs/lab/cnc1-template-mutations.md).
 * Unflagged: "check off this repeating to-do" has one sane reading, and the
 * composite resolves the open materialized occurrence when there is one and
 * materializes the pending one when there is not. Returns null when the target
 * is not a repeating to-do template, leaving the ordinary path untouched.
 *
 * The status LEG re-enters this module with the occurrence's uuid — an ordinary
 * row, so it takes the same `--completed-at` / `--children` vocabulary and never
 * routes again.
 */
async function routeRepeatingSeries(
  deps: WriteDeps,
  kind: ResolutionKind,
  op: "todo.complete" | "todo.cancel",
  ref: string,
  leg: (occurrenceUuid: string, occurrenceOptions: WriteOptions) => Promise<MutationResult>,
  options: WriteOptions,
): Promise<MutationResult | null> {
  if (kind !== "todo") return null;
  let uuid: string;
  try {
    // SCOPE-AWARE, like the pipeline's own target resolution: under a container
    // scope an out-of-scope uuid must resolve to "not found" through the SAME
    // path a nonexistent one does, so routing cannot become an oracle for rows
    // the caller is not allowed to see.
    const scope = deps.scope;
    uuid = resolveTaskUuidPrefix(
      deps.db,
      ref,
      "to-do",
      scope !== undefined ? taskMembershipClause(scope) : undefined,
    );
  } catch {
    return null; // an unresolvable ref is the ordinary path's error to report
  }
  if (!isRepeatingTemplate(loadTarget(deps.db, uuid))) return null;
  return runTemplateStatusWrite(deps, op, uuid, leg, options);
}

// ------------------------------------------------------------------ entries

/**
 * `complete [--completed-at]` for both kinds (plan §2). No timestamp → a single
 * plain `complete` (unchanged). With a timestamp → reach completed (if not
 * already), then AS-backdate the completed row.
 *
 * This is a CONSUMER entry point that never reaches the client's single-op
 * `run`, so the `opId` lookback runs here — for all three shapes it dispatches
 * (the plain write, the backdating flip-dance, and the repeating-series
 * composite). It matters most for the last: every re-run of a status write aimed
 * at a series is a NEW action that materializes the next occurrence, so a retry
 * without a key mints a duplicate. The leg re-enters this function with the
 * occurrence's uuid and the key stripped, so it never checks twice.
 */
export async function runCompleteWithDate(
  deps: WriteDeps,
  kind: ResolutionKind,
  ref: string,
  args: { completedAt?: string; children?: CompleteChildren },
  options: WriteOptions = {},
): Promise<MutationResult> {
  const replay = replayIfApplied(deps, options);
  if (replay !== null) return replay;
  const children: CompleteChildren = args.children ?? "require-resolved";
  const routed = await routeRepeatingSeries(
    deps,
    kind,
    "todo.complete",
    ref,
    (occurrenceUuid, occurrenceOptions) =>
      runCompleteWithDate(deps, kind, occurrenceUuid, args, occurrenceOptions),
    options,
  );
  if (routed !== null) return routed;
  if (args.completedAt === undefined) {
    return exec(deps, completeOp(kind), { uuid: ref, ...childrenParam(kind, children) }, options);
  }
  const uuid = resolveTarget(deps, kind, ref);
  const status = statusOf(deps, uuid);
  const legs: Leg[] = [];
  if (status !== "completed") legs.push(completeLeg(kind, uuid, children));
  legs.push(setDatesLeg(kind, uuid, { completedAt: args.completedAt }));
  const delta = stopDelta(uuid, "completed", resolutionDeltaDate(args.completedAt, options.zone));
  return runComposite(deps, completeOp(kind), uuid, legs, delta, options);
}

/**
 * `cancel [--completed-at]` for both kinds (plan §2). No timestamp → a single
 * plain `cancel`. With a timestamp → end canceled with the backdated stopDate:
 * reach completed (unless already), AS-backdate, then flip back to canceled (the
 * flip-dance). Refuses a project whose transit would strand open children.
 *
 * Carries the same entry-point `opId` lookback as `runCompleteWithDate`, for the
 * same reason (a cancel aimed at a series mints too).
 */
export async function runCancelWithDate(
  deps: WriteDeps,
  kind: ResolutionKind,
  ref: string,
  args: { completedAt?: string; children?: CancelChildren },
  options: WriteOptions = {},
): Promise<MutationResult> {
  const replay = replayIfApplied(deps, options);
  if (replay !== null) return replay;
  const children: CancelChildren = args.children ?? "require-resolved";
  const routed = await routeRepeatingSeries(
    deps,
    kind,
    "todo.cancel",
    ref,
    (occurrenceUuid, occurrenceOptions) =>
      runCancelWithDate(deps, kind, occurrenceUuid, args, occurrenceOptions),
    options,
  );
  if (routed !== null) return routed;
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
  legs.push(setDatesLeg(kind, uuid, { completedAt: args.completedAt }));
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
    return exec(deps, setDatesOp(kind), { uuid, createdAt: args.createdAt }, options);
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
    completedAt: args.completedAt,
    ...(args.createdAt !== undefined && { createdAt: args.createdAt }),
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
