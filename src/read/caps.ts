/**
 * The one shared decision behind every surface's `--limit`/`--all` (CLI) and
 * `limit`/`all` (MCP) cap resolution: given an explicit value, the `all`
 * flag, and a default, decide the effective row cap. Each surface keeps its
 * own input parsing and error emission (the CLI validates the string and
 * writes a usage error; MCP validates via zod and returns a tool error) —
 * only this pure conflict/default logic is shared.
 */

/**
 * Resolve one cap against `all` into a row cap: `null` = every row,
 * `"conflict"` when an explicit value combines with `all: true`, otherwise
 * the explicit value or the default.
 */
export function resolveCap(
  value: number | undefined,
  all: boolean | undefined,
  defaultLimit: number,
): number | null | "conflict" {
  if (all === true && value !== undefined) return "conflict";
  if (all === true) return null;
  return value ?? defaultLimit;
}
