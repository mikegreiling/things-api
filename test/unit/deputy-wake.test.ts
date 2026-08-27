/**
 * The wake primitive (src/deputy/wake.ts) — the liveness half of the GUI
 * preflight, issue #610.
 *
 * Both seams are injected: no cell here launches anything on the host or talks
 * to a deputy. What the cells pin is the ORDER (launch, then determine — the
 * reverse is what raises a consent dialog on an ungranted machine) and the
 * closed loop (re-ask until the target answers, bounded, never a fixed sleep
 * standing in for the answer).
 */
import { describe, expect, it } from "vitest";

import type { AutomationPermission } from "../../src/deputy/protocol.ts";
import { wakeSystemEvents } from "../../src/deputy/wake.ts";

/** A clock the cells advance themselves, so no cell waits on wall time. */
function fakeClock(stepMs = 50): { now: () => number; sleep: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms === 0 ? stepMs : ms;
    },
  };
}

describe("wakeSystemEvents", () => {
  it("starts the target BEFORE it asks macOS anything (an event would prompt)", () => {
    const order: string[] = [];
    wakeSystemEvents(
      {},
      {
        launch: () => order.push("launch"),
        probe: () => {
          order.push("probe");
          return "granted";
        },
        ...fakeClock(),
      },
    );
    expect(order).toEqual(["launch", "probe"]);
  });

  it("re-asks until the target answers, then reports what macOS reports", () => {
    const answers: AutomationPermission[] = ["not-running", "not-running", "granted"];
    let asked = 0;
    const wake = wakeSystemEvents(
      {},
      {
        launch: () => {},
        probe: () => answers[asked++] ?? "granted",
        ...fakeClock(),
        intervalMs: 10,
      },
    );
    expect(wake.standing).toBe("granted");
    expect(asked).toBe(3);
  });

  it("carries a REFUSAL back unchanged — the wake resolves liveness, never a grant", () => {
    const wake = wakeSystemEvents({}, { launch: () => {}, probe: () => "denied", ...fakeClock() });
    expect(wake.standing).toBe("denied");
  });

  it("keeps waiting while the deputy itself is silent, rather than inventing a verdict", () => {
    const answers: (AutomationPermission | undefined)[] = [undefined, undefined, "granted"];
    let asked = 0;
    const wake = wakeSystemEvents(
      {},
      {
        launch: () => {},
        probe: () => answers[asked++],
        ...fakeClock(),
        intervalMs: 10,
      },
    );
    expect(wake.standing).toBe("granted");
  });

  it("gives up on a bound and names the wait, not a permission", () => {
    const wake = wakeSystemEvents(
      {},
      {
        launch: () => {},
        probe: () => "not-running",
        ...fakeClock(),
        timeoutMs: 100,
        intervalMs: 10,
      },
    );
    expect(wake.standing).toBe("not-running");
    expect(wake.detail).toContain("did not come up");
    expect(wake.detail).not.toMatch(/permission|grant|denied/i);
  });

  it("reports a refused launch as a liveness failure and never probes", () => {
    let probed = 0;
    const wake = wakeSystemEvents(
      {},
      {
        launch: () => {
          throw new Error("open: no such bundle");
        },
        probe: () => {
          probed += 1;
          return "granted";
        },
        ...fakeClock(),
      },
    );
    expect(wake.standing).toBe("not-running");
    expect(wake.detail).toContain("could not be started");
    expect(wake.detail).toContain("no such bundle");
    expect(probed).toBe(0);
  });
});
