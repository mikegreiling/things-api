/**
 * The `<when>@<time>` scheduling sugar, shared by every consumer surface. A
 * single string like `2026-07-05@09:00` (or `today@evening`-style keyword +
 * time) carries BOTH the schedule and its reminder; this splits it into the
 * separate `when` + `reminder` the write pipeline expects, or reports the one
 * usage error. Extracted from the CLI so the CLI and MCP validate the suffix
 * identically instead of each re-deriving it — see docs/design/architecture.md
 * (Consumer boundary).
 *
 * Pure: it neither mutates its input nor validates the DATE/TIME values (the
 * pipeline does that downstream) — it only owns the `@` split and the two
 * usage messages. The flag/parameter LABELS are injected so each surface keeps
 * its own vocabulary (`--when`/`--reminder` vs `when`/`reminder`).
 */

/** The surface's spelling of the two parameters, interpolated into usage copy. */
export interface WhenSugarLabels {
  when: string;
  reminder: string;
}

/** CLI flag spellings — the default, since the sugar originated there. */
export const CLI_WHEN_LABELS: WhenSugarLabels = { when: "--when", reminder: "--reminder" };

/** MCP tool-parameter spellings. */
export const MCP_WHEN_LABELS: WhenSugarLabels = { when: "when", reminder: "reminder" };

/**
 * The result of inspecting a `when` value for the `@time` suffix:
 * - `unchanged` — no suffix; pass `when` through as-is.
 * - `split` — a valid suffix; use the split `when` + `reminder`.
 * - `error` — a malformed suffix, or a suffix given ALONGSIDE a separate
 *   reminder; emit `message` as a usage error.
 */
export type WhenSugar =
  | { kind: "unchanged" }
  | { kind: "split"; when: string; reminder: string }
  | { kind: "error"; message: string };

/**
 * Split a `when` value on its `@time` suffix. `reminderProvided` reflects
 * whether the caller ALSO passed a separate reminder — a suffix plus an
 * explicit reminder is ambiguous and rejected. A non-string or suffix-free
 * `when` is `unchanged`.
 */
export function splitWhenSugar(
  when: unknown,
  reminderProvided: boolean,
  labels: WhenSugarLabels = CLI_WHEN_LABELS,
): WhenSugar {
  if (typeof when !== "string" || !when.includes("@")) return { kind: "unchanged" };
  const at = when.indexOf("@");
  const date = when.slice(0, at);
  const time = when.slice(at + 1);
  if (date === "" || time === "" || time.includes("@")) {
    return {
      kind: "error",
      message: `invalid ${labels.when} "${when}" — expected today | evening | anytime | someday | YYYY-MM-DD (set a reminder with ${labels.reminder} HH:mm)`,
    };
  }
  if (reminderProvided) {
    return {
      kind: "error",
      message: `${labels.when} "${when}" carries an @time suffix and ${labels.reminder} was also given — use one`,
    };
  }
  return { kind: "split", when: date, reminder: time };
}
