/**
 * UNEXPLAINED-DELTA DETECTION for the rule-writing verbs (CGRD1 guard 3).
 *
 * The assertion set {@link import("./repeat-asserts.ts").expectedRuleAssertions}
 * builds proves the REQUESTED fields landed. It says nothing about the fields the
 * caller did not request, and a GUI drive is exactly the kind of writer that can
 * move one by accident: it fills a dialog whose controls interact, and #589 showed
 * a wrong-address write landing in a control nobody asked about while every check
 * in the drive reported OK. So a reschedule verifies twice — the requested rule
 * IS what was asked for, and nothing ELSE moved.
 *
 * The second check is a pre/post diff of the DECODED rule (the
 * `decodeRecurrenceRule` shapes) plus the template columns beside it, over the same
 * vocabulary RRF1's assertions compare. Every CHANGED field must be ATTRIBUTABLE:
 * either the caller requested it, or it is an explicitly mapped CO-MOVER of
 * something the caller requested — a field the app is known to rewrite as a
 * consequence, with the law written down beside it. Anything else is a
 * `verify-failed:collateral`: the requested change was applied, but a field the
 * caller did not ask about also moved, so the write is reported rather than blessed.
 *
 * FAIL CLOSED, NOT WARN. Things' repeat dialog is driven through an undocumented
 * private surface; an unexplained field movement is the signature of the app
 * having been re-laid-out under us, and the caller must hear about it as a failure.
 *
 * EXHAUSTIVE MAP, per the #491 structural doctrine (decisions.md 2026-08-17):
 * {@link RULE_ATTRIBUTION} is a `Record` over every key of the decoded rule plus
 * every watched template column, so a field added to `RepeatRule` breaks
 * compilation here until somebody classifies it. A per-consumer hand-enumeration
 * is exactly what that doctrine forbids.
 *
 * ONE DELIBERATE EXCLUSION, written down rather than silently omitted: the
 * template's `rt1_instanceCreationCount` (icCount) is NOT in this vocabulary,
 * because the decoder does not surface it — it is read only by the projection
 * internals (model/template-projection.ts), never onto the decoded entity, so
 * there is no field for `getField` to diff. Were it ever surfaced it would be a
 * CO-MOVER of every cadence field: it is the app's own spawn tally, and the
 * template-mutation verbs advance it by design (CNC1). It is named here so its
 * absence is a decision rather than an oversight.
 */
import type { RepeatRule } from "../model/recurrence.ts";
import type { RuleFields } from "./repeat-asserts.ts";

/** A rule-vocabulary key the caller may have requested. */
type RuleParam = keyof RuleFields;

/** The template columns beside the rule blob that this diff also watches. */
type TemplateColumn = "deadlined" | "nextOccurrence" | "paused";

/** Every field the collateral diff compares, pre versus post. */
type CollateralField = `rule.${keyof RepeatRule}` | TemplateColumn;

/**
 * ONE reason a field is allowed to differ pre → post. `independent` never
 * attributes anything: it marks a field no request can legitimately move, so any
 * change to it is collateral by definition.
 */
type AttributionClause =
  | { kind: "requested"; param: RuleParam }
  | { kind: "co-moves-with"; param: RuleParam; reason: string }
  | { kind: "independent"; reason: string };

/** The complete set of reasons ONE field may have moved. */
type Attribution = readonly AttributionClause[];

const requested = (...params: RuleParam[]): AttributionClause[] =>
  params.map((param) => ({ kind: "requested", param }));
const coMovesWith = (reason: string, ...params: RuleParam[]): AttributionClause[] =>
  params.map((param) => ({ kind: "co-moves-with", param, reason }));
const independent = (reason: string): AttributionClause[] => [{ kind: "independent", reason }];

/** Where each watched field is read from on the decoded entity. */
const FIELD_PATH: { [K in CollateralField]-?: string } = {
  "rule.type": "repeating.rule.type",
  "rule.unit": "repeating.rule.unit",
  "rule.interval": "repeating.rule.interval",
  "rule.startOffsetDays": "repeating.rule.startOffsetDays",
  // The calendar anchor is compared through its canonical, ORDER-INSENSITIVE key —
  // the same surface expectedRuleAssertions asserts on, so a weekly rule that fires
  // Tue+Thu reads identically whichever order the app stored the two offsets in.
  "rule.offsets": "repeating.rule.anchorKey",
  "rule.endDate": "repeating.rule.endDate",
  "rule.occurrenceCount": "repeating.rule.occurrenceCount",
  "rule.version": "repeating.rule.version",
  deadlined: "repeating.deadlined",
  nextOccurrence: "repeating.nextOccurrence",
  paused: "repeating.paused",
};

/** How each watched field reads in the failure copy. */
const FIELD_LABEL: { [K in CollateralField]-?: string } = {
  "rule.type": "the repeat mode (fixed / after completion)",
  "rule.unit": "the repeat frequency",
  "rule.interval": "the repeat interval",
  "rule.startOffsetDays": "the start-days-earlier offset",
  "rule.offsets": "the calendar anchor",
  "rule.endDate": "the end date",
  "rule.occurrenceCount": "the occurrence count",
  "rule.version": "the rule's storage-format version",
  deadlined: "the deadline flag",
  nextOccurrence: "the next occurrence",
  paused: "the paused flag",
};

/**
 * EXHAUSTIVE over the decoded-rule vocabulary + the watched template columns.
 * A field added to {@link RepeatRule} is a COMPILE error until it earns an entry.
 *
 * Every co-mover carries the law that makes it one. These are not conveniences:
 * each is a measured app behavior, and classifying one wrongly is how a real
 * corruption would be waved through.
 */
const RULE_ATTRIBUTION: { [K in CollateralField]-?: Attribution } = {
  "rule.type": requested("afterCompletion"),
  "rule.unit": requested("frequency"),
  "rule.interval": requested("interval"),
  "rule.offsets": [
    ...requested("weekdays", "monthly", "yearly"),
    ...coMovesWith(
      "a frequency change REBUILDS the calendar anchor — the dialog resets the offsets to the " +
        "new unit's nominal (yearly → January 1, monthly → the 1st, weekly → Sunday) unless an " +
        "anchor is driven, which is the anchor-drop #493 closed",
      "frequency",
    ),
    ...coMovesWith(
      "a fixed → after-completion conversion resets the calendar offsets to the unit nominal " +
        "(UIC7, oddities §8p) — an after-completion rule has no calendar to anchor on",
      "afterCompletion",
    ),
    ...coMovesWith(
      "with no explicit anchor, the anchor is DERIVED from the requested first occurrence and " +
        "driven into the dialog's anchor pop-ups (YANCH1 #493), so asking for a first occurrence " +
        "moves the anchor by design",
      "next",
    ),
  ],
  "rule.endDate": requested("ends"),
  "rule.occurrenceCount": requested("ends"),
  "rule.startOffsetDays": [
    ...requested("startDaysEarlier"),
    ...coMovesWith(
      "the deadline flag and the start offset are one control pair in the dialog — unticking " +
        "'Add deadlines' hides the offset field and clears it, and ticking it materializes one " +
        "(which is why assertRepeatRule refuses a start offset with deadline:false)",
      "deadline",
    ),
  ],
  "rule.version": independent(
    "the rule blob's own storage-format version is written by Things, never requested. A bump " +
      "means the app changed the format under this driver, which is a finding rather than a " +
      "side effect of any rule field",
  ),
  deadlined: [
    ...requested("deadline"),
    ...coMovesWith(
      "a start offset implies a deadline: a bare start-days-earlier request converges the " +
        "'Add deadlines' checkbox to ticked (#492 requested-fields-only), because the offset " +
        "field only exists while it is",
      "startDaysEarlier",
    ),
  ],
  nextOccurrence: [
    ...requested("next"),
    ...coMovesWith(
      "the cursor is the first RULE-ALIGNED occurrence (ANCH1 spawn law), so ANY change to the " +
        "cadence or the calendar anchor recomputes it",
      "frequency",
      "interval",
      "weekdays",
      "monthly",
      "yearly",
    ),
    ...coMovesWith(
      "an after-completion series rests with NO next occurrence between instances (RRX1), so a " +
        "conversion either way moves the cursor",
      "afterCompletion",
    ),
    ...coMovesWith(
      "the app CLEARS the cursor when a series ends — a past ends-on date, or an ends-after " +
        "total already reached (RRX1) — so changing the bound can null it",
      "ends",
    ),
    ...coMovesWith(
      "in deadline mode the dialog's first-occurrence field IS the deadline date and each " +
        "instance starts start-days-earlier before it (YANCH1 #493), so the deadline pair " +
        "shifts the cursor",
      "deadline",
      "startDaysEarlier",
    ),
  ],
  paused: independent(
    "pausing and resuming a series is its own verb. A reschedule never asks for it, and no " +
      "measured app behavior flips it as a consequence, so a change here is unexplained",
  ),
};

/** Every decoded-entity field path the pre-read must capture for this diff. */
export const COLLATERAL_FIELD_PATHS: readonly string[] = Object.values(FIELD_PATH);

/** ONE field that moved without a request or a mapped co-mover to explain it. */
export interface CollateralFinding {
  /** The decoded-entity path, as the `observed` bag names it. */
  field: string;
  /** How the field reads in the failure copy. */
  label: string;
  pre: unknown;
  post: unknown;
}

/** `undefined` and `null` are the same absence here (the capture normalizes to null). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null) return b === undefined || b === null;
  return a === b;
}

/**
 * The unattributable pre → post differences among the watched fields.
 *
 * `pre` and `post` are field-path → value bags over {@link COLLATERAL_FIELD_PATHS}.
 * A field is only judged when BOTH bags carry it: a target that was not a repeating
 * template before the write has no rule to diff against, so the check yields
 * nothing rather than reporting every field as collateral (which is also why
 * make-repeating and add-repeating do not carry it — they MINT the rule).
 */
export function collateralFindings(
  requestedParams: ReadonlySet<RuleParam>,
  pre: Record<string, unknown>,
  post: Record<string, unknown>,
): CollateralFinding[] {
  // No decodable pre-rule ⇒ nothing to diff (the target was not yet a template).
  const preUnit = pre[FIELD_PATH["rule.unit"]];
  if (preUnit === undefined || preUnit === null) return [];
  const findings: CollateralFinding[] = [];
  for (const key of Object.keys(RULE_ATTRIBUTION) as CollateralField[]) {
    const path = FIELD_PATH[key];
    if (!(path in pre) || !(path in post)) continue;
    const before = pre[path];
    const after = post[path];
    if (sameValue(before, after)) continue;
    const attributable = RULE_ATTRIBUTION[key].some(
      (clause) => clause.kind !== "independent" && requestedParams.has(clause.param),
    );
    if (attributable) continue;
    findings.push({
      field: path,
      label: FIELD_LABEL[key],
      pre: before ?? null,
      post: after ?? null,
    });
  }
  return findings;
}

/** How a value reads in the failure copy. */
function show(value: unknown): string {
  if (value === null || value === undefined) return "none";
  return String(value);
}

/**
 * The `verify-failed:collateral` sentence: what the caller asked for DID land, and
 * which field(s) moved that they never mentioned, with both values, so the first
 * thing they do is look rather than retry.
 */
export function describeCollateral(findings: CollateralFinding[]): string {
  const moved = findings
    .map((f) => `${f.label} went from ${show(f.pre)} to ${show(f.post)}`)
    .join("; ");
  const count = findings.length === 1 ? "a field" : `${findings.length} fields`;
  return (
    `the requested repeat rule was applied, but ${count} nobody asked to change also moved: ` +
    `${moved}. Re-read the item before doing anything else — this is not a rejected parameter, ` +
    `it is the app writing something the request did not name, so a retry would repeat it.`
  );
}
