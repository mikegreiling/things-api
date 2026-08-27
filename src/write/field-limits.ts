/**
 * The MEASURED ceilings on Things' content fields, and the counters that
 * measure a candidate value in the units the app actually cuts by.
 *
 * Why this exists (#621): a notes body a little over 10,000 characters was
 * accepted by the app as a TRUNCATED PREFIX — cut mid-word, no error, the row
 * mutated. The read-after-write caught the difference and reported a generic
 * mismatch, so the caller learned that something was wrong but not that a limit
 * existed, what it was, or that half the write had landed. Every field below is
 * the same trap: the app never refuses an over-long value, it stores a prefix.
 *
 * THE LAW (NOTECAP1, [docs/lab/notecap1-notes-ceiling.md] — Things 3.23 build
 * 32300036, golden `things-lab-golden-v4`). Two field classes, three ceilings:
 *
 * 1. **notes — 10,000 GRAPHEME CLUSTERS *and* 40,000 UTF-16 CODE UNITS,
 *    whichever binds first, on the URL scheme.** The cluster rule is the one
 *    ordinary text meets: 15,000 emoji cut to 10,000 emoji, 15,000 `e`+U+0301
 *    pairs cut to 10,000 pairs, and a regional-indicator flag or an emoji +
 *    skin-tone modifier each count as ONE. The unit rule only shows up in text
 *    whose clusters are unusually wide — a ZWJ emoji family is one cluster but
 *    eleven UTF-16 units — and it cuts on a surrogate-safe boundary rather than
 *    a cluster one, so it CAN leave a dangling joiner.
 *
 *    This ceiling belongs to the URL scheme, not to the database or the app's
 *    model: AppleScript's `set notes` stores 60 KB without complaint. Every
 *    notes-carrying operation here compiles to the URL scheme (`commands.ts`
 *    refuses any other vector), so it is the ceiling every caller meets.
 *
 *    It applies PER URL PARAMETER VALUE, not to the resulting field: an
 *    `append-notes` fragment under the ceiling joins onto an existing body and
 *    the joined result lands whole, well past 10,000. So the FRAGMENT is what
 *    must be checked — validating the JOIN would refuse writes the app performs
 *    correctly.
 *
 * 2. **titles and names — 4,000 UTF-16 CODE UNITS, in the app's model.** To-do
 *    titles, project titles, heading titles, checklist-item titles, area names
 *    and tag names all cut at 4,000 UTF-16 units, and unlike notes the cut is
 *    the SAME through AppleScript, so it is a property of the app rather than
 *    of a transport. The unit is UTF-16, not clusters: an emoji title cuts at
 *    1,993 emoji (3,999 units), not 4,000 emoji. The cut lands on a cluster
 *    boundary, which is why a value can stop one unit short of the ceiling.
 *
 * There is **no URL-length ceiling** below either: a 1,000,100-character
 * `things:///update` dispatches cleanly and still cuts the notes at exactly
 * 10,000 clusters, and padding the URL with 5,000 more characters of `title`
 * does not move that cut. The transport is not the constraint, so there is
 * nothing here for vector selection to route around.
 *
 * Fields with no measured app cap carry no limit here — these are refusals
 * against a value the app would silently mangle, not policy.
 */

/**
 * Printable ASCII plus LF and TAB: each of these is its own cluster, so the
 * code-unit count IS the cluster count. CR is deliberately excluded — a CR LF
 * pair is a SINGLE cluster, and counting it as two would refuse a CRLF-heavy
 * body about twice as early as the app would cut it.
 */
const ONE_CLUSTER_PER_UNIT = /^[\x20-\x7e\n\t]*$/;

let segmenter: Intl.Segmenter | undefined;

/**
 * Count grapheme clusters — the unit the notes ceiling is expressed in.
 *
 * `String.prototype.length` is UTF-16 code units and would over-count every
 * emoji and every combining pair, refusing an emoji-dense note at half the real
 * ceiling. `Intl.Segmenter` counts extended grapheme clusters (UAX #29), which
 * is what the measurement matched on every payload class probed.
 */
export function countGraphemes(value: string): number {
  // Fast path for the overwhelming majority of real values; the segmenter walk
  // is the expensive part on a 10,000-character body.
  if (ONE_CLUSTER_PER_UNIT.test(value)) return value.length;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let n = 0;
  for (const _ of segmenter.segment(value)) n++;
  return n;
}

/** Which unit a ceiling is counted in. */
export type LengthUnit = "graphemes" | "utf16";

/** One measured ceiling: how many, of what. */
export interface LengthLimit {
  max: number;
  unit: LengthUnit;
}

/** Notes: 10,000 grapheme clusters, and 40,000 UTF-16 units, whichever binds. */
export const NOTES_LIMITS: readonly LengthLimit[] = [
  { max: 10_000, unit: "graphemes" },
  { max: 40_000, unit: "utf16" },
];

/** Titles and names: 4,000 UTF-16 code units, on every vector. */
export const TITLE_LIMITS: readonly LengthLimit[] = [{ max: 4_000, unit: "utf16" }];

/**
 * How many checklist items ONE dispatch carries (NOTECAP1 CK-COUNT). Past this
 * Things keeps the first 100 and drops the rest — the count-axis version of the
 * same silent partial landing, and just as invisible: the to-do is created, the
 * items beyond 100 simply never exist.
 */
export const CHECKLIST_MAX_ITEMS = 100;

/** Measure a value in one ceiling's own unit. */
export function measure(value: string, unit: LengthUnit): number {
  return unit === "utf16" ? value.length : countGraphemes(value);
}

/** How a unit is named to the caller, in the words that make the number checkable. */
export function unitName(unit: LengthUnit): string {
  return unit === "utf16" ? "UTF-16 code units" : "characters";
}

/**
 * The refusal detail for an over-long field value, in the registry's house
 * shape (`<path>: expected … — received …`). Names the maximum, its unit, and
 * the size actually handed over, plus what the app would have done with it — so
 * the caller can trim without guessing and knows why the call was not simply
 * passed through. The FIRST exceeded ceiling is the one reported.
 *
 * Returns null when the value fits every ceiling.
 */
export function fieldLengthRefusal(
  path: string,
  value: string,
  limits: readonly LengthLimit[],
): string | null {
  for (const limit of limits) {
    const n = measure(value, limit.unit);
    if (n <= limit.max) continue;
    return (
      `${path}: expected at most ${limit.max.toLocaleString("en-US")} ${unitName(limit.unit)} — ` +
      `received ${n.toLocaleString("en-US")}; Things stores a longer value as a truncated ` +
      `prefix rather than refusing it, so nothing was sent`
    );
  }
  return null;
}

/**
 * The post-write reading of a field mismatch: when what landed is a strict
 * PREFIX of what was asked for, the app truncated rather than ignored, and the
 * item now holds a partial value. Returns the sentence naming that — how much
 * landed, how much was asked for — or null when the mismatch is something else
 * (a different value, a longer one, a non-string field).
 */
export function describeTruncation(
  field: string,
  expected: unknown,
  observed: unknown,
): string | null {
  if (typeof expected !== "string" || typeof observed !== "string") return null;
  if (observed.length === 0 || observed.length >= expected.length) return null;
  if (!expected.startsWith(observed)) return null;
  const ceilings = (field === "notes" ? NOTES_LIMITS : TITLE_LIMITS)
    .map((l) => `${l.max.toLocaleString("en-US")} ${unitName(l.unit)}`)
    .join(" / ");
  return (
    `${field} was TRUNCATED, not ignored: ${observed.length.toLocaleString("en-US")} of the ` +
    `${expected.length.toLocaleString("en-US")} UTF-16 code units requested landed, and the ` +
    `stored value is a prefix of what was sent — the item now holds a partial value. Things ` +
    `caps this field at ${ceilings} and stores a longer value as a prefix rather than ` +
    `refusing it`
  );
}
