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
 * 5. a `startDate` (past, today, OR future) → `upcoming` — Upcoming is a SUPERSET
 *    of Today (ruled). An arrived (past/today) startDate still reads `upcoming`;
 *    its presence in Today is carried by the separate `today` marker, not `stage`.
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
 * such an item to `start=1` / `startDate := deadline`, so the SAME conceptual item
 * legitimately reads `stage: "upcoming"` + `today: true` post-acknowledgement —
 * both DB states are real; this function reads the DB as it is and needs no
 * special-casing.
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
  if (item.startDate !== null) return "upcoming";
  if (item.start === "someday") return "someday";
  return "anytime";
}
