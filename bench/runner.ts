/**
 * Bench runner. For each selected task × rep: build a fresh synthetic fixture, fence
 * a sandbox/arm, drive one attempt (real pi-agent-core agent, or the zero-cost
 * `--pseudo` scripted executor), grade deterministically, and append a RunRecord to
 * runs.jsonl plus a transcript. Ends by writing a scorecard.
 *
 *   node bench/runner.ts --arm cli --tasks bench/tasks --split dev --pseudo
 *   node bench/runner.ts --arm cli --model <id> --provider openai --split dev --reps 3
 *   node bench/runner.ts --arm cli --model <id> --provider openai-codex --split dev
 *
 * Real runs authenticate one of two ways: `--provider openai` reads
 * `OPENAI_API_KEY` from the environment; `--provider openai-codex` uses a
 * ChatGPT-subscription OAuth credential stored by `npm run bench:login` at
 * `~/.config/things-api-bench/auth.json` (never in the repo).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import {
  buildCliArm,
  buildMcpArm,
  buildSkillArm,
  newCollector,
  type ArmContext,
  type Collector,
} from "./arms.ts";
import { EXIT_TOKEN_BUDGET, executeSweep, type SweepUnit } from "./budget.ts";
import { buildCodexAgentAuth, codexLoginHint, hasCodexCredential } from "./codex-auth.ts";
import { buildBenchFixture } from "./fixture.ts";
import { grade } from "./grade.ts";
import { writeScorecard } from "./report.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { estimateTokens } from "./tokens.ts";
import type { Arm, Assertion, Clock, RunRecord, Split, TaskSpec } from "./types.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(BENCH_DIR, "..");
const BIN_PATH = join(REPO_ROOT, "bin", "things.js");
// Skill content mount. Defaults to the in-tree skill; BENCH_SKILL_DIR overrides
// it so a paired A/B sweep can point the skill arm at an alternate skill build
// (e.g. a prior version materialized into a temp dir) without editing the tree.
const SKILL_DIR = process.env["BENCH_SKILL_DIR"] ?? join(REPO_ROOT, "skills", "things-cli");

interface RunnerOptions {
  arm: Arm;
  model: string;
  provider: string;
  tasks: string;
  split: Split | "all";
  reps: number;
  task?: string;
  pseudo: boolean;
  out: string;
  /** Evergreen world profile: PRNG seed (bench/world.ts). */
  worldSeed: number;
  /** Debugging escape hatch: run against bare task seeds only. */
  noWorld: boolean;
  /**
   * Sweep-wide cap on total tokens (tokensIn + tokensOut, accumulated across
   * completed runs). 0 = unlimited. Once exceeded, no further runs launch; the
   * remainder are recorded as skipped and the process exits {@link EXIT_TOKEN_BUDGET}.
   */
  maxTotalTokens: number;
}

interface ExecOutcome {
  turns: number;
  /** TOTAL input tokens (incl. cache reads/writes) — see RunRecord.tokensIn. */
  tokensIn: number;
  /** Cache-read portion of tokensIn (provider usage.cacheRead). */
  tokensInCached: number;
  tokensOut: number;
  finalText: string | null;
  dynamicText: string;
  messages: unknown[];
}

// --- small helpers ---------------------------------------------------------

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function promptHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12);
}

function loadTasks(dir: string, split: Split | "all", taskId?: string): TaskSpec[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskSpec)
    .filter((t) => split === "all" || t.split === split)
    .filter((t) => taskId === undefined || t.id === taskId)
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

function loadSkill(): { files: Record<string, string>; bytes: string } {
  const files: Record<string, string> = {};
  const skillMd = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  files["/skill/SKILL.md"] = skillMd;
  let bytes = skillMd;
  const refDir = join(SKILL_DIR, "references");
  for (const f of readdirSync(refDir)
    .filter((n) => n.endsWith(".md"))
    .toSorted()) {
    const content = readFileSync(join(refDir, f), "utf8");
    files[`/skill/references/${f}`] = content;
    bytes += `\n${content}`;
  }
  return { files, bytes };
}

interface Scratch {
  root: string;
  config: string;
  state: string;
}

function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "bench-scratch-"));
  const config = join(root, "config");
  const state = join(root, "state");
  mkdirSync(config);
  mkdirSync(state);
  return { root, config, state };
}

function buildFenceEnv(dbPath: string, clock: Clock, scratch: Scratch): Record<string, string> {
  const env: Record<string, string> = {
    THINGS_DB: dbPath,
    THINGS_SIM_WRITES: "1",
    THINGS_NOW: clock.now,
    THINGS_TZ: clock.tz,
    THINGS_WIDTH: "100",
    // The REAL config/state override names are THINGS_API_* (src/paths.ts).
    // An earlier revision used THINGS_CONFIG_DIR/THINGS_STATE_DIR, which the
    // CLI ignores — bench audit records then landed in the operator's real
    // audit trail (2026-07-17 incident). The simulator fence now REQUIRES
    // these two to be set, so a regression here fails the run loudly.
    THINGS_API_CONFIG_DIR: scratch.config,
    THINGS_API_STATE_DIR: scratch.state,
    NO_COLOR: "1",
  };
  const path = process.env["PATH"];
  if (path !== undefined) env["PATH"] = path;
  return env;
}

// --- final-answer synthesis for pseudo mode --------------------------------

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1] as string] = value;
}

/** Build an answer object that satisfies a task's answer assertions (pseudo mode). */
function synthesizeAnswer(assertions: Assertion[]): unknown | null {
  const answerAsserts = assertions.filter(
    (a) => a.type === "answer" || a.type === "answer-includes",
  );
  if (answerAsserts.length === 0) return null;
  const obj: Record<string, unknown> = {};
  for (const a of answerAsserts) {
    if (a.type === "answer") setPath(obj, a.path, a.equals);
    else if (a.type === "answer-includes") setPath(obj, a.path, a.values);
  }
  return obj;
}

function codeFence(answer: unknown): string {
  const fence = "```";
  return `${fence}json\n${JSON.stringify(answer, null, 2)}\n${fence}`;
}

// --- message helpers -------------------------------------------------------

interface MinMessage {
  role?: string;
  content?: unknown;
}

interface MinTextBlock {
  type?: string;
  text?: string;
}

function lastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as MinMessage;
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = (m.content as MinTextBlock[])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (text !== "") return text;
    }
  }
  return null;
}

// --- executors -------------------------------------------------------------

async function runPseudo(
  task: TaskSpec,
  prompt: string,
  sandbox: Sandbox,
  collector: Collector,
): Promise<ExecOutcome> {
  for (const cmd of task.pseudoScript ?? []) {
    collector.toolCalls++;
    const r = await sandbox.exec(cmd);
    if (r.exitCode !== 0) collector.errorsSeen++;
  }
  const answer = synthesizeAnswer(task.assertions);
  const finalText = answer !== null ? codeFence(answer) : null;
  const messages: unknown[] = [{ role: "user", content: prompt }];
  if (finalText !== null) {
    messages.push({ role: "assistant", content: [{ type: "text", text: finalText }] });
  }
  return {
    turns: 1,
    tokensIn: 0,
    tokensInCached: 0,
    tokensOut: 0,
    finalText,
    dynamicText: JSON.stringify(messages),
    messages,
  };
}

/**
 * Assistant-message usage as pi-ai reports it (`@earendil-works/pi-ai` `Usage`).
 * CRITICAL: `input` is the cache-DISCOUNTED input — the codex/openai Responses
 * backend subtracts `cached_tokens` and `cache_write_tokens` from `input_tokens`
 * before reporting `usage.input` (pi-ai `api/openai-responses-shared.js`). The true
 * total input is `input + cacheRead + cacheWrite`; the split is genuinely reported,
 * so no estimate is needed. `totalTokens` is the raw provider total (input+output).
 */
interface UsageEvent {
  type?: string;
  message?: {
    role?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
}

async function runAgent(
  armCtx: ArmContext,
  prompt: string,
  opts: RunnerOptions,
  maxTurns: number,
  timeoutMs: number,
): Promise<ExecOutcome> {
  const { Agent } = await import("@earendil-works/pi-agent-core");

  // Auth resolves one of two ways: the env-key providers (openai) resolve their
  // key from the environment via the default streamSimple; openai-codex resolves
  // a ChatGPT-subscription OAuth token per turn through the agent's getApiKey hook
  // (the codex Responses backend needs only that token — it derives the account
  // id from the JWT and the base URL from model metadata, so no custom streamFn).
  let model: unknown;
  let getApiKey: ((provider: string) => Promise<string | undefined>) | undefined;
  if (opts.provider === "openai-codex") {
    const codex = await buildCodexAgentAuth(opts.model);
    model = codex.model;
    getApiKey = codex.getApiKey;
  } else {
    const piai = await import("@earendil-works/pi-ai/compat");
    // getModel is over-narrow on provider/model id literals; the runner takes them as
    // free strings from the CLI, so widen the signature at the boundary.
    const getModel = piai.getModel as (provider: string, model: string) => unknown;
    model = getModel(opts.provider, opts.model);
    if (model === undefined) {
      throw new Error(`unknown model ${opts.provider}/${opts.model}`);
    }
  }

  const agent = new Agent({
    initialState: { systemPrompt: armCtx.systemPrompt, model: model as never, tools: armCtx.tools },
    ...(getApiKey !== undefined && { getApiKey }),
  });

  let turns = 0;
  let tokensIn = 0;
  let tokensInCached = 0;
  let tokensOut = 0;
  const unsubscribe = agent.subscribe((event) => {
    const e = event as unknown as UsageEvent;
    if (e.type === "turn_start") {
      turns++;
      if (turns > maxTurns) agent.abort();
    } else if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
      const u = e.message.usage;
      const cacheRead = u.cacheRead ?? 0;
      // usage.input is cache-DISCOUNTED; re-add cache reads + writes for the honest total.
      tokensIn += (u.input ?? 0) + cacheRead + (u.cacheWrite ?? 0);
      tokensInCached += cacheRead;
      tokensOut += u.output ?? 0;
    }
  });

  const timer = setTimeout(() => agent.abort(), timeoutMs);
  try {
    await agent.prompt(prompt);
  } catch {
    // Aborts (turn cap / timeout) surface as rejections; the partial transcript stands.
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  const messages = agent.state.messages as unknown[];
  return {
    turns,
    tokensIn,
    tokensInCached,
    tokensOut,
    finalText: lastAssistantText(messages),
    dynamicText: JSON.stringify(messages),
    messages,
  };
}

// --- main loop -------------------------------------------------------------

/**
 * Zero-dispatch fence preflight (2026-07-17 incident): before ANY task runs
 * against this fixture+env, prove the child CLI actually wires the simulator.
 * A `--dry-run` write returns its compiled invocation WITHOUT executing; under
 * the fence that is the literal `simulated:<op>` marker — anything else (a
 * real `things:///…` payload, a nonzero exit from a broken fence) means real
 * transports could reach the operator's app, and the run must abort.
 */
function assertFenceFunctional(fenceEnv: Record<string, string>): void {
  const res = spawnSync(
    process.execPath,
    [BIN_PATH, "todo", "add", "__fence_preflight__", "--dry-run", "--json"],
    { env: fenceEnv, encoding: "utf8", timeout: 30_000 },
  );
  let invocation = "";
  try {
    const env = JSON.parse(res.stdout) as { data?: { invocation?: string } };
    invocation = env.data?.invocation ?? "";
  } catch {
    // fall through to the error below with whatever we captured
  }
  if (res.status !== 0 || !invocation.startsWith("simulated:")) {
    throw new Error(
      `fence preflight FAILED — refusing to run any task. dry-run exit=${res.status}, ` +
        `invocation=${JSON.stringify(invocation)} (expected "simulated:todo.add"). ` +
        `stderr: ${res.stderr.slice(0, 500)}`,
    );
  }
}

async function runOne(
  task: TaskSpec,
  rep: number,
  opts: RunnerOptions,
  ctx: { gitSha: string; skill: { files: Record<string, string>; bytes: string }; outDir: string },
): Promise<RunRecord> {
  const scratch = makeScratch();
  const tasksDir = isAbsolute(opts.tasks) ? opts.tasks : resolve(process.cwd(), opts.tasks);
  const fixture = buildBenchFixture(
    task.seed,
    opts.noWorld ? undefined : { seed: opts.worldSeed, clock: task.clock, tasksDir },
  );
  const fenceEnv = buildFenceEnv(fixture.path, task.clock, scratch);
  assertFenceFunctional(fenceEnv);
  const collector = newCollector();
  const prompt = task.prompt;

  let armCtx: ArmContext;
  let sandbox: Sandbox | undefined;
  const useSandbox = opts.pseudo || opts.arm !== "mcp";
  if (useSandbox) {
    const files = opts.arm === "skill" ? ctx.skill.files : undefined;
    sandbox = createSandbox({ fenceEnv, binPath: BIN_PATH, ...(files !== undefined && { files }) });
    armCtx =
      opts.arm === "skill"
        ? buildSkillArm(sandbox, collector, ctx.skill.bytes)
        : buildCliArm(sandbox, collector);
  } else {
    armCtx = await buildMcpArm({ fenceEnv, binPath: BIN_PATH }, collector);
  }

  const maxTurns = task.maxTurns ?? 30;
  const timeoutMs = task.timeoutMs ?? 120_000;

  const start = performance.now();
  let outcome: ExecOutcome;
  try {
    outcome = opts.pseudo
      ? await runPseudo(task, prompt, sandbox as Sandbox, collector)
      : await runAgent(armCtx, prompt, opts, maxTurns, timeoutMs);
  } finally {
    if (armCtx.dispose) await armCtx.dispose();
  }
  const wallMs = Math.round(performance.now() - start);

  const gradeResult = grade({
    task,
    fixturePath: fixture.path,
    snapshotHash: fixture.snapshotHash,
    finalAnswerText: outcome.finalText,
  });

  const model = opts.pseudo ? "pseudo" : opts.model;
  const transcriptRel = join("transcripts", `${task.id}__p-null__r${rep}.json`);
  writeFileSync(
    join(ctx.outDir, transcriptRel),
    `${JSON.stringify(
      {
        taskId: task.id,
        family: task.family,
        arm: opts.arm,
        model,
        provider: opts.provider,
        prompt,
        systemPrompt: armCtx.systemPrompt,
        grade: gradeResult,
        metrics: {
          turns: outcome.turns,
          toolCalls: collector.toolCalls,
          errorsSeen: collector.errorsSeen,
          tokensIn: outcome.tokensIn,
          tokensInCached: outcome.tokensInCached,
          tokensOut: outcome.tokensOut,
          wallMs,
        },
        messages: outcome.messages,
      },
      null,
      2,
    )}\n`,
  );

  fixture.cleanup();
  rmSync(scratch.root, { recursive: true, force: true });

  const record: RunRecord = {
    runId: ctx.outDir,
    taskId: task.id,
    paraphrase: null,
    rep,
    arm: opts.arm,
    model,
    provider: opts.provider,
    promptHash: promptHash(armCtx.systemPrompt),
    gitSha: ctx.gitSha,
    success: gradeResult.success,
    safety: gradeResult.safety,
    errorsSeen: collector.errorsSeen,
    turns: outcome.turns,
    toolCalls: collector.toolCalls,
    tokensIn: outcome.tokensIn,
    tokensInCached: outcome.tokensInCached,
    tokensOut: outcome.tokensOut,
    staticContextTokens: estimateTokens(armCtx.staticText),
    dynamicContextTokens: estimateTokens(outcome.dynamicText),
    wallMs,
    worldSeed: opts.noWorld ? null : opts.worldSeed,
    transcript: transcriptRel,
    ...(gradeResult.failureNotes !== undefined && { failureNotes: gradeResult.failureNotes }),
  };
  return record;
}

/**
 * A placeholder record for a run the budget cap skipped before it ran. Marked
 * `skipped` so reporting never scores it as a failure; all metrics are zero.
 */
function skippedRecord(
  task: TaskSpec,
  rep: number,
  opts: RunnerOptions,
  ctx: { gitSha: string; outDir: string },
): RunRecord {
  return {
    runId: ctx.outDir,
    taskId: task.id,
    paraphrase: null,
    rep,
    arm: opts.arm,
    model: opts.pseudo ? "pseudo" : opts.model,
    provider: opts.provider,
    promptHash: "",
    gitSha: ctx.gitSha,
    success: false,
    safety: "ok",
    errorsSeen: 0,
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensInCached: 0,
    tokensOut: 0,
    staticContextTokens: 0,
    dynamicContextTokens: 0,
    wallMs: 0,
    worldSeed: opts.noWorld ? null : opts.worldSeed,
    transcript: "",
    skipped: "token-budget",
  };
}

async function run(opts: RunnerOptions): Promise<void> {
  const tasksDir = isAbsolute(opts.tasks) ? opts.tasks : resolve(process.cwd(), opts.tasks);
  const tasks = loadTasks(tasksDir, opts.split, opts.task);
  if (tasks.length === 0) {
    process.stderr.write(`no tasks matched (dir=${tasksDir}, split=${opts.split})\n`);
    process.exitCode = 1;
    return;
  }

  const outDir = isAbsolute(opts.out) ? opts.out : resolve(process.cwd(), opts.out);
  mkdirSync(join(outDir, "transcripts"), { recursive: true });
  const runsPath = join(outDir, "runs.jsonl");
  writeFileSync(runsPath, "");

  const ctx = { gitSha: gitSha(), skill: loadSkill(), outDir };
  const totalSelected = tasks.length * opts.reps;
  const units: SweepUnit[] = [];
  for (const task of tasks) {
    for (let rep = 0; rep < opts.reps; rep++) units.push({ task, rep });
  }

  const onRecord = (record: RunRecord, skipped: boolean): void => {
    appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
    if (skipped) {
      process.stdout.write(
        `[SKIP] ${record.taskId} rep${record.rep} arm=${opts.arm} — token budget spent\n`,
      );
      return;
    }
    const verdict = record.success ? "PASS" : "FAIL";
    const note = record.failureNotes ? ` — ${record.failureNotes}` : "";
    process.stdout.write(
      `[${verdict}] ${record.taskId} rep${record.rep} arm=${opts.arm} safety=${record.safety} ` +
        `errors=${record.errorsSeen} tools=${record.toolCalls}${note}\n`,
    );
  };

  const { records, skipped, spentTokens } = await executeSweep(
    units,
    opts.maxTotalTokens,
    (task, rep) => runOne(task, rep, opts, ctx),
    (task, rep) => skippedRecord(task, rep, opts, ctx),
    onRecord,
  );

  const familyOf = (taskId: string) =>
    tasks.find((t) => t.id === taskId)?.family ?? ("longtail" as TaskSpec["family"]);
  writeScorecard(records, familyOf, ctx.gitSha, outDir);
  process.stdout.write(
    `\nwrote ${records.length} runs → ${runsPath}\nscorecard → ${join(outDir, "scorecard.md")}\n`,
  );
  if (skipped.length > 0) {
    process.stderr.write(
      `\ntoken budget exceeded: spent ${spentTokens} tokens (cap ${opts.maxTotalTokens}); ` +
        `${records.length} runs completed, ${skipped.length} of ${totalSelected} skipped.\n`,
    );
    process.exitCode = EXIT_TOKEN_BUDGET;
  }
}

async function main(): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const program = new Command();
  program
    .name("bench-runner")
    .description("AGENTBENCH runner — seed → sandbox → agent → grade → report")
    .option("--arm <arm>", "cli | skill | mcp", "cli")
    .option("--model <id>", "model id (real runs)", "")
    .option("--provider <name>", "provider", "openai")
    .option("--tasks <dir>", "tasks directory", join(BENCH_DIR, "tasks"))
    .option("--split <split>", "dev | validation | holdout | all", "dev")
    .option("--reps <n>", "repetitions per task", "1")
    .option("--task <id>", "run a single task by id")
    .option("--pseudo", "scripted zero-cost executor (no LLM, no API key)", false)
    .option("--world-seed <n>", "evergreen world profile PRNG seed", "1")
    .option("--no-world", "bare task seeds only (debugging escape hatch)")
    .option(
      "--max-total-tokens <n>",
      "stop the sweep once total tokens (in+out) exceed n; 0 = unlimited",
      "0",
    )
    .option("--out <dir>", "output directory", join(BENCH_DIR, "artifacts", runId))
    .action(async (raw: Record<string, string | boolean>) => {
      const opts: RunnerOptions = {
        arm: raw["arm"] as Arm,
        model: raw["model"] as string,
        provider: raw["provider"] as string,
        tasks: raw["tasks"] as string,
        split: raw["split"] as Split | "all",
        reps: Math.max(1, Number(raw["reps"])),
        pseudo: raw["pseudo"] === true,
        out: raw["out"] as string,
        worldSeed: Math.max(0, Number(raw["worldSeed"]) || 1),
        noWorld: raw["world"] === false,
        maxTotalTokens: Math.max(0, Number(raw["maxTotalTokens"]) || 0),
        ...(typeof raw["task"] === "string" && { task: raw["task"] }),
      };
      if (!opts.pseudo && opts.model === "") {
        process.stderr.write("real runs require --model <id> (or use --pseudo)\n");
        process.exitCode = 1;
        return;
      }
      if (!opts.pseudo && opts.provider === "openai-codex" && !(await hasCodexCredential())) {
        process.stderr.write(codexLoginHint());
        process.exitCode = 1;
        return;
      }
      await run(opts);
    });
  await program.parseAsync(process.argv);
}

await main();
