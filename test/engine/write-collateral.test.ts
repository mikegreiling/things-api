/**
 * UNEXPLAINED-DELTA DETECTION end to end (CGRD1 guard 3): a reschedule that lands
 * the requested rule AND moves a field nobody asked about is a
 * `verify-failed:collateral`, not an `ok`.
 *
 * The pipeline runs against the fixture DB with the SIMULATOR write vector
 * applying each write as SQL. Three of the four cells use the simulator exactly as
 * it ships; the collateral cell wraps it in a test-owned decorator that performs
 * one extra unrequested write after the applier — the seam, kept entirely in the
 * test so no production path learns how to corrupt itself.
 *
 * Cells:
 *   - a clean reschedule                      → ok
 *   - a requested-field-only change           → ok
 *   - a MAPPED CO-MOVER moving with a request → ok (the anchor a frequency change
 *                                                   rebuilds is not collateral)
 *   - a simulated collateral write            → verify-failed:collateral, naming
 *                                                the field and both values
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { decodeRecurrenceRule } from "../../src/model/recurrence.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
import type { CompiledInvocation, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";
import { makeTempDir } from "../fixtures/temp-dir.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
const GUI = { dangerouslyDriveGui: true } as const;

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

const CONFIG: ThingsApiConfig = {
  profile: "workstation",
  maxDisruption: 1,
  actor: "test-actor",
  auditEnabled: true,
  acceptedFingerprint: null,
  certifiedAppVersion: null,
  allowExperimental: false,
  experimentalAreaReorder: true,
  bounceEnabled: true,
  bounceMaxItems: 30,
  autoLaunch: true,
  helpersMode: "false",
  ui: { enabled: false },
  host: "test-host",
};

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

function deps(vector: WriteVector): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: CONFIG,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-collateral-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
    // Advance an injected clock instead of sleeping, so the verify poll is instant.
    poller: (() => {
      let t = 0;
      return { now: () => t, sleep: async (ms: number) => void (t += ms) };
    })(),
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * THE TEST SEAM. Wrap the shipped simulator so that, after it applies the
 * requested rule, ONE extra unrequested column is written — the shape of a GUI
 * drive that ticked a control nobody asked about. Living here rather than in the
 * simulator keeps the production applier honest.
 */
function withCollateralWrite(inner: WriteVector, sql: string, uuid: string): WriteVector {
  return {
    ...inner,
    async execute(invocation: CompiledInvocation) {
      const res = await inner.execute(invocation);
      if (res.exitCode === 0) fixture.db.prepare(sql).run(uuid);
      return res;
    },
  };
}

describe("reschedule-repeat: an unrequested field movement is verify-failed:collateral", () => {
  let savedSim: string | undefined;
  let savedDb: string | undefined;
  let savedState: string | undefined;
  let savedConfig: string | undefined;
  let vector: WriteVector;

  beforeEach(() => {
    fixture = buildFixtureDb({ benchMarker: true });
    auditRecords = [];
    savedSim = process.env["THINGS_SIM_WRITES"];
    savedDb = process.env["THINGS_DB"];
    savedState = process.env["THINGS_API_STATE_DIR"];
    savedConfig = process.env["THINGS_API_CONFIG_DIR"];
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    process.env["THINGS_API_STATE_DIR"] = makeTempDir("collateral-state");
    process.env["THINGS_API_CONFIG_DIR"] = makeTempDir("collateral-config");
    vector = createSimulatorVector(fixture.path, { now: () => NOW });
  });
  afterEach(() => {
    restoreEnv("THINGS_SIM_WRITES", savedSim);
    restoreEnv("THINGS_DB", savedDb);
    restoreEnv("THINGS_API_STATE_DIR", savedState);
    restoreEnv("THINGS_API_CONFIG_DIR", savedConfig);
    fixture.close();
  });

  /** A weekly repeating template to reschedule, minted through the simulator. */
  async function template(title: string): Promise<string> {
    const src = seedTodo(fixture.db, { title, start: "active" });
    const made = await runMutation(
      deps(vector),
      "todo.make-repeating",
      { uuid: src, frequency: "weekly", interval: 1 },
      GUI,
    );
    if (made.kind !== "ok" || made.uuid === null) throw new Error("expected a template uuid");
    return made.uuid;
  }

  const ruleOf = (uuid: string): ReturnType<typeof decodeRecurrenceRule> => {
    const row = fixture.db
      .prepare("SELECT rt1_recurrenceRule AS rule FROM TMTask WHERE uuid = ?")
      .get(uuid) as { rule: unknown };
    return decodeRecurrenceRule(row.rule);
  };

  it("a clean reschedule verifies ok — nothing moved that was not asked for", async () => {
    const tmpl = await template("Sweep the deck");
    const res = await runMutation(
      deps(vector),
      "todo.reschedule-repeat",
      { uuid: tmpl, frequency: "daily", interval: 2 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    expect(ruleOf(tmpl)).toMatchObject({ unit: "daily", interval: 2 });
  });

  it("a requested-field-only change verifies ok (interval alone)", async () => {
    const tmpl = await template("Water the plants");
    const res = await runMutation(
      deps(vector),
      "todo.reschedule-repeat",
      { uuid: tmpl, frequency: "weekly", interval: 3 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    expect(ruleOf(tmpl)).toMatchObject({ unit: "weekly", interval: 3 });
  });

  it("a MAPPED CO-MOVER is not collateral: a frequency change rebuilds the anchor", async () => {
    // weekly (anchored on a weekday offset) → monthly rewrites the calendar
    // anchor entirely. Nobody requested an anchor; the map says a frequency change
    // brings one, so the write must still verify ok. This is the cell that would
    // fail if the attribution map were merely "requested fields only".
    const tmpl = await template("Change the filter");
    const before = ruleOf(tmpl);
    const res = await runMutation(
      deps(vector),
      "todo.reschedule-repeat",
      { uuid: tmpl, frequency: "monthly", interval: 1 },
      GUI,
    );
    expect(res.kind).toBe("ok");
    const after = ruleOf(tmpl);
    expect(after.unit).toBe("monthly");
    // The anchor really did move — the co-mover clause is load-bearing here.
    expect(JSON.stringify(after.offsets)).not.toBe(JSON.stringify(before.offsets));
  });

  it("an unrequested field movement fails as collateral, naming it and both values", async () => {
    const tmpl = await template("Rotate the compost");
    // The seam: the requested daily/2 rule lands, and the series is ALSO paused —
    // which no reschedule asks for and no measured app behavior brings along.
    const poisoned = withCollateralWrite(
      vector,
      "UPDATE TMTask SET rt1_instanceCreationPaused = 1 WHERE uuid = ?",
      tmpl,
    );
    const res = await runMutation(
      deps(poisoned),
      "todo.reschedule-repeat",
      { uuid: tmpl, frequency: "daily", interval: 2 },
      GUI,
    );
    expect(res.kind).toBe("verify-failed");
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.reason).toBe("collateral");
    // The copy names the field and both values, and tells the caller not to retry.
    expect(res.detail).toContain("the paused flag");
    expect(res.detail).toContain("the requested repeat rule was applied");
    expect(res.detail).toMatch(/went from .* to .*/);
    // The requested change DID land — that is the whole point of the verdict.
    expect(ruleOf(tmpl)).toMatchObject({ unit: "daily", interval: 2 });
    // …and the trail records the distinct code.
    expect(auditRecords.some((a) => a.result === "verify-failed:collateral")).toBe(true);
  });

  it("the moved field rides the failure's observed bag", async () => {
    const tmpl = await template("Descale the kettle");
    const poisoned = withCollateralWrite(
      vector,
      "UPDATE TMTask SET rt1_instanceCreationPaused = 1 WHERE uuid = ?",
      tmpl,
    );
    const res = await runMutation(
      deps(poisoned),
      "todo.reschedule-repeat",
      { uuid: tmpl, frequency: "daily", interval: 2 },
      GUI,
    );
    if (res.kind !== "verify-failed") throw new Error("expected verify-failed");
    expect(res.observed?.["repeating.paused"]).toBe(true);
  });
});
