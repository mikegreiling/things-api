// Lab runner CLI (host side). Run with Node ≥ 24 (native TS execution):
//   npm run lab:run                          full clone→probe→collect→teardown
//   npm run lab:run -- --keep-vm             leave the VM for debugging
//   npm run lab:compare -- <runA> <runB>     acceptance gate: identical verdicts
//   npm run lab:gc                           delete stray things-run-* VMs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

import { compareVerdicts } from "./evaluate.ts";
import { executeRun } from "./run.ts";
import { gcRunVms } from "./tart.ts";
import type { VerdictsFile } from "./types.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const program = new Command();

program.name("lab-runner").description("things-lab probe harness (Tart VM orchestration)");

program
  .command("run")
  .description("execute a probe suite against a fresh clone of the golden image")
  .option("--suite <path>", "suite JSON", join(REPO_ROOT, "lab/suites/u-suite.json"))
  .option("--keep-vm", "skip teardown, leave the VM running")
  .option("--skip-gc", "do not delete stray run VMs during preflight")
  .action(async (opts: { suite: string; keepVm?: boolean; skipGc?: boolean }) => {
    const outcome = await executeRun({
      suitePath: opts.suite,
      ...(opts.keepVm !== undefined && { keepVm: opts.keepVm }),
      ...(opts.skipGc !== undefined && { skipGc: opts.skipGc }),
    });
    process.exitCode = outcome.exitCode;
  });

program
  .command("compare")
  .description("compare two runs' verdicts.json — exit 0 only if identical")
  .argument("<runA>", "run id or path to verdicts.json")
  .argument("<runB>", "run id or path to verdicts.json")
  .action((runA: string, runB: string) => {
    const load = (ref: string): VerdictsFile => {
      const path = ref.endsWith(".json")
        ? ref
        : join(REPO_ROOT, "lab/artifacts", ref, "verdicts.json");
      return JSON.parse(readFileSync(path, "utf8")) as VerdictsFile;
    };
    const result = compareVerdicts(load(runA), load(runB));
    if (result.identical) {
      console.log(`identical verdicts across both runs (${Object.keys(load(runA)).length} probes)`);
    } else {
      console.log("verdict drift between runs:");
      for (const d of result.diffs) console.log(`  · ${d}`);
      process.exitCode = 1;
    }
  });

program
  .command("gc")
  .description("stop + delete stray things-run-* VMs")
  .action(() => {
    const removed = gcRunVms();
    console.log(removed.length > 0 ? `removed: ${removed.join(", ")}` : "no stray run VMs");
  });

await program.parseAsync(process.argv);
