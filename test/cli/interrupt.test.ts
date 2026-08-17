/**
 * Signal-safe final words (TRACE1, #487). Tests the pure report builder — the
 * structured "interrupted, outcome uncertain" result a SIGTERM/SIGINT emits —
 * without touching process teardown.
 */
import { describe, expect, it } from "vitest";

import type { InflightWrite } from "../../src/index.ts";
import { interruptMessage, interruptReport } from "../../src/cli/interrupt.ts";

const uiDrive: InflightWrite = {
  op: "todo.make-repeating",
  uuid: "ABC-1",
  vector: "ui",
  uiDrive: true,
  step: 'press "OK"',
  startedAt: 0,
};

describe("interruptReport", () => {
  it("emits nothing when no write was in flight", () => {
    expect(interruptReport("SIGTERM", null, null, true)).toBeNull();
    expect(interruptReport("SIGTERM", null, "/x/trace.jsonl", false)).toBeNull();
  });

  it("--json: a machine-readable interrupted envelope with the uncertain contract", () => {
    const report = interruptReport("SIGTERM", uiDrive, "/state/trace/run.jsonl", true);
    expect(report?.stream).toBe("stdout");
    const env = JSON.parse(report!.text) as {
      ok: boolean;
      error: { code: string; message: string; detail: Record<string, unknown> };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("interrupted");
    expect(env.error.detail).toMatchObject({
      signal: "SIGTERM",
      op: "todo.make-repeating",
      uuid: "ABC-1",
      outcome: "uncertain",
      step: 'press "OK"',
      recheck: "things show ABC-1",
      tracePath: "/state/trace/run.jsonl",
    });
    // The honesty contract: names the uncertainty and the re-check.
    expect(env.error.message).toContain("UNCERTAIN");
    expect(env.error.message).toContain("things show ABC-1");
  });

  it("non-json: a single honest stderr line", () => {
    const report = interruptReport("SIGINT", uiDrive, null, false);
    expect(report?.stream).toBe("stderr");
    expect(report!.text).toContain("interrupted by SIGINT");
    expect(report!.text).toContain("re-check");
  });

  it("omits tracePath/step when absent; falls back to <uuid> when the target is unknown", () => {
    const report = interruptReport(
      "SIGTERM",
      { op: "todo.update", uuid: null, vector: "url-scheme", uiDrive: false, startedAt: 0 },
      null,
      true,
    );
    const env = JSON.parse(report!.text) as { error: { detail: Record<string, unknown> } };
    expect(env.error.detail["tracePath"]).toBeUndefined();
    expect(env.error.detail["step"]).toBeUndefined();
    expect(env.error.detail["uuid"]).toBeNull();
    expect(env.error.detail["recheck"]).toBe("things show <uuid>");
  });

  it("interruptMessage distinguishes a UI drive from a plain write", () => {
    expect(interruptMessage("SIGTERM", uiDrive)).toContain("driving the Things UI");
    expect(
      interruptMessage("SIGTERM", {
        op: "todo.update",
        uuid: "X",
        vector: "url-scheme",
        uiDrive: false,
        startedAt: 0,
      }),
    ).toContain("while writing");
  });
});
