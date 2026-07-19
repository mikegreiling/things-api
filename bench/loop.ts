/**
 * AGENTBENCH refinement-loop driver (Phase 2). Drives the runner as a subprocess
 * (`npm run bench -- …`) and, per iteration: digests the dev failures, asks the
 * frontier refiner for the smallest generalizable patch, enforces the arm's file
 * allowlist, gates on `npm run fmt` + `npm run check`, re-benches, and accepts or
 * reverts per the CONSTITUTION metric ladder — committing each accepted patch on the
 * working branch. Stops after --max-iterations or two consecutive no-accepts, then
 * runs the holdout split once and writes checkpoint.md.
 *
 *   node bench/loop.ts --arm cli --provider openai-codex \
 *     --subject-model gpt-5.4-mini --refiner-model gpt-5.6-sol \
 *     --reps 3 --max-iterations 5 --out bench/artifacts/loop-cli-0
 *
 * The loop logic lives in `bench/loop-core.ts` (runIteration + the decision math),
 * unit-tested with a fake refiner; this file only wires the LIVE seams (git, the
 * bench subprocess, the codex refiner) and the outer loop control.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { codexLoginHint, hasCodexCredential } from "./codex-auth.ts";
import {
  appendLedger,
  appendLoopState,
  ARM_ALLOWLISTS,
  Budget,
  budgetNote,
  buildLedgerEntry,
  classifyBenchExit,
  extractLessons,
  isLedgerCandidate,
  isProviderError,
  ledgerFileName,
  LoopAbort,
  maxTotalTokensArgs,
  pairMetrics,
  parseSweepRuns,
  planEdits,
  projectBudget,
  renderCheckpoint,
  runIteration,
  splitMetrics,
  sumRunTokens,
  SweepParseError,
  TOKEN_BUDGET_DEFAULT,
  toStateEntry,
  type ApplyResult,
  type IterationDeps,
  type IterationResult,
  type LedgerEntry,
  type PairMetrics,
  type PairRuns,
  type SplitMetrics,
  type TranscriptData,
} from "./loop-core.ts";
import { CodexRefiner, type CreateOp, type EditOp } from "./refiner.ts";
import type { Arm, RunRecord, TaskSpec } from "./types.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(BENCH_DIR, "..");
const TASKS_DIR = join(BENCH_DIR, "tasks");
const STATE_PATH = join(BENCH_DIR, "loop-state.json");
const LEDGER_DIR = join(BENCH_DIR, "ledger");

interface LoopOptions {
  arm: Arm;
  provider: string;
  subjectModel: string;
  refinerModel: string;
  reps: number;
  maxIterations: number;
  worldSeed: number;
  /** Cumulative tokensIn+tokensOut ceiling across all bench + refiner calls this run. */
  tokenBudget: number;
  outDir: string;
}

// --- arm file reading ------------------------------------------------------

const ts = (): string => new Date().toISOString();
const log = (m: string): void => void process.stdout.write(`${m}\n`);

function toPosixRel(abs: string): string {
  return relative(REPO_ROOT, abs).split("\\").join("/");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** The arm's current target files → { repoRelativePosixPath: body }. */
function readArmFiles(arm: Arm): Record<string, string> {
  const abs: string[] = [];
  if (arm === "cli") {
    abs.push(
      join(REPO_ROOT, "src/cli/help.ts"),
      join(REPO_ROOT, "src/cli/excess-args.ts"),
      join(REPO_ROOT, "src/cli/did-you-mean.ts"),
      join(REPO_ROOT, "src/cli/verb-hint.ts"),
    );
    const cmdDir = join(REPO_ROOT, "src/cli/commands");
    for (const f of readdirSync(cmdDir)
      .filter((n) => n.endsWith(".ts"))
      .toSorted()) {
      abs.push(join(cmdDir, f));
    }
  } else if (arm === "skill") {
    abs.push(...walkFiles(join(REPO_ROOT, "skills/things-cli")));
  } else {
    abs.push(join(REPO_ROOT, "src/mcp/server.ts"));
  }
  const files: Record<string, string> = {};
  for (const p of abs) files[toPosixRel(p)] = readFileSync(p, "utf8");
  return files;
}

// --- git seams -------------------------------------------------------------

function git(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Validate the refiner's exact find/replace edits against the arm allowlist + current
 * files (via {@link planEdits}), then apply atomically. On success computes a REAL diff
 * (git diff, with created files intent-added so they show) for the ledger/checkpoint/
 * debrief. On any validation error, nothing is written.
 */
function applyEdits(arm: Arm, edits: EditOp[], creates: CreateOp[]): ApplyResult {
  const abs = (rel: string): string => join(REPO_ROOT, rel);
  const readFile = (rel: string): string | null =>
    existsSync(abs(rel)) ? readFileSync(abs(rel), "utf8") : null;

  const plan = planEdits(edits, creates, ARM_ALLOWLISTS[arm], readFile);
  if (!plan.ok) {
    return { ok: false, errors: plan.errors, modifiedFiles: [], createdFiles: [], diff: "" };
  }
  for (const w of plan.writes) writeFileSync(abs(w.file), w.content);

  const modifiedFiles = plan.writes.filter((w) => !w.isNew).map((w) => w.file);
  const createdFiles = plan.writes.filter((w) => w.isNew).map((w) => w.file);
  // Intent-add new files so `git diff` includes them; the accept-commit fully adds them.
  if (createdFiles.length > 0) git(["add", "-N", ...createdFiles]);
  const diff = git(["diff", "--", ...modifiedFiles, ...createdFiles]).stdout;
  return { ok: true, errors: [], modifiedFiles, createdFiles, diff };
}

function revert(modified: string[], created: string[]): void {
  if (modified.length > 0) git(["checkout", "--", ...modified]);
  if (created.length > 0) {
    git(["reset", "--", ...created]); // drop any intent-to-add
    for (const f of created) rmSync(join(REPO_ROOT, f), { force: true });
  }
}

function commit(message: string, files: string[]): void {
  const r = git(["commit", "-m", message, "--", ...files]);
  if (r.status !== 0) {
    process.stderr.write(`WARN: commit failed: ${r.stderr}\n`);
  }
}

// --- gate: npm run fmt + npm run check --------------------------------------

function runGate(): { ok: boolean; output: string } {
  const fmt = spawnSync("npm", ["run", "fmt"], { cwd: REPO_ROOT, encoding: "utf8" });
  if ((fmt.status ?? 1) !== 0) {
    return { ok: false, output: `fmt failed:\n${fmt.stdout ?? ""}${fmt.stderr ?? ""}` };
  }
  const check = spawnSync("npm", ["run", "check"], { cwd: REPO_ROOT, encoding: "utf8" });
  return {
    ok: (check.status ?? 1) === 0,
    output: `${check.stdout ?? ""}${check.stderr ?? ""}`,
  };
}

// --- bench subprocess ------------------------------------------------------

/** Read a sweep's runs from the SAME dir the runner wrote to; abort loudly if missing/empty. */
function readSweepRuns(benchDir: string): RunRecord[] {
  return parseSweepRuns(benchDir, (p) => (existsSync(p) ? readFileSync(p, "utf8") : null));
}

/**
 * Whether the runner accepts `--max-total-tokens` (added on another branch). Probed
 * once from its --help so this branch works standalone: the flag is passed only when
 * supported, otherwise omitted.
 */
let maxTotalFlagSupported: boolean | null = null;
function runnerSupportsMaxTotalTokens(): boolean {
  if (maxTotalFlagSupported !== null) return maxTotalFlagSupported;
  const r = spawnSync("npm", ["run", "bench", "--", "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  maxTotalFlagSupported = /--max-total-tokens/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  return maxTotalFlagSupported;
}

/**
 * Run the runner for one split into `benchDir`; parse runs.jsonl. Output is captured
 * (then echoed) so provider failures (429/quota/5xx) in the subprocess can be detected
 * and surfaced as a {@link ProviderError} for the loop's circuit breaker. `extraArgs`
 * carries the optional `--max-total-tokens` budget cap.
 */
function benchSplit(
  opts: LoopOptions,
  split: string,
  benchDir: string,
  extraArgs: string[],
): RunRecord[] {
  mkdirSync(benchDir, { recursive: true });
  const r = spawnSync(
    "npm",
    [
      "run",
      "bench",
      "--",
      "--arm",
      opts.arm,
      "--model",
      opts.subjectModel,
      "--provider",
      opts.provider,
      "--split",
      split,
      "--reps",
      String(opts.reps),
      "--world-seed",
      String(opts.worldSeed),
      "--out",
      benchDir,
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  // A runner exit 8 (its --max-total-tokens cap, sized to the loop's remaining budget)
  // surfaces here as a clean token-budget LoopAbort — not a crash — so the loop finalizes;
  // a provider-error exit becomes a ProviderError (circuit breaker); other nonzero exits
  // are hard errors.
  classifyBenchExit(split, { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  // Parse from EXACTLY the dir the runner wrote to (benchDir === --out); a missing or
  // empty runs.jsonl aborts loudly rather than defaulting metrics to zeros.
  return readSweepRuns(benchDir);
}

function loadTranscript(record: RunRecord): TranscriptData | null {
  try {
    // runId is the bench out dir (absolute); transcript is relative to it.
    const base = isAbsolute(record.runId) ? record.runId : join(REPO_ROOT, record.runId);
    return JSON.parse(readFileSync(join(base, record.transcript), "utf8")) as TranscriptData;
  } catch {
    return null;
  }
}

function loadTasks(): Map<string, TaskSpec> {
  const map = new Map<string, TaskSpec>();
  for (const f of readdirSync(TASKS_DIR).filter((n) => n.endsWith(".json"))) {
    const task = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf8")) as TaskSpec;
    map.set(task.id, task);
  }
  return map;
}

// --- outer loop ------------------------------------------------------------

async function runLoop(opts: LoopOptions): Promise<void> {
  const tasks = loadTasks();
  const budget = new Budget(opts.tokenBudget);
  const ledgerPath = join(LEDGER_DIR, ledgerFileName(opts.arm));
  const ledgerRel = relative(REPO_ROOT, ledgerPath).split("\\").join("/");
  // Stable per-invocation batch id → re-running the same --out dedups ledger appends.
  const batchId = basename(opts.outDir);
  // Feed-forward: seed the charter with THIS arm's prior lessons only (README rule).
  const priorLessons = existsSync(ledgerPath)
    ? extractLessons(readFileSync(ledgerPath, "utf8"))
    : [];
  let benchRound = 0;

  const onBudgetWarning = (): void => {
    const pct = Math.round(budget.fraction() * 100);
    process.stderr.write(
      `\n${"!".repeat(70)}\n!! TOKEN BUDGET WARNING: ${pct}% used ` +
        `(${budget.usedTokens} / ${budget.limit} tokens)\n${"!".repeat(70)}\n\n`,
    );
    appendLoopState(
      STATE_PATH,
      budgetNote(opts.arm, "budget-warning", `reached ${pct}% of token budget`, budget, ts()),
    );
  };

  /** One bench sweep of a single split: budget-gate → run → account tokens → warn. */
  const sweep = (split: string, dir: string): RunRecord[] => {
    budget.assertUnderBudget(`bench sweep (${split})`);
    const extra = maxTotalTokensArgs(runnerSupportsMaxTotalTokens(), budget.remaining());
    let runs: RunRecord[];
    try {
      runs = benchSplit(opts, split, dir, extra);
      budget.resetProviderErrors();
    } catch (e) {
      if (isProviderError(e)) {
        budget.recordProviderError(); // throws LoopAbort(rate-limit) on the Nth consecutive
      }
      throw e;
    }
    budget.add(sumRunTokens(runs));
    if (budget.crossedWarnThreshold()) onBudgetWarning();
    return runs;
  };

  const benchSplits = (): PairRuns => {
    benchRound++;
    const dir = join(opts.outDir, "bench", String(benchRound));
    return {
      dev: sweep("dev", join(dir, "dev")),
      validation: sweep("validation", join(dir, "validation")),
    };
  };

  const deps: IterationDeps = {
    refiner: new CodexRefiner({ model: opts.refinerModel, provider: opts.provider }),
    readArmFiles: () => readArmFiles(opts.arm),
    loadTranscript,
    applyEdits: (edits, creates) => applyEdits(opts.arm, edits, creates),
    runGate,
    benchSplits,
    revert,
    commit,
    stashPatch: (name, content) => {
      const p = join(opts.outDir, name);
      writeFileSync(p, content.endsWith("\n") ? content : `${content}\n`);
      return p;
    },
    onBudgetWarning,
    log,
  };

  const results: IterationResult[] = [];
  const needsMikePatches: string[] = [];
  let baseline: PairMetrics = pairMetrics({ dev: [], validation: [] });
  let prevMetrics = baseline;
  let stopReason = "max-iterations";

  const finalize = (holdout: SplitMetrics | null, reason: string, holdoutNote?: string): void => {
    const checkpoint = renderCheckpoint({
      arm: opts.arm,
      subjectModel: opts.subjectModel,
      refinerModel: opts.refinerModel,
      reps: opts.reps,
      results,
      baselineMetrics: baseline,
      finalMetrics: prevMetrics,
      holdout,
      needsMikePatches,
      stopReason: reason,
      ...(holdoutNote !== undefined && { holdoutNote }),
    });
    const checkpointPath = join(opts.outDir, "checkpoint.md");
    writeFileSync(checkpointPath, checkpoint);
    log(`\nwrote ${checkpointPath}`);

    // Append this batch's candidates to THIS arm's ledger and commit it so the ledger
    // rides the arm's PR (idempotent: a re-run with the same --out re-appends nothing).
    const artifacts = `loop-state: ${relative(REPO_ROOT, STATE_PATH).split("\\").join("/")} (batch ${batchId}); checkpoint: ${relative(REPO_ROOT, checkpointPath).split("\\").join("/")}`;
    const entries: LedgerEntry[] = results
      .filter(isLedgerCandidate)
      .map((r) =>
        buildLedgerEntry(r, { batchId, date: ts().slice(0, 10), artifactsPointer: artifacts }),
      );
    const appended = appendLedger(ledgerPath, opts.arm, entries);
    if (appended > 0) {
      commit(`loop(${opts.arm}) ledger: +${appended} candidate(s) [batch ${batchId}]`, [ledgerRel]);
      log(`appended ${appended} ledger entr${appended === 1 ? "y" : "ies"} → ${ledgerRel}`);
    }
  };

  try {
    log(
      `baseline bench (dev + validation), arm=${opts.arm}, ` +
        `allowlist=${ARM_ALLOWLISTS[opts.arm].join(", ")}, budget=${budget.limit} tokens`,
    );
    let prevRuns = benchSplits();
    prevMetrics = pairMetrics(prevRuns);
    baseline = prevMetrics;

    // Startup cost projection — now that the baseline sweep gives an observed per-run
    // median, price every planned iteration at it and WARN LOUDLY when the token budget
    // looks undersized. We never change the default budget silently, only advise.
    const projection = projectBudget(
      [...prevRuns.dev, ...prevRuns.validation],
      budget.limit,
      opts.maxIterations,
    );
    log(projection.line);
    if (projection.warning !== null) {
      process.stderr.write(`\n${"!".repeat(70)}\n!! ${projection.warning}\n${"!".repeat(70)}\n\n`);
    }

    let consecutiveNoAccept = 0;
    for (let iter = 1; iter <= opts.maxIterations; iter++) {
      log(`\n=== iteration ${iter}/${opts.maxIterations} ===`);
      const result = await runIteration(deps, {
        arm: opts.arm,
        iteration: iter,
        prevMetrics,
        prevRuns,
        tasks,
        budget,
        priorLessons,
      });
      results.push(result);
      appendLoopState(STATE_PATH, toStateEntry(result, ts()));
      if (result.needsMikePatchPath !== undefined) {
        needsMikePatches.push(result.needsMikePatchPath);
      }

      if (result.accepted && result.metricsAfter !== null && result.afterRuns !== null) {
        prevMetrics = result.metricsAfter;
        prevRuns = result.afterRuns;
        consecutiveNoAccept = 0;
      } else {
        consecutiveNoAccept++;
        if (consecutiveNoAccept >= 2) {
          stopReason = "2 consecutive no-accepts";
          break;
        }
      }
    }

    log(`\nholdout bench (final state, run once)`);
    const holdout = splitMetrics(sweep("holdout", join(opts.outDir, "bench", "holdout")));
    finalize(holdout, stopReason);
  } catch (e) {
    if (e instanceof LoopAbort) {
      process.stderr.write(`\nCLEAN ABORT (${e.kind}): ${e.message}\n`);
      appendLoopState(STATE_PATH, budgetNote(opts.arm, "abort", e.message, budget, ts()));
      finalize(null, `ABORTED (${e.kind}): ${e.message}`, `${e.kind} abort — holdout not run`);
      process.stderr.write(
        `\nTo resume: re-run the same command. Accepted patches are already committed; ` +
          `loop-state.json retains this run's history and the next invocation re-baselines ` +
          `from the current tree.\n`,
      );
      process.exitCode = e.code;
      return;
    }
    throw e;
  }
}

// --- CLI -------------------------------------------------------------------

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("bench-loop")
    .description("AGENTBENCH refinement loop — digest → refiner → gate → accept/revert")
    .requiredOption("--arm <arm>", "cli | skill | mcp")
    .option("--provider <name>", "provider", "openai-codex")
    .requiredOption("--subject-model <id>", "subject model id (benched)")
    .requiredOption("--refiner-model <id>", "refiner model id (proposes patches)")
    .option("--reps <n>", "repetitions per task", "3")
    .option("--max-iterations <n>", "max refinement iterations", "5")
    .option("--world-seed <n>", "evergreen world profile PRNG seed", "1")
    .option(
      "--token-budget <n>",
      "cumulative tokensIn+tokensOut ceiling (bench + refiner) before a clean abort",
      String(TOKEN_BUDGET_DEFAULT),
    )
    .requiredOption("--out <dir>", "output directory")
    .action(async (raw: Record<string, string>) => {
      const arm = raw["arm"] as Arm;
      if (!["cli", "skill", "mcp"].includes(arm)) {
        process.stderr.write(`invalid --arm "${arm}" (cli | skill | mcp)\n`);
        process.exitCode = 1;
        return;
      }
      const provider = raw["provider"] as string;
      if (provider === "openai-codex" && !(await hasCodexCredential())) {
        process.stderr.write(codexLoginHint());
        process.exitCode = 1;
        return;
      }
      const outDir = isAbsolute(raw["out"] as string)
        ? (raw["out"] as string)
        : resolve(process.cwd(), raw["out"] as string);
      mkdirSync(outDir, { recursive: true });

      const opts: LoopOptions = {
        arm,
        provider,
        subjectModel: raw["subjectModel"] as string,
        refinerModel: raw["refinerModel"] as string,
        reps: Math.max(1, Number(raw["reps"])),
        maxIterations: Math.max(1, Number(raw["maxIterations"])),
        worldSeed: Math.max(0, Number(raw["worldSeed"]) || 1),
        tokenBudget: Math.max(1, Number(raw["tokenBudget"]) || TOKEN_BUDGET_DEFAULT),
        outDir,
      };

      // Guard: never let the loop run against a dirty tree — reverts/commits assume a
      // clean baseline for the arm's files.
      const dirty = execFileSync("git", ["status", "--porcelain", "--", ...ARM_ALLOWLISTS[arm]], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
      if (dirty !== "") {
        process.stderr.write(`refusing to run — arm files have uncommitted changes:\n${dirty}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        await runLoop(opts);
      } catch (e) {
        // A lost/empty bench sweep is a hard stop: report loudly, never proceed on
        // zeroed metrics (which would silently vacate the validation gate).
        if (e instanceof SweepParseError) {
          process.stderr.write(`\nABORT — ${e.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    });
  await program.parseAsync(process.argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
