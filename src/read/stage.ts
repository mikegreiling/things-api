/**
 * The R10 lifecycle taxonomy: ONE derived per-item field, `stage`, that replaces
 * the three former wire fields `start` / `logged` / `trashed`. It names an item's
 * primary lifecycle bucket in the same six words the sidebar and the view cards
 * use, so a consumer reads one word instead of cross-referencing three.
 *
 * ## Why a pure function that REUSES the view predicates
 * `deriveStage` is a PURE function over the already-materialized entity (its
 * `logged` flag stamped by {@link markLogged} against the logbook boundary, its
 * `trashed`/`start`/`startDate`/`repeating` read from the DB). It encodes the
 * SAME membership rules the list views encode in SQL — inbox = `start=0`, someday
 * = `start=2 ∧ undated`, upcoming = a `startDate` or a repeating template, the
 * logbook-boundary rule that {@link markLogged} applies — so an item's `stage`
 * can never disagree with the bucket a view (or a card sub-bucket) puts it in.
 * The read surfaces bucket their card sections by calling this same function, and
 * the emit boundary stamps the wire `stage` from it; there is exactly one
 * derivation.
 *
 * ## Precedence (order matters)
 * 1. `trashed` → `trash` — wins over EVERYTHING, including a logged row (a trashed
 *    item that was also completed reads `trash`, per the ratified ruling).
 * 2. `logged` → `logbook` — the SAME logbook-boundary rule {@link markLogged}
 *    applies (completion ≠ logged; a closed row past the sweep boundary).
 *    A completed/canceled row NOT yet past the boundary has `logged=false` here,
 *    so it FALLS THROUGH and keeps its live stage below (Mike's explicit ruling).
 * 3. `start=inbox` → `inbox`.
 * 4. a repeating TEMPLATE → `upcoming` — regardless of its projected next date;
 *    the `repeating` object stays the template discriminator.
 * 5. a `startDate`, split by whether that When-date has ARRIVED:
 *    - STRICTLY FUTURE (`startDate > today`, i.e. NO `today` marker) → `upcoming`.
 *      GUI Upcoming membership is STRICTLY FUTURE — `groupKey =
 *      COALESCE(startDate, deadline) > today` (UPC1, GUI-verified,
 *      docs/lab/upcoming-research.md); only a future When-date is in Upcoming.
 *    - ARRIVED (`startDate <= today`, carrying the `today` marker) → `anytime`.
 *      An arrived-dated OPEN item is NOT in Upcoming — it is in Today (star) and
 *      Anytime. Its Today membership is carried by the separate `today` marker,
 *      never by `stage`. This holds for an active arrived row AND an arrived
 *      someday-scheduled row (`start=2`, `startDate <= today`) — both are Anytime
 *      members (ANYTIME_SELF, src/read/predicates.ts).
 *    The arrived/future split reads the `today` marker rather than re-comparing to
 *    a clock: for a dated non-inbox, non-template row the marker's scheduled arm is
 *    EXACTLY `startDate <= today` (mappers todayMarkers), computed with the same
 *    response clock — so `!today` on a dated row ⟺ `startDate > today`. Deriving
 *    from the marker also guarantees `stage` can never disagree with Today
 *    membership.
 * 6. `start=someday` (undated, deferred) → `someday`.
 * 7. otherwise (current/active, undated) → `anytime`.
 *
 * ## Today/evening are a SEPARATE axis, not a stage (see {@link isTodayMarked})
 * There is deliberately no `today` stage — the Today view is a SUPERSET filter
 * across the middle tier, so today membership is a separate presence-keyed marker.
 * The two axes cross: an undated ACTIVE to-do whose DEADLINE is today reads
 * `stage: "anytime"` AND `today: true` (F-DL pull; UPC1 2026-07-13, GUI-verified,
 * docs/lab/upcoming-research.md, summarized in docs/things-app-oddities.md
 * §8d–8e). A SOMEDAY item with a due/overdue UNsuppressed deadline reads
 * `stage: "someday"` AND `today: true` (surfaced in Today, still technically
 * someday); the same item once its deadline is SUPPRESSED
 * (`deadlineSuppressionDate` stamped — a side effect of rescheduling an
 * overdue-deadline item, oddities §8e) reads `stage: "someday"` with NO today
 * marker. And after the user OKs the "new to-dos" banner (§8d) the app MUTATES
 * such an item to `start=1` / `startDate := deadline` (= today, an ARRIVED
 * When-date), so the SAME conceptual item legitimately reads `stage: "anytime"` +
 * `today: true` post-acknowledgement — an arrived `startDate` is Anytime + Today,
 * NOT Upcoming. Both DB states are real; this function reads the DB as it is and
 * needs no special-casing.
 */
import type { IsoDate } from "../model/dates.ts";
import type { StartState } from "../model/entities.ts";

export type Stage = "inbox" | "upcoming" | "anytime" | "someday" | "logbook" | "trash";

/** The minimal materialized-entity shape {@link deriveStage} reads. */
export interface StageInput {
  trashed: boolean;
  /** The logbook-boundary-resolved flag (markLogged): closed AND past the sweep. */
  logged: boolean;
  start: StartState;
  startDate: IsoDate | null;
  repeating: { isTemplate: boolean };
  /**
   * The Today marker (mappers todayMarkers, presence-keyed on the entity). For a
   * dated non-inbox, non-template row its scheduled arm is EXACTLY
   * `startDate <= today` under the response clock, so it discriminates an ARRIVED
   * When-date (marker present → `anytime`) from a strictly-FUTURE one (marker
   * absent → `upcoming`). Absent/false on undated rows (their marker, if any, is
   * deadline-driven and irrelevant to the startDate branch). Optional so a
   * materialized entity (`today?: true`) is a structural {@link StageInput}.
   */
  today?: boolean;
}

/**
 * Derive an item's {@link Stage} from its materialized fields. Pure; see the
 * module doc for the precedence and the GUI-verified corners it honors.
 */
export function deriveStage(item: StageInput): Stage {
  if (item.trashed) return "trash";
  if (item.logged) return "logbook";
  if (item.start === "inbox") return "inbox";
  if (item.repeating.isTemplate) return "upcoming";
  // Upcoming is STRICTLY FUTURE (UPC1): a future When-date → `upcoming`; an
  // ARRIVED one (the `today` marker) → `anytime` (Today star + Anytime, not
  // Upcoming). Covers arrived active AND arrived someday-scheduled rows.
  if (item.startDate !== null) return item.today === true ? "anytime" : "upcoming";
  if (item.start === "someday") return "someday";
  return "anytime";
}
