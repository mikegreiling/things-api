// SIMFID app-side ground truth. The strongest source is a FRESH clone drive
// (lab/scripts/simfid.sh → a normalized app delta per case in the run artifact
// dir); until that runs for a case, the app golden is derived here from the
// BANKED probe evidence:
//
//   - CRUD ops: the app behaviour is the modeled behaviour — the a/e/o/u/r/p/s
//     suites already certified the real app does exactly this. The golden equals
//     the normalized sim delta (a regression anchor; provenance suite-evidence).
//     These rows are NOT independent re-captures this run; a clone drive
//     upgrades them.
//   - recurrence / subtree ops: the golden is the modeled delta PLUS the
//     documented app-only extras RSIM/RSIM-R/RSIM-S observed but the simulator
//     deliberately does not emit — the junk instance `rt1_nextInstanceStartDate`
//     sentinel and the nondeterministic per-child instance→template back-link.
//     Layering these in is what exercises the declared tolerances end-to-end,
//     and reflects the real app's observed shape (provenance rsim-evidence).
//
// A hand-authored or clone-captured golden file (lab/simfid/app-golden/<id>.json
// or the run's --app-deltas dir) OVERRIDES the derivation entirely.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SimfidCase } from "./cases.ts";
import type { AppGolden, CellValue, NormalizedDelta, NormalizedRow, Provenance } from "./types.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

/** The app's uninitialized junk value on a minted instance's next-start column. */
const INSTANCE_NEXT_SENTINEL = 69760;

function clone(delta: NormalizedDelta): NormalizedDelta {
  return JSON.parse(JSON.stringify(delta)) as NormalizedDelta;
}

const isTemplateRef = (v: CellValue): boolean =>
  typeof v === "string" && (v.startsWith("project:") || v.startsWith("todo:"));

/** A top-level INSTANCE row: carries a template back-link, not filed under a container. */
function isTopLevelInstance(row: NormalizedRow): boolean {
  const f = row.fields;
  return (
    isTemplateRef(f["rt1_repeatingTemplate"] ?? null) &&
    (f["project"] ?? null) === null &&
    (f["heading"] ?? null) === null
  );
}

/**
 * Layer the documented app-only recurrence extras onto a modeled delta:
 *  (1) every top-level instance row gets the junk `rt1_nextInstanceStartDate`
 *      sentinel (RSIM);
 *  (2) if the delta mints an instance PROJECT with subtree children, stamp the
 *      FIRST direct instance-side child's `rt1_repeatingTemplate` with the
 *      template — modelling ONE draw of the app's nondeterministic per-child
 *      stamping (RSIM-R C2 / RSIM-S S1d) so the tolerance is exercised.
 */
function layerRecurrenceExtras(delta: NormalizedDelta): void {
  for (const row of delta.inserted) {
    if (row.table === "TMTask" && isTopLevelInstance(row)) {
      row.fields["rt1_nextInstanceStartDate"] = INSTANCE_NEXT_SENTINEL;
    }
  }
  // Find the instance project (type=1 row with a template back-link).
  const instanceProject = delta.inserted.find(
    (r) =>
      r.table === "TMTask" &&
      r.fields["type"] === 1 &&
      isTemplateRef(r.fields["rt1_repeatingTemplate"] ?? null),
  );
  if (instanceProject === undefined) return;
  const templateRef = instanceProject.fields["rt1_repeatingTemplate"] ?? null;
  const firstChild = delta.inserted.find(
    (r) =>
      r.table === "TMTask" &&
      r.fields["type"] === 0 &&
      (r.fields["project"] ?? null) === instanceProject.placeholder,
  );
  if (firstChild !== undefined) firstChild.fields["rt1_repeatingTemplate"] = templateRef;
}

/** Build the app golden for a case from its normalized sim delta + banked evidence. */
export function deriveAppGolden(caseDef: SimfidCase, simNorm: NormalizedDelta): AppGolden {
  // A hand-authored / clone-captured file wins.
  const filePath = join(REPO_ROOT, "lab/simfid/app-golden", `${caseDef.id}.json`);
  if (existsSync(filePath)) {
    const delta = JSON.parse(readFileSync(filePath, "utf8")) as NormalizedDelta;
    return {
      caseId: caseDef.id,
      op: caseDef.op,
      provenance: {
        source: "rsim-evidence",
        ref: caseDef.evidence,
        note: "hand-authored golden file",
      },
      delta,
    };
  }

  const delta = clone(simNorm);
  let provenance: Provenance;
  if (caseDef.family === "crud") {
    provenance = {
      source: "suite-evidence",
      ref: caseDef.evidence,
      note: "modeled == suite-certified app behaviour",
    };
  } else {
    layerRecurrenceExtras(delta);
    provenance = {
      source: "rsim-evidence",
      ref: caseDef.evidence,
      note: "modeled + documented app-only extras",
    };
  }
  return { caseId: caseDef.id, op: caseDef.op, provenance, delta };
}

/** Load a clone-captured normalized app delta from a run's --app-deltas dir, if present. */
export function loadCloneDelta(
  appDeltasDir: string | undefined,
  caseId: string,
): NormalizedDelta | null {
  if (appDeltasDir === undefined) return null;
  const path = join(appDeltasDir, `${caseId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as NormalizedDelta;
}
