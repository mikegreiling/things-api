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
