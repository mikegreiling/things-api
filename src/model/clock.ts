/**
 * The effective clock: the instant "now" resolves to plus the calendar zone
 * that turns that instant into a Today. Both are consumer-settable knobs read
 * from the environment (shared by the CLI and the MCP server process):
 *
 *   - `THINGS_TZ`  — an IANA zone (e.g. `Asia/Tokyo`) so every date boundary
 *                    (today/evening/upcoming/logbook/overdue/…) evaluates for
 *                    the CONSUMER'S calendar rather than the host's. Things
 *                    membership is derived from stored calendar dates vs. an
 *                    evaluation instant, so this is coherent under any zone
 *                    (it is why two synced devices in different zones can
 *                    legitimately disagree about Today).
 *   - `THINGS_NOW` — an ISO-8601 instant pinning "now" (a determinism knob for
 *                    tests and lab runs). Absent, real time is read per call.
 *
 * Precedence: a per-call zone (the MCP `tz` argument) > `THINGS_TZ` > the host
 * zone. Invalid values FAIL CLOSED — an unknown zone or unparseable instant
 * throws {@link ClockError}, never a silent fall back to the host clock.
 */
import {
  calendarDateInZone,
  hostTimeZone,
  isValidTimeZone,
  localToday,
  type IsoDate,
} from "./dates.ts";

/** A consumer-supplied clock value was malformed (unknown zone / unparseable instant). */
export class ClockError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "ClockError";
  }
}

export interface EffectiveClock {
  /** The instant source: a fixed instant when `THINGS_NOW` is pinned, else real time per call. */
  now: () => Date;
  /** The consumer IANA zone in effect, or undefined for the host zone. */
  zone: string | undefined;
  /**
   * True when a consumer zone OR a pinned `THINGS_NOW` is in effect — the
   * signal that the additive `meta.clock` honesty field should be emitted. A
   * test that merely injects `now` (without either env knob) leaves this false,
   * so the wire shape stays unchanged for ordinary consumers.
   */
  explicit: boolean;
}

/**
 * Resolve the effective clock from the environment (and an optional per-call
 * zone override). Fails closed on malformed input.
 */
export function resolveClock(opts: {
  env: NodeJS.ProcessEnv;
  /** Per-call zone override (the MCP `tz` argument); wins over `THINGS_TZ`. */
  tz?: string | undefined;
  /** Test/injection seam: replaces the instant source entirely (does not set `explicit`). */
  now?: (() => Date) | undefined;
}): EffectiveClock {
  const rawTz = opts.tz ?? opts.env["THINGS_TZ"];
  let zone: string | undefined;
  if (rawTz !== undefined && rawTz.trim() !== "") {
    if (!isValidTimeZone(rawTz)) {
      throw new ClockError(
        `${opts.tz !== undefined ? "tz" : "THINGS_TZ"} is not a valid IANA time zone: ` +
          `"${rawTz}" — expected a name like "America/New_York" or "Asia/Tokyo"`,
      );
    }
    zone = rawTz;
  }

  const rawNow = opts.env["THINGS_NOW"];
  let pinned: number | undefined;
  if (rawNow !== undefined && rawNow.trim() !== "") {
    const ms = new Date(rawNow).getTime();
    if (Number.isNaN(ms)) {
      throw new ClockError(
        `THINGS_NOW is not a valid ISO-8601 instant: "${rawNow}" — ` +
          `expected e.g. "2026-07-17T09:00:00Z" or "2026-07-17T09:00:00-04:00"`,
      );
    }
    pinned = ms;
  }

  const now =
    opts.now ?? (pinned !== undefined ? (): Date => new Date(pinned) : (): Date => new Date());
  return { now, zone, explicit: zone !== undefined || pinned !== undefined };
}

/** The additive `meta.clock` honesty field, or undefined when the host clock is in force. */
export interface ClockMeta {
  /** The IANA zone the dates in this response were computed for. */
  timezone: string;
  /** The consumer's Today under that clock. */
  today: IsoDate;
}

/**
 * Build the `meta.clock` field for a clock and an optional per-call zone
 * override. Returns undefined unless a consumer zone or pinned now is in
 * effect (so the wire shape is unchanged for host-clock consumers).
 */
export function clockMeta(clock: EffectiveClock, zoneOverride?: string): ClockMeta | undefined {
  const zone = zoneOverride ?? clock.zone;
  const explicit = clock.explicit || zoneOverride !== undefined;
  if (!explicit) return undefined;
  const now = clock.now();
  return {
    timezone: zone ?? hostTimeZone(),
    today: zone === undefined ? localToday(now) : calendarDateInZone(now, zone),
  };
}
