// SIMFID host-side replay: drive one covered op through the FULL write pipeline
// with the simulator vector, against a fresh synthetic fixture, capturing the
// row-level DB delta. This is the same end-to-end path
// test/engine/write-simulator.test.ts exercises — guards → plan → execute →
// verified read-after-write → audit — so the captured SIM delta is exactly what
// the appliers produce in production simulation, not a re-derivation.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import type { OperationKind } from "../../src/write/operations.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import { buildFixtureDb } from "../../test/fixtures/build-db.ts";
import { diffSnapshots } from "../runner/differ.ts";
import type { SimfidCase } from "./cases.ts";
import { snapshotDb } from "./snapshot.ts";
import type { RawCapture } from "./types.ts";

/** Pinned instant — matches the RSIM campaigns' clock (2026-07-05 12:00, a Sunday). */
const NOW = new Date("2026-07-05T12:00:00Z");

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 3,
  actor: "simfid",
  auditEnabled: true,
  acceptedFingerprint: null,
  allowExperimental: false,
  ui: { enabled: true },
  host: "simfid-host",
};

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:simfid" },
  };
}

export interface ReplayResult {
  capture: RawCapture;
  resultKind: string;
  error?: string;
}

/**
 * Replay a case's op through the simulator and capture its row-level delta.
 * Sets the simulator fence env for the duration and restores it after.
 */
export async function replaySimCase(caseDef: SimfidCase): Promise<ReplayResult> {
  const fixture = buildFixtureDb({ benchMarker: true });
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    saved[k] = process.env[k];
    process.env[k] = v;
  };
  setEnv("THINGS_SIM_WRITES", "1");
  setEnv("THINGS_DB", fixture.path);
  setEnv("THINGS_API_STATE_DIR", mkdtempSync(join(tmpdir(), "simfid-state-")));
  setEnv("THINGS_API_CONFIG_DIR", mkdtempSync(join(tmpdir(), "simfid-config-")));

  try {
    const { params, opts } = caseDef.seed(fixture.db);
    const auditRecords: AuditRecord[] = [];
    const deps: WriteDeps = {
      db: fixture.db,
      vectors: [createSimulatorVector(fixture.path, { now: () => NOW })],
      config: CONFIG,
      audit: { append: (r) => auditRecords.push(r) },
      fingerprint: okFingerprint,
      lockPath: join(tmpdir(), `simfid-lock-${process.pid}-${caseDef.id}`),
      isAppRunning: () => true,
      ensureRunning: async () => true,
      now: () => NOW,
    };

    const before = snapshotDb(fixture.db);
    const res = await runMutation(deps, caseDef.op as OperationKind, params as never, opts ?? {});
    const after = snapshotDb(fixture.db);
    const delta = diffSnapshots(before, after);

    return {
      capture: { before, after, delta },
      resultKind: res.kind,
      ...(res.kind !== "ok" ? { error: `runMutation ${res.kind}: ${describe(res)}` } : {}),
    };
  } finally {
    fixture.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function describe(res: { kind: string } & Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof res["reason"] === "string") parts.push(res["reason"]);
  if (typeof res["detail"] === "string") parts.push(res["detail"]);
  return parts.join(" — ") || res.kind;
}
