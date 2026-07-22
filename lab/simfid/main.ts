// SIMFID CLI (host side). Run with Node ≥ 24 (native TS execution):
//   npm run lab:simfid                          replay every covered op, compare
//                                               vs banked-evidence app goldens
//   npm run lab:simfid -- --app-deltas <dir>    compare vs a fresh clone drive's
//                                               normalized app deltas
//   npm run lab:simfid -- --filter make-repeat  only matching case ids
//   npm run lab:simfid -- --gate                exit 1 on any DIVERGENT
//
// Report-only by default (the suite REPORTS divergences — a divergence is a
// simulator bug OR newly-discovered app behaviour to triage, not a test crash).

import { Command } from "commander";

import { runSimfid } from "./run.ts";

const program = new Command();
program
  .name("simfid")
  .description(
    "simulator-fidelity replay suite: certify src/write/vectors/simulator.ts vs the real app",
  )
  .option("--app-deltas <dir>", "directory of clone-captured normalized app deltas (<caseId>.json)")
  .option("--filter <substr>", "only run cases whose id contains this substring")
  .option("--gate", "exit 1 if any op is DIVERGENT (CI/drift-runbook gate)")
  .action(async (opts: { appDeltas?: string; filter?: string; gate?: boolean }) => {
    const result = await runSimfid({
      ...(opts.appDeltas !== undefined && { appDeltasDir: opts.appDeltas }),
      ...(opts.filter !== undefined && { filter: opts.filter }),
    });

    console.log(`\nSIMFID run ${result.runId}\n`);
    console.log(renderConsole(result));
    const { match, tolerated, divergent, error } = result.counts;
    console.log(
      `\n${result.outcomes.length} cases: ${match} MATCH · ${tolerated} TOLERATED · ${divergent} DIVERGENT · ${error} replay-error`,
    );
    console.log(`artifacts: ${result.artifactsDir}`);

    if (opts.gate === true && divergent > 0) process.exitCode = 1;
  });

function renderConsole(result: Awaited<ReturnType<typeof runSimfid>>): string {
  const rows = result.outcomes.map((o) => {
    const v =
      o.verdict.verdict === "TOLERATED"
        ? `TOLERATED(${o.verdict.tolerances.join(",")})`
        : o.verdict.summary;
    const flag = o.replayError !== undefined ? " [replay-error]" : "";
    return `  ${o.caseId.padEnd(46)} ${v}${flag}`;
  });
  return rows.join("\n");
}

await program.parseAsync(process.argv);
