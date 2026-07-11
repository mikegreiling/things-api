/**
 * todo.clear-dated-reminder orchestrator — two delivery paths, one op.
 *
 * ATOMIC (Shortcuts): `things-proxy-set-detail` Reminder Time = "" clears a
 * dated reminder IN PLACE — startDate untouched, one call, headless, and the
 * ONLY path that works on a repeating template (scf P3b). Preferred whenever
 * the proxies are installed.
 *
 * URL BOUNCE (fallback, NON-REPEATING only): two verified todo.update legs —
 * leg 1 `when=today` (the keyword clear drops the reminder, R07, and moves the
 * item to Today), leg 2 `when=<original date>` (re-dates back; the reminder
 * stays cleared, RC02). Wrapped in a txn with a SUMMARY audit record (op
 * `todo.clear-dated-reminder`); the summary is the single undoable unit, legs
 * are excluded from undo targeting. NOT usable on a repeating template — a URL
 * `when=` on one CRASHES Things (R09), so repeating items are Shortcuts-only.
 *
 * Selection: `--vector shortcuts|url-scheme` forces a path; otherwise the
 * atomic Shortcuts path is used when the proxy is installed, the URL bounce is
 * the fallback for non-repeating dated items when it is not, and a repeating
 * item with the proxy missing is BLOCKED with the setup remediation (never
 * bounced). Both paths leave a reversible audit record (undo re-attaches the
 * reminder via the URL set path — R17/R18).
 */
import type { AuditRecord } from "../audit/schema.ts";
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import type { UuidParams } from "./operations.ts";
import { readShortcutProxies } from "./availability.ts";
import { COMMANDS } from "./commands.ts";
import { evaluateGuards } from "./guards.ts";
import { emptyPreState, isRepeatingTemplate, loadTarget } from "./pre-state.ts";
import {
  fingerprintLabel,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";

const SET_DETAIL_PROXY = "things-proxy-set-detail";

export async function runClearReminder(
  deps: WriteDeps,
  params: UuidParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const uuid = resolveTaskUuidPrefix(deps.db, params.uuid);
  const forced = options.vector;

  // Dry-run previews the primary (atomic Shortcuts) plan unless the caller
  // forces the URL bounce — cheap and host-independent (no proxy probe).
  if (options.dryRun === true && forced !== "url-scheme") {
    return runMutation(
      deps,
      "todo.clear-dated-reminder",
      { uuid },
      { ...options, vector: "shortcuts" },
    );
  }

  // Uniform pre-checks (no reminder to clear / wrong target type) via the op's
  // own hazard set — identical result whichever path we'd pick.
  const target = loadTarget(deps.db, uuid);
  const pre = emptyPreState();
  pre.target = target;
  const block = evaluateGuards(COMMANDS["todo.clear-dated-reminder"].hazards, {
    op: "todo.clear-dated-reminder",
    params: { uuid },
    pre,
    acks: {},
  });
  if (block !== null) {
    appendClearAudit(deps, {
      uuid,
      startedAt: deps.now?.() ?? new Date(),
      result: `blocked:${block.hazard}`,
    });
    return {
      kind: "blocked",
      op: "todo.clear-dated-reminder",
      reason: "hazard",
      hazard: block.hazard,
      detail: block.detail,
      remediation: block.remediation,
    };
  }

  const repeating = isRepeatingTemplate(target);

  if (forced === "url-scheme" && repeating) {
    appendClearAudit(deps, {
      uuid,
      startedAt: deps.now?.() ?? new Date(),
      result: "blocked:H-REPEAT-SCHEDULE",
    });
    return {
      kind: "blocked",
      op: "todo.clear-dated-reminder",
      reason: "hazard",
      hazard: "H-REPEAT-SCHEDULE",
      detail:
        "the URL bounce is unusable on a repeating template — a URL when= re-schedule CRASHES " +
        "Things (R09); only the atomic Shortcuts clear is safe here",
      remediation:
        "install the proxies (`things setup shortcuts`) and omit --vector, or clear it in the app",
    };
  }

  // Repeating items are Shortcuts-only: delegate to the atomic path, which
  // either clears (proxy present) or blocks with the setup remediation
  // (proxy absent) — exactly the desired repeating behavior.
  const useShortcuts =
    forced === "shortcuts"
      ? true
      : forced === "url-scheme"
        ? false
        : repeating
          ? true
          : proxiesInstalled(deps);

  if (useShortcuts) {
    return runMutation(
      deps,
      "todo.clear-dated-reminder",
      { uuid },
      { ...options, vector: "shortcuts" },
    );
  }
  return runBounce(deps, uuid, target, options);
}

function proxiesInstalled(deps: WriteDeps): boolean {
  const state = (deps.shortcutProxies ?? (() => readShortcutProxies()))();
  return state.present.includes(SET_DETAIL_PROXY);
}

// ------------------------------------------------------------------- bounce

async function runBounce(
  deps: WriteDeps,
  uuid: string,
  target: ReturnType<typeof loadTarget>,
  options: WriteOptions,
): Promise<MutationResult> {
  const startedAt = deps.now?.() ?? new Date();
  const originalDate = target !== null && target.type === "to-do" ? target.startDate : null;
  const preReminder = target !== null && target.type === "to-do" ? target.reminder : null;
  if (originalDate === null || preReminder === null) {
    // The guard above already ruled these out; defensive only.
    return {
      kind: "blocked",
      op: "todo.clear-dated-reminder",
      reason: "hazard",
      hazard: "H-NO-REMINDER",
      detail: "the item has no dated reminder to clear via the URL bounce",
      remediation: "target a to-do with a date and a time-of-day reminder",
    };
  }

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op: "todo.clear-dated-reminder",
      plan: {
        op: "todo.clear-dated-reminder",
        vector: "url-scheme",
        tier: 0,
        invocation:
          `bounce: update?id=${uuid}&when=today (clears the reminder, R07) → verified → ` +
          `update?id=${uuid}&when=${originalDate} (re-dates back, RC02) → verified`,
        expectedDelta: {
          mode: "update",
          uuid,
          assert: [
            { field: "reminder", equals: null },
            { field: "startDate", equals: originalDate },
          ],
        },
        hazardsChecked: ["H-NO-REMINDER"],
      },
    };
  }

  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;
  const legOptions: WriteOptions = { vector: "url-scheme", txn: { id: txnId, role: "leg" } };
  if (options.maxDisruption !== undefined) legOptions.maxDisruption = options.maxDisruption;
  if (options.verifyTimeoutMs !== undefined) legOptions.verifyTimeoutMs = options.verifyTimeoutMs;
  if (options.actor !== undefined) legOptions.actor = options.actor;

  const leg1 = await runMutation(
    deps,
    "todo.update",
    { uuid, when: "today", reminder: null },
    legOptions,
  );
  if (leg1.kind !== "ok") {
    appendClearAudit(deps, { uuid, startedAt, result: "verify-failed:mismatch" });
    return {
      kind: "verify-failed",
      op: "todo.clear-dated-reminder",
      reason: "mismatch",
      expected:
        leg1.kind === "verify-failed" ? leg1.expected : { mode: "update", uuid, assert: [] },
      observed: leg1.kind === "verify-failed" ? leg1.observed : null,
      detail:
        "bounce leg 1 (when=today) failed — the item was NOT touched; its dated reminder is " +
        "unchanged. Retry, or clear it via `things setup shortcuts`",
    };
  }

  const leg2 = await runMutation(deps, "todo.update", { uuid, when: originalDate }, legOptions);
  if (leg2.kind !== "ok") {
    // Non-atomic residue: the reminder IS cleared but the item is stranded on
    // Today. Record it (summary as verify-failed) and surface the exact state.
    appendClearAudit(deps, {
      uuid,
      startedAt,
      result: "verify-failed:mismatch",
      observed: { reminder: null, startDate: null },
    });
    return {
      kind: "verify-failed",
      op: "todo.clear-dated-reminder",
      reason: "mismatch",
      expected: { mode: "update", uuid, assert: [{ field: "startDate", equals: originalDate }] },
      observed: leg2.kind === "verify-failed" ? leg2.observed : null,
      detail:
        `bounce leg 2 (when=${originalDate}) failed — the reminder IS cleared but the item is ` +
        `stranded on TODAY (not its original date ${originalDate}). Re-schedule it ` +
        `(\`things todo update ${uuid} --when ${originalDate}\`) to finish`,
    };
  }

  // Both legs verified: write the single undoable SUMMARY record.
  appendClearAudit(deps, {
    uuid,
    startedAt,
    result: "ok",
    pre: { reminder: preReminder, startDate: originalDate },
    observed: { reminder: null, startDate: originalDate },
    txn: { id: txnId, role: "summary" },
    invocation: `bounce(clear-dated-reminder) id=${uuid}`,
  });
  return {
    kind: "ok",
    op: "todo.clear-dated-reminder",
    uuid,
    observed: { reminder: null, startDate: originalDate },
    vector: "url-scheme",
    tier: 0,
  };
}

// --------------------------------------------------------------------- audit

function appendClearAudit(
  deps: WriteDeps,
  args: {
    uuid: string;
    startedAt: Date;
    result: AuditRecord["result"];
    pre?: Record<string, unknown>;
    observed?: Record<string, unknown> | null;
    txn?: { id: string; role: "leg" | "summary" };
    invocation?: string;
  },
): void {
  const fp = deps.fingerprint();
  const record: AuditRecord = {
    v: 1,
    ts: args.startedAt.toISOString(),
    actor: deps.config.actor,
    host: deps.config.host,
    op: "todo.clear-dated-reminder",
    uuid: args.uuid,
    vector: "url-scheme",
    disruption: 0,
    invocation: args.invocation ?? null,
    requested: { uuid: args.uuid },
    ...(args.txn !== undefined && { txn: args.txn }),
    pre: args.pre ?? null,
    observed: args.observed ?? null,
    result: args.result,
    verify: null,
    durationMs: (deps.now?.() ?? new Date()).getTime() - args.startedAt.getTime(),
    env: {
      pkg: deps.pkgVersion ?? "0.0.1",
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fingerprintLabel(fp, deps.config),
    },
  };
  deps.audit.append(record);
}
