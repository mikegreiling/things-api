// Host-side ingest for a fresh clone drive (lab/scripts/simfid.sh). The guest
// driver emits, per headless case, a before + after DB snapshot in the exact
// keyed-rows shape lab/simfid/snapshot.ts produces on the host (guest-driver.py
// mirrors the column set + key scheme). This turns each into a NORMALIZED app
// delta (same normalizer as the sim side) written as <caseId>.json into an
// output dir that `npm run lab:simfid -- --app-deltas <dir>` consumes.
//
//   node lab/simfid/ingest-clone.ts <guest-run-dir> <out-app-deltas-dir>
//
// <guest-run-dir> holds cases/<id>.before.json and cases/<id>.after.json.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { diffSnapshots } from "../runner/differ.ts";
import type { DbSnapshot } from "../runner/types.ts";
import { buildIdentityMap, normalizeDelta } from "./normalize.ts";

function main(): void {
  const guestRun = process.argv[2];
  const outDir = process.argv[3];
  if (guestRun === undefined || outDir === undefined) {
    console.error("usage: node lab/simfid/ingest-clone.ts <guest-run-dir> <out-app-deltas-dir>");
    process.exitCode = 2;
    return;
  }
  const casesDir = join(guestRun, "cases");
  if (!existsSync(casesDir)) {
    console.error(`no cases/ dir under ${guestRun}`);
    process.exitCode = 2;
    return;
  }
  mkdirSync(outDir, { recursive: true });

  const ids = [
    ...new Set(
      readdirSync(casesDir)
        .filter((f) => f.endsWith(".before.json"))
        .map((f) => f.replace(/\.before\.json$/, "")),
    ),
  ];
  let written = 0;
  for (const id of ids) {
    const beforePath = join(casesDir, `${id}.before.json`);
    const afterPath = join(casesDir, `${id}.after.json`);
    if (!existsSync(afterPath)) {
      console.error(`skip ${id}: missing after snapshot`);
      continue;
    }
    const before = JSON.parse(readFileSync(beforePath, "utf8")) as DbSnapshot;
    const after = JSON.parse(readFileSync(afterPath, "utf8")) as DbSnapshot;
    const delta = diffSnapshots(before, after);
    const norm = normalizeDelta(delta, buildIdentityMap(before, after));
    writeFileSync(join(outDir, `${id}.json`), JSON.stringify(norm, null, 2));
    written++;
  }
  console.log(`ingested ${written} clone app deltas → ${outDir}`);
}

main();
