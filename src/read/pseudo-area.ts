/**
 * The `loose` pseudo-area: a reserved, case-insensitive ref that addresses the
 * NULL area (area-less items) as if it were an area, on READ surfaces only. It
 * mirrors the GUI sidebar's leading loose block — area-less projects, then loose
 * direct to-dos — plus the "Later Projects" someday/scheduled block under
 * `--show-later`. The reserved word ALWAYS wins over a real area that happens to
 * be named "Loose" (that area is reachable only by uuid); when one shadows, the
 * read surfaces a resolution disclosure. Every WRITE verb and the `open` command
 * refuse the reserved word by name — the pseudo-area is a derived view, not a
 * mutable container.
 */
import type { DatabaseSync } from "node:sqlite";

/** The reserved ref (lowercase canonical form) that names the loose pseudo-area. */
export const LOOSE_REF = "loose";

/** True when a ref names the reserved `loose` pseudo-area (case-insensitive, trimmed). */
export function isLooseRef(ref: string): boolean {
  return ref.trim().toLowerCase() === LOOSE_REF;
}

/**
 * The uuid of a real area whose title case-insensitively equals the reserved
 * word, if any — for the resolution-shadow disclosure. Lowest sidebar index
 * wins on the (pathological) chance of duplicates. Returns undefined when no
 * real area shadows the reserved word.
 */
export function shadowingLooseArea(db: DatabaseSync): string | undefined {
  const row = db
    .prepare(`SELECT uuid FROM TMArea WHERE lower(title) = ? ORDER BY "index" ASC LIMIT 1`)
    .get(LOOSE_REF) as { uuid: string } | undefined;
  return row?.uuid;
}

/** The disclosure appended to a loose read when a real area shadows the reserved word. */
export function looseShadowNotice(uuid: string): string {
  return `resolved to the loose pseudo-area; an area named "Loose" exists (uuid ${uuid}) — target it by uuid`;
}

/** Refusal for opening the loose pseudo-area — it is a derived view, not an app screen. */
export const LOOSE_OPEN_REFUSAL =
  "the loose pseudo-area is a derived view — it cannot be opened; open a specific project or area by ref";

/** Refusal for `--to-area loose` — the reserved word is a read-only view, not a destination. */
export const LOOSE_TO_AREA_REFUSAL =
  'the loose pseudo-area is a derived view — it cannot be modified; to leave a to-do area-less use --loose (a project: --no-area), or target a real area named "Loose" by uuid';
