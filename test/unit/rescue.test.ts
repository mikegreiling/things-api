/**
 * `things rescue` — gating, refusals and the two ladders (issue #640).
 *
 * Everything here runs against injected seams: the fake screen from the ui
 * fixtures answers the census and the Cancel rungs the way the app does, and the
 * process table, the signals, the launch and the schema check are all supplied.
 * That is deliberate — the properties worth locking are decisions ("did it
 * refuse, and did it press anything before refusing?"), not osascript.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AuditRecord } from "../../src/audit/schema.ts";
import type { UiCapability } from "../../src/capability.ts";
import {
  rescueDismiss,
  rescueRelaunch,
  rescueStatus,
  rescueStatusLines,
  type RescueDeps,
} from "../../src/rescue.ts";
import {
  describeLockRefusal,
  LOCK_HOLDER_SUSPECT_MS,
  MutationLockError,
  readLockHolder,
} from "../../src/write/lock.ts";
import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";
import { healthyScreen, screenAnswer, type FakeScreen } from "../fixtures/ui-state.ts";

const HOST = { bundleId: null, name: "this terminal" };
const ALLOWED: UiCapability = {
  mode: "helpers",
  detail: "the helper pair holds the access",
  remediation: [],
  host: HOST,
};
const DENIED: UiCapability = {
  mode: "config-disabled",
  detail: "GUI-driving is switched off on this machine (`ui-enabled` is false)",
  remediation: ["run `things config set ui-enabled true` to opt in"],
  host: HOST,
};

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "rescue-"));
}

/** Deps wired to a fake screen, counting every command the module dispatched. */
function harness(screen: FakeScreen, extra: RescueDeps = {}) {
  const dispatched: UiCommand[] = [];
  const records: AuditRecord[] = [];
  const dir = stateDir();
  const deps: RescueDeps = {
    uiCapability: () => ALLOWED,
    env: { THINGS_API_STATE_DIR: dir, THINGS_API_PROFILE: "dedicated-server" },
    audit: { append: (r) => void records.push(r) },
    sleep: async () => {},
    run: async (c: UiCommand): Promise<UiRunResult> => {
      dispatched.push(c);
      return screenAnswer(screen, c) ?? { ok: false, stdout: "", stderr: "unexpected command" };
    },
    ...extra,
  };
  return { deps, dispatched, records, dir };
}

/** Did anything that could change the screen get dispatched? */
function pressedAnything(dispatched: UiCommand[]): boolean {
  return dispatched.some(
    (c) => c.primitive === "click-point" || (c.script ?? "").includes("click button"),
  );
}

// ------------------------------------------------------------------ status

describe("rescue status", () => {
  it("reports the census, and never touches anything", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1 });
    const { deps, dispatched } = harness(screen);
    const report = await rescueStatus(deps);

    expect(report.screenReadable).toBe(true);
    expect(report.state?.sheetKind).toBe("repeat");
    expect(report.warnings.join(" ")).toContain("stays on this Mac");
    expect(report.remediation.join(" ")).toContain("things rescue dismiss");
    expect(pressedAnything(dispatched)).toBe(false);
  });

  it("reports the capability verdict as data rather than refusing", async () => {
    const { deps, dispatched } = harness(healthyScreen(), { uiCapability: () => DENIED });
    const report = await rescueStatus(deps);

    expect(report.screenReadable).toBe(false);
    expect(report.remediation).toEqual(DENIED.remediation);
    // The gate comes FIRST: nothing was dispatched at all.
    expect(dispatched).toEqual([]);
  });

  it("names a system dialog as one nothing here may touch", async () => {
    const screen = healthyScreen({ front: "loginwindow", inspectable: false, failed: ["focus"] });
    const { deps } = harness(screen);
    const report = await rescueStatus(deps);

    expect(report.foreignModal).not.toBeNull();
    expect(report.foreignModal?.owner).toBe("loginwindow");
    expect(report.remediation.join(" ")).toContain("answer that dialog at the screen");
  });

  it("reports a live lock holder, its age, and that a hung one can be killed", async () => {
    const { deps, dir } = harness(healthyScreen());
    const held = new Date(Date.now() - LOCK_HOLDER_SUSPECT_MS - 1_000).toISOString();
    writeFileSync(join(dir, "mutation.lock"), JSON.stringify({ pid: 4242, ts: held }));

    const report = await rescueStatus({ ...deps, pidAlive: () => true });
    expect(report.lock.held).toBe(true);
    expect(report.lock.pid).toBe(4242);
    expect(report.lock.alive).toBe(true);
    expect(report.lock.suspect).toBe(true);
    expect(report.remediation.join(" ")).toContain("kill 4242");
  });

  it("says a dead holder's lock is simply stale, and offers no kill", async () => {
    const { deps, dir } = harness(healthyScreen());
    writeFileSync(
      join(dir, "mutation.lock"),
      JSON.stringify({ pid: 4242, ts: new Date().toISOString() }),
    );

    const report = await rescueStatus({ ...deps, pidAlive: () => false });
    expect(report.lock.alive).toBe(false);
    expect(report.lock.suspect).toBe(false);
    expect(report.lock.detail).toContain("no longer running");
    expect(report.remediation.join(" ")).not.toContain("kill ");
  });

  it("warns that a detached dialog is expected to resist dismissal", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1, form: "detached" });
    const { deps } = harness(screen);
    const report = await rescueStatus(deps);
    expect(report.remediation.join(" ")).toContain("things rescue relaunch");
  });

  // The two properties inherited from the retired top-level `ui-state` command,
  // which `rescue status` is now the only home for.
  it("renders which application owns the keyboard, and what has focus in it", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1, role: "AXTextField" });
    const { deps } = harness(screen);
    const rendered = rescueStatusLines(await rescueStatus(deps)).join("\n");

    expect(rendered).toContain("focus:");
    expect(rendered).toContain("Things3 · AXTextField");
    expect(rendered).toContain("dialog:      repeat");
    expect(rendered).toContain("stacked:     1");
  });

  it("renders a probe that did not answer as 'not established', never as its default", async () => {
    // #629: the census short-circuits at the stalled probe, so `dialog` reports
    // its unset default — which must NOT be printed as a clean screen.
    const screen = healthyScreen({ stalled: ["dialog"] });
    const { deps } = harness(screen);
    const rendered = rescueStatusLines(await rescueStatus(deps)).join("\n");

    expect(rendered).toContain("dialog:      not established");
    expect(rendered).toContain("stacked:     not established");
    expect(rendered).not.toContain("dialog:      none");
    expect(rendered).toContain("unproven:");
  });
});

// ----------------------------------------------------------------- dismiss

describe("rescue dismiss", () => {
  it("refuses without the acknowledgement, pressing nothing", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1 });
    const { deps, dispatched } = harness(screen);
    const result = await rescueDismiss({}, deps);

    expect(result.outcome).toBe("refused");
    expect(result.remediation.join(" ")).toContain("--dangerously-dismiss-dialog");
    expect(dispatched).toEqual([]);
    expect(screen.kind).toBe("repeat");
  });

  it("refuses without the GUI access, pressing nothing", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1 });
    const { deps, dispatched } = harness(screen, { uiCapability: () => DENIED });
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.remediation).toEqual(DENIED.remediation);
    expect(dispatched).toEqual([]);
  });

  it("closes a Repeat dialog by its own Cancel and confirms it is gone", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1 });
    const { deps, records } = harness(screen);
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("dismissed");
    expect(result.how).toBe("cancel-button");
    expect(result.levelsRemaining).toBe(0);
    expect(screen.kind).toBe("none");
    expect(records.map((r) => r.op)).toEqual(["rescue.dismiss"]);
    expect(records[0]?.result).toBe("ok");
  });

  it("closes exactly ONE level of a stack and says how many remain", async () => {
    const screen = healthyScreen({ kind: "other", depth: 3, dismissable: true });
    // The stack's TOP is what the census identifies; model a recognized one.
    screen.kind = "repeat";
    const { deps } = harness(screen);
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("dismissed");
    expect(result.levelsRemaining).toBe(2);
    expect(screen.depth).toBe(2);
    expect(result.remediation.join(" ")).toContain("again");
    expect(result.warnings.join(" ")).toContain("stays on this Mac");
  });

  it("refuses on a dialog it cannot identify, naming relaunch", async () => {
    const screen = healthyScreen({ kind: "other", depth: 1 });
    const { deps, dispatched } = harness(screen);
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.detail).toContain("cannot identify");
    expect(result.remediation.join(" ")).toContain("things rescue relaunch");
    expect(pressedAnything(dispatched)).toBe(false);
    expect(screen.kind).toBe("other");
  });

  it("refuses against a system dialog, naming its owner and pressing nothing", async () => {
    const screen = healthyScreen({
      kind: "repeat",
      depth: 1,
      front: "loginwindow",
      inspectable: false,
    });
    const { deps, dispatched } = harness(screen);
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.detail).toContain("loginwindow");
    expect(pressedAnything(dispatched)).toBe(false);
  });

  it("refuses when a decision-critical part of the census did not answer", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1, stalled: ["dialog"] });
    const { deps, dispatched } = harness(screen);
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("refused");
    expect(result.detail).toContain("which dialog a Cancel would land on");
    expect(pressedAnything(dispatched)).toBe(false);
  });

  it("is a clean no-op when nothing is open", async () => {
    const { deps, records } = harness(healthyScreen());
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("no-dialog");
    expect(result.levelsRemaining).toBe(0);
    expect(result.remediation).toEqual([]);
    // A no-op is not an action, so it leaves no record.
    expect(records).toEqual([]);
  });

  it("falls back to clicking the button when AXPress does not close it", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1 });
    const { deps, dispatched } = harness(screen, {
      // AXPress reports success and changes nothing — the §26 shape. The
      // synthesized click at the same button's frame is what closes it here.
      run: async (c: UiCommand): Promise<UiRunResult> => {
        dispatchedPush(c);
        if ((c.script ?? "").includes('click button "Cancel"')) {
          return { ok: true, stdout: "OK", stderr: "" };
        }
        return screenAnswer(screen, c) ?? { ok: false, stdout: "", stderr: "unexpected" };
      },
    });
    function dispatchedPush(c: UiCommand): void {
      dispatched.push(c);
    }
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("dismissed");
    expect(result.how).toBe("cancel-click");
    expect(result.notes.join(" ")).toContain("clicked at its own position");
  });

  it("reports honestly when a dialog ignores every press (oddities §26)", async () => {
    const screen = healthyScreen({
      kind: "repeat",
      depth: 1,
      form: "detached",
      dismissable: false,
    });
    const { deps, dispatched, records } = harness(screen);
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("still-open");
    expect(result.how).toBeNull();
    expect(result.detail).toContain("still open");
    expect(result.detail).toContain("detached");
    expect(result.remediation.join(" ")).toContain("things rescue relaunch");
    // It really did try both rungs before saying so.
    expect(dispatched.some((c) => c.primitive === "click-point")).toBe(true);
    expect(records[0]?.result).toBe("blocked:still-open");
  });

  it("reports UNVERIFIED rather than success when the screen goes unreadable", async () => {
    const screen = healthyScreen({ kind: "repeat", depth: 1 });
    let pressed = false;
    const { deps } = harness(screen, {
      run: async (c: UiCommand): Promise<UiRunResult> => {
        if ((c.script ?? "").includes('click button "Cancel"')) {
          pressed = true;
          return { ok: true, stdout: "OK", stderr: "" };
        }
        // Every read after the press fails at the transport.
        if (pressed) return { ok: false, stdout: "", stderr: "no answer" };
        return screenAnswer(screen, c) ?? { ok: false, stdout: "", stderr: "unexpected" };
      },
    });
    const result = await rescueDismiss({ dangerouslyDismissDialog: true }, deps);

    expect(result.outcome).toBe("unverified");
    expect(result.detail).toContain("whether the dialog closed is unknown");
  });
});

// ---------------------------------------------------------------- relaunch

/** Deps for the relaunch ladder: a fake process table that responds to signals. */
function relaunchHarness(opts: {
  pids: number[];
  /** Which signal (or "quit") actually ends the process. */
  diesOn: "quit" | "SIGTERM" | "SIGKILL" | "never";
  profile?: string;
  screen?: FakeScreen;
  launchOk?: boolean;
  schemaOk?: boolean;
}) {
  let alive = [...opts.pids];
  const signals: string[] = [];
  const screen = opts.screen ?? healthyScreen();
  const records: AuditRecord[] = [];
  // A clock that only moves when the code SLEEPS, so every bounded poll in the
  // ladder terminates on its own budget rather than on wall-clock luck.
  let clock = Date.now();
  const deps: RescueDeps = {
    uiCapability: () => ALLOWED,
    env: {
      THINGS_API_STATE_DIR: stateDir(),
      THINGS_API_PROFILE: opts.profile ?? "dedicated-server",
    },
    audit: { append: (r) => void records.push(r) },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    thingsPids: async () => [...alive],
    signal: (_pid, sig) => {
      signals.push(sig);
      if (sig === opts.diesOn) alive = [];
    },
    launch: async () => ({
      ok: opts.launchOk !== false,
      detail:
        opts.launchOk === false ? "Things would not start" : "Things was started in the background",
    }),
    schemaStatus: () => ({
      ok: opts.schemaOk !== false,
      detail:
        opts.schemaOk === false ? "the database no longer matches" : "the database reads fine",
    }),
    run: async (c: UiCommand): Promise<UiRunResult> => {
      if ((c.script ?? "").includes("to quit")) {
        if (opts.diesOn === "quit") alive = [];
        return { ok: true, stdout: "", stderr: "" };
      }
      return screenAnswer(screen, c) ?? { ok: false, stdout: "", stderr: "unexpected" };
    },
  };
  return { deps, signals, records, alivePids: () => alive };
}

describe("rescue relaunch", () => {
  it("refuses without --yes, signalling nothing", async () => {
    const { deps, signals } = relaunchHarness({ pids: [10], diesOn: "SIGTERM" });
    const result = await rescueRelaunch({}, deps);

    expect(result.outcome).toBe("refused");
    expect(result.remediation.join(" ")).toContain("--yes");
    expect(signals).toEqual([]);
  });

  it("needs a SECOND key on a workstation, where someone may be at the screen", async () => {
    const { deps, signals } = relaunchHarness({
      pids: [10],
      diesOn: "SIGTERM",
      profile: "workstation",
    });
    const refused = await rescueRelaunch({ yes: true }, deps);
    expect(refused.outcome).toBe("refused");
    expect(refused.detail).toContain("workstation");
    expect(refused.remediation.join(" ")).toContain("--dangerously-force-quit");
    expect(signals).toEqual([]);

    const done = await rescueRelaunch({ yes: true, dangerouslyForceQuit: true }, deps);
    expect(done.outcome).toBe("relaunched");
  });

  it("needs only --yes on a machine nobody is sitting at", async () => {
    const { deps } = relaunchHarness({ pids: [10], diesOn: "SIGTERM" });
    const result = await rescueRelaunch({ yes: true }, deps);
    expect(result.outcome).toBe("relaunched");
  });

  it("stops at the gentlest rung that works", async () => {
    const { deps, signals } = relaunchHarness({ pids: [10], diesOn: "quit" });
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.outcome).toBe("relaunched");
    expect(result.endedBy).toBe("quit");
    expect(signals).toEqual([]); // never escalated
  });

  it("escalates quit → SIGTERM → SIGKILL, in that order", async () => {
    const { deps, signals } = relaunchHarness({ pids: [10, 11], diesOn: "SIGKILL" });
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.outcome).toBe("relaunched");
    expect(result.endedBy).toBe("sigkill");
    expect(signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL", "SIGKILL"]);
    expect(result.ladder.join(" ")).toContain("SIGTERM");
    expect(result.ladder.join(" ")).toContain("SIGKILL");
  });

  it("still starts Things when it was not running", async () => {
    const { deps, signals } = relaunchHarness({ pids: [], diesOn: "never" });
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.outcome).toBe("relaunched");
    expect(result.endedBy).toBe("not-running");
    expect(signals).toEqual([]);
  });

  it("fails honestly when the process survives a kill", async () => {
    const { deps } = relaunchHarness({ pids: [10], diesOn: "never" });
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("would not end");
    expect(result.remediation.join(" ")).toContain("Force Quit");
  });

  it("fails honestly when Things will not start again", async () => {
    const { deps } = relaunchHarness({ pids: [10], diesOn: "SIGTERM", launchOk: false });
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("would not start again");
  });

  it("states what was lost and that sync resumes, and records the action", async () => {
    const { deps, records } = relaunchHarness({ pids: [10], diesOn: "SIGTERM" });
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.notes.join(" ")).toContain("already saved survived");
    expect(result.notes.join(" ")).toContain("Things Cloud");
    expect(records.map((r) => r.op)).toEqual(["rescue.relaunch"]);
    expect(records[0]?.observed).toMatchObject({ endedBy: "sigterm", schemaOk: true });
  });

  it("warns when the database no longer reads as the expected shape", async () => {
    const { deps } = relaunchHarness({ pids: [10], diesOn: "SIGTERM", schemaOk: false });
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.outcome).toBe("relaunched");
    expect(result.warnings.join(" ")).toContain("things doctor");
  });

  it("clears a dialog no dismissal could touch — the §26 cure", async () => {
    // A stranded detached editor: nothing dismisses it, and the census keeps
    // reporting it until the process itself goes.
    const screen = healthyScreen({
      kind: "repeat",
      depth: 1,
      form: "detached",
      dismissable: false,
    });
    const { deps } = relaunchHarness({ pids: [10], diesOn: "SIGKILL", screen });
    // The relaunched app comes back clean, as a fresh process does.
    const original = deps.launch;
    deps.launch = async () => {
      screen.kind = "none";
      screen.depth = 0;
      return original === undefined ? { ok: true, detail: "started" } : original();
    };
    const result = await rescueRelaunch({ yes: true }, deps);

    expect(result.outcome).toBe("relaunched");
    expect(result.endedBy).toBe("sigkill");
    expect(result.after?.sheetOpen).toBe(false);
    expect(result.detail).toContain("no dialog is open");
  });

  it("works without the GUI access — the machines that need it most lack it", async () => {
    const { deps, signals } = relaunchHarness({ pids: [10], diesOn: "SIGTERM" });
    const result = await rescueRelaunch({ yes: true }, { ...deps, uiCapability: () => DENIED });

    expect(result.outcome).toBe("relaunched");
    expect(signals).toContain("SIGTERM");
    expect(result.ladder.join(" ")).toContain("has not granted");
  });
});

// -------------------------------------------------------------- lock copy

describe("the mutation-lock refusal", () => {
  it("says a young live holder is simply busy", () => {
    const ts = new Date(Date.now() - 5_000).toISOString();
    const err = new MutationLockError("another mutation is in progress (pid 7 since …)", {
      pid: 7,
      ts,
    });
    const { detail, remediation } = describeLockRefusal(err, { pidAlive: () => true });

    expect(detail).toContain("still running");
    expect(detail).toContain("held for 5s");
    expect(remediation).not.toContain("kill 7");
  });

  it("says an old live holder may be hung, and that killing it releases the lock", () => {
    const ts = new Date(Date.now() - LOCK_HOLDER_SUSPECT_MS - 60_000).toISOString();
    const err = new MutationLockError("another mutation is in progress (pid 7 since …)", {
      pid: 7,
      ts,
    });
    const { remediation } = describeLockRefusal(err, { pidAlive: () => true });

    expect(remediation).toContain("may be hung");
    expect(remediation).toContain("kill 7");
    expect(remediation).toContain("things rescue status");
  });

  it("tells a caller whose holder died to just run it again", () => {
    const err = new MutationLockError("another mutation is in progress (pid 7 since …)", {
      pid: 7,
      ts: new Date().toISOString(),
    });
    const { detail, remediation } = describeLockRefusal(err, { pidAlive: () => false });

    expect(detail).toContain("stale");
    expect(remediation).toContain("run the command again");
  });

  it("says only what it can prove when the lockfile was unreadable", () => {
    const err = new MutationLockError("another mutation is in progress");
    const { detail, remediation } = describeLockRefusal(err);
    expect(detail).toBe("another mutation is in progress");
    expect(remediation).toBe("wait for the concurrent mutation to finish and retry");
  });
});

describe("readLockHolder", () => {
  it("reads an empty slot as no holder, never as an error", () => {
    expect(readLockHolder(join(stateDir(), "nope.lock"))).toEqual({
      holder: null,
      alive: false,
      heldForMs: null,
      suspect: false,
    });
  });

  it("treats a torn write as no holder we can name", () => {
    const path = join(stateDir(), "mutation.lock");
    writeFileSync(path, '{"pid":7,"ts":');
    expect(readLockHolder(path).holder).toBeNull();
  });

  it("never calls a dead holder suspect, however old", () => {
    const path = join(stateDir(), "mutation.lock");
    writeFileSync(path, JSON.stringify({ pid: 7, ts: new Date(0).toISOString() }));
    const report = readLockHolder(path, { pidAlive: () => false });
    expect(report.alive).toBe(false);
    expect(report.suspect).toBe(false);
  });
});
