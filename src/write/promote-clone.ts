/**
 * Promote-via-clone orchestrators (design of record: docs/design/promote-via-clone.md;
 * rulings 2026-08-11/13). The four public promote verbs live here:
 *
 *   - `todo.make-repeating` / `project.make-repeating` — the REWIRED promote:
 *       clone(X, preserveCreated) → native-promote(the clone) → trash(X).
 *     Recoverable (X survives in the Trash) and deterministic (the RSIM source-fate
 *     lottery lands on a disposable clone row we were going to discard anyway,
 *     CLONE verdict B). The result carries the minted template uuid (unchanged
 *     contract) plus the trashed original's uuid; the audit SUMMARY captures
 *     template + instance + original so `things undo` is the automated trash-both
 *     + restore (SERDEL S1/S2). The old direct-promote is GONE (ALPHA-CONTRACT):
 *     the native dialog stays the INTERNAL mechanism (runMutation on the clone /
 *     promoteProjectViaGui), never a user-facing mode.
 *
 *   - `todo.add-repeating` (NEW, closes §0.2) / `project.add-repeating` (full
 *     write vocabulary, closes §0.3) — add(full vocabulary) → native-promote(the
 *     fresh row). No trash leg (there is no original).
 *
 * A nested-repeater project refuses at the CLONE leg (H-CLONE-SOURCE), which
 * surfaces coherently at the make-repeating surface (ruling 2026-08-13, no
 * --flatten). Placement of the resulting instance is disclosed best-effort (see
 * PLACEMENT_NOTE).
 */
import type { AuditRecord } from "../audit/schema.ts";
import { undoToken } from "../audit/schema.ts";
import { addDaysIso, decodePackedDate, localToday, type IsoDate } from "../model/dates.ts";
import type { Project, Todo } from "../model/entities.ts";
import type { RepeatRule } from "../model/recurrence.ts";
import { byUuid } from "../read/detail.ts";
import { resolveProjectWriteTarget, resolveTaskUuidPrefix } from "../read/queries.ts";
import { runCloneProject, runCloneTodo } from "./clone.ts";
import { promoteProjectViaGui } from "./make-repeating-project.ts";
import type {
  AddRepeatingRuleFields,
  CloneParams,
  OperationKind,
  ProjectAddRepeatingParams,
  RepeatRuleParams,
  TodoAddRepeatingParams,
} from "./operations.ts";
import {
  fingerprintLabel,
  runComposite,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import {
  assessOffRuleFirst,
  daysBetweenIso,
  deriveFixedAnchor,
  isIsoDate,
} from "./repeat-anchor.ts";
import { assertRepeatRule, ruleToInverseParams, splitAddRepeatingRule } from "./repeat-rule.ts";
import { createDbReader, type PreModDates, type RepeatingDiscovery } from "./verify/delta.ts";
import { H_UI_SESSION_UNREACHABLE } from "./vectors/session-reachability.ts";

type PromoteOp =
  | "todo.make-repeating"
  | "project.make-repeating"
  | "todo.add-repeating"
  | "project.add-repeating";

const PLACEMENT_NOTE =
  "the series' current instance lands at its container's default position — its prior slot was " +
  "not automatically restored (best-effort placement is not yet wired for this container); " +
  "reposition it with `things reorder` if the order matters";

// --------------------------------------------------------------- small helpers

function newTxnId(now: Date): string {
  return `txn-${now.getTime().toString(36)}-${process.pid.toString(36)}`;
}

/**
 * Forward the caller's audit/timeout/GUI knobs onto a delegated leg. `extra`
 * carries per-leg additions — `preserveModified` is threaded ONLY onto the legs
 * that touch a PRE-EXISTING row (the trash-X leg); the clone/promote legs mint
 * fresh rows, where the flag would be a no-op.
 */
function legOptions(
  base: WriteOptions,
  txnId: string,
  vector?: WriteOptions["vector"],
  extra?: Partial<WriteOptions>,
): WriteOptions {
  const out: WriteOptions = { txn: { id: txnId, role: "leg" } };
  if (vector !== undefined) out.vector = vector;
  if (base.actor !== undefined) out.actor = base.actor;
  if (base.verifyTimeoutMs !== undefined) out.verifyTimeoutMs = base.verifyTimeoutMs;
  if (base.dangerouslyDriveGui !== undefined) out.dangerouslyDriveGui = base.dangerouslyDriveGui;
  if (base.maxDisruption !== undefined) out.maxDisruption = base.maxDisruption;
  if (base.zone !== undefined) out.zone = base.zone;
  if (extra?.preserveModified === true) out.preserveModified = true;
  return out;
}

/** The two-key GUI-drive block (mirrors H-UI-DRIVE) — the promote leg drives the app. */
function blockedUiDrive(op: PromoteOp): MutationResult {
  return {
    kind: "blocked",
    op,
    reason: "hazard",
    hazard: "H-UI-DRIVE",
    detail:
      "this operation promotes an item to a repeating series by driving the local Things app " +
      "through the Accessibility API (the Repeat… dialog) — it may briefly interact with the UI",
    remediation:
      "pass dangerouslyDriveGui (--dangerously-drive-gui) to proceed; the vector also requires " +
      "`things config set ui-enabled true` and Accessibility granted to this process (see docs/setup.md)",
  };
}

/**
 * SESSGATE (#480) pre-seed reachability gate. A promote composite is NOT atomic:
 * it SEEDS a row (clone / add) before the GUI promote leg drives the dialog. If
 * the Mac's session is AX-blind (screen locked / full-screen Space), the dialog
 * would open on an unreachable window and the drive would fail — leaving an
 * orphan seed. So probe the live session BEFORE seeding and refuse fast (zero
 * mutation) on the certain-failure LOCKED signature. Only "session" scope refuses
 * here: a window merely on another Space is left for the in-drive relocation (the
 * reveal has not run yet, so refusing before the seed would be a false positive).
 * No ui vector (simulator / bench), ui disabled, or a fail-open probe → proceed
 * (the promote leg's own gate + cleanup remain the backstop).
 */
async function gateSessionReachability(
  deps: WriteDeps,
  op: PromoteOp,
): Promise<MutationResult | null> {
  if (!deps.config.ui.enabled) return null;
  const ui = deps.vectors.find((v) => v.probeReachability !== undefined);
  if (ui?.probeReachability === undefined) return null;
  const verdict = await ui.probeReachability();
  if (verdict.reachable || verdict.scope !== "session") return null;
  return {
    kind: "blocked",
    op,
    reason: "hazard",
    hazard: H_UI_SESSION_UNREACHABLE,
    detail: verdict.detail,
    remediation: verdict.remediation,
  };
}

/**
 * Auto-trash a promote composite's own seeded item after its promote leg failed
 * (RATIFIED RULING 2026-08-15, issue #480). The add/add-repeating legs are NOT
 * atomic: the seed persists even when the promote no-ops. The seed is OUR
 * artifact — recreatable verbatim from the command args — and the Trash is
 * recoverable, so we trash it inside the same txn and disclose it. The
 * distinction the failure MUST make honest: an auto-trash that SUCCEEDS points
 * the caller at `restore` (the row is in the Trash); one that FAILS points at
 * `delete` with the seed's REAL, resolvable uuid (never a buried, non-actionable
 * uuid — the #480 second bug). Returns a `detail` patch appended to the promote
 * result's own message (best-effort: a non-`detail` result shape is left as-is).
 */
async function cleanupSeed(
  deps: WriteDeps,
  kind: "todo" | "project",
  createdUuid: string,
  promote: MutationResult,
  options: WriteOptions,
  txnId: string,
): Promise<{ detail?: string }> {
  const expectedType = kind === "project" ? "project" : "to-do";
  const trashOp: OperationKind = kind === "project" ? "project.delete" : "todo.delete";
  const trashed = await runMutation(
    deps,
    trashOp,
    { uuid: createdUuid },
    legOptions(options, txnId),
  );
  const cleanupNote =
    trashed.kind === "ok"
      ? `the seeded ${expectedType} (uuid ${createdUuid}) was created but the promote did not land, ` +
        `so it was moved to the Trash — recreate it from the command args, or restore it with ` +
        `\`things ${kind} restore ${createdUuid}\``
      : `the seeded ${expectedType} (uuid ${createdUuid}) was created but the promote did not land, ` +
        `and it could NOT be auto-trashed — remove it with \`things ${kind} delete ${createdUuid}\``;
  return "detail" in promote
    ? { detail: `${(promote as { detail: string }).detail} — ${cleanupNote}` }
    : {};
}

/**
 * Pick the rule fields (frequency/interval + calendar anchors + deadline offset)
 * as a RepeatRuleParams, plus the requested first-occurrence date to drive into
 * the dialog's "Next:" field (ANCH2, issue #476). `nextIso` is the item's
 * scheduled date; omitted (or after-completion) leaves Next at the app default.
 *
 * The `rule` bag is the SUPERSET the make/add legs actually carry: make-repeating
 * passes a full {@link RepeatRuleParams} (rule-level `deadline`/`startDaysEarlier`
 * and the requested `next` included), add-repeating an
 * {@link AddRepeatingRuleFields} plus whichever of the deadline pair its geometry
 * folded in. Every field flows through by SPREAD, never by a hand-copied field
 * list — a list here is how the make-repeating promote once stripped
 * `deadline`/`startDaysEarlier` (a deadlined make-repeating produced a
 * NON-deadlined template, YANCH1 #493) and how the project promote later dropped
 * `next` (#549). The ONE field that is deliberately re-derived rather than copied
 * is `next`: the drive date is deadline-shifted by the caller, and an
 * after-completion dialog has no first-occurrence field to drive at all.
 */
function ruleParamsFor(
  uuid: string,
  rule: Partial<Omit<RepeatRuleParams, "uuid">> & AddRepeatingRuleFields,
  nextIso?: IsoDate,
): RepeatRuleParams {
  const out: RepeatRuleParams = { ...rule, uuid };
  // Never the caller's raw `next` — see above; the drive date arrives as `nextIso`.
  delete out.next;
  if (nextIso !== undefined && rule.afterCompletion !== true) out.next = nextIso;
  return out;
}

const UNIT_SINGULAR: Record<RepeatRuleParams["frequency"], string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};
const UNIT_PLURAL: Record<RepeatRuleParams["frequency"], string> = {
  daily: "days",
  weekly: "weeks",
  monthly: "months",
  yearly: "years",
};

/**
 * A one-line echo of the LANDED series so a caller can eyeball what actually
 * committed — the cadence, the verified first-occurrence START, and the deadline
 * offset (YANCH1 #493 item 5). It rides the verified data (the anchor is asserted
 * == requested by the post-drive verify), so it describes the START date rather
 * than the internal deadline anchor, which for a deadlined rule is N days later.
 */
function landedRuleEcho(rule: RepeatRuleParams, startIso: IsoDate | null): string {
  const cadence =
    rule.interval === 1
      ? `every ${UNIT_SINGULAR[rule.frequency]}`
      : `every ${rule.interval} ${UNIT_PLURAL[rule.frequency]}`;
  if (rule.afterCompletion === true) {
    return `landed: the series repeats ${cadence} after each occurrence is completed`;
  }
  const first = startIso !== null ? `; the first occurrence is ${startIso}` : "";
  const offset = rule.startDaysEarlier ?? 0;
  const deadlineNote =
    offset > 0
      ? `, with a deadline ${offset} day${offset === 1 ? "" : "s"} later`
      : rule.deadline === true
        ? ", with a deadline on each occurrence"
        : "";
  return `landed: the series repeats ${cadence}${first}${deadlineNote}`;
}

/**
 * The DACON1 off-rule-first disclosure line, or null when the request is on-rule.
 * When an explicit anchor disagrees with `--when` (deadline-shift-aware) the app
 * lands an OFF-RULE first occurrence (honored for weekly/yearly); this states both
 * halves of the landed pattern so the caller can eyeball the two-phase series.
 * The dishonored monthly shape is refused upstream (assertRepeatRule), so only the
 * honored disclosure ever reaches here.
 */
function offRuleFirstNote(params: RepeatRuleParams): string | null {
  const assessment = assessOffRuleFirst(params);
  return assessment?.kind === "honored" ? assessment.disclosure.message : null;
}

/**
 * The template's app-materialized first occurrence (`rt1_instanceCreationStartDate`
 * = the date the current instance is dated at) as an ISO date, for the post-drive
 * Next-honored check. `null` when the row/date is absent.
 */
function firstOccurrenceOf(db: WriteDeps["db"], templateUuid: string): IsoDate | null {
  const row = db
    .prepare("SELECT rt1_instanceCreationStartDate AS ic FROM TMTask WHERE uuid = ?")
    .get(templateUuid) as { ic: number | null } | undefined;
  if (row === undefined || row.ic === null) return null;
  return decodePackedDate(row.ic);
}

/** A repeating instance's own scheduled start date (`startDate`) as ISO, or null. */
function instanceStartDate(db: WriteDeps["db"], instanceUuid: string): IsoDate | null {
  const row = db.prepare("SELECT startDate AS s FROM TMTask WHERE uuid = ?").get(instanceUuid) as
    | { s: number | null }
    | undefined;
  if (row === undefined || row.s === null) return null;
  return decodePackedDate(row.s);
}

/**
 * The oracle for the post-drive first-occurrence check, picked by rule KIND
 * (issue #508).
 *
 * A FIXED-schedule series is anchored on the calendar: the dialog's "Next:" field
 * IS driven, and the template's own cursor (`rt1_instanceCreationStartDate`) holds
 * the resulting first occurrence — the right thing to compare against.
 *
 * An AFTER-COMPLETION series has NO calendar anchor, so {@link ruleParamsFor}
 * deliberately leaves "Next:" alone, and the app mints the template with an EMPTY
 * cursor (RSIM2 / RSIM-P P4: no next / reference dates exist until a completion
 * happens). Comparing that empty cursor against `--when` reported a FALSE
 * `verify-failed:mismatch` on a perfectly correct creation (#508, reproduced 6/6
 * on the live host). The requested date lives on the materialized INSTANCE's own
 * `startDate` — the row the promote preserved and relinked — so that is the oracle
 * for an after-completion series.
 *
 * Returns `null` when no oracle is reachable. For an after-completion rule that
 * means "unverifiable" and the caller SKIPS the check (the create delta already
 * proved the series landed); for a fixed rule an absent cursor is a genuine miss.
 */
function landedFirstStart(
  deps: WriteDeps,
  templateUuid: string,
  instanceUuid: string | null,
  afterCompletion: boolean,
): IsoDate | null {
  if (!afterCompletion) return firstOccurrenceOf(deps.db, templateUuid);
  return instanceUuid === null ? null : instanceStartDate(deps.db, instanceUuid);
}

/**
 * DBLSPAWN1 (docs/lab/dblspawn1-preserved-instance.md, golden-v3 / Things 3.22.14):
 * a promote whose source is PRESERVED (SRCFATE deadline / terminal-element trigger)
 * relinks that source IN PLACE as the current-occurrence instance. When the first
 * occurrence is FUTURE-dated this double-books: the hidden template's cursor
 * (`rt1_nextInstanceStartDate`) points at the SAME occurrence with
 * `rt1_instanceCreationCount = 0` — the cursor does not know the occurrence is already
 * materialized — so when the date ARRIVES the app spawns a SECOND instance alongside
 * the preserved one (cell C: two rows dated the same day, icCount 0→1). A genuine
 * duplicate factory, not cosmetic.
 *
 * So a promote composite trashes the redundant preserved FUTURE instance inside the
 * txn: its content mirrors the template, and the cursor will mint the single real
 * occurrence when the date arrives (matching a normal future-first series, which holds
 * no materialized instance until then). A today/past-dated preserved instance is the
 * LEGITIMATE current occurrence (the cursor has already advanced past it) — left
 * untouched. Returns the disclosure warning (and the trashed uuid) or null when the
 * promote did not preserve a future instance. Best-effort: a failed trash is reported
 * in the warning rather than failing the whole compound (the series is already sound).
 */
async function trashRedundantFuturePreservedInstance(
  deps: WriteDeps,
  kind: "todo" | "project",
  promote: Extract<MutationResult, { kind: "ok" }>,
  options: WriteOptions,
  txnId: string,
  now: Date,
  afterCompletion: boolean,
): Promise<{ warning: string; trashedUuid: string } | null> {
  // AFTER-COMPLETION series are exempt: the double-book is a CURSOR phenomenon
  // (`rt1_nextInstanceStartDate` pointing at an already-materialized occurrence),
  // and an after-completion template is minted with NO cursor at all — the next
  // occurrence is unknown until a completion happens (RSIM2 / RSIM-P P4). Its
  // preserved instance is therefore the series' ONLY occurrence, whatever its
  // date; trashing it would destroy the series' current occurrence rather than a
  // duplicate. (Unreachable before #508, whose false verify-failed returned first.)
  if (afterCompletion) return null;
  const rep = promote.repeating;
  // Preserved iff the native promote relinked the source (replacedUuid === null) AND
  // there is a materialized instance. A DELETE-fate promote reports replacedUuid !==
  // null and never leaves a future instance to double-book.
  if (rep === undefined || rep.replacedUuid !== null || rep.instanceUuid === null) return null;
  const instanceUuid = rep.instanceUuid;
  const startIso = instanceStartDate(deps.db, instanceUuid);
  if (startIso === null) return null;
  const todayIso = localToday(now, deps.zone);
  if (daysBetweenIso(todayIso, startIso) <= 0) return null; // today or past — legitimate

  const trashOp: OperationKind = kind === "project" ? "project.delete" : "todo.delete";
  const trashed = await runMutation(
    deps,
    trashOp,
    { uuid: instanceUuid },
    legOptions(options, txnId),
  );
  const kindWord = kind === "project" ? "project" : "to-do";
  const warning =
    trashed.kind === "ok"
      ? `the source ${kindWord} was kept by the app as a pre-materialized first occurrence dated ` +
        `${startIso}; because that date is in the future the series would have spawned a DUPLICATE ` +
        `there, so the redundant occurrence was moved to the Trash — the series mints a single ` +
        `occurrence when ${startIso} arrives`
      : `the app kept the source ${kindWord} as a pre-materialized first occurrence dated ${startIso} ` +
        `(a future date the series would DUPLICATE), and it could NOT be auto-trashed — remove it ` +
        `with \`things ${kind} delete ${instanceUuid}\``;
  return { warning, trashedUuid: instanceUuid };
}

/**
 * The verify-failed result when the driven "Next:" first occurrence did not land
 * (issue #476, ANCH2). The series exists but on the wrong phase — report it
 * fail-closed rather than as a silent ok.
 */
function nextMismatch(
  op: PromoteOp,
  templateUuid: string,
  requestedIso: IsoDate,
  landedIso: IsoDate | null,
): MutationResult {
  return {
    kind: "verify-failed",
    op,
    reason: "mismatch",
    expected: { mode: "update", uuid: templateUuid, assert: [] },
    observed: null,
    detail:
      `the repeating series was created but its first occurrence landed on ` +
      `${landedIso ?? "an undetermined date"}, not the requested ${requestedIso} — the Next-field ` +
      "drive did not take; the series exists and can be corrected with `things reschedule-repeat`",
  };
}

/** The discovered template/instance from a promote leg's result. */
function discoveryOf(promote: Extract<MutationResult, { kind: "ok" }>): {
  templateUuid: string;
  instanceUuid: string | null;
} {
  const rep = promote.repeating;
  return {
    templateUuid: rep?.templateUuid ?? promote.uuid ?? "",
    instanceUuid: rep?.instanceUuid ?? null,
  };
}

// -------------------------------------------------------------- audit summary

function appendPromoteSummary(
  deps: WriteDeps,
  args: {
    startedAt: Date;
    op: PromoteOp;
    txnId: string;
    templateUuid: string;
    instanceUuid: string | null;
    originalUuid?: string;
    invocation: string;
    requested: Record<string, unknown>;
    /** The trashed original's pre-write umd (--preserve-modified) — drives the
     * symmetric undo restore (undo.ts) so the reversal is also timeline-silent. */
    preModDates?: PreModDates;
  },
): void {
  const fp = deps.fingerprint();
  const observed: Record<string, unknown> = {
    templateUuid: args.templateUuid,
    instanceUuid: args.instanceUuid,
    ...(args.originalUuid !== undefined && { originalUuid: args.originalUuid }),
  };
  const record: AuditRecord = {
    v: 1,
    ts: args.startedAt.toISOString(),
    actor: deps.config.actor,
    host: deps.config.host,
    op: args.op,
    uuid: args.templateUuid,
    vector: "ui",
    disruption: 3,
    invocation: args.invocation,
    requested: args.requested,
    txn: { id: args.txnId, role: "summary" },
    pre: null,
    observed,
    result: "ok",
    ...(args.preModDates !== undefined && { preModDates: args.preModDates }),
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

/** Build the ok result for a promote (make/add-repeating). */
function promoteOk(args: {
  op: PromoteOp;
  templateUuid: string;
  instanceUuid: string | null;
  replacedUuid: string | null;
  title: string;
  txnId: string;
  warnings: string[];
}): Extract<MutationResult, { kind: "ok" }> {
  const repeating: RepeatingDiscovery = {
    templateUuid: args.templateUuid,
    instanceUuid: args.instanceUuid,
    replacedUuid: args.replacedUuid,
  };
  return {
    kind: "ok",
    op: args.op,
    uuid: args.templateUuid,
    title: args.title,
    observed: { templateUuid: args.templateUuid, instanceUuid: args.instanceUuid },
    vector: "ui",
    tier: 3,
    undoToken: undoToken({
      ts: "",
      op: args.op,
      actor: "",
      host: "",
      uuid: args.templateUuid,
      txn: { id: args.txnId, role: "summary" },
    }),
    repeating,
    ...(args.warnings.length > 0 && { warnings: args.warnings }),
  };
}

// ============================================================ make-repeating

/**
 * Shared clone → native-promote → trash(X) for `todo.make-repeating` /
 * `project.make-repeating`. `promoteLeg` runs the native promote on the clone.
 */
async function makeRepeatingViaClone(
  deps: WriteDeps,
  kind: "todo" | "project",
  params: RepeatRuleParams,
  options: WriteOptions,
): Promise<MutationResult> {
  const op: PromoteOp = kind === "project" ? "project.make-repeating" : "todo.make-repeating";
  // Validate the rule BEFORE anything (a bad rule must never mint a clone).
  assertRepeatRule(params);

  const now = deps.now?.() ?? new Date();
  const srcUuid =
    kind === "project"
      ? resolveProjectWriteTarget(deps.db, params.uuid)
      : resolveTaskUuidPrefix(deps.db, params.uuid, "to-do");
  const src = byUuid(deps.db, srcUuid, now, deps.zone);
  const expectedType = kind === "project" ? "project" : "to-do";
  if (src === null || src.type !== expectedType) {
    return {
      kind: "blocked",
      op,
      reason: "hazard",
      hazard: "H-UNKNOWN-DESTINATION",
      detail: `the target is not a ${expectedType} (make-repeating needs an existing ${expectedType})`,
      remediation:
        kind === "project"
          ? "verify the uuid with `things projects`, or use `things todo make-repeating` for a to-do"
          : "verify the uuid with `things show <uuid>`, or use `things project make-repeating` for a project",
    };
  }

  // ANCH2 (issue #476): the app's Repeat dialog HAS a "Next:" first-occurrence
  // field; its default is the today-anchored next match, but it is editable and
  // honored (docs/lab/anch2-next-field.md). Drive it with the requested first
  // occurrence — an explicit `--when` if given, else the item's own scheduled
  // date. YANCH1 (issue #493): also DERIVE the calendar anchor (weekly weekday /
  // monthly day / yearly month+day) from that date when no explicit anchor was
  // given, and drive the anchor pop-ups — otherwise the recurring rule keeps the
  // dialog's untouched default (weekly Sunday, monthly 1st, yearly January 1) and
  // only the first occurrence is correct (the #493 anchor-drop).
  //
  // DEADLINE-MODE ANCHORING (YANCH1 #493, in-lab golden-v3): a deadlined rule
  // anchors on the DEADLINE, and each instance's START = anchor − startDaysEarlier
  // (probe: anchor+Next driven to Oct-16 with start-14 → of=[Oct-16], instance
  // start = Oct-02). `--when` is the scheduled START, so the date the dialog's
  // anchor pop-ups + "Next:" field must carry is when + startDaysEarlier (the
  // deadline); the app then back-shifts the start to `when`. For a non-deadlined
  // rule the shift is 0 and the drive date equals `--when` (unchanged).
  const whenIso = isIsoDate(params.next) ? params.next : src.startDate;
  const deadlineShift =
    params.deadline === true || (params.startDaysEarlier ?? 0) > 0
      ? (params.startDaysEarlier ?? 0)
      : 0;
  const driveIso = isIsoDate(whenIso) ? addDaysIso(whenIso, deadlineShift) : undefined;
  // The dialog is driven with the deadline-adjusted date; the verify below expects
  // the START to land back on the requested `--when`.
  const nextIso = driveIso;
  const expectedStartIso = isIsoDate(whenIso) ? whenIso : undefined;
  const effParams: RepeatRuleParams = { ...params, ...deriveFixedAnchor(params, driveIso) };

  // The promote leg drives the GUI — block before minting a clone if the ack is missing.
  if (options.dangerouslyDriveGui !== true && options.dryRun !== true) {
    return blockedUiDrive(op);
  }

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op,
      plan: {
        op,
        vector: "ui",
        tier: 3,
        invocation:
          `clone ${srcUuid} (--preserve-created) → make-repeating the clone (Repeat… → ` +
          `frequency=${effParams.frequency}, interval=${effParams.interval}) → trash the original ${srcUuid}`,
        expectedDelta: {
          mode: "create",
          probe: { title: src.title, type: expectedType, sinceEpoch: 0 },
          assert: [{ field: "repeating.isTemplate", equals: true }],
        },
        hazardsChecked: ["H-UNKNOWN-DESTINATION", "H-CLONE-SOURCE", "H-UI-DRIVE"],
      },
    };
  }

  // SESSGATE (#480): refuse a locked / full-screen session BEFORE minting a clone
  // — otherwise the promote's dialog opens on an unreachable window and the whole
  // compound fails, stranding a disposable clone. Zero mutation on refusal.
  const gate = await gateSessionReachability(deps, op);
  if (gate !== null) return gate;

  // COMPOSITE LOCK: everything below is ONE verb executed as several mutations
  // (clone → trash → promote → the DBLSPAWN1 clean-up), and they must not
  // interleave with another writer's legs — the promote's row selection is by
  // TITLE, so a concurrent clone of the same item makes it ambiguous. One lock,
  // held to the end; each leg's own acquisition is a reentrant no-op.
  return runComposite(deps, op, async () => {
    const startedAt = now;
    const txnId = newTxnId(startedAt);

    // 1. Clone the source as a disposable, embedded leg (--preserve-created). The
    // clone has captured X's full content by the time it returns.
    const clone =
      kind === "project"
        ? await runCloneProject(
            deps,
            { uuid: srcUuid, preserveCreated: true },
            legOptions(options, txnId),
          )
        : await runCloneTodo(
            deps,
            { uuid: srcUuid, preserveCreated: true },
            legOptions(options, txnId),
          );
    if (clone.kind !== "ok" || clone.uuid === null) {
      // A clone refusal (nested repeating template, H-CLONE-SOURCE) surfaces
      // coherently here — re-label it to the make-repeating op for the caller.
      return clone.kind === "ok"
        ? {
            kind: "verify-failed",
            op,
            reason: "mismatch",
            expected: {
              mode: "create",
              probe: { title: src.title, type: expectedType, sinceEpoch: 0 },
              assert: [],
            },
            observed: null,
            detail:
              "the disposable clone was created but its uuid was not discovered — nothing was promoted or trashed",
          }
        : { ...clone, op };
    }
    const cloneUuid = clone.uuid;

    // --preserve-modified: X is the ONLY pre-existing row the compound touches (the
    // clone/promote legs mint fresh rows). Capture its pre-write umd BEFORE the
    // trash bumps it — the trash leg restores it forward, and the value rides the
    // summary record's preModDates so the symmetric undo restore fires on the
    // revived X (undo.ts, 2026-08-13 ruling). The clone leg above reads X but never
    // writes it, so its umd is still pristine here.
    const preserveModified = options.preserveModified === true;
    const preUmd = preserveModified
      ? createDbReader(deps.db, now, deps.zone).modDateOf(srcUuid)
      : null;

    // 2. Trash the original BEFORE promoting — the clone already holds X's content,
    // and a live same-titled X would make the promote's project row-selection
    // ambiguous (H-PROJECT-REPEAT). X survives in the Trash (the recoverable half).
    const trash = await runMutation(
      deps,
      `${kind}.delete`,
      { uuid: srcUuid },
      legOptions(
        options,
        txnId,
        undefined,
        preserveModified ? { preserveModified: true } : undefined,
      ),
    );
    if (trash.kind !== "ok") {
      return {
        ...trash,
        op,
        ...("detail" in trash
          ? {
              detail:
                `${trash.detail} — the disposable clone (uuid ${cloneUuid}) was created but the ` +
                `original ${srcUuid} could not be moved to the Trash, so it was NOT promoted; trash ` +
                "the clone and retry",
            }
          : {}),
      } as MutationResult;
    }

    // 3. Native-promote the clone (with the ANCH2 Next drive + derived weekday).
    const rule = ruleParamsFor(cloneUuid, effParams, nextIso);
    const promote =
      kind === "project"
        ? await promoteProjectViaGui(deps, rule, legOptions(options, txnId, "ui"))
        : await runMutation(deps, "todo.make-repeating", rule, legOptions(options, txnId, "ui"));
    if (promote.kind !== "ok") {
      // The clone persists but was not promoted; best-effort ROLL BACK the trash so
      // the original is not stranded in the Trash.
      const restoreOp: OperationKind = kind === "project" ? "project.restore" : "todo.restore";
      const rolledBack = await runMutation(
        deps,
        restoreOp,
        { uuid: srcUuid },
        legOptions(options, txnId),
      );
      const rollNote =
        rolledBack.kind === "ok"
          ? `the original ${srcUuid} was restored from the Trash`
          : `the original ${srcUuid} could NOT be restored from the Trash — restore it in the app`;
      return {
        ...promote,
        op,
        ...("detail" in promote
          ? {
              detail:
                `${promote.detail} — the disposable clone (uuid ${cloneUuid}) was created but the ` +
                `promote did not land; ${rollNote}. Trash the clone and retry`,
            }
          : {}),
      } as MutationResult;
    }
    const { templateUuid } = discoveryOf(promote);
    let { instanceUuid } = discoveryOf(promote);

    // Post-drive verify (ANCH2 + YANCH1): the instance START must have landed on the
    // requested `--when` — for a deadlined rule the driven Next is the deadline
    // (when + startDaysEarlier) and the app back-shifts the start to `--when`, so the
    // check is against `expectedStartIso`, not the raw drive date. Fail closed on
    // mismatch rather than report a wrong-phase ok. The ORACLE is rule-kind dependent
    // (#508) — see landedFirstStart; an unverifiable after-completion series skips.
    const afterCompletion = effParams.afterCompletion === true;
    if (expectedStartIso !== undefined) {
      const landed = landedFirstStart(deps, templateUuid, instanceUuid, afterCompletion);
      if (!(afterCompletion && landed === null) && landed !== expectedStartIso) {
        return nextMismatch(op, templateUuid, expectedStartIso, landed);
      }
    }

    const warnings: string[] = [
      landedRuleEcho(effParams, expectedStartIso ?? firstOccurrenceOf(deps.db, templateUuid)),
      `the original ${expectedType} (uuid ${srcUuid}) was moved to the Trash; \`things undo\` ` +
        "removes the new series (trash-both) and restores it",
      PLACEMENT_NOTE,
    ];
    // DBLSPAWN1: if the promote PRESERVED the source (deadline / terminal-element
    // trigger) as a FUTURE-dated instance, the app would spawn a duplicate on that date
    // — trash the redundant occurrence and disclose (cursor mints the single real one).
    const dbl = await trashRedundantFuturePreservedInstance(
      deps,
      kind,
      promote,
      options,
      txnId,
      now,
      afterCompletion,
    );
    if (dbl !== null) {
      warnings.push(dbl.warning);
      if (instanceUuid === dbl.trashedUuid) instanceUuid = null;
    }
    const offRule = offRuleFirstNote(effParams);
    if (offRule !== null) warnings.push(offRule);
    if (promote.warnings !== undefined) warnings.push(...promote.warnings);

    appendPromoteSummary(deps, {
      startedAt,
      op,
      txnId,
      templateUuid,
      instanceUuid,
      originalUuid: srcUuid,
      invocation: `${op}: clone ${srcUuid} → trash ${srcUuid} → promote ${cloneUuid} → template ${templateUuid}`,
      requested: effParams as unknown as Record<string, unknown>,
      ...(preserveModified && preUmd !== null && { preModDates: { [srcUuid]: preUmd } }),
    });

    return promoteOk({
      op,
      templateUuid,
      instanceUuid,
      replacedUuid: cloneUuid,
      title: src.title,
      txnId,
      warnings,
    });
  });
}

export function runMakeRepeatingTodo(
  deps: WriteDeps,
  params: RepeatRuleParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  return makeRepeatingViaClone(deps, "todo", params, options);
}

export function runMakeRepeatingProject(
  deps: WriteDeps,
  params: RepeatRuleParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  return makeRepeatingViaClone(deps, "project", params, options);
}

// ============================================================== add-repeating

/**
 * Shared add(full vocabulary) → native-promote for `todo.add-repeating` /
 * `project.add-repeating`. No trash leg — there is no original. The two legs are
 * NOT atomic: the created item persists even if the promote refuses.
 */
async function addRepeatingViaCreate(
  deps: WriteDeps,
  kind: "todo" | "project",
  addParams: Record<string, unknown>,
  rule: AddRepeatingRuleFields & Partial<Pick<RepeatRuleParams, "deadline" | "startDaysEarlier">>,
  title: string,
  options: WriteOptions,
): Promise<MutationResult> {
  const op: PromoteOp = kind === "project" ? "project.add-repeating" : "todo.add-repeating";
  assertRepeatRule(rule);

  // ANCH2 (issue #476): drive the Repeat dialog's "Next:" field with --when so the
  // series starts on the requested date (the field's default is today-anchored but
  // it is editable and honored). YANCH1 (issue #493): also DERIVE the calendar
  // anchor (weekly weekday / monthly day / yearly month+day) from --when when no
  // explicit anchor was given, and drive the anchor pop-ups — otherwise the
  // recurring rule keeps the dialog's untouched default (weekly Sunday, monthly
  // 1st, yearly January 1) and only the first occurrence is correct.
  //
  // DEADLINE-MODE (DBLSPAWN1): a deadlined rule anchors on the DEADLINE, and each
  // instance's START = deadline − startDaysEarlier (DACON1 DC4). `--when` is the
  // scheduled START, so the date the dialog's "Next:" field + anchor pop-ups must
  // carry is when + startDaysEarlier (the deadline); the app back-shifts the start to
  // `--when`. `runAddRepeatingTodo` maps a concrete item-level `--deadline` into the
  // rule's deadline/startDaysEarlier here (and strips it from the seed, so the source
  // is not SRCFATE-preserved as a double-booking future instance). For a non-deadlined
  // rule the shift is 0 and the drive date equals `--when` (unchanged).
  const whenIso = isIsoDate(addParams["when"]) ? (addParams["when"] as IsoDate) : null;
  const deadlineShift =
    rule.deadline === true || (rule.startDaysEarlier ?? 0) > 0 ? (rule.startDaysEarlier ?? 0) : 0;
  const driveIso = whenIso !== null ? addDaysIso(whenIso, deadlineShift) : null;
  const nextIso = driveIso ?? undefined;
  const expectedStartIso = whenIso ?? undefined;
  const effRule: AddRepeatingRuleFields &
    Partial<Pick<RepeatRuleParams, "deadline" | "startDaysEarlier">> = {
    ...rule,
    ...deriveFixedAnchor(rule, driveIso),
  };

  // ADR1 (issue #480, requested behavior #3): carry the base to-do's --reminder
  // onto the SERIES. The create leg sets a one-off reminderTime on the seed, but
  // the Repeat-dialog conversion does NOT preserve it — the dialog OWNS the repeat
  // reminder via its "Add reminders" control — so a base reminder was silently
  // dropped from the template (verified empty on golden-v2,
  // docs/lab/adr1-add-repeating-reveal.md). Drive the dialog's reminder with the
  // base time so every spawned occurrence carries it (ANCH2: the reminder picker
  // commits reminderTime deterministically). Projects have no reminder vocabulary,
  // so addParams never carries one there.
  const baseReminder =
    typeof addParams["reminder"] === "string" ? (addParams["reminder"] as string) : undefined;
  const effRuleWithReminder: AddRepeatingRuleFields &
    Partial<Pick<RepeatRuleParams, "reminder" | "deadline" | "startDaysEarlier">> =
    baseReminder !== undefined ? { ...effRule, reminder: baseReminder } : effRule;

  // The promote leg drives the GUI — block before creating anything if the ack is missing.
  if (options.dangerouslyDriveGui !== true && options.dryRun !== true) {
    return blockedUiDrive(op);
  }

  const expectedType = kind === "project" ? "project" : "to-do";
  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op,
      plan: {
        op,
        vector: "ui",
        tier: 3,
        invocation:
          `create ${expectedType} "${title}" (persists on its own) → then make-repeating ` +
          `(Repeat… → frequency=${rule.frequency}, interval=${rule.interval})`,
        expectedDelta: {
          mode: "create",
          probe: { title, type: expectedType, sinceEpoch: 0 },
          assert: [{ field: "repeating.isTemplate", equals: true }],
        },
        hazardsChecked: ["H-UI-DRIVE"],
      },
    };
  }

  // SESSGATE (#480): refuse a locked / full-screen session BEFORE seeding the row
  // (the two legs are not atomic — a doomed promote would strand the seed). Zero
  // mutation on refusal; a window merely on another Space is relocated in-drive.
  const gate = await gateSessionReachability(deps, op);
  if (gate !== null) return gate;

  // COMPOSITE LOCK: add → promote (→ the seed auto-trash / DBLSPAWN1 clean-up)
  // is one verb, several mutations; hold one lock across all of them so a
  // concurrent composite cannot land its own legs between ours.
  return runComposite(deps, op, async () => {
    const startedAt = deps.now?.() ?? new Date();
    const txnId = newTxnId(startedAt);

    // 1. Create the item (full add vocabulary) as an embedded leg.
    const addOp = kind === "project" ? "project.add" : "todo.add";
    const add = await runMutation(
      deps,
      addOp,
      addParams as never,
      legOptions(options, txnId, "url-scheme"),
    );
    if (add.kind !== "ok" || add.uuid === null) {
      return add.kind === "ok"
        ? {
            kind: "verify-failed",
            op,
            reason: "mismatch",
            expected: {
              mode: "create",
              probe: { title, type: expectedType, sinceEpoch: 0 },
              assert: [],
            },
            observed: null,
            detail: `the ${expectedType} was created but its uuid was not discovered — it cannot be promoted to repeating`,
          }
        : ({ ...add, op } as MutationResult);
    }
    const createdUuid = add.uuid;

    // 2. Native-promote the fresh row (ANCH2 Next drive + derived weekday + the
    //    base reminder driven onto the series, ADR1).
    const ruleParams = ruleParamsFor(createdUuid, effRuleWithReminder, nextIso);
    const promote =
      kind === "project"
        ? await promoteProjectViaGui(deps, ruleParams, legOptions(options, txnId, "ui"))
        : await runMutation(
            deps,
            "todo.make-repeating",
            ruleParams,
            legOptions(options, txnId, "ui"),
          );
    if (promote.kind !== "ok") {
      // The seed persists (the two legs are not atomic) but the promote did not
      // land. RATIFIED RULING (2026-08-15, issue #480): auto-trash our OWN seed
      // inside the txn — it is our artifact, recreatable verbatim from the command
      // args, and the Trash is recoverable — then disclose it. If the auto-trash
      // itself fails, the result carries the seed's REAL, resolvable uuid with a
      // working `delete` remediation, so cleanup is never ambiguous (the #480
      // second bug: a failed add-repeating left a residue whose reported uuid was
      // not actionable).
      const patch = await cleanupSeed(deps, kind, createdUuid, promote, options, txnId);
      return { ...promote, op, ...patch } as MutationResult;
    }
    const { templateUuid } = discoveryOf(promote);
    let { instanceUuid } = discoveryOf(promote);

    // Post-drive verify (ANCH2 + DBLSPAWN1): the instance START must have landed on the
    // requested `--when` — for a deadlined rule the driven Next is the deadline (when +
    // startDaysEarlier) and the app back-shifts the start to `--when`, so the check is
    // against `expectedStartIso`, not the raw drive date. Fail closed on mismatch rather
    // than report a wrong-phase ok. The series EXISTS here (promote landed) but on the
    // wrong phase, so this is a genuine partial success, NOT a seed to trash. The
    // ORACLE is rule-kind dependent (#508) — see landedFirstStart; an after-completion
    // series verifies against its materialized instance, and skips when it has none.
    const afterCompletion = effRuleWithReminder.afterCompletion === true;
    if (expectedStartIso !== undefined) {
      const landed = landedFirstStart(deps, templateUuid, instanceUuid, afterCompletion);
      if (!(afterCompletion && landed === null) && landed !== expectedStartIso)
        return nextMismatch(op, templateUuid, expectedStartIso, landed);
    }

    const warnings: string[] = [
      landedRuleEcho(ruleParams, expectedStartIso ?? firstOccurrenceOf(deps.db, templateUuid)),
      PLACEMENT_NOTE,
    ];
    // DBLSPAWN1 backstop: the deadline-mapping above keeps the seed deadline-free (no
    // SRCFATE preserve), but any OTHER preserve trigger reaching the seed (defensive)
    // would double-book a future first occurrence — trash the redundant instance.
    const dbl = await trashRedundantFuturePreservedInstance(
      deps,
      kind,
      promote,
      options,
      txnId,
      startedAt,
      afterCompletion,
    );
    if (dbl !== null) {
      warnings.push(dbl.warning);
      if (instanceUuid === dbl.trashedUuid) instanceUuid = null;
    }
    const offRule = offRuleFirstNote(ruleParams);
    if (offRule !== null) warnings.push(offRule);
    if (promote.warnings !== undefined) warnings.push(...promote.warnings);

    appendPromoteSummary(deps, {
      startedAt,
      op,
      txnId,
      templateUuid,
      instanceUuid,
      invocation: `${op}: add "${title}" ${createdUuid} → template ${templateUuid}`,
      requested: { title, ...effRule },
    });

    return promoteOk({
      op,
      templateUuid,
      instanceUuid,
      replacedUuid: createdUuid,
      title,
      txnId,
      warnings,
    });
  });
}

/** The add-repeating rule bag once a concrete deadline has been folded into it. */
type RuleWithDeadline = AddRepeatingRuleFields &
  Partial<Pick<RepeatRuleParams, "deadline" | "startDaysEarlier">>;

/**
 * Fold a concrete item-level `deadline` (and/or an explicit `startDaysEarlier`)
 * into the RULE, returning the rule to promote with and the deadline the SEED
 * should keep (none — the rule owns it). Shared by the to-do and project
 * add-repeating verbs so one geometry, and one set of refusals, serves both.
 *
 * DBLSPAWN1 (docs/lab/dblspawn1-preserved-instance.md): each occurrence is due
 * `deadline − when` days after its start (the "Add deadlines" + "start N days
 * earlier" dialog fields). This is the deadline the series actually wants, and
 * mapping it up front is also what keeps the SEED deadline-free — a to-do seed
 * carrying a deadline is SRCFATE-preserved as a materialized instance, and a
 * future-dated first occurrence then DOUBLE-BOOKS against the template cursor
 * and spawns a duplicate on the date (cell C). A project seed is DELETE-fate, so
 * there the un-mapped deadline was simply LOST rather than duplicated — a
 * quieter bug with the same cause and the same fix. A deadline needs a concrete
 * `when` (the per-occurrence offset is measured from the start) on/after it.
 *
 * DEADLINE/OFFSET AGREEMENT (ruling 2026-08-18): the same rule-global offset can
 * be named two ways — a concrete `deadline` (offset = deadline − when) OR an
 * explicit `startDaysEarlier` N (deadline derived as when + N). The geometry
 * when/deadline/N is OVER-DETERMINED: the dialog's start-offset is rule-global
 * and the first occurrence's start is derived as due − N, so there is no
 * per-first-instance gap to absorb a disagreement (unlike DACON1's off-rule-first
 * calendar freedom). So when BOTH are given they must AGREE — an exact match is
 * harmless redundancy, a mismatch is inexpressible and refused fast (zero
 * mutation). Either input ALONE maps to the rule.
 */
function mapDeadlineOntoRule(
  baseRule: AddRepeatingRuleFields,
  when: unknown,
  deadline: IsoDate | undefined,
  startDaysEarlier: number | undefined,
): { rule: RuleWithDeadline; seedDeadline: undefined } {
  if (!isIsoDate(when)) {
    throw new RangeError(
      "a repeating --deadline or --start-days-earlier needs a concrete --when date (the deadline " +
        "offset is measured from each occurrence's start) — schedule the series on a YYYY-MM-DD " +
        "--when, or drop --deadline / --start-days-earlier",
    );
  }
  let startEarlier: number;
  if (deadline !== undefined) {
    const derived = daysBetweenIso(when, deadline);
    if (derived < 0) {
      throw new RangeError(
        `--deadline (${deadline}) must be on or after --when (${when}) — a deadline cannot ` +
          "precede the occurrence's own start",
      );
    }
    if (startDaysEarlier !== undefined && startDaysEarlier !== derived) {
      throw new RangeError(
        `--deadline (${deadline}) puts each occurrence's due date ${derived} day` +
          `${derived === 1 ? "" : "s"} after its start (--when ${when}), but ` +
          `--start-days-earlier says ${startDaysEarlier} — these disagree. Drop one, or make them ` +
          `agree (--start-days-earlier ${derived}, or --deadline ${addDaysIso(when, startDaysEarlier)}).`,
      );
    }
    startEarlier = derived;
  } else {
    // `--start-days-earlier N` alone: the deadline is derived as when + N. A bad N
    // (non-integer / negative) is refused by assertRepeatRule once mapped.
    startEarlier = startDaysEarlier as number;
  }
  // The RULE owns the deadline; the seed carries none.
  return {
    rule: { ...baseRule, deadline: true, startDaysEarlier: startEarlier },
    seedDeadline: undefined,
  };
}

export async function runAddRepeatingTodo(
  deps: WriteDeps,
  params: TodoAddRepeatingParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  // The rule/add split is driven by the exhaustive key map (splitAddRepeatingRule),
  // not by a hand-written destructure — a field added to either vocabulary lands on
  // the right leg instead of falling between them (#549 / YANCH1 #493).
  const { rule: baseRule, add } = splitAddRepeatingRule(params);
  const { afterCompletion } = params;
  const startDaysEarlier = add.startDaysEarlier;

  // A concrete `--deadline` (or `--start-days-earlier`) belongs to the RULE, not
  // the seed — see mapDeadlineOntoRule for the geometry and the refusals. The
  // to-do stakes: an un-mapped seed deadline makes the app preserve the seed as a
  // future-dated instance that double-books the cursor (DBLSPAWN1 cell C).
  let rule: RuleWithDeadline = baseRule;
  let seedDeadline = add.deadline;
  if ((add.deadline !== undefined || startDaysEarlier !== undefined) && afterCompletion !== true) {
    ({ rule, seedDeadline } = mapDeadlineOntoRule(
      baseRule,
      add.when,
      add.deadline,
      startDaysEarlier,
    ));
  } else if (startDaysEarlier !== undefined) {
    // afterCompletion === true here: an after-completion repeat has no calendar
    // start to count a deadline back from — refuse rather than silently drop it.
    throw new RangeError(
      "--start-days-earlier applies only to a fixed-schedule deadline — an after-completion repeat " +
        "has no calendar start to count back from; drop --after-completion or --start-days-earlier",
    );
  }

  // The seed carries the WHOLE add vocabulary by spread (a field added to
  // TodoAddRepeatingParams reaches the create leg without a line here), minus the
  // two the rule took: `startDaysEarlier` is rule-only, and the deadline is
  // whatever the geometry left for the seed (none, once mapped).
  const addParams: Record<string, unknown> = { ...add };
  delete addParams["startDaysEarlier"];
  delete addParams["deadline"];
  if (seedDeadline !== undefined) addParams["deadline"] = seedDeadline;
  return addRepeatingViaCreate(deps, "todo", addParams, rule, add.title, options);
}

export async function runAddRepeatingProject(
  deps: WriteDeps,
  params: ProjectAddRepeatingParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  // Same exhaustive rule/add split as the to-do verb (one key map, both verbs).
  const { rule: baseRule, add } = splitAddRepeatingRule(params);
  const { afterCompletion } = params;

  // A concrete `--deadline` maps to the RULE here exactly as it does on the to-do
  // verb (DBLSPAWN1 residual). The project stakes are quieter than the to-do's but
  // no more acceptable: a project seed is DELETE-fate, so the app does not preserve
  // it into a double-booked instance — it simply DROPS the deadline, and the series
  // came out undeadlined with nothing said. Mapped, every occurrence is due
  // `deadline − when` days after its start.
  let rule: RuleWithDeadline = baseRule;
  let seedDeadline = add.deadline;
  if (add.deadline !== undefined) {
    if (afterCompletion === true) {
      // The to-do verb can leave a deadline on an after-completion seed because
      // that seed SURVIVES as the series' instance. An after-completion project's
      // seed is deleted and its instance is minted deadline-free (RSIM-P P4), so
      // the deadline would vanish either way — refuse rather than drop it quietly.
      throw new RangeError(
        "an after-completion repeating project cannot carry a --deadline: the rule has no calendar " +
          "start to measure a per-occurrence deadline from, and the created project is replaced by " +
          "the series' own instance, which is created without one — drop --after-completion to " +
          "deadline every occurrence, or drop --deadline",
      );
    }
    ({ rule, seedDeadline } = mapDeadlineOntoRule(baseRule, add.when, add.deadline, undefined));
  }

  // Seed a pure-AX taxonomy: an area lands a selectable AREA-view row; otherwise
  // create in Someday (UIC4-f) so the promote skips the anytime-header problem.
  const seedWhen = add.when ?? (add.area === undefined ? "someday" : undefined);
  // The whole add vocabulary by spread (see the to-do verb), with the two the
  // promote owns re-derived: the seed taxonomy `when` and the mapped deadline.
  const addParams: Record<string, unknown> = { ...add };
  delete addParams["when"];
  delete addParams["deadline"];
  if (seedWhen !== undefined) addParams["when"] = seedWhen;
  if (seedDeadline !== undefined) addParams["deadline"] = seedDeadline;
  return addRepeatingViaCreate(deps, "project", addParams, rule, add.title, options);
}

// ====================================================== template-direct clone

/**
 * The new-series-identity disclosure: a template clone is NOT linked to the
 * source — it is a fresh series with its own uuid, and references to the source
 * (its instances, its uuid) do not transfer.
 */
const NEW_SERIES_NOTE =
  "cloning a repeating template mints a NEW repeating series with its own identity — it is not " +
  "linked to the source template, and references to the source (its instances, its uuid) do not " +
  "transfer to the clone";

/** A fail-closed H-CLONE-SOURCE refusal for a template that cannot be cloned. */
function blockedCloneSource(op: PromoteOp, detail: string, remediation: string): MutationResult {
  return { kind: "blocked", op, reason: "hazard", hazard: "H-CLONE-SOURCE", detail, remediation };
}

/**
 * Name the specific feature that puts a decoded rule OUTSIDE the promote
 * vocabulary (used only when {@link ruleToInverseParams} returns null — the SAME
 * boundary the reschedule undo rides). Two shapes the Repeat dialog cannot
 * produce: two simultaneous end bounds, and a multi-anchor month/year rule.
 */
function inexpressibleReason(rule: RepeatRule): string {
  if (rule.endDate !== null && rule.occurrenceCount !== null) {
    return (
      "the source rule ends on BOTH a date and an occurrence count, which the repeat vocabulary " +
      "cannot express (its Ends bound is a single choice)"
    );
  }
  const anchors = rule.offsets.filter(
    (o) => o.day !== undefined || o.weekday !== undefined || o.month !== undefined,
  );
  if ((rule.unit === "monthly" || rule.unit === "yearly") && anchors.length > 1) {
    return (
      `the source ${rule.unit} rule fires on multiple calendar anchors, which the repeat ` +
      `vocabulary cannot express (it sets exactly one ${rule.unit} anchor)`
    );
  }
  return "the source recurrence rule uses a shape the repeat vocabulary cannot express";
}

/**
 * TEMPLATE-DIRECT clone (ruling 2026-08-13(d)): cloning a repeating TEMPLATE =
 * clone its content as a PLAIN item, then native-promote the clone with the
 * SOURCE's decoded rule — a NEW series identity, NO instances cloned, one instance
 * spawns immediately per the create law (identical to a from-scratch
 * add-repeating). Delegated to from `runCloneTodo`/`runCloneProject`'s
 * template-source branch (clone.ts).
 *
 * The compound:
 *   1. decode the source's rule (`repeating.rule`) — undecodable ⇒ refuse;
 *   2. map it onto the promote vocabulary (`ruleToInverseParams` + the template's
 *      deadline flag) — inexpressible (two end bounds / multi-anchor month-year) ⇒
 *      refuse, naming the feature (the SAME boundary the reschedule undo rides);
 *   3. gate on the GUI-drive ack (the promote leg drives the app) BEFORE minting;
 *   4. mint the plain clone (embedded leg, recurrence stripped — `cloneTemplateAsPlain`);
 *   5. native-promote the clone with the FULL decoded rule (incl. deadline/start-earlier).
 *
 * Result = the add-repeating contract (template uuid + `repeating{templateUuid,
 * instanceUuid|null}`); undo = trash-both (no original to restore). A PAUSED
 * source mints the new series UNPAUSED (pause is not part of the rule vocabulary),
 * disclosed. `--title`/`--preserve-created` behave as in ordinary clone (a
 * delete-fate promote may replace the clone row, so preserve-created is
 * best-effort on the surviving series — disclosed).
 */
export async function cloneTemplateViaRepromote(
  deps: WriteDeps,
  kind: "todo" | "project",
  src: Todo | Project,
  srcUuid: string,
  params: CloneParams,
  options: WriteOptions,
): Promise<MutationResult> {
  const op: PromoteOp = kind === "project" ? "project.add-repeating" : "todo.add-repeating";
  const expectedType = kind === "project" ? "project" : "to-do";
  const title = params.title ?? src.title;

  // 1. Decode the source template's rule (detail reads populate repeating.rule;
  //    an undecodable rule — a future Things schema — is omitted).
  const rule = src.repeating.rule;
  if (rule === undefined) {
    return blockedCloneSource(
      op,
      `the source ${expectedType} is a repeating template whose recurrence rule could not be ` +
        "decoded (an unrecognized rule format), so the series cannot be reproduced",
      "re-create the repeat in the Things app on a fresh " + expectedType,
    );
  }

  // 2. Map the decoded rule onto the promote vocabulary — refuse fail-closed when
  //    it falls outside what the Repeat dialog can express (name the feature).
  const inverse = ruleToInverseParams(rule, src.repeating.deadlined === true);
  if (inverse === null) {
    return blockedCloneSource(
      op,
      `${inexpressibleReason(rule)} — so this template cannot be cloned faithfully`,
      "re-create the repeat in the Things app on a fresh " + expectedType,
    );
  }

  // 3. The promote leg drives the GUI — block before minting a clone if the ack
  //    is missing (nothing created). An expressibility refusal above takes
  //    precedence (more informative than the drive block).
  if (options.dangerouslyDriveGui !== true && options.dryRun !== true) {
    return blockedUiDrive(op);
  }

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op,
      plan: {
        op,
        vector: "ui",
        tier: 3,
        invocation:
          `clone the template ${srcUuid} as a plain ${expectedType} (content only, recurrence ` +
          `stripped) → make-repeating the clone with the source's rule (Repeat… → ` +
          `frequency=${inverse.frequency}, interval=${inverse.interval})`,
        expectedDelta: {
          mode: "create",
          probe: { title, type: expectedType, sinceEpoch: 0 },
          assert: [{ field: "repeating.isTemplate", equals: true }],
        },
        hazardsChecked: ["H-CLONE-SOURCE", "H-UI-DRIVE"],
      },
    };
  }

  // SESSGATE (#480): refuse a locked / full-screen session BEFORE minting the
  // plain clone (a doomed promote would strand it). Zero mutation on refusal.
  const gate = await gateSessionReachability(deps, op);
  if (gate !== null) return gate;

  // COMPOSITE LOCK: clone-as-plain → promote-with-the-source's-rule is one verb;
  // hold one lock across both legs.
  return runComposite(deps, op, async () => {
    const startedAt = deps.now?.() ?? new Date();
    const txnId = newTxnId(startedAt);

    // 4. Mint the plain clone as an embedded leg — cloneTemplateAsPlain reaches the
    //    clone orchestrator's plain-content path (recurrence + schedule stripped);
    //    --title/--preserve-created ride through the CloneParams.
    const cloneParams: CloneParams = {
      uuid: srcUuid,
      ...(params.title !== undefined && { title: params.title }),
      ...(params.preserveCreated === true && { preserveCreated: true }),
    };
    const cloneOptions: WriteOptions = {
      ...legOptions(options, txnId),
      cloneTemplateAsPlain: true,
    };
    const clone =
      kind === "project"
        ? await runCloneProject(deps, cloneParams, cloneOptions)
        : await runCloneTodo(deps, cloneParams, cloneOptions);
    if (clone.kind !== "ok" || clone.uuid === null) {
      // A nested-repeater refusal (a template CONTAINING a nested repeater) or any
      // clone failure surfaces coherently here — re-label it to the compound op.
      return clone.kind === "ok"
        ? {
            kind: "verify-failed",
            op,
            reason: "mismatch",
            expected: {
              mode: "create",
              probe: { title, type: expectedType, sinceEpoch: 0 },
              assert: [],
            },
            observed: null,
            detail:
              "the plain clone was created but its uuid was not discovered — nothing was promoted",
          }
        : { ...clone, op };
    }
    const cloneUuid = clone.uuid;

    // 5. Native-promote the clone with the FULL decoded rule (ruleToInverseParams
    //    carries deadline/start-earlier + the calendar anchors + ends).
    const ruleParams: RepeatRuleParams = { uuid: cloneUuid, ...inverse };
    const promote =
      kind === "project"
        ? await promoteProjectViaGui(deps, ruleParams, legOptions(options, txnId, "ui"))
        : await runMutation(
            deps,
            "todo.make-repeating",
            ruleParams,
            legOptions(options, txnId, "ui"),
          );
    if (promote.kind !== "ok") {
      // The plain clone persists but was not promoted — honest report (no original
      // to roll back; the clone is a fresh row the caller can trash and retry).
      return {
        ...promote,
        op,
        ...("detail" in promote
          ? {
              detail:
                `${promote.detail} — the plain clone (uuid ${cloneUuid}) was created but the promote ` +
                `did not land; trash the clone with \`things ${kind} delete ${cloneUuid}\` and retry`,
            }
          : {}),
      } as MutationResult;
    }
    const { templateUuid, instanceUuid } = discoveryOf(promote);

    const warnings: string[] = [NEW_SERIES_NOTE, PLACEMENT_NOTE];
    if (params.preserveCreated === true) {
      warnings.push(
        "--preserve-created is best-effort on a template clone: the promote may replace the clone " +
          "row with the new template, whose creation date is the conversion time",
      );
    }
    if (src.repeating.paused === true) {
      warnings.push(
        `the source template was PAUSED; the new series is created UNPAUSED and begins spawning — ` +
          `pause it with \`things ${kind} pause-repeat\` if you want it suspended`,
      );
    }
    if (promote.warnings !== undefined) warnings.push(...promote.warnings);

    // Summary WITHOUT originalUuid → undo is the add-repeating trash-both (remove
    // the minted series; there is no original to restore).
    appendPromoteSummary(deps, {
      startedAt,
      op,
      txnId,
      templateUuid,
      instanceUuid,
      invocation: `${kind}.clone (template) ${srcUuid}: clone → promote ${cloneUuid} → template ${templateUuid}`,
      requested: { source: srcUuid, title, ...inverse },
    });

    return promoteOk({
      op,
      templateUuid,
      instanceUuid,
      replacedUuid: cloneUuid,
      title,
      txnId,
      warnings,
    });
  });
}
