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
 */
import { createHash } from "node:crypto";

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
