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
 * 2½. a DEADLINE-PULLED undated row (`today` marker set ∧ `startDate IS NULL`) →
 *    `anytime` — R13 (BANNER1 / BANNER1b, law L-A): a due-deadline pull re-files
 *    an undated Inbox/Someday row into ANYTIME (the GUI removes it from
 *    Someday/Inbox and adds it to Anytime at pull time, even while raw `start`
 *    still reads 0/2). It derives its DESTINATION, not its origin. Ordered ABOVE
 *    inbox so an inbox-origin pull is caught; templates never carry the marker.
 *    With this, EVERY Today member derives `anytime` (arrived via step 5, pulled
 *    here).
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
 * §8d–8e). A SOMEDAY or INBOX item with a due/overdue UNsuppressed deadline is
 * PULLED into Today+Anytime, so it too reads `stage: "anytime"` AND `today: true`
 * (R13 / BANNER1b — the GUI files a pulled row under Anytime, out of its origin
 * bucket, §8s); the same item once its deadline is SUPPRESSED
 * (`deadlineSuppressionDate` stamped — a side effect of rescheduling an
 * overdue-deadline item, oddities §8e) is NOT pulled: no today marker, so it
 * reads its ORIGIN stage (`someday` / `inbox`) with NO today marker. And after
 * the user OKs the "new to-dos" banner (§8d) the app MUTATES
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
  // R13 (BANNER1 / BANNER1b, law L-A): a due-deadline PULL re-files an undated
  // row (Inbox or Someday origin) into ANYTIME — the GUI removes it from the
  // Someday/Inbox lists and adds it to the Anytime list at pull time, even while
  // its raw `start` still reads 0/2 (Anytime ⊇ Today's to-dos). The row carries
  // the Today marker via the deadline arm (mappers `todayMarkers`) with its
  // startDate still NULL, so a Today-marked UNDATED row IS a deadline pull → it
  // derives its DESTINATION bucket `anytime`, not its origin (inbox/someday).
  // Consequence: EVERY Today member is now stage `anytime` (arrived → anytime
  // via the arrived-startDate branch below; pulled → anytime here). Reuses the
  // marker verbatim — no independent re-derivation. Ordered ABOVE the inbox
  // branch so an inbox-origin pull is caught (templates never carry the marker).
  if (item.today === true && item.startDate === null) return "anytime";
  if (item.start === "inbox") return "inbox";
  if (item.repeating.isTemplate) return "upcoming";
  // Upcoming is STRICTLY FUTURE (UPC1): a future When-date → `upcoming`; an
  // ARRIVED one (the `today` marker) → `anytime` (Today star + Anytime, not
  // Upcoming). Covers arrived active AND arrived someday-scheduled rows.
  if (item.startDate !== null) return item.today === true ? "anytime" : "upcoming";
  if (item.start === "someday") return "someday";
  return "anytime";
}

/**
 * An item's TIME-AXIS POSITION (R12) — a presence-keyed value complementary to
 * {@link Stage}. The doctrine line: **`stage` enumerates the sidebar BUCKETS an
 * item lives in; `when` enumerates its TIME POSITIONS (today | evening | a future
 * date).** Someday is deliberately NOT a `when` value — it is a bucket, so it
 * lives on the `stage` axis.
 *
 * - `"evening"` — the This-Evening sub-bucket of Today (implies today);
 * - `"today"` — in the Today view by ANY arm (an arrived `startDate`, or a
 *   due/overdue undated deadline that is not suppressed — the same two-arm
 *   predicate {@link isTodayMarked} / mappers `todayMarkers` derive);
 * - a FUTURE ISO date — a strictly-future scheduled row (`startDate > today`), or
 *   a repeating TEMPLATE's app-materialized next occurrence;
 * - absent — unscheduled and not in Today (an unprojected template — paused /
 *   after-completion — has none, and neither does a logged/trashed item).
 */
export type When = "today" | "evening" | IsoDate;

/** The minimal shape {@link deriveWhen} reads (all fields off the materialized entity). */
export interface WhenInput {
  /** The derived {@link Stage} — gates out logbook/trash (never time-axis members). */
  stage: Stage;
  /** The presence-keyed Today marker (mappers `todayMarkers`) — reused, never re-derived. */
  today?: boolean;
  /** The presence-keyed This-Evening marker (implies today). */
  evening?: boolean;
  startDate: IsoDate | null;
  /** A template's projected next occurrence (a future date), if it has one. */
  repeating: { isTemplate: boolean; nextOccurrence?: IsoDate | null };
}

/**
 * Derive an item's {@link When} from its materialized fields. PURE, and it REUSES
 * the Today markers rather than re-deriving membership — so `when` ∈
 * {`"today"`, `"evening"`} can NEVER disagree with Today-view membership (the same
 * fact the star renders). See the type doc for the four positions.
 */
export function deriveWhen(item: WhenInput): When | undefined {
  // Out of the time axis: a logged/trashed item is never a Today member and is no
  // longer scheduled-forward — no `when`. (This is the same gate that strips the
  // raw materialize-time markers from a logbook/trash row at the emit boundary.)
  if (item.stage === "logbook" || item.stage === "trash") return undefined;
  // Today membership rides the presence-keyed markers verbatim (evening ⊃ today).
  if (item.evening === true) return "evening";
  if (item.today === true) return "today";
  // A repeating TEMPLATE sits at its projected next occurrence (a future date); an
  // unprojected one (paused / after-completion) has none → absent.
  if (item.repeating.isTemplate) return item.repeating.nextOccurrence ?? undefined;
  // A dated, NON-today-marked row is strictly future: the marker's scheduled arm is
  // EXACTLY `startDate <= today`, so `!today` on a dated row ⟺ `startDate > today`.
  // Arrived dates never reach here — they carried the `today` marker and returned
  // above.
  if (item.startDate !== null) return item.startDate;
  return undefined;
}

/**
 * The materialized-ENTITY shape the entity-level derivations read: the raw
 * lifecycle substrate lives in the nested `derived` bag ({@link
 * DerivedSubstrate}); `startDate` and `repeating` stay flat (consumer fields).
 */
export interface EntityDerivable {
  startDate: IsoDate | null;
  repeating: { isTemplate: boolean; nextOccurrence?: IsoDate | null };
  derived: {
    start: StartState;
    logged: boolean;
    trashed: boolean;
    today?: boolean;
    evening?: boolean;
  };
}

/**
 * The ONE {@link Stage} derivation for a materialized ENTITY — composes {@link
 * deriveStage} off the entity's `derived` substrate. Exported for programmatic-
 * API ergonomics: a TS consumer gets the wire's lifecycle word from an entity +
 * clock without reaching into `entity.derived` itself.
 */
export function entityStage(item: EntityDerivable): Stage {
  return deriveStage({
    trashed: item.derived.trashed,
    logged: item.derived.logged,
    start: item.derived.start,
    startDate: item.startDate,
    repeating: item.repeating,
    ...(item.derived.today !== undefined && { today: item.derived.today }),
  });
}

/**
 * The ONE time-axis derivation for a materialized ENTITY — the SINGLE SOURCE the
 * wire emit boundary (`shape.ts` `whenOf`) and the human/TTY renderers
 * (`whenValue`, `todayMark`) share. Composes {@link entityStage} → {@link
 * deriveWhen} off the entity's own presence-keyed markers, so a TTY when/pip can
 * NEVER disagree with the emitted `when` (never re-derived from `startBucket` /
 * `todaySection`). Returns the same {@link When} the wire carries.
 */
export function entityWhen(item: EntityDerivable): When | undefined {
  return deriveWhen({
    stage: entityStage(item),
    ...(item.derived.today !== undefined && { today: item.derived.today }),
    ...(item.derived.evening !== undefined && { evening: item.derived.evening }),
    startDate: item.startDate,
    repeating: item.repeating,
  });
}

/**
 * The R13 provisional-marker LAW (BANNER1 L-B) — the ONE predicate the wire emit
 * boundary (`shape.ts`) and the TTY pip (`render.ts` renderToday) share, so a
 * rendered `•` can NEVER disagree with the emitted `provisional`. A Today member
 * (a today/evening `when`) the app has not yet MATERIALIZED: `start != active OR
 * startDate IS NULL`. A future/undated/someday row (no today/evening `when`) is
 * never provisional; templates never carry a today/evening `when`, so they never
 * qualify either. Takes the already-derived `when` so neither caller re-derives it.
 */
export function whenIsProvisional(
  when: When | undefined,
  start: StartState,
  startDate: IsoDate | null,
): boolean {
  return (when === "today" || when === "evening") && (start !== "active" || startDate === null);
}

/**
 * Entity-level {@link whenIsProvisional}: derives the entity's own
 * {@link entityWhen} (the same value the wire emits), so the TTY provisional pip
 * shares the wire's derivation end to end.
 */
export function entityProvisional(item: EntityDerivable): boolean {
  return whenIsProvisional(entityWhen(item), item.derived.start, item.startDate);
}

/**
 * The §9n stale-reminder LAW — the ONE liveness predicate the read-emit boundary
 * (its precomputed `reminderLive` marker, mappers) and the write-side reminder
 * auto-preserve ({@link src/write/commands.ts} `effectiveReminder`) share, so a
 * reminder is reported/preserved iff the GUI would still render its bell.
 *
 * A time-of-day reminder renders in the GUI ONLY while its row's `startDate` is
 * the current day or FUTURE (a future-scheduled row's reminder is a live
 * upcoming reminder; today's is live). Once `startDate` goes STRICTLY PAST the
 * app hides the bell at the presentation layer while leaving the `reminderTime`
 * byte in the DB forever — presentation-dead, never cleared (docs/lab/
 * sit3-arrival-evening-lists.md REMSTALE, oddities §9n). A read keyed on the raw
 * byte would over-report; a `when=` re-schedule that auto-preserved it would
 * resurrect a reminder the user believes gone.
 *
 * A row with NO `startDate` keeps the byte live (a reminder cannot exist without
 * a scheduled date in the app's model, so this arm is defensive — see the test).
 * ISO `YYYY-MM-DD` strings order lexicographically == chronologically, so the
 * bare `>=` is the calendar comparison.
 */
export function reminderIsLive(startDate: IsoDate | null, todayIso: IsoDate): boolean {
  return startDate === null || startDate >= todayIso;
}
