/**
 * The mutation pipeline: fingerprint gate → lock → pre-read → guards →
 * vector planning → ensure-running → execute → verified read-after-write →
 * audit. Every mutation attempt is audited, including blocked decisions. A
 * write that reaches the app records TWICE: an `intent` marker right before
 * execute (so a crash mid-write leaves evidence — M3) and the final outcome
 * after verify.
 */
import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { AuditWriter } from "../audit/log.ts";
import { undoToken, type AuditRecord } from "../audit/schema.ts";
import { blockedCode, verifyFailedCode } from "../contracts.ts";
import type { DisruptionTier, ThingsApiConfig } from "../config.ts";
import type { FingerprintStatus } from "../db/fingerprint.ts";
import { localToday } from "../model/dates.ts";
import {
  liveSeriesInstances,
  resolveProjectWriteTarget,
  resolveTaskUuidPrefix,
} from "../read/queries.ts";
import { namedProjectClause, taskMembershipClause, type ResolvedScope } from "../read/scope.ts";
import { evaluateScope } from "./scope-guard.ts";
import { isThingsRunning } from "./automation-probe.ts";
import { readShortcutProxies, readUrlSchemeEnabled, type ShortcutsState } from "./availability.ts";
import {
  uiAllowed,
  uiCapability as uiCapabilityDefault,
  writeCapability as writeCapabilityDefault,
  type UiCapability,
  type WriteCapability,
} from "../capability.ts";
import { COMMANDS, type CommandSpec } from "./commands.ts";
import {
  describeEnvironmentChanges,
  diffEnvironment,
  type EnvironmentChange,
  type EnvironmentTracker,
} from "./environment.ts";
import { privateReorderIsNoOp, sdefDeclaresPrivateReorder } from "./experimental.ts";
import {
  classifyTransportFailure,
  classifyVerifyFailure,
  type FailureHint,
  type LikelyCause,
} from "./failure-hints.ts";
import { evaluateGuards, type GuardBlock, type HazardId } from "./guards.ts";
import {
  acquireMutationLock,
  MutationLockError,
  withMutationLock,
  type AcquireMutationLockOptions,
} from "./lock.ts";
import {
  isHeadingTargetOp,
  type Acknowledgements,
  type OperationKind,
  type OperationParamsMap,
} from "./operations.ts";
import { computeCompletionContext, type CompletionContext } from "./completion-context.ts";
import { assessOffRuleFirst } from "./repeat-anchor.ts";
import type { RepeatRuleParams } from "./operations.ts";
import { planVector } from "./planner.ts";
import { isRepeatingTemplate, type PreState } from "./pre-state.ts";
import {
  restoreModDates,
  type ModRestoreTarget,
  type PreserveModifiedFailure,
} from "./preserve-modified.ts";
import { REVERSIBILITY } from "./reversibility.ts";
import { certificationOf } from "./vectors/ui-certification.ts";
import type { CompiledInvocation, ExecuteResult, VectorId, WriteVector } from "./vectors/types.ts";
import {
  createDbReader,
  evaluateDelta,
  getField,
  type DeltaSpec,
  type PreModDates,
  type RepeatingDiscovery,
} from "./verify/delta.ts";
import { pollUntilVerified, type PollerDeps, type PollOutcome } from "./verify/poller.ts";
import { setInflight, trace } from "../trace/tracer.ts";

/**
 * Bounded backoff for the post-transport-failure re-verify (0½ defect (a)): a
 * GUI drive can abort part-way yet still have LANDED the change, so a nonzero
 * transport exit is re-verified over ~2s before the write is declared lost.
 */
const RECOVERY_VERIFY_TIMEOUT_MS = 2000;

export interface WriteOptions extends Acknowledgements {
  /** Caps vector selection; defaults from the config profile. */
  maxDisruption?: DisruptionTier;
  /** Force a specific vector (must still be validated + support the op). */
  vector?: VectorId;
  verifyTimeoutMs?: number;
  /** Return the plan without executing (nothing is audited). */
  dryRun?: boolean;
  /**
   * Keep this change off the `userModificationDate` (`umd`) timeline. When set,
   * the pipeline captures every pre-existing TARGET row's `umd` before the write
   * and — after the change verifies — restores it through the AppleScript `set
   * modification date` leg (preserve-modified.ts), so a `changes`/watch query
   * keyed on `umd` does not surface the edit. Rows the op CREATES are untouched
   * (their `umd` is legitimately new); a create-only op (add) is a silent no-op.
   * BEST-EFFORT: a failed restore never fails the (already-verified) mutation —
   * it is disclosed per row on the result. Restore lands on `floor(umd0)` (the
   * AppleScript 1-second floor) and is proven only on an UNSYNCED store (SYNC2).
   */
  preserveModified?: boolean;
  /**
   * Skip the post-execute state VERIFY poll for this write, treating a clean
   * transport (exit 0) as ok. Fail-loud on the transport itself is preserved (a
   * nonzero exit / deadline still runs the recovery re-verify). Used by the
   * bounce orchestrator for the transient AWAY/BACK legs of a `when=` round-trip:
   * the intermediate someday state is not independently verified — one verify
   * per item round-trip (the placed-position + when-restore delta) is asserted by
   * the orchestrator at item completion instead (reordgaps-results.md BOUNCE2).
   */
  skipVerify?: boolean;
  /**
   * Create any tag named in this op's tags that does not exist yet (through the
   * clean `make new tag` path, mkdir-p for `parent/child`) BEFORE applying —
   * turning what would be an H-UNKNOWN-TAG refusal into a create-then-apply.
   * Handled by the client's tag-prep orchestrator, above `runMutation`.
   */
  createTags?: boolean;
  /** Audit attribution. */
  actor?: string;
  /** Compound-operation grouping (set by orchestrators, not callers). */
  txn?: { id: string; role: "leg" | "summary" };
  /**
   * Undo back-reference (set by the undo executor, not callers): the token of
   * the original mutation this write inverts. Recorded on the audit trail so an
   * already-undone mutation is distinguishable from a nonexistent one.
   */
  undoOf?: string;
  /**
   * Client idempotency id — a batch line's `opId` (set by the batch
   * orchestrator) OR a single mutation's `--op-id` (set by the client `run`
   * entry). Recorded on the audit record so a resubmission carrying the same id
   * is recognized as already-applied. Recording is additive and never affects
   * dispatch; the single-op idempotency CHECK (skip-and-replay on a match) runs
   * in the client `run` entry before this pipeline is reached.
   */
  opId?: string;
  /**
   * Consumer IANA zone for THIS write, overriding the client's default zone.
   * Only affects the clock-relative `when` tokens (today/evening) when
   * {@link normalizeWhen} is set. Reminder times stay wall-clock and untranslated.
   */
  zone?: string;
  /**
   * Normalize a CONSUMER-provided clock-relative `when` (today/evening) to the
   * effective consumer zone BEFORE dispatch — set by the consumer entry points
   * (the client's `run`, batch), NEVER by the internal orchestrators (undo,
   * reorder), whose when tokens converse with app-written host state and must
   * stay on the host clock.
   */
  normalizeWhen?: boolean;
  /**
   * TEMPLATE-DIRECT clone (template-clone via re-promote): tells the clone
   * orchestrator to copy a repeating TEMPLATE source's content as a PLAIN item
   * (recurrence stripped — no rule, no schedule/reminder), instead of refusing it
   * (H-CLONE-SOURCE). NEVER set by a consumer entry point (the CLI/MCP/batch/client
   * do not thread it) — only `cloneTemplateViaRepromote` sets it on the embedded
   * clone leg, which it then native-promotes with the source's decoded rule. A bare
   * `todo/project clone` of a template still routes through the compound (which sets
   * this flag internally). See promote-clone.ts cloneTemplateViaRepromote.
   */
  cloneTemplateAsPlain?: boolean;
}

export interface MutationPlan {
  op: OperationKind;
  vector: VectorId;
  tier: DisruptionTier;
  invocation: string;
  expectedDelta: DeltaSpec;
  hazardsChecked: HazardId[];
  /** Advisory notes the preview should surface (e.g. the DACON1 off-rule-first disclosure). */
  notes?: string[];
}

export type MutationResult =
  | {
      kind: "ok";
      op: OperationKind;
      uuid: string | null;
      /**
       * The mutated item's title (ADDITIVE), when the op targets a single
       * pre-existing item — its pre-write title, captured before the change.
       * Lets a batch log confirm WHAT was mutated without a second read. Absent
       * for create/reorder ops, which have no single pre-existing target.
       */
      title?: string;
      observed: Record<string, unknown> | null;
      vector: VectorId;
      tier: DisruptionTier;
      /**
       * The undo token for this mutation (ADDITIVE): pass it to
       * `things undo --txn <token>` (MCP `txn`) to invert exactly this change,
       * unaffected by any other mutations made in between.
       */
      undoToken?: string;
      /**
       * Make-repeating conversions (todo/project make-repeating, and
       * project.add-repeating via its promote leg): the discovered template
       * uuid, the FK-derived current-occurrence instance (use this for the
       * VISIBLE item), and the replaced original uuid — plus `childrenReplaced`
       * for project conversions. `uuid` still equals `templateUuid` (use it to
       * reschedule the repeat). Absent for every other op.
       */
      repeating?: RepeatingDiscovery;
      /** Advisory notes (e.g. a changed environment tuple — consent may re-prompt later). */
      warnings?: string[];
      /**
       * Co-bounced siblings (ADDITIVE): a bounce reorder that anchors a block
       * with --before/--after (or lands it mid-bucket) must re-insert every
       * UNNAMED member between the block and the bucket edge. Those items get a
       * modification bump, a changes-feed entry, and an audit leg — disclosed
       * here explicitly, never as fine print. Absent when only the named movees
       * were touched.
       */
      touched?: string[];
      /**
       * Idempotency replay (ADDITIVE, presence-keyed): `true` when this result
       * did NOT execute — a mutation carrying an `opId` matched a prior verified
       * `ok` record with the same id in the recent change history, so the earlier
       * change stands and nothing ran again. The `uuid`/`title`/`undoToken` echo
       * the ORIGINAL mutation's identity. Absent on a normal (executed) result.
       */
      alreadyApplied?: true;
      /**
       * `--preserve-modified` disclosure (ADDITIVE, presence-keyed): the count of
       * pre-existing target rows whose `userModificationDate` was restored to its
       * pre-write value (to the floored second) so the change stays off the
       * `changes`/watch timeline. Present only when the flag did real work —
       * absent on a create-only or already-silent op, where restore is a no-op.
       */
      preservedModified?: number;
      /**
       * `--preserve-modified` per-row failures (ADDITIVE): rows the restore leg
       * could not neutralize. Best-effort — the mutation itself stands; these are
       * disclosed, never fatal. Absent when every restore leg succeeded.
       */
      preserveFailures?: PreserveModifiedFailure[];
      /**
       * HINTS1 completion-context (ADDITIVE, presence-keyed): on a successful
       * `todo.complete` / `todo.cancel` only, the remaining OPEN work in the
       * to-do's container(s), computed from a cheap post-verify re-read so an
       * agent can notice an emptied project/Today without a second read.
       * `project` is present when the to-do was in a project (directly or under a
       * heading) and carries its `uuid`, `title`, and the OPEN, untrashed,
       * non-template to-dos remaining in it (heading children included; `0` = the
       * project's open work is now empty). `today` is present when the to-do was
       * a Today member at mutation time and carries the OPEN Today members
       * remaining. The hint INFORMS, never auto-acts; absent when neither applies
       * (and on every other op). See {@link CompletionContext}.
       */
      context?: CompletionContext;
    }
  | {
      kind: "verify-failed";
      op: OperationKind;
      reason: "timeout" | "mismatch" | "silent-noop";
      expected: DeltaSpec;
      observed: Record<string, unknown> | null;
      detail: string;
      /** Advisory attribution when the failure signals point somewhere. */
      likelyCause?: LikelyCause;
      hint?: string;
      /**
       * The outcome is genuinely UNCERTAIN, not confirmed-failed (TRACE1, #487):
       * a UI drive was aborted by the watchdog (or the process was interrupted)
       * while the app might have been mid-commit, so the caller must re-check
       * with `things show <uuid>` rather than assume nothing changed. Present
       * only on the ui-drive watchdog timeout.
       */
      uncertain?: true;
      /** The local trace file reconstructing this drive's timeline (TRACE1). */
      tracePath?: string;
    }
  | {
      kind: "blocked";
      op: OperationKind;
      reason: "hazard" | "disruption-tier" | "drift" | "lock" | "environment" | "clock" | "scope";
      hazard?: HazardId;
      detail: string;
      remediation: string;
      likelyCause?: LikelyCause;
    }
  | {
      kind: "unsupported";
      op: OperationKind;
      considered: { vector: VectorId; why: string }[];
    }
  | { kind: "dry-run"; op: OperationKind; plan: MutationPlan };

export interface WriteDeps {
  db: DatabaseSync;
  vectors: WriteVector[];
  config: ThingsApiConfig;
  audit: AuditWriter;
  fingerprint(): FingerprintStatus;
  lockPath: string;
  /** Injectable for tests/lab: returns true when Things is up (launching if needed). */
  ensureRunning?: (alreadyRunning: boolean) => Promise<boolean>;
  isAppRunning?: () => boolean;
  /**
   * Seam for the default launch: the consent-free launch-readiness probe polled
   * after a background launch, before dispatch (past the startup URL-drop
   * window, #486). Only consulted by the default {@link ensureRunning}; ignored
   * when a test injects its own `ensureRunning`.
   */
  appReady?: () => boolean;
  /**
   * The resolved on-disk database path (client-wired from the located DB). The
   * default launch uses `${dbPath}-wal` as its consent-free readiness signal
   * (the app has written since we launched it, #486). Absent = fall back to the
   * LaunchServices launch-completion label.
   */
  dbPath?: string;
  /** Canary seam: does the installed sdef still declare the private command? */
  sdefProbe?: () => boolean;
  /** Consent-churn tripwire: tuple recorded per verified mutation (client wires the default). */
  environment?: EnvironmentTracker;
  /** Seam: on-disk 'Enable Things URLs' state for failure attribution (availability.ts). */
  urlSchemeEnabled?: () => boolean | null;
  /** Seam: installed Things proxy shortcuts, for the pre-dispatch availability gate (availability.ts). */
  shortcutProxies?: () => ShortcutsState;
  /** Seam: prompt-free app-automation standing, for the write gate (capability.ts). */
  writeCapability?: () => WriteCapability;
  /** Seam: prompt-free GUI-driving standing, for the Article IV gate (capability.ts). */
  uiCapability?: () => UiCapability;
  now?: () => Date;
  /** Default consumer IANA zone (client-resolved from THINGS_TZ); normalizes consumer `when` tokens. */
  zone?: string;
  /**
   * The active container scope (pinned at openThings). When set: uuid targets
   * resolve scope-aware (out-of-scope == not-found parity), and the universal
   * scope gate (evaluateScope) runs before the hazard guards. Absent = unscoped.
   */
  scope?: ResolvedScope;
  poller?: PollerDeps;
  pkgVersion?: string;
  /**
   * Audit-trail directory (client-wired): read by `runBatch` for the opId
   * idempotency lookback. Absent = no lookback (opId dedup is a no-op), which is
   * the correct degraded behavior when the trail is unavailable.
   */
  auditDirPath?: string;
}

export function readAuthToken(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT uriSchemeAuthenticationToken AS t FROM TMSettings").get() as
      | { t: string | null }
      | undefined;
    return row?.t ?? null;
  } catch {
    return null;
  }
}

/**
 * The ONE process-presence signal (shared with `doctor`/sync-health via
 * automation-probe.ts) — a single stable `pgrep -x Things3` shape so macOS
 * never sees a second command form.
 */
const defaultIsAppRunning = isThingsRunning;

/** Poll interval for the launch waits. */
const LAUNCH_POLL_INTERVAL_MS = 200;
/** Cap on how long we wait for the launched PROCESS to appear. */
const LAUNCH_PROCESS_TIMEOUT_MS = 20_000;
/**
 * Cap on how long we wait — after the process appears — for the app to become
 * READY to land a write. A freshly launched Things registers its URL handler
 * before it can actually apply a command: a command dispatched into that
 * startup window is accepted and silently dropped (issue #486). We poll a cheap
 * consent-free readiness signal past that window before dispatching.
 */
const LAUNCH_READY_TIMEOUT_MS = 12_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The write-ahead-log's mtime in ms, or null when it cannot be read. */
function walMtimeMs(walPath: string): number | null {
  try {
    return statSync(walPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Consent-free launch-completion signal via LaunchServices — the fallback used
 * only when the database path is unknown. NOT an Apple Event, so it never drags
 * Automation consent onto the consent-free URL path. `lsappinfo` reports a
 * process still coming up as `"Not Finished Launching"`; anything else is
 * treated as launched. False on any error (treated as "not ready yet").
 */
function lsappinfoLaunched(): boolean {
  try {
    const out = execFileSync(
      "lsappinfo",
      ["info", "-only", "StatusLabel", "-app", "com.culturedcode.ThingsMac"],
      { encoding: "utf8", timeout: 3000 },
    );
    if (out.trim() === "" || /Not Finished Launching/i.test(out)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Consent-free launch-readiness signal — a DB-write-capability probe. A freshly
 * launched Things recomputes its Today/repeat state and writes to its database
 * shortly after launch; a URL command applied BEFORE the app is truly up is at
 * risk of being dropped in the startup window (issue #486). Reading a file mtime
 * needs no Apple Event, so this never triggers a consent prompt. "Ready" = the
 * write-ahead log has advanced past the pre-launch baseline (the app has written
 * since we launched it). APPRUN1 (golden-v3, Things 3.22.14): the WAL advanced
 * ~0.9s after `open -g` — a real post-launch signal — while the process appeared
 * at ~0.03s; the drop window itself did not reproduce in a clean airgapped clone
 * (first URL landed immediately), so this wait is a defensive floor, and any
 * residual drop is caught by verify and attributed `app-not-running`. Falls back
 * to the LaunchServices label when the DB path is unknown. See
 * docs/lab/apprun1-launch-readiness.md.
 */
function walAdvancedSince(walPath: string | undefined, baseline: number | null): boolean {
  if (walPath === undefined) return lsappinfoLaunched();
  const m = walMtimeMs(walPath);
  return m !== null && (baseline === null || m > baseline);
}

/**
 * Background-launch Things (tier 1, by policy — `open -g` keeps it off the
 * foreground) and wait CLOSED-LOOP for it to become ready to land a write:
 * first for the process to appear, then for the readiness signal to trip (past
 * the startup URL-drop window, #486). Returns false only if the process never
 * appears within {@link LAUNCH_PROCESS_TIMEOUT_MS}; once it is up we proceed
 * after readiness trips OR the readiness cap elapses (best-effort — a residual
 * drop is then caught by verify + attributed "app was not running").
 */
async function defaultEnsureRunning(
  alreadyRunning: boolean,
  opts: { dbPath?: string; appReady?: () => boolean } = {},
): Promise<boolean> {
  if (alreadyRunning) return true;
  // Capture the readiness baseline BEFORE launching, so "the app has written
  // since we launched it" is judged against the pre-launch WAL state.
  const walPath = opts.dbPath !== undefined ? `${opts.dbPath}-wal` : undefined;
  const walBaseline = walPath !== undefined ? walMtimeMs(walPath) : null;
  const appReady = opts.appReady ?? (() => walAdvancedSince(walPath, walBaseline));
  await new Promise<void>((resolve) => {
    execFile("open", ["-g", "-a", "Things3"], () => resolve());
  });
  // Phase 1: wait for the process to exist.
  const processDeadline = Date.now() + LAUNCH_PROCESS_TIMEOUT_MS;
  while (!defaultIsAppRunning()) {
    if (Date.now() >= processDeadline) return false;
    await sleep(LAUNCH_POLL_INTERVAL_MS);
  }
  // Phase 2: wait for launch-readiness (past the URL-drop window).
  const readyDeadline = Date.now() + LAUNCH_READY_TIMEOUT_MS;
  while (!appReady()) {
    if (Date.now() >= readyDeadline) break; // best-effort: proceed and let verify judge
    await sleep(LAUNCH_POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * The template's PRESERVED deadline offset (`startOffsetDays`, ≤ 0) for a
 * reschedule that carries NO deadline flag — so the off-rule-first disclosure can
 * state the true appear/due dates the app lands (RSPA1-D). `null` when the request
 * addresses the deadline itself (an explicit --deadline / --start-days-earlier), or
 * the target is not a deadlined template — cases where the params already carry the
 * shift and no preserved offset applies.
 */
function preservedDeadlineOffsetFor(pre: PreState, params: RepeatRuleParams): number | null {
  if (params.deadline !== undefined || (params.startDaysEarlier ?? 0) > 0) return null;
  const target = pre.target;
  if (target === null || !("repeating" in target)) return null;
  const rep = target.repeating;
  if (rep.deadlined !== true) return null;
  return rep.rule?.startOffsetDays ?? 0;
}

/** Capture pre-values of asserted fields + movement tripwires for the spec. */
function capturePre(
  spec: DeltaSpec,
  deps: WriteDeps,
  pre: PreState,
): {
  modDates: PreModDates;
  fields: Record<string, Record<string, unknown>>;
  trashedCount?: number;
} {
  // Same injected clock the write planner rides — so a captured pre-value of the
  // today/evening markers is judged under the SAME Today the post-op read will be.
  const reader = createDbReader(deps.db, deps.now?.() ?? new Date(), deps.zone);
  const modDates: PreModDates = {};
  const fields: Record<string, Record<string, unknown>> = {};
  const captureFor = (uuid: string, assertions: { field: string }[]): void => {
    modDates[uuid] = reader.modDateOf(uuid);
    const entity = reader.taskByUuid(uuid);
    const captured: Record<string, unknown> = {};
    for (const a of assertions) {
      captured[a.field] = entity === null ? undefined : (getField(entity, a.field) ?? null);
    }
    fields[uuid] = captured;
  };
  if (spec.mode === "update" || spec.mode === "state") {
    const extra = spec.mode === "update" ? (spec.capture ?? []) : [];
    captureFor(spec.uuid, [...spec.assert, ...extra]);
    if (spec.mode === "state" && spec.cascade !== undefined) {
      for (const c of spec.cascade) captureFor(c.uuid, c.assert);
    }
  }
  if (spec.mode === "ordering") {
    const preRanks: Record<string, unknown> = {};
    // `capture` may list MORE uuids than the asserted sequence (the full
    // area order for area.reorder) so undo can restore the exact
    // previous position from the audit record.
    for (const uuid of spec.capture ?? spec.sequence) {
      preRanks[uuid] = reader.rankOf(uuid, spec.key);
    }
    fields["__ordering__"] = preRanks;
    // LOGSORT ORD-13: capture each frozen (unswept-resolved) movee's asserted
    // fields AND its userModificationDate, so the post-op eval can prove the
    // native re-rank left them index-only + umd-silent (no reopen).
    for (const f of spec.frozen ?? []) captureFor(f.uuid, f.assert);
  }
  if (spec.mode === "entity-updated") {
    const current = reader.entityFields(spec.entity, spec.uuid);
    const captured: Record<string, unknown> = {};
    for (const a of spec.assert) captured[a.field] = current?.[a.field] ?? null;
    fields[spec.uuid] = captured;
  }
  if (spec.mode === "trash-emptied") {
    return { modDates, fields, trashedCount: pre.trashedCount };
  }
  return { modDates, fields };
}

/** Attach failure-hint attribution (likelyCause/hint) to a result, if any was classified. */
function withHint<T extends object>(base: T, hint: FailureHint | null): T {
  return hint === null ? base : { ...base, likelyCause: hint.likelyCause, hint: hint.hint };
}

/**
 * Normalize a CONSUMER-provided clock-relative `when` for the effective zone,
 * so the app (which would interpret the bare word on the HOST clock) never sees
 * a relative token that means a different calendar date for the consumer.
 *
 * - `today` → the consumer-zone calendar date, dispatched as an explicit
 *   `when=YYYY-MM-DD` (with any reminder still appended) so verification agrees
 *   by construction. When the consumer's today already equals the app's today
 *   the token is left as-is (byte-identical dispatch). A consumer-today that is
 *   host-yesterday yields a past startDate — coherent (lands in Today with
 *   overdue-start semantics), documented, not special-cased.
 * - `evening` → This Evening exists ONLY for the app machine's own current day
 *   (the startBucket=1 rows whose startDate is exactly the app's today; an
 *   "evening of another day" is not representable in Things' model, not even in
 *   the GUI — see src/read/views.ts). Refused fail-closed when the dates differ.
 *
 * Reminder times are wall-clock and tz-less in Things' own model — never
 * translated here.
 */
export function normalizeConsumerWhen(
  params: Record<string, unknown>,
  now: Date,
  zone: string,
):
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; detail: string; remediation: string } {
  const when = params["when"];
  if (when !== "today" && when !== "evening") return { ok: true, params };
  const consumerToday = localToday(now, zone);
  const hostToday = localToday(now);
  if (consumerToday === hostToday) return { ok: true, params };
  if (when === "today") return { ok: true, params: { ...params, when: consumerToday } };
  return {
    ok: false,
    detail:
      `This Evening exists only for the app machine's current day (${hostToday}), but the ` +
      `requested time zone (${zone}) is on ${consumerToday}, so the item cannot be placed there`,
    remediation:
      `schedule an explicit date (when=${consumerToday}; it lands in that day's section, not ` +
      `This Evening), or set this host's system time zone to the consumer's so the calendars match`,
  };
}

/**
 * Run a COMPOSITE — a single verb the engine executes as several mutations —
 * under ONE mutation lock held end-to-end, so it serializes against other
 * writers as a whole instead of leg by leg. Every leg's own
 * `acquireMutationLock` inside `body` is a reentrant no-op (see
 * {@link withMutationLock}); the per-leg lock stays the base case for an
 * ordinary single mutation.
 *
 * Wrap only the MUTATING tail: validation, dry-run planning, and the hazard /
 * session gates belong outside, so a refusal never takes the lock. On contention
 * the refusal is the same `blocked` / `lock` shape the pipeline returns for a
 * single op, carrying the composite's own op name. No audit record is written
 * for it — unlike the single-op path, nothing was attempted, so there is no leg
 * to record.
 */
export async function runComposite(
  deps: WriteDeps,
  op: OperationKind,
  body: () => Promise<MutationResult>,
  /** @internal test seam — see {@link AcquireMutationLockOptions}. */
  lockOptions: AcquireMutationLockOptions = {},
): Promise<MutationResult> {
  try {
    return await withMutationLock(deps.lockPath, body, lockOptions);
  } catch (err) {
    if (err instanceof MutationLockError) {
      return {
        kind: "blocked",
        op,
        reason: "lock",
        detail: err.message,
        remediation: "wait for the concurrent mutation to finish and retry",
      };
    }
    throw err;
  }
}

export async function runMutation<K extends OperationKind>(
  deps: WriteDeps,
  op: K,
  params: OperationParamsMap[K],
  options: WriteOptions = {},
): Promise<MutationResult> {
  const startedAt = deps.now?.() ?? new Date();
  // Uuid params accept unique PREFIXES (>= 6 chars) — resolved to full uuids
  // here so guards/compiles/audit all see canonical ids. Throws (RangeError)
  // on unknown or ambiguous prefixes, like the title resolvers. PROJECT write
  // targets additionally accept a unique NAME (project titles are addressed
  // like areas/tags); to-do and heading targets stay uuid-only, differing only
  // in the entity noun their not-found copy names.
  // Container scope (when active) makes target resolution scope-aware: an
  // out-of-scope uuid/name resolves to "not found" through the IDENTICAL code
  // path a nonexistent one does, so the two are byte-indistinguishable (the
  // no-oracle guarantee — parity fires HERE, before pre-read/guards). Tag reads
  // are exempt, but no write op resolves a tag through `uuid`.
  const scope = deps.scope;
  const taskScope = scope !== undefined ? taskMembershipClause(scope) : undefined;
  const p = params as Record<string, unknown>;
  if (typeof p["uuid"] === "string") {
    // Heading verbs (project.*-heading whose `uuid` is a heading row) resolve as
    // headings, NOT projects, even though they share the `project.` namespace.
    const uuid = isHeadingTargetOp(op)
      ? resolveTaskUuidPrefix(deps.db, p["uuid"], "heading", taskScope)
      : op.startsWith("project.")
        ? resolveProjectWriteTarget(
            deps.db,
            p["uuid"],
            scope !== undefined
              ? { task: taskScope!, named: namedProjectClause(scope) }
              : undefined,
            // The trash-domain op widens the name pool to trashed projects so a
            // restore-by-name can find (and disambiguate) them; every other
            // project verb stays live-scoped (a trashed project resolves by uuid
            // only).
            op === "project.restore",
            // Reopen's whole purpose is a non-open target, so it (alone) widens
            // the name pool to completed/canceled projects; every other verb
            // resolves a done project by uuid only (open-only by name — PLOG1).
            op === "project.reopen",
          )
        : resolveTaskUuidPrefix(deps.db, p["uuid"], "to-do", taskScope);
    params = { ...params, uuid };
  }
  if (Array.isArray(p["uuids"])) {
    params = {
      ...params,
      uuids: (p["uuids"] as string[]).map((u) =>
        resolveTaskUuidPrefix(deps.db, u, "item", taskScope),
      ),
    };
  }
  const spec = COMMANDS[op] as CommandSpec<K>;
  const config = deps.config;
  const actor = options.actor ?? config.actor;
  // The GUI-drive acknowledgement is the second of the ui vector's two keys;
  // it also lifts the disruption ceiling to the top tier so the caller does
  // not additionally need --allow-very-disruptive for a change they already
  // acknowledged drives the GUI.
  const maxDisruption: DisruptionTier =
    options.dangerouslyDriveGui === true ? 3 : (options.maxDisruption ?? config.maxDisruption);

  const audit = (partial: Partial<AuditRecord> & { result: AuditRecord["result"] }): void => {
    const fp = deps.fingerprint();
    const record: AuditRecord = {
      v: 1,
      ts: startedAt.toISOString(),
      actor,
      host: config.host,
      op,
      uuid: null,
      vector: null,
      disruption: null,
      invocation: null,
      requested: params as Record<string, unknown>,
      ...(options.txn !== undefined && { txn: options.txn }),
      ...(options.undoOf !== undefined && { undoOf: options.undoOf }),
      ...(options.opId !== undefined && { opId: options.opId }),
      pre: null,
      observed: null,
      verify: null,
      durationMs: (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
      env: {
        pkg: deps.pkgVersion ?? "0.0.1",
        dbVersion: fp.observation.databaseVersion,
        fingerprint: fingerprintLabel(fp, config),
      },
      ...partial,
    };
    deps.audit.append(record);
  };

  // 1. Drift gate: writes hard-block on fingerprint mismatch.
  const fp = deps.fingerprint();
  const fpLabel = fingerprintLabel(fp, config);
  if (fpLabel === "drift" || fpLabel === "unknown") {
    const detail =
      fp.kind === "unknown-version"
        ? `unknown database version ${fp.observation.databaseVersion ?? "?"} (newer Things?)`
        : "schema fingerprint deviates from the shipped baseline";
    audit({ result: blockedCode({ reason: "drift" }) });
    return {
      kind: "blocked",
      op,
      reason: "drift",
      likelyCause: "schema-drift",
      detail,
      remediation:
        "update things-api to a release with a matching baseline, or (at your own risk) " +
        "`things config set accepted-fingerprint <observed hash>` after reviewing `things doctor`",
    };
  }

  // 2. Serialize mutations (create-probe verification must never race).
  let lock: { release(): void };
  try {
    lock = await acquireMutationLock(deps.lockPath);
  } catch (err) {
    if (err instanceof MutationLockError) {
      audit({ result: blockedCode({ reason: "lock" }) });
      return {
        kind: "blocked",
        op,
        reason: "lock",
        detail: err.message,
        remediation: "wait for the concurrent mutation to finish and retry",
      };
    }
    throw err;
  }

  try {
    // 3. Pre-read. The consumer zone (options.zone ?? deps.zone) is threaded so
    // any boundary-derived pre-state (the reorder swept/unswept log boundary,
    // LOGSORT ORD-13) is computed under the SAME zone the reads use.
    const pre = spec.preRead(
      deps.db,
      params,
      deps.now?.() ?? new Date(),
      options.zone ?? deps.zone,
    );

    // 3a. Universal container-scope gate — runs for EVERY op (unlike hazards),
    // BEFORE evaluateGuards so a scope refusal precedes any hazard copy. It may
    // rewrite `pre` (add-redirect defaulting; nullifying an out-of-scope
    // destination so H-UNKNOWN-DESTINATION fires with parity). Target-in-scope
    // parity already fired at resolution above.
    if (scope !== undefined) {
      const decision = evaluateScope(deps.db, op, params as Record<string, unknown>, pre, scope);
      if (decision.kind === "blocked") {
        audit({ result: blockedCode({ reason: "scope" }) });
        return {
          kind: "blocked",
          op,
          reason: "scope",
          detail: decision.detail,
          remediation: decision.remediation,
        };
      }
    }

    // 3b. Guards.
    const acks: Acknowledgements = {
      ...(options.acknowledgeChecklistReset !== undefined && {
        acknowledgeChecklistReset: options.acknowledgeChecklistReset,
      }),
      ...(options.acknowledgeProjectReopen !== undefined && {
        acknowledgeProjectReopen: options.acknowledgeProjectReopen,
      }),
      ...(options.dangerouslyPermanent !== undefined && {
        dangerouslyPermanent: options.dangerouslyPermanent,
      }),
      ...(options.acknowledgeTagSubtree !== undefined && {
        acknowledgeTagSubtree: options.acknowledgeTagSubtree,
      }),
      ...(options.allowNonEmptyArea !== undefined && {
        allowNonEmptyArea: options.allowNonEmptyArea,
      }),
      ...(options.dangerouslyDriveGui !== undefined && {
        dangerouslyDriveGui: options.dangerouslyDriveGui,
      }),
    };
    const block: GuardBlock | null = evaluateGuards(spec.hazards, {
      op,
      params: params as Record<string, unknown>,
      pre,
      acks,
    });
    if (block !== null) {
      audit({ result: blockedCode({ hazard: block.hazard, reason: "hazard" }) });
      return {
        kind: "blocked",
        op,
        reason: "hazard",
        hazard: block.hazard,
        detail: block.detail,
        remediation: block.remediation,
      };
    }

    // 3b. Consumer-zone `when` normalization (consumer entry points only —
    // undo/reorder never set normalizeWhen, so their host-clock when tokens are
    // untouched). Rewrites `today` to the consumer-zone date and refuses a
    // cross-date `evening` fail-closed, BEFORE compile so the explicit-date
    // branch of the delta verifies it.
    const effectiveZone = options.zone ?? deps.zone;
    if (options.normalizeWhen === true && effectiveZone !== undefined) {
      const norm = normalizeConsumerWhen(
        params as Record<string, unknown>,
        deps.now?.() ?? new Date(),
        effectiveZone,
      );
      if (!norm.ok) {
        audit({ result: blockedCode({ reason: "clock" }) });
        return {
          kind: "blocked",
          op,
          reason: "clock",
          detail: norm.detail,
          remediation: norm.remediation,
        };
      }
      params = norm.params as OperationParamsMap[K];
    }

    // 4. Vector planning under the disruption policy.
    const appRunning = (deps.isAppRunning ?? defaultIsAppRunning)();
    const plan = planVector(op, deps.vectors, {
      maxDisruption,
      appRunning,
      allowExperimental: config.allowExperimental,
      ...(options.vector !== undefined && { forcedVector: options.vector }),
    });
    if (plan.kind === "unsupported") {
      audit({ result: "unsupported" });
      return { kind: "unsupported", op, considered: plan.considered };
    }
    if (plan.kind === "tier-blocked") {
      audit({ result: blockedCode({ reason: "disruption-tier" }) });
      return {
        kind: "blocked",
        op,
        reason: "disruption-tier",
        detail:
          `operation needs disruption tier ${plan.requiredTier} ` +
          `(app ${appRunning ? "running" : "closed — launch required"}), ` +
          `policy allows ${plan.maxDisruption}`,
        remediation: "pass --allow-disruptive / raise maxDisruption, or launch Things first",
      };
    }
    const { vector, effectiveTier } = plan.candidate;

    // 4b. Experimental canary: the private sdef command can vanish in any
    // Things update — re-check the declaration before every dispatch. Things
    // 3.23 broke it WITHOUT withdrawing the declaration (it still exits 0 and
    // changes nothing — docs/lab/gv4-323-campaign.md §3.1, which caught both
    // `reorder` and `project.move-heading`), so a version gate stands in front
    // of the declaration check until the behavioral canary lands.
    if (plan.candidate.support.experimental === true) {
      const appVersion = deps.environment?.capture().thingsVersion ?? null;
      if (privateReorderIsNoOp(appVersion)) {
        audit({ result: blockedCode({ reason: "environment" }) });
        return {
          kind: "blocked",
          op,
          reason: "environment",
          detail:
            `Things ${appVersion} applies the private reorder command without changing ` +
            "anything — this operation would report a failed write, so it was NOT attempted",
          remediation:
            "use a non-experimental path where one exists (omit --strategy so the " +
            "bounce/move fallbacks run), or reorder the items in the app",
        };
      }
      const declared = (deps.sdefProbe ?? sdefDeclaresPrivateReorder)();
      if (!declared) {
        audit({ result: blockedCode({ reason: "environment" }) });
        return {
          kind: "blocked",
          op,
          reason: "environment",
          detail:
            "the installed Things no longer declares the private reorder command in its " +
            "sdef — the experimental surface has likely been removed by an app update",
          remediation:
            "check `things doctor`, file/track the change, and fall back to the bounce " +
            "strategy where available",
        };
      }
    }

    // 5. Compile + expected delta.
    const nowEpoch = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    const todayIso = localToday(deps.now?.() ?? new Date());
    const token = readAuthToken(deps.db);
    // The simulator vector applies mutations from STRUCTURED op/params via SQL,
    // never from a compiled payload — and a single VectorId cannot satisfy the
    // transport-specific `spec.compile` of every operation (url-scheme-only vs
    // applescript/shortcuts). So skip compile for it and synthesize a redacted
    // marker for the audit trail. Real transports compile as before, then carry
    // the structured input additively (they ignore it).
    const invocation: CompiledInvocation =
      vector.simulates === true
        ? {
            vector: vector.id,
            kind: "open-url",
            payload: `simulated:${op}`,
            redactedPayload: `simulated:${op}`,
            op,
            opParams: params,
          }
        : spec.compile(params, vector.id, pre, {
            token,
            ...(effectiveZone !== undefined && { zone: effectiveZone }),
          });
    if (vector.simulates !== true) {
      invocation.op = op;
      invocation.opParams = params;
    }
    const delta = spec.expectedDelta(pre, params, {
      nowEpoch,
      todayIso,
      ...(effectiveZone !== undefined && { zone: effectiveZone }),
    });

    if (options.dryRun === true) {
      // DACON1: preview the off-rule-first disclosure so --dry-run states the same
      // two-phase pattern the executed write would (the dishonored monthly shape is
      // already refused before reaching here).
      const planNotes: string[] = [];
      const dryRuleParams = params as unknown as RepeatRuleParams;
      const dryOffRule = assessOffRuleFirst(
        dryRuleParams,
        preservedDeadlineOffsetFor(pre, dryRuleParams),
      );
      if (dryOffRule?.kind === "honored") planNotes.push(dryOffRule.disclosure.message);
      return {
        kind: "dry-run",
        op,
        plan: {
          op,
          vector: vector.id,
          tier: effectiveTier,
          invocation: invocation.redactedPayload,
          expectedDelta: delta,
          hazardsChecked: spec.hazards,
          ...(planNotes.length > 0 && { notes: planNotes }),
        },
      };
    }

    // Capture the pre-read once — reused by the pre-drive idempotency check
    // below, the M3 intent record, and the post-verify movement classification.
    const preCapture = capturePre(delta, deps, pre);

    // 5a½. Pre-drive idempotency (ui vector, update/state deltas): the GUI drive
    // is the most disruptive vector (tier 3, foregrounds the app). Before
    // driving, check whether the requested end-state ALREADY holds — a
    // reschedule to the rule the template already carries, a pause of an
    // already-paused repeat. If it does, succeed as a no-op with the observed
    // state and NO GUI drive (0½ defect (a): idempotency-aware, pre-drive
    // direction). This reads the DB only; the app is never launched. Scoped to
    // update/state deltas so a create-mode probe (make-repeating / convert)
    // never short-circuits on a coincidental recent row.
    if (vector.id === "ui" && (delta.mode === "update" || delta.mode === "state")) {
      const preReader = createDbReader(deps.db, deps.now?.() ?? new Date(), deps.zone);
      const preEval = evaluateDelta(delta, preReader, preCapture);
      if (preEval.satisfied) {
        const uuid = delta.uuid;
        audit({
          result: "ok",
          vector: vector.id,
          disruption: effectiveTier,
          invocation: invocation.redactedPayload,
          pre: flattenPreFields(preCapture.fields),
          observed: preEval.observed,
          verify: { attempts: 0, elapsedMs: 0 },
          uuid,
        });
        return {
          kind: "ok",
          op,
          uuid,
          ...(pre.target !== null && { title: pre.target.title }),
          observed: preEval.observed,
          vector: vector.id,
          tier: effectiveTier,
          // No undoToken: nothing changed, so there is nothing to invert.
          warnings: [
            "the item was already in the requested state — no GUI drive was performed (idempotent no-op)",
          ],
        };
      }
    }

    // 5b. Shortcuts availability gate: the proxy the invocation names must be
    // installed. A missing proxy is a setup problem, not a failed write — the
    // app is never touched. (Skipped for dry-run above, which only compiles.)
    if (vector.id === "shortcuts" && invocation.shortcut !== undefined) {
      const proxies = (deps.shortcutProxies ?? (() => readShortcutProxies()))();
      if (!proxies.present.includes(invocation.shortcut)) {
        audit({
          result: blockedCode({ reason: "environment" }),
          vector: vector.id,
          disruption: effectiveTier,
          invocation: invocation.redactedPayload,
        });
        return {
          kind: "blocked",
          op,
          reason: "environment",
          detail:
            `the Things proxy shortcut "${invocation.shortcut}" is not installed — this ` +
            "operation is delivered through it",
          remediation: "run `things setup` to install the proxy shortcuts, then retry",
        };
      }
    }

    // 5c. THE WRITE GATE (docs/design/permissions-doctrine.md, Articles I+II).
    // The AppleScript vector sends a real Apple Event, and on a machine macOS
    // has no consent record for, that event IS the dialog. So the standing is
    // established prompt-free first — the deputy's own handshake when it is
    // onboarded, the host app's Automation record otherwise — and anything
    // short of a grant refuses here, before the app is touched. An unknown
    // standing is NOT resolved by trying: that is what `things setup` is for.
    if (vector.sendsAppleEvents === true && vector.simulates !== true) {
      const capability = (deps.writeCapability ?? (() => writeCapabilityDefault()))();
      if (capability.mode === "direct-denied" || capability.mode === "direct-unknown") {
        audit({
          result: blockedCode({ reason: "environment" }),
          vector: vector.id,
          disruption: effectiveTier,
          invocation: invocation.redactedPayload,
        });
        return {
          kind: "blocked",
          op,
          reason: "environment",
          detail: `this operation drives the Things app, and ${capability.detail}`,
          remediation: capability.remediation.join("; "),
        };
      }
    }

    // 5d. THE GUI GATE (docs/design/permissions-doctrine.md, Article IV).
    // Driving the Things window needs Accessibility + Automation → System
    // Events, and those are granted to the HELPER PAIR and to nothing else: on
    // a machine holding neither, the first AX call raises an Accessibility
    // prompt against whatever host app happens to be running us, which is the
    // banned outcome. So standing is established prompt-free (the config key
    // plus the deputy's own handshake) and anything short of it refuses here,
    // naming exactly what is missing. Keyed on the vector's DECLARATION, never
    // on its id — a fake substituted under "ui" drives no GUI and must not be
    // gated on the developer's own TCC state.
    if (vector.drivesGui === true && vector.simulates !== true) {
      const capability = (deps.uiCapability ?? (() => uiCapabilityDefault()))();
      if (!uiAllowed(capability)) {
        audit({
          result: blockedCode({ reason: "environment" }),
          vector: vector.id,
          disruption: effectiveTier,
          invocation: invocation.redactedPayload,
        });
        return {
          kind: "blocked",
          op,
          reason: "environment",
          detail: `this operation drives the Things window, and ${capability.detail}`,
          remediation: capability.remediation.join("; "),
        };
      }
    }

    // 6. Ensure the app is running in the BACKGROUND before dispatch —
    // plain opens and AppleEvents to a closed Things steal focus (A40/A41).
    // A simulating vector applies SQL to a fixture DB and never touches the
    // real app, so it neither needs nor may trigger the background launch.
    // A write can only land through a real transport when Things is up (a
    // command dispatched into a closed app is silently dropped, #486), so a
    // closed app is either launched-and-readied here or — when auto-launch is
    // disabled — refused BEFORE dispatch with a plain environment error.
    if (vector.simulates !== true && !appRunning) {
      if (!config.autoLaunch) {
        audit({ result: blockedCode({ reason: "environment" }) });
        return {
          kind: "blocked",
          op,
          reason: "environment",
          likelyCause: "app-not-running",
          detail: "Things is not running, and auto-launch is turned off",
          remediation:
            "open Things (or run `things config set auto-launch true` to let writes launch it), " +
            "then retry",
        };
      }
      const running = await (
        deps.ensureRunning ??
        ((ar: boolean) =>
          defaultEnsureRunning(ar, {
            ...(deps.dbPath !== undefined && { dbPath: deps.dbPath }),
            ...(deps.appReady !== undefined && { appReady: deps.appReady }),
          }))
      )(appRunning);
      if (!running) {
        audit({ result: blockedCode({ reason: "environment" }) });
        return {
          kind: "blocked",
          op,
          reason: "environment",
          likelyCause: "app-not-running",
          detail: "Things did not become available after a background launch attempt",
          remediation: "launch Things manually and retry",
        };
      }
    }

    // 7. Execute + verify. The environment tuple diff feeds failure
    // attribution (a changed tuple is the classic consent re-prompt trigger)
    // and, on success, a warning + refreshed recording.
    const envChanges: EnvironmentChange[] =
      deps.environment !== undefined
        ? diffEnvironment(deps.environment.load(), deps.environment.capture())
        : [];

    // M3 durability: record the INTENT to mutate BEFORE the app is touched.
    // The guards have passed and the invocation is compiled, so this carries
    // op/uuid/actor/redacted invocation/startedAt (+ the captured pre-state).
    // If the process dies between vector.execute and the final record below,
    // this intent has no matching final sibling (same ts+op+actor+host) — the
    // ONLY evidence the mutation may have landed. `things doctor` surfaces such
    // orphans; the final record written after verify supersedes this one.
    // (dry-run returned above, so nothing is recorded for a dry-run — preserved.)
    const intentUuid =
      delta.mode === "update" || delta.mode === "state"
        ? delta.uuid
        : delta.mode === "ordering"
          ? (delta.subject ?? null)
          : null;
    audit({
      result: "intent",
      vector: vector.id,
      disruption: effectiveTier,
      invocation: invocation.redactedPayload,
      pre: flattenPreFields(preCapture.fields),
      uuid: intentUuid,
    });

    // Mark the write as touching the app (read by the CLI's signal handler so a
    // SIGTERM/SIGINT can name the exact op — and last UI step — it interrupted,
    // TRACE1 #487) and open the execute stage in the trace. Cleared the moment
    // execute returns, whatever the outcome.
    setInflight({
      op,
      uuid: intentUuid,
      vector: vector.id,
      uiDrive: vector.id === "ui",
      startedAt: (deps.now?.() ?? new Date()).getTime(),
    });
    trace(() => ({
      phase: "stage",
      stage: "execute-start",
      op,
      vector: vector.id,
      tier: effectiveTier,
    }));
    let executeResult: ExecuteResult;
    try {
      executeResult = await vector.execute(invocation);
    } finally {
      setInflight(null);
    }
    trace(() => ({
      phase: "stage",
      stage: "execute-done",
      op,
      exitCode: executeResult.exitCode,
      timedOut: executeResult.timedOut === true,
      ...(executeResult.watchdog !== undefined && { watchdog: executeResult.watchdog }),
    }));

    // A vector that REFUSED at runtime before touching the app (the ui vector's
    // session-reachability gate: a locked / full-screen session leaves no
    // AX-reachable Things window for the dialog, SESSGATE #480). Nothing was
    // mutated → a `blocked` outcome (exit 4), never a transport failure.
    if (executeResult.blocked !== undefined) {
      const { hazard, detail, remediation } = executeResult.blocked;
      audit({
        result: blockedCode({ hazard, reason: "hazard" }),
        vector: vector.id,
        disruption: effectiveTier,
        invocation: invocation.redactedPayload,
        pre: flattenPreFields(preCapture.fields),
      });
      return { kind: "blocked", op, reason: "hazard", hazard, detail, remediation };
    }

    // Verify under the injected clock (deps.now/deps.zone), never the wall
    // clock: an `evening`/`today` write dated pinned-today must read back IN
    // Today at verify time, or its today/evening marker assertion fails under a
    // pinned THINGS_NOW (bench-caught #211 regression).
    const reader = createDbReader(deps.db, deps.now?.() ?? new Date(), deps.zone);
    const timeoutMs = options.verifyTimeoutMs ?? (appRunning ? 6000 : 10_000);

    let outcome: PollOutcome;
    // Whether a nonzero-transport drive was RESCUED by the recovery re-verify —
    // the change landed despite the reported failure (surfaced as a loud warning
    // on the ok result so the caller does NOT retry and clobber it).
    let transportRecovered = false;
    if (executeResult.exitCode !== 0 || executeResult.timedOut === true) {
      // The transport reported failure (nonzero exit / deadline kill). A GUI
      // drive can abort PART-WAY yet still have LANDED the change — the
      // field-report incident (0½ (a)): the after-completion unit step errored on
      // a pluralized menu item, but the dialog had already inherited the correct
      // unit/interval, so the rule was applied before the abort. Rather than
      // declaring the write lost (and inviting a clobbering retry), RE-VERIFY
      // with bounded backoff and treat a landed target state as SUCCESS.
      const recovery = await pollUntilVerified(
        () => evaluateDelta(delta, reader, preCapture),
        RECOVERY_VERIFY_TIMEOUT_MS,
        deps.poller ?? {},
      );
      if (recovery.kind !== "ok") {
        // The ui-drive WATCHDOG timeout is its own honest outcome (TRACE1 #487):
        // the CLI gave up first and cleared the dialog, but a drive aborted while
        // the OK was possibly mid-commit cannot promise the app is untouched — so
        // it is reported UNCERTAIN with the trace path and a "re-check first"
        // remediation, distinct from a plain transport failure with no landed change.
        const wd = executeResult.watchdog;
        if (wd !== undefined) {
          audit({
            result: verifyFailedCode({ reason: "timeout" }),
            vector: vector.id,
            disruption: effectiveTier,
            invocation: invocation.redactedPayload,
            pre: flattenPreFields(preCapture.fields),
            observed: recovery.observed,
          });
          const budgetS = Math.round(wd.budgetMs / 1000);
          const elapsedS = Math.round(wd.elapsedMs / 1000);
          const cleared =
            wd.clear === "dismissed"
              ? "the open dialog was dismissed"
              : wd.clear === "cleared-blind"
                ? "the Things window was closed and reopened to clear the open dialog"
                : "a dialog may still be open in Things";
          const traceNote =
            wd.tracePath != null && wd.tracePath !== ""
              ? ` The step timeline is at ${wd.tracePath}.`
              : "";
          return {
            kind: "verify-failed" as const,
            op,
            reason: "timeout" as const,
            expected: delta,
            observed: recovery.observed,
            detail:
              `the GUI drive ran past its ${budgetS}s budget at step "${wd.lastStep}" (after ` +
              `~${elapsedS}s) and the CLI stopped it before the change could be confirmed; ` +
              `${cleared}. The outcome is UNCERTAIN — a rule committed at the last moment could ` +
              `still appear — so re-check with \`things show ${intentUuid ?? "<uuid>"}\` before ` +
              `retrying (retrying could create a duplicate series).${traceNote}`,
            uncertain: true as const,
            ...(wd.tracePath != null && wd.tracePath !== "" && { tracePath: wd.tracePath }),
          };
        }
        audit({
          result: verifyFailedCode({ reason: "silent-noop" }),
          vector: vector.id,
          disruption: effectiveTier,
          invocation: invocation.redactedPayload,
          pre: flattenPreFields(preCapture.fields),
          observed: recovery.observed,
        });
        return withHint(
          {
            kind: "verify-failed" as const,
            op,
            reason: "silent-noop" as const,
            expected: delta,
            observed: recovery.observed,
            detail:
              `transport failed (exit ${executeResult.exitCode ?? "?"}${executeResult.timedOut === true ? ", timed out" : ""})` +
              `${executeResult.stderr.trim() !== "" ? `: ${executeResult.stderr.trim()}` : ""}` +
              " — and a follow-up re-read found no landed change",
          },
          classifyTransportFailure({
            vector: vector.id,
            stderr: executeResult.stderr,
            timedOut: executeResult.timedOut === true,
            environmentChanges: envChanges,
          }),
        );
      }
      outcome = recovery;
      transportRecovered = true;
    } else if (options.skipVerify === true) {
      // A clean transport with verify deliberately skipped (a bounce round-trip
      // leg): treat it as ok without polling the DB. The orchestrator asserts the
      // real delta once per round-trip. Fail-loud on transport is preserved above.
      outcome = { kind: "ok", observed: null, attempts: 0, elapsedMs: 0 };
    } else {
      outcome = await pollUntilVerified(
        () => evaluateDelta(delta, reader, preCapture),
        timeoutMs,
        deps.poller ?? {},
      );
    }

    trace(() => ({
      phase: "stage",
      stage: "verify",
      op,
      kind: outcome.kind,
      attempts: outcome.attempts,
      elapsedMs: outcome.elapsedMs,
      recovered: transportRecovered,
    }));

    const auditCommon = {
      vector: vector.id,
      disruption: effectiveTier,
      invocation: invocation.redactedPayload,
      pre: flattenPreFields(preCapture.fields),
      observed: outcome.observed,
      verify: { attempts: outcome.attempts, elapsedMs: outcome.elapsedMs },
    };

    if (outcome.kind === "ok") {
      const uuid =
        outcome.discoveredUuid ??
        (delta.mode === "update" || delta.mode === "state"
          ? delta.uuid
          : delta.mode === "ordering"
            ? (delta.subject ?? null)
            : null);
      // --preserve-modified: after the change verifies, restore the pre-write
      // `userModificationDate` of every pre-existing TARGET row the op BUMPED, so
      // the edit stays off the umd-keyed `changes`/watch timeline (TAGMOD T5).
      // The pre-read already captured each asserted/cascade row's umd
      // (preCapture.modDates); a null capture is a row the op CREATED (skip it),
      // and a row whose umd did not rise needs no restore (a silent op — no-op).
      // Best-effort: a failed restore is disclosed per row, never fatal (the
      // mutation already stands). The captured pre-values ride the audit record
      // when the flag is active (enables a future symmetric undo).
      let preserve: { restored: number; failures: PreserveModifiedFailure[] } | null = null;
      let preModDatesAudit: PreModDates | undefined;
      if (options.preserveModified === true) {
        const postReader = createDbReader(deps.db, deps.now?.() ?? new Date(), deps.zone);
        const captured: PreModDates = {};
        const targets: ModRestoreTarget[] = [];
        for (const [tUuid, preUmd] of Object.entries(preCapture.modDates)) {
          captured[tUuid] = preUmd;
          if (preUmd === null) continue; // a row the op created — legitimately new umd
          const post = postReader.modDateOf(tUuid);
          if (post !== null && post > preUmd) targets.push({ uuid: tUuid, preUmd });
        }
        if (Object.keys(captured).length > 0) preModDatesAudit = captured;
        preserve = await restoreModDates(deps.db, deps.vectors, targets);
      }
      audit({
        ...auditCommon,
        result: "ok",
        uuid,
        ...(preModDatesAudit !== undefined && { preModDates: preModDatesAudit }),
      });
      if (deps.environment !== undefined) {
        deps.environment.record(deps.environment.capture());
      }
      // Deleting a repeating TEMPLATE is allowed (byte-identical to the GUI's own
      // Edit ▸ Delete, SERDEL S1) but is IRREVERSIBLE headlessly — the app forbids
      // restoring a template out to a list (AS 301), so its only revival is Trash ▸
      // Put Back. Treat it like an irreversible op (no undo token) and disclose the
      // consequences below. Trashing an INSTANCE (no rule of its own) is unaffected.
      const templateDelete =
        (op === "todo.delete" || op === "project.delete") && isRepeatingTemplate(pre.target);
      // The undo token identifies THIS record on the trail (see undoToken); a
      // leg's token would be its shared txn id, but legs are never undone
      // directly, so we only surface it for non-leg writes. Irreversible ops get
      // NO token: `undo --txn` can only refuse it, so emitting one is misleading.
      const resultToken =
        options.txn?.role === "leg" || REVERSIBILITY[op].class === "irreversible" || templateDelete
          ? undefined
          : undoToken({
              ts: startedAt.toISOString(),
              op,
              actor,
              host: config.host,
              uuid,
              ...(options.txn !== undefined && { txn: options.txn }),
            });
      const warnings: string[] = [];
      // Auto-launch disclosure (#486): the app was not running when this write
      // started, so it was background-launched for the write. Never silent — a
      // side effect the caller should see (a simulating vector never launches).
      if (!appRunning && vector.simulates !== true) {
        warnings.push(
          "Things was not running, so it was launched in the background for this write",
        );
      }
      // Template-delete disclosure (public deletes only — internal trash-both legs
      // run under a txn and aggregate their own result). The series stops, its live
      // instances are left in place (count + name the current occurrence), and the
      // only revival is the app's Trash ▸ Put Back.
      if (templateDelete && options.txn?.role !== "leg" && pre.target !== null) {
        const kindNoun = op === "project.delete" ? "project" : "to-do";
        const series = liveSeriesInstances(deps.db, pre.target.uuid);
        warnings.push("this repeating series will no longer generate new occurrences");
        if (series.count > 0) {
          warnings.push(
            `its ${series.count} existing occurrence${series.count === 1 ? " was" : "s were"} ` +
              "left in place (not moved to the Trash)" +
              (series.currentUuid !== null ? ` — the current one is ${series.currentUuid}` : ""),
          );
        }
        warnings.push(
          `this cannot be undone here — to bring the series back, use the Things app's Trash ` +
            `(Put Back on the ${kindNoun})`,
        );
      }
      if (transportRecovered) {
        warnings.push(
          "the GUI drive reported a transport error, but a follow-up re-read confirmed the " +
            "requested change DID land — no retry is needed (retrying could overwrite it)",
        );
      }
      if (outcome.repeatingWarnings !== undefined) warnings.push(...outcome.repeatingWarnings);
      // DACON1 off-rule-first disclosure (reschedule-repeat): an explicit anchor
      // that disagrees with --when lands an OFF-RULE first occurrence (honored for
      // weekly/yearly). State both halves of the landed pattern; the dishonored
      // monthly shape was already refused at validation. (make/add-repeating carry
      // their own disclosure via the promote result.)
      if (op === "todo.reschedule-repeat" || op === "project.reschedule-repeat") {
        const offRuleParams = params as unknown as RepeatRuleParams;
        const offRule = assessOffRuleFirst(
          offRuleParams,
          preservedDeadlineOffsetFor(pre, offRuleParams),
        );
        if (offRule?.kind === "honored") warnings.push(offRule.disclosure.message);
      }
      // #V11 heading-reorder disclosure: re-ranking an archived heading also
      // un-archives it (status→open). Never silent — name every reopened heading.
      if (pre.headingMove !== null && pre.headingMove.reopened.length > 0) {
        warnings.push(
          "re-ranking these archived heading(s) brought them back to open " +
            `(un-archived): ${pre.headingMove.reopened.join(", ")} — repositioning an ` +
            "archived heading reopens it; their children stay resolved",
        );
      }
      if (vector.id === "ui") {
        warnings.push(
          "this change was applied by driving the local Things app through the Accessibility API",
        );
        // Surface the drive's own step summary (e.g. how a sidebar move was
        // performed: one drag / scroll-while-held / N hops) — behavior detail
        // the caller can log, and the lab's certification evidence.
        const driveSummary = executeResult.stdout.trim();
        if (driveSummary !== "") warnings.push(driveSummary);
        const cert = certificationOf(op);
        if (cert !== undefined && cert.status !== "certified") {
          warnings.push(
            `this operation is ${cert.status}: its GUI recipe has not been confirmed on real ` +
              "hardware (see `things doctor` / docs/lab/ui-certification-runbook.md)",
          );
        }
      }
      if (envChanges.length > 0) {
        warnings.push(
          `environment changed since the last verified write: ` +
            `${describeEnvironmentChanges(envChanges)} — the first use of another ` +
            `capability may show a macOS consent prompt`,
        );
      }
      // HINTS1 completion-context: on a verified complete/cancel of a to-do,
      // attach the remaining OPEN work in its project and/or Today. Applicability
      // is read off the captured pre-state, so a to-do in neither costs no extra
      // reads; the counts are a cheap post-verify re-read via the library's own
      // read paths.
      const completionContext: CompletionContext | undefined =
        op === "todo.complete" || op === "todo.cancel"
          ? computeCompletionContext(deps.db, pre.target, deps.now?.() ?? new Date(), deps.zone)
          : undefined;
      trace(() => ({ phase: "result", op, kind: "ok", uuid, vector: vector.id }));
      return {
        kind: "ok",
        op,
        uuid,
        // Echo the mutated item's title (ADDITIVE) whenever the op resolved a
        // single pre-existing target — its pre-write title. Uniform across the
        // whole single-item family (complete/cancel/reopen/update/move/…); absent
        // for create/reorder ops, which have no such target.
        ...(pre.target !== null && { title: pre.target.title }),
        observed: outcome.observed,
        vector: vector.id,
        tier: effectiveTier,
        ...(resultToken !== undefined && { undoToken: resultToken }),
        ...(outcome.repeating !== undefined && { repeating: outcome.repeating }),
        // Disclose --preserve-modified only when it did real work (restored a
        // bump or hit a restore failure) — a create-only / already-silent op
        // stays clean (no `preservedModified: 0` noise).
        ...(preserve !== null &&
          (preserve.restored > 0 || preserve.failures.length > 0) && {
            preservedModified: preserve.restored,
          }),
        ...(preserve !== null &&
          preserve.failures.length > 0 && { preserveFailures: preserve.failures }),
        ...(completionContext !== undefined && { context: completionContext }),
        ...(warnings.length > 0 && { warnings }),
      };
    }

    audit({ ...auditCommon, result: verifyFailedCode({ reason: outcome.kind }) });
    return withHint(
      {
        kind: "verify-failed" as const,
        op,
        reason: outcome.kind,
        expected: delta,
        observed: outcome.observed,
        detail:
          outcome.detail ??
          (outcome.kind === "silent-noop"
            ? "no observable change in the database (the app accepted the command but did nothing)"
            : outcome.kind === "timeout"
              ? "something moved but the expected state never appeared within the timeout"
              : "the database reached a state contradicting the expected delta"),
      },
      classifyVerifyFailure({
        reason: outcome.kind,
        vector: vector.id,
        urlSchemeEnabled: (deps.urlSchemeEnabled ?? (() => readUrlSchemeEnabled().enabled))(),
        appWasRunning: appRunning,
        environmentChanges: envChanges,
      }),
    );
  } finally {
    lock.release();
  }
}

/**
 * Build the single-op idempotency REPLAY result from the matched audit record —
 * a `kind: "ok"` MutationResult that did not execute (`alreadyApplied: true`),
 * echoing the ORIGINAL mutation's identity. Mirrors the pipeline's own
 * result-shaping: the `undoToken` is surfaced under the SAME rule the executor
 * uses (only for a non-leg, reversible op — an irreversible op or a batch leg
 * carries none), and `title` rides `requested.title` when the record stored one
 * (the audit record has no dedicated title field — see the trail-record note).
 */
export function replayResultFromRecord(record: AuditRecord): MutationResult {
  const op = record.op as OperationKind;
  const reversible = REVERSIBILITY[op]?.class !== "irreversible";
  const token =
    record.txn?.role === "leg" || !reversible
      ? undefined
      : undoToken({
          ts: record.ts,
          op: record.op,
          actor: record.actor,
          host: record.host,
          uuid: record.uuid,
          ...(record.txn !== undefined && { txn: record.txn }),
        });
  const title = record.requested["title"];
  return {
    kind: "ok",
    op,
    uuid: record.uuid,
    ...(typeof title === "string" && { title }),
    observed: record.observed,
    vector: (record.vector ?? "url-scheme") as VectorId,
    tier: (record.disruption ?? 0) as DisruptionTier,
    ...(token !== undefined && { undoToken: token }),
    alreadyApplied: true,
  };
}

export function fingerprintLabel(
  fp: FingerprintStatus,
  config: ThingsApiConfig,
): "ok" | "drift" | "user-accepted" | "unknown" {
  if (fp.kind === "ok") return "ok";
  if (fp.kind === "unknown-version") return "unknown";
  return config.acceptedFingerprint === fp.observation.fingerprint ? "user-accepted" : "drift";
}

function flattenPreFields(
  fields: Record<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const uuids = Object.keys(fields);
  if (uuids.length === 0) return null;
  if (uuids.length === 1) {
    const only = uuids[0];
    return only === undefined ? null : (fields[only] ?? null);
  }
  return fields;
}
