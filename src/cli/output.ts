/**
 * Versioned JSON envelope emitted by every CLI command under `--json`.
 *
 * Contract (see docs/design/contracts.md):
 * - Envelope JSON goes to stdout; all human/log chatter goes to stderr.
 * - `apiVersion` is bumped only on breaking envelope-shape changes.
 * - `data` is command-specific; `error` is present exactly when `ok` is false.
 */

export const API_VERSION = 1;

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
