/**
 * Bench runner. For each selected task × rep: build a fresh synthetic fixture, fence
 * a sandbox/arm, drive one attempt (real pi-agent-core agent, or the zero-cost
 * `--pseudo` scripted executor), grade deterministically, and append a RunRecord to
 * runs.jsonl plus a transcript. Ends by writing a scorecard.
 *
 *   node bench/runner.ts --arm cli --tasks bench/tasks --split dev --pseudo
 *   node bench/runner.ts --arm cli --model <id> --provider openai --split dev --reps 3
 *
 * Real runs require the provider's API key in the environment (OPENAI_API_KEY).
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
import { buildBenchFixture } from "./fixture.ts";
import { grade } from "./grade.ts";
import { writeScorecard } from "./report.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { estimateTokens } from "./tokens.ts";
import type { Arm, Assertion, Clock, RunRecord, Split, TaskSpec } from "./types.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(BENCH_DIR, "..");
const BIN_PATH = join(REPO_ROOT, "bin", "things.js");
const SKILL_DIR = join(REPO_ROOT, "skills", "things-cli");

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
}

interface ExecOutcome {
  turns: number;
  tokensIn: number;
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
    tokensOut: 0,
    finalText,
    dynamicText: JSON.stringify(messages),
    messages,
  };
}

interface UsageEvent {
  type?: string;
  message?: { role?: string; usage?: { input?: number; output?: number } };
}

async function runAgent(
  armCtx: ArmContext,
  prompt: string,
  opts: RunnerOptions,
  maxTurns: number,
  timeoutMs: number,
): Promise<ExecOutcome> {
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const piai = await import("@earendil-works/pi-ai/compat");
  // getModel is over-narrow on provider/model id literals; the runner takes them as
  // free strings from the CLI, so widen the signature at the boundary.
  const getModel = piai.getModel as (provider: string, model: string) => unknown;

  const model = getModel(opts.provider, opts.model);
  if (model === undefined) {
    throw new Error(`unknown model ${opts.provider}/${opts.model}`);
  }

  const agent = new Agent({
    initialState: { systemPrompt: armCtx.systemPrompt, model: model as never, tools: armCtx.tools },
  });

  let turns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const unsubscribe = agent.subscribe((event) => {
    const e = event as unknown as UsageEvent;
    if (e.type === "turn_start") {
      turns++;
      if (turns > maxTurns) agent.abort();
    } else if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
      tokensIn += e.message.usage.input ?? 0;
      tokensOut += e.message.usage.output ?? 0;
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
  const records: RunRecord[] = [];

  for (const task of tasks) {
    for (let rep = 0; rep < opts.reps; rep++) {
      const record = await runOne(task, rep, opts, ctx);
      appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
      records.push(record);
      const verdict = record.success ? "PASS" : "FAIL";
      const note = record.failureNotes ? ` — ${record.failureNotes}` : "";
      process.stdout.write(
        `[${verdict}] ${task.id} rep${rep} arm=${opts.arm} safety=${record.safety} ` +
          `errors=${record.errorsSeen} tools=${record.toolCalls}${note}\n`,
      );
    }
  }

  const familyOf = (taskId: string) =>
    tasks.find((t) => t.id === taskId)?.family ?? ("longtail" as TaskSpec["family"]);
  writeScorecard(records, familyOf, ctx.gitSha, outDir);
  process.stdout.write(
    `\nwrote ${records.length} runs → ${runsPath}\nscorecard → ${join(outDir, "scorecard.md")}\n`,
  );
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
        ...(typeof raw["task"] === "string" && { task: raw["task"] }),
      };
      if (!opts.pseudo && opts.model === "") {
        process.stderr.write("real runs require --model <id> (or use --pseudo)\n");
        process.exitCode = 1;
        return;
      }
      await run(opts);
    });
  await program.parseAsync(process.argv);
}

await main();
