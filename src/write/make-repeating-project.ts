/**
 * project.make-repeating + project.create-repeating orchestrators (UIC4).
 *
 * make-repeating drives a project into a repeating series purely via AX: the
 * project is selected as a content-table ROW (settable AXSelectedRows, UIC4-a),
 * then Items ▸ Repeat… opens the same dialog the to-do op uses. The row is
 * reachable in the project's AREA view or the SOMEDAY view, but an area-less
 * ANYTIME project renders as a header there (UIC4-d) — this orchestrator coerces
 * it to Someday first (a cleanup-free intermediate step, UIC4-c/d: make-repeating
 * normalizes start to someday regardless, so the coercion leaves no residue),
 * then delegates to the pure-AX drive. The area / someday cases need no coercion
 * and delegate directly.
 *
 * create-repeating is the two-step composite (UIC4-f roadmap ruling #2): create
 * the project seeded into a pure-AX taxonomy (an area, or Someday), THEN promote
 * it with make-repeating. The two legs are NOT atomic — the created project
 * persists even if the promote refuses.
 */
import type { AuditRecord } from "../audit/schema.ts";
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import { assertRepeatRule } from "./commands.ts";
import type { ProjectCreateRepeatingParams, RepeatRuleParams } from "./operations.ts";
import { classifyProjectRepeat, loadTarget, type ProjectRepeatTaxonomy } from "./pre-state.ts";
import {
  fingerprintLabel,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";

/** The two-key GUI-drive block, shared by both orchestrators (mirrors H-UI-DRIVE). */
function blockedUiDrive(op: "project.make-repeating" | "project.create-repeating"): MutationResult {
  return {
    kind: "blocked",
    op,
    reason: "hazard",
    hazard: "H-UI-DRIVE",
    detail:
      "this operation drives the local Things app through the Accessibility API — the project " +
      "row-selection, menu press, and Repeat dialog all run through the Accessibility tree",
    remediation:
      "pass dangerouslyDriveGui (--dangerously-drive-gui) to proceed; the vector also requires " +
      "`things config set ui-enabled true` and Accessibility granted to this process (see docs/setup.md)",
  };
}

/** Translate a refusal taxonomy into a blocked result (the guard's user-facing shape). */
function blockedRefusal(tax: Extract<ProjectRepeatTaxonomy, { kind: "refuse" }>): MutationResult {
  if (tax.refusal === "not-a-project") {
    return {
      kind: "blocked",
      op: "project.make-repeating",
      reason: "hazard",
      hazard: "H-UNKNOWN-DESTINATION",
      detail: `${tax.detail} — project.make-repeating needs an existing project`,
      remediation:
        "verify the uuid with `things projects`, or use `things todo make-repeating` for a to-do",
    };
  }
  const remediation =
    tax.refusal === "ambiguous-row"
      ? "rename one of the same-titled projects so the target's row is unambiguous"
      : tax.refusal === "already-repeating"
        ? "the project already repeats — use `things project reschedule-repeat` to change its rule"
        : "target an open, un-trashed project";
  return {
    kind: "blocked",
    op: "project.make-repeating",
    reason: "hazard",
    hazard: "H-PROJECT-REPEAT",
    detail: tax.detail,
    remediation,
  };
}

/** A per-run txn id (matches the pipeline's leg/summary grouping). */
function newTxnId(now: Date): string {
  return `txn-${now.getTime().toString(36)}-${process.pid.toString(36)}`;
}

/** Forward the caller's audit/timeout knobs onto a delegated leg. */
function legOptions(
  base: WriteOptions,
  txn: { id: string; role: "leg" },
  vector?: "url-scheme" | "ui",
): WriteOptions {
  const out: WriteOptions = { txn };
  if (vector !== undefined) out.vector = vector;
  if (base.actor !== undefined) out.actor = base.actor;
  if (base.verifyTimeoutMs !== undefined) out.verifyTimeoutMs = base.verifyTimeoutMs;
  if (base.maxDisruption !== undefined) out.maxDisruption = base.maxDisruption;
  if (base.dangerouslyDriveGui !== undefined) out.dangerouslyDriveGui = base.dangerouslyDriveGui;
  return out;
}

export async function runMakeRepeatingProject(
  deps: WriteDeps,
  params: RepeatRuleParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const uuid = resolveTaskUuidPrefix(deps.db, params.uuid);
  // Validate the rule BEFORE any coercion — a bad rule must never leave a
  // coerced-to-someday project stranded.
  assertRepeatRule(params);

  const target = loadTarget(deps.db, uuid);
  const tax = classifyProjectRepeat(deps.db, target);
  if (tax.kind === "refuse") return blockedRefusal(tax);

  // The GUI-drive ack gates the coercion decision too: block before touching
  // anything if it is missing (the delegated drive would block anyway, but the
  // anytime path must not coerce first only to be blocked at the drive).
  if (options.dangerouslyDriveGui !== true && options.dryRun !== true) {
    return blockedUiDrive("project.make-repeating");
  }

  const driveParams: RepeatRuleParams = {
    uuid,
    frequency: params.frequency,
    interval: params.interval,
    ...(params.afterCompletion !== undefined && { afterCompletion: params.afterCompletion }),
    ...(params.weekdays !== undefined && { weekdays: params.weekdays }),
    ...(params.monthly !== undefined && { monthly: params.monthly }),
    ...(params.yearly !== undefined && { yearly: params.yearly }),
    ...(params.ends !== undefined && { ends: params.ends }),
    ...(params.reminder !== undefined && { reminder: params.reminder }),
    ...(params.deadline !== undefined && { deadline: params.deadline }),
    ...(params.startDaysEarlier !== undefined && { startDaysEarlier: params.startDaysEarlier }),
  };

  if (options.dryRun === true) {
    const coercion =
      tax.kind === "anytime"
        ? `coerce to Someday (update-project?id=${uuid}&when=someday) → verified → `
        : "";
    const view = tax.kind === "area" ? `area ${tax.containerReveal}` : "Someday";
    return {
      kind: "dry-run",
      op: "project.make-repeating",
      plan: {
        op: "project.make-repeating",
        vector: "ui",
        tier: 3,
        invocation:
          `${coercion}reveal ${view} → select the project row (AXSelectedRows) → Items ▸ Repeat… → ` +
          `frequency=${params.frequency}, interval=${params.interval} → OK`,
        expectedDelta: {
          mode: "create",
          probe: { title: tax.title, type: "project", sinceEpoch: 0 },
          assert: [{ field: "repeating.isTemplate", equals: true }],
        },
        hazardsChecked: ["H-UNKNOWN-DESTINATION", "H-PROJECT-REPEAT", "H-UI-DRIVE"],
      },
    };
  }

  // area / someday: no coercion — the single pure-AX drive IS the mutation.
  if (tax.kind === "area" || tax.kind === "someday") {
    return runMutation(deps, "project.make-repeating", driveParams, { ...options, vector: "ui" });
  }

  // area-less anytime: coerce to Someday (cleanup-free, UIC4-c/d) then drive,
  // grouped as one txn with a single undoable SUMMARY record.
  const startedAt = deps.now?.() ?? new Date();
  const txnId = newTxnId(startedAt);
  const coerce = await runMutation(
    deps,
    "project.update",
    { uuid, when: "someday" },
    legOptions(options, { id: txnId, role: "leg" }, "url-scheme"),
  );
  if (coerce.kind !== "ok") {
    // Nothing was promoted; the coercion itself failed or was blocked — surface it.
    return coerce.kind === "blocked"
      ? coerce
      : {
          kind: "verify-failed",
          op: "project.make-repeating",
          reason: coerce.kind === "verify-failed" ? coerce.reason : "mismatch",
          expected:
            coerce.kind === "verify-failed"
              ? coerce.expected
              : { mode: "update", uuid, assert: [] },
          observed: coerce.kind === "verify-failed" ? coerce.observed : null,
          detail:
            "the Someday coercion (the intermediate step for an area-less Anytime project) failed — " +
            "the project was NOT made repeating and its schedule is unchanged",
        };
  }

  const drive = await runMutation(
    deps,
    "project.make-repeating",
    driveParams,
    legOptions(options, { id: txnId, role: "leg" }, "ui"),
  );
  if (drive.kind !== "ok") {
    // Non-atomic residue: the project IS now in Someday but was not promoted.
    // make-repeating normalizes start to someday anyway (UIC4-c), so this is not
    // a corruption — just an incomplete op. Report it honestly.
    return drive;
  }

  appendSummary(deps, {
    startedAt,
    uuid: drive.uuid,
    txnId,
    invocation: `make-repeating(project, coerced from anytime) id=${uuid} → template ${drive.uuid ?? "?"}`,
  });
  return { ...drive, ...(drive.warnings !== undefined && { warnings: drive.warnings }) };
}

export async function runCreateRepeatingProject(
  deps: WriteDeps,
  params: ProjectCreateRepeatingParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  // create-repeating carries only the base rule vocabulary (the promote can be
  // followed by a reschedule for a richer rule); validate just that.
  assertRepeatRule({ frequency: params.frequency, interval: params.interval });

  // The promote drives the GUI — block before creating anything if the ack is missing.
  if (options.dangerouslyDriveGui !== true && options.dryRun !== true) {
    return blockedUiDrive("project.create-repeating");
  }

  // Seed a pure-AX taxonomy: an area lands a selectable AREA-view row; otherwise
  // create in Someday (UIC4-f) so the promote skips the anytime-header problem.
  const seedWhen = params.area === undefined ? "someday" : undefined;

  if (options.dryRun === true) {
    const where = params.area !== undefined ? "the target area (Anytime)" : "Someday";
    return {
      kind: "dry-run",
      op: "project.create-repeating",
      plan: {
        op: "project.create-repeating",
        vector: "ui",
        tier: 3,
        invocation:
          `create project "${params.title}" in ${where} (persists on its own) → then make-repeating ` +
          `(select row → Items ▸ Repeat… → frequency=${params.frequency}, interval=${params.interval})`,
        expectedDelta: {
          mode: "create",
          probe: { title: params.title, type: "project", sinceEpoch: 0 },
          assert: [{ field: "repeating.isTemplate", equals: true }],
        },
        hazardsChecked: ["H-UI-DRIVE"],
      },
    };
  }

  const startedAt = deps.now?.() ?? new Date();
  const txnId = newTxnId(startedAt);

  const add = await runMutation(
    deps,
    "project.add",
    {
      title: params.title,
      ...(params.notes !== undefined && { notes: params.notes }),
      ...(params.area !== undefined && { area: params.area }),
      ...(seedWhen !== undefined && { when: seedWhen }),
      ...(params.deadline !== undefined && { deadline: params.deadline }),
      ...(params.todos !== undefined && { todos: params.todos }),
    },
    legOptions(options, { id: txnId, role: "leg" }, "url-scheme"),
  );
  if (add.kind !== "ok" || add.uuid === null) {
    return add.kind === "ok"
      ? {
          kind: "verify-failed",
          op: "project.create-repeating",
          reason: "mismatch",
          expected: {
            mode: "create",
            probe: { title: params.title, type: "project", sinceEpoch: 0 },
            assert: [],
          },
          observed: null,
          detail:
            "the project was created but its uuid was not discovered — cannot promote it to repeating",
        }
      : add;
  }

  const promote = await runMakeRepeatingProject(
    deps,
    { uuid: add.uuid, frequency: params.frequency, interval: params.interval },
    legOptions(options, { id: txnId, role: "leg" }, "ui"),
  );
  if (promote.kind !== "ok") {
    // Honest: the project was created (and persists) but the promote did not land.
    return promote;
  }

  appendSummary(deps, {
    startedAt,
    uuid: promote.uuid,
    txnId,
    op: "project.create-repeating",
    invocation: `create-repeating project "${params.title}" → template ${promote.uuid ?? "?"}`,
  });
  return { ...promote, op: "project.create-repeating" };
}

// --------------------------------------------------------------------- audit

function appendSummary(
  deps: WriteDeps,
  args: {
    startedAt: Date;
    uuid: string | null;
    txnId: string;
    op?: "project.make-repeating" | "project.create-repeating";
    invocation: string;
  },
): void {
  const fp = deps.fingerprint();
  const record: AuditRecord = {
    v: 1,
    ts: args.startedAt.toISOString(),
    actor: deps.config.actor,
    host: deps.config.host,
    op: args.op ?? "project.make-repeating",
    uuid: args.uuid,
    vector: "ui",
    disruption: 3,
    invocation: args.invocation,
    requested: {},
    txn: { id: args.txnId, role: "summary" },
    pre: null,
    observed: args.uuid !== null ? { uuid: args.uuid } : null,
    result: "ok",
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
