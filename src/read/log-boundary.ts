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

export function logBoundary(db: DatabaseSync, now = new Date()): Date {
  const row = db.prepare("SELECT logInterval, manualLogDate FROM TMSettings").get() as
    | { logInterval: number | null; manualLogDate: number | null }
    | undefined;
  const manual = row?.manualLogDate != null ? new Date(row.manualLogDate * 1000) : null;
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
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

/** Stamp `logged` on mapped entities (closed AND at/before the boundary). */
export function markLogged<T extends { status: string; stopped: Date | null; logged: boolean }>(
  items: T[],
  boundary: Date,
): T[] {
  for (const item of items) {
    item.logged = item.status !== "open" && item.stopped !== null && item.stopped <= boundary;
  }
  return items;
}
