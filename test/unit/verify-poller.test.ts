/**
 * The verification poller (src/write/verify/poller.ts): the deadline
 * classification and the DACON1 stable-mismatch early exit.
 *
 * A DETERMINISTIC virtual clock drives both `now` and `sleep`: `sleep(ms)` simply
 * advances the clock, so a scripted `evaluate` sequence plays out against exact
 * wall-clock without real timers. Each `evaluate` call consumes the next scripted
 * evaluation (the last one repeats once the script is exhausted).
 */
import { describe, expect, it } from "vitest";

import type { DeltaEvaluation } from "../../src/write/verify/delta.ts";
import { pollUntilVerified, type PollerDeps } from "../../src/write/verify/poller.ts";

/** A virtual clock whose `sleep` advances `now` — no real timers. */
function virtualClock(): PollerDeps & { nowMs: () => number } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    nowMs: () => t,
  };
}

/** Fill a partial evaluation with the movement-flag defaults. */
function evaluation(partial: Partial<DeltaEvaluation>): DeltaEvaluation {
  return {
    satisfied: false,
    movement: false,
    assertedMovement: false,
    observed: null,
    ...partial,
  };
}

/** A scripted `evaluate` that yields each entry in turn, repeating the last. */
function scripted(seq: DeltaEvaluation[]): () => DeltaEvaluation {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)]!;
}

const TIMEOUT = 120_000;

describe("pollUntilVerified — deadline classification", () => {
  it("returns ok as soon as an evaluation is satisfied", async () => {
    const clock = virtualClock();
    const out = await pollUntilVerified(
      scripted([evaluation({ satisfied: true, observed: { x: 1 } })]),
      TIMEOUT,
      clock,
    );
    expect(out.kind).toBe("ok");
    expect(out.attempts).toBe(1);
    expect(out.elapsedMs).toBe(0);
  });

  it("fails fast (mismatch) on a terminal evaluation, carrying its detail", async () => {
    const clock = virtualClock();
    const out = await pollUntilVerified(
      scripted([evaluation({ terminal: true, assertedMovement: true, detail: "ambiguous" })]),
      TIMEOUT,
      clock,
    );
    expect(out.kind).toBe("mismatch");
    expect(out.detail).toBe("ambiguous");
    expect(out.elapsedMs).toBe(0);
  });

  it("times out (tripwire) when only non-asserted movement is seen — full budget", async () => {
    const clock = virtualClock();
    const out = await pollUntilVerified(
      scripted([evaluation({ movement: true, observed: null })]),
      TIMEOUT,
      clock,
    );
    expect(out.kind).toBe("timeout");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT);
  });

  it("returns silent-noop when nothing moves — full budget", async () => {
    const clock = virtualClock();
    const out = await pollUntilVerified(scripted([evaluation({})]), TIMEOUT, clock);
    expect(out.kind).toBe("silent-noop");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT);
  });
});

describe("pollUntilVerified — DACON1 stable-mismatch early exit", () => {
  it("exits mismatch early when an asserted field settles on a stable wrong value", async () => {
    // The live-host shape: nextOccurrence moved to a wrong value and never converges.
    const clock = virtualClock();
    const stuck = evaluation({
      assertedMovement: true,
      movement: true,
      observed: { "repeating.nextOccurrence": "2029-10-02" },
      detail: "nextOccurrence 2029-10-02 ≠ 2028-10-16",
    });
    const out = await pollUntilVerified(scripted([stuck]), TIMEOUT, clock);
    expect(out.kind).toBe("mismatch");
    expect(out.detail).toContain("2029-10-02");
    // Far short of the full budget — a few seconds past the stability window.
    expect(out.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(out.elapsedMs).toBeLessThan(8000);
  });

  it("does NOT fire while the asserted value is still changing (converges to ok)", async () => {
    // The value moves through several distinct wrong values, then converges — the
    // window resets on every change, so no early mismatch, and ok wins.
    const clock = virtualClock();
    const seq: DeltaEvaluation[] = [];
    // ~9s of a CHANGING wrong value (30 polls at 100/300ms), a new value each poll.
    for (let i = 0; i < 40; i++) {
      seq.push(evaluation({ assertedMovement: true, movement: true, observed: { n: `v${i}` } }));
    }
    seq.push(evaluation({ satisfied: true, observed: { n: "target" } }));
    const out = await pollUntilVerified(scripted(seq), TIMEOUT, clock);
    expect(out.kind).toBe("ok");
  });

  it("never early-exits a would-converge case: stable-wrong briefly, then converges", async () => {
    // Stable-wrong for < the window (only 2s), then converges → ok, never mismatch.
    const clock = virtualClock();
    const seq: DeltaEvaluation[] = [];
    for (let i = 0; i < 10; i++) {
      seq.push(evaluation({ assertedMovement: true, movement: true, observed: { n: "wrong" } }));
    }
    seq.push(evaluation({ satisfied: true, observed: { n: "target" } }));
    const out = await pollUntilVerified(scripted(seq), TIMEOUT, clock);
    // 10 polls at 100ms ≈ 1s < 5s window → converges to ok.
    expect(out.kind).toBe("ok");
  });

  it("does not fire on tripwire-only movement (no asserted field observed)", async () => {
    // Non-asserted movement with a null observation must ride the full budget → timeout.
    const clock = virtualClock();
    const out = await pollUntilVerified(
      scripted([evaluation({ movement: true, assertedMovement: false, observed: null })]),
      TIMEOUT,
      clock,
    );
    expect(out.kind).toBe("timeout");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT);
  });

  it("is inert for short budgets (timeout < the stability window)", async () => {
    // A 2s budget never reaches the 5s window — behaves exactly as before (deadline mismatch).
    const clock = virtualClock();
    const out = await pollUntilVerified(
      scripted([evaluation({ assertedMovement: true, movement: true, observed: { n: "wrong" } })]),
      2000,
      clock,
    );
    expect(out.kind).toBe("mismatch");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(2000);
  });

  it("resets the window when the value flickers away and back", async () => {
    // Same wrong value for ~3s, a single DIFFERENT observation, then the wrong value
    // again for ~3s — neither run alone reaches 5s, so no early exit before deadline...
    // but the two runs are on the SAME value only if uninterrupted. Here the flicker
    // resets, so the value must sit unchanged ≥5s AFTER the flicker to trip.
    const clock = virtualClock();
    const seq: DeltaEvaluation[] = [];
    for (let i = 0; i < 15; i++) {
      seq.push(evaluation({ assertedMovement: true, movement: true, observed: { n: "A" } }));
    }
    seq.push(evaluation({ assertedMovement: true, movement: true, observed: { n: "B" } })); // flicker
    for (let i = 0; i < 40; i++) {
      seq.push(evaluation({ assertedMovement: true, movement: true, observed: { n: "A" } }));
    }
    const out = await pollUntilVerified(scripted(seq), TIMEOUT, clock);
    // It still trips (A sits unchanged ≥5s after the flicker) — just later than a
    // clean run would. The point is the window RESET at the flicker.
    expect(out.kind).toBe("mismatch");
    expect(out.observed).toEqual({ n: "A" });
  });
});
