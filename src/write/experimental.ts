/**
 * Canary for `experimental: true` capabilities: the private reorder command
 * is UNDOCUMENTED and can vanish in any Things update, so before every use
 * the pipeline re-checks that the app's sdef still declares it. A missing
 * declaration blocks the write loudly instead of dispatching a command the
 * app may now reject — or reinterpret.
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
