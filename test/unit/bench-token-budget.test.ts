/**
 * Token-budget bookkeeping (bench `--max-total-tokens`): the pure stop decision
 * ({@link overBudget}) and the guarantee that budget-skipped placeholder records are
 * NOT scored as failures by the report aggregator.
 */
import { describe, expect, it } from "vitest";

import { executeSweep, overBudget, type SweepUnit } from "../../bench/budget.ts";
import { buildScorecard } from "../../bench/report.ts";
import type { RunRecord, TaskSpec } from "../../bench/types.ts";

function baseRecord(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: "out",
    taskId: "t1",
    paraphrase: null,
    rep: 0,
    arm: "cli",
    model: "m",
    provider: "openai",
    promptHash: "h",
    gitSha: "sha",
    success: true,
    safety: "ok",
    errorsSeen: 0,
    turns: 1,
    toolCalls: 1,
    tokensIn: 100,
    tokensInCached: 0,
    tokensOut: 20,
    staticContextTokens: 0,
    dynamicContextTokens: 0,
    wallMs: 1,
    worldSeed: 1,
    transcript: "t.json",
    ...overrides,
  };
}

describe("overBudget", () => {
  it("treats 0 (or negative) cap as unlimited", () => {
    expect(overBudget(0, 0)).toBe(false);
    expect(overBudget(1_000_000, 0)).toBe(false);
    expect(overBudget(1_000_000, -5)).toBe(false);
  });

  it("trips only once the spend strictly EXCEEDS the cap", () => {
    expect(overBudget(99, 100)).toBe(false);
    expect(overBudget(100, 100)).toBe(false); // the run that reaches the cap still runs
    expect(overBudget(101, 100)).toBe(true);
  });
});

const unit = (id: string): SweepUnit => ({ task: { id } as TaskSpec, rep: 0 });
const makeSkipped = (task: TaskSpec, rep: number): RunRecord =>
  baseRecord({ taskId: task.id, rep, success: false, skipped: "token-budget" });

describe("executeSweep (the accumulation/stop decision)", () => {
  it("keeps the run that crosses the cap, then skips the rest", async () => {
    const order: string[] = [];
    // Each run spends 100 (in) + 20 (out) = 120 tokens. Cap 150: run 1 spends 120
    // (still ≤ 150 before run 2), run 2 crosses to 240, runs 3+ are skipped.
    const res = await executeSweep(
      [unit("a"), unit("b"), unit("c"), unit("d")],
      150,
      (task) => {
        order.push(task.id);
        return Promise.resolve(baseRecord({ taskId: task.id }));
      },
      makeSkipped,
    );
    expect(order).toEqual(["a", "b"]); // only two runs actually launched
    expect(res.records.map((r) => r.taskId)).toEqual(["a", "b"]);
    expect(res.skipped.map((r) => r.taskId)).toEqual(["c", "d"]);
    expect(res.skipped.every((r) => r.skipped === "token-budget")).toBe(true);
    expect(res.spentTokens).toBe(240);
  });

  it("runs everything when the cap is 0 (unlimited)", async () => {
    const res = await executeSweep(
      [unit("a"), unit("b"), unit("c")],
      0,
      (task) => Promise.resolve(baseRecord({ taskId: task.id })),
      makeSkipped,
    );
    expect(res.records).toHaveLength(3);
    expect(res.skipped).toHaveLength(0);
    expect(res.spentTokens).toBe(360);
  });

  it("streams every record through onRecord in order, flagging skips", async () => {
    const seen: [string, boolean][] = [];
    await executeSweep(
      [unit("a"), unit("b"), unit("c")],
      1,
      (task) => Promise.resolve(baseRecord({ taskId: task.id })),
      makeSkipped,
      (rec, skipped) => seen.push([rec.taskId, skipped]),
    );
    // First run executes (spends 120 > cap 1), the remainder are skipped.
    expect(seen).toEqual([
      ["a", false],
      ["b", true],
      ["c", true],
    ]);
  });
});

describe("buildScorecard ignores budget-skipped records", () => {
  it("never counts a skipped placeholder as a run or a failure", () => {
    const records: RunRecord[] = [
      baseRecord({ taskId: "t1", success: true }),
      baseRecord({
        taskId: "t2",
        success: false,
        skipped: "token-budget",
        tokensIn: 0,
        tokensOut: 0,
      }),
    ];
    const sc = buildScorecard(records, () => "reads", "sha");
    // One cell (cli|m|reads); exactly one scored run, and it succeeded — the skipped
    // record neither adds a run nor drags the success rate down.
    expect(sc.cells).toHaveLength(1);
    const cell = sc.cells[0];
    expect(cell?.runs).toBe(1);
    expect(cell?.successes).toBe(1);
    expect(cell?.successRate).toBe(1);
  });

  it("produces no cells when every selected run was skipped", () => {
    const records: RunRecord[] = [
      baseRecord({ taskId: "t1", success: false, skipped: "token-budget" }),
      baseRecord({ taskId: "t2", success: false, skipped: "token-budget" }),
    ];
    const sc = buildScorecard(records, () => "reads", "sha");
    expect(sc.cells).toHaveLength(0);
  });
});
