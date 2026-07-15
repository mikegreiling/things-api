/**
 * ui vector (Accessibility GUI) tests. The osascript seam is MOCKED — no
 * System Events call ever fires (CLAUDE.md safety rails; the driver is also
 * unprobeable on this host). Covers: the driver's fail-closed behaviour
 * (canary refusal, wait-timeout abort + partial-state report, command shapes)
 * and the pipeline gating (H-UI-DRIVE without the ack, unsupported without the
 * config, certification-status warnings on success).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { ThingsApiConfig } from "../../src/config.ts";
import type { FingerprintStatus } from "../../src/db/fingerprint.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import { pauseRepeatRecipe } from "../../src/write/vectors/ui-recipes.ts";
import { createUiVector, type UiCommand, type UiRunResult } from "../../src/write/vectors/ui.ts";
import type { CompiledInvocation, UiRecipe, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let auditRecords: AuditRecord[];
let lockSeq = 0;

beforeEach(() => {
  fixture = buildFixtureDb();
  auditRecords = [];
});
afterEach(() => fixture.close());

function config(uiEnabled: boolean): ThingsApiConfig {
  return {
    profile: "workstation",
    maxDisruption: 1,
    actor: "test-actor",
    auditEnabled: true,
    acceptedFingerprint: null,
    allowExperimental: false,
    ui: { enabled: uiEnabled },
    host: "test-host",
  };
}

function okFingerprint(): FingerprintStatus {
  return {
    kind: "ok",
    observation: { databaseVersion: 26, tables: [], fingerprint: "sha256:test" },
  };
}

function deps(vector: WriteVector, cfg: ThingsApiConfig): WriteDeps {
  return {
    db: fixture.db,
    vectors: [vector],
    config: cfg,
    audit: { append: (r) => auditRecords.push(r) },
    fingerprint: okFingerprint,
    lockPath: join(tmpdir(), `things-api-ui-lock-${process.pid}-${lockSeq++}`),
    isAppRunning: () => true,
    ensureRunning: async () => true,
    now: () => NOW,
  };
}

/** A ui invocation wrapper for driving the vector's execute() directly. */
function invocation(recipe: UiRecipe): CompiledInvocation {
  return { vector: "ui", kind: "ui-drive", payload: "test", redactedPayload: "test", recipe };
}

/** A mock runner recording every command; `answer` decides each result. */
function mockRunner(answer: (c: UiCommand) => UiRunResult): {
  run: (c: UiCommand, t: number) => Promise<UiRunResult>;
  commands: UiCommand[];
} {
  const commands: UiCommand[] = [];
  return {
    commands,
    run: async (c) => {
      commands.push(c);
      return answer(c);
    },
  };
}

const ok = (stdout = ""): UiRunResult => ({ ok: true, stdout, stderr: "" });

describe("ui driver — fail-closed", () => {
  it("runs the reveal/activate preamble, then refuses in the canary before pressing anything", async () => {
    // The preamble selects + foregrounds the target so the context-dependent
    // Items ▸ Repeat submenu populates; the canary then fails on the first
    // resolve → refusal, and NO element is actuated (nothing pressed).
    const { run, commands } = mockRunner((c) => (c.primitive === "resolve" ? ok("false") : ok()));
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(pauseRepeatRecipe("TODO-1")));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("preflight refused");
    // The benign preamble ran (reveal to select), but nothing was actuated.
    expect(commands.some((c) => c.primitive === "reveal")).toBe(true);
    expect(
      commands.some(
        (c) =>
          c.primitive === "press" || c.primitive === "set-value" || c.primitive === "select-popup",
      ),
    ).toBe(false);
  });

  it("emits one stable osascript shape per primitive", async () => {
    const { run, commands } = mockRunner((c) => (c.primitive === "resolve" ? ok("true") : ok()));
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(pauseRepeatRecipe("TODO-1")));
    expect(res.exitCode).toBe(0);
    const reveal = commands.find((c) => c.primitive === "reveal");
    expect(reveal?.url).toBe("things:///show?id=TODO-1");
    const press = commands.find((c) => c.primitive === "press");
    expect(press?.script).toContain('tell application "System Events" to tell process "Things3"');
    expect(press?.script).toContain("click");
    expect(press?.script).toContain('menu item "Pause"');
  });

  it("aborts (Escape) and reports partial state when a dynamic element never appears", async () => {
    // A recipe with a short-timeout wait that never resolves → abort + partial.
    const recipe: UiRecipe = {
      op: "todo.make-repeating",
      targetUuid: "TODO-1",
      steps: [
        {
          primitive: "press",
          label: "open the dialog",
          path: `menu item "Repeat…" of menu "Items" of menu bar 1`,
          addressing: "title",
        },
        {
          primitive: "wait",
          label: "the Repeat dialog",
          path: `sheet 1 of window 1`,
          timeoutMs: 1,
          dynamic: true,
        },
      ],
    };
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve") return ok("true"); // canary passes
      if (c.primitive === "wait") return ok("false"); // dialog never appears
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(recipe));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("stopped at");
    expect(res.stderr).toContain("dismissed (Escape)");
    // The Escape abort keystroke was sent (key code 53).
    expect(commands.some((c) => c.primitive === "key" && c.script?.includes("key code 53"))).toBe(
      true,
    );
  });
});

/** A ui vector whose execute() applies a DB effect, for pipeline gating tests. */
function applyingUiVector(effect: () => void, enabled = true): WriteVector {
  const base = createUiVector(config(enabled), async () => ({
    ok: true,
    stdout: "true",
    stderr: "",
  }));
  return {
    id: "ui",
    matrix: base.matrix,
    async execute(inv) {
      if (!enabled) return base.execute(inv);
      effect();
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("ui vector — two-key gating", () => {
  it("blocks with H-UI-DRIVE when the drive acknowledgement is absent", async () => {
    const uuid = seedTodo(fixture.db, { title: "R", recurrenceRule: true });
    const vector = applyingUiVector(() => {
      /* never runs */
    });
    const res = await runMutation(deps(vector, config(true)), "todo.pause-repeat", { uuid });
    expect(res.kind).toBe("blocked");
    if (res.kind === "blocked") {
      expect(res.hazard).toBe("H-UI-DRIVE");
      expect(res.remediation).toContain("--dangerously-drive-gui");
    }
  });

  it("reports unsupported when the ui config is disabled (remediation names the config key)", async () => {
    const uuid = seedTodo(fixture.db, { title: "R", recurrenceRule: true });
    const vector = applyingUiVector(() => {}, false);
    const res = await runMutation(
      deps(vector, config(false)),
      "todo.pause-repeat",
      { uuid },
      { dangerouslyDriveGui: true },
    );
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") {
      const why = res.considered.map((c) => c.why).join(" ");
      expect(why).toContain("ui-enabled");
    }
  });

  it("succeeds with config + ack, and warns the op is GUI-driven + not on-device certified", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "R",
      recurrenceRule: true,
      instanceCreationPaused: false,
    });
    const vector = applyingUiVector(() => {
      fixture.db
        .prepare(
          "UPDATE TMTask SET rt1_instanceCreationPaused = 1, userModificationDate = ? WHERE uuid = ?",
        )
        .run(Math.floor(NOW.getTime() / 1000) + 1, uuid);
    });
    const res = await runMutation(
      deps(vector, config(true)),
      "todo.pause-repeat",
      { uuid },
      { dangerouslyDriveGui: true },
    );
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.vector).toBe("ui");
      expect((res.warnings ?? []).join(" ")).toContain("Accessibility");
      // pause-repeat is lab-certified (UIC1) — still not confirmed on device, so
      // the drive carries a status warning naming that tier.
      expect((res.warnings ?? []).join(" ")).toContain("lab-certified");
    }
  });
});

// A minimal mouse-hybrid recipe: reveal → activate → click a repeat bar
// (asserting a popover) → click a popover item. Mirrors the shape of the project
// repeat recipes without depending on their exact provisional element paths.
function clickRecipe(assertTimeoutMs = 5000): UiRecipe {
  return {
    op: "project.pause-repeat",
    targetUuid: "PROJ-1",
    steps: [
      { primitive: "reveal", label: "reveal", value: "PROJ-1" },
      { primitive: "activate", label: "activate" },
      {
        primitive: "click-element",
        label: "open the repeat menu",
        path: `text area 2 of group 1`,
        assertPath: `pop over 1`,
        assertLabel: "the repeat menu",
        assertTimeoutMs,
        addressing: "title",
      },
      {
        primitive: "click-element",
        label: "repeat menu ▸ Pause",
        path: `(first UI element of pop over 1 whose description is "Pause")`,
        dynamic: true,
        addressing: "title",
      },
    ],
  };
}

// resolve = canary (static repeat bar), resolve-frame = the click target's
// frame, click-point = the HID click, wait = the post-click assertion.
function answerHappy(c: UiCommand): UiRunResult {
  if (c.primitive === "resolve") return ok("true");
  if (c.primitive === "resolve-frame") return ok("100 200 40 20");
  if (c.primitive === "wait") return ok("true");
  return ok();
}

describe("ui driver — mouse-hybrid click-element (NATIVE1 primitive)", () => {
  it("resolves the frame from AX, clicks its center via a JXA/HID command, and asserts the outcome", async () => {
    const { run, commands } = mockRunner(answerHappy);
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(clickRecipe()));
    expect(res.exitCode).toBe(0);
    // The static repeat bar was canaried (a resolve), never AXPress'd.
    expect(commands.some((c) => c.primitive === "resolve")).toBe(true);
    expect(commands.some((c) => c.primitive === "press")).toBe(false);
    // The click is a JavaScript (JXA) command posting a CGEvent at the AX-resolved
    // CENTER (100+40/2, 200+20/2) = (120, 210) — a computed frame center, never a pixel.
    const click = commands.find((c) => c.primitive === "click-point");
    expect(click?.lang).toBe("javascript");
    expect(click?.script).toContain("CGEventPost");
    expect(click?.script).toContain("$.kCGHIDEventTap");
    expect(click?.script).toContain("120");
    expect(click?.script).toContain("210");
  });

  it("fails closed BEFORE clicking when the element frame does not resolve", async () => {
    // Canary passes (the bar exists) but the frame read errors → no click is sent.
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "resolve-frame") return { ok: false, stdout: "", stderr: "boom" };
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(clickRecipe()));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("did not resolve");
    // The decisive guarantee: no click was ever posted at a guessed point.
    expect(commands.some((c) => c.primitive === "click-point")).toBe(false);
  });

  it("dismisses (Escape) and reports partial state when the declared post-click element never appears", async () => {
    // Frame resolves + click posts, but the asserted popover never shows → abort.
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "resolve-frame") return ok("100 200 40 20");
      if (c.primitive === "wait") return ok("false"); // assertion never satisfied
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(clickRecipe(10)));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("did not appear");
    // A click DID post (the first one), then Escape was sent to dismiss whatever opened.
    expect(commands.some((c) => c.primitive === "click-point")).toBe(true);
    const abort = commands.filter((c) => c.primitive === "key");
    expect(abort.some((c) => c.script?.includes("key code 53"))).toBe(true);
  });

  it("canaries a static mouse target and refuses before any click when it is missing", async () => {
    // The repeat bar (static) fails to resolve in the canary → refuse, no frame
    // read, no click — mouse targets are canaried exactly like AX press targets.
    const { run, commands } = mockRunner((c) => (c.primitive === "resolve" ? ok("false") : ok()));
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(clickRecipe()));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("preflight refused");
    expect(commands.some((c) => c.primitive === "resolve-frame")).toBe(false);
    expect(commands.some((c) => c.primitive === "click-point")).toBe(false);
  });
});
