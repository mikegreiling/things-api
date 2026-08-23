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
 *    resolve STRICTLY (fail-closed). A `$` value naming no declared tempId or a
 *    forward reference is a STATIC error caught by the whole-batch preflight
 *    (the batch is refused before anything runs). A reference to an earlier leg
 *    that BOUND NOTHING (its op failed/skipped) is a RUNTIME miss that fails
 *    that one line as it lands.
 *  - opId (`opId`): a client idempotency id. Before dispatch, a line with an
 *    opId is matched against the recent change history; a prior `ok` record with
 *    the same id means the line is SKIPPED (reported already-applied with the
 *    original uuid, which is bound to the line's tempId) — safe resubmission of
 *    an ambiguously-failed batch without double-creates.
 *  - batch undo token: every leg records under one shared txn, and the batch
 *    writes a summary record whose undo token undoes the WHOLE submission as one
 *    unit (`things undo --txn <token>`), replaying leg inverses in reverse.
 *
 * `preserveModified` (the universal timeline-silent write flag) rides the same
 * submission in BOTH shapes: a run-level default on {@link BatchOptions} that
 * applies to every line, and a per-line `options.preserveModified` that outranks
 * it. Each leg then takes the ordinary single-op path — capture pre-write `umd`,
 * restore after verify, disclose `preservedModified`/`preserveFailures` on that
 * line's result — so a bulk re-tag stays off the `changes` timeline under one
 * undo token.
 */
import type { AuditRecord } from "../audit/schema.ts";
import { OPERATION_KINDS, type OperationKind, type OperationParamsMap } from "./operations.ts";
import { findAppliedOpId, OP_ID_RE } from "./opid.ts";
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
    /** Delete a non-empty area together with its contents (area.delete). */
    allowNonEmptyArea?: boolean;
    /**
     * Acknowledge a GUI-driven op (make-repeating, convert-to-project, …) — the
     * second of its two keys. Required for any ui-drive op (several of which are
     * uuid-minting, so tempId-eligible), or the per-leg H-UI-DRIVE gate blocks it.
     */
    dangerouslyDriveGui?: boolean;
    /** Create any missing tag (mkdir-p for parent/child) instead of failing on an unknown tag. */
    createTags?: boolean;
    /**
     * Keep THIS line's change off the modification-date timeline (the universal
     * write flag): the leg captures each pre-existing edited row's
     * `userModificationDate` and restores it after the change verifies, so a
     * `changes`/watch query keyed on it does not surface the edit. Best-effort —
     * a failed restore is disclosed on the line's result
     * (`preservedModified`/`preserveFailures`), never fatal. A no-op on a pure
     * create. An explicit value here OUTRANKS the run-level
     * {@link BatchOptions.preserveModified} default (including an explicit
     * `false`, which opts this one line out of a preserving run).
     */
    preserveModified?: boolean;
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

/**
 * Resume guidance after a stop-on-failure halt (Change 2). Present only when a
 * runtime failure halted the batch with lines left not-run. Tells the caller
 * whether the SAME batch can be resubmitted verbatim to resume.
 */
export interface BatchResumption {
  /** How many lines were reported not-run after the halt. */
  notRun: number;
  /** True iff every line that COMMITTED a change carried an opId (safe verbatim rerun). */
  verbatimSafe: boolean;
  /** Indices of committed lines that lacked an opId — a verbatim rerun would RE-RUN these. */
  nonIdempotentIndices: number[];
  /** Human-readable resume story (mirrored into the CLI/MCP summary). */
  detail: string;
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
  /**
   * Resume guidance — present only when a runtime failure HALTED the batch
   * (stop-on-failure default) leaving lines not-run (ADDITIVE).
   */
  resumption?: BatchResumption;
}

export interface BatchOptions {
  /**
   * Run PAST a runtime per-line failure instead of halting. The default is
   * stop-on-failure (Change 2): a runtime failure halts the batch and every
   * later line is reported not-run. Set this to restore the old proceed-past
   * behavior (every line runs regardless of earlier failures).
   */
  continueOnError?: boolean;
  /** Plan every op without executing (each result is its dry-run plan). */
  dryRun?: boolean;
  /**
   * Run-level DEFAULT for the universal `--preserve-modified` flag: every line
   * that does not set `options.preserveModified` itself runs with this value, so
   * a whole bulk submission stays off the modification-date timeline in one
   * flag. A line's own explicit value always outranks this (an explicit `false`
   * opts that line back onto the timeline).
   */
  preserveModified?: boolean;
  actor?: string;
}

const KNOWN_OPS = new Set<string>(OPERATION_KINDS);

/**
 * The promote COMPOUNDS — each is a multi-leg orchestration (make-repeating:
 * clone → native GUI promote → trash; add-repeating: add → native GUI promote),
 * delivered only by its dedicated orchestrator and NOT dispatchable through the
 * pipeline as one atomic op, so none can be a batch leg. Refused per-line with a
 * pointer to the standalone command. (make-repeating joined this set with the
 * promote-via-clone rewrite — ruling 2026-08-13; the old batch path ran the
 * destructive native promote, which is deleted per ALPHA-CONTRACT.)
 */
const BATCH_UNSUPPORTED_COMPOUND = new Set<string>([
  "todo.make-repeating",
  "project.make-repeating",
  "todo.add-repeating",
  "project.add-repeating",
]);

/**
 * Ops that MINT a uuid, so may declare a `tempId` — the ratified rule is
 * "anything that creates a new uuid". NB: `tag.add` is deliberately absent (tags
 * have no uuid — identity is the title).
 */
const UUID_MINTING_OPS = new Set<string>([
  "todo.add",
  "project.add",
  "area.add",
  "project.add-heading",
  "todo.duplicate",
  "project.duplicate",
  "todo.make-repeating",
  "project.make-repeating",
  "todo.convert-to-project",
  "project.promote-heading",
  // NB: `*.make-repeating` mints a uuid but is REFUSED as a batch leg
  // (BATCH_UNSUPPORTED_COMPOUND) — it stays listed here so a tempId on it clears
  // the tempId-declaration pre-flight and is then caught by the static compound
  // check (which now refuses the WHOLE batch, Change 1) with the informative
  // compound detail rather than a bare "tempId not valid here". The add-repeating
  // COMPOUNDS mint uuids too but are likewise refused standalone.
]);

const TEMP_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

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
  "headings",
]);

/** The discovery uuids a bound temp id can resolve (primary + identity-replacement kin). */
interface Binding {
  primary: string;
  instance: string | null;
  replaced: string | null;
}

/** True when an outcome should be treated as a failure (halt / exit code). */
export function outcomeFailed(outcome: BatchItemOutcome): boolean {
  return outcome.kind !== "ok" && outcome.kind !== "dry-run" && outcome.kind !== "already-applied";
}

/**
 * STATIC preflight over EVERY line, BEFORE any leg runs (Change 1). Returns the
 * name→line index of valid tempId declarations and, per statically-invalid line,
 * the usage detail. "Statically detectable" means checkable with NO DB/app state:
 * a torn/non-object line, missing/unknown op, a BATCH_UNSUPPORTED_COMPOUND op,
 * non-object params, a malformed opId, a malformed/misplaced/duplicate tempId
 * declaration, and a `$ref` naming a tempId that NO EARLIER line declares
 * (unresolved or forward). ANY hit rejects the WHOLE batch (nothing executes) —
 * a script with a structural error is refused as a unit. RUNTIME failures
 * (verify-failed, guards, param-shape throws, a ref to a leg that BOUND NOTHING)
 * are not detectable here and keep their per-line semantics in `runLine`.
 */
function preflightBatch(ops: BatchOp[]): {
  declIndex: Map<string, number>;
  errors: Map<number, string>;
} {
  const declIndex = new Map<string, number>();
  const errors = new Map<number, string>();

  // Pass 1 — validate every tempId DECLARATION and index the valid ones (so the
  // ref check below can tell "declared earlier" from "unresolved"/"forward").
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
        `tempId is only valid on an op that creates something (e.g. todo.add, project.add, project.add-heading) — not "${entry.op}"`,
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

  // Pass 2 — per-line STATIC shape + static ref checks (skip lines already
  // flagged by a declaration error; one detail per line is enough to refuse).
  for (let i = 0; i < ops.length; i++) {
    if (errors.has(i)) continue;
    const detail = staticLineError(ops[i] as BatchOp, i, declIndex);
    if (detail !== undefined) errors.set(i, detail);
  }

  return { declIndex, errors };
}

/** One line's STATIC shape/ref error (no DB/app state), or undefined when clean. */
function staticLineError(
  entry: BatchOp,
  index: number,
  declIndex: Map<string, number>,
): string | undefined {
  if (typeof entry !== "object" || entry === null || typeof entry.op !== "string") {
    return "each op needs {op, params}";
  }
  if (!KNOWN_OPS.has(entry.op)) {
    return `unknown op "${entry.op}" — see \`things capabilities\``;
  }
  if (BATCH_UNSUPPORTED_COMPOUND.has(entry.op)) {
    return (
      `"${entry.op}" is a promote-via-clone COMPOUND (clone/add → GUI promote → trash), not a ` +
      "single atomic op — it does not compose inside a batch. Run it as a standalone command " +
      "(`things todo|project make-repeating` / `add-repeating`)"
    );
  }
  if (typeof entry.params !== "object" || entry.params === null) {
    return "params must be an object";
  }
  if (entry.opId !== undefined && !OP_ID_RE.test(entry.opId)) {
    return "opId must match [A-Za-z0-9_-] and be 1–64 characters";
  }
  return staticRefError(entry.params, declIndex, index);
}

/**
 * STATIC `$ref` check for one line's ref-accepting params: a `$name` that names
 * a tempId NO EARLIER line declares — either declared nowhere (unresolved) or
 * declared on this/a later line (forward). Both are structural and refuse the
 * whole batch. A ref to a tempId declared EARLIER is fine here (whether the leg
 * actually bound a uuid is a RUNTIME question, resolved in `runLine`).
 */
function staticRefError(
  params: Record<string, unknown>,
  declIndex: Map<string, number>,
  currentIndex: number,
): string | undefined {
  const check = (value: unknown): string | undefined => {
    if (!isRef(value)) return undefined;
    const { name } = parseRef(value);
    const declaredAt = declIndex.get(name);
    if (declaredAt === undefined) {
      return `unresolved-temp-ref: "${value}" names no tempId declared in this batch`;
    }
    if (declaredAt > currentIndex) {
      return `unresolved-temp-ref: "${value}" is a forward reference — tempId "${name}" is declared later (line ${declaredAt + 1})`;
    }
    return undefined;
  };
  for (const key of Object.keys(params)) {
    if (!REF_KEYS.has(key)) continue;
    const value = params[key];
    if (isRef(value)) {
      const e = check(value);
      if (e !== undefined) return e;
    } else if (Array.isArray(value)) {
      for (const el of value) {
        const e = check(el);
        if (e !== undefined) return e;
      }
    } else if (typeof value === "object" && value !== null) {
      const e = check((value as Record<string, unknown>)["uuid"]);
      if (e !== undefined) return e;
    }
  }
  return undefined;
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

  // STATIC preflight (Change 1): scan EVERY line for a structural error BEFORE
  // any leg runs — dry-run takes the same pass. On any hit the WHOLE batch is
  // refused: the offending lines report `invalid` (enumerating every one), all
  // others report `skipped`, and nothing is dispatched.
  const { declIndex, errors: staticErrors } = preflightBatch(ops);
  if (staticErrors.size > 0) {
    const results: BatchItemResult[] = ops.map((entry, index) => {
      const op = String((entry as { op?: unknown } | null)?.op);
      const detail = staticErrors.get(index);
      const outcome: BatchItemOutcome =
        detail !== undefined
          ? { kind: "invalid", op, detail }
          : {
              kind: "skipped",
              op,
              detail:
                "not run — the batch was refused before executing (a line is statically invalid; see the invalid line(s))",
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
  let notRun = 0;

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
    // Every STATIC shape/op/opId/ref check already passed the whole-batch
    // preflight above (a hit there refuses the batch and this loop never runs),
    // so `entry` is a well-formed op with object params and a valid opId here.
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
    const preserveModified = entry.options?.preserveModified ?? options.preserveModified;
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
      ...(entry.options?.allowNonEmptyArea !== undefined && {
        allowNonEmptyArea: entry.options.allowNonEmptyArea,
      }),
      ...(entry.options?.dangerouslyDriveGui !== undefined && {
        dangerouslyDriveGui: entry.options.dangerouslyDriveGui,
      }),
      ...(entry.options?.createTags !== undefined && { createTags: entry.options.createTags }),
      // --preserve-modified: the line's own explicit value wins; otherwise the
      // run-level default applies. `??` (not `||`) so an explicit per-line
      // `false` opts one line out of an otherwise-preserving submission.
      ...(preserveModified !== undefined && { preserveModified }),
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
      notRun += 1;
      outcome = {
        kind: "skipped",
        op: String(entry?.op),
        detail:
          "not run — a preceding line failed and the batch stops on failure by default " +
          "(pass --continue-on-error / continueOnError to run past failures)",
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
    // Stop-on-failure is the DEFAULT (Change 2): a runtime failure halts the
    // batch so every later line is reported not-run. `continueOnError` restores
    // the old proceed-past behavior. Dry-run never halts — a preview shows the
    // WHOLE plan.
    if (
      options.dryRun !== true &&
      options.continueOnError !== true &&
      !halted &&
      outcomeFailed(outcome)
    ) {
      halted = true;
    }
  }

  // Write the batch summary (and mint the batch undo token) when at least one
  // leg actually reached the pipeline. Skipped for dry-run and all-rejected
  // batches — there is nothing to undo.
  let undoToken: string | undefined;
  if (options.dryRun !== true && legsDispatched > 0) {
    auditBatchSummary(deps, startedAt, txnId, legsDispatched, tempIdMapping, actor);
    undoToken = txnId;
  }

  // Resume guidance (Change 2): only when a runtime failure HALTED the batch
  // with lines left not-run. A verbatim rerun is SAFE iff every COMMITTED line
  // (kind "ok") carried an opId — those replay as already-applied (skipped),
  // while the failed line is retried and the not-run lines run for the first
  // time. A committed line without an opId would RE-RUN (e.g. a duplicate
  // create), so it is named.
  let resumption: BatchResumption | undefined;
  if (options.dryRun !== true && halted && notRun > 0) {
    const nonIdempotentIndices = results
      .filter((r) => r.outcome.kind === "ok" && r.opId === undefined)
      .map((r) => r.index);
    const verbatimSafe = nonIdempotentIndices.length === 0;
    const detail = verbatimSafe
      ? `${notRun} line(s) did not run after the batch stopped on a failure. Every committed ` +
        "line carried an opId, so the SAME batch can be resubmitted verbatim to resume — " +
        "already-applied lines are skipped and the run continues past the failure."
      : `${notRun} line(s) did not run after the batch stopped on a failure. Resubmitting the ` +
        `SAME batch verbatim would RE-RUN line(s) ${nonIdempotentIndices.join(", ")} (they ` +
        "committed a change but carry no opId, so they are not idempotent) — add an opId to " +
        "every line before resubmitting, or drop the already-applied lines.";
    resumption = { notRun, verbatimSafe, nonIdempotentIndices, detail };
  }

  return {
    results,
    tempIdMapping,
    ...(undoToken !== undefined && { undoToken }),
    ...(resumption !== undefined && { resumption }),
  };
}
