/**
 * RAWAX1 — the DEFAULT transport's engine seam (#695).
 *
 * `write-ui-vector.test.ts` certifies the AppleScript fallback and pins
 * `THINGS_API_REPEAT_RAWAX=0` to do it. This suite is the other half: the
 * merged raw-AX path as the driver actually runs it, which is the shape a field
 * drive takes and therefore the one that must not be less covered than its
 * fallback.
 *
 * What it asserts is the SEAM, not the Accessibility calls — those are measured
 * in the lab, on a real dialog, because a mock cannot be wrong in the ways an
 * app is. Here: that a merged group dispatches ONE javascript hop and not a
 * script per step; that the envelope's verdicts (shape, pre-fill, commit) fold
 * back into the driver's own state; that the step trail a caller reads is
 * rebuilt from the per-op report and still names every step; and that a refusal
 * inside a merged hop lands on the ordinary partial-state path carrying the
 * op's own sentence rather than a generic one.
 *
 * The last of those is the fold's whole debt. RDLAT2 §10 declined this merge
 * because it costs per-step failure attribution; if that were true, a refusal
 * here would say "the Repeat dialog could not be driven" instead of naming the
 * control — so the cell that proves otherwise is the one that matters most.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThingsApiConfig } from "../../src/config.ts";
import { createUiVector } from "../../src/write/vectors/ui.ts";
import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";
import { makeRepeatingRecipe } from "../../src/write/vectors/ui-recipes.ts";
import { setInstalledThingsVersion } from "../../src/write/vectors/ui-shape.ts";
import type { CompiledInvocation, UiRecipe } from "../../src/write/vectors/types.ts";
import type { AxEnvelope, AxOpRecord } from "../../src/write/vectors/ui-rawax-ops.ts";

function config(): ThingsApiConfig {
  return {
    dbPath: ":memory:",
    allowExperimental: false,
    experimentalAreaReorder: true,
    bounceEnabled: true,
    bounceMaxItems: 30,
    autoLaunch: true,
    helpersMode: "false",
    ui: { enabled: true },
    host: "test-host",
  } as unknown as ThingsApiConfig;
}

function invocation(recipe: UiRecipe): CompiledInvocation {
  return { vector: "ui", kind: "ui-drive", payload: "test", redactedPayload: "test", recipe };
}

const ok = (stdout = ""): UiRunResult => ({ ok: true, stdout, stderr: "" });

/**
 * The census answer the per-step focus guard and the open-dialog preflight read.
 * Healthy, Things frontmost, no dialog standing — so nothing refuses before the
 * dialog entry, which is the part under test.
 */
function censusAnswer(): UiRunResult {
  return ok(
    JSON.stringify({
      running: true,
      frontmost: true,
      frontmostApp: "Things3",
      sheetOpen: false,
      sheetKind: "none",
      sheetForm: "none",
      sheetDepth: 0,
      sheetControls: null,
      focusOwner: null,
      inspectable: true,
      stalledProbes: [],
      failedProbes: [],
      windows: 1,
    }),
  );
}

/** One op record, in the shape the executor reports. */
function record(label: string, op: string, extra: Partial<AxOpRecord> = {}): AxOpRecord {
  return { label, op, durationMs: 1, axCalls: 3, axElems: 1, verdict: "ok", ...extra };
}

function envelope(env: Partial<AxEnvelope> & { ops: AxOpRecord[] }): string {
  return JSON.stringify({ ok: true, axCalls: 40, axElems: 12, ...env });
}

/**
 * A runner that answers every non-raw hop truthfully and hands each merged hop
 * whatever envelope the cell wants. `raw` collects the javascript commands so a
 * cell can count HOPS rather than steps.
 */
function rawRunner(envelopes: string[]): {
  run: (c: UiCommand, t: number) => Promise<UiRunResult>;
  commands: UiCommand[];
  raw: UiCommand[];
} {
  const commands: UiCommand[] = [];
  const raw: UiCommand[] = [];
  let next = 0;
  return {
    commands,
    raw,
    run: async (c) => {
      commands.push(c);
      if (c.meta?.["rawax"] === true) {
        raw.push(c);
        const body = envelopes[next] ?? envelope({ ops: [] });
        next += 1;
        return ok(body);
      }
      if (c.primitive === "resolve") {
        // The census is a `resolve` too; tell them apart by what the script is.
        return c.script?.includes("frontmost") === true ? censusAnswer() : ok("true");
      }
      if (c.primitive === "dialog-open")
        return ok(
          "idx=1 roles=AXCheckBox,AXCheckBox,AXGroup,AXStaticText,AXPopUpButton,AXButton,AXButton,AXImage",
        );
      if (c.primitive === "assert-eligible") return ok("OK");
      return ok();
    },
  };
}

/** The field's own shape: seeded weekly with a first occurrence. */
function fieldRecipe(): UiRecipe {
  return makeRepeatingRecipe("TODO-1", "weekly", 1, {
    weekdays: ["thursday"],
    next: "2026-07-09",
    seed: { scheduled: "2026-07-09", today: "2026-07-05", deadline: null, reminder: null },
  });
}

describe("the merged raw-AX hop (RAWAX1)", () => {
  beforeEach(() => {
    // The switch is ON by default; these cells state it so a future flip of the
    // default cannot silently change what they mean.
    vi.stubEnv("THINGS_API_REPEAT_RAWAX", "1");
    setInstalledThingsVersion("3.23");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setInstalledThingsVersion(undefined);
  });

  it("dispatches ONE javascript hop per merged group, not a script per step", async () => {
    const { run, raw, commands } = rawRunner([
      envelope({ ops: [record("frequency = weekly", "select-popup")] }),
      envelope({
        ops: [record("measure the shape", "probe-shape", { shape: "next-popup" })],
        shape: "next-popup",
      }),
      envelope({ ops: [record("audit", "audit")], committed: true }),
    ]);
    const vector = createUiVector(config(), run);
    const res = await vector.execute(invocation(fieldRecipe()));
    expect(res.exitCode).toBe(0);
    // Three groups for the SEEDED path: the frequency selection ends its own
    // group because node waits there (DEPOBS3), then the probe run, then the
    // committing tail. `settle-occurrences` dispatches nothing.
    expect(raw).toHaveLength(3);
    for (const hop of raw) expect(hop.lang).toBe("javascript");
    // And the per-step AppleScript setters are gone from the dispatch entirely.
    expect(commands.some((c) => c.primitive === "set-group-number")).toBe(false);
    expect(commands.some((c) => c.primitive === "select-popup")).toBe(false);
  });

  it("folds the envelope's verdicts back into the driver — shape, pre-fill, commit", async () => {
    const { run, raw } = rawRunner([
      envelope({ ops: [record("frequency = weekly", "select-popup")] }),
      envelope({
        ops: [
          record("measure the shape", "probe-shape", { shape: "next-popup" }),
          record("read the pre-filled controls", "verify-prefill", { confirmed: ["interval"] }),
          record("interval = 1", "type-into", { verdict: "skipped", detail: "pre-filled" }),
        ],
        shape: "next-popup",
        confirmed: ["interval"],
      }),
      envelope({ ops: [record("audit", "audit")], committed: true }),
    ]);
    const vector = createUiVector(config(), run);
    const res = await vector.execute(invocation(fieldRecipe()));
    expect(res.exitCode).toBe(0);
    expect(raw).toHaveLength(3);
    // The shape reached the LAST hop's program, which is how the tail's
    // shape-selected addresses are resolved.
    const tail = JSON.parse(
      /var RAWAX_PROGRAM = (\{.*?\});\n/s.exec(raw[2]?.script ?? "")?.[1] ?? "null",
    ) as { shape: string | null };
    expect(tail.shape).toBe("next-popup");
    // The pre-filled key is disclosed in the trail rather than silently dropped.
    expect(res.steps?.join(" | ")).toContain("pre-filled");
  });

  it("names every step in the trail, rebuilt from the per-op report", async () => {
    const { run } = rawRunner([
      envelope({ ops: [record("frequency = weekly", "select-popup")] }),
      envelope({
        ops: [record("measure the shape", "probe-shape", { shape: "next-popup" })],
        shape: "next-popup",
      }),
      envelope({
        ops: [record("audit the Repeat dialog", "audit")],
        committed: true,
      }),
    ]);
    const vector = createUiVector(config(), run);
    const res = await vector.execute(invocation(fieldRecipe()));
    expect(res.exitCode).toBe(0);
    const trail = res.steps?.join(" | ") ?? "";
    expect(trail).toContain("frequency = weekly");
    expect(trail).toContain("audit the Repeat dialog");
    // The OK press rides the audit's script and is still named (RDLAT2 §4d).
    expect(trail).toContain('press "OK"');
  });

  it("carries an op's OWN refusal out, which is the debt the fold owed", async () => {
    // RDLAT2 §10 declined this merge because folding costs per-step failure
    // attribution. If that were true this would read "could not be driven".
    const sentence =
      "the Repeat dialog does not hold what this drive entered — 1 control(s) differ: " +
      'interval (intended "3", dialog shows "1")';
    const { run } = rawRunner([
      envelope({ ops: [record("frequency = weekly", "select-popup")] }),
      envelope({
        ops: [record("measure the shape", "probe-shape", { shape: "next-popup" })],
        shape: "next-popup",
      }),
      JSON.stringify({
        ok: false,
        detail: sentence,
        failedAt: "audit the Repeat dialog",
        ops: [
          record("Add deadlines", "ensure-checkbox"),
          record("audit the Repeat dialog", "audit", { verdict: "refused", detail: sentence }),
        ],
        axCalls: 30,
        axElems: 9,
      }),
    ]);
    const vector = createUiVector(config(), run);
    const res = await vector.execute(invocation(fieldRecipe()));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('interval (intended "3", dialog shows "1")');
    // The op that failed is NAMED as the stopping point…
    expect(res.stderr).toContain("audit the Repeat dialog");
    // …and the ops that DID run are still in the trail.
    expect(res.steps?.join(" | ")).toContain("Add deadlines");
  });

  it("falls back to the certified AppleScript transport when the switch is off", async () => {
    vi.stubEnv("THINGS_API_REPEAT_RAWAX", "0");
    const { run, raw, commands } = rawRunner([]);
    const vector = createUiVector(config(), run);
    await vector.execute(invocation(fieldRecipe()));
    expect(raw).toHaveLength(0);
    // The per-step AppleScript dispatch is back, byte-identically.
    expect(commands.some((c) => c.primitive === "select-popup")).toBe(true);
    const popup = commands.find((c) => c.primitive === "select-popup");
    expect(popup?.lang ?? "applescript").toBe("applescript");
    expect(popup?.script).toContain('tell application "System Events"');
  });

  it("refuses a hop that answers with something other than an envelope", async () => {
    // A script that died produces stderr and no structure; the driver must not
    // invent a verdict from it.
    const { run } = rawRunner([]);
    const wrapped = async (c: UiCommand, t: number): Promise<UiRunResult> => {
      if (c.meta?.["rawax"] === true) {
        return { ok: false, stdout: "", stderr: "execution error: something broke (-1728)" };
      }
      return run(c, t);
    };
    const vector = createUiVector(config(), wrapped);
    const res = await vector.execute(invocation(fieldRecipe()));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("something broke");
  });
});
