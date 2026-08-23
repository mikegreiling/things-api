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
import { encodePackedDate } from "../../src/model/dates.ts";
import { runMutation, type WriteDeps } from "../../src/write/pipeline.ts";
import type { RepeatRuleParams } from "../../src/write/operations.ts";
import { COMMANDS } from "../../src/write/commands.ts";
import { anchorKeyOfOffsets, decodeOffsetEntry } from "../../src/model/recurrence.ts";
import {
  composeRepeatRuleSpec,
  ruleXml as composeRuleXml,
} from "../../src/write/recurrence-rule-blob.ts";
import {
  makeRepeatingRecipe,
  pauseRepeatRecipe,
  rescheduleRepeatRecipe,
} from "../../src/write/vectors/ui-recipes.ts";
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
    autoLaunch: true,
    helpersMode: "false",
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

type Bag = Omit<RepeatRuleParams, "uuid">;

/** The DB state a reschedule-to-`bag` lands: rule blob + deadline column + cursor. */
function bagState(bag: Bag): { xml: string; deadline: string | null; cursor: string | null } {
  const deadlined = bag.deadline === true || (bag.startDaysEarlier ?? 0) > 0;
  const spec = composeRepeatRuleSpec({ uuid: "x", ...bag }, bag.next ?? "2026-09-22", 0);
  return {
    xml: composeRuleXml(spec),
    deadline: deadlined ? "4001-01-01" : null,
    cursor: bag.next ?? null,
  };
}

/** Apply a reschedule-`bag`'s landed state (rule blob + deadline column + cursor) to a row. */
function applyBag(uuid: string, bag: Bag): void {
  const s = bagState(bag);
  fixture.db
    .prepare(
      "UPDATE TMTask SET rt1_recurrenceRule = ?, deadline = ?, rt1_nextInstanceStartDate = ?, " +
        "userModificationDate = ? WHERE uuid = ?",
    )
    .run(
      new TextEncoder().encode(s.xml),
      s.deadline === null ? null : encodePackedDate(s.deadline),
      s.cursor === null ? null : encodePackedDate(s.cursor),
      Math.floor(NOW.getTime() / 1000) + 1,
      uuid,
    );
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

  // ---- #491: full-fidelity precheck (anchor/deadline/offset/cursor) ----------
  //
  // The pre-drive idempotency check evaluates the SAME assert set expectedDelta
  // produces. When those asserts were unit+interval only, a reschedule that
  // changed the monthly anchor / deadline offset / cursor read back "already
  // satisfied" and was skipped with a false no-op. These two cells prove the
  // full-fidelity asserts fix that: the anchor/offset/cursor change DRIVES, and a
  // genuine same-command re-run still no-ops.

  function seedBagTemplate(title: string, bag: Bag): string {
    const s = bagState(bag);
    return seedTodo(fixture.db, {
      title,
      start: "someday",
      recurrenceRuleXml: s.xml,
      deadline: s.deadline,
      nextInstanceStartDate: s.cursor,
    });
  }

  function applyBagToRow(uuid: string, bag: Bag): void {
    const s = bagState(bag);
    fixture.db
      .prepare(
        "UPDATE TMTask SET rt1_recurrenceRule = ?, deadline = ?, rt1_nextInstanceStartDate = ?, " +
          "userModificationDate = ? WHERE uuid = ?",
      )
      .run(
        new TextEncoder().encode(s.xml),
        s.deadline === null ? null : encodePackedDate(s.deadline),
        s.cursor === null ? null : encodePackedDate(s.cursor),
        Math.floor(NOW.getTime() / 1000) + 1,
        uuid,
      );
  }

  // The maintainer's live-repro shape, synthetic: a monthly last-day deadlined
  // ts=-14 template, rescheduled to a monthly nth-Tuesday ts=-21 with an explicit
  // --when. Pre-#491 the precheck false-noop'd (unit+interval unchanged). The
  // anchor is the DEADLINE date's placement (--when 2026-09-22 + 21 ⇒ 2026-10-13,
  // the 2nd Tuesday) so the request is DACON1-consistent (a deadlined rule anchors
  // on its deadline).
  const PREV: Bag = {
    frequency: "monthly",
    interval: 1,
    monthly: { day: "last" },
    deadline: true,
    startDaysEarlier: 14,
    next: "2026-08-31",
  };
  const NEW: Bag = {
    frequency: "monthly",
    interval: 1,
    monthly: { weekday: "tuesday", ordinal: 2 },
    deadline: true,
    startDaysEarlier: 21,
    next: "2026-09-22",
  };

  it("#491: a monthly anchor/offset/cursor-only reschedule DRIVES (not a false no-op)", async () => {
    const uuid = seedBagTemplate("Monthly review", PREV);
    // The drive "lands" NEW's full state so the post-verify passes.
    const scripted = scriptedUiVector(async () => ({
      exitCode: 0,
      effect: () => applyBagToRow(uuid, NEW),
    }));
    const res = await runMutation(
      deps(scripted.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, ...NEW },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 500 },
    );
    expect(res.kind).toBe("ok");
    expect(scripted.ran()).toBe(true); // the precheck did NOT short-circuit — #491 closed
    // The landed anchor + offset + cursor are what was requested.
    const row = fixture.db
      .prepare("SELECT rt1_nextInstanceStartDate AS cur, deadline AS dl FROM TMTask WHERE uuid = ?")
      .get(uuid) as { cur: number; dl: number | null };
    expect(row.cur).toBe(encodePackedDate("2026-09-22"));
    expect(row.dl).not.toBeNull();
  });

  it("#491: a genuine same-command re-run is still an idempotent no-op (zero drive)", async () => {
    const uuid = seedBagTemplate("Monthly review", NEW);
    const scripted = scriptedUiVector(async () => ({ exitCode: 0 }));
    const res = await runMutation(
      deps(scripted.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, ...NEW },
      { dangerouslyDriveGui: true },
    );
    expect(res.kind).toBe("ok");
    expect(scripted.ran()).toBe(false); // every requested field already holds → no drive
    if (res.kind === "ok") {
      expect((res.warnings ?? []).join(" ")).toContain("already in the requested state");
      expect(res.undoToken).toBeUndefined();
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

// ---- RRD1: reschedule on a deadlined rule + preserve-unspecified ------------
//
// These drive the REAL compile path (commands.ts reschedRuleExtras →
// rescheduleRepeatRecipe → repeatDialogEntry) through runMutation and inspect the
// COMPILED RECIPE a capturing vector records. That is where the checkbox-converge
// fix lives: an already-deadlined reschedule must converge the box (never blind-
// press it), and an unspecified deadline/reminder must emit NO checkbox step so
// the pre-populated state is preserved (#492).

/** A ui vector that RECORDS the compiled recipe it is handed and applies a DB effect. */
function capturingUiVector(effect?: () => void): {
  vector: WriteVector;
  recipe: () => UiRecipe | undefined;
} {
  let captured: UiRecipe | undefined;
  const base = createUiVector(config(true), async () => ok("true"));
  return {
    recipe: () => captured,
    vector: {
      id: "ui",
      matrix: base.matrix,
      async execute(inv: CompiledInvocation) {
        captured = inv.recipe;
        effect?.();
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

/** The dialog-entry steps of a compiled reschedule recipe (checkbox/field controls). */
function rescheduleDialogSteps(recipe: UiRecipe | undefined) {
  return (recipe?.steps ?? []).filter(
    (s) => s.pathCandidates !== undefined || s.primitive === "set-datetime",
  );
}

describe("ui vector — RRD1 checkbox convergence (reschedule on a pre-populated dialog)", () => {
  // A currently-DEADLINED monthly template (last-day, ts=-14), rescheduled to a
  // different anchor + offset while KEEPING the deadline — the maintainer's live
  // repro shape. The drive must run (anchor/offset differ) and the compiled recipe
  // must converge "Add deadlines" (target checked) BEFORE it drives "Next:".
  const DEADLINED_PREV: Bag = {
    frequency: "monthly",
    interval: 1,
    monthly: { day: "last" },
    deadline: true,
    startDaysEarlier: 14,
    next: "2026-08-31",
  };

  function seedRow(bag: Bag): string {
    const s = bagState(bag);
    return seedTodo(fixture.db, {
      title: "Monthly review",
      start: "someday",
      recurrenceRuleXml: s.xml,
      deadline: s.deadline,
      nextInstanceStartDate: s.cursor,
    });
  }

  it("reschedule-on-deadlined converges the deadline box (not a blind press) and orders it before Next", async () => {
    const uuid = seedRow(DEADLINED_PREV);
    // Anchor = the deadline date's placement (--when + start-21 ⇒ 2026-10-13, the
    // 2nd Tuesday) — DACON1-consistent (a deadlined rule anchors on its deadline).
    const NEW: Bag = {
      frequency: "monthly",
      interval: 1,
      monthly: { weekday: "tuesday", ordinal: 2 },
      deadline: true,
      startDaysEarlier: 21,
      next: "2026-09-22",
    };
    const cap = capturingUiVector(() => applyBag(uuid, NEW));
    const res = await runMutation(
      deps(cap.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, ...NEW },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 500 },
    );
    expect(res.kind).toBe("ok");
    const steps = rescheduleDialogSteps(cap.recipe());
    const deadline = steps.find((s) => s.label === "Add deadlines");
    expect(deadline?.primitive).toBe("ensure-checkbox");
    expect(deadline?.checkboxTarget).toBe(true);
    // No blind checkbox press survives the compile.
    expect(
      steps.some((s) => s.primitive === "press" && /Add (deadlines|reminders)/.test(s.label)),
    ).toBe(false);
    // Deadline mode is established before the deadline-shifted "Next:" is driven.
    const deadlineIdx = steps.findIndex((s) => s.label === "Add deadlines");
    const nextIdx = steps.findIndex((s) => s.dtTarget === "next");
    expect(nextIdx).toBeGreaterThan(deadlineIdx);
    // YANCH1 shift: --when 2026-09-22 + start-21 ⇒ the deadline (Next) is driven to 2026-10-13.
    expect(steps.find((s) => s.dtTarget === "next")?.value).toBe("date:2026-10-13");
  });

  it("reschedule preserving an UNSPECIFIED deadline emits NO deadline checkbox step", async () => {
    // A rule-only reschedule (anchor change) of a deadlined template with NO
    // --deadline: the box must be left untouched so the app preserves it (#492).
    const uuid = seedRow(DEADLINED_PREV);
    const NEW_NO_DEADLINE: Bag = {
      frequency: "monthly",
      interval: 1,
      monthly: { weekday: "tuesday", ordinal: 4 },
    };
    // The drive "lands" the new anchor while the app keeps the deadline untouched.
    const cap = capturingUiVector(() =>
      applyBag(uuid, { ...NEW_NO_DEADLINE, deadline: true, startDaysEarlier: 14 }),
    );
    const res = await runMutation(
      deps(cap.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, ...NEW_NO_DEADLINE },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 500 },
    );
    expect(res.kind).toBe("ok");
    const steps = rescheduleDialogSteps(cap.recipe());
    expect(steps.some((s) => s.label === "Add deadlines")).toBe(false);
    expect(steps.some((s) => s.label === "Add reminders")).toBe(false);
  });

  it("reschedule preserving an UNSPECIFIED reminder emits NO reminder checkbox step", async () => {
    const uuid = seedRow(DEADLINED_PREV);
    const NEW: Bag = { frequency: "monthly", interval: 2, monthly: { day: "last" } };
    const cap = capturingUiVector(() =>
      applyBag(uuid, { ...NEW, deadline: true, startDaysEarlier: 14 }),
    );
    const res = await runMutation(
      deps(cap.vector, config(true)),
      "todo.reschedule-repeat",
      { uuid, ...NEW },
      { dangerouslyDriveGui: true, verifyTimeoutMs: 500 },
    );
    expect(res.kind).toBe("ok");
    const steps = rescheduleDialogSteps(cap.recipe());
    expect(steps.some((s) => s.label === "Add reminders")).toBe(false);
  });
});

// ---- RSPA1: reschedule derives + DRIVES the anchor for a --when-only rule -----
//
// The live failure: a yearly deadlined `reschedule-repeat --when <date>` with NO
// explicit anchor flag drove Next (deadline-shifted) but NEVER the yearly month/day
// anchor pop-ups — so the reschedule kept the dialog's untouched anchor while the
// verify (which now derives the anchor from --when) expected the derived placement.
// The fix wires deriveFixedAnchor into the reschedule compile (via reschedEffParams)
// so the SAME derived anchor make/add-repeating drive is driven here, and the
// coherence lock below proves the DRIVE vocabulary == the ASSERT vocabulary.

/** The anchorKey the verify asserts for an op's rule params (or undefined if none). */
function assertedAnchorKey(
  op: "todo.reschedule-repeat",
  params: RepeatRuleParams,
): string | undefined {
  const pre = COMMANDS[op].preRead(fixture.db, params, NOW);
  const delta = COMMANDS[op].expectedDelta(pre, params, {
    nowEpoch: Math.floor(NOW.getTime() / 1000),
    todayIso: "2026-07-05",
  });
  if (delta.mode !== "update") throw new Error("expected an update delta");
  const anchor = delta.assert.find((a) => a.field === "repeating.rule.anchorKey");
  return anchor !== undefined && "equals" in anchor ? (anchor.equals as string) : undefined;
}

/** The anchorKey a landed {frequency, anchor} rule carries (independent of the CLI derive). */
function anchorKeyOf(bag: Bag): string {
  const spec = composeRepeatRuleSpec({ uuid: "x", ...bag }, bag.next ?? "2000-01-01", 0);
  return anchorKeyOfOffsets(
    (spec.of ?? []).map((o) => decodeOffsetEntry(o as Record<string, unknown>)),
  );
}

describe("ui vector — RSPA1 reschedule derives + drives the calendar anchor (--when only)", () => {
  // A yearly template ALREADY carrying a (stale) anchor + a pending cursor — the
  // live shape. Reschedule with --when only (no --yearly-month/--on-day) + deadline.
  const YEARLY_PREV: Bag = {
    frequency: "yearly",
    interval: 1,
    yearly: { month: 10, day: 2 },
    deadline: true,
    startDaysEarlier: 14,
    next: "2028-10-02",
  };

  function seedYearly(): string {
    const s = bagState(YEARLY_PREV);
    return seedTodo(fixture.db, {
      title: "Annual review",
      start: "someday",
      recurrenceRuleXml: s.xml,
      deadline: s.deadline,
      nextInstanceStartDate: s.cursor,
    });
  }

  it("drives the DERIVED yearly month+day anchor and the verify asserts the SAME anchor", async () => {
    const uuid = seedYearly();
    // --when 2028-10-16 + start-14 ⇒ the DUE anchor is 2028-10-30 (Oct 30) — the
    // dialog's yearly month/day pop-ups must be driven there, not left at the stale
    // Oct-2 / January-1 default.
    const NEW: RepeatRuleParams = {
      uuid,
      frequency: "yearly",
      interval: 1,
      deadline: true,
      startDaysEarlier: 14,
      next: "2028-10-16",
    };
    const cap = capturingUiVector();
    const res = await runMutation(deps(cap.vector, config(true)), "todo.reschedule-repeat", NEW, {
      dangerouslyDriveGui: true,
      verifyTimeoutMs: 1,
    });
    // (verify may not converge on the untouched fixture — we inspect the COMPILE, not the DB.)
    expect(["ok", "verify-failed"]).toContain(res.kind);
    const steps = (cap.recipe()?.steps ?? []) as { label?: string }[];
    // DRIVE side: the yearly anchor pop-ups are driven to the DUE date Oct 30.
    expect(steps.some((s) => s.label === "yearly month = 10")).toBe(true);
    expect(steps.some((s) => s.label === "monthly mode = day")).toBe(true);
    expect(steps.some((s) => s.label === "monthly day = 30")).toBe(true);
    // The deadline-shifted Next is driven to the same DUE date.
    expect(
      (cap.recipe()?.steps ?? []).some(
        (s) => s.dtTarget === "next" && s.value === "date:2028-10-30",
      ),
    ).toBe(true);

    // ASSERT side: the verify expects an anchorKey — and it is the SAME anchor the
    // drive lands (Oct 30), computed independently from a {yearly Oct-30} rule blob.
    const asserted = assertedAnchorKey("todo.reschedule-repeat", NEW);
    const driven = anchorKeyOf({
      frequency: "yearly",
      interval: 1,
      yearly: { month: 10, day: 30 },
    });
    expect(asserted).toBe(driven);
  });

  it("an explicit --yearly-month anchor still wins over the --when derivation", async () => {
    const uuid = seedYearly();
    // Explicit Nov-5 anchor + --when 2028-10-16 (off-rule first, honored for yearly).
    const NEW: RepeatRuleParams = {
      uuid,
      frequency: "yearly",
      interval: 1,
      yearly: { month: 11, day: 5 },
      next: "2028-10-16",
    };
    const cap = capturingUiVector();
    await runMutation(deps(cap.vector, config(true)), "todo.reschedule-repeat", NEW, {
      dangerouslyDriveGui: true,
      verifyTimeoutMs: 1,
    });
    const steps = (cap.recipe()?.steps ?? []) as { label?: string }[];
    expect(steps.some((s) => s.label === "yearly month = 11")).toBe(true);
    expect(steps.some((s) => s.label === "yearly month = 10")).toBe(false);
    const asserted = assertedAnchorKey("todo.reschedule-repeat", NEW);
    expect(asserted).toBe(
      anchorKeyOf({ frequency: "yearly", interval: 1, yearly: { month: 11, day: 5 } }),
    );
  });

  it("a rule-only reschedule (no --when) drives NO anchor pop-up and asserts NO anchorKey", async () => {
    const uuid = seedYearly();
    const NEW: RepeatRuleParams = { uuid, frequency: "yearly", interval: 2 };
    const cap = capturingUiVector();
    await runMutation(deps(cap.vector, config(true)), "todo.reschedule-repeat", NEW, {
      dangerouslyDriveGui: true,
      verifyTimeoutMs: 1,
    });
    const steps = (cap.recipe()?.steps ?? []) as { label?: string }[];
    expect(steps.some((s) => (s.label ?? "").startsWith("yearly month"))).toBe(false);
    expect(assertedAnchorKey("todo.reschedule-repeat", NEW)).toBeUndefined();
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

// RDLG2 — Things 3.23 redesigned the Repeat dialog: a new "Next:" occurrence
// pop-up sits between Ends and every per-frequency control (+1 to their indices)
// and REPLACES the first-occurrence date area. The driver MEASURES which dialog is
// open and drives accordingly; nothing keys off the app version, so one binary
// serves both goldens and an unrecognized third dialog refuses.
describe("ui driver — the measured Repeat-dialog shape fork (RDLG2)", () => {
  /** Answer every probe/canary happily; `shape` is what the dialog measures as. */
  function shapeRunner(shape: string) {
    return mockRunner((c) => {
      if (isReach(c)) return ok("1 1 3");
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve") return ok("true");
      if (c.primitive === "assert-eligible") return ok("OK");
      if (c.primitive === "wait") return ok("true");
      if (c.primitive === "probe-dialog-shape") return ok(shape);
      return ok("OK");
    });
  }
  const recipe = makeRepeatingRecipe("TODO-1", "weekly", 1, {
    weekdays: ["tuesday", "thursday"],
    next: "2026-09-22",
  });

  it("under the 3.23 dialog: weekday rows start at pop-up 3 and Next is a MENU pick", async () => {
    const { run, commands } = shapeRunner("next-popup");
    const res = await createUiVector(config(true), run).execute(invocation(recipe));
    expect(res.exitCode).toBe(0);
    const weekdays = commands.find((c) => c.primitive === "converge-weekdays");
    expect(weekdays?.script).toContain("set baseIx to 3");
    expect(weekdays?.script).toContain('{"Tuesday", "Thursday"}');
    // the first occurrence goes through the new pop-up, and the ≤3.22 date-area
    // write is NOT dispatched (it would target a control that no longer exists)
    expect(commands.some((c) => c.primitive === "select-next-occurrence")).toBe(true);
    expect(commands.some((c) => c.primitive === "set-datetime")).toBe(false);
  });

  it("under the ≤3.22 dialog: weekday rows start at pop-up 2 and Next is a date write", async () => {
    const { run, commands } = shapeRunner("legacy");
    const res = await createUiVector(config(true), run).execute(invocation(recipe));
    expect(res.exitCode).toBe(0);
    expect(commands.find((c) => c.primitive === "converge-weekdays")?.script).toContain(
      "set baseIx to 2",
    );
    const dt = commands.find((c) => c.primitive === "set-datetime");
    expect(dt?.script).toContain("2026-09-22");
    expect(commands.some((c) => c.primitive === "select-next-occurrence")).toBe(false);
  });

  it("a dialog matching NEITHER shape refuses before any control is driven", async () => {
    const { run, commands } = shapeRunner("unknown");
    const res = await createUiVector(config(true), run).execute(invocation(recipe));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("matched neither known shape");
    expect(res.stderr).toContain("nothing was entered into the rule");
    // no weekday/next/OK actuation followed the refusal
    expect(commands.some((c) => c.primitive === "converge-weekdays")).toBe(false);
    expect(commands.some((c) => c.primitive === "select-next-occurrence")).toBe(false);
    expect(commands.filter((c) => c.primitive === "press" && c.script?.includes('"OK"'))).toEqual(
      [],
    );
  });

  it("the measured shape is named in the completed-steps trail", async () => {
    const { run } = shapeRunner("next-popup");
    const res = await createUiVector(config(true), run).execute(invocation(recipe));
    expect(res.stdout).toContain("(next-popup)");
  });

  it("the certified two-control path drives with NO shape probe at all", async () => {
    const { run, commands } = shapeRunner("next-popup");
    const res = await createUiVector(config(true), run).execute(
      invocation(makeRepeatingRecipe("TODO-1", "daily", 2)),
    );
    expect(res.exitCode).toBe(0);
    expect(commands.some((c) => c.primitive === "probe-dialog-shape")).toBe(false);
  });

  it("reschedule presses whichever menu spelling the installed app offers", async () => {
    // 3.23 renamed Reschedule… to Edit Rule…; the drive resolves the candidates in
    // order, so an app offering only the OLD name still drives.
    const { run, commands } = mockRunner((c) => {
      if (isReach(c)) return ok("1 1 3");
      if (c.primitive === "resolve" && c.script?.includes("sheetOpen") === true) return ok("false");
      if (c.primitive === "resolve")
        return ok(c.script?.includes('"Edit Rule…"') === true ? "false" : "true");
      if (c.primitive === "wait") return ok("true");
      return ok("OK");
    });
    const res = await createUiVector(config(true), run).execute(
      invocation(rescheduleRepeatRecipe("TODO-1", "daily", 3)),
    );
    expect(res.exitCode).toBe(0);
    const press = commands.find(
      (c) => c.primitive === "press" && c.script?.includes("of menu 1 of menu item") === true,
    );
    expect(press?.script).toContain('menu item "Reschedule…"');
  });
});
