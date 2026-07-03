/**
 * Audit record v1 — one JSON object per line in
 * ~/.local/state/things-api/audit/YYYY-MM.jsonl (see design §5).
 *
 * Every mutation ATTEMPT is recorded: successes, verification failures, and
 * blocked decisions (with invocation null — the app was never touched).
 */

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
  /** Normalized requested delta (params as given, post-normalization). */
  requested: Record<string, unknown>;
  /** Asserted-field subset of the pre-state (null when target didn't exist). */
  pre: Record<string, unknown> | null;
  /** Post-verify observation (best-effort on failure). */
  observed: Record<string, unknown> | null;
  result:
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
