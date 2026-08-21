/**
 * Container-scoped file reads (Things prefs plists for sync-health and URL-
 * scheme availability). The group container is TCC-protected like the
 * database, so in deputy mode these reads ride the deputy's `read-file` verb —
 * which the deputy confines to the container subtree. Direct mode is a plain
 * readFileSync, byte-identical to the pre-deputy behavior.
 */
import { readFileSync } from "node:fs";

import { deputyRouting, deputySyncRequest } from "./routing.ts";

export function readContainerFileSync(path: string): Buffer {
  if (!deputyRouting().active) return readFileSync(path);
  const res = deputySyncRequest({ verb: "read-file", path }, 10_000);
  return Buffer.from(res["b64"] as string, "base64");
}
