/**
 * Template-mutation composites — "Create Next Copy, then mutate the instance"
 * (design of record: docs/lab/cnc1-template-mutations.md; ruling 2026-08-24).
 *
 * A repeating template refuses every schedule/status write we ship, and the
 * app's own Make Exception chooser is not on the automation path. CNC1 measured
 * the alternative and it is exact: `Items ▸ Repeat ▸ Create Next Copy` followed
 * by an ordinary write to the row it mints reproduces Make Exception FIELD FOR
 * FIELD on the template (weekly against REPX3 §1.2, daily against §2.1; the
 * vacated slot then stays silent when the clock reaches it, against a live
 * control that spawns normally). The composite differs from the chooser by one
 * column on one row — the minted instance's modification stamp, which the
 * chooser leaves unset — and that difference is the winning side of Things
 * Cloud's merge arbitration (SYNCX1), so it is the safe direction.
 *
 * Two composites live here:
 *
 *   - {@link runTemplateStatusWrite} — `complete`/`cancel` aimed at a series.
 *     UNFLAGGED, because there is exactly one sane reading of "check off this
 *     repeating to-do". If the series already has an OPEN materialized
 *     occurrence, that IS the current one and it is resolved directly (no
 *     mint); otherwise the pending occurrence is materialized first and
 *     resolved. Either way the template is left byte-unchanged and the series
 *     continues on schedule (CNC1 §6, measured for `cancel` as well as
 *     `complete`).
 *
 *   - {@link runTemplateExceptionWrite} — `update --exception` aimed at a
 *     series: move/re-deadline/re-remind ONLY the next occurrence. Always mints,
 *     because the exception semantics belong to the PENDING occurrence — the one
 *     the rule has not spawned yet. (Re-dating an already-materialized
 *     occurrence is an ordinary update on that row and consumes no slot, so the
 *     rule would still spawn its own copy — REPX1 §3.2. Callers who want that
 *     can address the occurrence directly.)
 *
 * Three refusals, each measured, are enforced before anything is driven:
 *
 *   1. a target date that is a live slot of the same rule DOUBLE-BOOKS that day
 *      (CNC1 §2, inheriting oddities §17 whole);
 *   2. a series with NO CURSOR has no pending occurrence to materialize, and
 *      `Create Next Copy` duplicates the current one onto the same day instead
 *      (CNC1 §5, CNCAC1 §6/§8, oddities §18);
 *   3. repeating PROJECTS are out of scope: the menu that carries the command
 *      does not exist for a project selection (CNC1 §8).
 *
 * Refusal 2 used to be keyed on the rule KIND — "after-completion" — and that
 * was fail-closed guesswork that fired on the wrong state. CNCAC1 measured the
 * shape it was actually hitting: an after-completion series ANCHORS on its
 * occurrence being resolved and DERIVES a real cursor from that anchor, so a
 * series with a completed history renders a projection in Upcoming, the GUI
 * checks that projection off, and `Create Next Copy` materializes it correctly
 * with no duplicate — byte-equivalent to the GUI gesture modulo the minted row's
 * modification stamp. The duplicate belongs to the CURSOR-LESS case alone (a
 * never-resolved series, or a paused one), which is what this now refuses.
 *
 * Reversibility is HALF and is disclosed at op time: `things undo` restores the
 * occurrence's own change perfectly, and can neither remove the materialized
 * occurrence nor rewind the series (CNC1 §7).
 */
import { addDaysIso, decodePackedDate, localToday, type IsoDate } from "../model/dates.ts";
import type { RepeatRule } from "../model/recurrence.ts";
import { projectOccurrences } from "../model/occurrences.ts";
import { byUuid } from "../read/detail.ts";
import type { OperationKind, UpdateFields } from "./operations.ts";
import {
  runComposite,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";

/** How far ahead the collision check will look for a live slot. */
const SLOT_LOOKAHEAD = 400;

const IRREVERSIBLE_NOTE =
  "`things undo` restores this occurrence's own change; it cannot remove the occurrence that was " +
  "created for it, and the series has already moved on to its following date";

const PROJECT_REFUSAL =
  "this is a repeating project, and only repeating to-dos can have a single occurrence changed";

const PROJECT_REMEDIATION =
  "change the whole series with `things project reschedule-repeat <ref>`, or change one of its " +
  "to-dos directly";

/**
 * The precondition, stated as what it actually is. A composite can only work on
 * an occurrence the series has NOT spawned yet, and the app tells us whether
 * there is one: `rt1_nextInstanceStartDate`. When it is null there is no next
 * date to bring forward, and `Create Next Copy` does not refuse — it DUPLICATES
 * the current occurrence onto the same day (CNC1 §5 / CNCAC1 §6, oddities §18).
 *
 * This replaces a rule-KIND refusal that fired on the wrong state. It read "an
 * after-completion series has no upcoming occurrence until the current one is
 * done" — but CNCAC1 measured that an after-completion series acquires a real
 * cursor the moment its occurrence is resolved (completed, canceled, OR
 * trashed), which is precisely when the old branch fired: it refused the one
 * shape whose projection the app renders in Upcoming and happily checks off.
 *
 * With that corrected, the only state that reaches this refusal is a PAUSED
 * series whose occurrence is already resolved — and there the refusal earns its
 * keep for a second measured reason. CNC on a paused series does not duplicate;
 * it quietly materializes the occurrence the pause was suppressing, from the
 * stale anchor, and clears that anchor while leaving the paused flag set
 * (CNCAC1 §8). Producing an occurrence from a series the user deliberately
 * paused is not a reading of "check this off" worth guessing at, so the refusal
 * names `resume-repeat` instead.
 */
const NO_PENDING_REFUSAL =
  "this repeating to-do has no upcoming occurrence to work on — its schedule names no next date, " +
  "so there is nothing to bring forward";

/** What the composite learned about the series before it drove anything. */
interface SeriesState {
  templateUuid: string;
  title: string;
  /** The pending occurrence's date — the slot a mint would consume. */
  cursor: IsoDate | null;
  rule: RepeatRule | null;
  deadlined: boolean;
  afterCompletion: boolean;
  /** The series is paused, which is WHY it has no cursor — a different remedy. */
  paused: boolean;
  /** An already-materialized OPEN occurrence of this series, if there is one. */
  openInstance: { uuid: string; startDate: IsoDate | null } | null;
}

function blocked(op: OperationKind, detail: string, remediation: string): MutationResult {
  return { kind: "blocked", op, reason: "environment", detail, remediation };
}

/**
 * Read everything the composite decides on, in one pass. Returns null when the
 * target is not a repeating to-do template, which the caller has already
 * established but which keeps this total.
 */
export function readSeriesState(deps: WriteDeps, uuid: string): SeriesState | null {
  const target = byUuid(deps.db, uuid);
  if (target === null || target.type === "heading" || !target.repeating.isTemplate) return null;
  const rule = target.repeating.rule ?? null;
  const rows = deps.db
    .prepare(
      "SELECT uuid, startDate FROM TMTask WHERE rt1_repeatingTemplate = ? AND trashed = 0 " +
        "AND status = 0 ORDER BY startDate, creationDate",
    )
    .all(uuid) as { uuid: string; startDate: number | null }[];
  const first = rows[0];
  return {
    templateUuid: uuid,
    title: target.title,
    cursor: target.repeating.nextOccurrence ?? null,
    rule,
    deadlined: target.repeating.deadlined === true,
    afterCompletion: rule !== null && rule.type === "after-completion",
    paused: target.repeating.paused === true,
    openInstance:
      first === undefined
        ? null
        : { uuid: first.uuid, startDate: decodePackedDate(first.startDate) },
  };
}

/**
 * The dates this rule will still produce ON ITS OWN after the pending
 * occurrence has been materialized — i.e. every slot from the one AFTER the
 * cursor up to and including `until`. Landing an occurrence on one of these
 * leaves that day holding two copies once the clock reaches it (CNC1 §2), which
 * is the whole reason this list exists.
 *
 * Empty when the rule is undecodable or has no calendar: nothing can be proven
 * about a rule we cannot read, and the caller refuses rather than guessing.
 */
export function liveSlotsAfterMint(state: SeriesState, until: IsoDate): IsoDate[] {
  const { rule, cursor } = state;
  if (rule === null || rule.type !== "fixed" || cursor === null) return [];
  if (until <= cursor) return [];
  const projected = projectOccurrences(
    rule,
    cursor,
    { count: SLOT_LOOKAHEAD, until },
    state.deadlined,
  );
  // The first projection IS the cursor — the slot the mint consumes, not a
  // collision. Everything after it is a slot the rule will still fire.
  return projected.slice(1).map((o) => o.startDate);
}

/**
 * Resolve the calendar day a `when` value lands on, or null when it names no
 * single day (`anytime`/`someday` are not dated, so they cannot collide with a
 * slot).
 */
function whenTargetDay(when: string | undefined, todayIso: IsoDate): IsoDate | null {
  if (when === undefined) return null;
  if (when === "today" || when === "evening") return todayIso;
  if (when === "tomorrow") return addDaysIso(todayIso, 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(when) ? (when as IsoDate) : null;
}

/**
 * The refusal for a series with nothing pending, with the remedy that fits WHY
 * it is empty. A paused series is one command away from having a cursor again;
 * anything else is the app's own business.
 */
function noPendingRefusal(op: OperationKind, state: SeriesState): MutationResult {
  if (state.paused) {
    return blocked(
      op,
      "this repeating to-do is paused, so it has no upcoming occurrence to work on",
      "resume it first with `things todo resume-repeat <ref>`",
    );
  }
  return blocked(op, NO_PENDING_REFUSAL, "work on one of its occurrences directly");
}

/** Human phrasing for "the occurrence dated X" when X may be unknown. */
function occurrenceLabel(date: IsoDate | null): string {
  return date === null ? "the current occurrence" : `the ${date} occurrence`;
}

/** Where the series goes next, read back AFTER the composite has run. */
function nextOccurrenceAfter(deps: WriteDeps, templateUuid: string): IsoDate | null {
  const target = byUuid(deps.db, templateUuid);
  if (target === null || target.type === "heading") return null;
  return target.repeating.nextOccurrence ?? null;
}

/**
 * Materialize the pending occurrence and hand back its uuid. Split out because
 * both composites need exactly this, including the failure phrasing: a mint
 * that did not land must never be reported as a mutation that did.
 */
async function mintPendingOccurrence(
  deps: WriteDeps,
  op: OperationKind,
  templateUuid: string,
  options: WriteOptions,
  txnId: string,
): Promise<{ ok: true; uuid: string } | { ok: false; result: MutationResult }> {
  const mint = await runMutation(
    deps,
    "todo.create-next-copy",
    { uuid: templateUuid },
    {
      ...options,
      txn: { id: txnId, role: "leg" },
      vector: "ui",
      // The GUI-drive ACKNOWLEDGEMENT is made here, on the caller's behalf, and
      // it is the one place in the package that does so. Rationale (ruling
      // 2026-08-24): these verbs are UNFLAGGED — "check off this repeating
      // to-do" and "move only the next occurrence" already name the effect the
      // user asked for, and there is no other way to perform either, so a second
      // flag would be ceremony with no decision behind it. Nothing else is
      // relaxed: Article IV's capability gate still refuses a machine whose
      // helpers have no GUI tier, and the disruption ceiling still refuses
      // unless the caller allowed a change that visibly drives the app — which
      // is the control that keeps this from being a surprise.
      dangerouslyDriveGui: true,
    },
  );
  if (mint.kind !== "ok" || mint.uuid === null) {
    return {
      ok: false,
      result: {
        ...mint,
        op,
        ...("detail" in mint
          ? { detail: `${mint.detail} — no occurrence was created, so nothing was changed` }
          : {}),
      } as MutationResult,
    };
  }
  return { ok: true, uuid: mint.uuid };
}

function newTxnId(now: Date): string {
  return `txn-${now.getTime().toString(36)}-${process.pid.toString(36)}`;
}

// ------------------------------------------------------------ status writes

/**
 * `complete`/`cancel` aimed at a repeating to-do. Resolves the series' CURRENT
 * occurrence: the open materialized one when it exists, otherwise the pending
 * one, materialized first. The template itself is never written — CNC1 §6
 * measured both status writes leaving it byte-unchanged, with the series
 * continuing at its next date and exactly one occurrence per day.
 */
export async function runTemplateStatusWrite(
  deps: WriteDeps,
  op: "todo.complete" | "todo.cancel",
  uuid: string,
  /**
   * The status write itself, applied to ONE ordinary occurrence. Injected
   * rather than imported so the caller keeps ownership of its own vocabulary —
   * `--completed-at` backdating, the children policy — and so this module does
   * not have to import the resolution orchestrator that calls it.
   */
  runStatusLeg: (occurrenceUuid: string, legOptions: WriteOptions) => Promise<MutationResult>,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const now = deps.now?.() ?? new Date();
  return runComposite(deps, op, async () => {
    const state = readSeriesState(deps, uuid);
    if (state === null) return blocked(op, "this to-do is no longer a repeating series", "retry");
    const txnId = newTxnId(now);

    let targetUuid: string;
    let occurrenceDate: IsoDate | null;
    let minted = false;
    if (state.openInstance !== null) {
      targetUuid = state.openInstance.uuid;
      occurrenceDate = state.openInstance.startDate;
    } else {
      if (state.cursor === null) return noPendingRefusal(op, state);
      const mint = await mintPendingOccurrence(deps, op, state.templateUuid, options, txnId);
      if (!mint.ok) return mint.result;
      targetUuid = mint.uuid;
      occurrenceDate = state.cursor;
      minted = true;
    }

    const write = await runStatusLeg(targetUuid, {
      ...options,
      txn: { id: txnId, role: "leg" },
    });
    if (write.kind !== "ok") return { ...write, op } as MutationResult;

    const verb = op === "todo.complete" ? "checked off" : "canceled";
    const nextDate = nextOccurrenceAfter(deps, state.templateUuid);
    const disclosure = [
      `${verb} ${occurrenceLabel(occurrenceDate)} of "${state.title}"` +
        (minted ? " (created just now, because the series had no unfinished copy)" : ""),
      nextDate === null
        ? "the series has no further scheduled occurrence"
        : state.afterCompletion
          ? `the next occurrence is ${nextDate} — this series counts from each completion, so ` +
            "resolving it now restarted the interval from today"
          : `the next occurrence is ${nextDate}`,
    ];
    if (minted) disclosure.push(IRREVERSIBLE_NOTE);
    return {
      ...write,
      op,
      warnings: [...(write.warnings ?? []), ...disclosure],
    };
  });
}

// --------------------------------------------------------- exception writes

/**
 * `update --exception` aimed at a repeating to-do: change ONLY the next
 * occurrence. Materializes the pending occurrence and applies the patch to it,
 * which is what the app's own "make a one-time exception" does.
 */
export async function runTemplateExceptionWrite(
  deps: WriteDeps,
  uuid: string,
  patch: UpdateFields & Record<string, unknown>,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const op: OperationKind = "todo.update";
  const now = deps.now?.() ?? new Date();
  const todayIso = localToday(now, options.zone);
  return runComposite(deps, op, async () => {
    const state = readSeriesState(deps, uuid);
    if (state === null) return blocked(op, "this to-do is no longer a repeating series", "retry");

    if (state.cursor === null) return noPendingRefusal(op, state);

    // The collision refusal (CNC1 §2). A day the rule will still fire on ends up
    // holding two copies of the series, and nothing in the app reconciles them.
    const targetDay = whenTargetDay(
      typeof patch["when"] === "string" ? patch["when"] : undefined,
      todayIso,
    );
    if (targetDay !== null && !state.afterCompletion) {
      // An after-completion series is exempt BY CONSTRUCTION, not by assumption:
      // it has no calendar, so it owns exactly one future date — the cursor this
      // mint is about to consume — and there is no second slot for the moved
      // occurrence to collide with (CNCAC1 §7).
      if (state.rule === null || state.rule.type !== "fixed") {
        return blocked(
          op,
          "this series' schedule cannot be read, so there is no way to tell whether " +
            `${targetDay} is a day it already lands on`,
          "move the occurrence in the Things app, or change the whole series with " +
            "`things todo reschedule-repeat <ref>`",
        );
      }
      if (liveSlotsAfterMint(state, targetDay).includes(targetDay)) {
        return blocked(
          op,
          `"${state.title}" already lands on ${targetDay} — moving this occurrence there would ` +
            "leave two copies on that day, and the app does not merge them",
          "pick a day the series does not already land on, or change the whole series with " +
            "`things todo reschedule-repeat <ref>`",
        );
      }
    }

    const txnId = newTxnId(now);
    const mint = await mintPendingOccurrence(deps, op, state.templateUuid, options, txnId);
    if (!mint.ok) return mint.result;

    const write = await runMutation(
      deps,
      "todo.update",
      { uuid: mint.uuid, ...patch },
      { ...options, txn: { id: txnId, role: "leg" } },
    );
    if (write.kind !== "ok") {
      return {
        ...write,
        op,
        ...("detail" in write
          ? {
              detail:
                `${write.detail} — the ${occurrenceLabel(state.cursor)} was created but not ` +
                `changed; it is now a plain to-do you can edit directly (${mint.uuid})`,
            }
          : {}),
      } as MutationResult;
    }

    const nextDate = nextOccurrenceAfter(deps, state.templateUuid);
    return {
      ...write,
      op,
      warnings: [
        ...(write.warnings ?? []),
        `changed only ${occurrenceLabel(state.cursor)} of "${state.title}" — the series itself is ` +
          "unchanged",
        nextDate === null
          ? "the series has no further scheduled occurrence"
          : `the next occurrence is ${nextDate}`,
        IRREVERSIBLE_NOTE,
      ],
    };
  });
}

export { PROJECT_REFUSAL, PROJECT_REMEDIATION };
