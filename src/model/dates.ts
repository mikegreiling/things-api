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
