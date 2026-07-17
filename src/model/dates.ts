/**
 * Codecs for the date encodings used in Things' database.
 * See docs/atlas/schema-v26.md § Encodings.
 *
 * - Packed date int: `y<<16 | m<<12 | d<<7` (startDate, deadline, …).
 *   Verified live: 132803712 → 2026-06-25. Low 7 bits observed 0.
 * - Epoch REAL: Unix seconds, possibly fractional (creationDate, stopDate, …).
 */

/** ISO calendar date, `yyyy-mm-dd`. Deliberately not a Date — these fields are timezone-less. */
export type IsoDate = string;

export function decodePackedDate(value: number | null): IsoDate | null {
  if (value === null || value === 0) return null;
  const y = value >> 16;
  const m = (value >> 12) & 0xf;
  const d = (value >> 7) & 0x1f;
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) {
    throw new RangeError(`packed date out of domain: ${value} (y=${y} m=${m} d=${d})`);
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function encodePackedDate(iso: IsoDate): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new RangeError(`not an ISO date: ${iso}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new RangeError(`date components out of range: ${iso}`);
  }
  return (y << 16) | (m << 12) | (d << 7);
}

export function decodeEpochReal(value: number | null): Date | null {
  if (value === null) return null;
  return new Date(value * 1000);
}

export function encodeEpochReal(date: Date): number {
  return date.getTime() / 1000;
}

/** Reminder time-of-day, `HH:mm` 24-hour. Timezone-less like IsoDate. */
export type ReminderTime = string;

/**
 * TMTask.reminderTime packing: `hour<<26 | minute<<20` — verified against 13
 * known-time lab samples (R-suite 2026-07-04; docs/lab/r-suite-results.md).
 */
export function decodeReminderTime(value: number | null): ReminderTime | null {
  if (value === null) return null;
  const packed = value >> 20;
  const h = packed >> 6;
  const m = packed & 0x3f;
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new RangeError(`packed reminderTime out of domain: ${value} (h=${h} m=${m})`);
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function encodeReminderTime(time: ReminderTime): number {
  const { h, m } = parseReminderTime(time);
  return (h * 64 + m) << 20;
}

function parseReminderTime(time: ReminderTime): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new RangeError(`not an HH:mm time: ${time}`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw new RangeError(`time components out of range: ${time}`);
  return { h, m };
}

/**
 * Deterministic URL spelling for `when=<list>@<time>`. The app's parser
 * treats BARE hours 1–11 as 12-hour times resolved to the next upcoming
 * occurrence (10:05 → 22:05 at an afternoon wall clock!), while leading-zero
 * hours are 24-hour literals and hours ≥ 12 are unambiguous. Every branch
 * here is probe-backed (R01–R16): 0–9 → zero-padded 24h; 10–11 → explicit
 * am suffix; 12–23 → literal.
 */
export function reminderUrlToken(time: ReminderTime): string {
  const { h, m } = parseReminderTime(time);
  const mm = String(m).padStart(2, "0");
  if (h <= 9) return `0${h}:${mm}`;
  if (h <= 11) return `${h}:${mm}am`;
  return `${h}:${mm}`;
}

/** Calendar arithmetic on timezone-less ISO dates (UTC-anchored). */
export function addDaysIso(iso: IsoDate, days: number): IsoDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new RangeError(`not an ISO date: ${iso}`);
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Today's date, as Things computes it: local-midnight is the Today boundary.
 * `now` is injectable (tests, pinned-clock runs). `zone` is an OPTIONAL IANA
 * time zone — when absent the machine's host zone is used and the result is
 * byte-identical to before this parameter existed; when given, the calendar
 * date is computed IN THAT ZONE (a consumer three time zones away can ask for
 * their own Today). DST/antimeridian correctness comes from {@link
 * calendarDateInZone}'s use of Intl — never manual offset math.
 */
export function localToday(now: Date = new Date(), zone?: string): IsoDate {
  if (zone !== undefined) return calendarDateInZone(now, zone);
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The calendar date (`YYYY-MM-DD`) of an instant in a given IANA zone, via
 * `Intl.DateTimeFormat` (the DST- and antimeridian-correct path — the platform
 * ICU data owns the offset, so we never compute one by hand). Throws a
 * RangeError on an unknown zone.
 */
export function calendarDateInZone(instant: Date, zone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

/** Whether a string names an IANA time zone the platform recognizes. */
export function isValidTimeZone(zone: string): boolean {
  try {
    // Constructing with the zone throws (RangeError) on an unknown identifier;
    // reading back the resolved zone keeps this an expression, not a bare `new`.
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/** The machine's host IANA zone (what the app itself renders in). */
export function hostTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The instant at the START (00:00:00.000) or END (23:59:59.999) of a calendar
 * date. Without a `zone` the day edge is the HOST-local one (byte-identical to
 * a bare `new Date(y, m-1, d, …)`); with a `zone` it is that zone's day edge,
 * resolved through the zone's offset (DST-corrected by a second Intl read).
 */
export function dayBoundInstant(iso: IsoDate, edge: "start" | "end", zone?: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) throw new RangeError(`not an ISO date: ${iso}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const [hh, mm, ss, ms] = edge === "start" ? [0, 0, 0, 0] : [23, 59, 59, 999];
  if (zone === undefined) return new Date(y, m - 1, d, hh, mm, ss, ms);
  // Treat the wall time as if UTC, then subtract the zone's offset at that
  // instant; re-read once so a DST-boundary offset is corrected.
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms));
  const offset = zoneOffsetMs(guess, zone);
  const first = new Date(guess.getTime() - offset);
  const offset2 = zoneOffsetMs(first, zone);
  return offset2 === offset ? first : new Date(guess.getTime() - offset2);
}

/** Milliseconds to add to a UTC instant to read it as wall-clock time in `zone` (the zone's offset). */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // formatToParts has no sub-second field; zone offsets are whole minutes, so
  // the wall clock carries the instant's own milliseconds — restore them, else
  // the offset is corrupted by up to a second (a day-boundary rounding error).
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
    instant.getUTCMilliseconds(),
  );
  return asUtc - instant.getTime();
}
