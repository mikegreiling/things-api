/**
 * Unit tests for the refinement-loop core (`bench/loop-core.ts`). No live model, no
 * git, no bench subprocess: the refiner and every side-effecting seam are faked so the
 * control flow and — critically — the accept/revert DECISION MATH are asserted
 * directly. Covers: allowlist rejection, gate revert, accept/revert tie-breaks,
 * the gui needs-mike path, and the state-file append.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  appendLedger,
  appendLoopState,
  Budget,
  BUDGET_ABORT_EXIT_CODE,
  BUDGET_ESTIMATE_ITERATIONS,
  budgetLooksUndersized,
  budgetNote,
  buildCharter,
  buildLedgerEntry,
  classifyBenchExit,
  CONSECUTIVE_PROVIDER_ERROR_LIMIT,
  decideAccept,
  decisionLabel,
  diffStat,
  estimateBatchTokens,
  extractLessons,
  filesInPatch,
  filesOutsideAllowlist,
  isLedgerCandidate,
  isProviderError,
  ledgerFileName,
  LoopAbort,
  matchesAllowlist,
  maxTotalTokensArgs,
  medianRunTokens,
  pairMetrics,
  parseSweepRuns,
  planEdits,
  projectBudget,
  ProviderError,
  RATE_LIMIT_ABORT_EXIT_CODE,
  renderApplyFeedback,
  renderCheckpoint,
  renderLedgerEntry,
  runIteration,
  splitMetrics,
  sumRunTokens,
  SweepParseError,
  toStateEntry,
  type ApplyResult,
  type IterationDeps,
  type IterationParams,
  type IterationResult,
  type PairMetrics,
  type PairRuns,
} from "../../bench/loop-core.ts";
import type {
  CreateOp,
  DebriefInput,
  DebriefOutput,
  EditOp,
  Refiner,
  RefinerInput,
  RefinerOutput,
} from "../../bench/refiner.ts";
import type { RunRecord } from "../../bench/types.ts";

// --- fixtures --------------------------------------------------------------

function makeRun(o: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "/bench/x",
    taskId: "task",
    paraphrase: null,
    rep: 0,
    arm: "cli",
    model: "m",
    provider: "p",
    promptHash: "h",
    gitSha: "g",
    success: true,
    safety: "ok",
    errorsSeen: 0,
    turns: 1,
    toolCalls: 0,
    tokensIn: 100,
    tokensInCached: 0,
    tokensOut: 0,
    staticContextTokens: 0,
    dynamicContextTokens: 0,
    wallMs: 0,
    worldSeed: 1,
    transcript: "t.json",
    ...o,
  };
}

/** `successes` successful runs then the rest failing, all with the given knobs. */
function runsWith(
  successes: number,
  total: number,
  knobs: { errorsSeen?: number; tokensIn?: number; safety?: "ok" | "violated" } = {},
): RunRecord[] {
  return Array.from({ length: total }, (_, i) =>
    makeRun({
      success: i < successes,
      errorsSeen: knobs.errorsSeen ?? 0,
      tokensIn: knobs.tokensIn ?? 100,
      safety: knobs.safety ?? "ok",
    }),
  );
}

function patchFor(...paths: string[]): string {
  return paths
    .map(
      (p) =>
        `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n-old line\n+new line\n`,
    )
    .join("");
}

function editFor(file: string, find = "old line", replace = "new line"): EditOp {
  return { file, find, replace };
}

function refinerOutput(o: Partial<RefinerOutput> = {}): RefinerOutput {
  return {
    classifications: [],
    edits: [editFor("src/cli/help.ts")],
    rationale: "smallest generalizable fix\nsecond line",
    predictedBlastRadius: "one task",
    guiSemanticChange: false,
    ...o,
  };
}

/** A failed apply (validation errors, nothing written). */
function failApply(errors: string[]): ApplyResult {
  return { ok: false, errors, modifiedFiles: [], createdFiles: [], diff: "" };
}

/** A default successful apply: modifies the edited files, creates the created ones. */
function okApply(edits: EditOp[], creates: CreateOp[]): ApplyResult {
  const createdFiles = creates.map((c) => c.file);
  const modifiedFiles = [...new Set(edits.map((e) => e.file))].filter(
    (f) => !createdFiles.includes(f),
  );
  return {
    ok: true,
    errors: [],
    modifiedFiles,
    createdFiles,
    diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line\n",
  };
}

function debriefOutput(o: Partial<DebriefOutput> = {}): DebriefOutput {
  return {
    attribution: "help wording clarified discovery",
    lesson: "name the verb",
    confidence: "medium",
    ...o,
  };
}

/** A full fake Refiner: `refine` resolves `output`, `debrief` resolves `debrief` (or is overridden). */
function fakeRefiner(output: RefinerOutput, over: Partial<Refiner> = {}): Refiner {
  return {
    refine: (_in: RefinerInput) => Promise.resolve(output),
    debrief: (_in: DebriefInput) => Promise.resolve(debriefOutput()),
    ...over,
  };
}

interface Calls {
  applyEdits: Array<{ edits: EditOp[]; creates: CreateOp[] }>;
  runGate: number;
  benchSplits: number;
  revert: Array<{ modified: string[]; created: string[] }>;
  commit: Array<{ message: string; files: string[] }>;
  stashPatch: Array<{ name: string; content: string }>;
  onBudgetWarning: number;
}

function makeDeps(
  output: RefinerOutput,
  overrides: Partial<IterationDeps> = {},
): { deps: IterationDeps; calls: Calls } {
  const calls: Calls = {
    applyEdits: [],
    runGate: 0,
    benchSplits: 0,
    revert: [],
    commit: [],
    stashPatch: [],
    onBudgetWarning: 0,
  };
  const deps: IterationDeps = {
    refiner: fakeRefiner(output),
    readArmFiles: () => ({ "src/cli/help.ts": "body" }),
    loadTranscript: () => null,
    applyEdits: (edits, creates) => {
      calls.applyEdits.push({ edits, creates });
      return okApply(edits, creates);
    },
    runGate: () => {
      calls.runGate++;
      return { ok: true, output: "" };
    },
    benchSplits: () => {
      calls.benchSplits++;
      return { dev: runsWith(1, 3), validation: runsWith(2, 2) };
    },
    revert: (modified, created) => {
      calls.revert.push({ modified, created });
    },
    commit: (message, files) => {
      calls.commit.push({ message, files });
    },
    stashPatch: (name, content) => {
      calls.stashPatch.push({ name, content });
      return `/out/${name}`;
    },
    onBudgetWarning: () => {
      calls.onBudgetWarning++;
    },
    log: () => {},
    ...overrides,
  };
  return { deps, calls };
}

/** Fresh per-call params with a roomy budget unless a test overrides it. */
function emptyParams(): Pick<IterationParams, "iteration" | "prevRuns" | "tasks" | "budget"> {
  return {
    iteration: 1,
    prevRuns: { dev: [], validation: [] },
    tasks: new Map(),
    budget: new Budget(1e12),
  };
}

// --- patch parsing + allowlist --------------------------------------------

describe("patch parsing + allowlist", () => {
  it("extracts touched files from a unified diff", () => {
    expect(filesInPatch(patchFor("src/cli/help.ts", "skills/things-cli/SKILL.md"))).toEqual([
      "src/cli/help.ts",
      "skills/things-cli/SKILL.md",
    ]);
  });

  it("matches * (one segment) and ** (any depth)", () => {
    expect(matchesAllowlist("src/cli/commands/todo.ts", ["src/cli/commands/*.ts"])).toBe(true);
    expect(matchesAllowlist("src/cli/commands/nested/x.ts", ["src/cli/commands/*.ts"])).toBe(false);
    expect(matchesAllowlist("skills/things-cli/references/gui.md", ["skills/things-cli/**"])).toBe(
      true,
    );
    expect(matchesAllowlist("skills/things-cli/SKILL.md", ["skills/things-cli/**"])).toBe(true);
  });

  it("flags files outside the allowlist", () => {
    const patch = patchFor("src/cli/help.ts", "src/index.ts");
    expect(filesOutsideAllowlist(patch, ["src/cli/help.ts"])).toEqual(["src/index.ts"]);
  });
});

// --- decision math (tested directly) ---------------------------------------

function metrics(dev: RunRecord[], validation: RunRecord[]): PairMetrics {
  return pairMetrics({ dev, validation });
}

describe("decideAccept (metric ladder)", () => {
  const baseValidation = runsWith(2, 2);

  it("accepts on dev success ↑ (non-inferior validation)", () => {
    const before = metrics(runsWith(1, 3), baseValidation);
    const after = metrics(runsWith(2, 3), baseValidation);
    const d = decideAccept(before, after, false);
    expect(d.accept).toBe(true);
    expect(d.reason).toContain("dev success");
  });

  it("rejects a safety regression regardless of success gains", () => {
    const before = metrics(runsWith(1, 3), baseValidation);
    const after = metrics(runsWith(3, 3, { safety: "violated" }), baseValidation);
    const d = decideAccept(before, after, false);
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("safety regression");
  });

  it("rejects when validation success regresses even if dev improves", () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const after = metrics(runsWith(3, 3), runsWith(1, 2));
    const d = decideAccept(before, after, false);
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("validation success regressed");
  });

  it("tie-break 2: dev success = , friction ↓ → accept", () => {
    const before = metrics(runsWith(2, 3, { errorsSeen: 2 }), baseValidation);
    const after = metrics(runsWith(2, 3, { errorsSeen: 1 }), baseValidation);
    const d = decideAccept(before, after, false);
    expect(d.accept).toBe(true);
    expect(d.reason).toContain("friction ↓");
  });

  it("tie-break 2 does NOT fire when friction rises", () => {
    const before = metrics(runsWith(2, 3, { errorsSeen: 1 }), baseValidation);
    const after = metrics(runsWith(2, 3, { errorsSeen: 2 }), baseValidation);
    expect(decideAccept(before, after, false).accept).toBe(false);
  });

  it("tie-break 3: success = , friction = , median tokensIn ↓ ≥10% → accept", () => {
    const before = metrics(runsWith(2, 3, { tokensIn: 1000 }), baseValidation);
    const after = metrics(runsWith(2, 3, { tokensIn: 900 }), baseValidation);
    const d = decideAccept(before, after, false);
    expect(d.accept).toBe(true);
    expect(d.reason).toContain("tokensIn");
  });

  it("tie-break 3 does NOT fire for a <10% token reduction", () => {
    const before = metrics(runsWith(2, 3, { tokensIn: 1000 }), baseValidation);
    const after = metrics(runsWith(2, 3, { tokensIn: 950 }), baseValidation);
    expect(decideAccept(before, after, false).accept).toBe(false);
  });

  it("gui-semantic change is never auto-accepted; it needs Mike", () => {
    const before = metrics(runsWith(1, 3), baseValidation);
    const after = metrics(runsWith(3, 3), baseValidation);
    const d = decideAccept(before, after, true);
    expect(d.accept).toBe(false);
    expect(d.needsMike).toBe(true);
  });

  it("friction efficiency is measured over successful runs only", () => {
    const m = splitMetrics([
      makeRun({ success: true, errorsSeen: 0 }),
      makeRun({ success: false, errorsSeen: 5 }),
    ]);
    expect(m.frictionOnSuccesses).toBe(0);
    expect(m.safetyViolations).toBe(0);
  });
});

// --- runIteration control flow ---------------------------------------------

describe("runIteration", () => {
  it("reverts (no commit, no re-bench) when the gate fails", async () => {
    const { deps, calls } = makeDeps(refinerOutput(), {
      runGate: () => ({ ok: false, output: "typecheck error" }),
    });
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("gate failed");
    expect(calls.applyEdits).toHaveLength(1);
    expect(calls.benchSplits).toBe(0);
    expect(calls.revert).toEqual([{ modified: ["src/cli/help.ts"], created: [] }]);
    expect(calls.commit).toHaveLength(0);
  });

  it("commits when the re-bench improves dev success", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps, calls } = makeDeps(refinerOutput(), {
      benchSplits: (): PairRuns => ({ dev: runsWith(2, 3), validation: runsWith(2, 2) }),
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(true);
    expect(calls.commit).toHaveLength(1);
    expect(calls.commit[0]?.message).toContain("loop(cli) iter 1:");
    expect(calls.commit[0]?.files).toEqual(["src/cli/help.ts"]);
    expect(calls.revert).toHaveLength(0);
    expect(result.afterRuns).not.toBeNull();
  });

  it("reverts when the re-bench shows no improvement", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps, calls } = makeDeps(refinerOutput(), {
      benchSplits: (): PairRuns => ({ dev: runsWith(1, 3), validation: runsWith(2, 2) }),
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("no dev improvement");
    expect(calls.commit).toHaveLength(0);
    expect(calls.revert).toEqual([{ modified: ["src/cli/help.ts"], created: [] }]);
  });

  it("parks a gui-semantic change for Mike and reverts (no re-bench, no commit)", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps, calls } = makeDeps(
      refinerOutput({
        edits: [editFor("skills/things-cli/references/gui.md")],
        guiSemanticChange: true,
      }),
    );
    const result = await runIteration(deps, {
      arm: "skill",
      prevMetrics: before,
      ...emptyParams(),
    });
    expect(result.accepted).toBe(false);
    expect(result.needsMike).toBe(true);
    expect(result.needsMikePatchPath).toBe("/out/needs-mike-iter1.patch");
    // The stashed content is the REAL applied diff (not a model-authored patch).
    expect(calls.stashPatch[0]?.content).toContain("+new line");
    expect(calls.benchSplits).toBe(0);
    expect(calls.commit).toHaveLength(0);
    expect(calls.revert).toEqual([
      { modified: ["skills/things-cli/references/gui.md"], created: [] },
    ]);
  });

  it("treats an empty edits list as a no-op no-accept (no apply, no re-bench)", async () => {
    const { deps, calls } = makeDeps(refinerOutput({ edits: [] }));
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("no edits proposed");
    expect(calls.applyEdits).toHaveLength(0);
    expect(calls.benchSplits).toBe(0);
  });

  it("commits created files too when a create is part of the candidate", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps, calls } = makeDeps(
      refinerOutput({
        edits: [editFor("src/cli/help.ts")],
        creates: [{ file: "src/cli/commands/new.ts", content: "export {};\n" }],
      }),
      { benchSplits: (): PairRuns => ({ dev: runsWith(2, 3), validation: runsWith(2, 2) }) },
    );
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(true);
    expect(calls.commit[0]?.files).toEqual(["src/cli/help.ts", "src/cli/commands/new.ts"]);
  });
});

// --- usage fail-safe: budget math ------------------------------------------

describe("Budget", () => {
  it("accumulates tokensIn+tokensOut and computes fraction/remaining", () => {
    const b = new Budget(1000);
    b.add({ tokensIn: 300, tokensOut: 100 });
    expect(b.usedTokens).toBe(400);
    expect(b.fraction()).toBeCloseTo(0.4);
    expect(b.remaining()).toBe(600);
  });

  it("crosses the 60% warn threshold exactly once", () => {
    const b = new Budget(1000);
    b.add({ tokensIn: 590, tokensOut: 0 });
    expect(b.crossedWarnThreshold()).toBe(false);
    b.add({ tokensIn: 20, tokensOut: 0 }); // now 61%
    expect(b.crossedWarnThreshold()).toBe(true);
    expect(b.crossedWarnThreshold()).toBe(false); // only once
  });

  it("assertUnderBudget throws a token-budget LoopAbort (exit 8) at 100%", () => {
    const b = new Budget(1000);
    b.add({ tokensIn: 1000, tokensOut: 0 });
    try {
      b.assertUnderBudget("test phase");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LoopAbort);
      expect((e as LoopAbort).kind).toBe("token-budget");
      expect((e as LoopAbort).code).toBe(BUDGET_ABORT_EXIT_CODE);
    }
  });

  it("trips the rate-limit breaker (exit 9) on the Nth consecutive provider error", () => {
    const b = new Budget(1000);
    for (let i = 0; i < CONSECUTIVE_PROVIDER_ERROR_LIMIT - 1; i++) b.recordProviderError();
    expect(b.consecutiveProviderErrors).toBe(CONSECUTIVE_PROVIDER_ERROR_LIMIT - 1);
    try {
      b.recordProviderError();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LoopAbort);
      expect((e as LoopAbort).kind).toBe("rate-limit");
      expect((e as LoopAbort).code).toBe(RATE_LIMIT_ABORT_EXIT_CODE);
    }
  });

  it("resetProviderErrors clears the streak so it never trips", () => {
    const b = new Budget(1000);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < CONSECUTIVE_PROVIDER_ERROR_LIMIT - 1; i++) b.recordProviderError();
      b.resetProviderErrors();
    }
    expect(b.consecutiveProviderErrors).toBe(0);
  });

  it("sumRunTokens totals tokensIn+tokensOut across runs", () => {
    const runs = [
      makeRun({ tokensIn: 100, tokensOut: 10 }),
      makeRun({ tokensIn: 50, tokensOut: 5 }),
    ];
    expect(sumRunTokens(runs)).toEqual({ tokensIn: 150, tokensOut: 15 });
  });

  it("maxTotalTokensArgs passes the flag only when supported and budget remains", () => {
    expect(maxTotalTokensArgs(true, 5000)).toEqual(["--max-total-tokens", "5000"]);
    expect(maxTotalTokensArgs(false, 5000)).toEqual([]);
    expect(maxTotalTokensArgs(true, 0)).toEqual([]);
  });

  it("isProviderError detects 429 / quota / 5xx signatures", () => {
    expect(isProviderError(new ProviderError("x"))).toBe(true);
    expect(isProviderError({ status: 429 })).toBe(true);
    expect(isProviderError({ status: 503 })).toBe(true);
    expect(isProviderError("Error: rate limit exceeded")).toBe(true);
    expect(isProviderError("insufficient_quota")).toBe(true);
    expect(isProviderError(new Error("bad argument"))).toBe(false);
  });
});

// --- bench subprocess exit classification (runner budget-cap → clean abort) --

describe("classifyBenchExit", () => {
  it("returns (no throw) on a clean exit 0", () => {
    expect(() =>
      classifyBenchExit("dev", { status: 0, stdout: "wrote 6 runs", stderr: "" }),
    ).not.toThrow();
  });

  it("maps the runner's --max-total-tokens cap (exit 8) to a clean token-budget LoopAbort", () => {
    try {
      classifyBenchExit("dev", {
        status: BUDGET_ABORT_EXIT_CODE,
        stdout: "token budget exceeded",
        stderr: "",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LoopAbort);
      expect((e as LoopAbort).kind).toBe("token-budget");
      expect((e as LoopAbort).code).toBe(BUDGET_ABORT_EXIT_CODE);
      expect((e as LoopAbort).message).toContain("split=dev");
    }
  });

  it("maps a provider-error exit to a ProviderError (circuit breaker), not an abort", () => {
    try {
      classifyBenchExit("validation", {
        status: 1,
        stdout: "",
        stderr: "Error: 429 rate limit exceeded",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect(e).not.toBeInstanceOf(LoopAbort);
    }
  });

  it("raises any OTHER nonzero exit as a hard Error (never a silent abort)", () => {
    let thrown: unknown;
    try {
      classifyBenchExit("dev", { status: 1, stdout: "", stderr: "corrupt patch" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(LoopAbort);
    expect(thrown).not.toBeInstanceOf(ProviderError);
    expect((thrown as Error).message).toContain("exit=1");
  });

  it("treats a null status (spawn failure) as a hard Error", () => {
    expect(() => classifyBenchExit("dev", { status: null, stdout: "", stderr: "" })).toThrow(Error);
  });
});

describe("runner budget-cap → clean abort artifacts", () => {
  it("a bench sweep exit 8 reverts the applied patch and unwinds as a token-budget LoopAbort", async () => {
    // The fixed benchSplit turns a runner exit 8 into exactly this LoopAbort; drive
    // runIteration with a benchSplits seam that does the same and assert the loop reverts
    // the applied-but-unaccepted patch and re-throws the abort — so the outer driver
    // finalizes (ledger + checkpoint, exit 8) instead of crashing on an unhandled error.
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps, calls } = makeDeps(refinerOutput(), {
      benchSplits: (): PairRuns => {
        classifyBenchExit("dev", {
          status: BUDGET_ABORT_EXIT_CODE,
          stdout: "token budget exceeded",
          stderr: "",
        });
        return { dev: [], validation: [] }; // unreachable — classifyBenchExit throws
      },
    });
    await expect(
      runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() }),
    ).rejects.toMatchObject({ kind: "token-budget", code: BUDGET_ABORT_EXIT_CODE });
    expect(calls.applyEdits).toHaveLength(1);
    expect(calls.runGate).toBe(1);
    expect(calls.commit).toHaveLength(0);
    expect(calls.revert).toEqual([{ modified: ["src/cli/help.ts"], created: [] }]);
  });

  it("renders the checkpoint with the holdout SKIPPED on a clean abort", () => {
    // The finalize path passes holdout=null + a note when the loop aborts; the checkpoint
    // records the holdout as skipped rather than silently omitting it.
    const md = renderCheckpoint({
      arm: "cli",
      subjectModel: "m",
      refinerModel: "r",
      reps: 3,
      results: [],
      baselineMetrics: metrics(runsWith(1, 3), runsWith(2, 2)),
      finalMetrics: metrics(runsWith(1, 3), runsWith(2, 2)),
      holdout: null,
      holdoutNote: "token-budget abort — holdout not run",
      needsMikePatches: [],
      stopReason: "ABORTED (token-budget): budget exhausted",
    });
    expect(md).toContain("holdout: SKIPPED");
    expect(md).toContain("token-budget abort — holdout not run");
  });
});

// --- startup cost projection (token-budget sizing guidance) ----------------

describe("startup cost projection", () => {
  it("medianRunTokens sums tokensIn+tokensOut per run then takes the median", () => {
    const runs = [
      makeRun({ tokensIn: 100, tokensOut: 0 }),
      makeRun({ tokensIn: 200, tokensOut: 50 }),
      makeRun({ tokensIn: 300, tokensOut: 100 }),
    ];
    expect(medianRunTokens(runs)).toBe(250); // 100, 250, 400 → median 250
  });

  it("estimateBatchTokens prices baseline + iterations at the per-run median", () => {
    const runs = Array.from({ length: 4 }, () => makeRun({ tokensIn: 1000, tokensOut: 0 }));
    // 4 runs × 1000 median × (1 baseline + 2 iterations) = 12000
    expect(estimateBatchTokens(runs, 2)).toBe(12000);
    expect(estimateBatchTokens(runs, 0)).toBe(4000); // baseline only
  });

  it("budgetLooksUndersized flags a budget below 1.5× the estimate", () => {
    expect(budgetLooksUndersized(10_000, 8_000)).toBe(true); // 10k < 12k
    expect(budgetLooksUndersized(12_000, 8_000)).toBe(false); // exactly 1.5×
    expect(budgetLooksUndersized(20_000, 8_000)).toBe(false);
  });

  it("projectBudget WARNS (loudly) when the budget is too small, and reports the numbers", () => {
    const runs = Array.from({ length: 4 }, () => makeRun({ tokensIn: 1000, tokensOut: 0 }));
    const p = projectBudget(runs, 10_000, 5);
    expect(p.estimate).toBe(estimateBatchTokens(runs, BUDGET_ESTIMATE_ITERATIONS)); // 12000
    expect(p.medianTokensPerRun).toBe(1000);
    expect(p.baselineRuns).toBe(4);
    expect(p.undersized).toBe(true);
    expect(p.warning).not.toBeNull();
    expect(p.warning).toContain("UNDERSIZED");
    expect(p.line).toContain("cost projection");
  });

  it("projectBudget stays quiet (no warning) when the budget is ample", () => {
    const runs = Array.from({ length: 4 }, () => makeRun({ tokensIn: 1000, tokensOut: 0 }));
    const p = projectBudget(runs, 1_000_000, 5);
    expect(p.undersized).toBe(false);
    expect(p.warning).toBeNull();
  });
});

// --- usage fail-safe: runIteration abort paths -----------------------------

describe("runIteration budget/circuit-breaker", () => {
  it("aborts (LoopAbort exit 8) BEFORE the refiner call when already over budget", async () => {
    const { deps, calls } = makeDeps(refinerOutput());
    const budget = new Budget(100);
    budget.add({ tokensIn: 100, tokensOut: 0 }); // at 100%
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    await expect(
      runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams(), budget }),
    ).rejects.toMatchObject({ kind: "token-budget", code: BUDGET_ABORT_EXIT_CODE });
    expect(calls.applyEdits).toHaveLength(0);
  });

  it("reverts the applied patch when the budget aborts before the re-bench", async () => {
    // Under budget before the refiner; the refiner's own usage pushes it to 100%, so
    // the re-bench gate (after apply+gate) trips a clean abort that must revert.
    const { deps, calls } = makeDeps(refinerOutput({ usage: { tokensIn: 100, tokensOut: 0 } }));
    const budget = new Budget(100);
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    await expect(
      runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams(), budget }),
    ).rejects.toMatchObject({ kind: "token-budget", code: BUDGET_ABORT_EXIT_CODE });
    expect(calls.applyEdits).toHaveLength(1);
    expect(calls.runGate).toBe(1);
    expect(calls.benchSplits).toBe(0);
    expect(calls.revert).toEqual([{ modified: ["src/cli/help.ts"], created: [] }]); // unapplied change reverted
  });

  it("counts a refiner provider error as a no-accept without applying", async () => {
    const budget = new Budget(1e9);
    const { deps, calls } = makeDeps(refinerOutput(), {
      refiner: fakeRefiner(refinerOutput(), {
        refine: () => Promise.reject(new ProviderError("429 rate limit")),
      }),
    });
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const result = await runIteration(deps, {
      arm: "cli",
      prevMetrics: before,
      ...emptyParams(),
      budget,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("provider error");
    expect(calls.applyEdits).toHaveLength(0);
    expect(budget.consecutiveProviderErrors).toBe(1);
  });

  it("trips the rate-limit breaker on the Nth consecutive refiner provider error", async () => {
    const budget = new Budget(1e9);
    for (let i = 0; i < CONSECUTIVE_PROVIDER_ERROR_LIMIT - 1; i++) budget.recordProviderError();
    const { deps } = makeDeps(refinerOutput(), {
      refiner: fakeRefiner(refinerOutput(), {
        refine: () => Promise.reject(new ProviderError("503")),
      }),
    });
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    await expect(
      runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams(), budget }),
    ).rejects.toMatchObject({ kind: "rate-limit", code: RATE_LIMIT_ABORT_EXIT_CODE });
  });

  it("emits the budget warning once when refiner usage crosses 60%", async () => {
    const budget = new Budget(100);
    budget.add({ tokensIn: 59, tokensOut: 0 });
    const { deps, calls } = makeDeps(refinerOutput({ usage: { tokensIn: 1, tokensOut: 0 } }), {
      benchSplits: (): PairRuns => ({ dev: runsWith(2, 3), validation: runsWith(2, 2) }),
    });
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams(), budget });
    expect(calls.onBudgetWarning).toBe(1);
  });

  it("budgetNote captures used/limit for the state log", () => {
    const b = new Budget(1000);
    b.add({ tokensIn: 700, tokensOut: 0 });
    const note = budgetNote("cli", "abort", "over budget", b, "2026-07-17T00:00:00Z");
    expect(note).toMatchObject({ kind: "abort", usedTokens: 700, limit: 1000, arm: "cli" });
  });
});

// --- state-file append -----------------------------------------------------

describe("appendLoopState", () => {
  function makeResult(o: Partial<IterationResult> = {}): IterationResult {
    return {
      iteration: 1,
      arm: "cli",
      digestHash: "abc123",
      accepted: true,
      needsMike: false,
      reason: "dev success ↑",
      rationale: "fix discovery",
      predictedBlastRadius: "discovery family",
      patchSummary: "1 file",
      classifications: [{ taskId: "t", class: "discovery", note: "n" }],
      guiSemanticChange: false,
      metricsBefore: metrics(runsWith(1, 3), runsWith(2, 2)),
      metricsAfter: metrics(runsWith(2, 3), runsWith(2, 2)),
      afterRuns: null,
      debrief: { attribution: "clearer verb", lesson: "name the verb", confidence: "medium" },
      applyFailed: false,
      touchedFiles: ["src/cli/help.ts"],
      ...o,
    };
  }

  it("creates the file then appends, preserving prior entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-state-"));
    const path = join(dir, "loop-state.json");

    appendLoopState(path, toStateEntry(makeResult({ iteration: 1 }), "2026-07-17T00:00:00Z"));
    appendLoopState(
      path,
      toStateEntry(
        makeResult({ iteration: 2, accepted: false, reason: "no dev improvement" }),
        "2026-07-17T00:01:00Z",
      ),
    );

    const parsed = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.iteration).toBe(1);
    expect(parsed[0]?.decision).toBe("accept");
    expect(parsed[0]?.digestHash).toBe("abc123");
    expect(parsed[1]?.iteration).toBe(2);
    expect(parsed[1]?.decision).toBe("revert");
  });

  it("labels decisions (accept / revert / needs-mike)", () => {
    expect(decisionLabel(makeResult({ accepted: true }))).toBe("accept");
    expect(decisionLabel(makeResult({ accepted: false, needsMike: true }))).toBe("needs-mike");
    expect(decisionLabel(makeResult({ accepted: false, needsMike: false }))).toBe("revert");
  });
});

// --- post-hoc debrief ------------------------------------------------------

describe("runIteration debrief", () => {
  it("records a debrief on the ACCEPTED path", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps } = makeDeps(refinerOutput(), {
      refiner: fakeRefiner(refinerOutput(), {
        debrief: () =>
          Promise.resolve({
            attribution: "helped discovery",
            lesson: "state the verb",
            confidence: "high",
          }),
      }),
      benchSplits: (): PairRuns => ({ dev: runsWith(2, 3), validation: runsWith(2, 2) }),
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(true);
    expect(result.debrief).toEqual({
      attribution: "helped discovery",
      lesson: "state the verb",
      confidence: "high",
    });
  });

  it("records a debrief on the REVERTED path too", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps } = makeDeps(refinerOutput(), {
      refiner: fakeRefiner(refinerOutput(), {
        debrief: () =>
          Promise.resolve({
            attribution: "no measurable effect",
            lesson: "avoid cosmetic edits",
            confidence: "low",
          }),
      }),
      benchSplits: (): PairRuns => ({ dev: runsWith(1, 3), validation: runsWith(2, 2) }),
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("no dev improvement");
    expect(result.debrief.lesson).toBe("avoid cosmetic edits");
  });

  it("does NOT block the loop when the debrief call fails", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps, calls } = makeDeps(refinerOutput(), {
      refiner: fakeRefiner(refinerOutput(), {
        debrief: () => Promise.reject(new ProviderError("debrief 503")),
      }),
      benchSplits: (): PairRuns => ({ dev: runsWith(2, 3), validation: runsWith(2, 2) }),
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(true); // still committed
    expect(calls.commit).toHaveLength(1);
    expect(result.debrief.attribution).toBe("debrief-failed");
  });
});

// --- charter feed-forward --------------------------------------------------

describe("buildCharter prior lessons", () => {
  it("injects a Prior lessons section for the arm's lessons", () => {
    const charter = buildCharter("cli", [
      "name the verb before its object",
      "prefer one precise edit",
    ]);
    expect(charter).toContain("PRIOR LESSONS (this arm)");
    expect(charter).toContain("name the verb before its object");
  });

  it("omits the section when there are no prior lessons", () => {
    expect(buildCharter("cli", [])).not.toContain("PRIOR LESSONS");
  });
});

// --- per-arm ledger --------------------------------------------------------

function iterationResult(o: Partial<IterationResult> = {}): IterationResult {
  return {
    iteration: 1,
    arm: "cli",
    digestHash: "d00d",
    accepted: true,
    needsMike: false,
    reason: "dev success ↑",
    rationale: "clarify inbox wording\n(second line)",
    predictedBlastRadius: "reads-inbox family",
    patchSummary: "1 file(s) [src/cli/help.ts], +3/-1",
    classifications: [],
    guiSemanticChange: false,
    metricsBefore: metrics(runsWith(1, 3), runsWith(2, 2)),
    metricsAfter: metrics(runsWith(2, 3), runsWith(2, 2)),
    afterRuns: null,
    debrief: {
      attribution: "clearer inbox copy",
      lesson: "define state before container",
      confidence: "medium",
    },
    applyFailed: false,
    touchedFiles: ["src/cli/help.ts"],
    ...o,
  };
}

describe("ledger rendering", () => {
  it("ledgerFileName is per-arm", () => {
    expect(ledgerFileName("cli")).toBe("cli.md");
    expect(ledgerFileName("skill")).toBe("skill.md");
    expect(ledgerFileName("mcp")).toBe("mcp.md");
  });

  it("isLedgerCandidate selects accepted, reverted, needs-mike, and apply-failed — not bare rejects", () => {
    expect(isLedgerCandidate(iterationResult({ accepted: true }))).toBe(true);
    expect(
      isLedgerCandidate(iterationResult({ accepted: false, metricsAfter: metrics([], []) })),
    ).toBe(true);
    expect(
      isLedgerCandidate(iterationResult({ accepted: false, needsMike: true, metricsAfter: null })),
    ).toBe(true);
    expect(
      isLedgerCandidate(
        iterationResult({ accepted: false, applyFailed: true, metricsAfter: null }),
      ),
    ).toBe(true);
    // gate/provider reject: no re-bench, not parked, applied cleanly → no ledger entry
    expect(
      isLedgerCandidate(iterationResult({ accepted: false, needsMike: false, metricsAfter: null })),
    ).toBe(false);
  });

  it("renders an APPLY-FAILED entry with preserved hypothesis and no measured deltas", () => {
    const entry = buildLedgerEntry(
      iterationResult({
        accepted: false,
        applyFailed: true,
        metricsAfter: null,
        reason: "apply failed: find not found in src/cli/help.ts",
        patchSummary: "1 file(s) attempted [src/cli/help.ts], not applied",
      }),
      { batchId: "b", date: "2026-07-17", artifactsPointer: "x" },
    );
    const md = renderLedgerEntry(entry);
    expect(md).toContain("**APPLY-FAILED**");
    expect(md).toContain("not measured (no re-bench)");
    // hypothesis is preserved even though the change never landed
    expect(md).toContain("**pre-hoc hypothesis:** clarify inbox wording");
  });

  it("renders an entry with a machine-readable id+lesson marker and the human body", () => {
    const entry = buildLedgerEntry(iterationResult(), {
      batchId: "loop-cli-0",
      date: "2026-07-17",
      artifactsPointer: "loop-state: bench/loop-state.json; checkpoint: out/checkpoint.md",
    });
    const md = renderLedgerEntry(entry);
    expect(md).toContain(
      '<!-- ledger-entry id="loop-cli-0-cli-iter1" lesson="define state before container" -->',
    );
    expect(md).toContain("**ACCEPTED**");
    // The change summary is the FIRST line of the rationale only …
    expect(md).toContain("**change:** clarify inbox wording — files: src/cli/help.ts");
    // … while the pre-hoc hypothesis carries the full rationale.
    expect(md).toContain("**pre-hoc hypothesis:** clarify inbox wording");
    expect(md).toContain("attribution — clearer inbox copy");
    expect(md).toContain("success 1/3 → 2/3");
  });

  it("shows 'not measured' deltas for a needs-mike candidate", () => {
    const entry = buildLedgerEntry(
      iterationResult({ accepted: false, needsMike: true, metricsAfter: null }),
      { batchId: "b", date: "2026-07-17", artifactsPointer: "x" },
    );
    const md = renderLedgerEntry(entry);
    expect(md).toContain("**NEEDS-MIKE**");
    expect(md).toContain("not measured (no re-bench)");
  });
});

function ledgerWith(lessons: string[]): string {
  return lessons
    .map((l, i) => `<!-- ledger-entry id="b-cli-iter${i}" lesson="${l}" -->\n### entry ${i}\n`)
    .join("\n");
}

const longLesson = (n: number): string => `lesson ${n} ${"x".repeat(95)}`;

describe("extractLessons", () => {
  it("returns the most recent lessons, oldest→newest, capped by count", () => {
    const md = ledgerWith(["l1", "l2", "l3", "l4"]);
    expect(extractLessons(md, 2)).toEqual(["l3", "l4"]);
  });

  it("skips empty lessons (debrief-failed/skipped entries contribute nothing)", () => {
    const md = ledgerWith(["kept-1", "", "kept-2"]);
    expect(extractLessons(md, 15)).toEqual(["kept-1", "kept-2"]);
  });

  it("drops OLDEST first to fit the token cap", () => {
    // ~25 tokens each (~100 chars); a 30-token cap keeps only the newest.
    const md = ledgerWith([longLesson(1), longLesson(2), longLesson(3)]);
    const kept = extractLessons(md, 15, 30);
    expect(kept.length).toBeLessThan(3);
    expect(kept.at(-1)).toContain("lesson 3");
    expect(kept.join("\n")).not.toContain("lesson 1");
  });
});

describe("appendLedger idempotence", () => {
  it("creates the arm file, appends once, and never duplicates across re-runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const path = join(dir, "cli.md");
    const batch1 = [
      buildLedgerEntry(iterationResult({ iteration: 1 }), {
        batchId: "b1",
        date: "2026-07-17",
        artifactsPointer: "a",
      }),
      buildLedgerEntry(
        iterationResult({
          iteration: 2,
          accepted: false,
          metricsAfter: metrics(runsWith(1, 3), runsWith(2, 2)),
        }),
        { batchId: "b1", date: "2026-07-17", artifactsPointer: "a" },
      ),
    ];

    expect(appendLedger(path, "cli", batch1)).toBe(2);
    expect(appendLedger(path, "cli", batch1)).toBe(0); // idempotent re-run of the same batch
    const md = readFileSync(path, "utf8");
    expect(md).toContain("# AGENTBENCH refinement ledger — `cli` arm");
    expect((md.match(/ledger-entry id="b1-cli-iter1"/g) ?? []).length).toBe(1);

    // A distinct batch appends its own entries without touching the prior ones.
    const batch2 = [
      buildLedgerEntry(iterationResult({ iteration: 1 }), {
        batchId: "b2",
        date: "2026-07-18",
        artifactsPointer: "a",
      }),
    ];
    expect(appendLedger(path, "cli", batch2)).toBe(1);
    const md2 = readFileSync(path, "utf8");
    expect((md2.match(/<!-- ledger-entry /g) ?? []).length).toBe(3);
  });
});

// --- exact find/replace edit contract --------------------------------------

const HELP_BODY = "line A\nUNIQUE_ANCHOR\nline B\nDUP\nDUP\n";

describe("planEdits contract", () => {
  const allow = ["src/cli/help.ts", "src/cli/commands/*.ts"];
  const read = (f: string): string | null => (f === "src/cli/help.ts" ? HELP_BODY : null);

  it("applies a unique find/replace", () => {
    const plan = planEdits(
      [{ file: "src/cli/help.ts", find: "UNIQUE_ANCHOR", replace: "REPLACED" }],
      [],
      allow,
      read,
    );
    expect(plan.ok).toBe(true);
    expect(plan.writes).toEqual([
      {
        file: "src/cli/help.ts",
        content: HELP_BODY.replace("UNIQUE_ANCHOR", "REPLACED"),
        isNew: false,
      },
    ]);
  });

  it("supports an empty replace (pure deletion)", () => {
    const plan = planEdits(
      [{ file: "src/cli/help.ts", find: "UNIQUE_ANCHOR\n", replace: "" }],
      [],
      allow,
      read,
    );
    expect(plan.ok).toBe(true);
    expect(plan.writes[0]?.content).not.toContain("UNIQUE_ANCHOR");
  });

  it("rejects an edit whose file is outside the arm allowlist", () => {
    const plan = planEdits([{ file: "src/index.ts", find: "x", replace: "y" }], [], allow, read);
    expect(plan.ok).toBe(false);
    expect(plan.errors[0]).toContain("not in arm allowlist");
    expect(plan.writes).toHaveLength(0);
  });

  it("rejects a find that is missing", () => {
    const plan = planEdits(
      [{ file: "src/cli/help.ts", find: "NOPE", replace: "y" }],
      [],
      allow,
      read,
    );
    expect(plan.ok).toBe(false);
    expect(plan.errors[0]).toContain("find not found");
  });

  it("rejects a find that is not unique", () => {
    const plan = planEdits(
      [{ file: "src/cli/help.ts", find: "DUP", replace: "y" }],
      [],
      allow,
      read,
    );
    expect(plan.ok).toBe(false);
    expect(plan.errors[0]).toContain("matched 2 times");
  });

  it("is atomic — one bad edit voids the whole set (no writes)", () => {
    const plan = planEdits(
      [
        { file: "src/cli/help.ts", find: "UNIQUE_ANCHOR", replace: "ok" },
        { file: "src/cli/help.ts", find: "NOPE", replace: "y" },
      ],
      [],
      allow,
      read,
    );
    expect(plan.ok).toBe(false);
    expect(plan.writes).toHaveLength(0); // the valid edit is NOT applied either
  });

  it("composes multiple edits to one file in order", () => {
    const plan = planEdits(
      [
        { file: "src/cli/help.ts", find: "line A", replace: "line A2" },
        { file: "src/cli/help.ts", find: "line B", replace: "line B2" },
      ],
      [],
      allow,
      read,
    );
    expect(plan.ok).toBe(true);
    expect(plan.writes[0]?.content).toContain("line A2");
    expect(plan.writes[0]?.content).toContain("line B2");
  });

  it("creates an allowlisted new file; rejects an existing target or one out of scope", () => {
    const okc = planEdits([], [{ file: "src/cli/commands/new.ts", content: "x" }], allow, read);
    expect(okc.ok).toBe(true);
    expect(okc.writes[0]).toEqual({ file: "src/cli/commands/new.ts", content: "x", isNew: true });

    const exists = planEdits([], [{ file: "src/cli/help.ts", content: "x" }], allow, read);
    expect(exists.ok).toBe(false);
    expect(exists.errors[0]).toContain("already exists");

    const outside = planEdits([], [{ file: "src/index.ts", content: "x" }], allow, read);
    expect(outside.ok).toBe(false);
  });

  it("diffStat counts adds/removes; renderApplyFeedback lists the errors", () => {
    expect(diffStat("--- a/x\n+++ b/x\n+one\n+two\n-old\n")).toBe("+2/-1");
    const fb = renderApplyFeedback(["find not found in x", "find matched 3 times"]);
    expect(fb).toContain("find not found in x");
    expect(fb).toContain("DID NOT APPLY");
  });
});

describe("runIteration apply-retry", () => {
  it("retries ONCE with the errors appended, then applies and commits", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const applied: EditOp[][] = [];
    const seen: string[] = [];
    const { deps, calls } = makeDeps(refinerOutput(), {
      refiner: {
        refine: (i: RefinerInput) => {
          seen.push(i.userContent);
          return Promise.resolve(refinerOutput());
        },
        debrief: () => Promise.resolve(debriefOutput()),
      },
      applyEdits: (edits: EditOp[], creates: CreateOp[]) => {
        applied.push(edits);
        return applied.length === 1
          ? failApply(["find not found in src/cli/help.ts"])
          : okApply(edits, creates);
      },
      benchSplits: (): PairRuns => ({ dev: runsWith(2, 3), validation: runsWith(2, 2) }),
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(applied).toHaveLength(2); // one failed attempt + one successful retry
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("DID NOT APPLY"); // feedback appended on the retry
    expect(result.accepted).toBe(true);
    expect(calls.commit).toHaveLength(1);
  });

  it("gives up after the retry → apply-failed candidate (no re-bench, no commit, ledger-worthy)", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    let attempts = 0;
    const { deps, calls } = makeDeps(refinerOutput(), {
      applyEdits: (_edits: EditOp[], _creates: CreateOp[]) => {
        attempts++;
        return failApply(["find matched 2 times in src/cli/help.ts (must be unique)"]);
      },
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(attempts).toBe(2); // initial + one retry
    expect(result.applyFailed).toBe(true);
    expect(result.reason).toContain("apply failed");
    expect(calls.benchSplits).toBe(0);
    expect(calls.commit).toHaveLength(0);
    expect(isLedgerCandidate(result)).toBe(true);
    expect(decisionLabel(result)).toBe("apply-failed");
  });

  it("treats a retry that proposes no edits as apply-failed", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    let call = 0;
    const { deps, calls } = makeDeps(refinerOutput(), {
      refiner: {
        refine: () => {
          call++;
          return Promise.resolve(call === 1 ? refinerOutput() : refinerOutput({ edits: [] }));
        },
        debrief: () => Promise.resolve(debriefOutput()),
      },
      applyEdits: (_e: EditOp[], _c: CreateOp[]) =>
        failApply(["find not found in src/cli/help.ts"]),
    });
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.applyFailed).toBe(true);
    expect(calls.benchSplits).toBe(0);
  });
});

// --- sweep-parse safety (baseline metrics path + loud parse misses) --------

const jsonl = (rows: RunRecord[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

describe("parseSweepRuns", () => {
  it("reads runs from EXACTLY the dir the sweep wrote to (read-dir == write-dir)", () => {
    // Simulate a sweep writing runs to /out/bench/1/validation (the baseline dir).
    const written = new Map<string, string>();
    const writeDir = "/out/bench/1/validation";
    written.set(
      `${writeDir}/runs.jsonl`,
      jsonl([
        makeRun({ taskId: "gui-placement-room214", success: true, tokensIn: 28455 }),
        makeRun({ taskId: "recovery-missing-area", success: false, tokensIn: 9263 }),
      ]),
    );
    const read = (p: string): string | null => written.get(p) ?? null;

    const rows = parseSweepRuns(writeDir, read);
    expect(rows).toHaveLength(2);
    expect(splitMetrics(rows).successes).toBe(1);

    // A different dir was never written — reading it aborts instead of silently zeroing.
    expect(() => parseSweepRuns("/out/bench/2/validation", read)).toThrow(SweepParseError);
  });

  it("aborts LOUD on a MISSING runs.jsonl (never defaults to zeros)", () => {
    expect(() => parseSweepRuns("/out/x", () => null)).toThrow(SweepParseError);
    try {
      parseSweepRuns("/out/x", () => null);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("/out/x/runs.jsonl");
      expect((e as Error).message).toContain("vacate the validation non-inferiority gate");
    }
  });

  it("aborts LOUD on an EMPTY runs.jsonl", () => {
    expect(() => parseSweepRuns("/out/x", () => "")).toThrow(SweepParseError);
    expect(() => parseSweepRuns("/out/x", () => "  \n \n")).toThrow(SweepParseError);
  });

  it("an ALL-FAILED sweep is real data (rows/0-successes), NOT a parse miss", () => {
    // The loop-cli-1 case: 6 validation runs that all failed → 6 rows, 0 successes,
    // med tokIn 0 (over successful runs only). This is correct, not an abort.
    const raw = jsonl(
      Array.from({ length: 6 }, () => makeRun({ success: false, tokensIn: 12345 })),
    );
    const rows = parseSweepRuns("/out/bench/1/validation", () => raw);
    expect(rows).toHaveLength(6);
    const m = splitMetrics(rows);
    expect(m.runs).toBe(6);
    expect(m.successes).toBe(0);
    expect(m.medianTokensInOnSuccesses).toBe(0);
    expect(m.frictionOnSuccesses).toBe(0);
  });
});
