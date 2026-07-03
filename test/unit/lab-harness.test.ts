import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "../../lab/runner/assertions.ts";
import { diffSnapshots } from "../../lab/runner/differ.ts";
import { compareVerdicts, evaluateProbe } from "../../lab/runner/evaluate.ts";
import { computeDisruption, parseEventLog, sliceEvents } from "../../lab/runner/tier.ts";
import type {
  DbSnapshot,
  ExecutionRecord,
  MonitorEvent,
  ProbeSpec,
  VerdictsFile,
} from "../../lab/runner/types.ts";

const THINGS = "com.culturedcode.ThingsMac";

function ev(kind: string, detail?: Record<string, unknown>): MonitorEvent {
  return detail === undefined
    ? { ts: "2026-07-05T12:00:00.000Z", kind }
    : { ts: "2026-07-05T12:00:00.000Z", kind, detail };
}

const mark = (probe: string, phase: string) => ev("mark", { probe, phase });

describe("differ", () => {
  const before: DbSnapshot = {
    TMTask: {
      aaa: { uuid: "aaa", title: "Alpha", status: 0, notes: "" },
      bbb: { uuid: "bbb", title: "Bravo", status: 0, notes: "" },
    },
    TMTag: {},
  };

  it("detects inserts, deletes, and field changes", () => {
    const after: DbSnapshot = {
      TMTask: {
        aaa: { uuid: "aaa", title: "Alpha", status: 3, notes: "" },
        ccc: { uuid: "ccc", title: "Charlie", status: 0, notes: "" },
      },
      TMTag: {},
    };
    const delta = diffSnapshots(before, after);
    expect(delta.inserted).toEqual([
      { table: "TMTask", key: "ccc", row: { uuid: "ccc", title: "Charlie", status: 0, notes: "" } },
    ]);
    expect(delta.deleted.map((d) => d.key)).toEqual(["bbb"]);
    expect(delta.changed).toEqual([
      { table: "TMTask", key: "aaa", fields: [{ field: "status", before: 0, after: 3 }] },
    ]);
  });

  it("returns an empty delta for identical snapshots", () => {
    const delta = diffSnapshots(before, structuredClone(before));
    expect(delta).toEqual({ inserted: [], deleted: [], changed: [] });
  });

  it("tolerates float noise in epoch REAL columns", () => {
    const a: DbSnapshot = { TMTask: { x: { creationDate: 1000.0000001 } } };
    const b: DbSnapshot = { TMTask: { x: { creationDate: 1000.0000002 } } };
    expect(diffSnapshots(a, b).changed).toEqual([]);
  });

  it("handles tables present on only one side", () => {
    const delta = diffSnapshots({ TMTask: {} }, { TMTask: {}, TMArea: { z: { uuid: "z" } } });
    expect(delta.inserted).toEqual([{ table: "TMArea", key: "z", row: { uuid: "z" } }]);
  });
});

describe("tier", () => {
  it("slices events between the probe's marks only", () => {
    const events = [
      ev("frontmost", { bundleId: "com.apple.finder" }),
      mark("U01", "start"),
      ev("launch", { bundleId: THINGS }),
      mark("U01", "end"),
      mark("U02", "start"),
      ev("window-new", { window: 5, title: "" }),
      mark("U02", "end"),
    ];
    expect(sliceEvents(events, "U01").map((e) => e.kind)).toEqual(["launch"]);
    expect(sliceEvents(events, "U02").map((e) => e.kind)).toEqual(["window-new"]);
    expect(sliceEvents(events, "U99")).toEqual([]);
  });

  it("tier 0 when nothing happens", () => {
    expect(computeDisruption([]).tier).toBe(0);
  });

  it("tier 1 for background launch (main window + untitled companion allowed)", () => {
    const d = computeDisruption([
      ev("launch", { bundleId: THINGS }),
      ev("window-new", { window: 1, title: "Today" }),
      ev("window-new", { window: 2, title: "" }),
    ]);
    expect(d.tier).toBe(1);
    expect(d.signals).toMatchObject({ launch: true, activated: false, windowNew: 2 });
  });

  it("tier 2 when Things becomes frontmost", () => {
    const d = computeDisruption([
      ev("launch", { bundleId: THINGS }),
      ev("window-new", { window: 1, title: "" }),
      ev("frontmost", { bundleId: THINGS }),
    ]);
    expect(d.tier).toBe(2);
  });

  it("tier 3 for a modal on an already-running app", () => {
    const d = computeDisruption([ev("window-new", { window: 9, title: "" })]);
    expect(d.tier).toBe(3);
  });

  it("tier 2 when bare activation surfaces the untitled companion window", () => {
    const d = computeDisruption([
      ev("activate", { bundleId: THINGS }),
      ev("frontmost", { bundleId: THINGS }),
      ev("window-new", { window: 4, title: "" }),
    ]);
    expect(d.tier).toBe(2);
  });

  it("tier 3 when activation comes with windows beyond its budget", () => {
    const d = computeDisruption([
      ev("activate", { bundleId: THINGS }),
      ev("window-new", { window: 4, title: "" }),
      ev("window-new", { window: 5, title: "" }),
    ]);
    expect(d.tier).toBe(3);
  });

  it("tier 3 when a launch spawns more windows than its budget", () => {
    const d = computeDisruption([
      ev("launch", { bundleId: THINGS }),
      ev("window-new", { window: 1, title: "Today" }),
      ev("window-new", { window: 2, title: "" }),
      ev("window-new", { window: 3, title: "" }),
    ]);
    expect(d.tier).toBe(3);
  });

  it("ignores launches/activations of other apps", () => {
    const d = computeDisruption([
      ev("launch", { bundleId: "com.apple.TextEdit" }),
      ev("frontmost", { bundleId: "com.apple.finder" }),
    ]);
    expect(d.tier).toBe(0);
  });

  it("parses NDJSON and skips torn lines", () => {
    const log = `${JSON.stringify(ev("launch", { bundleId: THINGS }))}\n{"ts":"2026-`;
    expect(parseEventLog(log)).toHaveLength(1);
  });
});

describe("assertions", () => {
  const before: DbSnapshot = {
    TMTask: {
      t1: { uuid: "t1", title: "Target", status: 0, startDate: 132803712 },
    },
    TMChecklistItem: {},
  };
  const after: DbSnapshot = {
    TMTask: {
      t1: { uuid: "t1", title: "Target", status: 3, startDate: 132803712 },
      t2: { uuid: "t2", title: "NewItem", status: 0, startDate: null },
    },
    TMChecklistItem: {
      c1: { uuid: "c1", task: "t2", title: "Alpha" },
      c2: { uuid: "c2", task: "t2", title: "Bravo" },
    },
  };
  const delta = diffSnapshots(before, after);
  const context = { seed: { "LAB-AREA-A": { uuid: "area-1" } }, ctx: { token: "tok" } };

  function run(assertions: Parameters<typeof evaluateAssertions>[0]) {
    return evaluateAssertions(assertions, before, after, delta, context);
  }

  it("rowExists / rowAbsent", () => {
    const [a, b, c] = run([
      { kind: "rowExists", table: "TMTask", where: { title: "NewItem" } },
      { kind: "rowAbsent", table: "TMTask", where: { title: "Ghost" } },
      { kind: "rowExists", table: "TMTask", where: { title: "Ghost" } },
    ]);
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(true);
    expect(c?.ok).toBe(false);
  });

  it("inserted / notInserted", () => {
    const [a, b, c] = run([
      { kind: "inserted", table: "TMTask", where: { title: "NewItem" } },
      { kind: "notInserted", table: "TMTask", where: { title: "Target" } },
      { kind: "notInserted", table: "TMChecklistItem" },
    ]);
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(true);
    expect(c?.ok).toBe(false); // two checklist rows were inserted
  });

  it("fieldEquals with @uuidOf ref in where-clause", () => {
    const [a] = run([
      {
        kind: "rowCount",
        table: "TMChecklistItem",
        where: { task: "@uuidOf:TMTask:title=NewItem" },
        count: 2,
      },
    ]);
    expect(a?.ok).toBe(true);
  });

  it("fieldEquals / fieldUnchanged / unchanged", () => {
    const [a, b, c, d] = run([
      { kind: "fieldEquals", table: "TMTask", where: { uuid: "t1" }, field: "status", value: 3 },
      { kind: "fieldUnchanged", table: "TMTask", where: { uuid: "t1" }, fields: ["startDate"] },
      { kind: "fieldUnchanged", table: "TMTask", where: { uuid: "t1" }, fields: ["status"] },
      { kind: "unchanged", table: "TMTask", where: { uuid: "t1" } },
    ]);
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(true);
    expect(c?.ok).toBe(false);
    expect(d?.ok).toBe(false);
  });

  it("deltaEmpty fails when anything changed", () => {
    const [a] = run([{ kind: "deltaEmpty" }]);
    expect(a?.ok).toBe(false);
    const clean = evaluateAssertions(
      [{ kind: "deltaEmpty" }],
      before,
      structuredClone(before),
      diffSnapshots(before, structuredClone(before)),
      context,
    );
    expect(clean[0]?.ok).toBe(true);
  });

  it("deleted: before-row must be gone from after", () => {
    const gone: DbSnapshot = { TMTask: {} };
    const d = diffSnapshots(before, gone);
    const [a, b] = evaluateAssertions(
      [
        { kind: "deleted", table: "TMTask", where: { title: "Target" } },
        { kind: "deleted", table: "TMTask", where: { title: "Ghost" } },
      ],
      before,
      gone,
      d,
      context,
    );
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(false); // never existed
    const [c] = run([{ kind: "deleted", table: "TMTask", where: { title: "Target" } }]);
    expect(c?.ok).toBe(false); // still present in after
  });

  it("@uuidOfBefore resolves against the before snapshot", () => {
    const gone: DbSnapshot = {
      TMTask: {},
      TMTombstone: { tomb1: { uuid: "tomb1", deletedObjectUUID: "t1" } },
    };
    const [a] = evaluateAssertions(
      [
        {
          kind: "rowExists",
          table: "TMTombstone",
          where: { deletedObjectUUID: "@uuidOfBefore:TMTask:title=Target" },
        },
      ],
      before,
      gone,
      diffSnapshots(before, gone),
      { ...context, before },
    );
    expect(a?.ok).toBe(true);
  });

  it("stdoutMatches checks command transport output", () => {
    const withCommands = {
      ...context,
      commands: [
        {
          resolved: "osascript …",
          exitCode: 0,
          stdout: "to do id ABC123",
          stderr: "",
          durationMs: 5,
        },
      ],
    };
    const [a, b, c] = evaluateAssertions(
      [
        { kind: "stdoutMatches", command: 0, pattern: "to do id \\w+" },
        { kind: "stdoutMatches", command: 0, pattern: "^nope$" },
        { kind: "stdoutMatches", command: 9, pattern: "." },
      ],
      before,
      after,
      delta,
      withCommands,
    );
    expect(a?.ok).toBe(true);
    expect(b?.ok).toBe(false);
    expect(c?.ok).toBe(false); // no such command index
  });

  it("@seed and @ctx refs resolve; ambiguous selectors fail loudly", () => {
    const [a] = run([{ kind: "rowAbsent", table: "TMTask", where: { area: "@seed:LAB-AREA-A" } }]);
    expect(a?.ok).toBe(true);
    const [b] = run([
      { kind: "fieldEquals", table: "TMTask", where: {}, field: "title", value: "x" },
    ]);
    expect(b?.ok).toBe(false);
    expect(b?.detail).toContain("ambiguous");
  });
});

describe("evaluateProbe + compareVerdicts", () => {
  const probe: ProbeSpec = {
    id: "U03",
    legacyRef: "T03",
    title: "add with unknown tag",
    vector: "url",
    operation: "todo.create",
    appState: "running-background",
    commands: [{ openUrl: "things:///add?title=Probe" }],
    expect: {
      verdict: "supported",
      tier: 0,
      assertions: [{ kind: "inserted", table: "TMTask", where: { title: "Probe" } }],
    },
  };

  const execution: ExecutionRecord = {
    probe: "U03",
    startedAt: "2026-07-05T12:00:00.000Z",
    endedAt: "2026-07-05T12:00:04.000Z",
    appState: "running-background",
    appRunningBefore: true,
    commands: [
      {
        resolved: "open -g things:///add?title=Probe",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 90,
      },
    ],
    waits: [{ sql: "SELECT 1", satisfied: true, waitedMs: 300 }],
    snapshotBefore: "snapshots/U03-before.json",
    snapshotAfter: "snapshots/U03-after.json",
    crash: { pidDied: false, ipsFiles: [] },
    errors: [],
  };

  const before: DbSnapshot = { TMTask: {} };
  const after: DbSnapshot = { TMTask: { p1: { uuid: "p1", title: "Probe", status: 0 } } };
  const events = [mark("U03", "start"), mark("U03", "end")];
  const env = {
    thingsVersion: "3.22.11",
    golden: "things-lab-golden-v1",
    schemaFingerprint: "sha256:test",
    pinnedDate: "2026-07-05",
    runId: "test-run",
  };
  const context = { seed: {}, ctx: {} };

  it("green probe: verdict adopted, no failures, duration computed", () => {
    const record = evaluateProbe(probe, { execution, before, after }, events, context, env);
    expect(record.failures).toEqual([]);
    expect(record.verdict).toBe("supported");
    expect(record.duration_ms).toBe(4000);
    expect(record.db_delta.inserted).toHaveLength(1);
    expect(record.crash).toBeNull();
  });

  it("tier mismatch and unexpected crash both fail the probe", () => {
    const noisyEvents = [
      mark("U03", "start"),
      ev("frontmost", { bundleId: THINGS }),
      mark("U03", "end"),
    ];
    const r1 = evaluateProbe(probe, { execution, before, after }, noisyEvents, context, env);
    expect(r1.verdict).toBe("mismatch");
    expect(r1.failures.some((f) => f.includes("tier 2 observed"))).toBe(true);

    const crashed = { ...execution, crash: { pidDied: true, ipsFiles: ["Things3.ips"] } };
    const r2 = evaluateProbe(probe, { execution: crashed, before, after }, events, context, env);
    expect(r2.failures.some((f) => f.includes("unexpected crash"))).toBe(true);
  });

  it("non-zero exits fail unless allowNonzeroExit", () => {
    const failedCmd = {
      ...execution,
      commands: [
        { resolved: "osascript -e …", exitCode: 1, stdout: "", stderr: "err", durationMs: 5 },
      ],
    };
    const r1 = evaluateProbe(probe, { execution: failedCmd, before, after }, events, context, env);
    expect(r1.failures.some((f) => f.includes("exited 1"))).toBe(true);

    const tolerant: ProbeSpec = {
      ...probe,
      expect: { ...probe.expect, allowNonzeroExit: true },
    };
    const r2 = evaluateProbe(
      tolerant,
      { execution: failedCmd, before, after },
      events,
      context,
      env,
    );
    expect(r2.failures.some((f) => f.includes("exited"))).toBe(false);
  });

  it("compareVerdicts flags any drift between two runs", () => {
    const a: VerdictsFile = {
      U01: { ok: true, verdict: "supported", tier: 2, crash: false, failures: [] },
      U02: { ok: true, verdict: "unsupported", tier: 3, crash: false, failures: [] },
    };
    expect(compareVerdicts(a, structuredClone(a)).identical).toBe(true);

    const b = structuredClone(a);
    b.U02 = { ok: true, verdict: "unsupported", tier: 2, crash: false, failures: [] };
    const cmp = compareVerdicts(a, b);
    expect(cmp.identical).toBe(false);
    expect(cmp.diffs).toEqual(["U02: tier 3 vs 2"]);
  });
});
