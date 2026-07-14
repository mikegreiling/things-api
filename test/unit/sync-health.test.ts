import { describe, expect, it } from "vitest";

import {
  computeSyncHealth,
  decodeBplistScalarDouble,
  describeAge,
  selectNearestNsDate,
  type SyncHealthDeps,
} from "../../src/sync-health.ts";
import { bplistScalarDouble } from "../fixtures/seed.ts";

/** NSDate epoch offset (2001-01-01Z in Unix seconds). */
const NSDATE_OFFSET = 978_307_200;
/** A fixed clock: 2026-07-13T18:14:22Z. */
const NOW_MS = Date.UTC(2026, 6, 13, 18, 14, 22);
const NOW_NSDATE = NOW_MS / 1000 - NSDATE_OFFSET;

/** A minimal db double whose prepare().get()/all() return fixed rows. */
function fakeDb(opts: {
  maxMod?: number | null;
  syncronyRows?: Array<{ uuid: string; value: Uint8Array }> | "no-table";
}): { prepare(sql: string): { get(): unknown; all(): unknown[] } } {
  return {
    prepare(sql: string) {
      if (sql.includes("MAX(userModificationDate)")) {
        return { get: () => ({ m: opts.maxMod ?? null }), all: () => [] };
      }
      if (sql.includes("BSSyncronyMetadata")) {
        if (opts.syncronyRows === "no-table") throw new Error("no such table: BSSyncronyMetadata");
        const rows: unknown[] = opts.syncronyRows ?? [];
        return { get: () => undefined, all: () => rows };
      }
      return { get: () => undefined, all: () => [] };
    },
  };
}

const NEVER_FOREGROUND: SyncHealthDeps["readForegroundMs"] = () => null;

describe("bplist scalar-double decoding", () => {
  it("decodes a real (0x23) double round-trip", () => {
    const bytes = bplistScalarDouble(805_659_262.1);
    expect(decodeBplistScalarDouble(bytes)).toBeCloseTo(805_659_262.1, 3);
  });

  it("decodes an NSDate (0x33) double round-trip", () => {
    const bytes = bplistScalarDouble(805_659_262.1, { date: true });
    expect(decodeBplistScalarDouble(bytes)).toBeCloseTo(805_659_262.1, 3);
  });

  it("returns null for non-scalar-double or malformed bytes", () => {
    expect(decodeBplistScalarDouble(null)).toBeNull();
    expect(decodeBplistScalarDouble(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(
      decodeBplistScalarDouble(new TextEncoder().encode("not a bplist at all......")),
    ).toBeNull();
  });
});

describe("last-sync selection (lease-sentinel exclusion)", () => {
  it("excludes the ~now+31yr lease sentinel and picks nearest-to-now", () => {
    const lastSync = NOW_NSDATE - 30; // 30s ago
    const lease = NOW_NSDATE + 31 * 365 * 24 * 3600; // now + 31 years
    expect(selectNearestNsDate([lease, lastSync], NOW_NSDATE)).toBe(lastSync);
    // Sentinel-only input yields nothing usable.
    expect(selectNearestNsDate([lease], NOW_NSDATE)).toBeNull();
  });
});

describe("describeAge", () => {
  it("buckets seconds/minutes/hours/days", () => {
    expect(describeAge(12)).toBe("12s ago");
    expect(describeAge(300)).toBe("5m ago");
    expect(describeAge(3 * 3600)).toBe("3h ago");
    expect(describeAge(3 * 86_400)).toBe("3d ago");
    expect(describeAge(null)).toBe("at an unknown time");
  });
});

describe("WAL staleness verdict (injected clock)", () => {
  const base: SyncHealthDeps = {
    now: () => NOW_MS,
    readForegroundMs: NEVER_FOREGROUND,
  };

  it("fresh when the app is running and the WAL was written recently", () => {
    const sh = computeSyncHealth(fakeDb({}), "/x/main.sqlite", {
      ...base,
      isAppRunning: () => true,
      walMtimeMs: () => NOW_MS - 12_000, // 12s ago
    });
    expect(sh.wal.stale).toBe(false);
    expect(sh.wal.ageSeconds).toBe(12);
    expect(sh.wal.verdict).toContain("fresh");
  });

  it("stale when the app is running but the WAL is older than the threshold", () => {
    const sh = computeSyncHealth(fakeDb({}), "/x/main.sqlite", {
      ...base,
      isAppRunning: () => true,
      walMtimeMs: () => NOW_MS - 40 * 3600 * 1000, // 40h ago
      walStaleSeconds: 24 * 3600,
    });
    expect(sh.wal.stale).toBe(true);
    expect(sh.wal.verdict).toContain("may be stuck");
  });

  it("cannot judge staleness when the app is not running (stale = null)", () => {
    const sh = computeSyncHealth(fakeDb({}), "/x/main.sqlite", {
      ...base,
      isAppRunning: () => false,
      walMtimeMs: () => NOW_MS - 40 * 3600 * 1000,
    });
    expect(sh.wal.stale).toBeNull();
    expect(sh.appRunning.running).toBe(false);
    expect(sh.appRunning.verdict).toContain("NOT running");
  });

  it("reports no WAL sidecar when the mtime is unavailable", () => {
    const sh = computeSyncHealth(fakeDb({}), "/x/main.sqlite", {
      ...base,
      isAppRunning: () => true,
      walMtimeMs: () => null,
    });
    expect(sh.wal.stale).toBeNull();
    expect(sh.wal.mtime).toBeNull();
    expect(sh.wal.verdict).toContain("sidecar");
  });
});

describe("cloud last-sync signal", () => {
  const base: SyncHealthDeps = {
    now: () => NOW_MS,
    isAppRunning: () => true,
    walMtimeMs: () => NOW_MS,
    readForegroundMs: NEVER_FOREGROUND,
  };

  it("reports no account when BSSyncronyMetadata is empty", () => {
    const sh = computeSyncHealth(fakeDb({ syncronyRows: [] }), "/x/main.sqlite", base);
    expect(sh.cloud.accountAttached).toBe(false);
    expect(sh.cloud.lastSyncAttempt).toBeNull();
    expect(sh.cloud.verdict).toContain("no Things Cloud account");
  });

  it("reports no account when the table is absent (older schema)", () => {
    const sh = computeSyncHealth(fakeDb({ syncronyRows: "no-table" }), "/x/main.sqlite", base);
    expect(sh.cloud.accountAttached).toBe(false);
    expect(sh.cloud.verdict).toContain("no Things Cloud account");
  });

  it("reads the known-key last-sync timestamp and words it as an attempt", () => {
    const nsdate = NOW_NSDATE - 30;
    const sh = computeSyncHealth(
      fakeDb({
        syncronyRows: [
          { uuid: "GryCJ44xPcJG6go5KeTZp1", value: bplistScalarDouble(nsdate, { date: true }) },
          { uuid: "someCounter", value: new Uint8Array([1]) }, // decodes to null, ignored
        ],
      }),
      "/x/main.sqlite",
      base,
    );
    expect(sh.cloud.accountAttached).toBe(true);
    expect(sh.cloud.keySource).toBe("known-key");
    expect(sh.cloud.ageSeconds).toBe(30);
    expect(sh.cloud.verdict).toContain("last sync attempt");
    expect(sh.cloud.verdict).toContain("offline");
  });

  it("falls back to nearest-to-now when the account key is absent, excluding the lease", () => {
    const lastSync = NOW_NSDATE - 45;
    const lease = NOW_NSDATE + 31 * 365 * 24 * 3600;
    const sh = computeSyncHealth(
      fakeDb({
        syncronyRows: [
          { uuid: "leaseKey", value: bplistScalarDouble(lease, { date: true }) },
          { uuid: "unknownKey", value: bplistScalarDouble(lastSync, { date: true }) },
        ],
      }),
      "/x/main.sqlite",
      base,
    );
    expect(sh.cloud.keySource).toBe("nearest-to-now");
    expect(sh.cloud.ageSeconds).toBe(45);
    expect(sh.cloud.verdict).toContain("identified by value");
  });
});
