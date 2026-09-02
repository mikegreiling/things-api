/**
 * THE DEFAULTS LAW, as arithmetic the drive can act on (DEFAULTS2, the build
 * DEFAULTS1 was the probe for — docs/lab/defaults1-repeat-dialog-defaults.md).
 *
 * The Repeat dialog SEEDS ITSELF FROM THE ROW. Measured across 70 cells (14 seed
 * states × 5 frequencies) on Things 3.23: the dialog derives its entire cadence
 * row from ONE date — `D = max(the row's scheduled date, today)` — recomputed on
 * every frequency change, and every value it carries is already final the first
 * instant the control exists (DEFAULTS1-4, so the shape probe's success IS the
 * gate). Eleven of eleven commit cells landed a rule blob byte-equivalent to the
 * one the full drive produces by clicking every control.
 *
 * WHY IT IS WORTH ARITHMETIC. Our own CLI MINTS THE SEED — `make-repeating`
 * clones the source and `add-repeating` creates the row by URL, and only then is
 * the dialog driven. So the CLI knows, before the drive starts, exactly what the
 * dialog is about to pre-fill; every control whose pre-fill is already correct is
 * an actuation that becomes a READ. On the maintainer's M1 each of those
 * actuations costs about a second of settles and recompute waits.
 *
 * THE RULE FOR THIS MODULE, STATED ONCE (DEFAULTS1 §9.4). A default may be
 * RELIED ON only where the seed's own shape makes it provable arithmetically
 * before the drive starts. Everything else keeps its actuation. And a claim made
 * here is not trusted: every key this module returns is VERIFIED BY READ in the
 * dialog before its setter is skipped (the `verify-prefill` hop), and a control
 * whose pre-fill is not what the arithmetic predicted falls back to the certified
 * setter for that control alone. The pre-commit audit (CGRD1) then re-reads every
 * control regardless, driven or pre-filled, so the fail direction is unchanged.
 *
 * VERSION-KEYED like the shape manifest. Every cell of the law was measured
 * against ONE app generation; an unrecognized build gets no reliance at all and
 * runs the full recipe exactly as it did before this module existed
 * ({@link shapeManifestCoversVersion}).
 */
import { addDaysIso, type IsoDate } from "../../model/dates.ts";
import type { MonthlyAnchor, RepeatFrequency, Weekday, YearlyAnchor } from "../operations.ts";
import {
  dayOfMonthIso,
  isIsoDate,
  monthOfIso,
  weekdayOfIso,
  daysBetweenIso,
} from "../repeat-anchor.ts";
import { WD_TO_WEEKDAY } from "../repeat-rule.ts";
import { shapeManifestCoversVersion } from "./ui-shape.ts";

/**
 * ONE pre-fillable dialog control, named. A key is the join between three
 * places: the arithmetic below decides whether it is provable, the recipe tags
 * the setter it would replace with it, and the `verify-prefill` hop reports it
 * matched or missed. A key the hop does not confirm is never skipped.
 */
export type PrefillKey =
  /** The cadence interval field ("Every [n] …") — always `1` in every measured cell. */
  | "interval"
  /** The after-completion unit pop-up — always `week`, whatever the seed. */
  | "ac-unit"
  /** The `Next:` first-occurrence pop-up — D itself. */
  | "next"
  /** The weekly weekday row(s) — exactly one row, D's own weekday. */
  | "weekdays"
  /** The monthly mode pop-up — always `day` (never the ordinal-weekday form). */
  | "monthly-mode"
  /** The monthly ordinal pop-up — D's day-of-month (never `last`). */
  | "monthly-ordinal"
  /** The yearly month pop-up — D's month. */
  | "yearly-month"
  /** The yearly mode pop-up — always `day`. */
  | "yearly-mode"
  /** The yearly ordinal pop-up — D's day-of-month. */
  | "yearly-ordinal"
  /** The "Add reminders" checkbox — pre-ticked iff the seed row carries a reminder. */
  | "add-reminders"
  /** The reminder time area — the seed row's own `reminderTime`, riding onto the template. */
  | "reminder-time"
  /** The "Add deadlines" checkbox — pre-ticked iff the seed row carries a deadline. */
  | "add-deadlines"
  /** The "and start N days earlier" offset — (seed deadline − seed start). */
  | "start-earlier";

/**
 * The seed row's own state, as READ from the database after the CLI minted it —
 * never as the CLI believes it minted it.
 *
 * That distinction is the whole safety of this module. `make-repeating` promotes
 * a CLONE and `add-repeating` promotes a freshly created row, and in both cases
 * the op's own uuid at compile time IS the seed — so the pre-read that every
 * command already performs is the authority on what the dialog is about to see.
 * A seed whose `when` the URL scheme clamped (a past date becomes today,
 * DEFAULTS1 §3.1) is therefore described correctly here, and the anchor
 * arithmetic below reaches the same answer the dialog will.
 */
export interface SeedRowFacts {
  /** The seed row's scheduled date, or null (Inbox / Someday / Anytime / no date). */
  scheduled: IsoDate | null;
  /** The response clock's local calendar date — the `max(…, today)` half of the anchor. */
  today: IsoDate;
  /** The seed row's deadline, or null. Deadline-free is the shipped seed shaping. */
  deadline: IsoDate | null;
  /** The seed row's reminder time (`HH:mm`), or null. */
  reminder: string | null;
}

/** The rule fields the arithmetic needs — a structural subset of `RepeatDialogRule`. */
export interface PrefillRule {
  frequency: RepeatFrequency;
  interval: number;
  afterCompletion?: boolean;
  weekdays?: Weekday[];
  monthly?: MonthlyAnchor;
  yearly?: YearlyAnchor;
  reminder?: string;
  deadline?: boolean;
  startDaysEarlier?: number;
  /** The date the recipe would drive into `Next:` (already deadline-shifted). */
  next?: string;
}

/**
 * THE SWITCH. `0`/`false`/`no`/`off` disables every reliance on the dialog's own
 * defaults, so the drive emits the full recipe — every setter, the interval hop
 * included — and no verify-by-read hop at all.
 *
 * It exists for the same reason {@link import("./ui-observer.ts").OBSERVER_ENV}
 * does: the shipped path and the path it replaced must BOTH be certifiable, and a
 * fallback that cannot be selected cannot be certified. With it set, the
 * generated scripts are the ones that shipped before this module existed, which
 * is what lets a lab cell prove the two paths land byte-identical rule blobs.
 * Machinery gets an off switch.
 */
export const PREFILL_ENV = "THINGS_API_PREFILL";

/** Is reliance on the dialog's pre-fill switched off by environment? */
export function prefillDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[PREFILL_ENV] ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

/**
 * THE ANCHOR (LAW DEFAULTS1-1, extended by §4): the LATEST of the row's
 * scheduled date, its deadline, and today.
 *
 * Every seed with no usable future date — Inbox, Someday, Anytime, this evening,
 * today — anchors the dialog on TODAY, which is the same answer an overdue row
 * would need (and an overdue row is not a state this seeding route can produce:
 * `things:///add` clamps a past `when` to today, DEFAULTS1 §3.1).
 *
 * THE DEADLINE TERM IS NOT A REFINEMENT, IT IS THE LAW'S OTHER HALF, and leaving
 * it out is how this module would have made a WRONG claim on a real shape. A
 * deadline on the row re-anchors the ENTIRE cadence row onto the due date
 * (DEFAULTS1 §4, cell S11: start 07-09 with a deadline 07-12 pre-fills `Next:`
 * Jul 12, weekly Sunday, monthly 12th — the deadline's geometry throughout), and
 * `make-repeating` on a to-do that already HAS a deadline is an ordinary thing to
 * ask for: the clone inherits it. Taking the maximum covers the flattened case
 * too — a deadline BEFORE the start is discarded by the dialog, which then
 * anchors on the start (S12, oddities §31) — so one expression fits every
 * measured cell of §4.
 *
 * Callers must not reach here for a seed that carries a deadline and NO
 * scheduled date; that state's pre-fill is unexplained (DEFAULTS1 §10.3 — an
 * anchor and an offset that agree with neither date), and {@link provenPrefills}
 * proves nothing at all for it.
 */
export function prefillAnchorDate(seed: SeedRowFacts): IsoDate {
  let anchor = seed.today;
  for (const candidate of [seed.scheduled, seed.deadline]) {
    if (candidate === null || !isIsoDate(candidate)) continue;
    if (daysBetweenIso(anchor, candidate) > 0) anchor = candidate;
  }
  return anchor;
}

/**
 * The pre-filled controls this seed PROVES, for this rule, on this app build.
 *
 * Absences are as load-bearing as presences, and each one is an absence MEASURED
 * across all 70 matrix cells rather than inferred (DEFAULTS1 §8):
 *
 *  - `interval` is always `1` — so an interval > 1 keeps its typing step;
 *  - `Ends:` is always `never` — no seed property expresses a series bound, so an
 *    ends bound is never claimed here at all;
 *  - a weekday set is always exactly ONE row (the anchor's own weekday) — a
 *    multi-weekday set keeps the converge;
 *  - the monthly/yearly mode is always `day`, and the ordinal is always the
 *    literal day-of-month: `last` is never selected and the ordinal-weekday form
 *    is never reached by inference (a seed ON the first Monday pre-fills `3rd`,
 *    not `Monday`/`1st` — DEFAULTS1-2, measured against seeds chosen to falsify
 *    it);
 *  - the after-completion unit is always `week`, so three of the four
 *    after-completion frequencies still need it driven;
 *  - the after-completion state carries NO `Next:` control, so the anchor date
 *    reaches an after-completion rule not at all — only its deadline offset and
 *    its reminder do (which is not the exception the campaign was briefed with:
 *    CNCAC2 had already removed that belief from the shipped mapping).
 */
export function provenPrefills(
  rule: PrefillRule,
  seed: SeedRowFacts,
  appVersion: string | null,
): Set<PrefillKey> {
  const keys = new Set<PrefillKey>();
  if (prefillDisabled()) return keys;
  // AN UNRECOGNIZED BUILD GETS NO RELIANCE. The laws were measured against one
  // app generation; a version this manifest was never sat with runs the full
  // recipe, exactly as it did before this module existed.
  if (!shapeManifestCoversVersion(appVersion)) return keys;

  const afterCompletion = rule.afterCompletion === true;
  // A DEADLINE WITH NO SCHEDULED DATE PROVES NOTHING (DEFAULTS1 §10.3). That seed
  // state pre-fills a `Next:` and an offset that agree with neither the deadline
  // nor today, and the campaign that measured it could not explain the arithmetic
  // — so there is no prediction to make, and a module whose whole contract is
  // "prove it before you claim it" makes none.
  if (seed.deadline !== null && seed.scheduled === null) return keys;
  const anchor = prefillAnchorDate(seed);

  // The interval field, in every cell of the whole matrix, under every frequency,
  // after-completion included.
  if (rule.interval === 1) keys.add("interval");

  if (afterCompletion) {
    // The opening default is `after completion, every 1 week` — not `day`. So
    // weekly is the one after-completion shape whose unit needs no actuation.
    if (rule.frequency === "weekly") keys.add("ac-unit");
  } else {
    // `Next:` — the requested first occurrence must BE the anchor. The recipe's
    // `next` is already deadline-shifted (it names the DUE date for a deadlined
    // rule), which is the same date the dialog derives from a seed scheduled on
    // the due date, so one comparison serves both shapes.
    if (isIsoDate(rule.next) && rule.next === anchor) keys.add("next");

    if (rule.frequency === "weekly" && rule.weekdays !== undefined) {
      const anchorWeekday = WD_TO_WEEKDAY[weekdayOfIso(anchor)];
      if (rule.weekdays.length === 1 && rule.weekdays[0] === anchorWeekday) keys.add("weekdays");
    }

    if (rule.monthly !== undefined && dayAnchorMatches(rule.monthly, anchor)) {
      keys.add("monthly-mode");
      keys.add("monthly-ordinal");
    }

    const yearly = rule.yearly;
    if (yearly !== undefined) {
      if (yearly.month === monthOfIso(anchor)) keys.add("yearly-month");
      if (dayAnchorMatches(yearly, anchor)) {
        keys.add("yearly-mode");
        keys.add("yearly-ordinal");
      }
    }
  }

  // DEADLINES (DEFAULTS1 §4). A deadline ON THE SEED re-anchors the whole cadence
  // row onto the DUE date, ticks `Add deadlines`, and pre-fills the offset with
  // (deadline − start) — after-completion included. The shipped seed shaping keeps
  // the seed DEADLINE-FREE (DBLSPAWN1 cell C: a to-do seed carrying a deadline is
  // SRCFATE-preserved as a materialized instance which double-books the template
  // cursor), so these two keys are unclaimable on the shipped path and are proved
  // here only for the shape that would earn them. Option A in DEFAULTS1 §9.3 is a
  // GATED follow-up: it needs the DBLSPAWN1 matrix re-run through the CLI first.
  const deadlineTarget: boolean | undefined =
    rule.deadline !== undefined
      ? rule.deadline
      : (rule.startDaysEarlier ?? 0) > 0
        ? true
        : undefined;
  if (deadlineTarget !== undefined && deadlineTarget === (seed.deadline !== null)) {
    keys.add("add-deadlines");
    const offset = rule.startDaysEarlier ?? 0;
    if (
      deadlineTarget &&
      offset > 0 &&
      seed.deadline !== null &&
      seed.scheduled !== null &&
      // THE OFFSET PRE-FILL IS FREQUENCY-DEPENDENT, AND UNDER AFTER-COMPLETION IT
      // IS CLAMPED (DEFAULTS2 §clamp — the correction to DEFAULTS1 §4, observed on
      // Things 3.23.2 by the maintainer and measured here). A far-future deadline
      // pre-fills its full offset under a fixed cadence and a much smaller number
      // under `after completion`; the arithmetic that predicts the fixed-cadence
      // value is therefore simply WRONG for the after-completion state, and a wrong
      // prediction must never become a claim. So the after-completion offset keeps
      // its actuation, whatever the seed holds.
      afterCompletion !== true &&
      // The dialog derives the offset from the ROW's own two dates, and a
      // deadline PRECEDING the start is silently flattened to 0 with the box
      // ticked and the date discarded (oddities §31) — a shape the CLI refuses
      // before dispatch, and one this claim must never make.
      daysBetweenIso(seed.scheduled, seed.deadline) === offset
    ) {
      keys.add("start-earlier");
    }
  }

  // REMINDERS (DEFAULTS1-3). A reminder lives in the row's own `reminderTime`
  // column, not in the recurrence blob, and a promote carries it onto the
  // template untouched: `Add reminders` comes up pre-ticked and the time rides
  // the row. The pre-tick is claimed from the row's own byte; the TIME is claimed
  // only when the row's reminder IS the requested one — and it is still verified,
  // through the ObjC date-area read the pre-commit audit already uses (System
  // Events reads that control's value as empty, which is a limitation of that
  // transport rather than of the control — DEFAULTS1 §11.3 left exactly this
  // "needs a working spelling" open, and the audit ships one).
  if (rule.reminder !== undefined && seed.reminder !== null) {
    keys.add("add-reminders");
    if (seed.reminder === rule.reminder) keys.add("reminder-time");
  }

  return keys;
}

/** Whether the anchor date satisfies a `day N` monthly/yearly anchor, day-of-month form only. */
function dayAnchorMatches(anchor: MonthlyAnchor | YearlyAnchor, iso: IsoDate): boolean {
  // The ordinal-weekday form and `last` are NEVER pre-filled (DEFAULTS1-2), so
  // they are not provable however well the date happens to fit them.
  if (!("day" in anchor)) return false;
  if (anchor.day === "last") return false;
  return anchor.day === dayOfMonthIso(iso);
}

/**
 * THE SEED SHAPING RULE for a deadlined rule (DEFAULTS1 §9.3 option B, the
 * recommendation): the seed is scheduled ON THE DUE DATE and stays deadline-free.
 *
 * It takes 44–47 % of the predicted field wall with NO change to the DBLSPAWN1
 * invariant at all — the seed still carries no deadline, so no preserve trigger
 * is armed — and it needs only that the seed's `when` be the date the dialog must
 * anchor on, which the compile already computes. The landed `next`/`icStart` still
 * hold the requested START, because the app back-shifts each occurrence's start by
 * N (NEXTPOP1's own 8/8, and DEFAULTS1's `CWD`/`CMD` commit cells).
 *
 * Returns the date the seed should be scheduled on, or null when the request
 * gives nothing to shape (no concrete start, or a drive date the URL scheme would
 * clamp — DEFAULTS1 §3.1: a past `when` silently becomes today, so a seed that
 * cannot hold the date must keep its actuation rather than claim a wrong anchor).
 */
export function seedScheduleFor(
  startIso: unknown,
  startDaysEarlier: number,
  todayIso: IsoDate,
): IsoDate | null {
  if (!isIsoDate(startIso)) return null;
  const due = startDaysEarlier > 0 ? addDaysIso(startIso, startDaysEarlier) : startIso;
  return daysBetweenIso(todayIso, due) >= 0 ? due : null;
}
