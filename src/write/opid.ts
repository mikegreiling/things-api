/**
 * Shared client-idempotency (`opId`) machinery — the ONE place the lookback
 * window, the match rule and the ambiguous-outcome reconciliation live, so the
 * batch path and the single-op path agree by construction rather than by two
 * copies staying in sync.
 *
 * An `opId` is a caller-supplied idempotency key recorded on the audit record of
 * the mutation it accompanied. Before a mutation that carries one is dispatched,
 * the recent change history is scanned for a record bearing the SAME id; on a
 * hit the mutation is SKIPPED (reported already-applied) rather than re-run. The
 * id namespace is the whole trail — a batch leg and a single op that share an id
 * match each other — so resubmitting an ambiguously-failed write (as a batch
 * line OR a single `--op-id` invocation) is safe against a double.
 *
 * Two match classes:
 *
 *  - a VERIFIED-OK record — the earlier change is known to have landed, so the
 *    resubmission replays its identity and runs nothing;
 *  - a `verify-failed:timeout` record — the earlier attempt dispatched and never
 *    confirmed, so what landed is unknown. That record carries the assertion the
 *    attempt was verifying ({@link AuditRecord.expected}), and THAT assertion is
 *    the presence oracle: re-evaluated against current state it says the change
 *    is there (replay it, disclosing the reconciliation) or is absent (execute
 *    normally). When the recorded assertion cannot distinguish the two — the
 *    operation asserts a whole-database singleton, or nothing was recorded — the
 *    resubmission is REFUSED with a pointer at the item, never guessed.
 *
 * Every other FINAL result class (blocked, unsupported, the other verify-failed
 * reasons) is not a match: a blocked/unsupported attempt changed nothing, and a
 * mismatch/silent-noop landed something the caller must look at first.
 *
 * The third class is an UNSUPERSEDED INTENT — a keyed write that recorded its
 * start and has written no final record yet (#639). That is not a fourth match
 * rule but a different question, and it is answered by asking whether the
 * process that wrote it is still alive:
 *
 *  - HOLDER ALIVE — the original is still running. The resubmission is REFUSED
 *    (`blocked:in-flight`) and pointed at `things op-result <key>`. This is the
 *    refusal that closes the race the pre-lock lookback used to leave open: a
 *    retry fired while the original is mid-drive used to see no record, queue
 *    behind the mutation lock, and execute the whole verb a second time once the
 *    original released it.
 *  - HOLDER GONE — the writer died between touching the app and recording an
 *    outcome, which is the SAME ambiguity a `verify-failed:timeout` leaves, so it
 *    takes the same answer: the intent's own recorded assertion is the presence
 *    oracle, re-evaluated against current state. An intent that recorded no
 *    usable oracle refuses honestly rather than guessing.
 *
 * DOUBLE-CHECKED LOCKING. Every caller consults this gate TWICE: once before
 * taking the mutation lock (the cheap fast path — most resubmissions are settled
 * by then and never touch the lock) and again immediately after acquiring it,
 * before the first mutating leg. The second check is the load-bearing one: a
 * retry that passed the first check while the original was still running, then
 * waited out the lock, finds the original's record on the way back in and
 * replays instead of re-executing.
 */
import type { AuditRecord } from "../audit/schema.ts";
import { instanceAlive } from "../process-instance.ts";
import { attach, disclose, disclosuresOf } from "./disclosures.ts";
import type { OperationKind } from "./operations.ts";
import {
  replayResultFromRecord,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import { readAuditRecords } from "./undo.ts";
import { createDbReader, evaluateDelta, type DeltaSpec } from "./verify/delta.ts";

/** The idempotency-key charset/length, identical for a batch line and a single-op flag. */
export const OP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * opId idempotency lookback: at most the last {@link OPID_LOOKBACK_RECORDS}
 * records, AND only the last {@link OPID_LOOKBACK_MS} (whichever is more
 * restrictive).
 */
export const OPID_LOOKBACK_RECORDS = 1000;
export const OPID_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The disclosure a reconciled replay carries — see {@link reconcileAmbiguous}.
 * Deliberately worded for BOTH ambiguous origins (a confirmation that timed out,
 * and a writer that died before recording an outcome): the caller's situation
 * and next move are identical either way, and the record itself says which.
 */
export const RECONCILED_NOTE =
  "an earlier submission with this idempotency key never recorded a completed change; the change " +
  "was found already in place, so nothing ran again. It cannot be reversed with `things undo` — " +
  "there is no completed-change record to reverse";

/** Result classes an `opId` match acts on (see the module header). */
function matchable(result: AuditRecord["result"]): boolean {
  return result === "ok" || result === "verify-failed:timeout";
}

/**
 * The recent-history lookback for an opId: the most recent MATCHABLE record
 * carrying that id, within the last {@link OPID_LOOKBACK_RECORDS} records AND
 * the last {@link OPID_LOOKBACK_MS} (whichever is more restrictive). Undo/intent/
 * blocked records are naturally excluded.
 */
export function findOpIdRecord(
  records: AuditRecord[],
  opId: string,
  now: Date,
): AuditRecord | undefined {
  const cutoff = now.getTime() - OPID_LOOKBACK_MS;
  const window = records.slice(-OPID_LOOKBACK_RECORDS);
  let match: AuditRecord | undefined;
  for (const r of window) {
    if (r.opId !== opId || !matchable(r.result)) continue;
    if (new Date(r.ts).getTime() < cutoff) continue;
    match = r; // records are oldest-first, so the last match is the newest
  }
  return match;
}

/**
 * The UNSUPERSEDED intent for a key, if there is one: an `intent` record whose
 * ATTEMPT never recorded an outcome.
 *
 * Supersession pairs an intent to its own final by `ts`, which is the schema's
 * documented sibling invariant — both records of one attempt derive from the
 * same `startedAt`, so they carry the same timestamp (`audit/schema.ts`). It is
 * deliberately NOT "the last record wins": `readAuditRecords` RE-SORTS the trail
 * by `ts`, so file order does not survive the read, and a composite's intent
 * (written when it takes the lock) briefly carried a later `ts` than its own
 * summary (stamped when the verb began) — which sorted the intent last and left
 * every finished promote looking permanently in flight. Measured in TORPH1
 * cell B; the fix is this pairing plus stamping a composite's intent with the
 * verb's own `startedAt`.
 *
 * Pairing also handles the RE-DISPATCH shape by construction: a key retried
 * after an ambiguous failure records intent+final for the first attempt and a
 * fresh intent for the second, and only the second is unpaired.
 */
export function findPendingIntent(
  records: AuditRecord[],
  opId: string,
  now: Date,
): AuditRecord | undefined {
  const cutoff = now.getTime() - OPID_LOOKBACK_MS;
  const window = records.slice(-OPID_LOOKBACK_RECORDS);
  const inWindow = (r: AuditRecord): boolean =>
    r.opId === opId && new Date(r.ts).getTime() >= cutoff;
  const settled = new Set<string>();
  for (const r of window) {
    if (inWindow(r) && r.result !== "intent") settled.add(r.ts); // that attempt finished
  }
  // The newest unpaired intent (there is at most one in practice).
  return window.findLast((r) => inWindow(r) && r.result === "intent" && !settled.has(r.ts));
}

/**
 * Can the recorded assertion decide, after the fact, whether the timed-out
 * change landed? Usable means the assertion is keyed to a SUBJECT the attempt
 * itself identified — a target row, or a creation probe naming the row it was
 * making. Unusable means the assertion is either vacuous (nothing to check) or a
 * whole-database singleton that names none of the items the call was about, so a
 * satisfied assertion now says nothing about THIS call. `why` completes the
 * sentence "… and <why>" in the refusal.
 */
export type PresenceOracle = { usable: true } | { usable: false; why: string };

export function presenceOracle(spec: DeltaSpec | undefined): PresenceOracle {
  if (spec === undefined) {
    return {
      usable: false,
      why: "that attempt did not record what it was waiting to see",
    };
  }
  switch (spec.mode) {
    case "update":
    case "state": {
      const cascade = spec.mode === "state" ? (spec.cascade?.length ?? 0) : 0;
      return spec.assert.length + cascade > 0
        ? { usable: true }
        : { usable: false, why: "it named no field whose value would show the change" };
    }
    case "entity-updated":
      return spec.assert.length > 0
        ? { usable: true }
        : { usable: false, why: "it named no field whose value would show the change" };
    case "create":
      // An unbounded probe (sinceEpoch 0) matches any same-titled item ever
      // created, so an older namesake would be read as this call's own work.
      return spec.probe.sinceEpoch > 0
        ? { usable: true }
        : {
            usable: false,
            why:
              "its record of the new item is not bounded in time, so an older item of the same " +
              "name would be mistaken for it",
          };
    case "entity-created":
    case "gone":
      return { usable: true };
    case "ordering":
      return spec.sequence.length > 1
        ? { usable: true }
        : { usable: false, why: "a single item's order reads the same before and after" };
    case "trash-emptied":
      return {
        usable: false,
        why:
          "emptying the Trash records none of the items it destroyed, so an empty Trash now " +
          "says nothing about whether this call is what emptied it",
      };
    case "logged-now":
      return {
        usable: false,
        why:
          "moving finished items to the Logbook records none of the items it moved, and Things " +
          "moves them on its own as well",
      };
    default: {
      const exhaustive: never = spec;
      throw new Error(`unknown delta mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The refusal: the key matched an unconfirmed attempt nothing here can settle. */
function unreconcilable(record: AuditRecord, why: string): MutationResult {
  const target = record.uuid === null ? "the item" : record.uuid;
  // An intent's writer DIED; a timeout's writer finished and could not confirm.
  // Both leave the same ambiguity, and the caller acts on it the same way, but
  // saying which one happened is what makes the trace worth looking at.
  const how =
    record.result === "intent"
      ? `started a change and its process ended without recording an outcome`
      : `never confirmed its change`;
  return {
    kind: "blocked",
    op: record.op as OperationKind,
    reason: "reconcile",
    detail:
      `an earlier submission with this idempotency key (${record.ts}) ${how}, and ${why} — so ` +
      "whether that change took effect cannot be settled from here",
    remediation:
      `check ${target} in Things (\`things op-result ${record.opId ?? "<key>"}\` reports what the ` +
      "earlier attempt recorded); once you know whether the change is there, leave it alone or " +
      "re-run with a NEW --op-id",
  };
}

/**
 * The refusal: this key is STILL RUNNING somewhere. Returned instead of letting
 * the resubmission queue behind the mutation lock, because waiting there is how
 * the double happened — the waiter wakes up after the original finishes and, on
 * the pre-lock answer it is still carrying, executes the verb again.
 *
 * Refusing costs the caller one poll. It is also the only answer that is true
 * for the whole class: nothing here can know whether the running original will
 * succeed, so nothing here should act on a guess about it.
 */
function stillInFlight(record: AuditRecord, holderPid: number): MutationResult {
  return {
    kind: "blocked",
    op: record.op as OperationKind,
    reason: "in-flight",
    detail:
      `an earlier submission with this idempotency key is STILL RUNNING (started ${record.ts}, ` +
      `pid ${holderPid}) — it has not recorded an outcome yet, so nothing was run again here`,
    remediation:
      `poll \`things op-result ${record.opId ?? "<key>"}\` until it reports a final outcome, then ` +
      "act on that; do not resubmit while it is running (a GUI-driven change takes seconds, and " +
      "longer on a large or syncing database)",
  };
}

/**
 * Reconcile a resubmission against an AMBIGUOUS original — one that touched the
 * app and never recorded whether the change landed. Two records reach here: a
 * `verify-failed:timeout` final (the attempt finished and could not confirm) and
 * an orphaned `intent` (the attempt's process died mid-flight, #639). The
 * ambiguity is identical, so the answer is: re-read current state through the
 * attempt's own recorded assertion and decide.
 *
 *  - satisfied  → the change is there: replay it as already-applied, disclosing
 *    the reconciliation. The replay carries NO undo token — the trail holds no
 *    completed-change record for undo to reverse — and takes its uuid from the
 *    re-read, which is how a create whose uuid was never discovered (recorded
 *    `uuid: null`) still answers with the row it made.
 *  - not satisfied → the change is absent: return null so the write runs.
 *  - no usable oracle → refuse (never a guess).
 */
function reconcileAmbiguous(deps: WriteDeps, record: AuditRecord): MutationResult | null {
  const oracle = presenceOracle(record.expected);
  if (!oracle.usable) return unreconcilable(record, oracle.why);
  const spec = record.expected as DeltaSpec;
  const evaluation = evaluateDelta(
    spec,
    createDbReader(deps.db, deps.now?.() ?? new Date(), deps.zone),
    // The movement classification needs the attempt's pre-read, which is long
    // gone; only `satisfied`/`observed` are consulted here, and neither uses it.
    { modDates: {}, fields: {} },
  );
  if (!evaluation.satisfied) return null;
  const replay = replayResultFromRecord(record);
  if (replay.kind !== "ok") return replay; // replayResultFromRecord always builds an ok
  const { undoToken: _noToken, ...rest } = replay;
  const bag = disclosuresOf(replay);
  disclose(bag, "reconciled-replay", RECONCILED_NOTE);
  return attach(
    {
      ...rest,
      uuid: evaluation.discoveredUuid ?? record.uuid,
      observed: evaluation.observed,
      ...(evaluation.repeating !== undefined && { repeating: evaluation.repeating }),
    },
    bag,
  );
}

/**
 * The lookback as a DISPATCH DECISION over an already-read trail: the replay
 * result when this key was already applied, a refusal when it is still running
 * or matched an unsettleable attempt, or null when the write must run. Shared by
 * the batch line path and {@link replayIfApplied}.
 *
 * An unsuperseded intent is consulted FIRST, because it describes the key's
 * present, while any matchable final describes its past. (Both can exist: a key
 * whose first attempt timed out and is now being re-driven has an old timeout
 * final AND a live intent. Acting on the final there would replay a change the
 * running attempt has not finished making.)
 */
export function resolveOpId(
  deps: WriteDeps,
  records: AuditRecord[],
  opId: string,
  now: Date,
): MutationResult | null {
  const pending = findPendingIntent(records, opId, now);
  if (pending !== undefined) {
    const holder = pending.holder;
    // No holder recorded (an M3 intent from before write-ahead intents, or a
    // path that writes one unkeyed): liveness is unknowable, and the safe
    // unknowable answer is the one that never doubles — treat it as running.
    if (holder === undefined || instanceAlive(holder)) {
      return stillInFlight(pending, holder?.pid ?? -1);
    }
    // The holder is gone and no outcome was ever recorded: same ambiguity as a
    // timeout, same oracle-driven answer.
    return reconcileAmbiguous(deps, pending);
  }
  const match = findOpIdRecord(records, opId, now);
  if (match === undefined) return null;
  return match.result === "ok" ? replayResultFromRecord(match) : reconcileAmbiguous(deps, match);
}

/**
 * The dispatch decision for a SINGLE invocation, reading the trail itself. The
 * ONE gate every single-invocation entry point calls before doing anything — the
 * client's single-op `run`, and the composites that own their own dispatch (the
 * complete/cancel/exception template-target verbs, the `--completed-at`
 * flip-dance, and the promote-via-clone verbs; they never reach `run`, so
 * without this the key would be recorded and never honored).
 *
 * Called TWICE per keyed write, and the second call is the one that matters —
 * see the module header on double-checked locking. Both calls re-read the trail:
 * the whole point of the post-acquire check is that the trail changed while this
 * process was waiting for the lock, so a cached read would answer the stale
 * question all over again.
 *
 * Three conditions fail-open (run the write) rather than fail-closed: no key, a
 * dry run (it mints and records nothing, so there is nothing to deduplicate
 * against), or no trail to read.
 */
export function replayIfApplied(deps: WriteDeps, options: WriteOptions): MutationResult | null {
  if (options.opId === undefined || options.dryRun === true) return null;
  if (deps.auditDirPath === undefined) return null;
  return resolveOpId(
    deps,
    readAuditRecords(deps.auditDirPath),
    options.opId,
    deps.now?.() ?? new Date(),
  );
}
