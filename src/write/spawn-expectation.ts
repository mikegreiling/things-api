/**
 * THE SPAWN-EXPECTATION MAP (#634) — what the app is KNOWN to do about
 * materializing a repeating series' first occurrence, per rule shape × anchor
 * relation, and the assertion that turns that knowledge into an honest
 * post-promote disclosure.
 *
 * The failure this replaces: a successful after-completion monthly promote with
 * a future anchor warned *"could not derive the spawned instance: no row links
 * back to the new repeating template (the app may not have materialized the
 * current occurrence)"* — a shrug, as though the absence were a surprise. It is
 * not a surprise. The spawn laws are MEASURED per rule shape, and for that
 * shape zero instances is the CORRECT and expected outcome. So:
 *
 *  - the expectation is stated up front, from the rule and the anchor date;
 *  - it is ASSERTED against what the FK derivation actually found;
 *  - a mismatch in EITHER direction (expected-and-missing, or unexpected-found)
 *    is a real `warning` — something is wrong with the series;
 *  - the expectation MET is a matter-of-fact `note` naming when the first
 *    occurrence appears, or nothing at all when the instance is present and
 *    returned (the caller already has it).
 *
 * RRF1 discipline: {@link SPAWN_EXPECTATIONS} has an explicit entry for every
 * (rule kind × anchor relation) cell with the evidence that pins it, and the
 * compiler enforces completeness — the map is typed as a total record over both
 * axes, so adding a rule kind or an anchor relation breaks the build until the
 * new cells are given a verdict and a citation.
 */

import type { IsoDate } from "../model/dates.ts";

// --------------------------------------------------------------- the two axes

/**
 * The rule shapes the app treats DIFFERENTLY for first-occurrence
 * materialization. This is deliberately coarser than the full rule vocabulary:
 * frequency and interval do NOT affect materialization (ANCH1 §A2 measured
 * interval 1 and interval 2 placing the first occurrence identically — "the
 * interval only sets the CADENCE, not the anchor"), so they are not axes here.
 *
 *  - `fixed` — a calendar rule (`afterCompletion: false`), including a
 *    deadline-bearing one: DACON1/NEXTPOP1 measured the deadline as a SHIFT of
 *    the dates the rule carries, not a change to whether an occurrence
 *    materializes, so it is not its own kind.
 *  - `fixed-preserved` — a fixed rule whose SOURCE was preserved by the app and
 *    relinked as the current-occurrence instance (SRCFATE's preserve triggers:
 *    a to-do deadline, a terminal element in the subtree, a project's nested
 *    repeater). The source's survival IS the materialization, which makes this
 *    a genuinely different cell from a plain fixed promote.
 *  - `after-completion` — a cursor-less rule (`afterCompletion: true`) whose
 *    next date is derived from each completion.
 */
export type SpawnRuleKind = "fixed" | "fixed-preserved" | "after-completion";

/**
 * Where the series' first occurrence falls relative to the local TODAY at
 * promote time. `unknown` is the honest fallback for a promote whose first
 * occurrence could not be read back (an undecodable rule, a missing cursor) —
 * it asserts nothing rather than guessing.
 */
export type AnchorRelation = "today" | "future" | "past" | "unknown";

/** Whether an instance row should exist the moment the promote returns. */
export type SpawnVerdict =
  /** An instance MUST already exist — its absence is a real problem. */
  | "materialized"
  /** No instance yet, and that is correct — the app mints it on the named date. */
  | "pending"
  /**
   * No instance yet, and the date it appears is not knowable from the rule —
   * an after-completion series with no cursor waits for a completion.
   */
  | "pending-until-completion"
  /** The evidence does not pin this cell; assert nothing (see {@link AnchorRelation}). */
  | "unpinned";

export interface SpawnExpectation {
  verdict: SpawnVerdict;
  /** The probe evidence pinning this cell — doc + section/cell id. */
  evidence: string;
  /** Why the app behaves this way, in one line. */
  why: string;
}

// ------------------------------------------------------------------- the map

/**
 * EXHAUSTIVE over rule kind × anchor relation. Every cell carries a verdict and
 * the campaign that measured it; the `unpinned` verdict is a first-class
 * answer — the map says "we have not measured this" rather than inventing a
 * behavior, and an unpinned cell asserts nothing at all.
 */
export const SPAWN_EXPECTATIONS: Record<SpawnRuleKind, Record<AnchorRelation, SpawnExpectation>> = {
  // ------------------------------------------------------------------ fixed
  fixed: {
    today: {
      verdict: "materialized",
      evidence: "FGRD1 §8 (3.23/golden-v4); ANCH1 §A3 a3-today/a3-align; RSIM1",
      why:
        "committing a rule whose first occurrence is TODAY makes the app materialize that " +
        "occurrence immediately and advance the cursor to the next slot — so a fixed same-day " +
        "series that has NO instance did not land the way it was asked to",
    },
    future: {
      verdict: "pending",
      evidence: "ANCH1 §A2 (5/5 cells, icCount=0); UIC8 §C4 spawn-shape law; ANCH1 Phase-B FIX2",
      why:
        "a fixed promote whose first occurrence is in the future materializes only the template " +
        "and its cursor; the occurrence is minted when the date arrives (FIX2 watched it appear " +
        "on the day, with the cursor advancing by the cadence)",
    },
    past: {
      verdict: "unpinned",
      evidence:
        "ANCH1 §A2 law (`sr` = today, `ia` = the next match >= today) — never reachable by default",
      why:
        "the app anchors a fixed rule to the next calendar match ON OR AFTER TODAY, so a " +
        "past first occurrence is not a state the promote paths produce; no campaign has " +
        "driven one deliberately, so nothing is asserted about it",
    },
    unknown: {
      verdict: "unpinned",
      evidence: "n/a — the first-occurrence date could not be read back",
      why: "with no anchor date there is no expectation to assert; the derivation stays silent",
    },
  },

  // -------------------------------------------------------- fixed, preserved
  //
  // The SOURCE survived the promote and was relinked as the current-occurrence
  // instance (SRCFATE §P1). Its survival is the materialization, so an instance
  // exists whatever the date — including the future, which is the state the app
  // itself double-books from.
  "fixed-preserved": {
    today: {
      verdict: "materialized",
      evidence: "RSIM-T T-deadline (1/1); SRCFATE §P1 (2/2 every cell)",
      why:
        "the preserved source IS the current occurrence — the app relinked it in place " +
        "(`rt1_repeatingTemplate` set) and minted only the template",
    },
    future: {
      verdict: "materialized",
      evidence: "DBLSPAWN1 cell A (the double-book) + cell C (the duplicate spawn)",
      why:
        "a preserved source dated in the FUTURE is a materialized future occurrence — a state " +
        "normal spawning never creates, and the one the app later double-books on. The " +
        "composite trashes the redundant occurrence itself (DBLSPAWN1 cell F), so a caller " +
        "reaching this cell with no instance normally means that trash leg ran",
    },
    past: {
      verdict: "materialized",
      evidence:
        "DBLSPAWN1 (a today/past-dated preserved instance is the legitimate current occurrence)",
      why: "the preserved row exists regardless of its date; only a FUTURE one is redundant",
    },
    unknown: {
      verdict: "materialized",
      evidence: "SRCFATE §P1 — the preserve fate is read from the source itself, not from a date",
      why:
        "the preserve verdict is established by the source surviving and relinking, which is " +
        "known even when the occurrence date is not",
    },
  },

  // ------------------------------------------------------- after-completion
  //
  // The cursor-less family. CNCAC1 §7.1 measured a never-completed
  // after-completion series seeded on TODAY: `next = NULL`, `icCount = 1`, one
  // live occurrence. VMRES1 §1 measured the FUTURE-anchored shape on the same
  // golden and found the opposite: ZERO instances, with `rt1_nextInstanceStartDate`
  // holding the requested date verbatim. That split is the whole of #634's field
  // report — the two cells look identical to a caller and behave oppositely.
  "after-completion": {
    today: {
      verdict: "materialized",
      evidence: "CNCAC1 §1.1/§7.1 cell N (3.23/golden-v4); CERTSWEEP1 §4 cell AC; UIC8 §C4b/C4d",
      why:
        "an after-completion promote anchored on today spawns its first instance immediately " +
        "(icCount=1, one live occurrence) and carries NO cursor until something is completed",
    },
    future: {
      verdict: "pending",
      evidence: "VMRES1 §1 (3/3 shapes, at rest); ACFUT1 cells R/R2 + control C (the spawn itself)",
      why:
        "a future-anchored after-completion promote materializes NOTHING — every measured shape " +
        "landed zero non-trashed instances — and instead populates `rt1_nextInstanceStartDate` " +
        "with the requested date verbatim. ACFUT1 then rolled the clock and watched the " +
        "occurrence appear ON that date, exactly once, in both creation shapes, against a " +
        "fixed-rule control that spawned on the same relaunch. THIS IS THE #634 FIELD CASE: the " +
        "old derivation called it a surprise; it is the measured law, and the date we name is " +
        "the date the app keeps",
    },
    past: {
      verdict: "unpinned",
      evidence: "ACFUT1 cell A2b — the shape is UNREACHABLE, not unmeasured",
      why:
        "the app normalizes a past start date to today, so a promote can never be anchored in " +
        "the past; the cell stays unasserted because nothing can land in it",
    },
    unknown: {
      verdict: "pending-until-completion",
      evidence: "CNCAC1 §7.1 (a never-completed series has `next = NULL`); REPX1 §2.5",
      why:
        "an after-completion series with no readable cursor has no calendar at all — its next " +
        "date is derived from a completion, so there is no date to name",
    },
  },
};

/** The expectation for one cell. Total over both axes by construction. */
export function spawnExpectation(kind: SpawnRuleKind, relation: AnchorRelation): SpawnExpectation {
  return SPAWN_EXPECTATIONS[kind][relation];
}

// ------------------------------------------------------- classifying a promote

/**
 * Which cell of the map a landed promote sits in.
 *
 * `preserved` is the SOURCE FATE the derivation already resolved (the source
 * survived and relinked), not a guess from the rule — SRCFATE's triggers are
 * structural, so the fate is read, never predicted.
 */
export function spawnRuleKind(input: {
  afterCompletion: boolean;
  preserved: boolean;
}): SpawnRuleKind {
  if (input.afterCompletion) return "after-completion";
  return input.preserved ? "fixed-preserved" : "fixed";
}

/**
 * Where a first-occurrence date sits relative to today. Both dates are local
 * ISO days, so the comparison is a plain string compare — no timezone
 * arithmetic, and no "same day but different instant" ambiguity.
 */
export function anchorRelation(firstOccurrence: IsoDate | null, todayIso: IsoDate): AnchorRelation {
  if (firstOccurrence === null) return "unknown";
  if (firstOccurrence === todayIso) return "today";
  return firstOccurrence > todayIso ? "future" : "past";
}

// ------------------------------------------------------------ the assertion

/**
 * The outcome of asserting the expectation against what was actually found.
 * `id` is the disclosure id the caller routes through {@link disclose}, so the
 * TIER of each outcome is decided in the registry, not here.
 */
export type SpawnAssertion =
  | { id: "instance-pending"; text: string }
  | { id: "instance-missing"; text: string }
  | { id: "instance-unexpected"; text: string }
  | null;

/** Days from `from` to `to`, both local ISO days. */
function daysUntil(from: IsoDate, to: IsoDate): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** "in 3 days" / "tomorrow" / "today" — the human half of the pending note. */
function whenPhrase(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/**
 * ASSERT the spawn expectation. Returns the single disclosure this promote
 * should carry about its instance, or `null` when there is nothing to say —
 * which is the common case: the expectation was "materialized" and an instance
 * was found, so the caller already holds it in `repeating.instanceUuid` and a
 * line restating that would be noise.
 *
 * Mismatches are reported in BOTH directions, because both mean the series is
 * not what the measured laws say it should be.
 */
export function assertSpawnExpectation(input: {
  kind: SpawnRuleKind;
  relation: AnchorRelation;
  /** The first-occurrence date the template carries, when readable. */
  firstOccurrence: IsoDate | null;
  todayIso: IsoDate;
  /** Did the FK derivation find an instance row? */
  found: boolean;
}): SpawnAssertion {
  const expectation = spawnExpectation(input.kind, input.relation);

  // An UNPINNED cell asserts nothing in either direction — the map refuses to
  // turn "we have not measured this" into a verdict about the caller's series.
  if (expectation.verdict === "unpinned") return null;

  if (expectation.verdict === "materialized") {
    if (input.found) return null; // expected and present — the caller has it
    return {
      id: "instance-missing",
      text:
        "the series was created but its current occurrence is missing: this rule shape " +
        `materializes an occurrence immediately (${expectation.evidence}) and no row links back ` +
        "to the new template. Re-read the series before relying on it",
    };
  }

  // PENDING (with or without a date). An instance that exists here is the
  // mismatch — the app is not supposed to have minted one yet.
  if (input.found) {
    return {
      id: "instance-unexpected",
      text:
        "the series was created and already has a materialized occurrence, which this rule " +
        `shape is not expected to produce yet (${expectation.evidence}) — re-read the series to ` +
        "check it will not double-book",
    };
  }

  if (expectation.verdict === "pending-until-completion") {
    return {
      id: "instance-pending",
      text:
        "no occurrence yet — this series counts from each completion, so the first one appears " +
        "once the current work is checked off",
    };
  }

  // PENDING with a known date: name it, and say how far off it is.
  if (input.firstOccurrence === null) {
    return {
      id: "instance-pending",
      text: "no occurrence yet — the series mints its first one when its start date arrives",
    };
  }
  const days = daysUntil(input.todayIso, input.firstOccurrence);
  return {
    id: "instance-pending",
    text: `no occurrence yet — the first one appears ${input.firstOccurrence} (${whenPhrase(days)})`,
  };
}
