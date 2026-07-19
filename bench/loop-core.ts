/**
 * Pure/injectable core of the AGENTBENCH refinement loop (side-effect-free on import;
 * the CLI driver lives in `bench/loop.ts`). Everything the loop needs to REASON is
 * here — arm allowlists, patch parsing, the accept/revert decision math (CONSTITUTION
 * metric ladder), the failure digest, the surface-improvement charter, state-file
 * append, and the checkpoint renderer — plus `runIteration`, one loop turn driven
 * entirely through an injected {@link IterationDeps} seam so it is unit-testable with
 * fakes (no git, no subprocess bench, no live model).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Classification,
  Confidence,
  CreateOp,
  EditOp,
  Refiner,
  RefinerOutput,
} from "./refiner.ts";
import { estimateTokens } from "./tokens.ts";
import type { Arm, RunRecord, TaskSpec } from "./types.ts";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

// --- arm scopes (patch allowlists) -----------------------------------------

/**
 * Per-arm patch allowlist. A refiner patch touching ANY file outside its arm's list
 * is rejected (the iteration counts as a no-accept). Patterns support `*` (one path
 * segment) and `**` (any depth); paths are repo-relative POSIX.
 */
export const ARM_ALLOWLISTS: Record<Arm, string[]> = {
  cli: [
    "src/cli/help.ts",
    "src/cli/commands/*.ts",
    "src/cli/excess-args.ts",
    "src/cli/did-you-mean.ts",
    "src/cli/verb-hint.ts",
  ],
  skill: ["skills/things-cli/**"],
  mcp: ["src/mcp/server.ts"],
};

/** Translate a `*`/`**` glob into an anchored RegExp over a POSIX path. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume the second `*`
        if (glob[i + 1] === "/") {
          // `**/` — zero or more leading path segments.
          i++;
          re += "(?:.*/)?";
        } else {
          // trailing `**` — anything, including nested `/`.
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`${re}$`);
}

/** True iff `file` (repo-relative POSIX) matches at least one allowlist pattern. */
export function matchesAllowlist(file: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(file));
}

/**
 * The repo-relative paths a unified diff touches. Reads the `diff --git a/… b/…`
 * headers, falling back to `+++`/`---` hunk headers, and strips the `a/`|`b/` prefix.
 */
const stripAB = (p: string): string => p.replace(/^[ab]\//, "").trim();

export function filesInPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const git = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (git) {
      files.add(stripAB(git[1] as string));
      files.add(stripAB(git[2] as string));
      continue;
    }
    const hunk = /^(?:---|\+\+\+) ([^\t\n]+)/.exec(line);
    if (hunk) {
      const p = (hunk[1] as string).trim();
      if (p !== "/dev/null") files.add(stripAB(p));
    }
  }
  return [...files];
}

/** The touched files that fall OUTSIDE the given allowlist. */
export function filesOutsideAllowlist(patch: string, patterns: string[]): string[] {
  return filesInPatch(patch).filter((f) => !matchesAllowlist(f, patterns));
}

// --- metrics + decision math -----------------------------------------------

export interface SplitMetrics {
  runs: number;
  successes: number;
  safetyViolations: number;
  /** Mean errorsSeen over SUCCESSFUL runs (CONSTITUTION: efficiency on successes). */
  frictionOnSuccesses: number;
  /** Median tokensIn over SUCCESSFUL runs. */
  medianTokensInOnSuccesses: number;
}

export interface PairMetrics {
  dev: SplitMetrics;
  validation: SplitMetrics;
}

export interface PairRuns {
  dev: RunRecord[];
  validation: RunRecord[];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0
    ? ((s[mid - 1] as number) + (s[mid] as number)) / 2
    : (s[mid] as number);
}

export function splitMetrics(records: RunRecord[]): SplitMetrics {
  const ok = records.filter((r) => r.success);
  return {
    runs: records.length,
    successes: ok.length,
    safetyViolations: records.filter((r) => r.safety === "violated").length,
    frictionOnSuccesses: mean(ok.map((r) => r.errorsSeen)),
    medianTokensInOnSuccesses: median(ok.map((r) => r.tokensIn)),
  };
}

export function pairMetrics(runs: PairRuns): PairMetrics {
  return { dev: splitMetrics(runs.dev), validation: splitMetrics(runs.validation) };
}

/** Thrown when a bench sweep produced no parseable runs — a hard, loud stop. */
export class SweepParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepParseError";
  }
}

/**
 * Parse a sweep's `runs.jsonl` from EXACTLY `benchDir` (the same directory the runner's
 * `--out` wrote to), reading via the injected `readFile` (which returns null when the
 * file is absent). A MISSING or EMPTY runs file is a hard {@link SweepParseError}, never
 * a silent empty array: empty metrics mean zero successes, and the validation
 * non-inferiority gate (`after.successes >= before.successes`) is then satisfied
 * vacuously — so a lost sweep would silently promote regressions. The loop must abort
 * loudly instead. (A genuinely all-failed sweep still returns its rows: 6 failed runs
 * read as 6 rows / 0 successes, which is correct data, not a parse miss.)
 */
export function parseSweepRuns(
  benchDir: string,
  readFile: (path: string) => string | null,
): RunRecord[] {
  const runsPath = join(benchDir, "runs.jsonl");
  const raw = readFile(runsPath);
  if (raw === null) {
    throw new SweepParseError(
      `bench sweep produced no runs file at ${runsPath} — aborting (a missing sweep would ` +
        `silently zero the metrics and vacate the validation non-inferiority gate)`,
    );
  }
  const rows = raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RunRecord);
  if (rows.length === 0) {
    throw new SweepParseError(
      `bench sweep runs file is empty at ${runsPath} — aborting (empty metrics would ` +
        `silently zero the metrics and vacate the validation non-inferiority gate)`,
    );
  }
  return rows;
}

export interface Decision {
  accept: boolean;
  /** True when the patch must be parked for Mike (gui-semantic change) rather than reverted-and-forgotten. */
  needsMike: boolean;
  reason: string;
}

/** ≥10% reduction threshold for the token tie-break (after ≤ before × 0.9). */
export const TOKEN_REDUCTION_FACTOR = 0.9;

const EPS = 1e-9;
const approxEq = (a: number, b: number): boolean => Math.abs(a - b) < EPS;

/**
 * The CONSTITUTION accept/revert rule, as a pure function of before/after metrics.
 *
 * Accept iff: zero safety regressions on EITHER split; validation success is
 * non-inferior (after ≥ before); AND one of the dev tie-break rungs holds —
 *   1. dev success ↑, or
 *   2. dev success = AND friction-on-successes ↓, or
 *   3. dev success = AND friction = AND median tokensIn-on-successes ↓ by ≥10%.
 * `guiSemanticChange` short-circuits to a non-accept that is parked for Mike,
 * regardless of any measured gain.
 */
export function decideAccept(
  before: PairMetrics,
  after: PairMetrics,
  guiSemanticChange: boolean,
): Decision {
  if (guiSemanticChange) {
    return { accept: false, needsMike: true, reason: "gui semantic change — stashed for Mike" };
  }
  if (
    after.dev.safetyViolations > before.dev.safetyViolations ||
    after.validation.safetyViolations > before.validation.safetyViolations
  ) {
    return { accept: false, needsMike: false, reason: "safety regression" };
  }
  if (after.validation.successes < before.validation.successes) {
    return { accept: false, needsMike: false, reason: "validation success regressed" };
  }
  if (after.dev.successes > before.dev.successes) {
    return { accept: true, needsMike: false, reason: "dev success ↑" };
  }
  if (after.dev.successes === before.dev.successes) {
    if (after.dev.frictionOnSuccesses < before.dev.frictionOnSuccesses - EPS) {
      return { accept: true, needsMike: false, reason: "dev success = ; friction ↓" };
    }
    if (
      approxEq(after.dev.frictionOnSuccesses, before.dev.frictionOnSuccesses) &&
      after.dev.medianTokensInOnSuccesses <=
        before.dev.medianTokensInOnSuccesses * TOKEN_REDUCTION_FACTOR
    ) {
      return {
        accept: true,
        needsMike: false,
        reason: "dev success = ; friction = ; median tokensIn ↓ ≥10%",
      };
    }
  }
  return { accept: false, needsMike: false, reason: "no dev improvement" };
}

// --- usage fail-safe: token budget + rate-limit circuit breaker ------------

export interface UsageDelta {
  tokensIn: number;
  tokensOut: number;
}

/** Sum tokensIn+tokensOut across a set of bench runs (for budget accounting). */
export function sumRunTokens(runs: RunRecord[]): UsageDelta {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const r of runs) {
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
  }
  return { tokensIn, tokensOut };
}

export const TOKEN_BUDGET_DEFAULT = 12_000_000;
export const BUDGET_WARN_FRACTION = 0.6;
export const CONSECUTIVE_PROVIDER_ERROR_LIMIT = 5;
export const BUDGET_ABORT_EXIT_CODE = 8;
export const RATE_LIMIT_ABORT_EXIT_CODE = 9;

/** A retryable provider failure (HTTP 429 / quota / 5xx). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Heuristically detect a rate-limit/quota/5xx provider failure from any throwable. */
export function isProviderError(err: unknown): boolean {
  if (err instanceof ProviderError) return true;
  const status =
    (err as { status?: number } | null)?.status ??
    (err as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return /\b429\b|rate.?limit|quota|too many requests|overloaded|insufficient_quota|\b5\d\d\b|server error|service unavailable/.test(
    msg,
  );
}

export type LoopAbortKind = "token-budget" | "rate-limit";

/** A clean, resumable abort: unwinds the loop so the caller can finalize + exit. */
export class LoopAbort extends Error {
  readonly kind: LoopAbortKind;
  readonly code: number;
  constructor(kind: LoopAbortKind, code: number, message: string) {
    super(message);
    this.name = "LoopAbort";
    this.kind = kind;
    this.code = code;
  }
}

/**
 * Cumulative usage fail-safe for ONE loop invocation. Sums tokensIn+tokensOut across
 * every subject bench sweep AND refiner call; warns once at {@link BUDGET_WARN_FRACTION},
 * forces a clean abort (exit {@link BUDGET_ABORT_EXIT_CODE}) at 100%, and trips a
 * rate-limit breaker (exit {@link RATE_LIMIT_ABORT_EXIT_CODE}) after
 * {@link CONSECUTIVE_PROVIDER_ERROR_LIMIT} consecutive provider errors.
 */
export class Budget {
  readonly limit: number;
  usedTokens = 0;
  #warned = false;
  #consecutiveProviderErrors = 0;

  constructor(limit: number = TOKEN_BUDGET_DEFAULT) {
    this.limit = limit;
  }

  add(delta: UsageDelta): void {
    this.usedTokens += delta.tokensIn + delta.tokensOut;
  }

  fraction(): number {
    return this.limit <= 0 ? 1 : this.usedTokens / this.limit;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.usedTokens);
  }

  /** True EXACTLY ONCE — the first check after cumulative usage reaches the warn line. */
  crossedWarnThreshold(): boolean {
    if (!this.#warned && this.fraction() >= BUDGET_WARN_FRACTION) {
      this.#warned = true;
      return true;
    }
    return false;
  }

  /** Throw {@link LoopAbort} if at/over 100%. Call BEFORE each sweep and refiner call. */
  assertUnderBudget(phase: string): void {
    if (this.fraction() >= 1) {
      throw new LoopAbort(
        "token-budget",
        BUDGET_ABORT_EXIT_CODE,
        `token budget exhausted before ${phase}: used ${this.usedTokens} / ${this.limit} tokens`,
      );
    }
  }

  /** Count one provider error; throw {@link LoopAbort} on the Nth CONSECUTIVE one. */
  recordProviderError(): void {
    this.#consecutiveProviderErrors++;
    if (this.#consecutiveProviderErrors >= CONSECUTIVE_PROVIDER_ERROR_LIMIT) {
      throw new LoopAbort(
        "rate-limit",
        RATE_LIMIT_ABORT_EXIT_CODE,
        `${this.#consecutiveProviderErrors} consecutive provider errors — rate-limit circuit breaker tripped`,
      );
    }
  }

  /** A successful provider interaction resets the consecutive-error streak. */
  resetProviderErrors(): void {
    this.#consecutiveProviderErrors = 0;
  }

  get consecutiveProviderErrors(): number {
    return this.#consecutiveProviderErrors;
  }
}

/** Args to size the runner's `--max-total-tokens` to the remaining budget (if supported). */
export function maxTotalTokensArgs(supported: boolean, remaining: number): string[] {
  return supported && remaining > 0 ? ["--max-total-tokens", String(Math.floor(remaining))] : [];
}

/** The subset of a `spawnSync` result the loop needs to classify a bench subprocess. */
export interface BenchExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Classify a bench SUBPROCESS result, throwing the matching loop signal (returns void on a
 * clean exit — the caller then parses runs). Exit {@link BUDGET_ABORT_EXIT_CODE} is the
 * runner's OWN `--max-total-tokens` cap tripping — a cap the loop sizes to its remaining
 * budget — so it is the loop's token budget exhausting THROUGH the subprocess. It must
 * surface as the SAME clean, resumable {@link LoopAbort} (token-budget, exit 8) the loop's
 * own budget gate throws, so the outer loop reverts any unapplied patch and finalizes
 * (ledger + checkpoint with the holdout skipped) rather than crashing on an unhandled
 * error. A provider failure in the captured output becomes a {@link ProviderError} (fed to
 * the circuit breaker); any OTHER nonzero exit is a hard {@link Error}.
 */
export function classifyBenchExit(split: string, r: BenchExecResult): void {
  const status = r.status ?? 1;
  if (status === 0) return;
  if (status === BUDGET_ABORT_EXIT_CODE) {
    throw new LoopAbort(
      "token-budget",
      BUDGET_ABORT_EXIT_CODE,
      `bench subprocess hit its --max-total-tokens cap (split=${split}, exit ${BUDGET_ABORT_EXIT_CODE}) — ` +
        `the loop's token budget exhausted through the runner; treating as a clean budget abort`,
    );
  }
  if (isProviderError(`${r.stdout}${r.stderr}`)) {
    throw new ProviderError(`bench subprocess provider error (split=${split})`);
  }
  throw new Error(`bench subprocess failed (split=${split}, exit=${status})`);
}

// --- startup cost projection (token-budget sizing guidance) ----------------

/** Iterations the startup cost projection sizes the budget against. */
export const BUDGET_ESTIMATE_ITERATIONS = 2;
/** A budget below this multiple of the projected cost is flagged undersized. */
export const BUDGET_ESTIMATE_SAFETY_FACTOR = 1.5;

/** Median of per-run total tokens (tokensIn + tokensOut) across a set of runs. */
export function medianRunTokens(runs: RunRecord[]): number {
  return median(runs.map((r) => r.tokensIn + r.tokensOut));
}

/**
 * Project a batch's cumulative token cost from the observed baseline sweep. The baseline
 * benches dev+validation once; each refinement iteration re-benches the same dev+validation
 * pair, so total runs ≈ baseline run count × (1 + iterations). Every run is priced at the
 * baseline's observed median per-run tokens. Refiner, debrief, and the single holdout sweep
 * are intentionally EXCLUDED (small next to the repeated dev+validation sweeps), making this
 * a deliberate lower bound the safety factor then pads.
 */
export function estimateBatchTokens(baselineRuns: RunRecord[], iterations: number): number {
  const perRun = medianRunTokens(baselineRuns);
  return Math.round(baselineRuns.length * perRun * (1 + Math.max(0, iterations)));
}

/** True when `limit` is below the safety-factor multiple of the projected cost. */
export function budgetLooksUndersized(limit: number, estimate: number): boolean {
  return limit < BUDGET_ESTIMATE_SAFETY_FACTOR * estimate;
}

/** The startup cost projection: an always-printed line plus a loud warning when undersized. */
export interface BudgetProjection {
  medianTokensPerRun: number;
  baselineRuns: number;
  estimate: number;
  undersized: boolean;
  line: string;
  warning: string | null;
}

/**
 * Build the startup cost projection from the baseline sweep's runs. Never mutates the
 * budget and never changes the default — it only estimates and, when the budget looks too
 * small for {@link BUDGET_ESTIMATE_ITERATIONS} iterations, returns a loud `warning` the
 * caller prints. The default `--token-budget` is left untouched by design.
 */
export function projectBudget(
  baselineRuns: RunRecord[],
  limit: number,
  maxIterations: number,
): BudgetProjection {
  const medianTokensPerRun = Math.round(medianRunTokens(baselineRuns));
  const estimate = estimateBatchTokens(baselineRuns, BUDGET_ESTIMATE_ITERATIONS);
  const undersized = budgetLooksUndersized(limit, estimate);
  const line =
    `cost projection: ${baselineRuns.length} baseline runs @ ~${medianTokensPerRun} median tokens/run → ` +
    `~${estimate} tokens projected for ${BUDGET_ESTIMATE_ITERATIONS} iterations ` +
    `(budget ${limit}, planned max-iterations ${maxIterations})`;
  const warning = undersized
    ? `TOKEN BUDGET MAY BE UNDERSIZED: --token-budget ${limit} is below ` +
      `${BUDGET_ESTIMATE_SAFETY_FACTOR}× the ~${estimate}-token projection for ` +
      `${BUDGET_ESTIMATE_ITERATIONS} iterations. Consider raising --token-budget; the loop still ` +
      `runs and aborts cleanly (exit ${BUDGET_ABORT_EXIT_CODE}) if the cap trips.`
    : null;
  return {
    medianTokensPerRun,
    baselineRuns: baselineRuns.length,
    estimate,
    undersized,
    line,
    warning,
  };
}

// --- surface-improvement charter (refiner system prompt) -------------------

/** The CONSTITUTION metric ladder, sliced verbatim from CONSTITUTION.md (with a fallback). */
export function metricLadderText(constitutionPath = join(CORE_DIR, "CONSTITUTION.md")): string {
  const fallback =
    "1. Safety  2. Task success  3. Friction (errors seen)  4. Context tokens  5. Tool calls / latency.";
  try {
    const md = readFileSync(constitutionPath, "utf8");
    const start = md.indexOf("## The metric ladder");
    if (start < 0) return fallback;
    const rest = md.slice(start + "## The metric ladder".length);
    const next = rest.indexOf("\n## ");
    return `## The metric ladder${next < 0 ? rest : rest.slice(0, next)}`.trim();
  } catch {
    return fallback;
  }
}

/** Render the "Prior lessons (this arm)" block from prior debrief lessons, or "". */
function priorLessonsBlock(lessons: string[]): string {
  if (lessons.length === 0) return "";
  return [
    "",
    "PRIOR LESSONS (this arm) — hard-won from earlier refinement rounds; weigh them, do not",
    "blindly repeat a move a lesson warns against:",
    ...lessons.map((l) => `  - ${l}`),
  ].join("\n");
}

/**
 * The refiner's system prompt: the metric ladder (verbatim), the non-opinionated and
 * smallest-generalizable-change doctrines, the arm scope + exact file list, the GUI
 * rule (skill arm only), prior lessons for this arm (fed forward from the ledger), and
 * the strict output contract.
 */
export function buildCharter(arm: Arm, priorLessons: string[] = []): string {
  const files = ARM_ALLOWLISTS[arm];
  const guiRule =
    arm === "skill"
      ? "- GUI-FACT RULE: `references/gui.md` states facts about the Things app UI that " +
        "this loop CANNOT verify. You may COMPRESS or RELOCATE those facts, but you may " +
        "NEVER add, remove, or alter their semantics. If your patch changes gui.md " +
        "semantics in any way, you MUST set `guiSemanticChange` to true so a human reviews it.\n"
      : "";
  return [
    "You are the AGENTBENCH surface refiner. You improve ONE consumer surface so that a",
    "zero-context, non-frontier agent understands and operates Things correctly. You never",
    "execute tasks and never grade — you analyze the supplied failure digest and propose the",
    "SMALLEST GENERALIZABLE change.",
    "",
    "OPTIMIZE STRICTLY BY THIS LEXICOGRAPHIC LADDER (a lower rung never trades for a higher):",
    "",
    metricLadderText(),
    "",
    "DOCTRINE:",
    "- NON-OPINIONATED: surfaces teach capabilities and structure — the data model, what a",
    "  command does, how a human sees the result. They NEVER give GTD/workflow advice.",
    "- SMALLEST GENERALIZABLE CHANGE: fix the root cause a failure class reveals, not the exact",
    "  benchmark phrasing. Do not memorize task wording. Prefer one precise edit over many.",
    "- Every failure is CLASSIFIED before any copy change: (a) discovery — couldn't find the",
    "  command; (b) behavior-misunderstanding; (c) data-model-misunderstanding; (d)",
    "  argument-construction; (e) failed recovery; (f) tool-defect (a real bug — flag it, do",
    "  not paper over it with copy).",
    priorLessonsBlock(priorLessons),
    "",
    `ARM SCOPE — you are refining the "${arm}" surface. You may touch ONLY these paths:`,
    ...files.map((f) => `  - ${f}`),
    "An edit or new file touching anything else is rejected outright.",
    guiRule,
    "HOW TO EXPRESS A CHANGE — do NOT emit a unified diff. Use exact find/replace edits:",
    "- Each edit is { file, find, replace }. `find` must be copied VERBATIM from the file",
    "  content shown above and must occur EXACTLY ONCE in that file (if it appears more than",
    '  once, extend it with surrounding lines until it is unique). `replace` may be "" to',
    "  delete the matched text. To add a brand-new file, use `creates: [{ file, content }]`.",
    "- Worked example — insert a line after a known anchor by including the anchor in both",
    "  `find` and `replace`:",
    "```json",
    "{",
    '  "edits": [',
    '    { "file": "src/cli/help.ts",',
    '      "find": "  inbox           captured, still-unsorted to-dos\\n",',
    '      "replace": "  inbox           captured, still-unsorted to-dos\\n  today           what is scheduled for today\\n" }',
    "  ]",
    "}",
    "```",
    "OUTPUT CONTRACT — reply with ONLY a single fenced ```json object, no prose around it:",
    "```json",
    "{",
    '  "classifications": [{"taskId": "...", "class": "a|b|c|d|e|f or the class name", "note": "..."}],',
    '  "edits": [{"file": "<allowed path>", "find": "<exact unique substring>", "replace": "<new text or empty>"}],',
    '  "creates": [{"file": "<allowed new path>", "content": "<full file body>"}],',
    '  "rationale": "<why this is the smallest generalizable fix>",',
    '  "predictedBlastRadius": "<which tasks/behaviors this should move, and any risk>",',
    '  "guiSemanticChange": false',
    "}",
    "```",
    'For no change, return "edits": [] (and omit "creates").',
  ].join("\n");
}

/**
 * The post-hoc debrief system prompt. The debriefer is a metric-honest analyst: given a
 * patch, its pre-hoc hypothesis, and the per-task before/after NUMBERS (no task text),
 * it attributes the measured delta and distills one transferable lesson.
 */
export function buildDebriefCharter(): string {
  return [
    "You are the AGENTBENCH post-hoc debriefer. A candidate patch to one consumer surface",
    "was just benched; you receive the patch, its author's pre-hoc hypothesis + predicted",
    "blast radius, and the per-task before→after RESULTS (success / friction / tokensIn) for",
    "the dev and validation splits. You did NOT see the task prompts and must not invent them.",
    "",
    "Judge only by the numbers and the diff. Attribute the delta (positive OR negative) to the",
    "most likely cause, and state ONE transferable lesson a future refiner of ANY arm could use.",
    "The lesson must generalize — never quote or paraphrase specific task content (you have none).",
    "",
    "OUTPUT CONTRACT — reply with ONLY a single fenced ```json object, no prose around it:",
    "```json",
    '{ "attribution": "...", "lesson": "one transferable sentence", "confidence": "high|medium|low" }',
    "```",
  ].join("\n");
}

/** Per-task numbers for a split's runs, keyed by taskId (NO task text — hygiene). */
function perTaskLines(label: string, before: RunRecord[], after: RunRecord[]): string[] {
  const ids = new Set<string>([...before, ...after].map((r) => r.taskId));
  const agg = (runs: RunRecord[], id: string): string => {
    const rows = runs.filter((r) => r.taskId === id);
    const ok = rows.filter((r) => r.success);
    const succ = `${ok.length}/${rows.length}`;
    const err = mean(rows.map((r) => r.errorsSeen)).toFixed(1);
    const tok = Math.round(median(ok.map((r) => r.tokensIn)));
    return `${succ} succ, ${err} err, ${tok} tokIn`;
  };
  const lines = [`${label}:`];
  for (const id of [...ids].toSorted()) {
    lines.push(`  ${id}: ${agg(before, id)} → ${agg(after, id)}`);
  }
  return lines;
}

/** Debrief user content: the applied diff + pre-hoc hypothesis + per-task before→after numbers. */
export function renderDebriefUserContent(
  output: RefinerOutput,
  diff: string,
  before: PairRuns,
  after: PairRuns,
): string {
  return [
    "APPLIED CHANGE (real unified diff of what landed):",
    "```diff",
    diff.trim() === "" ? "(empty)" : diff,
    "```",
    "",
    `PRE-HOC RATIONALE: ${output.rationale || "(none)"}`,
    `PRE-HOC PREDICTED BLAST RADIUS: ${output.predictedBlastRadius || "(none)"}`,
    "",
    "PER-TASK RESULTS (before → after), success / mean-friction / median-tokensIn:",
    ...perTaskLines("dev", before.dev, after.dev),
    ...perTaskLines("validation", before.validation, after.validation),
  ].join("\n");
}

// --- failure digest --------------------------------------------------------

export interface TranscriptData {
  messages?: unknown[];
}

export type TranscriptLoader = (record: RunRecord) => TranscriptData | null;

export interface DigestItem {
  taskId: string;
  family: string;
  preClass: string;
}

export interface DigestResult {
  text: string;
  hash: string;
  items: DigestItem[];
}

/** ~8k-token cap on the digest (≈4 chars/token). */
export const MAX_DIGEST_CHARS = 32_000;
const MAX_EXCERPT_CHARS = 2_000;
const MAX_RESULT_CHARS = 500;

interface ToolCallBlock {
  type?: string;
  name?: string;
  arguments?: unknown;
  text?: string;
}

/** A compact transcript excerpt: the commands/tool calls tried + their output/errors. */
function extractExcerpt(messages: unknown[]): string {
  const lines: string[] = [];
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown };
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as ToolCallBlock[]) {
      if (b.type === "toolCall") {
        const args = b.arguments as { command?: string } | undefined;
        const call =
          typeof args?.command === "string"
            ? args.command
            : `${b.name ?? "tool"}(${JSON.stringify(b.arguments ?? {})})`;
        lines.push(`$ ${call}`);
      } else if (m.role === "toolResult" && b.type === "text" && typeof b.text === "string") {
        const text =
          b.text.length > MAX_RESULT_CHARS ? `${b.text.slice(0, MAX_RESULT_CHARS)}…` : b.text;
        lines.push(`> ${text.replace(/\n/g, "\n> ")}`);
      }
    }
  }
  const joined = lines.join("\n");
  return joined.length > MAX_EXCERPT_CHARS ? `${joined.slice(0, MAX_EXCERPT_CHARS)}…` : joined;
}

/** Heuristic pre-classification (a hint the refiner re-decides). */
export function preClassify(record: RunRecord, excerpt: string): string {
  const notes = (record.failureNotes ?? "").toLowerCase();
  const hay = `${notes}\n${excerpt.toLowerCase()}`;
  if (
    /typeerror|referenceerror|unexpected error|\bat object\.|stack trace|internal error/.test(hay)
  ) {
    return "tool-defect";
  }
  if (/command not found|unknown command|not a things command|did you mean/.test(hay)) {
    return "discovery";
  }
  if (
    /unknown option|unknown argument|invalid option|error: option|too many arguments|usage:/.test(
      hay,
    )
  ) {
    return "argument-construction";
  }
  if (/db-unchanged|safety/.test(notes)) {
    return "recovery";
  }
  if (/inbox|area|project|heading|tag|someday|deadline|start date|scheduled/.test(hay)) {
    return "data-model-misunderstanding";
  }
  return "behavior-misunderstanding";
}

/**
 * Build the failure digest from DEV runs only (NEVER validation/holdout content):
 * failed dev runs plus high-friction dev successes (errorsSeen ≥ 2), grouped to one
 * representative item per task, capped at ~8k tokens.
 */
export function buildDigest(
  devRuns: RunRecord[],
  tasks: Map<string, TaskSpec>,
  loadTranscript: TranscriptLoader,
): DigestResult {
  const selected = devRuns.filter((r) => {
    const task = tasks.get(r.taskId);
    // Defensive belt-and-suspenders: a non-dev task must never enter the digest.
    if (task !== undefined && task.split !== "dev") return false;
    return !r.success || r.errorsSeen >= 2;
  });

  const byTask = new Map<string, RunRecord[]>();
  for (const r of selected) {
    const bucket = byTask.get(r.taskId) ?? [];
    bucket.push(r);
    byTask.set(r.taskId, bucket);
  }

  const sections: string[] = [];
  const items: DigestItem[] = [];
  let budget = MAX_DIGEST_CHARS;

  for (const taskId of [...byTask.keys()].toSorted()) {
    const reps = byTask.get(taskId) as RunRecord[];
    // Prefer a failing rep (worst friction); else the worst high-friction success.
    const failing = reps.filter((r) => !r.success);
    const pool = failing.length > 0 ? failing : reps;
    const rep = pool.toSorted((a, b) => b.errorsSeen - a.errorsSeen)[0] as RunRecord;

    const task = tasks.get(taskId);
    const family = task?.family ?? "unknown";
    const transcript = loadTranscript(rep);
    const excerpt = transcript?.messages ? extractExcerpt(transcript.messages) : "";
    const preClass = preClassify(rep, excerpt);

    const graded = rep.success
      ? "(high-friction success — no grading failure)"
      : (rep.failureNotes ?? "(failed, no notes)");
    const section = [
      `## ${taskId}  [family: ${family}]  (pre-class: ${preClass}, errorsSeen: ${rep.errorsSeen})`,
      `prompt: ${task?.prompt ?? "(unknown)"}`,
      `graded failure: ${graded}`,
      "transcript excerpt:",
      excerpt === "" ? "(no tool calls captured)" : excerpt,
      "",
    ].join("\n");

    if (section.length > budget) break;
    budget -= section.length;
    sections.push(section);
    items.push({ taskId, family, preClass });
  }

  const header =
    "=== FAILURE DIGEST — DEV SPLIT ONLY ===\n" +
    "Failed or high-friction dev tasks. Validation/holdout content is intentionally absent.\n\n";
  const text =
    sections.length > 0
      ? header + sections.join("\n")
      : `${header}(no failing or high-friction dev runs)\n`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { text, hash, items };
}

const MAX_FILE_CHARS = 24_000;

/** Assemble the refiner user content: current target file bodies + the digest. */
export function renderUserContent(
  arm: Arm,
  targetFiles: Record<string, string>,
  digestText: string,
): string {
  const parts: string[] = [`=== CURRENT "${arm}" SURFACE FILES ===`, ""];
  for (const path of Object.keys(targetFiles).toSorted()) {
    const body = targetFiles[path] as string;
    const shown =
      body.length > MAX_FILE_CHARS
        ? `${body.slice(0, MAX_FILE_CHARS)}\n… [truncated ${body.length - MAX_FILE_CHARS} chars]`
        : body;
    parts.push(`--- FILE: ${path} ---`, shown, "");
  }
  parts.push("", digestText);
  return parts.join("\n");
}

// --- exact find/replace edit engine ----------------------------------------

/** A validated write the apply engine will make (all or none). */
export interface PlannedWrite {
  file: string;
  content: string;
  isNew: boolean;
}

export interface EditPlan {
  ok: boolean;
  /** Per-edit validation errors (empty iff ok); fed back to the refiner on retry. */
  errors: string[];
  /** The writes to make when ok; empty when not ok (atomic — all or none). */
  writes: PlannedWrite[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

/**
 * Validate exact find/replace edits + file creations against the arm allowlist and the
 * current file bodies, WITHOUT touching anything. Every edit's `find` must occur exactly
 * once; every target must be in the allowlist; a `creates` target must not already exist.
 * Returns the full set of writes only when EVERY op validates (atomic — all or none), so
 * the caller can apply with no half-applied state. `readFile` returns null for a missing
 * file. Multiple edits to one file compose in order (each validated against the running
 * content).
 */
export function planEdits(
  edits: EditOp[],
  creates: CreateOp[],
  allowlist: string[],
  readFile: (file: string) => string | null,
): EditPlan {
  const errors: string[] = [];
  const working = new Map<string, string>();
  const created = new Set<string>();

  const current = (file: string): string | null => {
    if (working.has(file)) return working.get(file) as string;
    return readFile(file);
  };

  for (const edit of edits) {
    if (!matchesAllowlist(edit.file, allowlist)) {
      errors.push(`edit target not in arm allowlist: ${edit.file}`);
      continue;
    }
    const content = current(edit.file);
    if (content === null) {
      errors.push(`file not found: ${edit.file}`);
      continue;
    }
    const n = countOccurrences(content, edit.find);
    if (n === 0) {
      errors.push(`find not found in ${edit.file}: ${JSON.stringify(edit.find.slice(0, 60))}`);
      continue;
    }
    if (n > 1) {
      errors.push(
        `find matched ${n} times in ${edit.file} (must be unique): ${JSON.stringify(edit.find.slice(0, 60))}`,
      );
      continue;
    }
    working.set(edit.file, content.replace(edit.find, edit.replace));
  }

  for (const create of creates) {
    if (!matchesAllowlist(create.file, allowlist)) {
      errors.push(`create target not in arm allowlist: ${create.file}`);
      continue;
    }
    if (current(create.file) !== null) {
      errors.push(`create target already exists: ${create.file}`);
      continue;
    }
    working.set(create.file, create.content);
    created.add(create.file);
  }

  if (errors.length > 0) return { ok: false, errors, writes: [] };
  const writes: PlannedWrite[] = [...working.entries()].map(([file, content]) => ({
    file,
    content,
    isNew: created.has(file),
  }));
  return { ok: true, errors: [], writes };
}

/** Outcome of applying a validated edit set to the working tree. */
export interface ApplyResult {
  ok: boolean;
  /** Validation errors when !ok (nothing was written). */
  errors: string[];
  modifiedFiles: string[];
  createdFiles: string[];
  /** Real unified diff of the applied change (git diff), for ledger/checkpoint/debrief. */
  diff: string;
}

/** Format per-edit validation errors as a refiner-retry feedback block. */
export function renderApplyFeedback(errors: string[]): string {
  return [
    "",
    "",
    "YOUR PREVIOUS EDITS DID NOT APPLY. Fix these and resend the SAME JSON contract:",
    ...errors.map((e) => `  - ${e}`),
    "Remember: each `find` must be copied EXACTLY from the file above and be UNIQUE.",
  ].join("\n");
}

/** +adds/-dels summary from a unified diff (ignoring the +++/--- file headers). */
export function diffStat(diff: string): string {
  const added = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
  const removed = (diff.match(/^-(?!--)/gm) ?? []).length;
  return `+${added}/-${removed}`;
}

// --- one loop iteration (injectable seam) ----------------------------------

export interface IterationDeps {
  refiner: Refiner;
  /** Read the arm's current target files → { repoRelativePath: body }. */
  readArmFiles: () => Record<string, string>;
  loadTranscript: TranscriptLoader;
  /** Validate (allowlist + unique find + create-not-exists) then apply atomically. */
  applyEdits: (edits: EditOp[], creates: CreateOp[]) => ApplyResult;
  /** `npm run fmt` + `npm run check`, judged by exit code. */
  runGate: () => { ok: boolean; output: string };
  /** Re-bench dev + validation at the current working-tree state. */
  benchSplits: () => PairRuns;
  /** Revert the working tree: `git checkout` modified files, delete created ones. */
  revert: (modified: string[], created: string[]) => void;
  /** Commit exactly these files. */
  commit: (message: string, files: string[]) => void;
  /** Persist a parked patch; returns the path written. */
  stashPatch: (name: string, content: string) => string;
  /** Emit the prominent 60%-budget warning (console + a loop-state.json note). */
  onBudgetWarning: () => void;
  log: (msg: string) => void;
}

export interface IterationParams {
  arm: Arm;
  iteration: number;
  prevMetrics: PairMetrics;
  /** Runs from the previous bench (dev feeds the digest; both feed the debrief). */
  prevRuns: PairRuns;
  tasks: Map<string, TaskSpec>;
  /** The invocation-wide usage fail-safe (token budget + provider-error breaker). */
  budget: Budget;
  /** Prior lessons for THIS arm (from the ledger), fed into the refiner charter. */
  priorLessons?: string[];
}

/** The post-hoc debrief distilled for one candidate. */
export interface DebriefRecord {
  attribution: string;
  lesson: string;
  confidence: Confidence;
}

/** A candidate that was neither re-benched nor debriefed. */
export function notDebriefed(note = "(not debriefed)"): DebriefRecord {
  return { attribution: note, lesson: "", confidence: "low" };
}

export interface IterationResult {
  iteration: number;
  arm: Arm;
  digestHash: string;
  accepted: boolean;
  needsMike: boolean;
  reason: string;
  rationale: string;
  predictedBlastRadius: string;
  patchSummary: string;
  classifications: Classification[];
  guiSemanticChange: boolean;
  metricsBefore: PairMetrics;
  metricsAfter: PairMetrics | null;
  /** The re-bench runs (only when a re-bench happened AND was kept, i.e. accepted). */
  afterRuns: PairRuns | null;
  /** Post-hoc debrief (present for accepted + reverted; sentinel otherwise). */
  debrief: DebriefRecord;
  /** True when the candidate's edits failed to apply even after the one feedback retry. */
  applyFailed: boolean;
  touchedFiles: string[];
  needsMikePatchPath?: string;
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, 120) || "(no rationale)";
}

/** Summarize applied files + diff stat for the ledger/checkpoint. */
function patchSummaryFor(touched: string[], diff: string): string {
  return `${touched.length} file(s) [${touched.join(", ")}], ${diffStat(diff)}`;
}

/** True when the refiner proposed nothing to apply. */
function noEdits(o: RefinerOutput): boolean {
  return (o.edits?.length ?? 0) === 0 && (o.creates?.length ?? 0) === 0;
}

/**
 * The post-hoc debrief for a re-benched candidate. NEVER blocks the loop: a parse
 * failure or provider error is recorded as "debrief-failed" and swallowed (it does NOT
 * feed the circuit breaker); if the budget is already spent the debrief is skipped.
 * Debrief token usage, when reported, still counts against the budget.
 */
async function runDebrief(
  deps: IterationDeps,
  budget: Budget,
  output: RefinerOutput,
  diff: string,
  before: PairRuns,
  after: PairRuns,
): Promise<DebriefRecord> {
  if (budget.fraction() >= 1) return notDebriefed("debrief-skipped (budget)");
  try {
    const d = await deps.refiner.debrief({
      systemPrompt: buildDebriefCharter(),
      userContent: renderDebriefUserContent(output, diff, before, after),
    });
    if (d.usage !== undefined) budget.add(d.usage);
    return { attribution: d.attribution, lesson: d.lesson, confidence: d.confidence };
  } catch (e) {
    deps.log(`debrief failed (non-blocking) — ${(e as Error).message}`);
    return notDebriefed("debrief-failed");
  }
}

/**
 * Run ONE loop iteration: digest → refiner → allowlist → apply → gate → gui-guard →
 * re-bench → accept/revert. Every side effect goes through {@link IterationDeps} so a
 * test can drive the whole control flow with fakes. Returns the outcome; the caller
 * records state and decides whether to continue.
 */
export async function runIteration(
  deps: IterationDeps,
  params: IterationParams,
): Promise<IterationResult> {
  const { arm, iteration, prevMetrics, budget } = params;
  const prevRuns = params.prevRuns;
  const digest = buildDigest(prevRuns.dev, params.tasks, deps.loadTranscript);
  const targetFiles = deps.readArmFiles();

  const charter = buildCharter(arm, params.priorLessons ?? []);
  const baseUserContent = renderUserContent(arm, targetFiles, digest.text);

  // One refiner call: budget-gated, usage-accounted. Throws ProviderError/LoopAbort.
  const refineCall = async (extra: string): Promise<RefinerOutput> => {
    budget.assertUnderBudget(`refiner call (iter ${iteration})`);
    const out = await deps.refiner.refine({
      systemPrompt: charter,
      userContent: baseUserContent + extra,
    });
    budget.resetProviderErrors();
    if (out.usage !== undefined) budget.add(out.usage);
    if (budget.crossedWarnThreshold()) deps.onBudgetWarning();
    return out;
  };

  const resultFor = (o: RefinerOutput, over: Partial<IterationResult>): IterationResult => ({
    iteration,
    arm,
    digestHash: digest.hash,
    accepted: false,
    needsMike: false,
    reason: "",
    rationale: o.rationale,
    predictedBlastRadius: o.predictedBlastRadius,
    patchSummary: "",
    classifications: o.classifications,
    guiSemanticChange: o.guiSemanticChange,
    metricsBefore: prevMetrics,
    metricsAfter: null,
    afterRuns: null,
    debrief: notDebriefed(),
    applyFailed: false,
    touchedFiles: [],
    ...over,
  });

  // Refiner call + apply, with ONE feedback retry on a validation failure. Provider
  // errors (either call) surface here and count toward the circuit breaker.
  let output: RefinerOutput;
  let apply: ApplyResult;
  try {
    output = await refineCall("");
    if (noEdits(output)) {
      deps.log(`iter ${iteration}: refiner proposed no change`);
      return resultFor(output, { reason: "no edits proposed" });
    }
    apply = deps.applyEdits(output.edits, output.creates ?? []);
    if (!apply.ok) {
      deps.log(
        `iter ${iteration}: edits did not apply (${apply.errors.join("; ")}) — retrying once`,
      );
      output = await refineCall(renderApplyFeedback(apply.errors));
      apply = noEdits(output)
        ? {
            ok: false,
            errors: ["retry proposed no edits"],
            modifiedFiles: [],
            createdFiles: [],
            diff: "",
          }
        : deps.applyEdits(output.edits, output.creates ?? []);
    }
  } catch (e) {
    if (e instanceof LoopAbort) throw e;
    if (isProviderError(e)) {
      deps.log(`iter ${iteration}: provider error (refiner) — ${(e as Error).message}`);
      budget.recordProviderError(); // throws LoopAbort(rate-limit) on the Nth consecutive
      return {
        iteration,
        arm,
        digestHash: digest.hash,
        accepted: false,
        needsMike: false,
        reason: "provider error (refiner)",
        rationale: "",
        predictedBlastRadius: "",
        patchSummary: "",
        classifications: [],
        guiSemanticChange: false,
        metricsBefore: prevMetrics,
        metricsAfter: null,
        afterRuns: null,
        debrief: notDebriefed("(no candidate)"),
        applyFailed: false,
        touchedFiles: [],
      };
    }
    throw e;
  }

  // Apply failed even after the one retry → an apply-failed candidate. Hypothesis is
  // preserved in the ledger (no metrics, no debrief) — failed attempts are knowledge.
  if (!apply.ok) {
    const attempted = [
      ...output.edits.map((e) => e.file),
      ...(output.creates ?? []).map((c) => c.file),
    ];
    deps.log(`iter ${iteration}: edits failed to apply after retry — ${apply.errors.join("; ")}`);
    return resultFor(output, {
      applyFailed: true,
      reason: `apply failed: ${apply.errors.join("; ")}`,
      patchSummary: `${attempted.length} file(s) attempted [${[...new Set(attempted)].join(", ")}], not applied`,
      touchedFiles: [...new Set(attempted)],
    });
  }

  const touched = [...apply.modifiedFiles, ...apply.createdFiles];
  const base = resultFor(output, {
    patchSummary: patchSummaryFor(touched, apply.diff),
    touchedFiles: touched,
  });

  // Gate (fmt + check).
  const gate = deps.runGate();
  if (!gate.ok) {
    deps.revert(apply.modifiedFiles, apply.createdFiles);
    deps.log(`iter ${iteration}: gate failed — reverted`);
    return { ...base, reason: "gate failed (fmt/check)" };
  }

  // GUI-semantic guard: never auto-accept; park the applied diff for Mike, revert.
  if (output.guiSemanticChange) {
    const patchPath = deps.stashPatch(`needs-mike-iter${iteration}.patch`, apply.diff);
    deps.revert(apply.modifiedFiles, apply.createdFiles);
    deps.log(`iter ${iteration}: gui-semantic change — parked at ${patchPath}, reverted`);
    return {
      ...base,
      needsMike: true,
      reason: "gui semantic change — stashed for Mike",
      needsMikePatchPath: patchPath,
    };
  }

  // Re-bench + decide. The budget gate here fires AFTER apply+gate, so a clean abort
  // (or a provider error) must revert the applied-but-unaccepted change first.
  let afterRuns: PairRuns;
  try {
    budget.assertUnderBudget(`re-bench (iter ${iteration})`);
    afterRuns = deps.benchSplits();
  } catch (e) {
    deps.revert(apply.modifiedFiles, apply.createdFiles);
    if (e instanceof LoopAbort) throw e;
    if (isProviderError(e)) {
      deps.log(`iter ${iteration}: provider error (bench) — reverted`);
      budget.recordProviderError(); // throws LoopAbort(rate-limit) on the Nth consecutive
      return { ...base, reason: "provider error (bench)" };
    }
    throw e;
  }
  budget.add(sumRunTokens([...afterRuns.dev, ...afterRuns.validation]));
  budget.resetProviderErrors();
  if (budget.crossedWarnThreshold()) deps.onBudgetWarning();
  const afterMetrics = pairMetrics(afterRuns);
  const decision = decideAccept(prevMetrics, afterMetrics, false);

  // Post-hoc debrief runs for BOTH outcomes (accepted and reverted) — never blocking.
  const debrief = await runDebrief(deps, budget, output, apply.diff, prevRuns, afterRuns);

  if (decision.accept) {
    deps.commit(`loop(${arm}) iter ${iteration}: ${firstLine(output.rationale)}`, touched);
    deps.log(`iter ${iteration}: ACCEPT — ${decision.reason}`);
    return {
      ...base,
      accepted: true,
      reason: decision.reason,
      metricsAfter: afterMetrics,
      afterRuns,
      debrief,
    };
  }
  deps.revert(apply.modifiedFiles, apply.createdFiles);
  deps.log(`iter ${iteration}: revert — ${decision.reason}`);
  return { ...base, reason: decision.reason, metricsAfter: afterMetrics, debrief };
}

// --- state file + checkpoint -----------------------------------------------

export interface LoopStateEntry {
  timestamp: string;
  arm: Arm;
  iteration: number;
  digestHash: string;
  patchSummary: string;
  rationale: string;
  decision: "accept" | "revert" | "needs-mike" | "apply-failed";
  reason: string;
  guiSemanticChange: boolean;
  classifications: Classification[];
  metricsBefore: PairMetrics;
  metricsAfter: PairMetrics | null;
}

/** A non-iteration note in the state log: a 60% budget warning or a clean abort. */
export interface BudgetNoteEntry {
  timestamp: string;
  arm: Arm;
  kind: "budget-warning" | "abort";
  reason: string;
  usedTokens: number;
  limit: number;
}

/** Anything appended to loop-state.json — an iteration outcome or a budget note. */
export type LoopStateRecord = LoopStateEntry | BudgetNoteEntry;

/** Build a budget-warning / abort note for the state log. */
export function budgetNote(
  arm: Arm,
  kind: BudgetNoteEntry["kind"],
  reason: string,
  budget: Budget,
  timestamp: string,
): BudgetNoteEntry {
  return { timestamp, arm, kind, reason, usedTokens: budget.usedTokens, limit: budget.limit };
}

/** Map an iteration outcome to the decision label recorded in state/checkpoint. */
export function decisionLabel(result: IterationResult): LoopStateEntry["decision"] {
  if (result.accepted) return "accept";
  if (result.needsMike) return "needs-mike";
  if (result.applyFailed) return "apply-failed";
  return "revert";
}

/** Append one record to the JSON-array loop-state file (creating it if absent). */
export function appendLoopState(statePath: string, entry: LoopStateRecord): void {
  let existing: LoopStateRecord[] = [];
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) existing = parsed as LoopStateRecord[];
    } catch {
      existing = [];
    }
  }
  existing.push(entry);
  writeFileSync(statePath, `${JSON.stringify(existing, null, 2)}\n`);
}

/** Build a state entry from an iteration result + timestamp. */
export function toStateEntry(result: IterationResult, timestamp: string): LoopStateEntry {
  return {
    timestamp,
    arm: result.arm,
    iteration: result.iteration,
    digestHash: result.digestHash,
    patchSummary: result.patchSummary,
    rationale: result.rationale,
    decision: decisionLabel(result),
    reason: result.reason,
    guiSemanticChange: result.guiSemanticChange,
    classifications: result.classifications,
    metricsBefore: result.metricsBefore,
    metricsAfter: result.metricsAfter,
  };
}

export interface CheckpointData {
  arm: Arm;
  subjectModel: string;
  refinerModel: string;
  reps: number;
  results: IterationResult[];
  baselineMetrics: PairMetrics;
  finalMetrics: PairMetrics;
  /** Holdout metrics run once at the final state, or null when skipped (clean abort). */
  holdout: SplitMetrics | null;
  /** Why the holdout was skipped (only set when `holdout` is null). */
  holdoutNote?: string;
  needsMikePatches: string[];
  stopReason: string;
}

function fmtSplit(m: SplitMetrics): string {
  return (
    `${m.successes}/${m.runs} success, safety✗ ${m.safetyViolations}, ` +
    `friction ${m.frictionOnSuccesses.toFixed(2)}, med tokIn ${Math.round(m.medianTokensInOnSuccesses)}`
  );
}

/** Render the end-of-loop checkpoint.md. */
export function renderCheckpoint(data: CheckpointData): string {
  const L: string[] = [];
  L.push(`# AGENTBENCH loop checkpoint — ${data.arm}`);
  L.push("");
  L.push(`- subject model: \`${data.subjectModel}\``);
  L.push(`- refiner model: \`${data.refinerModel}\``);
  L.push(`- reps: ${data.reps}`);
  L.push(`- iterations run: ${data.results.length}`);
  L.push(`- stop reason: ${data.stopReason}`);
  L.push("");

  L.push("## Iterations");
  L.push("");
  L.push("| iter | decision | reason | rationale | patch |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const r of data.results) {
    const rat = firstLine(r.rationale).replace(/\|/g, "\\|");
    const sum = r.patchSummary.replace(/\|/g, "\\|");
    L.push(`| ${r.iteration} | ${decisionLabel(r)} | ${r.reason} | ${rat} | ${sum} |`);
  }
  L.push("");

  L.push("## Metrics (before → after)");
  L.push("");
  L.push(`- dev baseline: ${fmtSplit(data.baselineMetrics.dev)}`);
  L.push(`- dev final: ${fmtSplit(data.finalMetrics.dev)}`);
  L.push(`- validation baseline: ${fmtSplit(data.baselineMetrics.validation)}`);
  L.push(`- validation final: ${fmtSplit(data.finalMetrics.validation)}`);
  L.push(
    data.holdout !== null
      ? `- **holdout (final state, run once): ${fmtSplit(data.holdout)}**`
      : `- **holdout: SKIPPED — ${data.holdoutNote ?? "clean abort"}**`,
  );
  L.push("");

  const classCounts = new Map<string, number>();
  for (const r of data.results) {
    for (const c of r.classifications) {
      classCounts.set(c.class, (classCounts.get(c.class) ?? 0) + 1);
    }
  }
  L.push("## Per-class failure counts (refiner classifications)");
  L.push("");
  if (classCounts.size === 0) {
    L.push("_(none)_");
  } else {
    for (const cls of [...classCounts.keys()].toSorted()) {
      L.push(`- ${cls}: ${classCounts.get(cls)}`);
    }
  }
  L.push("");

  L.push("## needs-mike patches");
  L.push("");
  if (data.needsMikePatches.length === 0) {
    L.push("_(none)_");
  } else {
    for (const p of data.needsMikePatches) L.push(`- \`${p}\``);
  }
  L.push("");
  return L.join("\n");
}

// --- per-arm knowledge ledger (bench/ledger/<arm>.md) ----------------------

/** The ledger file name for one arm (files live under `bench/ledger/`). */
export function ledgerFileName(arm: Arm): string {
  return `${arm}.md`;
}

/** One committed, append-only ledger record for a single candidate. */
export interface LedgerEntry {
  /** Stable id (batch + arm + iteration) — dedups appends so the write is idempotent. */
  id: string;
  date: string;
  arm: Arm;
  iteration: number;
  decision: "ACCEPTED" | "REVERTED" | "NEEDS-MIKE" | "APPLY-FAILED";
  changeSummary: string;
  filesTouched: string[];
  diffStat: string;
  hypothesis: string;
  predictedBlastRadius: string;
  metricsBefore: PairMetrics;
  metricsAfter: PairMetrics | null;
  debrief: DebriefRecord;
  artifactsPointer: string;
}

/** UPPERCASE decision label for the ledger. */
function ledgerDecision(result: IterationResult): LedgerEntry["decision"] {
  if (result.accepted) return "ACCEPTED";
  if (result.needsMike) return "NEEDS-MIKE";
  if (result.applyFailed) return "APPLY-FAILED";
  return "REVERTED";
}

/**
 * A candidate worth a ledger entry: it was accepted, reverted after a re-bench, parked
 * for Mike, or died in apply-retry (failed attempts are knowledge too). Gate / empty /
 * provider-error iterations carry no candidate and live only in loop-state.json.
 */
export function isLedgerCandidate(result: IterationResult): boolean {
  return result.accepted || result.needsMike || result.applyFailed || result.metricsAfter !== null;
}

/** Deterministic per-candidate id: identical within a batch (idempotent), unique across. */
export function ledgerEntryId(batchId: string, arm: Arm, iteration: number): string {
  return `${batchId}-${arm}-iter${iteration}`;
}

/** Build a ledger entry from an iteration result. */
export function buildLedgerEntry(
  result: IterationResult,
  ctx: { batchId: string; date: string; artifactsPointer: string },
): LedgerEntry {
  return {
    id: ledgerEntryId(ctx.batchId, result.arm, result.iteration),
    date: ctx.date,
    arm: result.arm,
    iteration: result.iteration,
    decision: ledgerDecision(result),
    changeSummary: firstLine(result.rationale),
    filesTouched: result.touchedFiles,
    diffStat: result.patchSummary,
    hypothesis: result.rationale || "(none)",
    predictedBlastRadius: result.predictedBlastRadius || "(none)",
    metricsBefore: result.metricsBefore,
    metricsAfter: result.metricsAfter,
    debrief: result.debrief,
    artifactsPointer: ctx.artifactsPointer,
  };
}

function fmtSplitDelta(before: SplitMetrics, after: SplitMetrics | null): string {
  if (after === null) return "not measured (no re-bench)";
  return (
    `success ${before.successes}/${before.runs} → ${after.successes}/${after.runs}; ` +
    `friction ${before.frictionOnSuccesses.toFixed(2)} → ${after.frictionOnSuccesses.toFixed(2)}; ` +
    `median tokIn ${Math.round(before.medianTokensInOnSuccesses)} → ${Math.round(after.medianTokensInOnSuccesses)}`
  );
}

/** Escape a lesson for the single-line entry marker (kept HTML-comment-safe). */
function escapeMarker(text: string): string {
  return text.replace(/\s+/g, " ").replace(/--+/g, "—").replace(/"/g, "'").trim();
}

/** Render one ledger entry (a hidden id+lesson marker followed by the human body). */
export function renderLedgerEntry(entry: LedgerEntry): string {
  const L: string[] = [];
  L.push(`<!-- ledger-entry id="${entry.id}" lesson="${escapeMarker(entry.debrief.lesson)}" -->`);
  L.push(`### ${entry.date} · ${entry.arm} · iter ${entry.iteration} · **${entry.decision}**`);
  L.push("");
  L.push(
    `- **change:** ${entry.changeSummary} — files: ${entry.filesTouched.join(", ") || "(none)"}; diff ${entry.diffStat}`,
  );
  L.push(`- **pre-hoc hypothesis:** ${entry.hypothesis}`);
  L.push(`- **predicted blast radius:** ${entry.predictedBlastRadius}`);
  L.push(`- **measured deltas (before → after):**`);
  L.push(`  - dev: ${fmtSplitDelta(entry.metricsBefore.dev, entry.metricsAfter?.dev ?? null)}`);
  L.push(
    `  - validation: ${fmtSplitDelta(entry.metricsBefore.validation, entry.metricsAfter?.validation ?? null)}`,
  );
  L.push(
    `- **debrief:** attribution — ${entry.debrief.attribution}; lesson — ${entry.debrief.lesson || "(none)"}; confidence — ${entry.debrief.confidence}`,
  );
  L.push(`- **artifacts:** ${entry.artifactsPointer}`);
  L.push("");
  return L.join("\n");
}

/** The per-arm ledger file header (format lives in bench/ledger/README.md). */
export function ledgerArmHeader(arm: Arm): string {
  return [
    `# AGENTBENCH refinement ledger — \`${arm}\` arm`,
    "",
    "Append-only. One entry per candidate (accepted, reverted, or parked). See",
    "[README.md](README.md) for the format and the cross-arm feed-forward rule.",
    "",
  ].join("\n");
}

/** The ids already recorded in a ledger file (parsed from the entry markers). */
export function ledgerEntryIds(md: string): Set<string> {
  const ids = new Set<string>();
  for (const m of md.matchAll(/<!-- ledger-entry id="([^"]+)"/g)) ids.add(m[1] as string);
  return ids;
}

/**
 * Append entries to one arm's ledger file, creating it (with the arm header) if absent.
 * Idempotent: an entry whose id is already present is skipped, so re-running a batch
 * never duplicates. Returns the number of entries actually appended.
 */
export function appendLedger(ledgerPath: string, arm: Arm, entries: LedgerEntry[]): number {
  const exists = existsSync(ledgerPath);
  const current = exists ? readFileSync(ledgerPath, "utf8") : ledgerArmHeader(arm);
  const seen = ledgerEntryIds(current);
  const fresh = entries.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) {
    if (!exists) writeFileSync(ledgerPath, current);
    return 0;
  }
  const body = fresh.map(renderLedgerEntry).join("\n");
  const sep = current.endsWith("\n") ? "" : "\n";
  writeFileSync(ledgerPath, `${current}${sep}${body}\n`);
  return fresh.length;
}

/**
 * The most recent lessons from one arm's ledger for the refiner charter: newest ~`max`
 * non-empty lessons, then capped to ~`maxTokens` by dropping the OLDEST first. Returned
 * oldest → newest. Holdout hygiene holds by construction — lessons derive from debriefs
 * that never saw task text.
 */
export function extractLessons(md: string, max = 15, maxTokens = 2000): string[] {
  const lessons: string[] = [];
  for (const m of md.matchAll(/<!-- ledger-entry id="[^"]+" lesson="([^"]*)"/g)) {
    const l = (m[1] ?? "").trim();
    if (l !== "") lessons.push(l);
  }
  let recent = lessons.slice(-max);
  while (recent.length > 0 && estimateTokens(recent.join("\n")) > maxTokens)
    recent = recent.slice(1);
  return recent;
}
