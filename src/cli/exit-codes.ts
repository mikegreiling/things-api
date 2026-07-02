/**
 * Stable exit-code contract for the `things` CLI.
 *
 * These values are part of the public API surface consumed by agents and
 * scripts. They must never be renumbered; add new codes at the end.
 * See docs/design/contracts.md.
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
