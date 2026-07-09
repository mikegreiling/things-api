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
 *   ts  start offset in days relative to the event date (≤0 = start early;
 *       the event date becomes the spawned instance's DEADLINE when ts<0)
 *   of  occurrence offsets: dy (0-based day; -1 = last day of month),
 *       mo (0-based month), wd (weekday, 0=Sunday), wdo (nth weekday, -1=last)
 *   ed  end date (unix seconds; distant-future sentinel = no end)
 *   rc  remaining repeat count (0 = unlimited)
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
  /** Days the instance's start precedes its event date (≤ 0). */
  startOffsetDays: number;
  offsets: RepeatOffset[];
  endDate: IsoDate | null;
  remainingCount: number | null;
  version: number;
}

const UNITS: Record<number, RepeatRule["unit"]> = {
  16: "daily",
  256: "weekly",
  8: "monthly",
  4: "yearly",
};

/** Unix seconds this far out (year ≥ 3000) mean "repeats forever". */
const DISTANT_FUTURE_EPOCH = 32503680000;

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
      const e = entry as Record<string, PlistValue>;
      const offset: RepeatOffset = {};
      if (typeof e["dy"] === "number") offset.day = e["dy"] === -1 ? -1 : e["dy"] + 1;
      if (typeof e["mo"] === "number") offset.month = e["mo"] + 1;
      if (typeof e["wd"] === "number") offset.weekday = e["wd"];
      if (typeof e["wdo"] === "number") offset.weekdayOrdinal = e["wdo"];
      offsets.push(offset);
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
    remainingCount: rc === 0 ? null : rc,
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
