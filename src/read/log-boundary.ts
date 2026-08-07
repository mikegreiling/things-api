/**
 * The GUI's log-move boundary — completion and LOGGED are two separate
 * states. A closed item enters the Logbook only when the app's periodic
 * "Move completed items to Logbook" sweep passes it; until then it stays
 * checked in its original list. No per-row column records this: membership
 * is computed against `TMSettings.logInterval` + `manualLogDate`
 * (probe: live prod diff 2026-07-10 — fresh completions absent from the
 * GUI Logbook share every TMTask column shape with logged history; only
 * the stopDate-vs-boundary relation differs).
 *
 * logInterval semantics (GUI enum VERIFIED live in a clone, 2026-07-12,
 * s-campaign-results.md round 3): 0 = immediately, 1 = daily, 4 = manual
 * ("When I choose"). Things 3.22.11's "Move completed items to Logbook"
 * dropdown offers ONLY these three — there is NO weekly or monthly option,
 * so the `case 2`/`case 3` branches below are UNREACHABLE with the current
 * app (kept as defensive analogues in case a future build adds them; the
 * real manual value 4 falls to `default`, which is correct). manualLogDate
 * is the user's last explicit "log now" (an AppleScript `log completed now`
 * advances it to the current time — VERIFIED); it can only move the boundary
 * FORWARD past the interval's own edge.
 */
import type { DatabaseSync } from "node:sqlite";

import { dayBoundInstant, localToday } from "../model/dates.ts";

// `zone` (optional IANA zone) is threaded so the daily/weekly/monthly sweep
// edge is the CONSUMER'S local midnight, not the host's — byte-identical to a
// bare `new Date(now); setHours(0,…)` when absent. logInterval=0 (immediately,
// the golden default) is zone-independent (the boundary is `now`).
export function logBoundary(db: DatabaseSync, now = new Date(), zone?: string): Date {
  const row = db.prepare("SELECT logInterval, manualLogDate FROM TMSettings").get() as
    | { logInterval: number | null; manualLogDate: number | null }
    | undefined;
  const manual = row?.manualLogDate != null ? new Date(row.manualLogDate * 1000) : null;
  const startOfDay =
    zone === undefined
      ? ((): Date => {
          const d = new Date(now);
          d.setHours(0, 0, 0, 0);
          return d;
        })()
      : dayBoundInstant(localToday(now, zone), "start", zone);
  let auto: Date;
  switch (row?.logInterval ?? 0) {
    case 0:
      auto = now;
      break;
    case 1:
      auto = startOfDay;
      break;
    case 2: {
      const d = new Date(startOfDay);
      d.setDate(d.getDate() - d.getDay());
      auto = d;
      break;
    }
    case 3: {
      const d = new Date(startOfDay);
      d.setDate(1);
      auto = d;
      break;
    }
    default:
      auto = manual ?? now;
  }
  return manual !== null && manual > auto ? manual : auto;
}

/**
 * The Cultured Code words for the "Move completed items to Logbook" cadence —
 * the exact Settings-dropdown labels (`logInterval` 0=Immediately · 1=Daily ·
 * 4=Manually; there is NO weekly/monthly in Things 3.22.x, oddities §8c). Kept
 * in the app's own vocabulary so consumer copy never invents a lifecycle word.
 */
export type LogCadence = "Immediately" | "Daily" | "Manually";

/**
 * A VIEW-LEVEL fact about the Logbook: the log-move cadence in Cultured Code's
 * own Settings words, plus — under Daily and Manually — the instant of the last
 * explicit log (`TMSettings.manualLogDate`), as an ISO-8601 string (an INSTANT,
 * so a consumer renders its calendar day in their own zone; the wire carries the
 * exact instant). Rides `meta.logging` on the wire (never a data row) — the
 * `meta.counts` precedent for a whole-view aggregate.
 */
export interface LogState {
  cadence: LogCadence;
  /** ISO-8601 instant of the last explicit log — present under Daily and Manually. */
  lastLoggedAt?: string;
}

/**
 * Read the log-move cadence fact from the `TMSettings` singleton. The golden
 * default is Immediately (`logInterval` absent/0 → boundary is `now`, so nothing
 * is ever pending). `manualLogDate` is surfaced as `lastLoggedAt` under Daily AND
 * Manually — a manual `log completed now` works under any cadence, and under Daily
 * a `manualLogDate` newer than the daily edge IS the effective boundary
 * (`logBoundary = max(interval edge, manualLogDate)` above), so the stamp is
 * operationally LIVE information, not just history. Under Immediately it is OMITTED
 * (the boundary is `now`, so any stored value is inert — a settings-flip artifact,
 * never the operative boundary); the asymmetry is deliberate.
 */
export function logState(db: DatabaseSync): LogState {
  const row = db.prepare("SELECT logInterval, manualLogDate FROM TMSettings").get() as
    | { logInterval: number | null; manualLogDate: number | null }
    | undefined;
  const interval = row?.logInterval ?? 0;
  const cadence: LogCadence =
    interval === 0 ? "Immediately" : interval === 1 ? "Daily" : "Manually";
  const manual = row?.manualLogDate ?? null;
  return cadence !== "Immediately" && manual !== null
    ? { cadence, lastLoggedAt: new Date(manual * 1000).toISOString() }
    : { cadence };
}

/**
 * How many closed items sit resolved-but-NOT-yet-logged — the boundary predicate
 * INVERTED (`status IN (2,3) AND stopDate > logBoundary`). This is the count an
 * AppleScript `log completed now` would move into the Logbook; it is 0 under the
 * default Immediately cadence (the boundary is `now`). Feeds `log-now`'s pre-read
 * so the result can disclose how many items were logged (and the count==0 no-op).
 */
export function pendingLogCount(db: DatabaseSync, now = new Date(), zone?: string): number {
  const boundaryEpoch = logBoundary(db, now, zone).getTime() / 1000;
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 0 AND status IN (2, 3) " +
        "AND stopDate IS NOT NULL AND stopDate > ?",
    )
    .get(boundaryEpoch) as { n: number };
  return row.n;
}

/** The current `TMSettings.manualLogDate` (epoch seconds), or null. */
export function manualLogDateEpoch(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT manualLogDate FROM TMSettings").get() as
    | { manualLogDate: number | null }
    | undefined;
  return row?.manualLogDate ?? null;
}

/** Stamp `derived.logged` on mapped entities (closed AND at/before the boundary). */
export function markLogged<
  T extends { status: string; stopped: Date | null; derived: { logged: boolean } },
>(items: T[], boundary: Date): T[] {
  for (const item of items) {
    item.derived.logged =
      item.status !== "open" && item.stopped !== null && item.stopped <= boundary;
  }
  return items;
}
