/**
 * Shared parameter vocabulary — the exact wording every surface (CLI option
 * help, MCP tool schemas) uses for recurring parameter formats, so a format
 * learned on one surface transfers verbatim to the others. Only vocabulary
 * is shared; tool/command PROSE is written per surface. Style rules:
 * docs/design/surface-copy.md.
 */

/** Accepted `when` scheduling values. */
export const WHEN_VALUES = "today | evening | anytime | someday | YYYY-MM-DD";

/** Calendar-date parameter format (deadlines, dated `when`). */
export const DATE_FORMAT = "YYYY-MM-DD";

/** Reminder time-of-day parameter format. */
export const REMINDER_FORMAT = "HH:mm (24-hour)";

/** How projects, areas, and tags may be referenced. */
export const REF_FORMAT = "uuid or unique name";

/**
 * Time-window bound grammar shared by `--since`/`--until` flags: relative
 * periods counted from today (`2w`/`3m`/`1y`) or whole calendar periods
 * (`2024`, `2024-03`, `2024-03-05`).
 */
export const PERIOD_SINCE = "`2w`/`3m`/`1y` back from today, or `2024`, `2024-03`, `2024-03-05`";
export const PERIOD_UNTIL = "`2w`/`3m`/`1y` from today, or `2026-09`, `2026-09-15`, `2026`";

/** Default number of rows a list view returns before it truncates. */
export const DEFAULT_LIST_LIMIT = 50;

/** Shared `--limit`/`limit` description for FLAT views (total-row cap). */
export const LIMIT_DESC = `maximum items to show (default ${DEFAULT_LIST_LIMIT})`;

/** Shared `--all`/`all` description (lift the row limit). */
export const ALL_DESC = "show every matching item, no limit";

/** Per-group preview cap for the grouped catalogues (anytime/someday). */
export const GROUPED_PREVIEW_LIMIT = 3;

/**
 * `--limit`/`limit` description for the GROUPED views: the flag caps each
 * block independently, and the block skeleton (every area + project header)
 * is always complete.
 */
export const GROUPED_LIMIT_DESC = `items shown per group before truncating, applied to each area/project block independently (default ${GROUPED_PREVIEW_LIMIT}); every group header is always shown`;

/** `--all`/`all` description for the grouped views (lift the per-group cap). */
export const GROUPED_ALL_DESC = "show every item in every group (no per-group cap)";
