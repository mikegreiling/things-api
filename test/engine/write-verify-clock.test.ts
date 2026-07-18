/**
 * Regression: the verified read-after-write must gate `todaySection` on the
 * INJECTED clock (deps.now / deps.zone), never the wall clock.
 *
 * The #211 todaySection fix threaded `packedToday` through the read surfaces,
 * but the WRITE pipeline's verify reader (createDbReader) kept resolving
 * `packedToday` from `new Date()`. Under a pinned THINGS_NOW in the FUTURE
 * (consumer-timezone / bench fence), an `evening`/`today` write dated
 * pinned-today is future-dated relative to the wall clock, so a real-clock
 * verify reader omits `todaySection` and the `{ todaySection: "evening" }`
 * create-delta assertion fails as `verify-failed:mismatch` — a correct write
 * reported as a failure (bench-caught: the agent's retry then duplicated state).
 *
 * These tests pin deps.now (and the simulator's now) to a far-future instant,
 * guaranteeing the injected clock is ahead of the wall clock whenever the suite
 * runs. Before the fix the FUTURE case fails; after it, both verify.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { encodePackedDate, localToday } from "../../src/model/dates.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";

// Far enough ahead that the injected clock is ALWAYS in the future relative to
// the wall clock the suite runs under — this is exactly the condition the bug
// needs (pinned-today > real-today makes an evening item look future-dated).
const FUTURE = new Date("2099-06-15T12:00:00Z");
const FUTURE_TODAY = localToday(FUTURE); // "2099-06-15" (date-only, tz-invariant at noon UTC)

let fixture: FixtureDb;

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "test-actor",
  auditEnabled: false,
  acceptedFingerprint: null,
  allowExperimental: false,
  ui: { enabled: false },
  host: "test-host",
};

let lockSeq = 0;

function deps(vector: WriteVector, now: () => Date): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: () => {} },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-vclock-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now,
  };
}

let savedSim: string | undefined;
let savedDb: string | undefined;
let savedState: string | undefined;
let savedConfig: string | undefined;

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  savedSim = process.env["THINGS_SIM_WRITES"];
  savedDb = process.env["THINGS_DB"];
  savedState = process.env["THINGS_API_STATE_DIR"];
  savedConfig = process.env["THINGS_API_CONFIG_DIR"];
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_API_STATE_DIR"] = mkdtempSync(join(tmpdir(), "vclock-state-"));
  process.env["THINGS_API_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "vclock-config-"));
});
afterEach(() => {
  fixture.close();
  restoreEnv("THINGS_SIM_WRITES", savedSim);
  restoreEnv("THINGS_DB", savedDb);
  restoreEnv("THINGS_API_STATE_DIR", savedState);
  restoreEnv("THINGS_API_CONFIG_DIR", savedConfig);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("write verification honors the injected clock (not the wall clock)", () => {
  it("evening write dated a FUTURE pinned-today still verifies (todaySection: evening)", async () => {
    const vector = createSimulatorVector(fixture.path, { now: () => FUTURE });
    const res = await runMutation(
      deps(vector, () => FUTURE),
      "todo.add",
      { title: "Evening probe", when: "evening" },
      { verifyTimeoutMs: 1000 }, // a reintroduced bug fails fast as a mismatch
    );
    // Before the fix: verify-failed:mismatch with observed.todaySection === null,
    // because the verify reader computed packedToday from new Date() (< FUTURE).
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.observed).toMatchObject({
      start: "active",
      startDate: FUTURE_TODAY,
      todaySection: "evening",
    });
    // And the row is genuinely a future-pinned Today/Evening member.
    const row = fixture.db
      .prepare("SELECT startDate, startBucket FROM TMTask WHERE uuid = ?")
      .get(res.uuid) as { startDate: number; startBucket: number };
    expect(row.startDate).toBe(encodePackedDate(FUTURE_TODAY));
    expect(row.startBucket).toBe(1);
  });

  it("today write dated a FUTURE pinned-today still verifies (todaySection: today)", async () => {
    const vector = createSimulatorVector(fixture.path, { now: () => FUTURE });
    const res = await runMutation(
      deps(vector, () => FUTURE),
      "todo.add",
      { title: "Today probe", when: "today" },
      { verifyTimeoutMs: 1000 },
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.observed).toMatchObject({
      start: "active",
      startDate: FUTURE_TODAY,
      todaySection: "today",
    });
  });

  it("control: evening write under a real-ish now verifies too", async () => {
    const now = new Date();
    const vector = createSimulatorVector(fixture.path, { now: () => now });
    const res = await runMutation(
      deps(vector, () => now),
      "todo.add",
      {
        title: "Evening probe (real now)",
        when: "evening",
      },
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.observed).toMatchObject({ todaySection: "evening", startDate: localToday(now) });
  });
});
