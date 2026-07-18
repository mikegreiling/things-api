/**
 * The recurrence-rule SERIALIZER — the write-side inverse of the read-only
 * decoder in {@link ../model/recurrence.ts}. It composes the `rt1_recurrenceRule`
 * XML plist the Things app writes for a repeating template, in the exact shape
 * the decoder round-trips (rrv=4, the `of` offset grammar, the year-4001 "forever"
 * `ed` sentinel).
 *
 * Two consumers share it, and NEITHER writes to a real Things database:
 *  - the SIMULATOR write vector (src/write/vectors/simulator.ts), which applies
 *    the RSIM-characterized recurrence mutations as SQL against a synthetic
 *    fixture DB (docs/lab/rsim-results.md); and
 *  - the bench WORLD profile (bench/world.ts), which seeds synthetic templates.
 *
 * Repeat rules remain UI-only on any real surface (writes go through the app's
 * Repeat dialog, never SQLite) — this serializer exists solely so bench/simulated
 * writes can reproduce the app's row shape without a Things install. The
 * low-level {@link ruleXml} takes a numeric {@link RuleSpec}; {@link composeRepeatRuleSpec}
 * maps the consumer-facing {@link RepeatRuleParams} vocabulary onto that spec.
 */
import { type IsoDate } from "../model/dates.ts";
import type { RepeatRuleParams } from "./operations.ts";
import { WEEKDAY_TO_WD } from "./repeat-rule.ts";

/** One entry in a rule's `of` offset array (numeric, decoder-facing encoding). */
export interface RuleOffsets {
  /** 0-based day of month; -1 = last day. */
  dy?: number;
  /** 0-based month. */
  mo?: number;
  /** Weekday, 0 = Sunday … 6 = Saturday. */
  wd?: number;
  /** Nth weekday within the month (1..5); -1 = last. */
  wdo?: number;
}

/** The numeric fields {@link ruleXml} renders into the plist. */
export interface RuleSpec {
  /** 0 fixed · 1 after-completion. */
  tp: 0 | 1;
  /** 16 daily · 256 weekly · 8 monthly · 4 yearly. */
  fu: 16 | 256 | 8 | 4;
  /** Interval multiplier ("every fa units"). */
  fa: number;
  /** Start offset in days (≤ 0); default 0. */
  ts?: number;
  of?: RuleOffsets[];
  /** Anchor epoch written to both `sr` and `ia` (the decoder ignores these). */
  anchor: number;
  /** End date, unix seconds; default the year-4001 "forever" sentinel. */
  ed?: number;
  /** Remaining repeat count; default 0 (= unlimited). */
  rc?: number;
}

/** Distant-future `ed` sentinel (year 4001 — the same class the app writes). */
export const RULE_FOREVER = 64_092_211_200;

/** Recurrence-unit code for each frequency (mirrors the decoder's UNITS map). */
export const FREQUENCY_TO_FU: Record<RepeatRuleParams["frequency"], 16 | 256 | 8 | 4> = {
  daily: 16,
  weekly: 256,
  monthly: 8,
  yearly: 4,
};

/** Compose an `rt1_recurrenceRule` XML plist the read-path decoder accepts. */
export function ruleXml(spec: RuleSpec): string {
  const offsets = (spec.of ?? [{ dy: 0 }])
    .map((o) => {
      const entries = Object.entries(o)
        .map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`)
        .join("");
      return `<dict>${entries}</dict>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>` +
    `<key>ed</key><integer>${spec.ed ?? RULE_FOREVER}</integer>` +
    `<key>fa</key><integer>${spec.fa}</integer>` +
    `<key>fu</key><integer>${spec.fu}</integer>` +
    `<key>ia</key><integer>${spec.anchor}</integer>` +
    `<key>of</key><array>${offsets}</array>` +
    `<key>rc</key><integer>${spec.rc ?? 0}</integer>` +
    `<key>rrv</key><integer>4</integer>` +
    `<key>sr</key><integer>${spec.anchor}</integer>` +
    `<key>tp</key><integer>${spec.tp}</integer>` +
    `<key>ts</key><integer>${spec.ts ?? 0}</integer>` +
    `</dict></plist>\n`
  );
}

// -------------------------------------------------- vocabulary → spec

const ymd = (iso: IsoDate): [number, number, number] =>
  iso.split("-").map(Number) as [number, number, number];

/** Weekday (0 = Sunday) of an ISO date, evaluated at UTC noon (tz-invariant). */
function weekdayOf(iso: IsoDate): number {
  const [y, m, d] = ymd(iso);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/**
 * The `of` offsets for a rule. A FIXED rule anchors on its calendar placement —
 * the explicit weekdays/monthly/yearly anchor when given, else derived from the
 * occurrence date (`refIso`): a weekly rule fires on the occurrence's weekday, a
 * monthly one on its day-of-month, a yearly one on its month + day. An
 * AFTER-COMPLETION rule has NO calendar day, so Things writes only the unit's
 * nominal zero-index offset (UIC6-e: weekly of=[{wd:0}], monthly of=[{dy:0}]);
 * the decoder ignores it. Only the weekly after-completion shape is RSIM-proven
 * (RSIM2); the daily/monthly/yearly nominals follow the UIC6-e convention.
 */
function composeOffsets(params: RepeatRuleParams, refIso: IsoDate): RuleOffsets[] {
  if (params.afterCompletion === true) {
    switch (params.frequency) {
      case "daily":
        return [{ dy: 0 }];
      case "weekly":
        return [{ wd: 0 }];
      case "monthly":
        return [{ dy: 0 }];
      case "yearly":
        return [{ mo: 0, dy: 0 }];
    }
  }
  switch (params.frequency) {
    case "daily":
      return [{ dy: 0 }];
    case "weekly": {
      if (params.weekdays !== undefined) {
        return params.weekdays.map((w) => ({ wd: WEEKDAY_TO_WD[w] }));
      }
      return [{ wd: weekdayOf(refIso) }];
    }
    case "monthly": {
      const anchor = params.monthly;
      if (anchor === undefined) return [{ dy: ymd(refIso)[2] - 1 }];
      return [monthlyOffset(anchor)];
    }
    case "yearly": {
      const anchor = params.yearly;
      if (anchor === undefined) {
        const [, m, d] = ymd(refIso);
        return [{ mo: m - 1, dy: d - 1 }];
      }
      return [{ mo: anchor.month - 1, ...monthlyOffset(anchor) }];
    }
  }
}

/** One month/year day anchor → its offset entry (day-of-month OR nth-weekday). */
function monthlyOffset(
  anchor: { day: number | "last" } | { weekday: string; ordinal: number | "last" },
): RuleOffsets {
  if ("day" in anchor) {
    return { dy: anchor.day === "last" ? -1 : anchor.day - 1 };
  }
  return {
    wd: WEEKDAY_TO_WD[anchor.weekday as keyof typeof WEEKDAY_TO_WD],
    wdo: anchor.ordinal === "last" ? -1 : anchor.ordinal,
  };
}

/**
 * Map the extended {@link RepeatRuleParams} vocabulary onto a numeric
 * {@link RuleSpec}. `refIso` is the occurrence date the calendar anchor derives
 * from when no explicit anchor is given; `anchor` seeds the (decoder-ignored)
 * sr/ia epochs. A deadlined rule carries the start-offset in `ts` (ts = −N days
 * earlier); the template's own `deadline` sentinel column — set by the applier,
 * not here — is what actually flags deadline-ness (oddities §8a).
 */
export function composeRepeatRuleSpec(
  params: RepeatRuleParams,
  refIso: IsoDate,
  anchor: number,
): RuleSpec {
  const deadlined = params.deadline === true || (params.startDaysEarlier ?? 0) > 0;
  const spec: RuleSpec = {
    tp: params.afterCompletion === true ? 1 : 0,
    fu: FREQUENCY_TO_FU[params.frequency],
    fa: params.interval,
    ts: deadlined ? -(params.startDaysEarlier ?? 0) : 0,
    of: composeOffsets(params, refIso),
    anchor,
  };
  const ends = params.ends;
  if (ends !== undefined && ends.kind !== "never") {
    if (ends.kind === "on-date") {
      spec.ed = Math.floor(Date.parse(`${ends.date}T00:00:00Z`) / 1000);
    } else {
      spec.rc = ends.count;
    }
  }
  return spec;
}
