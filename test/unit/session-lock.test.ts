/**
 * LOCKSCR1 (#732) — the session-lock decision, exercised as a table.
 *
 * The field defect was not a missing capability; it was an ORDER. A locked Mac
 * shows an empty window inventory, the drive read that emptiness as "Things has
 * no open window", and the operator was told to click a Dock icon behind a lock
 * screen. Every case below is one row of the order this module restores: ask the
 * session first, refuse when it says locked, hedge when it says nothing.
 */
import { describe, expect, it } from "vitest";

import { DEPUTY_BANNED_SCRIPT_PHRASES } from "../../src/deputy/protocol.ts";
import {
  blocksGuiDrive,
  describeSessionLock,
  interpretSessionLock,
  jxaSessionLockScript,
  lockRefusal,
  probeSessionLock,
  SESSION_LOCK_MARKER,
  UNKNOWN_SESSION_LOCK,
} from "../../src/write/vectors/session-lock.ts";
import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";

/** The probe's own output shape, as measured in the guest (LOCKSCR1 §2). */
function probeJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    keys: ["CGSSessionScreenIsLocked", "kCGSSessionOnConsoleKey", "kCGSSessionUserIDKey"],
    screenIsLocked: true,
    onConsole: true,
    screenSaver: false,
    source: "session-dictionary",
    ...over,
  });
}

/** A verdict in one named state, everything else unestablished. */
const inState = (s: string): ReturnType<typeof interpretSessionLock> => ({
  ...UNKNOWN_SESSION_LOCK,
  state: s as "locked",
});

/** The doctor row for one reading. */
const row = (s: string): string => describeSessionLock(inState(s));

/** A runner that records what it was handed and answers with a fixed result. */
const capture = (
  result: UiRunResult,
): { run: (c: UiCommand, t: number) => Promise<UiRunResult>; commands: UiCommand[] } => {
  const commands: UiCommand[] = [];
  return {
    commands,
    run: async (c) => {
      commands.push(c);
      return result;
    },
  };
};

describe("interpretSessionLock — the four readings", () => {
  it("reads CGSSessionScreenIsLocked=true as LOCKED, keeping the keys as evidence", () => {
    const v = interpretSessionLock(probeJson());
    expect(v.state).toBe("locked");
    expect(v.screenIsLocked).toBe(true);
    expect(v.onConsole).toBe(true);
    expect(v.keys).toContain("CGSSessionScreenIsLocked");
    expect(v.source).toBe("session-dictionary");
  });

  it("reads the key's ABSENCE as unlocked — that is how macOS reports an unlocked screen", () => {
    const v = interpretSessionLock(
      probeJson({ keys: ["kCGSSessionOnConsoleKey"], screenIsLocked: null }),
    );
    expect(v.state).toBe("unlocked");
    expect(v.screenIsLocked).toBeNull();
  });

  it("reads an explicit false the same way", () => {
    expect(interpretSessionLock(probeJson({ screenIsLocked: false })).state).toBe("unlocked");
  });

  it("reads a running screen saver on an unlocked session as SCREENSAVER (over-caution)", () => {
    const v = interpretSessionLock(probeJson({ screenIsLocked: null, screenSaver: true }));
    expect(v.state).toBe("screensaver");
  });

  it("prefers the lock over the saver when both are true — the lock is the actionable fact", () => {
    expect(interpretSessionLock(probeJson({ screenSaver: true })).state).toBe("locked");
  });

  it("reads NO session dictionary as unknown, never as unlocked", () => {
    const v = interpretSessionLock(
      JSON.stringify({
        keys: [],
        screenIsLocked: null,
        onConsole: null,
        screenSaver: false,
        source: "unavailable",
      }),
    );
    expect(v.state).toBe("unknown");
    expect(v.source).toBe("unavailable");
  });

  it("reads unparseable output as unknown", () => {
    expect(interpretSessionLock("").state).toBe("unknown");
    expect(interpretSessionLock("execution error: -1743").state).toBe("unknown");
    expect(interpretSessionLock("[1,2,3]").state).toBe("unknown");
  });
});

describe("blocksGuiDrive — which readings stop a gesture", () => {
  it("blocks on locked and on screensaver", () => {
    expect(blocksGuiDrive(inState("locked"))).toBe(true);
    expect(blocksGuiDrive(inState("screensaver"))).toBe(true);
  });
  it("does NOT block on unlocked or on unknown — an unread session is hedged, not refused", () => {
    expect(blocksGuiDrive(inState("unlocked"))).toBe(false);
    expect(blocksGuiDrive(inState("unknown"))).toBe(false);
  });
});

describe("the refusal a locked session produces", () => {
  it("names the lock, the remedy, and that nothing changed", () => {
    const r = lockRefusal({ ...UNKNOWN_SESSION_LOCK, state: "locked" });
    expect(r.reachable).toBe(false);
    expect(r.scope).toBe("session");
    expect(r.detail).toContain("the screen is locked");
    expect(r.detail).toContain("no window can be read or clicked");
    expect(r.detail).toContain("Nothing was changed");
    expect(r.remediation).toContain("Unlock the Mac");
    // It must NOT resurrect the sentence #732 complained about.
    expect(r.detail).not.toContain("Dock icon");
    expect(r.detail).not.toContain("no open window");
  });

  it("says SAVER when it is the saver, not the lock — the remedy differs", () => {
    const r = lockRefusal({ ...UNKNOWN_SESSION_LOCK, state: "screensaver" });
    expect(r.detail).toContain("screen saver is running");
    expect(r.remediation).toContain("Wake the Mac");
  });
});

describe("the doctor session row", () => {
  it("renders one honest line per reading", () => {
    expect(row("locked")).toContain("locked");
    expect(row("unlocked")).toBe("unlocked");
    expect(row("screensaver")).toContain("saver");
    // The unknown row must say WHY it matters, not just "unknown".
    expect(row("unknown")).toContain("locked screen");
  });
});

describe("the probe script itself", () => {
  const script = jxaSessionLockScript();

  it("carries its marker and reads only the caller's own session", () => {
    expect(script).toContain(SESSION_LOCK_MARKER);
    expect(script).toContain("CGSessionCopyCurrentDictionary");
    expect(script).toContain("CGSSessionScreenIsLocked");
    expect(script).toContain("kCGSSessionOnConsoleKey");
  });

  it("targets no other application — nothing here can raise a consent dialog", () => {
    // The two shapes that WOULD need a grant: an Apple event at another app, or
    // a read of another process's Accessibility tree. Neither may appear.
    expect(script).not.toContain("System Events");
    expect(script).not.toContain("Things3");
    expect(script).not.toContain("AXUIElement");
  });

  it("carries no phrase the deputy's broker refuses", () => {
    const lowered = script.toLowerCase();
    expect(DEPUTY_BANNED_SCRIPT_PHRASES.filter((p) => lowered.includes(p))).toEqual([]);
  });
});

describe("probeSessionLock — the transport", () => {
  it("dispatches ONE javascript hop and interprets its stdout", async () => {
    const { run, commands } = capture({ ok: true, stdout: probeJson(), stderr: "" });
    const v = await probeSessionLock(run, 1000);
    expect(v.state).toBe("locked");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.lang).toBe("javascript");
    expect(commands[0]?.primitive).toBe("resolve");
  });

  it("reports unknown — never unlocked — when the hop fails", async () => {
    const { run } = capture({ ok: false, stdout: "", stderr: "boom" });
    expect((await probeSessionLock(run, 1000)).state).toBe("unknown");
  });
});
