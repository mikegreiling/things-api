/**
 * Period-and-calendar grammar shared by the read views: the `--since`/`--until`
 * whole-period parsers, the relative-period (`3d`/`2w`/`1m`/`1y`) grammar, and
 * the Upcoming date-bucket labeller. The only library dependency is the pair of
 * zone-aware date helpers (through the single entry point) so a `--since 2w` is
 * counted in the CONSUMER'S calendar, not the host's — byte-identical to the
 * host math when no zone is in effect.
 */
import { dayBoundInstant, localToday, type IsoDate } from "../index.ts";

const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export { FULL_MONTHS };

/**
 * Relative period: `3d`/`2w`/`1m`/`1y` (days/weeks/calendar months/years),
 * counted from `now` — FORWARD for an until-bound, BACKWARD for a since-
 * bound (each command's natural direction; the flag name carries it).
 */
const RELATIVE_PERIOD = /^(\d+)([dwmy])$/i;

/** Format a UTC-anchored Date's date fields as `YYYY-MM-DD`. */
function isoFromUtc(dt: Date): IsoDate {
  return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The target CALENDAR date for a relative period, counted from a base ISO date
 * (the consumer's today) — days/weeks add days, months/years use the JS Date
 * overflow the host arithmetic always used (Jan 31 + 1m → Mar 3). Pure calendar
 * math on the date fields (UTC-anchored so the host zone never intrudes), so it
 * is zone-agnostic once the base date is chosen.
 */
function relativeTargetIso(m: RegExpExecArray, baseIso: IsoDate, sign: 1 | -1): IsoDate {
  const [y, mo, d] = baseIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1));
  const n = sign * Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "d") dt.setUTCDate(dt.getUTCDate() + n);
  else if (unit === "w") dt.setUTCDate(dt.getUTCDate() + 7 * n);
  else if (unit === "m") dt.setUTCMonth(dt.getUTCMonth() + n);
  else dt.setUTCFullYear(dt.getUTCFullYear() + n);
  return isoFromUtc(dt);
}

/** The ISO date at a whole absolute period's START or END edge (`2024` → Jan 1 / Dec 31, etc.). */
function absolutePeriodIso(m: RegExpExecArray, edge: "start" | "end"): IsoDate {
  const year = Number(m[1]);
  if (m[2] === undefined) return edge === "start" ? `${m[1]}-01-01` : `${m[1]}-12-31`;
  const month = Number(m[2]) - 1;
  if (m[3] === undefined) {
    if (edge === "start") return `${m[1]}-${m[2]}-01`;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Double a relative period for a "wider window" suggestion: `1m`→`2m`,
 * `2w`→`4w`, `1y`→`2y`. A non-relative input (an absolute calendar period
 * like `2026-09`) comes back unchanged — there is nothing sensible to double.
 * Deliberately dumb: it only scales the count of a `\d+[dwmy]` period.
 */
export function doublePeriod(period: string): string {
  const m = RELATIVE_PERIOD.exec(period.trim());
  if (m === null) return period;
  return `${Number(m[1]) * 2}${(m[2] ?? "").toLowerCase()}`;
}

/**
 * `--until` accepting whole periods: `2024` means through Dec 31 2024,
 * `2024-03` through Mar 31, `2024-03-05` through end of that day; relative
 * periods (`2w`, `1m`, `1y`) count FORWARD from now through the end of the
 * landing day; anything else parses as an instant.
 */
export function parsePeriodEnd(s: string, now: Date = new Date(), zone?: string): Date {
  const rel = RELATIVE_PERIOD.exec(s.trim());
  if (rel !== null) {
    return dayBoundInstant(relativeTargetIso(rel, localToday(now, zone), 1), "end", zone);
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (m === null) return new Date(s);
  return dayBoundInstant(absolutePeriodIso(m, "end"), "end", zone);
}

/**
 * `--since` accepting the same vocabulary at the period's START: `2024` =
 * Jan 1 2024 00:00, `2024-03` = Mar 1, `2024-03-05` = that midnight;
 * relative periods (`2w`, `1m`) count BACKWARD from now to the landing
 * day's midnight; anything else parses as an instant.
 */
export function parsePeriodStart(s: string, now: Date = new Date(), zone?: string): Date {
  const rel = RELATIVE_PERIOD.exec(s.trim());
  if (rel !== null) {
    return dayBoundInstant(relativeTargetIso(rel, localToday(now, zone), -1), "start", zone);
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (m === null) return new Date(s);
  return dayBoundInstant(absolutePeriodIso(m, "start"), "start", zone);
}

/**
 * GUI-style Upcoming bucket for a date, granularity decaying with distance:
 * individual days for the next week ("Wed Jul 15"), the remainder of the
 * current month ("Jul 19–31"), months through the end of NEXT year
 * ("August", "January 2027"), then bare years ("2028").
 */
export function upcomingBucket(iso: string, todayIso: string): { label: string; isDay: boolean } {
  const [y, m, d] = iso.split("-").map(Number);
  const [y0, m0, d0] = todayIso.split("-").map(Number);
  const diff = Math.round(
    (Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) - Date.UTC(y0 ?? 0, (m0 ?? 1) - 1, d0 ?? 1)) /
      86_400_000,
  );
  if (diff <= 7) {
    const weekday = WEEKDAYS[new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay()];
    return { label: `${weekday} ${SHORT_MONTHS[(m ?? 1) - 1]} ${d}`, isDay: true };
  }
  if (y === y0 && m === m0) {
    const lastDay = new Date(y ?? 0, m ?? 1, 0).getDate();
    return { label: `${SHORT_MONTHS[(m ?? 1) - 1]} ${(d0 ?? 1) + 8}–${lastDay}`, isDay: false };
  }
  if ((y ?? 0) <= (y0 ?? 0) + 1) {
    const month = FULL_MONTHS[(m ?? 1) - 1];
    return { label: y === y0 ? `${month}` : `${month} ${y}`, isDay: false };
  }
  return { label: `${y}`, isDay: false };
}
