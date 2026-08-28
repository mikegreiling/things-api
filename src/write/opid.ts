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
 * Every other result class (blocked, unsupported, intent, the other
 * verify-failed reasons) is not a match: a blocked/unsupported attempt changed
 * nothing, a mismatch/silent-noop landed something the caller must look at
 * first, and an intent marker means the attempt may still be in flight.
 */
import type { AuditRecord } from "../audit/schema.ts";
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

/** The disclosure a reconciled replay carries — see {@link reconcileTimedOut}. */
export const RECONCILED_NOTE =
  "an earlier submission with this idempotency key did not finish confirming; the change was " +
  "found already in place, so nothing ran again. It cannot be reversed with `things undo` — the " +
  "earlier attempt never recorded a completed change to reverse";

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
  return {
    kind: "blocked",
    op: record.op as OperationKind,
    reason: "reconcile",
    detail:
      `an earlier submission with this idempotency key (${record.ts}) never confirmed its ` +
      `change, and ${why} — so whether that change took effect cannot be settled from here`,
    remediation:
      `check ${target} in Things (\`things op-result ${record.opId ?? "<key>"}\` reports what the ` +
      "earlier attempt recorded); once you know whether the change is there, leave it alone or " +
      "re-run with a NEW --op-id",
  };
}

/**
 * Reconcile a resubmission against a TIMED-OUT original: re-read current state
 * through the attempt's own recorded assertion and decide.
 *
 *  - satisfied  → the change is there: replay it as already-applied, disclosing
 *    that a timeout was reconciled. The replay carries NO undo token — the trail
 *    holds no completed-change record for undo to reverse — and takes its uuid
 *    from the re-read, which is how a create whose uuid was never discovered
 *    (recorded `uuid: null`) still answers with the row it made.
 *  - not satisfied → the change is absent: return null so the write runs.
 *  - no usable oracle → refuse (never a guess).
 */
function reconcileTimedOut(deps: WriteDeps, record: AuditRecord): MutationResult | null {
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
 * result when this key was already applied, a refusal when it matched an
 * unsettleable attempt, or null when the write must run. Shared by the batch
 * line path and {@link replayIfApplied}.
 */
export function resolveOpId(
  deps: WriteDeps,
  records: AuditRecord[],
  opId: string,
  now: Date,
): MutationResult | null {
  const match = findOpIdRecord(records, opId, now);
  if (match === undefined) return null;
  return match.result === "ok" ? replayResultFromRecord(match) : reconcileTimedOut(deps, match);
}

/**
 * The dispatch decision for a SINGLE invocation, reading the trail itself. The
 * ONE gate every single-invocation entry point calls before doing anything — the
 * client's single-op `run`, and the composites that own their own dispatch (the
 * complete/cancel/exception template-target verbs, the `--completed-at`
 * flip-dance, and the promote-via-clone verbs; they never reach `run`, so
 * without this the key would be recorded and never honored).
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
