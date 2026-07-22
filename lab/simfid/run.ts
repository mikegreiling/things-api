// SIMFID orchestrator: for every covered-op case, replay the op through the
// simulator (host), normalize the delta, obtain the app-side golden (a fresh
// clone-drive capture when provided, else the banked-evidence derivation), and
// compare with declared tolerances → a per-op MATCH / TOLERATED / DIVERGENT
// verdict. Banks per-case artifacts and prints the results table.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SIMFID_CASES, type SimfidCase } from "./cases.ts";
import { compareDeltas } from "./compare.ts";
import { deriveAppGolden, loadCloneDelta } from "./evidence.ts";
import { buildIdentityMap, normalizeDelta } from "./normalize.ts";
import { replaySimCase } from "./replay.ts";
import type { AppGolden, OpVerdict, Provenance } from "./types.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

export interface CaseOutcome {
  caseId: string;
  op: string;
  family: SimfidCase["family"];
  title: string;
  provenance: Provenance;
  verdict: OpVerdict;
  simResultKind: string;
  replayError?: string;
}

export interface SimfidRunResult {
  runId: string;
  artifactsDir: string;
  outcomes: CaseOutcome[];
  counts: { match: number; tolerated: number; divergent: number; error: number };
}

export interface SimfidRunOptions {
  /** Directory of clone-captured normalized app deltas (<caseId>.json); overrides evidence. */
  appDeltasDir?: string;
  /** Only run cases whose id contains this substring. */
  filter?: string;
}

export async function runSimfid(options: SimfidRunOptions = {}): Promise<SimfidRunResult> {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const runId = `simfid-${stamp.slice(0, 8)}-${stamp.slice(8)}`;
  const artifactsDir = join(REPO_ROOT, "lab/artifacts", runId);
  mkdirSync(join(artifactsDir, "cases"), { recursive: true });

  const cases = SIMFID_CASES.filter(
    (c) => options.filter === undefined || c.id.includes(options.filter),
  );
  const outcomes: CaseOutcome[] = [];

  for (const caseDef of cases) {
    const replay = await replaySimCase(caseDef);
    const { before, after, delta } = replay.capture;
    const identity = buildIdentityMap(before, after);
    const simNorm = normalizeDelta(delta, identity);

    // App-side ground truth: a fresh clone capture wins; else banked evidence.
    const cloneDelta = loadCloneDelta(options.appDeltasDir, caseDef.id);
    let golden: AppGolden;
    if (cloneDelta !== null) {
      golden = {
        caseId: caseDef.id,
        op: caseDef.op,
        provenance: { source: "clone-drive", runId, note: "fresh guest-CLI capture" },
        delta: cloneDelta,
      };
    } else {
      golden = deriveAppGolden(caseDef, simNorm);
    }

    const verdict = compareDeltas(simNorm, golden.delta);
    outcomes.push({
      caseId: caseDef.id,
      op: caseDef.op,
      family: caseDef.family,
      title: caseDef.title,
      provenance: golden.provenance,
      verdict,
      simResultKind: replay.resultKind,
      ...(replay.error !== undefined ? { replayError: replay.error } : {}),
    });

    writeFileSync(
      join(artifactsDir, "cases", `${caseDef.id}.json`),
      JSON.stringify(
        {
          caseDef: { id: caseDef.id, op: caseDef.op, title: caseDef.title },
          simNorm,
          golden,
          verdict,
          replay: { resultKind: replay.resultKind, error: replay.error },
        },
        null,
        2,
      ),
    );
  }

  const counts = {
    match: outcomes.filter((o) => o.verdict.verdict === "MATCH").length,
    tolerated: outcomes.filter((o) => o.verdict.verdict === "TOLERATED").length,
    divergent: outcomes.filter((o) => o.verdict.verdict === "DIVERGENT").length,
    error: outcomes.filter((o) => o.replayError !== undefined).length,
  };

  const table = renderTable(outcomes);
  writeFileSync(join(artifactsDir, "results.md"), table);
  writeFileSync(
    join(artifactsDir, "summary.json"),
    JSON.stringify({ runId, counts, outcomes }, null, 2),
  );

  return { runId, artifactsDir, outcomes, counts };
}

function provTag(p: Provenance): string {
  switch (p.source) {
    case "clone-drive":
      return `clone-drive (${p.runId})`;
    case "rsim-evidence":
      return `rsim-evidence (${p.ref})`;
    case "suite-evidence":
      return `suite-evidence (${p.ref})`;
  }
}

/** Render the per-op verdict table (MATCH / TOLERATED(<which>) / DIVERGENT(<detail>)). */
export function renderTable(outcomes: CaseOutcome[]): string {
  const lines: string[] = [];
  lines.push("| Case | Op | Family | Verdict | App-side provenance |");
  lines.push("|---|---|---|---|---|");
  for (const o of outcomes) {
    const v =
      o.verdict.verdict === "TOLERATED"
        ? `TOLERATED(${o.verdict.tolerances.join(", ")})`
        : o.verdict.verdict === "DIVERGENT"
          ? o.verdict.summary
          : "MATCH";
    const err = o.replayError !== undefined ? ` ⚠️ ${o.replayError}` : "";
    lines.push(
      `| \`${o.caseId}\` | \`${o.op}\` | ${o.family} | ${v}${err} | ${provTag(o.provenance)} |`,
    );
  }
  return lines.join("\n") + "\n";
}
