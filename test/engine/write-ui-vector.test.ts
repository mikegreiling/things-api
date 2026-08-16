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
import { makeRepeatingRecipe, pauseRepeatRecipe } from "../../src/write/vectors/ui-recipes.ts";
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
    certifiedAppVersion: null,
    allowExperimental: false,
    bounceEnabled: true,
    bounceMaxItems: 30,
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
      // The sheet-open probe (a resolve carrying the sheetOpen script) reports the
      // sheet GONE after the abort — so the report may claim a confirmed dismissal.
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("true"); // canary passes
      if (c.primitive === "wait") return ok("false"); // dialog never appears
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(recipe));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("stopped at");
    // (d) The dismissal was VERIFIED gone before it was claimed.
    expect(res.stderr).toContain("dismissed (Escape, confirmed gone)");
    // The Escape abort keystroke was sent (key code 53).
    expect(commands.some((c) => c.primitive === "key" && c.script?.includes("key code 53"))).toBe(
      true,
    );
  });

  it("(d) warns the sheet MAY REMAIN OPEN when Escape does not dismiss it (fail-closed honesty)", async () => {
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
          path: `sheet 1`,
          timeoutMs: 1,
          dynamic: true,
        },
      ],
    };
    // The sheet-open probe keeps reporting the sheet PRESENT after both Escapes.
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("true");
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "wait") return ok("false");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(recipe));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("may still be open");
    expect(res.stderr).not.toContain("confirmed gone");
    // Escape was retried ONCE (two key-code-53 sends).
    const escapes = commands.filter(
      (c) => c.primitive === "key" && c.script?.includes("key code 53"),
    );
    expect(escapes.length).toBe(2);
  });

  it("(e) blames a leftover OPEN SHEET first when the canary cannot resolve the menu path", async () => {
    // The canary miss is really a modal sheet from an earlier aborted drive
    // disabling the menu bar — diagnose THAT, not a Things-update/language guess.
    const { run } = mockRunner((c) => {
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("true");
      if (c.primitive === "resolve") return ok("false"); // canary element never resolves
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(pauseRepeatRecipe("TODO-1")));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("preflight refused");
    expect(res.stderr).toContain("modal sheet");
    expect(res.stderr).toContain("Dismiss the open sheet");
    // It must NOT fall back to the generic guesses when a sheet is detected.
    expect(res.stderr).not.toContain("may not be in English");
  });

  it("(e) falls back to the generic canary guesses when NO sheet is open", async () => {
    const { run } = mockRunner((c) => {
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("false");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(pauseRepeatRecipe("TODO-1")));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("preflight refused");
    expect(res.stderr).toContain("may not be in English");
    expect(res.stderr).not.toContain("modal sheet");
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

  it("drove cleanly (exit 0) but the app changed nothing → verify-failed:silent-noop", async () => {
    // The transport SUCCEEDS (the GUI drive completes with no error), yet the
    // app silently no-ops, so verification observes no movement. This is the
    // "drove-then-verify-failed" path from the field report — it must produce a
    // structured verify-failed result (which the CLI/MCP render as a single JSON
    // error envelope), never diverge from the transport-refused (exit != 0) path.
    const uuid = seedTodo(fixture.db, {
      title: "R",
      recurrenceRule: true,
      instanceCreationPaused: false,
    });
    const vector = applyingUiVector(() => {
      /* the drive "completes" but changes nothing observable in the DB */
    });
    const res = await runMutation(
      deps(vector, config(true)),
      "todo.pause-repeat",
      { uuid },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 200 },
    );
    expect(res.kind).toBe("verify-failed");
    if (res.kind === "verify-failed") expect(res.reason).toBe("silent-noop");
  });
});

// ---- defect (a): idempotency + transport-failure recovery -----------------

/** A weekly / interval-2 recurrence rule blob, fixed OR after-completion (tp). */
function ruleXml(type: "fixed" | "after-completion"): string {
  return (
    `<?xml version="1.0"?><plist version="1.0"><dict>` +
    `<key>tp</key><integer>${type === "fixed" ? 0 : 1}</integer>` +
    `<key>fu</key><integer>256</integer><key>fa</key><integer>2</integer>` +
    `<key>ts</key><integer>0</integer><key>rc</key><integer>0</integer>` +
    `<key>rrv</key><integer>4</integer>` +
    `<key>of</key><array><dict><key>wd</key><integer>1</integer></dict></array>` +
    `</dict></plist>`
  );
}

/** A ui vector with a custom execute() — records whether it ran + optional DB effect. */
function scriptedUiVector(execute: () => Promise<{ exitCode: number; effect?: () => void }>): {
  vector: WriteVector;
  ran: () => boolean;
} {
  let didRun = false;
  const base = createUiVector(config(true), async () => ok("true"));
  return {
    ran: () => didRun,
    vector: {
      id: "ui",
      matrix: base.matrix,
      async execute() {
        didRun = true;
        const r = await execute();
        r.effect?.();
        return { exitCode: r.exitCode, stdout: "", stderr: r.exitCode === 0 ? "" : "aborted" };
      },
    },
  };
}

describe("ui vector — idempotency + transport recovery (defect (a))", () => {
  it("pre-drive idempotency: the rule already equals the target → ok no-op, NO GUI drive", async () => {
    const uuid = seedTodo(fixture.db, {
      title: "R",
      recurrenceRuleXml: ruleXml("after-completion"),
    });
    const scripted = scriptedUiVector(async () => ({ exitCode: 0 }));
    const res = await runMutation(
      deps(scripted.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, frequency: "weekly", interval: 2, afterCompletion: true },
      { dangerouslyDriveGui: true },
    );
    expect(res.kind).toBe("ok");
    expect(scripted.ran()).toBe(false); // the app was never driven
    if (res.kind === "ok") {
      expect((res.warnings ?? []).join(" ")).toContain("already in the requested state");
      expect(res.undoToken).toBeUndefined(); // nothing changed → nothing to undo
    }
  });

  it("post-drive-failure recovery: transport aborts but the conversion landed → ok, DID-land warning", async () => {
    // The incident's exact shape: a fixed→after-completion reschedule whose drive
    // aborts on the pluralized unit pop-up, yet the rule was applied by inheritance
    // before the abort. Transport exit 1, but the after-completion rule is in the DB.
    const uuid = seedTodo(fixture.db, { title: "R", recurrenceRuleXml: ruleXml("fixed") });
    const scripted = scriptedUiVector(async () => ({
      exitCode: 1, // aborted mid-drive
      effect: () => {
        fixture.db
          .prepare(
            "UPDATE TMTask SET rt1_recurrenceRule = ?, userModificationDate = ? WHERE uuid = ?",
          )
          .run(
            new TextEncoder().encode(ruleXml("after-completion")),
            Math.floor(NOW.getTime() / 1000) + 1,
            uuid,
          );
      },
    }));
    const res = await runMutation(
      deps(scripted.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, frequency: "weekly", interval: 2, afterCompletion: true },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 500 },
    );
    expect(res.kind).toBe("ok"); // NOT a false failure
    if (res.kind === "ok") {
      expect((res.warnings ?? []).join(" ")).toContain("DID land");
    }
  });

  it("post-drive-failure with NO landed change → verify-failed silent-noop (honest failure)", async () => {
    const uuid = seedTodo(fixture.db, { title: "R", recurrenceRuleXml: ruleXml("fixed") });
    const scripted = scriptedUiVector(async () => ({ exitCode: 1 })); // aborts, changes nothing
    const res = await runMutation(
      deps(scripted.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, frequency: "weekly", interval: 2, afterCompletion: true },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 300 },
    );
    expect(res.kind).toBe("verify-failed");
    if (res.kind === "verify-failed") {
      expect(res.reason).toBe("silent-noop");
      expect(res.detail).toContain("no landed change");
    }
  });

  it("type-conversion is VERIFIABLE: fixed→after-completion asserts the rule type flipped", async () => {
    // Both rules are weekly/interval-2 — only the type changes. Without the type
    // assertion a botched drive that stayed fixed would falsely verify-pass.
    const uuid = seedTodo(fixture.db, { title: "R", recurrenceRuleXml: ruleXml("fixed") });
    const scripted = scriptedUiVector(async () => ({ exitCode: 0 })); // "succeeds" but changes nothing
    const res = await runMutation(
      deps(scripted.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, frequency: "weekly", interval: 2, afterCompletion: true },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 300 },
    );
    // The rule is still fixed → the type assertion catches the no-op.
    expect(res.kind).toBe("verify-failed");
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

// ADR1 (issue #480): the to-do make/add-repeating recipe asserts the reveal
// landed an eligible selection BEFORE pressing Items ▸ Repeat…, so a disabled-menu
// no-op (the row was not actually selected) fails EARLY + named instead of dying
// opaquely at the downstream dialog-wait timeout.
describe("ui driver — ADR1 selection/eligibility assertion (#480)", () => {
  it("aborts EARLY + named when the reveal did not land an eligible selection", async () => {
    const diagnostic =
      "NOTSEL no to-do is selected after the reveal (expected TODO-1) — the show URL navigated without selecting an eligible row";
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("true"); // canary passes
      if (c.primitive === "assert-eligible") return ok(diagnostic);
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(makeRepeatingRecipe("TODO-1", "weekly", 2)));
    expect(res.exitCode).toBe(1);
    // The diagnostic IS the human-readable failure reason (not an opaque timeout).
    expect(res.stderr).toContain("NOTSEL");
    expect(res.stderr).toContain("stopped at");
    // The eligibility check DID run…
    expect(commands.some((c) => c.primitive === "assert-eligible")).toBe(true);
    // …and NOTHING was actuated afterwards (no menu press, no dialog controls).
    expect(
      commands.some(
        (c) =>
          c.primitive === "press" || c.primitive === "set-value" || c.primitive === "select-popup",
      ),
    ).toBe(false);
  });

  it("carries the target uuid + Repeat… menu path into the assertion script", async () => {
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "assert-eligible") return ok("OK");
      if (c.primitive === "wait") return ok("true");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    await vector.execute(invocation(makeRepeatingRecipe("TODO-42", "weekly", 2)));
    const assertCmd = commands.find((c) => c.primitive === "assert-eligible");
    expect(assertCmd?.script).toContain("id of selected to dos");
    expect(assertCmd?.script).toContain("TODO-42");
    expect(assertCmd?.script).toContain('menu item "Repeat…"');
    expect(assertCmd?.script).toContain("enabled of");
  });

  it("proceeds to the menu press once the target is confirmed selected + enabled", async () => {
    const { run, commands } = mockRunner((c) => {
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "assert-eligible") return ok("OK");
      if (c.primitive === "wait") return ok("true");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(makeRepeatingRecipe("TODO-1", "weekly", 2)));
    expect(res.exitCode).toBe(0);
    // The assertion preceded the Items ▸ Repeat… press in the command stream.
    const assertIdx = commands.findIndex((c) => c.primitive === "assert-eligible");
    const pressIdx = commands.findIndex(
      (c) => c.primitive === "press" && c.script?.includes('menu item "Repeat…"') === true,
    );
    expect(assertIdx).toBeGreaterThanOrEqual(0);
    expect(pressIdx).toBeGreaterThan(assertIdx);
  });
});

const isReach = (c: UiCommand): boolean => c.script?.includes("sessgate-reachability") === true;
const isCloseReopen = (c: UiCommand): boolean => c.script?.includes("close window 1") === true;
const isActuation = (c: UiCommand): boolean =>
  c.primitive === "press" || c.primitive === "set-value" || c.primitive === "select-popup";

// SESSGATE (issue #480): dialog-class ops probe the live session AFTER the reveal
// and BEFORE any press. A locked/full-screen session (every process AX-0) refuses
// (blocked, zero mutation); a window merely on another Space (Things AX-0, others
// visible) is RELOCATED to the current Space and the drive proceeds (disclosed).
describe("ui driver — session-reachability gate (SESSGATE #480)", () => {
  it("REFUSES (blocked, exit 4) on the LOCKED signature — every process AX-0 — with zero mutation", async () => {
    // reachability probe reports Things AS=1 but AX=0 AND all-processes AX=0.
    const { run, commands } = mockRunner((c) => {
      if (isReach(c)) return ok("1 0 0");
      if (c.primitive === "resolve") return ok("true");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(makeRepeatingRecipe("TODO-1", "weekly", 2)));
    expect(res.exitCode).toBe(4);
    expect(res.blocked?.hazard).toBe("H-UI-SESSION-UNREACHABLE");
    expect(res.blocked?.remediation.toLowerCase()).toContain("unlock");
    // Zero mutation: nothing actuated, and NO relocation was attempted (locked ≠ off-Space).
    expect(commands.some(isActuation)).toBe(false);
    expect(commands.some(isCloseReopen)).toBe(false);
  });

  it("RELOCATES on the WRONG-SPACE signature (Things AX-0, others visible), then proceeds + discloses", async () => {
    let reachCalls = 0;
    const { run, commands } = mockRunner((c) => {
      if (isReach(c)) {
        reachCalls += 1;
        // First probe: off-Space (others visible). After close+reopen: reachable.
        return ok(reachCalls === 1 ? "1 0 4" : "1 1 4");
      }
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "assert-eligible") return ok("OK");
      if (c.primitive === "wait") return ok("true");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(makeRepeatingRecipe("TODO-1", "weekly", 2)));
    expect(res.exitCode).toBe(0);
    // The relocation maneuver ran (close window + reopen) and was disclosed.
    expect(commands.some(isCloseReopen)).toBe(true);
    expect(res.stdout).toContain("moved to the desktop");
    expect(reachCalls).toBe(2); // probe → relocate → re-probe (closed-loop)
  });

  it("BLOCKS with the Space remediation when relocation does NOT restore reachability", async () => {
    const { run, commands } = mockRunner((c) => {
      if (isReach(c)) return ok("1 0 4"); // off-Space before AND after the relocation
      if (c.primitive === "resolve") return ok("true");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(makeRepeatingRecipe("TODO-1", "weekly", 2)));
    expect(res.exitCode).toBe(4);
    expect(res.blocked?.hazard).toBe("H-UI-SESSION-UNREACHABLE");
    expect(res.blocked?.detail.toLowerCase()).toContain("another desktop");
    // The relocation WAS attempted before giving up, but nothing was actuated.
    expect(commands.some(isCloseReopen)).toBe(true);
    expect(commands.some(isActuation)).toBe(false);
  });

  it("does NOT gate a menu-only op (pause-repeat) — no reachability probe, no block under lock", async () => {
    // Even if the session WOULD read locked, a pure menu-item press works under
    // lock (AXVM1), so pause-repeat is never gated: the probe is never issued.
    const { run, commands } = mockRunner((c) => {
      if (isReach(c)) return ok("1 0 0"); // would be "locked" — but must never be consulted
      if (c.primitive === "resolve") return ok("true");
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(pauseRepeatRecipe("TODO-1")));
    expect(res.exitCode).toBe(0);
    expect(commands.some(isReach)).toBe(false);
  });

  it("mid-flight lock: an AX-blind dialog-wait timeout clears the sheet by close+reopen, HONESTLY", async () => {
    // The gate passes (reachable), then the session goes AX-blind and the dialog
    // wait times out. Cleanup must NOT claim "confirmed gone" (it is blind) — it
    // runs the proven app-level close+reopen and says so. A bespoke dialog-class
    // recipe with a 1ms wait keeps the timeout fast.
    const recipe: UiRecipe = {
      op: "todo.make-repeating",
      targetUuid: "TODO-1",
      needsWindowReachability: true,
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
          path: `sheet 1`,
          timeoutMs: 1,
          dynamic: true,
        },
      ],
    };
    let reachCalls = 0;
    const { run, commands } = mockRunner((c) => {
      if (isReach(c)) {
        reachCalls += 1;
        return ok(reachCalls === 1 ? "1 1 3" : "1 0 0"); // reachable at the gate, locked at cleanup
      }
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "wait") return ok("false"); // the dialog never appears (window went AX-blind)
      return ok();
    });
    const vector = createUiVector(config(true), run);
    const res = await vector.execute(invocation(recipe));
    expect(res.exitCode).toBe(1); // partial-state refusal
    expect(res.stderr).toContain("closed and reopened");
    expect(res.stderr).not.toContain("confirmed gone");
    // The proven maneuver ran to clear the (unseen) stuck sheet.
    expect(commands.some(isCloseReopen)).toBe(true);
  });
});
