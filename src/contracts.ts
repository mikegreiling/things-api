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
export const PKG_VERSION = "0.9.0";

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

/**
 * List-view truncation metadata (ADDITIVE). Present on the meta of any read
 * command that applies a row limit; absent on unbounded/structured views.
 * `shown` items were returned of `total` that matched after all filters;
 * `limit` is the effective cap (null when the caller asked for all rows);
 * `truncated` is true exactly when `shown < total`. The dropped remainder is
 * `total - shown`.
 */
export interface Pagination {
  shown: number;
  total: number;
  limit: number | null;
  truncated: boolean;
}

/**
 * Per-block truncation for the grouped catalogues (anytime/someday) and the
 * sectioned detail views (`area show`). Every header/section is always
 * present; only the innermost item lists are capped. One entry per non-empty
 * block: the area-less loose block, an area's direct items, a project's
 * to-dos, or — in `area show` — the area's project-ROWS section ("projects").
 */
export interface BlockCount {
  kind: "loose" | "area" | "project" | "projects";
  /** Container uuid (area or project); null for the loose block. */
  uuid: string | null;
  /** Container title; null for the loose block. */
  title: string | null;
  shown: number;
  total: number;
  /** The cap that applied to THIS block (null = uncapped). */
  limit: number | null;
  /**
   * Type split for blocks that mix project rows and to-dos (someday's
   * loose/area blocks; projects always list first, so the hidden split is
   * `totalProjects - min(shown, totalProjects)` projects, remainder to-dos).
   * Absent on single-type blocks.
   */
  totalProjects?: number;
  totalTodos?: number;
}

/** Grouped-view truncation metadata (ADDITIVE); the per-block counterpart of {@link Pagination}. */
export interface GroupedPagination {
  /** True when any block hid items. */
  truncated: boolean;
  blocks: BlockCount[];
}

export interface EnvelopeMeta {
  /** Things database schema version (`Meta.databaseVersion`), null when no DB was opened. */
  dbVersion: number | null;
  /** Schema fingerprint status at the time of the command. */
  fingerprint: "ok" | "drift" | "user-accepted" | "unknown";
  /** Wall-clock duration of the command in milliseconds. */
  elapsedMs: number;
  /** List-view truncation metadata; present only on limited flat read views. */
  pagination?: Pagination;
  /** Per-block truncation metadata; present only on grouped views (anytime/someday). */
  grouped?: GroupedPagination;
  /**
   * The canonical `things …` command a sugar invocation normalized to (bare
   * noun, keyword-in-show, uuid/share-link routing). Present only on routed
   * reads reached via a sugar form; absent for canonical invocations.
   */
  resolvedCommand?: string;
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
    /**
     * Structured, machine-readable failure context (ADDITIVE). For an
     * unresolved show/bare-noun subject it carries `candidates` — the
     * did-you-mean title matches (standard item shapes, capped) so an agent
     * can self-correct without a second round-trip. For a bare mutation verb
     * (`things update <ref>`) it carries `suggestions` — the concrete
     * namespaced command(s) to run instead.
     */
    details?: { candidates?: unknown[]; suggestions?: string[] };
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

/**
 * Canonical machine-readable error CODE for a refused ("blocked") mutation: the
 * specific hazard id when one is named, else the block reason. Every surface —
 * the CLI `--json` envelope, the MCP tool error, and the audit trail — builds
 * the `blocked:*` string HERE so the format lives in exactly one place. The
 * input is a structural subset of the blocked mutation outcome (`hazard`,
 * `reason`), kept as plain strings so the core never depends on the write layer.
 */
export function blockedCode(outcome: { hazard?: string; reason: string }): `blocked:${string}` {
  return `blocked:${outcome.hazard ?? outcome.reason}`;
}

/**
 * Canonical error CODE for a mutation that executed but failed read-after-write
 * verification (`verify-failed:<reason>`). Companion to {@link blockedCode}; see
 * it for why this lives in the core and takes a plain-string shape.
 */
export function verifyFailedCode<R extends string>(outcome: { reason: R }): `verify-failed:${R}` {
  return `verify-failed:${outcome.reason}`;
}

/**
 * Aggregate exit code for a multi-op run (`things batch`): the single WORST
 * failure decides, by the documented precedence
 *
 *   drift-blocked > blocked > unsupported > verify-failed
 *
 * mirroring the per-outcome mapping the single-op path applies (drift→5,
 * blocked→4, unsupported→6, everything else that failed→3). `failures` is the
 * failed ops' outcomes: each carries its `kind`, plus the block `reason` so a
 * drift block can be told apart from a policy block. An empty list is success.
 */
export function aggregateExitCode(
  failures: readonly { kind: string; reason?: string }[],
): ExitCode {
  if (failures.length === 0) return ExitCode.Ok;
  const kinds = new Set(failures.map((f) => f.kind));
  if (failures.some((f) => f.kind === "blocked" && f.reason === "drift")) {
    return ExitCode.DriftBlocked;
  }
  if (kinds.has("blocked")) return ExitCode.Blocked;
  if (kinds.has("unsupported")) return ExitCode.Unsupported;
  return ExitCode.VerifyFailed;
}
