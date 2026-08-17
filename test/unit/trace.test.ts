/**
 * Dev-mode trace writer + registry seams (TRACE1, #487). No app is touched: the
 * file sink is exercised against a scratch directory and the in-flight registry
 * / enablement helpers are pure.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeCliTrace,
  createFileTraceSink,
  getInflight,
  installCliTrace,
  noteInflightStep,
  resolveTraceEnabled,
  sanitizeArgv,
  setInflight,
  trace,
  traceActive,
  traceSink,
} from "../../src/trace/tracer.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "things-trace-"));
});
afterEach(() => {
  closeCliTrace();
  setInflight(null);
  rmSync(dir, { recursive: true, force: true });
});

function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("resolveTraceEnabled (tri-state)", () => {
  it("config value wins over the build signal", () => {
    expect(resolveTraceEnabled(true, false)).toBe(true);
    expect(resolveTraceEnabled(false, true)).toBe(false);
  });
  it("null/undefined follows isDev", () => {
    expect(resolveTraceEnabled(null, true)).toBe(true);
    expect(resolveTraceEnabled(null, false)).toBe(false);
    expect(resolveTraceEnabled(undefined, true)).toBe(true);
  });
});

describe("sanitizeArgv", () => {
  it("redacts auth/token query values, keeps everything else", () => {
    expect(sanitizeArgv(["todo", "make-repeating", "ABC-1", "--frequency", "weekly"])).toEqual([
      "todo",
      "make-repeating",
      "ABC-1",
      "--frequency",
      "weekly",
    ]);
    expect(sanitizeArgv(["things:///show?auth=deadbeef123&id=X"])).toEqual([
      "things:///show?auth=<redacted>&id=X",
    ]);
  });
});

describe("in-flight registry", () => {
  it("records the write and updates the last step; noteInflightStep is a no-op when clear", () => {
    expect(getInflight()).toBeNull();
    noteInflightStep("ignored"); // no in-flight → no-op, never throws
    setInflight({
      op: "todo.make-repeating",
      uuid: "ABC-1",
      vector: "ui",
      uiDrive: true,
      startedAt: 0,
    });
    noteInflightStep('press "OK"');
    expect(getInflight()?.step).toBe('press "OK"');
    setInflight(null);
    expect(getInflight()).toBeNull();
  });
});

describe("file trace sink", () => {
  it("opens with an invocation event and appends stamped JSONL lines", () => {
    let clock = 1000;
    const sink = createFileTraceSink({
      dir,
      argv: ["todo", "make-repeating", "ABC-1"],
      version: "0.16.0-dev",
      pid: 4242,
      now: () => clock,
    });
    clock = 1300;
    sink.write({ phase: "ui-dispatch", label: 'press "OK"', durationMs: 250 });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("4242");
    const lines = readLines(join(dir, files[0]!));
    expect(lines[0]).toMatchObject({ phase: "invocation", version: "0.16.0-dev", pid: 4242 });
    expect(lines[0]!["argv"]).toEqual(["todo", "make-repeating", "ABC-1"]);
    expect(lines[0]!["elapsedMs"]).toBe(0);
    expect(lines[1]).toMatchObject({ phase: "ui-dispatch", label: 'press "OK"', elapsedMs: 300 });
  });
});

describe("trace() sink guard", () => {
  it("is a no-op with no sink and never invokes the thunk", () => {
    closeCliTrace(); // ensure no sink
    let called = false;
    trace(() => {
      called = true;
      return { phase: "x" };
    });
    expect(called).toBe(false);
    expect(traceActive()).toBe(false);
  });
});

describe("installCliTrace", () => {
  it("returns null (no file) when tracing resolves off", () => {
    const sink = installCliTrace({
      argv: ["today"],
      version: "0.16.0",
      isDev: false,
      env: { THINGS_API_STATE_DIR: dir },
    });
    expect(sink).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
    expect(traceActive()).toBe(false);
  });

  it("installs a live sink when isDev (default) and writes under the trace dir", () => {
    const sink = installCliTrace({
      argv: ["todo", "make-repeating", "ABC-1"],
      version: "0.16.0-dev",
      isDev: true,
      env: { THINGS_API_STATE_DIR: dir },
    });
    expect(sink).not.toBeNull();
    expect(traceActive()).toBe(true);
    expect(traceSink()).toBe(sink);
    // The file lands under <stateDir>/trace with the invocation event.
    const files = readdirSync(join(dir, "trace"));
    expect(files).toHaveLength(1);
    const lines = readLines(join(dir, "trace", files[0]!));
    expect(lines[0]).toMatchObject({ phase: "invocation" });
  });

  it("THINGS_API_TRACE=false forces tracing off even for a -dev build", () => {
    const sink = installCliTrace({
      argv: ["todo", "make-repeating", "ABC-1"],
      version: "0.16.0-dev",
      isDev: true,
      env: { THINGS_API_STATE_DIR: dir, THINGS_API_TRACE: "false" },
    });
    expect(sink).toBeNull();
  });
});
