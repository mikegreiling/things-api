/**
 * FULL-FIDELITY expected-rule assertions for the rule-writing verbs
 * (reschedule-repeat, make-repeating, add-repeating; to-do AND project).
 *
 * The idempotency precheck (pipeline.ts step 5a½) and the post-drive verify both
 * ride the SAME {@link FieldAssertion} set an op's `expectedDelta` produces. When
 * that set asserted only unit+interval (the RSIM5-era shallow subset), a
 * reschedule that changed ONLY the monthly anchor / deadline offset / ends bound
 * read back "already satisfied" and was skipped with a false idempotent-no-op —
 * issue #491. This builder closes that class by construction: it maps the COMPLETE
 * requested vocabulary onto assertions over the DECODED rule (decodeRecurrenceRule
 * shapes) + the template's deadline column, never a raw blob/string compare.
 *
 * Two laws:
 *  1. REQUESTED-FIELDS-ONLY. Only fields the caller actually set contribute an
 *     assertion; the three base fields (type/unit/interval) are always asserted
 *     (frequency+interval are required; the rule TYPE is meaningful even when
 *     `afterCompletion` is defaulted). A bare `{frequency, interval}` reschedule
 *     therefore never fails on an untouched anchor/ends/deadline — those keep
 *     their existing don't-care semantics.
 *  2. EXHAUSTIVE MAP. {@link RULE_ASSERT_MAP} is a `Record` over every key of the
 *     rule vocabulary; each key is either an assert-producer or an explicit skip
 *     carrying a written reason. Adding a field to {@link RepeatRuleParams} breaks
 *     compilation here until it is consciously handled — a multi-consumer
 *     vocabulary must never be hand-enumerated per consumer (decisions.md).
 */
import { anchorKeyOfOffsets, decodeOffsetEntry } from "../model/recurrence.ts";
import type { IsoDate } from "../model/dates.ts";
import { composeRepeatRuleSpec } from "./recurrence-rule-blob.ts";
import type { RepeatEnds, RepeatRuleParams } from "./operations.ts";
import type { FieldAssertion } from "./verify/delta.ts";

/** The full requested-rule vocabulary minus the target uuid. */
export type RuleFields = Omit<RepeatRuleParams, "uuid">;

/**
 * How ONE rule-vocabulary field contributes to the expected-rule assertion set:
 * it either PRODUCES assertions or is consciously SKIPPED with a written reason.
 */
type FieldAssertSpec =
  | {
      kind: "assert";
      /** Emit even when the field is absent — the always-meaningful base fields. */
      always?: boolean;
      /**
       * Presence trigger, overriding the default `params[key] !== undefined`. Used
       * where a field's assertion is triggered by a SIBLING (a start-offset request
       * also asserts a deadline, since startDaysEarlier implies one).
       */
      when?: (p: RuleFields) => boolean;
      build: (p: RuleFields) => FieldAssertion[];
    }
  | { kind: "skip"; reason: string };

/** A never-used anchor reference: every anchor path that reaches the key builder
 * carries an EXPLICIT anchor (weekdays/monthly/yearly present), so composeOffsets
 * never falls back to deriving one from this date. */
const ANCHOR_DUMMY_REF = "2000-01-01" as IsoDate;

/**
 * The canonical, order-insensitive anchor key the DECODED rule would carry for
 * these requested params — computed by composing the numeric offsets exactly as a
 * write would and round-tripping them through the SAME per-offset decode the read
 * path uses, so the expected key is byte-consistent with the observed one.
 */
function expectedAnchorKey(p: RuleFields): string {
  const spec = composeRepeatRuleSpec({ uuid: "", ...p }, ANCHOR_DUMMY_REF, 0);
  return anchorKeyOfOffsets(
    (spec.of ?? []).map((o) => decodeOffsetEntry(o as Record<string, unknown>)),
  );
}

/**
 * The Ends bound, per the RRX1 laws: ends-after sets the `rc` occurrence-count
 * total and OMITS the end date; ends-on-date sets `ed` and no count; never = both
 * null. Every arm asserts BOTH columns so a reschedule from one bound kind to
 * another is fully discriminated (e.g. after→on-date must clear the count).
 */
function endsAsserts(ends: RepeatEnds): FieldAssertion[] {
  switch (ends.kind) {
    case "never":
      return [
        { field: "repeating.rule.endDate", equals: null },
        { field: "repeating.rule.occurrenceCount", equals: null },
      ];
    case "on-date":
      return [
        { field: "repeating.rule.endDate", equals: ends.date },
        { field: "repeating.rule.occurrenceCount", equals: null },
      ];
    case "after":
      return [
        { field: "repeating.rule.occurrenceCount", equals: ends.count },
        { field: "repeating.rule.endDate", equals: null },
      ];
    default: {
      const exhaustive: never = ends;
      throw new Error(`unknown ends bound ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * EXHAUSTIVE over every key of the rule vocabulary. The mapped-type key set (`-?`
 * makes each required) is what makes a newly added {@link RepeatRuleParams} field
 * a COMPILE error until it earns an entry here.
 */
const RULE_ASSERT_MAP: { [K in keyof RuleFields]-?: FieldAssertSpec } = {
  frequency: {
    kind: "assert",
    always: true,
    build: (p) => [{ field: "repeating.rule.unit", equals: p.frequency }],
  },
  interval: {
    kind: "assert",
    always: true,
    build: (p) => [{ field: "repeating.rule.interval", equals: p.interval }],
  },
  afterCompletion: {
    kind: "assert",
    // The rule TYPE is always meaningful (an absent flag ⇒ a fixed schedule); a
    // fixed→after-completion conversion leaves unit+interval unchanged, so without
    // this the precheck could not tell the target had not yet been reached.
    always: true,
    build: (p) => [
      {
        field: "repeating.rule.type",
        equals: p.afterCompletion === true ? "after-completion" : "fixed",
      },
    ],
  },
  weekdays: {
    kind: "assert",
    build: (p) => [{ field: "repeating.rule.anchorKey", equals: expectedAnchorKey(p) }],
  },
  monthly: {
    kind: "assert",
    build: (p) => [{ field: "repeating.rule.anchorKey", equals: expectedAnchorKey(p) }],
  },
  yearly: {
    kind: "assert",
    build: (p) => [{ field: "repeating.rule.anchorKey", equals: expectedAnchorKey(p) }],
  },
  ends: {
    kind: "assert",
    build: (p) => (p.ends === undefined ? [] : endsAsserts(p.ends)),
  },
  deadline: {
    kind: "assert",
    // A start-offset request also asserts a deadline: startDaysEarlier implies one
    // (assertRepeatRule refuses startDaysEarlier with deadline:false).
    when: (p) => p.deadline !== undefined || (p.startDaysEarlier ?? 0) > 0,
    build: (p) => [
      {
        field: "repeating.deadlined",
        equals: p.deadline === true || (p.startDaysEarlier ?? 0) > 0,
      },
    ],
  },
  startDaysEarlier: {
    kind: "assert",
    // ts = −startDaysEarlier on the decoded rule (a deadline-relative start offset).
    build: (p) => [{ field: "repeating.rule.startOffsetDays", equals: -(p.startDaysEarlier ?? 0) }],
  },
  next: {
    kind: "assert",
    // The ANCH2 first-occurrence cursor (rt1_nextInstanceStartDate → nextOccurrence).
    // Gated by RuleAssertOptions.includeCursor — see expectedRuleAssertions.
    build: (p) =>
      p.next === undefined ? [] : [{ field: "repeating.nextOccurrence", equals: p.next }],
  },
  reminder: {
    kind: "skip",
    reason:
      "not stored in the recurrence-rule blob (rt1_recurrenceRule) — 'Add reminders' sets a " +
      "time-of-day on the SPAWNED INSTANCES, not on the rule (RRX1/ANCH2). It has no decoded-rule " +
      "field to compare against, so it is verified through the instance reminder-byte path, not here.",
  },
};

export interface RuleAssertOptions {
  /**
   * Include the ANCH2 first-occurrence cursor assertion (`repeating.nextOccurrence`)
   * when `next` is requested. TRUE for reschedule-repeat — the cursor is driven
   * into the EXISTING template in place, so a wrong-anchor drive is caught. FALSE
   * for make-repeating / add-repeating: the freshly-minted template's cursor
   * follows the app's spawn law (ANCH1: next calendar match ≥ today), not the raw
   * Next field, so those verbs verify the rule BLOB + deadline only.
   */
  includeCursor: boolean;
}

/**
 * Build the full-fidelity expected-rule assertion set for a validated rule-params
 * bag. The base three (type/unit/interval) are always emitted; every other field
 * contributes only when requested (requested-fields-only law).
 */
export function expectedRuleAssertions(
  params: RuleFields,
  opts: RuleAssertOptions,
): FieldAssertion[] {
  const out: FieldAssertion[] = [];
  for (const key of Object.keys(RULE_ASSERT_MAP) as (keyof RuleFields)[]) {
    // The cursor is a reschedule-only expectation (see RuleAssertOptions).
    if (key === "next" && !opts.includeCursor) continue;
    const spec = RULE_ASSERT_MAP[key];
    if (spec.kind === "skip") continue;
    const present = spec.when !== undefined ? spec.when(params) : params[key] !== undefined;
    if (present || spec.always === true) out.push(...spec.build(params));
  }
  return out;
}
