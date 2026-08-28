/**
 * The shared single-op idempotency helpers: `findOpIdRecord` (the lookback
 * window + match rule), `presenceOracle` (which recorded assertions can settle a
 * timed-out attempt after the fact), and `replayResultFromRecord` (the replay
 * result built from a matched audit record). These are the core the client `run`
 * entry and the batch path both key on, so they are pinned directly here; the
 * reconciliation they feed is exercised end-to-end against the simulator in
 * `test/engine/write-opid-reconcile.test.ts`.
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import { undoToken } from "../../src/audit/schema.ts";
import {
  findOpIdRecord,
  findPendingIntent,
  presenceOracle,
  resolveOpId,
} from "../../src/write/opid.ts";
import { replayResultFromRecord } from "../../src/write/pipeline.ts";
import type { DeltaSpec } from "../../src/write/verify/delta.ts";

const NOW = new Date("2026-07-20T12:00:00Z");

function record(over: Partial<AuditRecord>): AuditRecord {
  return {
    v: 1,
    ts: NOW.toISOString(),
    actor: "test",
    host: "test-host",
    op: "todo.complete",
    uuid: "UUID-1",
    vector: "url-scheme",
    disruption: 0,
    invocation: "things:///…",
    requested: {},
    pre: null,
    observed: null,
    result: "ok",
    verify: { attempts: 1, elapsedMs: 5 },
    durationMs: 10,
    env: { pkg: "0.0.0", dbVersion: 26, fingerprint: "ok" },
    ...over,
  };
}

describe("findOpIdRecord", () => {
  it("matches the newest ok record carrying the id", () => {
    const records = [
      record({ ts: "2026-07-20T10:00:00Z", opId: "k", uuid: "OLD" }),
      record({ ts: "2026-07-20T11:00:00Z", opId: "k", uuid: "NEW" }),
      record({ ts: "2026-07-20T11:30:00Z", opId: "other", uuid: "X" }),
    ];
    expect(findOpIdRecord(records, "k", NOW)?.uuid).toBe("NEW");
  });

  it("returns undefined when no record carries the id", () => {
    expect(findOpIdRecord([record({ opId: "k" })], "missing", NOW)).toBeUndefined();
  });

  it("matches a TIMED-OUT record too — the ambiguous outcome reconciliation acts on", () => {
    const records = [record({ opId: "k", result: "verify-failed:timeout", uuid: "MAYBE" })];
    expect(findOpIdRecord(records, "k", NOW)?.uuid).toBe("MAYBE");
  });

  it("matches nothing else — a mismatch, a refusal, and an intent marker are all skipped", () => {
    const records = [
      record({ opId: "k", result: "verify-failed:mismatch", uuid: "WRONG" }),
      record({ opId: "k", result: "verify-failed:silent-noop", uuid: "NOOP" }),
      record({ opId: "k", result: "verify-failed:ui-unreachable", uuid: "BLIND" }),
      record({ opId: "k", result: "blocked:H-UNKNOWN-TAG", uuid: null }),
      record({ opId: "k", result: "intent", uuid: "INTENT" }),
    ];
    expect(findOpIdRecord(records, "k", NOW)).toBeUndefined();
  });

  it("a later ok record supersedes an earlier timeout under the same key", () => {
    const records = [
      record({ ts: "2026-07-20T10:00:00Z", opId: "k", result: "verify-failed:timeout", uuid: "T" }),
      record({ ts: "2026-07-20T11:00:00Z", opId: "k", uuid: "CONFIRMED" }),
    ];
    const match = findOpIdRecord(records, "k", NOW);
    expect(match?.uuid).toBe("CONFIRMED");
    expect(match?.result).toBe("ok");
  });

  it("ignores records older than the 7-day window", () => {
    const stale = record({ ts: "2026-07-01T12:00:00Z", opId: "k", uuid: "STALE" }); // 19 days back
    expect(findOpIdRecord([stale], "k", NOW)).toBeUndefined();
  });

  it("only scans the last 1000 records", () => {
    const filler = Array.from({ length: 1000 }, () => record({ opId: "noise" }));
    const target = record({ opId: "k", uuid: "TARGET" });
    // target is now the 1001st-from-end → outside the window.
    expect(findOpIdRecord([target, ...filler], "k", NOW)).toBeUndefined();
    // within the window, it matches.
    expect(findOpIdRecord([target, ...filler.slice(1)], "k", NOW)?.uuid).toBe("TARGET");
  });
});

describe("findPendingIntent — is this key in flight right now? (#639)", () => {
  it("an intent with no final after it is pending", () => {
    const records = [record({ opId: "k", result: "intent", uuid: "RUNNING" })];
    expect(findPendingIntent(records, "k", NOW)?.uuid).toBe("RUNNING");
  });

  it("a final of ANY class supersedes its own attempt's intent", () => {
    for (const result of ["ok", "verify-failed:timeout", "blocked:lock", "unsupported"] as const) {
      const records = [record({ opId: "k", result: "intent" }), record({ opId: "k", result })];
      expect(findPendingIntent(records, "k", NOW), result).toBeUndefined();
    }
  });

  it("pairing is by ts, NOT by position — the trail is re-sorted before it gets here", () => {
    // `readAuditRecords` re-sorts by `ts`, so a "the last record wins" rule reads
    // whatever the sort happened to put last. This is the TORPH1 cell-B shape,
    // where a composite's intent briefly carried a LATER ts than its own summary
    // and every finished promote read as permanently in flight.
    const records = [
      record({ ts: "2026-07-20T11:00:00Z", opId: "k", result: "ok", uuid: "LANDED" }),
      record({ ts: "2026-07-20T11:00:00Z", opId: "k", result: "intent" }),
    ];
    expect(findPendingIntent(records, "k", NOW)).toBeUndefined();
  });

  it("a RE-DISPATCHED key is pending again — the unpaired intent is the live one", () => {
    const records = [
      record({ ts: "2026-07-20T10:00:00Z", opId: "k", result: "intent", uuid: "FIRST" }),
      record({ ts: "2026-07-20T10:00:00Z", opId: "k", result: "verify-failed:timeout" }),
      record({ ts: "2026-07-20T11:00:00Z", opId: "k", result: "intent", uuid: "SECOND" }),
    ];
    expect(findPendingIntent(records, "k", NOW)?.uuid).toBe("SECOND");
  });

  it("another key's intent is not this key's", () => {
    expect(
      findPendingIntent([record({ opId: "other", result: "intent" })], "k", NOW),
    ).toBeUndefined();
  });

  it("ignores an intent older than the 7-day window", () => {
    const stale = record({ ts: "2026-07-01T12:00:00Z", opId: "k", result: "intent" });
    expect(findPendingIntent([stale], "k", NOW)).toBeUndefined();
  });
});

/**
 * A REAL pid that has really exited: spawnSync returns only after the child is
 * reaped, so this number named a process and no longer does — the shape a killed
 * writer leaves behind, and the one case `pidAlive` must answer false for.
 */
function deadHolder(): { pid: number; start: string } {
  return {
    pid: spawnSync(process.execPath, ["-e", ""]).pid as number,
    start: "Wed Aug 26 09:00:00 2026",
  };
}

describe("resolveOpId — a live holder REFUSES, a dead one reconciles (#639)", () => {
  /** Deps stubbed down to what the intent branches touch (no db read reached). */
  const deps = { now: () => NOW } as unknown as Parameters<typeof resolveOpId>[0];
  const liveHolder = { pid: process.pid, start: null };

  it("a LIVE holder's intent refuses with blocked:in-flight, pointing at op-result", () => {
    const records = [record({ opId: "k", result: "intent", holder: liveHolder })];
    const decision = resolveOpId(deps, records, "k", NOW);
    expect(decision).toMatchObject({ kind: "blocked", reason: "in-flight", op: "todo.complete" });
    expect(decision?.kind === "blocked" && decision.detail).toContain("STILL RUNNING");
    expect(decision?.kind === "blocked" && decision.remediation).toContain("things op-result k");
  });

  it("a live intent WINS over an older matchable final for the same key", () => {
    // The retry-after-timeout shape: replaying the stale timeout here would hand
    // back a change the running attempt has not finished making.
    const records = [
      record({ ts: "2026-07-20T10:00:00Z", opId: "k", result: "verify-failed:timeout" }),
      record({ ts: "2026-07-20T11:00:00Z", opId: "k", result: "intent", holder: liveHolder }),
    ];
    expect(resolveOpId(deps, records, "k", NOW)).toMatchObject({ reason: "in-flight" });
  });

  it("an intent with NO holder is treated as live — the safe unknowable answer", () => {
    const records = [record({ opId: "k", result: "intent" })];
    expect(resolveOpId(deps, records, "k", NOW)).toMatchObject({ reason: "in-flight" });
  });

  it("a DEAD holder's intent with no oracle refuses honestly with blocked:reconcile", () => {
    const records = [record({ opId: "k", result: "intent", holder: deadHolder() })];
    const decision = resolveOpId(deps, records, "k", NOW);
    expect(decision).toMatchObject({ kind: "blocked", reason: "reconcile" });
    expect(
      decision?.kind === "blocked" && decision.detail,
      "the refusal says the process ENDED, not that it timed out",
    ).toContain("process ended without recording an outcome");
  });

  it("a superseded intent is invisible — the final decides, as before", () => {
    const records = [
      record({ opId: "k", result: "intent", holder: liveHolder }),
      record({ opId: "k", result: "ok", uuid: "LANDED" }),
    ];
    expect(resolveOpId(deps, records, "k", NOW)).toMatchObject({
      kind: "ok",
      uuid: "LANDED",
      alreadyApplied: true,
    });
  });
});

describe("presenceOracle — which recorded assertion can settle a timed-out attempt", () => {
  const usable: [string, DeltaSpec][] = [
    [
      "an update naming a field",
      { mode: "update", uuid: "U", assert: [{ field: "status", equals: "completed" }] },
    ],
    [
      "a state change naming a field",
      { mode: "state", uuid: "U", assert: [{ field: "status", equals: "canceled" }] },
    ],
    [
      "a state change whose only assertion is on a cascaded child",
      {
        mode: "state",
        uuid: "U",
        assert: [],
        cascade: [{ uuid: "C", assert: [{ field: "status", equals: "canceled" }] }],
      },
    ],
    [
      "a time-bounded creation probe",
      {
        mode: "create",
        probe: { title: "T", type: "to-do", sinceEpoch: 1_780_000_000 },
        assert: [],
      },
    ],
    ["a deletion", { mode: "gone", entity: "task", uuid: "U" }],
    [
      "an area/tag creation probe",
      { mode: "entity-created", entity: "tag", title: "T", excludeUuids: ["A"] },
    ],
    [
      "an area/tag field update",
      {
        mode: "entity-updated",
        entity: "area",
        uuid: "A",
        assert: [{ field: "title", equals: "X" }],
      },
    ],
    ["an ordering of two or more items", { mode: "ordering", key: "index", sequence: ["A", "B"] }],
  ];
  for (const [label, spec] of usable) {
    it(`settles ${label}`, () => {
      expect(presenceOracle(spec).usable).toBe(true);
    });
  }

  const unusable: [string, DeltaSpec | undefined][] = [
    ["nothing recorded at all", undefined],
    ["an update naming no field", { mode: "update", uuid: "U", assert: [] }],
    [
      "an area/tag update naming no field",
      { mode: "entity-updated", entity: "tag", uuid: "T", assert: [] },
    ],
    [
      "a creation probe with no time bound",
      { mode: "create", probe: { title: "T", type: "to-do", sinceEpoch: 0 }, assert: [] },
    ],
    ["a one-item ordering", { mode: "ordering", key: "index", sequence: ["A"] }],
    ["emptying the Trash", { mode: "trash-emptied" }],
    ["logging finished items", { mode: "logged-now", pending: 3, manualLogDatePre: 1_780_000_000 }],
  ];
  for (const [label, spec] of unusable) {
    it(`refuses to settle ${label}`, () => {
      const oracle = presenceOracle(spec);
      expect(oracle.usable, label).toBe(false);
      // The `why` completes the refusal's sentence, so it must be a real clause.
      if (oracle.usable) throw new Error("unreachable");
      expect(oracle.why.length).toBeGreaterThan(20);
    });
  }
});

describe("replayResultFromRecord", () => {
  it("echoes the original identity with alreadyApplied and a re-derived undoToken", () => {
    const r = record({ op: "todo.complete", uuid: "UUID-9", opId: "k" });
    const replay = replayResultFromRecord(r);
    expect(replay.kind).toBe("ok");
    if (replay.kind !== "ok") throw new Error("unreachable");
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.op).toBe("todo.complete");
    expect(replay.uuid).toBe("UUID-9");
    // The token is the SAME content-addressed token the original write returned.
    expect(replay.undoToken).toBe(
      undoToken({ ts: r.ts, op: r.op, actor: r.actor, host: r.host, uuid: r.uuid }),
    );
  });

  it("surfaces the requested title when the record stored one (a create)", () => {
    const r = record({ op: "todo.add", uuid: "NEW", requested: { title: "Buy milk" } });
    const replay = replayResultFromRecord(r);
    if (replay.kind !== "ok") throw new Error("unreachable");
    expect(replay.title).toBe("Buy milk");
  });

  it("omits the undoToken for an irreversible op", () => {
    const r = record({ op: "tag.delete", uuid: null, requested: { target: "old-tag" } });
    const replay = replayResultFromRecord(r);
    if (replay.kind !== "ok") throw new Error("unreachable");
    expect(replay.undoToken).toBeUndefined();
    expect(replay.alreadyApplied).toBe(true);
  });
});
