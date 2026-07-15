/**
 * The mutation pipeline: fingerprint gate → lock → pre-read → guards →
 * vector planning → ensure-running → execute → verified read-after-write →
 * audit. Every mutation attempt is audited, including blocked decisions.
 */
import { execFile, execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

import type { AuditWriter } from "../audit/log.ts";
import { undoToken, type AuditRecord } from "../audit/schema.ts";
import type { DisruptionTier, ThingsApiConfig } from "../config.ts";
import type { FingerprintStatus } from "../db/fingerprint.ts";
import { localToday } from "../model/dates.ts";
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import { readShortcutProxies, readUrlSchemeEnabled, type ShortcutsState } from "./availability.ts";
import { COMMANDS, type CommandSpec } from "./commands.ts";
import {
  describeEnvironmentChanges,
  diffEnvironment,
  type EnvironmentChange,
  type EnvironmentTracker,
} from "./environment.ts";
import { sdefDeclaresPrivateReorder } from "./experimental.ts";
import {
  classifyTransportFailure,
  classifyVerifyFailure,
  type FailureHint,
  type LikelyCause,
} from "./failure-hints.ts";
import { evaluateGuards, type GuardBlock, type HazardId } from "./guards.ts";
import { acquireMutationLock, MutationLockError } from "./lock.ts";
import type { Acknowledgements, OperationKind, OperationParamsMap } from "./operations.ts";
import { planVector } from "./planner.ts";
import type { PreState } from "./pre-state.ts";
import { certificationOf } from "./vectors/ui-certification.ts";
import type { CompiledInvocation, VectorId, WriteVector } from "./vectors/types.ts";
import {
  createDbReader,
  evaluateDelta,
  getField,
  type DeltaSpec,
  type PreModDates,
} from "./verify/delta.ts";
import { pollUntilVerified, type PollerDeps } from "./verify/poller.ts";

export interface WriteOptions extends Acknowledgements {
  /** Caps vector selection; defaults from the config profile. */
  maxDisruption?: DisruptionTier;
  /** Force a specific vector (must still be validated + support the op). */
  vector?: VectorId;
  verifyTimeoutMs?: number;
  /** Return the plan without executing (nothing is audited). */
  dryRun?: boolean;
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
}

export interface MutationPlan {
  op: OperationKind;
  vector: VectorId;
  tier: DisruptionTier;
  invocation: string;
  expectedDelta: DeltaSpec;
  hazardsChecked: HazardId[];
}

export type MutationResult =
  | {
      kind: "ok";
      op: OperationKind;
      uuid: string | null;
      observed: Record<string, unknown> | null;
      vector: VectorId;
      tier: DisruptionTier;
      /**
       * The undo token for this mutation (ADDITIVE): pass it to
       * `things undo --txn <token>` (MCP `txn`) to invert exactly this change,
       * unaffected by any other mutations made in between.
       */
      undoToken?: string;
      /** Advisory notes (e.g. a changed environment tuple — consent may re-prompt later). */
      warnings?: string[];
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
    }
  | {
      kind: "blocked";
      op: OperationKind;
      reason: "hazard" | "disruption-tier" | "drift" | "lock" | "environment";
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
  /** Canary seam: does the installed sdef still declare the private command? */
  sdefProbe?: () => boolean;
  /** Consent-churn tripwire: tuple recorded per verified mutation (client wires the default). */
  environment?: EnvironmentTracker;
  /** Seam: on-disk 'Enable Things URLs' state for failure attribution (availability.ts). */
  urlSchemeEnabled?: () => boolean | null;
  /** Seam: installed Things proxy shortcuts, for the pre-dispatch availability gate (availability.ts). */
  shortcutProxies?: () => ShortcutsState;
  now?: () => Date;
  poller?: PollerDeps;
  pkgVersion?: string;
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

function defaultIsAppRunning(): boolean {
  try {
    execFileSync("pgrep", ["-x", "Things3"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Background-launch Things and wait for the process (tier 1, by policy). */
async function defaultEnsureRunning(alreadyRunning: boolean): Promise<boolean> {
  if (alreadyRunning) return true;
  await new Promise<void>((resolve) => {
    execFile("open", ["-g", "-a", "Things3"], () => resolve());
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (defaultIsAppRunning()) {
      // oxlint-disable-next-line no-await-in-loop -- the post-launch settle wait must happen once, right after the process is first detected, before returning
      await new Promise((r) => setTimeout(r, 2000)); // post-launch settle
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- launch-detection retries are inherently sequential polling of the same process state
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
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
  const reader = createDbReader(deps.db);
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
    captureFor(spec.uuid, spec.assert);
    if (spec.mode === "state" && spec.cascade !== undefined) {
      for (const c of spec.cascade) captureFor(c.uuid, c.assert);
    }
  }
  if (spec.mode === "ordering") {
    const preRanks: Record<string, unknown> = {};
    // `capture` may list MORE uuids than the asserted sequence (the full
    // sidebar order for area.reorder-sidebar) so undo can restore the exact
    // previous position from the audit record.
    for (const uuid of spec.capture ?? spec.sequence) {
      preRanks[uuid] = reader.rankOf(uuid, spec.key);
    }
    fields["__ordering__"] = preRanks;
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

export async function runMutation<K extends OperationKind>(
  deps: WriteDeps,
  op: K,
  params: OperationParamsMap[K],
  options: WriteOptions = {},
): Promise<MutationResult> {
  const startedAt = deps.now?.() ?? new Date();
  // Uuid params accept unique PREFIXES (>= 6 chars) — resolved to full uuids
  // here so guards/compiles/audit all see canonical ids. Throws (RangeError)
  // on unknown or ambiguous prefixes, like the title resolvers.
  const p = params as Record<string, unknown>;
  if (typeof p["uuid"] === "string") {
    params = { ...params, uuid: resolveTaskUuidPrefix(deps.db, p["uuid"]) };
  }
  if (Array.isArray(p["uuids"])) {
    params = {
      ...params,
      uuids: (p["uuids"] as string[]).map((u) => resolveTaskUuidPrefix(deps.db, u)),
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
    audit({ result: "blocked:drift" });
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
      audit({ result: "blocked:lock" });
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
    // 3. Pre-read + guards.
    const pre = spec.preRead(deps.db, params, deps.now?.() ?? new Date());
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
      audit({ result: `blocked:${block.hazard}` });
      return {
        kind: "blocked",
        op,
        reason: "hazard",
        hazard: block.hazard,
        detail: block.detail,
        remediation: block.remediation,
      };
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
      audit({ result: "blocked:disruption-tier" });
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
    // Things update — re-check the declaration before every dispatch.
    if (plan.candidate.support.experimental === true) {
      const declared = (deps.sdefProbe ?? sdefDeclaresPrivateReorder)();
      if (!declared) {
        audit({ result: "blocked:environment" });
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
    const token = readAuthToken(deps.db);
    const invocation: CompiledInvocation = spec.compile(params, vector.id, pre, { token });
    const delta = spec.expectedDelta(pre, params, {
      nowEpoch,
      todayIso: localToday(deps.now?.() ?? new Date()),
    });

    if (options.dryRun === true) {
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
        },
      };
    }

    // 5b. Shortcuts availability gate: the proxy the invocation names must be
    // installed. A missing proxy is a setup problem, not a failed write — the
    // app is never touched. (Skipped for dry-run above, which only compiles.)
    if (vector.id === "shortcuts" && invocation.shortcut !== undefined) {
      const proxies = (deps.shortcutProxies ?? (() => readShortcutProxies()))();
      if (!proxies.present.includes(invocation.shortcut)) {
        audit({
          result: "blocked:environment",
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
          remediation: "run `things setup shortcuts` to install the proxy shortcuts, then retry",
        };
      }
    }

    // 6. Ensure the app is running in the BACKGROUND before dispatch —
    // plain opens and AppleEvents to a closed Things steal focus (A40/A41).
    const running = await (deps.ensureRunning ?? defaultEnsureRunning)(appRunning);
    if (!running) {
      audit({ result: "blocked:environment" });
      return {
        kind: "blocked",
        op,
        reason: "environment",
        detail: "Things did not become available after a background launch attempt",
        remediation: "launch Things manually and retry",
      };
    }

    // 7. Execute + verify. The environment tuple diff feeds failure
    // attribution (a changed tuple is the classic consent re-prompt trigger)
    // and, on success, a warning + refreshed recording.
    const envChanges: EnvironmentChange[] =
      deps.environment !== undefined
        ? diffEnvironment(deps.environment.load(), deps.environment.capture())
        : [];

    const preCapture = capturePre(delta, deps, pre);
    const executeResult = await vector.execute(invocation);
    if (executeResult.exitCode !== 0 || executeResult.timedOut === true) {
      audit({
        result: "verify-failed:silent-noop",
        vector: vector.id,
        disruption: effectiveTier,
        invocation: invocation.redactedPayload,
        pre: flattenPreFields(preCapture.fields),
      });
      return withHint(
        {
          kind: "verify-failed" as const,
          op,
          reason: "silent-noop" as const,
          expected: delta,
          observed: null,
          detail: `transport failed (exit ${executeResult.exitCode ?? "?"}${executeResult.timedOut === true ? ", timed out" : ""}): ${executeResult.stderr.trim()}`,
        },
        classifyTransportFailure({
          vector: vector.id,
          stderr: executeResult.stderr,
          timedOut: executeResult.timedOut === true,
          environmentChanges: envChanges,
        }),
      );
    }

    const reader = createDbReader(deps.db);
    const timeoutMs = options.verifyTimeoutMs ?? (appRunning ? 6000 : 10_000);
    const outcome = await pollUntilVerified(
      () => evaluateDelta(delta, reader, preCapture),
      timeoutMs,
      deps.poller ?? {},
    );

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
      audit({ ...auditCommon, result: "ok", uuid });
      if (deps.environment !== undefined) {
        deps.environment.record(deps.environment.capture());
      }
      // The undo token identifies THIS record on the trail (see undoToken); a
      // leg's token would be its shared txn id, but legs are never undone
      // directly, so we only surface it for non-leg writes.
      const resultToken =
        options.txn?.role === "leg"
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
      if (vector.id === "ui") {
        warnings.push(
          "this change was applied by driving the local Things app through the Accessibility API",
        );
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
      return {
        kind: "ok",
        op,
        uuid,
        observed: outcome.observed,
        vector: vector.id,
        tier: effectiveTier,
        ...(resultToken !== undefined && { undoToken: resultToken }),
        ...(warnings.length > 0 && { warnings }),
      };
    }

    audit({ ...auditCommon, result: `verify-failed:${outcome.kind}` });
    return withHint(
      {
        kind: "verify-failed" as const,
        op,
        reason: outcome.kind,
        expected: delta,
        observed: outcome.observed,
        detail:
          outcome.kind === "silent-noop"
            ? "no observable change in the database (the app accepted the command but did nothing)"
            : outcome.kind === "timeout"
              ? "something moved but the expected state never appeared within the timeout"
              : "the database reached a state contradicting the expected delta",
      },
      classifyVerifyFailure({
        reason: outcome.kind,
        vector: vector.id,
        urlSchemeEnabled: (deps.urlSchemeEnabled ?? (() => readUrlSchemeEnabled().enabled))(),
        environmentChanges: envChanges,
      }),
    );
  } finally {
    lock.release();
  }
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
