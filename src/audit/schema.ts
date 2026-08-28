/**
 * Audit record v1 — one JSON object per line in
 * ~/.local/state/things-api/audit/YYYY-MM.jsonl (see design §5).
 *
 * Every mutation ATTEMPT is recorded: successes, verification failures, and
 * blocked decisions (with invocation null — the app was never touched).
 *
 * A successful mutation writes TWO records: an `intent` marker immediately
 * before the app is touched (M3 durability — so a crash between the app-side
 * mutation and the final record leaves evidence the change may have landed),
 * then the final `ok`/`verify-failed:*` record after read-after-write. The two
 * share ts+op+actor+host (both derive from the same startedAt); an intent with
 * no later final sibling is the signature of a crashed write. Intent records
 * are NEVER undo targets — every undo reader filters `result === "ok"`, which
 * an intent (result `"intent"`) is not, so it is excluded uniformly.
 *
 * WRITE-AHEAD INTENT (#639). An intent is not only crash evidence — for a
 * mutation carrying an `opId` it is the record that makes the key's state
 * READABLE while the write is still running. Such an intent is written under the
 * mutation lock, before the first mutating leg, and carries two extra fields:
 * {@link AuditRecord.holder} (the writing process's instance identity) and
 * {@link AuditRecord.expected} (the presence oracle). Together they let a later
 * reader distinguish the three states a key can be in — still running, holder
 * gone with the outcome unrecorded, or settled by a final record — instead of
 * collapsing the first two into one hedge. A COMPOSITE writes exactly ONE such
 * intent, at the SUMMARY layer: the key addresses the whole verb, so its
 * in-flight marker must too (its legs run with the key stripped and write only
 * their own ordinary M3 intents).
 */
import { createHash } from "node:crypto";

import type { ProcessInstance } from "../process-instance.ts";
import type { DeltaSpec, OccurrenceResolution } from "../write/verify/delta.ts";

export interface AuditRecord {
  v: 1;
  ts: string;
  actor: string;
  host: string;
  op: string;
  /** Target uuid; null until discovered for creates that verify by probe. */
  uuid: string | null;
  vector: string | null;
  disruption: number | null;
  /** Compiled invocation with the auth token structurally redacted. */
  invocation: string | null;
  /**
   * Compound-operation grouping: legs share the orchestrator's txn id and
   * are excluded from direct undo targeting; the summary record is the
   * single undoable unit for the whole sequence.
   */
  txn?: { id: string; role: "leg" | "summary" };
  /**
   * Undo back-reference (ADDITIVE): the undo token of the ORIGINAL mutation
   * this record inverts. Set only on inverse mutations (`undo:<actor>` records)
   * so a later `things undo --txn <token>` can tell an already-undone mutation
   * apart from a nonexistent one. Absent on ordinary (non-undo) mutations.
   */
  undoOf?: string;
  /**
   * Client idempotency id (ADDITIVE): a caller-supplied id for a batch line,
   * recorded so a resubmitted batch can recognize an already-applied line (a
   * later submission with the same `opId` on an `ok` record is skipped instead
   * of re-created). Absent on records with no client idempotency id.
   */
  opId?: string;
  /**
   * `--preserve-modified` capture (ADDITIVE): the pre-write `userModificationDate`
   * of each captured target row (uuid → epoch seconds, or null for a row the op
   * created), recorded on the `ok` record only when the flag was active. Cheap
   * provenance that enables a future SYMMETRIC undo (restore the umd the mutation
   * bumped) without a separate read. Absent on writes made without the flag.
   */
  preModDates?: Record<string, number | null>;
  /**
   * Template-target composite disclosure (ADDITIVE): which occurrence a
   * `complete`/`cancel`/`update --exception` aimed at a repeating series
   * actually wrote, and whether the composite minted it. Recorded on the
   * composite's SUMMARY record only — the one record its `opId` keys — so an
   * idempotency replay can hand the caller the same two uuids the original
   * call returned without re-reading the database.
   */
  occurrence?: OccurrenceResolution;
  /**
   * IN-FLIGHT HOLDER (ADDITIVE): the process that owns this work, recorded on a
   * keyed `intent` record so a later reader can tell "still running" from "died
   * without recording an outcome" (#639). A pid alone cannot answer that — pids
   * are recycled — so this is the pid PAIRED with its start time, the same
   * instance key the session grant uses; {@link instanceAlive} states the
   * (deliberately conservative) liveness rule. Absent on final records, where
   * the outcome itself is the answer, and on unkeyed M3 intents, which nothing
   * polls.
   */
  holder?: ProcessInstance;
  /**
   * AMBIGUOUS-OUTCOME reconciliation key (ADDITIVE): the expected-state
   * assertion this attempt was verifying. Recorded on the two record classes
   * where the change may or may not have landed: `verify-failed:timeout`
   * finals, and keyed `intent` markers (whose holder may die mid-flight and
   * leave exactly that ambiguity — #639). A resubmission carrying the same
   * `opId` re-evaluates THIS assertion against current state to decide whether
   * the change is there (replay it as already-applied) or absent (execute
   * normally), so the presence test is the attempt's OWN oracle rather than a
   * per-operation guess (`src/write/opid.ts`). Absent on every other record —
   * and an absent one is a refusal to guess, never an assumption either way. A
   * composite's summary intent is legitimately absent here when the verb's
   * timeout point knows no oracle that could settle the question; that
   * resubmission refuses rather than reconciling.
   */
  expected?: DeltaSpec;
  /**
   * The GUI drive's step play-by-play (ADDITIVE), one compact entry per recipe
   * step, in order — recorded on the FINAL record of every ui-vector write,
   * success and failure alike.
   *
   * This record is the APPEND-ONLY DEBUG LOG of the diagnostic ladder (#632).
   * The step list used to ride every successful result and cost a caller context
   * on writes that went fine; now the default success output omits it, a failure
   * carries it, `--verbose` opts a success back into it, and it is ALWAYS here —
   * so `things op-result <op-id>` can hand it back after the fact. Compact
   * labels only (the recipe's own step names); the per-invocation trace file
   * remains the deep tier with the raw payloads and timings.
   */
  steps?: string[];
  /** Normalized requested delta (params as given, post-normalization). */
  requested: Record<string, unknown>;
  /** Asserted-field subset of the pre-state (null when target didn't exist). */
  pre: Record<string, unknown> | null;
  /** Post-verify observation (best-effort on failure). */
  observed: Record<string, unknown> | null;
  result:
    | "intent"
    | "ok"
    | "verify-failed:timeout"
    | "verify-failed:mismatch"
    | "verify-failed:silent-noop"
    /** A GUI drive stopped because the Things window was unreachable/unresponsive (#512). */
    | "verify-failed:ui-unreachable"
    /**
     * The requested change landed, but a field the caller never named moved with it
     * and nothing in the operation's vocabulary attributes the movement (CGRD1).
     */
    | "verify-failed:collateral"
    | `blocked:${string}`
    | "unsupported";
  verify: { attempts: number; elapsedMs: number } | null;
  durationMs: number;
  env: {
    pkg: string;
    dbVersion: number | null;
    fingerprint: "ok" | "drift" | "user-accepted" | "unknown";
  };
}

/**
 * The stable UNDO TOKEN for a mutation — the value a caller passes to
 * `things undo --txn <token>` (MCP `txn`) to invert exactly THIS record,
 * immune to interleaving. Two cases:
 *
 *  - A compound operation's SUMMARY record already carries a real transaction
 *    id shared by its legs — that id IS the token (undoing it replays the
 *    whole sequence as one unit).
 *  - A single-op record has no such id, so we derive a content-addressed one
 *    from the fields that identify the record on disk (start timestamp + op +
 *    actor + host + target uuid). The mutation lock serializes writes, so those
 *    fields are unique per record in practice; the token is deterministic, so
 *    the write path (which returns it in the result) and the undo path (which
 *    recomputes it while scanning the trail) always agree.
 *
 * Purely additive: it is DERIVED from persisted fields, never stored.
 */
export function undoToken(
  record: Pick<AuditRecord, "ts" | "op" | "actor" | "host" | "uuid" | "txn">,
): string {
  if (record.txn?.role === "summary") return record.txn.id;
  // JSON-encode the identity tuple so field boundaries are unambiguous (no
  // separator an actor/host string could forge) while staying plain text.
  const identity = JSON.stringify([
    record.ts,
    record.op,
    record.actor,
    record.host,
    record.uuid ?? "",
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `m-${digest}`;
}
