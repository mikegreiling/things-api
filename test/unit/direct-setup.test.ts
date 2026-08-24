/**
 * The `things setup` ceremony (docs/design/permissions-doctrine.md, Article V).
 *
 * SAFETY: every runner that could put something on screen — the Settings deep
 * link, the Apple Event, the container open, the install sheets — is stubbed.
 * No cell in this file may reach the host's real consent state.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { directSetup, surveySetup, type DirectSetupDeps } from "../../src/direct-setup.ts";
import { resetCapabilityForTests } from "../../src/capability.ts";

/**
 * A ceremony wired entirely to stubs. Defaults describe the hardest machine:
 * nothing granted, nothing installed.
 */
function ceremony(over: Partial<DirectSetupDeps> = {}): DirectSetupDeps {
  resetCapabilityForTests();
  const lines: string[] = [];
  return {
    env: {
      __CFBundleIdentifier: "com.mitchellh.ghostty",
      THINGS_API_STATE_DIR: mkdtempSync(join(tmpdir(), "things-setup-")),
      THINGS_API_HELPERS: "false",
    },
    progress: (line) => lines.push(line),
    openUrl: () => {},
    openShortcut: () => {},
    sleep: () => {},
    elapsed: (() => {
      // A clock that runs out immediately, so the bounded wait never blocks.
      let t = 0;
      return () => (t += 1_000_000);
    })(),
    fdaProbe: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    helpersServing: () => false,
    helpersExpected: () => false,
    deputyAutomation: () => undefined,
    automationAuthValue: () => null,
    lookupAppName: () => null,
    sendAutomationProbe: () => {},
    shortcutProxies: () => ({
      present: [],
      missing: ["things-proxy-find-items", "things-proxy-create-heading"],
      detail: "none installed",
    }),
    openContainer: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    hostPid: () => 4242,
    processStart: () => "Thu Jul 16 00:29:43 2026",
    bootTime: () => 1_784_187_814,
    ...over,
  };
}

function progressOf(deps: DirectSetupDeps): string[] {
  const lines: string[] = [];
  const spy = { ...deps, progress: (line: string) => lines.push(line) };
  directSetup(spy);
  return lines;
}

describe("the upfront banner (Article V, strict mode)", () => {
  it("counts the dialogs BEFORE raising any of them", () => {
    const lines = progressOf(ceremony());
    const banner = lines.find((l) => l.startsWith("about to raise"));
    expect(banner).toBeDefined();
    expect(banner).toContain("about to raise 3 dialogs");
    expect(banner).toContain("someone must be at the screen");
  });

  it("says so plainly when a settled machine has nothing to raise", () => {
    const lines = progressOf(
      ceremony({
        fdaProbe: () => {},
        automationAuthValue: () => 2,
        shortcutProxies: () => ({ present: ["x"], missing: [], detail: "all installed" }),
      }),
    );
    expect(lines.some((l) => l.startsWith("nothing to raise"))).toBe(true);
  });

  it("a REFUSED grant is not counted — macOS will not show that dialog again", () => {
    const survey = surveySetup(ceremony({ automationAuthValue: () => 0 }));
    expect(survey.outstanding).not.toContain("app-control");
  });
});

describe("leg (a) — read access", () => {
  it("is skipped, prompt-free, when Full Disk Access is already held", () => {
    const result = directSetup(ceremony({ fdaProbe: () => {} }));
    const step = result.steps.find((s) => s.leg === "read-access");
    expect(step).toMatchObject({ state: "granted", alreadySatisfied: true });
    expect(step?.detail).toContain("Full Disk Access");
  });

  it("is skipped when the helpers already serve reads", () => {
    const result = directSetup(ceremony({ helpersServing: () => true }));
    expect(result.steps.find((s) => s.leg === "read-access")).toMatchObject({
      state: "granted",
      alreadySatisfied: true,
    });
  });

  it("guides to Full Disk Access first, and polls for it", () => {
    const opened: string[] = [];
    const lines = progressOf(ceremony({ openUrl: (url) => opened.push(url) }));
    expect(lines.some((l) => l.includes("Privacy & Security ▸ Full Disk Access"))).toBe(true);
    expect(opened.some((u) => u.includes("Privacy_AllFiles"))).toBe(true);
  });

  it("witnesses the session grant when the deliberate container open succeeds", () => {
    const result = directSetup(ceremony({ openContainer: () => {} }));
    const step = result.steps.find((s) => s.leg === "read-access");
    expect(step?.state).toBe("granted");
    // The copy must be honest about how long it lasts.
    expect(step?.detail).toContain("until it quits");
    expect(step?.detail).toContain("Full Disk Access");
  });

  it("stays pending — never claims a grant — when the open still fails", () => {
    const result = directSetup(ceremony());
    const step = result.steps.find((s) => s.leg === "read-access");
    expect(step?.state).toBe("pending");
    expect(step?.detail).toContain("things helpers setup");
  });
});

describe("leg (b) — app control", () => {
  it("is skipped, prompt-free, when macOS already records the grant", () => {
    let sent = false;
    const result = directSetup(
      ceremony({ automationAuthValue: () => 2, sendAutomationProbe: () => (sent = true) }),
    );
    expect(result.steps.find((s) => s.leg === "app-control")).toMatchObject({
      state: "granted",
      alreadySatisfied: true,
    });
    expect(sent, "an already-granted leg must send no Apple Event").toBe(false);
  });

  it("a recorded refusal is NOT re-asked, and names both remedies", () => {
    let sent = false;
    const result = directSetup(
      ceremony({ automationAuthValue: () => 0, sendAutomationProbe: () => (sent = true) }),
    );
    const step = result.steps.find((s) => s.leg === "app-control");
    expect(step?.state).toBe("denied");
    expect(sent, "macOS will not show a spent dialog — do not re-fire it").toBe(false);
    expect(step?.detail).toContain("System Settings");
    expect(step?.detail).toContain("tccutil reset AppleEvents");
  });

  it("a -1743 from the live event is a denial with the same two remedies", () => {
    const result = directSetup(
      ceremony({
        sendAutomationProbe: () => {
          throw Object.assign(new Error("nope"), { stderr: "execution error: … (-1743)" });
        },
      }),
    );
    const step = result.steps.find((s) => s.leg === "app-control");
    expect(step?.state).toBe("denied");
    expect(step?.detail).toContain("tccutil reset AppleEvents com.mitchellh.ghostty");
  });

  it("an unanswered dialog is PENDING (resumable), not a failure", () => {
    const result = directSetup(
      ceremony({
        sendAutomationProbe: () => {
          throw Object.assign(new Error("timeout"), { killed: true, stderr: "" });
        },
      }),
    );
    expect(result.steps.find((s) => s.leg === "app-control")?.state).toBe("pending");
  });

  it("a zero exit is not believed on its own — macOS's own record is re-read", () => {
    // The event 'succeeded' but TCC still records nothing: reporting `granted`
    // here is the false positive that shipped once in the helpers' ceremony.
    const result = directSetup(ceremony({ sendAutomationProbe: () => {} }));
    expect(result.steps.find((s) => s.leg === "app-control")?.state).toBe("pending");
  });
});

describe("leg (c) — the shortcuts importer, now one leg of the ceremony", () => {
  it("opens an install sheet per missing shortcut", () => {
    const opened: string[] = [];
    directSetup(ceremony({ openShortcut: (f) => opened.push(f) }));
    // The bundled .shortcut files ship with the package, so at least one sheet
    // is attempted on a machine with none installed.
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((f) => f.endsWith(".shortcut"))).toBe(true);
  });
});

describe("exit semantics and the closing line", () => {
  it("anything outstanding leaves the run nonzero-worthy and names what remains", () => {
    const result = directSetup(ceremony());
    expect(result.pending || result.denied).toBe(true);
    expect(result.closing).toContain("still outstanding");
    expect(result.closing).toContain("things setup");
  });

  it("a refusal is reported as such, not as a pending step", () => {
    const result = directSetup(ceremony({ automationAuthValue: () => 0 }));
    expect(result.denied).toBe(true);
    expect(result.closing).toContain("refused");
  });

  it("there is NO Accessibility leg — GUI-driving is helpers-only (Article IV)", () => {
    const result = directSetup(ceremony());
    expect(result.steps.map((s) => s.leg)).toEqual(["read-access", "app-control", "shortcuts"]);
    expect(JSON.stringify(result)).not.toMatch(/accessibility/i);
  });
});

/** A runner that fails the test if the survey ever reaches it. */
const forbidden = (what: string) => (): never => {
  throw new Error(`survey must not ${what}`);
};

describe("surveySetup is prompt-free by construction", () => {
  it("raises nothing at all: no event, no container open, no sheet, no deep link", () => {
    const survey = surveySetup(
      ceremony({
        sendAutomationProbe: forbidden("send an Apple Event") as () => void,
        openContainer: forbidden("open the container"),
        openShortcut: forbidden("open an install sheet") as () => void,
        openUrl: forbidden("open System Settings") as () => void,
      }),
    );
    expect(survey.outstanding).toContain("read-access");
    expect(survey.host.name).toBe("Ghostty");
  });
});
