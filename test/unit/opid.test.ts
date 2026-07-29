/**
 * The shared single-op idempotency helpers: `findAppliedOpId` (the lookback
 * window + ok-only match rule) and `replayResultFromRecord` (the replay result
 * built from a matched audit record). These are the core the client `run` entry
 * and the batch path both key on, so they are pinned directly here.
 */
import { describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import { undoToken } from "../../src/audit/schema.ts";
import { findAppliedOpId } from "../../src/write/opid.ts";
import { replayResultFromRecord } from "../../src/write/pipeline.ts";

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

describe("findAppliedOpId", () => {
  it("matches the newest ok record carrying the id", () => {
    const records = [
      record({ ts: "2026-07-20T10:00:00Z", opId: "k", uuid: "OLD" }),
      record({ ts: "2026-07-20T11:00:00Z", opId: "k", uuid: "NEW" }),
      record({ ts: "2026-07-20T11:30:00Z", opId: "other", uuid: "X" }),
    ];
    expect(findAppliedOpId(records, "k", NOW)?.uuid).toBe("NEW");
  });

  it("returns undefined when no record carries the id", () => {
    expect(findAppliedOpId([record({ opId: "k" })], "missing", NOW)).toBeUndefined();
  });

  it("matches VERIFIED-OK records only — a verify-failed record with the same id does NOT match", () => {
    const records = [
      record({ opId: "k", result: "verify-failed:timeout", uuid: "FAILED" }),
      record({ opId: "k", result: "verify-failed:silent-noop", uuid: "FAILED2" }),
      record({ opId: "k", result: "blocked:H-UNKNOWN-TAG", uuid: null }),
      record({ opId: "k", result: "intent", uuid: "INTENT" }),
    ];
    expect(findAppliedOpId(records, "k", NOW)).toBeUndefined();
  });

  it("ignores records older than the 7-day window", () => {
    const stale = record({ ts: "2026-07-01T12:00:00Z", opId: "k", uuid: "STALE" }); // 19 days back
    expect(findAppliedOpId([stale], "k", NOW)).toBeUndefined();
  });

  it("only scans the last 1000 records", () => {
    const filler = Array.from({ length: 1000 }, () => record({ opId: "noise" }));
    const target = record({ opId: "k", uuid: "TARGET" });
    // target is now the 1001st-from-end → outside the window.
    expect(findAppliedOpId([target, ...filler], "k", NOW)).toBeUndefined();
    // within the window, it matches.
    expect(findAppliedOpId([target, ...filler.slice(1)], "k", NOW)?.uuid).toBe("TARGET");
  });
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
