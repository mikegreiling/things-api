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
export const PKG_VERSION = "0.11.0";

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
 * Per-section counts for a SPLIT flat view — currently only `today`'s
 * Today / This-Evening split. One entry per section IN RENDER ORDER, each
 * reporting the rows `shown` of the `total` that matched after all filters.
 * Lets a renderer keep a downstream section (This Evening) honest under a
 * single global cap without a pre-truncation copy of the view.
 */
export interface SectionCount {
  key: "today" | "evening";
  shown: number;
  total: number;
}

/**
 * The single truncation-metadata shape for every read (the `meta.truncation`
 * field). `shown` items were returned of `total` that matched after all
 * filters; `limit` is the effective cap (null when the caller asked for all
 * rows, and always null on a grouped view whose caps are per-block); `truncated`
 * is the UNIVERSAL completeness check — true exactly when anything was dropped
 * (`shown < total`, or any block hid rows). The dropped remainder is
 * `total - shown`.
 *
 * Two optional per-shape breakdowns hang off it: `sections` for a split flat
 * view (the Today split — per render-section shown/total), and `blocks` for a
 * grouped view (anytime/someday/`area show` — the identity-carrying per-block
 * nesting). Exactly one of them is present on the shapes that have it; both are
 * absent on a plain flat view.
 */
export interface Truncation {
  shown: number;
  total: number;
  limit: number | null;
  truncated: boolean;
  /** Per-section shown/total breakdown for a split flat view (Today); absent otherwise. */
  sections?: SectionCount[];
  /** Per-block nesting for a grouped view (anytime/someday/area card); absent otherwise. */
  blocks?: GroupBlock[];
}

/**
 * One identity-carrying block of a grouped catalogue (anytime/someday) or a
 * sectioned detail view (`area show`). Every header/section is always rendered;
 * only the innermost item lists are capped. Emitted for every block that has
 * rows to cap (`total > 0`) — including a block whose rows were ALL dropped
 * (`shown: 0`), so no truncated header is untraceable. A block with no
 * cappable rows of its own (`total: 0`) is omitted UNLESS it wraps truncated
 * `children` — an area whose only capped content is its project item-lists
 * still appears as their container.
 *
 * Blocks are NESTED: an area/loose block carries its project blocks in
 * `children` — in anytime the project item-lists inside the area, in someday
 * the active-project child groups found in that section. The `area show`
 * `projects`/`area` blocks are siblings of one area and stay top-level.
 */
export interface GroupBlock {
  kind: "loose" | "area" | "project" | "projects";
  /** Container reference (area or project uuid); null for the loose block. */
  ref: string | null;
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
  /** Nested project blocks (anytime item-lists / someday active-project groups). Absent when none. */
  children?: GroupBlock[];
}

export interface EnvelopeMeta {
  /** Things database schema version (`Meta.databaseVersion`), null when no DB was opened. */
  dbVersion: number | null;
  /** Schema fingerprint status at the time of the command. */
  fingerprint: "ok" | "drift" | "user-accepted" | "unknown";
  /** Wall-clock duration of the command in milliseconds. */
  elapsedMs: number;
  /**
   * The read's completeness metadata (the single truncation shape). Present on
   * any read that could drop rows — flat views (row `limit`), the Today split
   * (`sections`), and grouped views (anytime/someday/`area show`, `blocks`).
   * `meta.truncation.truncated` is the universal "did I see everything" check.
   */
  truncation?: Truncation;
  /**
   * The canonical `things …` command a sugar invocation normalized to (bare
   * noun, keyword-in-show, uuid/share-link routing). Present only on routed
   * reads reached via a sugar form; absent for canonical invocations.
   */
  resolvedCommand?: string;
  /**
   * Non-blocking advisories about this read (ADDITIVE). Present only when there
   * is something to flag — currently a one-line note when the Things database
   * schema no longer matches the version this build was validated against
   * (reads stay best-effort; run `things doctor`). Absent means none.
   */
  warnings?: string[];
  /**
   * The effective clock this response's date boundaries were computed for
   * (ADDITIVE honesty field). Present ONLY when a consumer zone (`THINGS_TZ` /
   * the MCP `tz` argument) or a pinned `THINGS_NOW` is in effect; ABSENT on the
   * host clock, so the wire shape is unchanged for ordinary consumers.
   */
  clock?: { timezone: string; today: string };
  /**
   * The active content filter this response was scoped to (ADDITIVE). Present
   * ONLY when a scope was applied — currently `area` (the `--area` view filter),
   * carrying the resolved area's uuid + title; ABSENT otherwise, so the wire
   * shape is unchanged for unscoped reads (the `meta.clock` precedent).
   */
  filter?: { area: { uuid: string; title: string } };
  /**
   * The active container scope this response was jailed to (ADDITIVE). Present
   * ONLY when a scope is in force (the MCP `--scope` flag / `THINGS_API_SCOPE` /
   * a stored `scope`), naming the container + where the scope came from; ABSENT
   * otherwise, so the wire shape is unchanged for unscoped reads. Lets an agent
   * know its own jail — which is not an oracle for what lies outside it (the
   * `meta.clock` / `meta.filter` additive precedent).
   */
  scope?: {
    kind: "area" | "project";
    uuid: string;
    title: string;
    source: "flag" | "env" | "config";
  };
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
    /**
     * The SINGLE structured, machine-readable failure-context object (there is
     * no separate `details` field — the two were reconciled into this one). Each
     * key is present only for the failures that produce it:
     *  - `expected` / `observed` — a verify-failed mutation's expected delta and
     *    the observed post-write state.
     *  - `candidates` — did-you-mean title matches for an unresolved
     *    show/bare-noun subject (standard item shapes, capped), so an agent can
     *    self-correct without another round-trip.
     *  - `suggestions` — for a bare mutation verb (`things update <ref>`), the
     *    concrete namespaced command(s) to run instead.
     *  - `considered` — the vectors weighed (and why each was rejected) for an
     *    unsupported operation.
     *  - `placed` / `remaining` / `cause` — a bounce reorder that aborted
     *    part-way: the items already placed, those not yet placed, and the cause.
     *  - `failed` / `completed` — a multi-leg move that failed mid-way: the leg
     *    that failed and the legs already completed before it.
     */
    detail?: {
      expected?: unknown;
      observed?: Record<string, unknown> | null;
      candidates?: unknown[];
      suggestions?: string[];
      considered?: { vector: string; why: string }[];
      placed?: string[];
      remaining?: string[];
      cause?: unknown;
      failed?: unknown;
      completed?: unknown[];
    };
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
 * Project a successful mutation/reorder/move outcome to its ENVELOPE `data`
 * shape. The wire's mutation-success discriminator is REDUNDANT and is not
 * emitted: the envelope already carries call success (`ok: true`, and the
 * envelope `kind` names the payload class — `mutation-result` / `move-result`).
 * So the result's internal `kind` discriminator is STRIPPED here — the emitted
 * `data` has no `result` and no `kind`, just the payload fields (`op`, `uuid`,
 * `title`, `undoToken`, `observed`, `vector`, `tier`, `touched`, notes, …).
 * Only the internal tags `"ok"` / `"move-ok"` ever reach this boundary
 * (failures route to error envelopes, dry-runs to the `mutation-plan` /
 * `move-plan` kinds), so nothing is lost by dropping it. The library keeps the
 * idiomatic `kind` discriminator on its in-memory
 * `MutationResult`/`ReorderResult`/`MoveResult` unions; it simply never appears
 * on the wire. The CLI emits through it today; the MCP mutation path still
 * emits the internal shape until its phase-2 framing sweep.
 */
export function mutationWireData<T extends { kind: string }>(ok: T): Omit<T, "kind"> {
  const { kind: _kind, ...rest } = ok;
  return rest;
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
