/**
 * Batch mutations: N ops through the SAME pipeline as single mutations —
 * every op individually pre-read, guarded, verified, and audited. The wins
 * are amortization (one process, one DB handle, one config load) and a
 * per-op result stream; there is deliberately NO transactional semantics
 * (the app's surfaces have none to offer). Ops run SEQUENTIALLY: the
 * mutation lock serializes them anyway, and create-probe verification must
 * never race.
 *
 * Three chaining/idempotency/undo features ride the same submission:
 *
 *  - temp ids (`tempId`): a per-line handle bound to the op's created uuid once
 *    the leg verifies, so a LATER line can reference it as `"$name"` in any
 *    ref-accepting param (project/area/target/uuid/…). Dotted access reaches an
 *    identity-replacement op's other discovered uuids: `$name.instance` (the
 *    spawned occurrence) and `$name.replaced` (the destroyed source). Refs
 *    resolve STRICTLY (fail-closed) as each leg lands — a `$` value naming no
 *    declared tempId, a forward reference, or a reference to a leg that bound
 *    nothing fails that one line before dispatch; independent later lines run.
 *  - opId (`opId`): a client idempotency id. Before dispatch, a line with an
 *    opId is matched against the recent change history; a prior `ok` record with
 *    the same id means the line is SKIPPED (reported already-applied with the
 *    original uuid, which is bound to the line's tempId) — safe resubmission of
 *    an ambiguously-failed batch without double-creates.
 *  - batch undo token: every leg records under one shared txn, and the batch
 *    writes a summary record whose undo token undoes the WHOLE submission as one
 *    unit (`things undo --txn <token>`), replaying leg inverses in reverse.
 */
import type { AuditRecord } from "../audit/schema.ts";
import { OPERATION_KINDS, type OperationKind, type OperationParamsMap } from "./operations.ts";
import { fingerprintLabel, runMutation, type WriteDeps, type WriteOptions } from "./pipeline.ts";
import { runReorder, type ReorderResult } from "./reorder.ts";
import { readAuditRecords } from "./undo.ts";

/** One line of a batch: the op kind, its params, and per-op options. */
export interface BatchOp {
  op: OperationKind;
  params: Record<string, unknown>;
  /**
   * Client handle for the uuid this op CREATES — a later line references it as
   * `"$tempId"` (or `"$tempId.instance"` / `"$tempId.replaced"`) in any
   * ref-accepting param. Valid only on uuid-minting ops (never `tag.add` — tags
   * have no uuid; reference a tag by its title). `[A-Za-z0-9_-]{1,32}`; unique
   * within one batch.
   */
  tempId?: string;
  /**
   * Client idempotency id: a resubmitted batch whose line carries the same id
   * as a prior successful change is skipped (reported already-applied) instead
   * of re-created. `[A-Za-z0-9_-]{1,64}`.
   */
  opId?: string;
  /** Per-op acknowledgements/overrides (a safe subset of WriteOptions). */
  options?: {
    acknowledgeChecklistReset?: boolean;
    acknowledgeProjectReopen?: boolean;
    dangerouslyPermanent?: boolean;
    acknowledgeTagSubtree?: boolean;
    /**
     * Acknowledge a GUI-driven op (make-repeating, convert-to-project, …) — the
     * second of its two keys. Required for any ui-drive op (several of which are
     * uuid-minting, so tempId-eligible), or the per-leg H-UI-DRIVE gate blocks it.
     */
    dangerouslyDriveGui?: boolean;
    /** Create any missing tag (mkdir-p for parent/child) instead of failing on an unknown tag. */
    createTags?: boolean;
    vector?: WriteOptions["vector"];
    verifyTimeoutMs?: number;
    maxDisruption?: WriteOptions["maxDisruption"];
  };
}

export type BatchItemOutcome =
  | ReorderResult
  | { kind: "invalid"; op: string; detail: string }
  | { kind: "skipped"; op: string; detail: string }
  | {
      /** An idempotency-id match: the op was already applied by an earlier submission. */
      kind: "already-applied";
      op: string;
      uuid: string;
      detail: string;
    };

export interface BatchItemResult {
  index: number;
  op: string;
  outcome: BatchItemOutcome;
  /** Echoed when the op declared a temp id (ADDITIVE). */
  tempId?: string;
  /** The uuid bound to this op's temp id, once the leg minted one (ADDITIVE). */
  boundUuid?: string;
  /** Echoed when the op carried a client idempotency id (ADDITIVE). */
  opId?: string;
}

/** The whole-batch result: the per-op stream plus the batch-level additions. */
export interface BatchResult {
  results: BatchItemResult[];
  /** Every temp id that bound a uuid → that uuid (ADDITIVE; empty when none declared). */
  tempIdMapping: Record<string, string>;
  /**
   * The batch-level undo token — pass it to `things undo --txn <token>` to
   * reverse the WHOLE submission as one unit. Absent for a dry-run, an
   * all-rejected batch, or one where no leg reached the pipeline.
   */
  undoToken?: string;
}

export interface BatchOptions {
  /** Stop at the first non-ok outcome; remaining ops report kind "skipped". */
  failFast?: boolean;
  /** Plan every op without executing (each result is its dry-run plan). */
  dryRun?: boolean;
  actor?: string;
}

const KNOWN_OPS = new Set<string>(OPERATION_KINDS);

/**
 * Ops that MINT a uuid, so may declare a `tempId` — the ratified rule is
 * "anything that creates a new uuid". NB: `tag.add` is deliberately absent (tags
 * have no uuid — identity is the title).
 */
const UUID_MINTING_OPS = new Set<string>([
  "todo.add",
  "todo.add-logged",
  "project.add",
  "project.add-repeating",
  "area.add",
  "heading.add",
  "todo.duplicate",
  "project.duplicate",
  "todo.make-repeating",
  "project.make-repeating",
  "todo.convert-to-project",
  "heading.convert-to-project",
]);

const TEMP_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Param keys whose values are REFERENCES (uuid / name / container) — the only
 * places a `"$temp"` handle is resolved. A value starting with `$` anywhere
 * else (a title, notes) is a literal, never a ref. Container refs nest the id
 * under `.uuid`; `uuids` is a list.
 */
const REF_KEYS = new Set([
  "uuid",
  "uuids",
  "target",
  "before",
  "after",
  "project",
  "area",
  "container",
  "heading",
]);

/** opId idempotency lookback: at most the last 1000 records, and only the last 7 days. */
const OPID_LOOKBACK_RECORDS = 1000;
const OPID_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The discovery uuids a bound temp id can resolve (primary + identity-replacement kin). */
interface Binding {
  primary: string;
  instance: string | null;
  replaced: string | null;
}

/** True when an outcome should be treated as a failure for --fail-fast/exit. */
export function outcomeFailed(outcome: BatchItemOutcome): boolean {
  return outcome.kind !== "ok" && outcome.kind !== "dry-run" && outcome.kind !== "already-applied";
}

/**
 * Pre-flight scan of every declared `tempId`, BEFORE any leg runs. Returns the
 * name→line index of valid declarations and, per offending line, the usage
 * detail. Any declaration error rejects the WHOLE batch (nothing executes) —
 * a temp-id script with a bad/duplicate/misplaced handle is a structural error,
 * like a torn JSONL line.
 */
function validateDeclarations(ops: BatchOp[]): {
  declIndex: Map<string, number>;
  errors: Map<number, string>;
} {
  const declIndex = new Map<string, number>();
  const errors = new Map<number, string>();
  for (let i = 0; i < ops.length; i++) {
    const entry = ops[i];
    if (typeof entry !== "object" || entry === null) continue;
    const tempId = entry.tempId;
    if (tempId === undefined) continue;
    if (entry.op === "tag.add") {
      errors.set(
        i,
        'tempId is not valid on "tag.add": a tag has no uuid to bind — reference a tag by its title instead',
      );
      continue;
    }
    if (!UUID_MINTING_OPS.has(entry.op)) {
      errors.set(
        i,
        `tempId is only valid on an op that creates something (e.g. todo.add, project.add, heading.add) — not "${entry.op}"`,
      );
      continue;
    }
    if (typeof tempId !== "string" || !TEMP_ID_RE.test(tempId)) {
      errors.set(i, "tempId must match [A-Za-z0-9_-] and be 1–32 characters");
      continue;
    }
    const prior = declIndex.get(tempId);
    if (prior !== undefined) {
      errors.set(i, `duplicate tempId "${tempId}" (already declared on line ${prior + 1})`);
      continue;
    }
    declIndex.set(tempId, i);
  }
  return { declIndex, errors };
}

/** Parse a `"$name"` / `"$name.instance"` token into its handle + accessor. */
function parseRef(value: string): { name: string; accessor?: string } {
  const body = value.slice(1); // drop the leading "$"
  const dot = body.indexOf(".");
  if (dot < 0) return { name: body };
  return { name: body.slice(0, dot), accessor: body.slice(dot + 1) };
}

/** Resolve one `$`-token to a uuid, or a fail-closed usage detail. */
function resolveRef(
  value: string,
  declIndex: Map<string, number>,
  bindings: Map<string, Binding>,
  currentIndex: number,
): { ok: true; uuid: string } | { ok: false; detail: string } {
  const { name, accessor } = parseRef(value);
  const declaredAt = declIndex.get(name);
  if (declaredAt === undefined) {
    return {
      ok: false,
      detail: `unresolved-temp-ref: "${value}" names no tempId declared in this batch`,
    };
  }
  const bound = bindings.get(name);
  if (bound === undefined) {
    if (declaredAt > currentIndex) {
      return {
        ok: false,
        detail: `unresolved-temp-ref: "${value}" is a forward reference — tempId "${name}" is declared later (line ${declaredAt + 1})`,
      };
    }
    return {
      ok: false,
      detail: `unresolved-temp-ref: tempId "${name}" bound nothing (its op failed or was skipped) — cannot resolve "${value}"`,
    };
  }
  if (accessor === undefined) return { ok: true, uuid: bound.primary };
  if (accessor === "instance") {
    if (bound.instance === null) {
      return { ok: false, detail: `"${value}" has no spawned-instance uuid to resolve` };
    }
    return { ok: true, uuid: bound.instance };
  }
  if (accessor === "replaced") {
    if (bound.replaced === null) {
      return { ok: false, detail: `"${value}" has no replaced uuid to resolve` };
    }
    return { ok: true, uuid: bound.replaced };
  }
  return {
    ok: false,
    detail: `"${value}" uses an unknown accessor ".${accessor}" (only .instance and .replaced exist)`,
  };
}

/** True for a string that must be treated as a temp ref (leading `$`). */
function isRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("$");
}

/**
 * Resolve every `$`-reference in a line's ref-accepting params against the
 * current bindings. Returns rewritten params, or the FIRST fail-closed detail
 * (that line becomes invalid; independent later lines still run).
 */
function resolveRefs(
  params: Record<string, unknown>,
  declIndex: Map<string, number>,
  bindings: Map<string, Binding>,
  currentIndex: number,
): { ok: true; params: Record<string, unknown> } | { ok: false; detail: string } {
  const out: Record<string, unknown> = { ...params };
  const resolveOne = (value: string): { ok: true; uuid: string } | { ok: false; detail: string } =>
    resolveRef(value, declIndex, bindings, currentIndex);

  for (const key of Object.keys(out)) {
    if (!REF_KEYS.has(key)) continue;
    const value = out[key];
    if (isRef(value)) {
      const r = resolveOne(value);
      if (!r.ok) return r;
      out[key] = r.uuid;
    } else if (Array.isArray(value)) {
      const next = [...value];
      for (let i = 0; i < next.length; i++) {
        if (isRef(next[i])) {
          const r = resolveOne(next[i] as string);
          if (!r.ok) return r;
          next[i] = r.uuid;
        }
      }
      out[key] = next;
    } else if (typeof value === "object" && value !== null) {
      // Container ref: resolve a `$` uuid sub-field, leave title/others alone.
      const ref = value as Record<string, unknown>;
      if (isRef(ref["uuid"])) {
        const r = resolveOne(ref["uuid"] as string);
        if (!r.ok) return r;
        out[key] = { ...ref, uuid: r.uuid };
      }
    }
  }
  return { ok: true, params: out };
}

/** Does any line use a `$`-reference in a ref-accepting param? (dry-run gate) */
function usesRef(params: Record<string, unknown>): boolean {
  for (const key of Object.keys(params)) {
    if (!REF_KEYS.has(key)) continue;
    const value = params[key];
    if (isRef(value)) return true;
    if (Array.isArray(value) && value.some(isRef)) return true;
    if (
      typeof value === "object" &&
      value !== null &&
      isRef((value as Record<string, unknown>)["uuid"])
    )
      return true;
  }
  return false;
}

/**
 * The recent-history lookback for an opId: the most recent `ok` record carrying
 * that id, within the last {@link OPID_LOOKBACK_RECORDS} records AND the last
 * {@link OPID_LOOKBACK_MS} (whichever is more restrictive). Undo/intent records
 * are naturally excluded (only `result === "ok"` matches).
 */
function findAppliedOpId(records: AuditRecord[], opId: string, now: Date): AuditRecord | undefined {
  const cutoff = now.getTime() - OPID_LOOKBACK_MS;
  const window = records.slice(-OPID_LOOKBACK_RECORDS);
  let match: AuditRecord | undefined;
  for (const r of window) {
    if (r.opId !== opId || r.result !== "ok") continue;
    if (new Date(r.ts).getTime() < cutoff) continue;
    match = r; // records are oldest-first, so the last match is the newest
  }
  return match;
}

/** Bind a leg's discovered uuids to its temp id, once it verifies ok. */
function bindingFromResult(result: {
  uuid?: string | null;
  repeating?: { instanceUuid: string | null; replacedUuid: string | null };
}): Binding | null {
  if (typeof result.uuid !== "string") return null;
  return {
    primary: result.uuid,
    instance: result.repeating?.instanceUuid ?? null,
    replaced: result.repeating?.replacedUuid ?? null,
  };
}

/** Write the batch-level summary audit record (role "summary"; its undoToken is the batch token). */
function auditBatchSummary(
  deps: WriteDeps,
  startedAt: Date,
  txnId: string,
  legCount: number,
  tempIdMapping: Record<string, string>,
  actor: string,
): void {
  const fp = deps.fingerprint();
  const hasMapping = Object.keys(tempIdMapping).length > 0;
  const record: AuditRecord = {
    v: 1,
    ts: startedAt.toISOString(),
    actor,
    host: deps.config.host,
    op: "batch",
    uuid: null,
    vector: null,
    disruption: null,
    invocation: `batch ×${legCount}`,
    txn: { id: txnId, role: "summary" },
    requested: { legCount, ...(hasMapping && { tempIdMapping }) },
    pre: null,
    observed: hasMapping ? { tempIdMapping } : null,
    result: "ok",
    verify: null,
    durationMs: (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
    env: {
      pkg: deps.pkgVersion ?? "0.0.1",
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fingerprintLabel(fp, deps.config),
    },
  };
  deps.audit.append(record);
}

export async function runBatch(
  deps: WriteDeps,
  ops: BatchOp[],
  options: BatchOptions = {},
  onResult?: (result: BatchItemResult) => void,
): Promise<BatchResult> {
  const startedAt = deps.now?.() ?? new Date();
  const actor = options.actor ?? deps.config.actor;
  const bindings = new Map<string, Binding>();
  const tempIdMapping: Record<string, string> = {};

  // Pre-flight: validate every temp-id declaration BEFORE any leg runs.
  const { declIndex, errors: declErrors } = validateDeclarations(ops);
  if (declErrors.size > 0) {
    const results: BatchItemResult[] = ops.map((entry, index) => {
      const op = String((entry as { op?: unknown } | null)?.op);
      const detail = declErrors.get(index);
      const outcome: BatchItemOutcome =
        detail !== undefined
          ? { kind: "invalid", op, detail }
          : {
              kind: "skipped",
              op,
              detail: "not run — the batch has a temp-id declaration error (see the invalid line)",
            };
      const result: BatchItemResult = { index, op, outcome };
      onResult?.(result);
      return result;
    });
    return { results, tempIdMapping };
  }

  // opId idempotency reads the recent trail ONCE, before executing.
  const usesOpId = ops.some((o) => typeof o === "object" && o !== null && o.opId !== undefined);
  const priorRecords =
    usesOpId && deps.auditDirPath !== undefined ? readAuditRecords(deps.auditDirPath) : [];

  const txnId = `txn-batch-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const results: BatchItemResult[] = [];
  let halted = false;
  let legsDispatched = 0;

  /** Bind (or rebind) a temp id to a discovered uuid so later `$refs` resolve. */
  const bind = (tempId: string, binding: Binding): void => {
    bindings.set(tempId, binding);
    tempIdMapping[tempId] = binding.primary;
  };

  /** Compute one line's outcome + bound uuid; mutates bindings/dispatch counter. */
  const runLine = async (
    entry: BatchOp,
    index: number,
    tempId: string | undefined,
    opId: string | undefined,
  ): Promise<{ outcome: BatchItemOutcome; boundUuid?: string }> => {
    if (typeof entry !== "object" || entry === null || typeof entry.op !== "string") {
      return {
        outcome: {
          kind: "invalid",
          op: String((entry as { op?: unknown })?.op),
          detail: "each op needs {op, params}",
        },
      };
    }
    if (!KNOWN_OPS.has(entry.op)) {
      return {
        outcome: {
          kind: "invalid",
          op: entry.op,
          detail: `unknown op "${entry.op}" — see \`things capabilities\``,
        },
      };
    }
    if (typeof entry.params !== "object" || entry.params === null) {
      return { outcome: { kind: "invalid", op: entry.op, detail: "params must be an object" } };
    }
    if (opId !== undefined && !OP_ID_RE.test(opId)) {
      return {
        outcome: {
          kind: "invalid",
          op: entry.op,
          detail: "opId must match [A-Za-z0-9_-] and be 1–64 characters",
        },
      };
    }
    // opId idempotency: an earlier submission already applied this line — skip,
    // report already-applied with the recorded uuid, and rebind it so later
    // $refs still resolve.
    if (opId !== undefined) {
      const applied = findAppliedOpId(priorRecords, opId, startedAt);
      if (applied !== undefined) {
        const uuid = applied.uuid ?? "";
        if (tempId !== undefined && uuid !== "")
          bind(tempId, { primary: uuid, instance: null, replaced: null });
        return {
          outcome: {
            kind: "already-applied",
            op: entry.op,
            uuid,
            detail:
              "already applied by an earlier submission (matching opId in the change history) — not re-run",
          },
          ...(tempId !== undefined && uuid !== "" && { boundUuid: uuid }),
        };
      }
    }
    // Temp refs resolve only during real execution — nothing is created in a
    // dry-run to bind them, so preview a ref-using line as skipped (not a false
    // failure).
    if (options.dryRun === true && usesRef(entry.params)) {
      return {
        outcome: {
          kind: "skipped",
          op: entry.op,
          detail:
            "not previewed — temp-references resolve only during real execution (not --dry-run)",
        },
      };
    }
    const resolved = resolveRefs(entry.params, declIndex, bindings, index);
    if (!resolved.ok) {
      return { outcome: { kind: "invalid", op: entry.op, detail: resolved.detail } };
    }
    const writeOptions: WriteOptions = {
      ...(entry.options?.acknowledgeChecklistReset !== undefined && {
        acknowledgeChecklistReset: entry.options.acknowledgeChecklistReset,
      }),
      ...(entry.options?.acknowledgeProjectReopen !== undefined && {
        acknowledgeProjectReopen: entry.options.acknowledgeProjectReopen,
      }),
      ...(entry.options?.dangerouslyPermanent !== undefined && {
        dangerouslyPermanent: entry.options.dangerouslyPermanent,
      }),
      ...(entry.options?.acknowledgeTagSubtree !== undefined && {
        acknowledgeTagSubtree: entry.options.acknowledgeTagSubtree,
      }),
      ...(entry.options?.dangerouslyDriveGui !== undefined && {
        dangerouslyDriveGui: entry.options.dangerouslyDriveGui,
      }),
      ...(entry.options?.createTags !== undefined && { createTags: entry.options.createTags }),
      ...(entry.options?.vector !== undefined && { vector: entry.options.vector }),
      ...(entry.options?.verifyTimeoutMs !== undefined && {
        verifyTimeoutMs: entry.options.verifyTimeoutMs,
      }),
      ...(entry.options?.maxDisruption !== undefined && {
        maxDisruption: entry.options.maxDisruption,
      }),
      ...(options.dryRun === true && { dryRun: true }),
      ...(opId !== undefined && { opId }),
      // Group every leg under one txn so the batch summary's undo token replays
      // the whole submission (dry-run legs are not recorded, so no txn).
      ...(options.dryRun !== true && { txn: { id: txnId, role: "leg" as const } }),
      actor,
    };
    try {
      // Params arrive as parsed JSON; the pipeline's pre-read + guards are the
      // runtime validators (loud on bad shapes), same as single ops.
      const result =
        entry.op === "reorder"
          ? // batch ops run sequentially by design: the mutation lock serializes them and create-probe verification must never race
            await runReorder(
              deps,
              resolved.params as unknown as OperationParamsMap["reorder"],
              writeOptions,
            )
          : // same sequencing requirement as the reorder branch above; batch is a
            // consumer entry point, so a consumer `when` normalizes to the zone
            await runMutation(
              deps,
              entry.op as Exclude<OperationKind, "reorder">,
              resolved.params as never,
              { ...writeOptions, normalizeWhen: true },
            );
      if (options.dryRun !== true) legsDispatched += 1;
      // A leg binds its temp id ONLY when it verified ok — a failed leg
      // (including a rule-mismatch that surfaces discovery uuids in its error)
      // binds nothing, so later refs to it fail fast.
      let boundUuid: string | undefined;
      if (result.kind === "ok" && tempId !== undefined) {
        const binding = bindingFromResult(result);
        if (binding !== null) {
          bind(tempId, binding);
          boundUuid = binding.primary;
        }
      }
      return { outcome: result, ...(boundUuid !== undefined && { boundUuid }) };
    } catch (err) {
      // Param-shape errors (exclusive combos etc.) surface per-op, not fatally.
      return {
        outcome: {
          kind: "invalid",
          op: entry.op,
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };

  for (let index = 0; index < ops.length; index++) {
    const entry = ops[index] as BatchOp;
    const tempId = typeof entry === "object" && entry !== null ? entry.tempId : undefined;
    const opId = typeof entry === "object" && entry !== null ? entry.opId : undefined;

    let outcome: BatchItemOutcome;
    let boundUuid: string | undefined;
    if (halted) {
      outcome = {
        kind: "skipped",
        op: String(entry?.op),
        detail: "skipped after earlier failure (--fail-fast)",
      };
    } else {
      ({ outcome, boundUuid } = await runLine(entry, index, tempId, opId));
    }

    const result: BatchItemResult = {
      index,
      op: String(entry?.op),
      outcome,
      ...(tempId !== undefined && { tempId }),
      ...(boundUuid !== undefined && { boundUuid }),
      ...(opId !== undefined && { opId }),
    };
    results.push(result);
    onResult?.(result);
    if (options.failFast === true && !halted && outcomeFailed(outcome)) halted = true;
  }

  // Write the batch summary (and mint the batch undo token) when at least one
  // leg actually reached the pipeline. Skipped for dry-run and all-rejected
  // batches — there is nothing to undo.
  let undoToken: string | undefined;
  if (options.dryRun !== true && legsDispatched > 0) {
    auditBatchSummary(deps, startedAt, txnId, legsDispatched, tempIdMapping, actor);
    undoToken = txnId;
  }

  return { results, tempIdMapping, ...(undoToken !== undefined && { undoToken }) };
}
