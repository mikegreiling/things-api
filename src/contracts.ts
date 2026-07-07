/**
 * Machine-facing contracts shared by every surface over the library (CLI
 * --json envelopes, MCP tool results): the versioned envelope shape and the
 * stable exit-code family. Lives in the CORE so thin surfaces depend on the
 * library, never on each other (see docs/design/contracts.md).
 *
 * - Envelope JSON goes to stdout; all human/log chatter goes to stderr.
 * - `apiVersion` is bumped only on breaking envelope-shape changes.
 * - `data` is command-specific; `error` is present exactly when `ok` is false.
 */

export const API_VERSION = 1;

/**
 * Package version, surfaced by `things --version` and the MCP serverInfo.
 * Kept in lockstep with package.json by a contract test.
 */
export const PKG_VERSION = "0.3.0";

/**
 * Stable exit-code contract for the `things` CLI (mirrored by MCP error
 * codes). Part of the public API surface consumed by agents and scripts —
 * values must never be renumbered; add new codes at the end.
 */
export const ExitCode = {
  /** Success. */
  Ok: 0,
  /** Unexpected internal error (bug, unhandled condition). */
  Unexpected: 1,
  /** Usage error: unknown command, bad flags, invalid arguments. */
  Usage: 2,
  /** Mutation executed but read-after-write verification failed (timeout, mismatch, or silent no-op). */
  VerifyFailed: 3,
  /** Mutation refused before touching the app: hazard guard or disruption-tier policy. */
  Blocked: 4,
  /** Writes disabled because the database schema fingerprint deviates from the known baseline. */
  DriftBlocked: 5,
  /** Operation not supported by any available write vector. */
  Unsupported: 6,
  /** Environment problem: database not found, Things not installed, permissions. */
  Environment: 7,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface EnvelopeMeta {
  /** Things database schema version (`Meta.databaseVersion`), null when no DB was opened. */
  dbVersion: number | null;
  /** Schema fingerprint status at the time of the command. */
  fingerprint: "ok" | "drift" | "user-accepted" | "unknown";
  /** Wall-clock duration of the command in milliseconds. */
  elapsedMs: number;
}

export interface OkEnvelope<T> {
  apiVersion: typeof API_VERSION;
  ok: true;
  /** Discriminator naming the payload shape, e.g. "today", "mutation-result". */
  kind: string;
  data: T;
  meta: EnvelopeMeta;
}

export interface ErrorEnvelope {
  apiVersion: typeof API_VERSION;
  ok: false;
  kind: "error";
  error: {
    /** Stable machine-readable code, mirrors the exit-code family (e.g. "verify-failed", "blocked"). */
    code: string;
    message: string;
    /**
     * Advisory attribution when failure signals point somewhere: e.g.
     * "permission-denied", "permission-pending", "feature-disabled",
     * "app-updated", "schema-drift", "app-behavior-change".
     */
    likelyCause?: string;
    /** Actionable next step for the caller, when one exists. */
    remediation?: string;
    detail?: unknown;
  };
  meta: EnvelopeMeta;
}

export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

export function okEnvelope<T>(kind: string, data: T, meta: EnvelopeMeta): OkEnvelope<T> {
  return { apiVersion: API_VERSION, ok: true, kind, data, meta };
}

export function errorEnvelope(error: ErrorEnvelope["error"], meta: EnvelopeMeta): ErrorEnvelope {
  return { apiVersion: API_VERSION, ok: false, kind: "error", error, meta };
}
