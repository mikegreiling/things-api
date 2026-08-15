/**
 * The FIXED-recurrence anchor law + the phase-honour check the promote verbs use
 * (issue #476, evidence: docs/lab/anch1-repeat-anchor.md, golden-v2 / Things
 * 3.22.12).
 *
 * PROVEN LAW (ANCH1). When the Repeat dialog turns an item into a FIXED series it
 * anchors the FIRST occurrence to the next calendar match ON OR AFTER TODAY and
 * IGNORES the item's own scheduled `when` entirely (5/5 anchor-matrix cells:
 * when ∈ {today, aligned future weekday, misaligned weekday, someday} all landed
 * the same). It is INTERVAL-INDEPENDENT (interval 1 and 2 place the first
 * occurrence identically). With no explicit weekday the dialog defaults the
 * weekly weekday to SUNDAY (wd 0, the start of the week) — constant, independent
 * of today AND of the item's scheduled weekday (3/3 cells incl. a Monday probe).
 * There is NO first-occurrence control in the dialog (UIC6 field map) and no
 * post-promote vector that re-anchors the cursor to a requested phase (AS
 * `schedule` on the template → error 302; moving the instance leaves the cursor;
 * reschedule re-anchors to the current cursor — A5). So a requested first
 * occurrence that the app would drop cannot be honoured programmatically.
 *
 * Two consequences this module encodes:
 *  1. {@link deriveWeeklyWeekdays} — when a weekly rule omits `weekdays` but a
 *     concrete anchor date is known, derive the weekday FROM that date so the
 *     series fires on the intended weekday (not the app's Sunday default).
 *  2. {@link requestedPhaseHonored} — whether the app-anchored series would
 *     actually CONTAIN the requested first-occurrence date. For interval > 1 a
 *     mismatched phase silently drops the user's date; the promote verbs refuse
 *     fail-closed rather than create a wrong-phase series.
 *
 * Guarded frequencies: DAILY and WEEKLY (the ANCH1-probed law). MONTHLY/YEARLY
 * phase is NOT guarded here (their default anchor law is unprobed) — documented
 * residual in the campaign doc.
 */
import { addDaysIso, type IsoDate } from "../model/dates.ts";
import type { RepeatRuleParams, Weekday } from "./operations.ts";
import { WD_TO_WEEKDAY, WEEKDAY_TO_WD } from "./repeat-rule.ts";

/** True iff `v` is a concrete `YYYY-MM-DD` date (not a list keyword / undefined). */
export function isIsoDate(v: unknown): v is IsoDate {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Weekday of an ISO date, 0 = Sunday … 6 = Saturday (evaluated at UTC noon, tz-invariant). */
export function weekdayOfIso(iso: IsoDate): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/** Whole days from `a` to `b` (b − a); negative when b precedes a. */
function daysBetweenIso(a: IsoDate, b: IsoDate): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** The smallest date on or after `todayIso` whose weekday is `wd` (0 = Sunday). */
function nextWeekdayOnOrAfter(todayIso: IsoDate, wd: number): IsoDate {
  const delta = (((wd - weekdayOfIso(todayIso)) % 7) + 7) % 7;
  return addDaysIso(todayIso, delta);
}

/** The Sunday that starts the week containing `iso` (the app's weeks start Sunday). */
function weekAnchorSunday(iso: IsoDate): IsoDate {
  return addDaysIso(iso, -weekdayOfIso(iso));
}

/** A true modulo (result always in [0, n)). */
function mod(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/** The rule's effective weekday numbers (explicit set, else the app's Sunday default). */
function effectiveWds(rule: Pick<RepeatRuleParams, "weekdays">): number[] {
  return rule.weekdays !== undefined && rule.weekdays.length > 0
    ? rule.weekdays.map((w) => WEEKDAY_TO_WD[w])
    : [0];
}

/**
 * Whether `d` is on the active-week grid of a weekly rule anchored at `firstOcc`
 * (weeks fire every `interval` weeks from the anchor's Sunday-week). Weekday match
 * is checked separately.
 */
function weeklyActiveWeek(firstOcc: IsoDate, d: IsoDate, interval: number): boolean {
  const weeks = daysBetweenIso(weekAnchorSunday(firstOcc), weekAnchorSunday(d)) / 7;
  return mod(weeks, interval) === 0;
}

/**
 * When a WEEKLY rule omits its weekday set but a concrete anchor date is known,
 * the weekday to drive explicitly (so the series fires on the anchor date's
 * weekday, not the app's Sunday default). Returns `undefined` when nothing should
 * change (non-weekly, weekdays already given, or no concrete anchor date).
 */
export function deriveWeeklyWeekdays(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  anchorIso: IsoDate | null | undefined,
): Weekday[] | undefined {
  if (rule.afterCompletion === true) return undefined;
  if (rule.frequency !== "weekly") return undefined;
  if (rule.weekdays !== undefined) return undefined;
  if (!isIsoDate(anchorIso)) return undefined;
  return [WD_TO_WEEKDAY[weekdayOfIso(anchorIso)] as Weekday];
}

/**
 * The app's first occurrence of a FIXED daily/weekly rule = the next calendar
 * match on or after today. `null` for after-completion (no calendar) or an
 * unguarded frequency (monthly/yearly). Weekly uses `weekdays` (caller should
 * pass the DERIVED set); with no weekdays it falls back to the app's Sunday default.
 */
export function fixedFirstOccurrence(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
): IsoDate | null {
  if (rule.afterCompletion === true) return null;
  if (rule.frequency === "daily") return todayIso; // every day is an occurrence
  if (rule.frequency === "weekly") {
    let best: IsoDate | null = null;
    for (const wd of effectiveWds(rule)) {
      const cand = nextWeekdayOnOrAfter(todayIso, wd);
      if (best === null || daysBetweenIso(cand, best) > 0) best = cand;
    }
    return best;
  }
  return null; // monthly/yearly: default anchor law unprobed — not guarded
}

/**
 * The smallest occurrence STRICTLY AFTER today (the template's cursor,
 * rt1_nextInstanceStartDate). Daily/weekly only. Returns `null` for other
 * frequencies / after-completion.
 */
export function nextFixedOccurrenceAfter(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
): IsoDate | null {
  if (rule.afterCompletion === true) return null;
  if (rule.frequency === "daily") return addDaysIso(todayIso, Math.max(1, rule.interval));
  if (rule.frequency === "weekly") {
    const first = fixedFirstOccurrence(rule, todayIso);
    if (first === null) return null;
    const wds = effectiveWds(rule);
    const interval = Math.max(1, rule.interval);
    let d = addDaysIso(todayIso, 1);
    for (let i = 0; i < (interval + 2) * 7; i++) {
      if (wds.includes(weekdayOfIso(d)) && weeklyActiveWeek(first, d, interval)) return d;
      d = addDaysIso(d, 1);
    }
    return first; // unreachable in practice
  }
  return null;
}

/**
 * The spawn shape a FIXED daily/weekly `make-repeating` produces under the ANCH1
 * law: the calendar-offset reference date, the current-occurrence instance start
 * (null when today is not an occurrence → no instance spawns), the template
 * cursor (next occurrence strictly after today), and the instance-creation count.
 * MONTHLY/YEARLY are unprobed — callers keep their prior today+interval model.
 */
export interface FixedSpawnPlan {
  refIso: IsoDate;
  instanceStartIso: IsoDate | null;
  cursorIso: IsoDate;
  instanceCount: 0 | 1;
}

export function fixedSpawnPlan(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
): FixedSpawnPlan {
  const first = fixedFirstOccurrence(rule, todayIso);
  if (first === null) {
    // Not a guarded frequency — degenerate plan (caller handles monthly/yearly).
    return { refIso: todayIso, instanceStartIso: todayIso, cursorIso: todayIso, instanceCount: 1 };
  }
  const isToday = first === todayIso;
  const cursor = isToday ? (nextFixedOccurrenceAfter(rule, todayIso) ?? first) : first;
  return {
    refIso: first,
    instanceStartIso: isToday ? todayIso : null,
    cursorIso: cursor,
    instanceCount: isToday ? 1 : 0,
  };
}

/**
 * Whether the FIXED series the app WILL create (anchored at today, cadence
 * `interval` units) would actually CONTAIN the requested first-occurrence date.
 * Returns `true` (nothing to refuse) whenever the phase is irrelevant or cannot
 * be judged: after-completion, interval 1 (every match is an occurrence), a
 * monthly/yearly rule (unguarded), no concrete `requestedIso`, or a
 * `requestedIso` that isn't even a match of the rule's calendar pattern (the
 * item's own date is not a declaration of THIS rule's phase). Returns `false`
 * ONLY when a concrete, pattern-matching requested date would be DROPPED by the
 * app's today-anchored phase (daily/weekly, interval > 1) — the wrong-phase bug.
 */
export function requestedPhaseHonored(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
  requestedIso: IsoDate | null | undefined,
): boolean {
  if (rule.afterCompletion === true) return true;
  if (rule.interval <= 1) return true; // every match is an occurrence — phase is irrelevant
  if (!isIsoDate(requestedIso)) return true;
  if (rule.frequency === "daily") {
    const gap = daysBetweenIso(todayIso, requestedIso);
    if (gap < 0) return false; // a fixed series can't start in the past
    return mod(gap, rule.interval) === 0;
  }
  if (rule.frequency === "weekly") {
    if (!effectiveWds(rule).includes(weekdayOfIso(requestedIso))) return true; // not a pattern match
    const first = fixedFirstOccurrence(rule, todayIso);
    if (first === null) return true;
    return weeklyActiveWeek(first, requestedIso, rule.interval);
  }
  return true; // monthly/yearly: unguarded
}

/**
 * A one-line, human description of where the app WILL place the first occurrence
 * of this fixed rule (for the refusal message). Empty string when it can't be
 * described (monthly/yearly/after-completion).
 */
export function appAnchorDescription(
  rule: Pick<RepeatRuleParams, "frequency" | "interval" | "weekdays" | "afterCompletion">,
  todayIso: IsoDate,
): string {
  const first = fixedFirstOccurrence(rule, todayIso);
  if (first === null) return "";
  if (rule.frequency === "daily") return `${first} (today)`;
  const wd = weekdayOfIso(first);
  const name = WD_TO_WEEKDAY[wd] as Weekday;
  return `${first} (the next ${name} on or after today)`;
}
