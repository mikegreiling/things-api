/**
 * Aggregate runs.jsonl → scorecard (JSON + Markdown). Per arm × model × family:
 * success rate, then — on SUCCESSFUL runs only (CONSTITUTION: efficiency compared
 * across successful paired runs) — friction, tokens, static/dynamic context split,
 * turns, tool calls, wall ms. Safety violations are counted across ALL runs and never
 * averaged away.
 *
 * Runnable directly: `node bench/report.ts --out <run-dir> --tasks <dir>`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

import type { Family, RunRecord, Scorecard, ScorecardCell, TaskSpec } from "./types.ts";

type FamilyOf = (taskId: string) => Family;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Build the aggregated scorecard from raw run records. */
export function buildScorecard(
  records: RunRecord[],
  familyOf: FamilyOf,
  gitSha: string,
): Scorecard {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const family = familyOf(r.taskId);
    const key = `${r.arm}|${r.model}|${family}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(r);
    groups.set(key, bucket);
  }

  const cells: ScorecardCell[] = [];
  const promptHashes: Record<string, string> = {};
  const models = new Set<string>();

  for (const [key, runs] of groups) {
    const [arm, model, family] = key.split("|") as [ScorecardCell["arm"], string, Family];
    models.add(model);
    if (runs[0] !== undefined) promptHashes[arm] = runs[0].promptHash;

    const ok = runs.filter((r) => r.success);
    cells.push({
      arm,
      model,
      family,
      runs: runs.length,
      successes: ok.length,
      successRate: round(ok.length / runs.length),
      meanErrorsSeen: round(mean(ok.map((r) => r.errorsSeen))),
      meanTokensIn: round(mean(ok.map((r) => r.tokensIn))),
      meanTokensOut: round(mean(ok.map((r) => r.tokensOut))),
      meanStaticContextTokens: round(mean(ok.map((r) => r.staticContextTokens))),
      meanDynamicContextTokens: round(mean(ok.map((r) => r.dynamicContextTokens))),
      meanTurns: round(mean(ok.map((r) => r.turns))),
      meanToolCalls: round(mean(ok.map((r) => r.toolCalls))),
      meanWallMs: round(mean(ok.map((r) => r.wallMs))),
      safetyViolations: runs.filter((r) => r.safety === "violated").length,
    });
  }

  const sortedCells = cells.toSorted((a, b) =>
    `${a.arm}${a.model}${a.family}`.localeCompare(`${b.arm}${b.model}${b.family}`),
  );

  return {
    pins: {
      gitSha,
      promptHashes,
      models: [...models].toSorted(),
      generatedAt: new Date().toISOString(),
    },
    cells: sortedCells,
  };
}

export function renderScorecardMarkdown(sc: Scorecard): string {
  const lines: string[] = [];
  lines.push("# AGENTBENCH scorecard");
  lines.push("");
  lines.push(`- git: \`${sc.pins.gitSha}\``);
  lines.push(`- models: ${sc.pins.models.map((m) => `\`${m}\``).join(", ") || "(none)"}`);
  lines.push(
    `- prompt hashes: ${
      Object.entries(sc.pins.promptHashes)
        .map(([arm, h]) => `${arm}=\`${h}\``)
        .join(", ") || "(none)"
    }`,
  );
  lines.push(`- generated: ${sc.pins.generatedAt}`);
  lines.push("");
  const header = [
    "arm",
    "model",
    "family",
    "runs",
    "success",
    "safety✗",
    "friction",
    "tok_in",
    "tok_out",
    "static",
    "dynamic",
    "turns",
    "tools",
    "ms",
  ];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const c of sc.cells) {
    lines.push(
      `| ${[
        c.arm,
        c.model,
        c.family,
        c.runs,
        `${Math.round(c.successRate * 100)}%`,
        c.safetyViolations,
        c.meanErrorsSeen,
        c.meanTokensIn,
        c.meanTokensOut,
        c.meanStaticContextTokens,
        c.meanDynamicContextTokens,
        c.meanTurns,
        c.meanToolCalls,
        c.meanWallMs,
      ].join(" | ")} |`,
    );
  }
  lines.push("");
  lines.push("_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._");
  lines.push("");
  return lines.join("\n");
}

/** Load taskId → family from a tasks directory. */
function familyMapFromTasks(tasksDir: string): FamilyOf {
  const map = new Map<string, Family>();
  for (const file of readdirSync(tasksDir).filter((f) => f.endsWith(".json"))) {
    const task = JSON.parse(readFileSync(join(tasksDir, file), "utf8")) as TaskSpec;
    map.set(task.id, task.family);
  }
  return (taskId) => map.get(taskId) ?? ("longtail" as Family);
}

function readRuns(runsPath: string): RunRecord[] {
  return readFileSync(runsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RunRecord);
}

/** Aggregate one run directory's runs.jsonl into scorecard.json + scorecard.md. */
export function writeScorecard(
  records: RunRecord[],
  familyOf: FamilyOf,
  gitSha: string,
  outDir: string,
): Scorecard {
  const scorecard = buildScorecard(records, familyOf, gitSha);
  writeFileSync(join(outDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
  writeFileSync(join(outDir, "scorecard.md"), renderScorecardMarkdown(scorecard));
  return scorecard;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("bench-report")
    .requiredOption("--out <dir>", "run directory containing runs.jsonl")
    .option("--tasks <dir>", "tasks directory (for taskId → family)", "bench/tasks")
    .action((opts: { out: string; tasks: string }) => {
      const records = readRuns(join(opts.out, "runs.jsonl"));
      const gitSha = records[0]?.gitSha ?? "unknown";
      const sc = writeScorecard(records, familyMapFromTasks(opts.tasks), gitSha, opts.out);
      process.stdout.write(`${renderScorecardMarkdown(sc)}\n`);
    });
  await program.parseAsync(process.argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
