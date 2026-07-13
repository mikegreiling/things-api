/**
 * Period-and-calendar grammar shared by the read views: the `--since`/`--until`
 * whole-period parsers, the relative-period (`3d`/`2w`/`1m`/`1y`) grammar, and
 * the Upcoming date-bucket labeller. Fully pure — no CLI or app imports — so
 * the renderers and command registrations can both draw on it.
 */

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

function relativePeriodDate(m: RegExpExecArray, now: Date, sign: 1 | -1): Date {
  const n = sign * Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const d = new Date(now);
  if (unit === "d") d.setDate(d.getDate() + n);
  else if (unit === "w") d.setDate(d.getDate() + 7 * n);
  else if (unit === "m") d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return d;
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
export function parsePeriodEnd(s: string, now: Date = new Date()): Date {
  const rel = RELATIVE_PERIOD.exec(s.trim());
  if (rel !== null) {
    const d = relativePeriodDate(rel, now, 1);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (m === null) return new Date(s);
  const year = Number(m[1]);
  // Day 0 of month n+1 = the last day of month n.
  if (m[2] === undefined) return new Date(year, 11, 31, 23, 59, 59, 999);
  const month = Number(m[2]) - 1;
  if (m[3] === undefined) return new Date(year, month + 1, 0, 23, 59, 59, 999);
  return new Date(year, month, Number(m[3]), 23, 59, 59, 999);
}

/**
 * `--since` accepting the same vocabulary at the period's START: `2024` =
 * Jan 1 2024 00:00, `2024-03` = Mar 1, `2024-03-05` = that midnight;
 * relative periods (`2w`, `1m`) count BACKWARD from now to the landing
 * day's midnight; anything else parses as an instant.
 */
export function parsePeriodStart(s: string, now: Date = new Date()): Date {
  const rel = RELATIVE_PERIOD.exec(s.trim());
  if (rel !== null) {
    const d = relativePeriodDate(rel, now, -1);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (m === null) return new Date(s);
  const year = Number(m[1]);
  if (m[2] === undefined) return new Date(year, 0, 1);
  const month = Number(m[2]) - 1;
  if (m[3] === undefined) return new Date(year, month, 1);
  return new Date(year, month, Number(m[3]));
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
