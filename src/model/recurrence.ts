/**
 * READ-ONLY decoder for TMTask.rt1_recurrenceRule — an XML plist Things
 * writes for repeating templates. NEVER serialized or written back (repeat
 * rules are UI-only; see docs/gaps.md). Semantics reverse-engineered from a
 * 91-rule live corpus and cross-validated against the app's own spawned
 * instances (deadline = startDate − ts held on every sample, 2026-07-04):
 *
 *   tp  0 fixed schedule · 1 after-completion
 *   fu  16 daily · 256 weekly · 8 monthly · 4 yearly
 *   fa  interval multiplier ("every fa units")
 *   ts  start offset in days relative to the event date (≤0 = start early).
 *       For a DEADLINED rule the event date is the spawned instance's deadline
 *       (deadline = start − ts; corpus re-validated 2026-07-11 over 1,900+ live
 *       instances). A non-zero start offset appears here as ts<0 (UI "start N
 *       days earlier" → ts=−N; UI1 2026-07-12: "3 days earlier" → ts=−3).
 *       ⚠️ deadline-ness is NOT encoded in this blob. A deadline-LESS fixed
 *       repeat is the GUI DEFAULT ("Add deadlines" is opt-in): its instances
 *       carry a startDate but NO deadline, and its rt1_recurrenceRule is
 *       BYTE-IDENTICAL to a deadlined ts=0 rule (tp=0, ts=0, of=[{dy:0}]).
 *       RESOLVED discriminator (UI1 2026-07-12, oddities §8a): the TEMPLATE
 *       row's own `deadline` COLUMN — NULL when deadline-less, a far-future
 *       sentinel (4001-01-01) when deadlined. It holds for BOTH fixed and
 *       after-completion rules (also falsifying the old after-completion
 *       ts<0 heuristic: a deadlined ts=0 after-completion template exists).
 *       Consumers therefore gate the deadline projection on the template's
 *       deadline column (surfaced as RepeatingInfo.deadlined), never on this
 *       rule. NOTE: t2_deadlineOffset stays 0 in every case — it is NOT the
 *       discriminator.
 *   of  occurrence offsets: dy (0-based day; -1 = last day of month),
 *       mo (0-based month), wd (weekday, 0=Sunday), wdo (nth weekday, -1=last)
 *   ed  end date (unix seconds; distant-future sentinel = no end). An
 *       ends-after rule OMITS this key entirely (RRX1); an ends-on rule sets
 *       it to the chosen date.
 *   rc  the configured "ends after N times" TOTAL occurrence count. IMMUTABLE:
 *       it does NOT decrement as instances spawn (RRX1 — a daily ends-after-3
 *       series held rc=3 through all three spawns and past exhaustion; the app
 *       counts spawns in the template's rt1_instanceCreationCount column and
 *       stops by clearing the cursor rt1_nextInstanceStartDate, never by
 *       touching rc). 0/absent = unlimited. NOT "remaining" — it never counts
 *       down, so it is decoded as `occurrenceCount`, not a remaining tally.
 *   rrv rule schema version (4 observed)
 *   sr/ia anchor timestamps (not needed for reads)
 */
import type { IsoDate } from "./dates.ts";

export interface RepeatOffset {
  /** 1-based day of month; -1 = last day. */
  day?: number;
  /** 1-based month. */
  month?: number;
  /** Weekday, 0 = Sunday … 6 = Saturday. */
  weekday?: number;
  /** Nth weekday within the month (1..5), -1 = last. */
  weekdayOrdinal?: number;
}

export interface RepeatRule {
  type: "fixed" | "after-completion";
  unit: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  /**
   * Days the instance's start precedes its event date (≤ 0). CAVEAT (UIC7,
   * oddities §8p): a GUI reschedule from a fixed to an after-completion rule
   * PRESERVES this offset (and the deadline) from the old rule — an
   * after-completion rule can therefore legitimately carry a non-zero `ts`
   * (deadline = start − ts), so consumers must not assume after-completion ⇒
   * ts=0. The calendar `offsets`, by contrast, reset to the unit nominal.
   */
  startOffsetDays: number;
  offsets: RepeatOffset[];
  endDate: IsoDate | null;
  /**
   * The rule's "ends after N times" TOTAL occurrence count (`null` when the
   * series is unlimited). This is the CONFIGURED bound, NOT a live tally: it
   * never decrements as instances spawn (RRX1). The app tracks progress in the
   * template's `rt1_instanceCreationCount` column (not in this rule blob) and
   * ends the series by clearing its next-occurrence cursor once that count
   * reaches this total — so an exhausted ends-after series still decodes with
   * `occurrenceCount` = its original N. Reading how MANY remain therefore
   * requires the template's icCount, which is outside this rule.
   */
  occurrenceCount: number | null;
  version: number;
}

const UNITS: Record<number, RepeatRule["unit"]> = {
  16: "daily",
  256: "weekly",
  8: "monthly",
  4: "yearly",
};

/**
 * Decode ONE `of` offset entry (the plist grammar `dy`/`mo`/`wd`/`wdo`) into a
 * {@link RepeatOffset}. Shared by {@link decodeRecurrenceRule} (reading a stored
 * rule) and the write-side full-fidelity assert builder (which composes the
 * expected numeric offsets and round-trips them through this SAME decode so the
 * canonical anchor key it compares against is byte-consistent with what a real
 * read produces). Accepts any record; non-numeric fields are ignored.
 */
export function decodeOffsetEntry(e: Record<string, unknown>): RepeatOffset {
  const offset: RepeatOffset = {};
  if (typeof e["dy"] === "number") offset.day = e["dy"] === -1 ? -1 : e["dy"] + 1;
  if (typeof e["mo"] === "number") offset.month = e["mo"] + 1;
  if (typeof e["wd"] === "number") offset.weekday = e["wd"];
  if (typeof e["wdo"] === "number") offset.weekdayOrdinal = e["wdo"];
  return offset;
}

/**
 * A canonical, ORDER-INSENSITIVE string key of a rule's calendar anchor (its
 * `offsets`) — the comparison surface for full-fidelity recurrence assertions.
 * Each offset renders to a compact token (`m` month · `d` day · `w` weekday ·
 * `o` weekday-ordinal, all decoded values), and the tokens are sorted so a
 * weekly rule that fires Tue+Thu keys identically regardless of the order the
 * app happened to store the two weekday offsets in. Two rules share a key iff
 * they name the SAME set of calendar placements. Empty offsets (or all-nominal
 * after-completion offsets) yield "".
 */
export function anchorKeyOfOffsets(offsets: RepeatOffset[]): string {
  return offsets
    .map((o) => {
      const parts: string[] = [];
      if (o.month !== undefined) parts.push(`m${o.month}`);
      if (o.day !== undefined) parts.push(`d${o.day}`);
      if (o.weekday !== undefined) parts.push(`w${o.weekday}`);
      if (o.weekdayOrdinal !== undefined) parts.push(`o${o.weekdayOrdinal}`);
      return parts.join("");
    })
    .filter((t) => t.length > 0)
    .toSorted()
    .join(",");
}

/** Unix seconds this far out (year ≥ 3000) mean "repeats forever". */
const DISTANT_FUTURE_EPOCH = 32503680000;

/**
 * The GUI's status word for a repeating template with no set next occurrence:
 * `paused` (instance creation paused), `ended` (the series will spawn no more
 * instances — its end date has passed or its occurrence count is exhausted),
 * else `waiting` (an after-completion rule between instances).
 *
 * Exhaustion is read from the CURSOR, not the rule's count. A FIXED series
 * always carries a next-occurrence cursor while live; the app clears it
 * (`rt1_nextInstanceStartDate` → NULL) the moment the series ends — whether by
 * an ends-ON date passing OR an ends-AFTER count being reached (RRX1: a daily
 * ends-after-3 series went cursor-NULL after its 3rd spawn with rc still 3, and
 * a past ends-on template was born cursor-NULL). So a fixed rule with no next
 * occurrence has ended. The rule's occurrence count is NOT the signal — it is
 * the immutable configured total (never 0 at exhaustion), which is why the old
 * `remainingCount === 0` test was unreachable. After-completion rules rest with
 * no next occurrence BETWEEN instances (that is `waiting`, not `ended`), so the
 * cursor test is gated on fixed rules. Live-verified 2026-07-11 (Ended = fixed
 * rule with a past endDate; Waiting = after-completion rule) + RRX1 2026-08-15
 * (ends-after / ends-on exhaustion end-states, golden-v2 / 3.22.12).
 */
export function templateStatus(
  repeating: { paused?: boolean; rule?: RepeatRule; nextOccurrence?: IsoDate | null },
  todayIso: string,
): "waiting" | "paused" | "ended" {
  if (repeating.paused === true) return "paused";
  const rule = repeating.rule;
  if (rule !== undefined) {
    // An ends-on rule whose end date has passed is ended — an authoritative
    // signal that also covers a "born already ended" past ends-on template.
    if (rule.endDate !== null && rule.endDate < todayIso) return "ended";
    // A fixed series with no next occurrence has exhausted its bound (count OR
    // date) — the app cleared the cursor. (After-completion cursor-NULL is a
    // normal resting state, so this is fixed-only.)
    if (rule.type === "fixed" && repeating.nextOccurrence == null) return "ended";
  }
  return "waiting";
}

export function decodeRecurrenceRule(blob: unknown): RepeatRule {
  const xml =
    typeof blob === "string"
      ? blob
      : blob instanceof Uint8Array
        ? new TextDecoder().decode(blob)
        : null;
  if (xml === null) throw new RangeError("recurrence rule is not an XML blob");
  const root = parsePlist(xml);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new RangeError("recurrence rule plist is not a dict");
  }
  const dict = root as Record<string, PlistValue>;
  const tp = num(dict, "tp");
  const fu = num(dict, "fu");
  const unit = UNITS[fu];
  if (unit === undefined) throw new RangeError(`unknown recurrence unit fu=${fu}`);
  if (tp !== 0 && tp !== 1) throw new RangeError(`unknown recurrence type tp=${tp}`);

  const offsets: RepeatOffset[] = [];
  const of = dict["of"];
  if (Array.isArray(of)) {
    for (const entry of of) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      offsets.push(decodeOffsetEntry(entry as Record<string, unknown>));
    }
  }

  const ed = typeof dict["ed"] === "number" ? dict["ed"] : null;
  const rc = typeof dict["rc"] === "number" ? dict["rc"] : 0;
  // STRICT version gate: every rule in the validated corpus carries rrv=4.
  // A different version means a Things update changed the rule format — the
  // old semantics must not be silently applied to a new encoding. Consumers
  // already treat a decode throw as "rule unavailable"; `things doctor`
  // counts undecodable templates so the drift surfaces loudly.
  const rrv = typeof dict["rrv"] === "number" ? dict["rrv"] : 0;
  if (rrv !== KNOWN_RULE_VERSION) {
    throw new RangeError(
      `unsupported recurrence rule version rrv=${rrv} (validated: ${KNOWN_RULE_VERSION}) — ` +
        "a Things update may have changed the repeat-rule format",
    );
  }
  return {
    type: tp === 0 ? "fixed" : "after-completion",
    unit,
    interval: num(dict, "fa"),
    startOffsetDays: typeof dict["ts"] === "number" ? dict["ts"] : 0,
    offsets,
    endDate: ed === null || ed >= DISTANT_FUTURE_EPOCH ? null : epochToIso(ed),
    // rc = the "ends after N" TOTAL (immutable, never decrements — RRX1);
    // 0/absent = unlimited. See RepeatRule.occurrenceCount.
    occurrenceCount: rc === 0 ? null : rc,
    version: rrv,
  };
}

/** The rule schema version the 91-rule corpus + instance validation covered. */
export const KNOWN_RULE_VERSION = 4;

function num(dict: Record<string, PlistValue>, key: string): number {
  const v = dict[key];
  if (typeof v !== "number") throw new RangeError(`recurrence rule missing numeric ${key}`);
  return v;
}

function epochToIso(seconds: number): IsoDate {
  const d = new Date(seconds * 1000);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ------------------------------------------------- minimal XML plist parser

type PlistValue = number | string | boolean | PlistValue[] | { [key: string]: PlistValue };

/**
 * Parses the machine-generated plist subset Things emits (dict/array/
 * integer/real/string/true/false). Deliberately tiny — not a general XML
 * parser; unknown node kinds fail loudly.
 */
export function parsePlist(xml: string): PlistValue {
  const body = /<plist[^>]*>([\s\S]*)<\/plist>/.exec(xml)?.[1];
  if (body === undefined) throw new RangeError("not a plist document");
  const parser = new Parser(body);
  const value = parser.parseValue();
  parser.skipWs();
  return value;
}

class Parser {
  private pos = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  skipWs(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos] as string)) this.pos++;
  }

  private openTag(): string {
    this.skipWs();
    const m = /^<([a-z]+)\s*(\/)?>/.exec(this.s.slice(this.pos));
    if (!m) throw new RangeError(`plist parse error at ${this.pos}`);
    this.pos += m[0].length;
    return m[2] === "/" ? `${m[1] as string}/` : (m[1] as string);
  }

  private closeTag(name: string): void {
    this.skipWs();
    const expect = `</${name}>`;
    if (!this.s.startsWith(expect, this.pos)) {
      throw new RangeError(`plist parse error: expected ${expect} at ${this.pos}`);
    }
    this.pos += expect.length;
  }

  private text(until: string): string {
    const idx = this.s.indexOf(`</${until}>`, this.pos);
    if (idx === -1) throw new RangeError(`plist parse error: unterminated <${until}>`);
    const raw = this.s.slice(this.pos, idx);
    this.pos = idx + until.length + 3;
    return raw
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  }

  peekClose(name: string): boolean {
    this.skipWs();
    return this.s.startsWith(`</${name}>`, this.pos);
  }

  parseValue(): PlistValue {
    const tag = this.openTag();
    switch (tag) {
      case "integer":
      case "real":
        return Number(this.text(tag));
      case "string":
        return this.text(tag);
      case "true/":
        return true;
      case "false/":
        return false;
      case "dict": {
        const dict: { [key: string]: PlistValue } = {};
        while (!this.peekClose("dict")) {
          const keyTag = this.openTag();
          if (keyTag !== "key") throw new RangeError(`plist parse error: expected <key>`);
          const key = this.text("key");
          dict[key] = this.parseValue();
        }
        this.closeTag("dict");
        return dict;
      }
      case "array": {
        const arr: PlistValue[] = [];
        while (!this.peekClose("array")) arr.push(this.parseValue());
        this.closeTag("array");
        return arr;
      }
      default:
        throw new RangeError(`plist parse error: unsupported node <${tag}>`);
    }
  }
}
