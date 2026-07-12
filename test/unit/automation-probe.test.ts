/**
 * Automation-consent probe classification via the injectable runner seam.
 */
import { describe, expect, it } from "vitest";

import { probeAutomation } from "../../src/write/automation-probe.ts";

function throwing(props: Record<string, unknown>): () => string {
  return () => {
    throw Object.assign(new Error("probe failed"), props);
  };
}

describe("probeAutomation", () => {
  it("skips (app-not-running) rather than launching Things", () => {
    const result = probeAutomation({ isAppRunning: () => false });
    expect(result.status).toBe("app-not-running");
  });

  it("classifies a clean run as granted", () => {
    const result = probeAutomation({ isAppRunning: () => true, run: () => "3\n" });
    expect(result.status).toBe("granted");
  });

  it("classifies a deadline kill as pending (unanswered consent dialog)", () => {
    const result = probeAutomation({
      isAppRunning: () => true,
      run: throwing({ killed: true, signal: "SIGTERM" }),
    });
    expect(result.status).toBe("pending");
    expect(result.detail).toContain("Automation dialog");
  });

  it("classifies an in-band AppleEvent -1712 as pending too (oddity 5m: Things gives up before our deadline)", () => {
    const result = probeAutomation({
      isAppRunning: () => true,
      run: throwing({
        stderr: "execution error: Things3 got an error: AppleEvent timed out. (-1712)",
      }),
    });
    expect(result.status).toBe("pending");
    expect(result.detail).toContain("physical screen");
  });

  it("classifies -1743 as denied", () => {
    const result = probeAutomation({
      isAppRunning: () => true,
      run: throwing({
        stderr: "execution error: Not authorized to send Apple events to Things3. (-1743)",
      }),
    });
    expect(result.status).toBe("denied");
    expect(result.detail).toContain("Automation");
  });

  it("reports anything else as inconclusive with the raw error", () => {
    const result = probeAutomation({
      isAppRunning: () => true,
      run: throwing({ stderr: "some osascript failure" }),
    });
    expect(result.status).toBe("inconclusive");
    expect(result.detail).toContain("some osascript failure");
  });
});
