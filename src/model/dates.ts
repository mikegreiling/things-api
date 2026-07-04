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

/**
 * Today's date in the machine's local timezone, as Things computes it.
 * The Today list boundary is local-midnight; injectable `now` for tests.
 */
export function localToday(now: Date = new Date()): IsoDate {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
