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
  budgetNote,
  buildCharter,
  buildLedgerEntry,
  CONSECUTIVE_PROVIDER_ERROR_LIMIT,
  decideAccept,
  decisionLabel,
  extractLessons,
  filesInPatch,
  filesOutsideAllowlist,
  isLedgerCandidate,
  isProviderError,
  ledgerFileName,
  LoopAbort,
  matchesAllowlist,
  maxTotalTokensArgs,
  pairMetrics,
  ProviderError,
  RATE_LIMIT_ABORT_EXIT_CODE,
  renderLedgerEntry,
  runIteration,
  splitMetrics,
  sumRunTokens,
  toStateEntry,
  type IterationDeps,
  type IterationParams,
  type IterationResult,
  type PairMetrics,
  type PairRuns,
} from "../../bench/loop-core.ts";
import type {
  DebriefInput,
  DebriefOutput,
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

function refinerOutput(o: Partial<RefinerOutput> = {}): RefinerOutput {
  return {
    classifications: [],
    patch: patchFor("src/cli/help.ts"),
    rationale: "smallest generalizable fix\nsecond line",
    predictedBlastRadius: "one task",
    guiSemanticChange: false,
    ...o,
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
  gitApply: string[];
  runGate: number;
  benchSplits: number;
  revertFiles: string[][];
  commit: Array<{ message: string; files: string[] }>;
  stashPatch: Array<{ name: string; content: string }>;
  onBudgetWarning: number;
}

function makeDeps(
  output: RefinerOutput,
  overrides: Partial<IterationDeps> = {},
): { deps: IterationDeps; calls: Calls } {
  const calls: Calls = {
    gitApply: [],
    runGate: 0,
    benchSplits: 0,
    revertFiles: [],
    commit: [],
    stashPatch: [],
    onBudgetWarning: 0,
  };
  const deps: IterationDeps = {
    refiner: fakeRefiner(output),
    readArmFiles: () => ({ "src/cli/help.ts": "body" }),
    loadTranscript: () => null,
    gitApply: (patch) => {
      calls.gitApply.push(patch);
      return { ok: true };
    },
    runGate: () => {
      calls.runGate++;
      return { ok: true, output: "" };
    },
    benchSplits: () => {
      calls.benchSplits++;
      return { dev: runsWith(1, 3), validation: runsWith(2, 2) };
    },
    revertFiles: (files) => {
      calls.revertFiles.push(files);
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
  it("rejects a patch touching files outside the arm allowlist (no apply)", async () => {
    const { deps, calls } = makeDeps(refinerOutput({ patch: patchFor("src/index.ts") }));
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("allowlist violation");
    expect(calls.gitApply).toHaveLength(0);
    expect(calls.benchSplits).toBe(0);
    expect(calls.commit).toHaveLength(0);
  });

  it("reverts (no commit, no re-bench) when the gate fails", async () => {
    const { deps, calls } = makeDeps(refinerOutput(), {
      runGate: () => ({ ok: false, output: "typecheck error" }),
    });
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("gate failed");
    expect(calls.gitApply).toHaveLength(1);
    expect(calls.benchSplits).toBe(0);
    expect(calls.revertFiles).toEqual([["src/cli/help.ts"]]);
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
    expect(calls.revertFiles).toHaveLength(0);
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
    expect(calls.revertFiles).toEqual([["src/cli/help.ts"]]);
  });

  it("parks a gui-semantic patch for Mike and reverts (no re-bench, no commit)", async () => {
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const { deps, calls } = makeDeps(
      refinerOutput({
        patch: patchFor("skills/things-cli/references/gui.md"),
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
    expect(calls.stashPatch).toHaveLength(1);
    expect(calls.benchSplits).toBe(0);
    expect(calls.commit).toHaveLength(0);
    expect(calls.revertFiles).toEqual([["skills/things-cli/references/gui.md"]]);
  });

  it("treats an empty patch as a no-op no-accept", async () => {
    const { deps, calls } = makeDeps(refinerOutput({ patch: "" }));
    const before = metrics(runsWith(1, 3), runsWith(2, 2));
    const result = await runIteration(deps, { arm: "cli", prevMetrics: before, ...emptyParams() });
    expect(result.accepted).toBe(false);
    expect(calls.gitApply).toHaveLength(0);
    expect(calls.benchSplits).toBe(0);
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
    expect(calls.gitApply).toHaveLength(0);
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
    expect(calls.gitApply).toHaveLength(1);
    expect(calls.runGate).toBe(1);
    expect(calls.benchSplits).toBe(0);
    expect(calls.revertFiles).toEqual([["src/cli/help.ts"]]); // unapplied patch reverted
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
    expect(calls.gitApply).toHaveLength(0);
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

  it("isLedgerCandidate selects accepted, reverted, and needs-mike — not bare rejects", () => {
    expect(isLedgerCandidate(iterationResult({ accepted: true }))).toBe(true);
    expect(
      isLedgerCandidate(iterationResult({ accepted: false, metricsAfter: metrics([], []) })),
    ).toBe(true);
    expect(
      isLedgerCandidate(iterationResult({ accepted: false, needsMike: true, metricsAfter: null })),
    ).toBe(true);
    // allowlist/gate/provider reject: no re-bench, not parked → no ledger entry
    expect(
      isLedgerCandidate(iterationResult({ accepted: false, needsMike: false, metricsAfter: null })),
    ).toBe(false);
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
    expect(md).toContain("not measured (parked before re-bench)");
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
