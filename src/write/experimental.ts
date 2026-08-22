/**
 * Canary for `experimental: true` capabilities: the private reorder command
 * is UNDOCUMENTED and can vanish in any Things update, so before every use
 * the pipeline re-checks that the app's sdef still declares it. A missing
 * declaration blocks the write loudly instead of dispatching a command the
 * app may now reject — or reinterpret.
 *
 * The sdef canary is a DECLARATION check, and Things 3.23 broke the command
 * without touching the declaration: it still parses, still exits 0, and now
 * changes nothing (docs/lab/gv4-323-campaign.md §3.1 — 14 o-suite reds plus
 * the e2e reorder steps, reproduced in isolation against a project scope).
 * Until the behavioral canary that would catch that class exists, a VERSION
 * gate stands in: on 3.23 and later the private command is treated as absent.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_REORDER_COMMAND = "_private_experimental_ reorder to dos in";

const SDEF_NEEDLE = `command name="${PRIVATE_REORDER_COMMAND}"`;
const RESOURCES_DIR = "/Applications/Things3.app/Contents/Resources";

/**
 * True when the installed Things sdef still declares the private reorder
 * command (Things 3.22.11 ships it as Resources/Things.sdef — scan every
 * .sdef in the bundle so a rename alone doesn't false-negative).
 */
export function sdefDeclaresPrivateReorder(resourcesDir: string = RESOURCES_DIR): boolean {
  let entries: string[];
  try {
    entries = readdirSync(resourcesDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".sdef")) continue;
    try {
      if (readFileSync(join(resourcesDir, entry), "utf8").includes(SDEF_NEEDLE)) return true;
    } catch {
      // unreadable sdef → keep scanning; all-fail means "not declared"
    }
  }
  return false;
}

/**
 * The first Things marketing version that accepts the private reorder command
 * and does nothing with it (GV4, docs/lab/gv4-323-campaign.md §3.1).
 */
export const PRIVATE_REORDER_NO_OP_FROM = "3.23";

/** The leading dotted-numeric run of a marketing version, or null when absent. */
function parseAppVersion(v: string | null): number[] | null {
  if (v === null) return null;
  const m = /^\d+(?:\.\d+)*/.exec(v.trim());
  if (m === null) return null;
  return m[0].split(".").map(Number);
}

/**
 * Compare two dotted marketing versions ("3.22.14", "3.23", "4.0"): -1 / 0 / +1
 * for a<b / a==b / a>b, or null when either is not a dotted-numeric stamp.
 * Missing trailing segments count as 0, so "3.23" == "3.23.0" < "3.23.1".
 */
export function compareAppVersions(a: string | null, b: string | null): number | null {
  const pa = parseAppVersion(a);
  const pb = parseAppVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * True when the installed Things is known to execute the private reorder
 * command as a silent no-op — i.e. its version is readable AND at least
 * {@link PRIVATE_REORDER_NO_OP_FROM}. An unknown or unparseable version is NOT
 * gated: the sdef canary and the `allow-experimental` gate remain the only
 * checks there, exactly as before.
 */
export function privateReorderIsNoOp(installedVersion: string | null): boolean {
  const cmp = compareAppVersions(installedVersion, PRIVATE_REORDER_NO_OP_FROM);
  return cmp !== null && cmp >= 0;
}
