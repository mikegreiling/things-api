/**
 * Locate the Things database. Precedence:
 *   1. explicit dbPath option
 *   2. THINGS_DB environment variable
 *   3. glob under the Things group container (most recently modified wins)
 */
import { globSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONTAINER_GLOB = join(
  "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac",
  "ThingsData-*/Things Database.thingsdatabase/main.sqlite",
);

export interface LocateResult {
  path: string;
  source: "option" | "env" | "container";
  /** Additional candidate paths that also matched (warn when >1). */
  otherCandidates: string[];
}

export class ThingsDbNotFoundError extends Error {
  constructor(searched: string) {
    super(
      `Things database not found (searched ${searched}). ` +
        `Is Things installed and has it been launched at least once? ` +
        `Override with THINGS_DB or openThings({ dbPath }).`,
    );
    this.name = "ThingsDbNotFoundError";
  }
}

export function locateThingsDb(options?: { dbPath?: string; home?: string }): LocateResult {
  if (options?.dbPath) {
    return { path: options.dbPath, source: "option", otherCandidates: [] };
  }
  const envPath = process.env["THINGS_DB"];
  if (envPath) {
    return { path: envPath, source: "env", otherCandidates: [] };
  }
  const home = options?.home ?? homedir();
  const matches = globSync(CONTAINER_GLOB, { cwd: home }).map((rel) => join(home, rel));
  if (matches.length === 0) {
    throw new ThingsDbNotFoundError(join(home, CONTAINER_GLOB));
  }
  const byMtime = matches
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime);
  const first = byMtime[0];
  if (!first) throw new ThingsDbNotFoundError(join(home, CONTAINER_GLOB));
  return {
    path: first.path,
    source: "container",
    otherCandidates: byMtime.slice(1).map((entry) => entry.path),
  };
}
