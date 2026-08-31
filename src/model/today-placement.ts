/**
 * THE Today / This-Evening placement law — one derivation, every surface.
 *
 * Things stores a Today member's evening flag as a raw `startBucket` byte, and it
 * NEVER cleans that byte when the day it belongs to goes past ([SIT3
 * REMSTALE](../../docs/lab/sit3-arrival-evening-lists.md), oddities §9n). The app
 * instead re-derives placement at RENDER time against the device's current local
 * day, so a `startBucket=1` row whose `startDate` has passed — a STALE evening
 * row — renders in **Today proper**, below the day's daytime rows and ABOVE the
 * "This Evening" section header, exactly like any other arrived member
 * ([STEV1](../../docs/lab/stev1-stale-evening.md) cell 1).
 *
 * Every consumer of the evening flag therefore has to apply the same gate, and
 * they must all apply the SAME one: the read views, the reorder scopes' member
 * census, the bounce's concurrent-edit re-check, and the move planner's axis
 * choice. Four independent spellings is what left a stale evening item refused by
 * BOTH reorder scopes (#657) — `--in today` called it an evening-bucket item and
 * `--in evening` called it stale. This module is the single spelling.
 */

/**
 * Where a row sits in the Today view: `"today"` (the daytime section),
 * `"evening"` (the This Evening section), or `null` (not a Today member on the
 * scheduled arm at all).
 */
export type TodayPlacement = "today" | "evening" | null;

/** The columns the placement law reads. */
export interface TodayPlacementRow {
  /** `start`: 0 = inbox, 1 = anytime/active, 2 = someday. */
  start: number;
  /** Packed `startDate`, or null for an undated row. */
  startDate: number | null;
  /** Raw `startBucket`: 0 = Today proper, 1 = This Evening. */
  startBucket: number | null;
}

/**
 * The Today/Evening placement of a row on the SCHEDULED arm, under `packedToday`
 * (the device-local day, encoded — never a UTC date; see
 * [timezones](../../docs/reference/timezones.md)).
 *
 * - An Inbox row (`start=0`) is never a scheduled Today member.
 * - An undated or strictly-future row is not a member either.
 * - An ARRIVED row (`startDate <= today`, `start` 1 or 2) IS a Today member — an
 *   overdue day and an arrived someday-scheduled row included.
 * - It is in **This Evening** only while its evening flag is LIVE: `startBucket=1`
 *   with a `startDate` of EXACTLY today. Evening membership expires daily, so a
 *   past-dated bucket-1 row is `"today"`.
 *
 * Arrivedness is judged on the DATE alone, never on the start state: an arrived
 * someday-scheduled row (`start=2`, `startDate <= today`) is a Today member and
 * buckets today/evening like any other, matching how `deriveStage` reports it as
 * `anytime` carrying the Today marker (#325).
 *
 * The DEADLINE arm of Today membership (an undated row pulled in by a due or
 * overdue deadline) is not expressible from these three columns and is layered on
 * by the reader (`mappers.todayMarkers`); it is never an evening member.
 */
export function todayPlacement(row: TodayPlacementRow, packedToday: number): TodayPlacement {
  if (row.start !== 1 && row.start !== 2) return null;
  if (row.startDate === null || row.startDate > packedToday) return null;
  return row.startBucket === 1 && row.startDate === packedToday ? "evening" : "today";
}

/**
 * Whether a row's evening flag has gone STALE: the `startBucket=1` byte is still
 * set, but the day it was set for has passed, so the app renders the row in Today
 * proper. The reorder scopes use this to tell a stale movee (accepted by the
 * `today` scope) from a live evening one (refused there, O03), and to point a
 * stale movee's `evening`-scope refusal at the scope that does take it.
 */
export function isStaleEvening(row: TodayPlacementRow, packedToday: number): boolean {
  return row.startBucket === 1 && todayPlacement(row, packedToday) === "today";
}
