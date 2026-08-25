/**
 * Signal-safe final words (TRACE1, #487). Tests the pure report builder — the
 * structured "interrupted, outcome uncertain" result a SIGTERM/SIGINT emits —
 * without touching process teardown, plus the ARMING lifecycle: the listeners
 * exist only for the span of a write, because a listener a blocked event loop
 * cannot dispatch swallows the signal instead of honoring it.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import type { InflightWrite } from "../../src/index.ts";
import {
  armInterrupt,
  disarmInterrupt,
  installServerSignalHandlers,
  interruptMessage,
  interruptReport,
} from "../../src/cli/interrupt.ts";

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

/**
 * A JS listener can only run ON the event loop, so one registered across a
 * synchronous span makes the process SWALLOW the signal rather than die to it.
 * The guard is therefore armed only where it can be honored and has something to
 * say — see src/cli/interrupt.ts's module note.
 */
const counts = (): [number, number] => [
  process.listenerCount("SIGTERM"),
  process.listenerCount("SIGINT"),
];

describe("arming lifecycle — listeners exist only while a write is in flight", () => {
  /** Vitest itself may hold listeners; every assertion is relative to that. */
  const base = counts();

  afterEach(() => {
    disarmInterrupt();
  });

  it("arming adds exactly one handler per signal; disarming removes them", () => {
    expect(counts()).toEqual(base);
    armInterrupt(true);
    expect(counts()).toEqual([base[0] + 1, base[1] + 1]);
    disarmInterrupt();
    expect(counts()).toEqual(base);
  });

  it("re-arming inside a span does not stack handlers", () => {
    armInterrupt(false);
    armInterrupt(true);
    armInterrupt(true);
    expect(counts()).toEqual([base[0] + 1, base[1] + 1]);
    disarmInterrupt();
    expect(counts()).toEqual(base);
  });

  it("disarming twice is a no-op, and re-arming after it works", () => {
    armInterrupt(true);
    disarmInterrupt();
    disarmInterrupt();
    expect(counts()).toEqual(base);
    armInterrupt(true);
    expect(counts()).toEqual([base[0] + 1, base[1] + 1]);
  });

  it("the server install is the same handlers, kept for the process lifetime", () => {
    installServerSignalHandlers();
    expect(counts()).toEqual([base[0] + 1, base[1] + 1]);
    // Idempotent: a second call cannot double-register.
    installServerSignalHandlers();
    expect(counts()).toEqual([base[0] + 1, base[1] + 1]);
  });

  it("the CLI startup path registers nothing — an ordinary command keeps the kernel's disposition", () => {
    const main = readFileSync(new URL("../../src/cli/main.ts", import.meta.url), "utf8");
    // The regression this locks: `runCli` used to install the handlers before
    // dispatch, so `timeout 30 things today` was ignored while the read blocked
    // in open(2) (measured 2026-08-24 — the clean-host probes needed SIGKILL).
    expect(main).not.toMatch(/process\.(on|once)\(\s*["']SIG/);
    expect(main).not.toContain("installServerSignalHandlers");
    expect(main).not.toContain("armInterrupt");
  });
});
