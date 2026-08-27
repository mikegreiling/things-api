/**
 * The `things setup` ceremony (docs/design/permissions-doctrine.md, Article V).
 *
 * SAFETY: every runner that could put something on screen — the Settings deep
 * link, the Apple Event, the container open, the install sheets — is stubbed.
 * No cell in this file may reach the host's real consent state.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ContainerOpenTimedOut,
  directSetup,
  surveySetup,
  type DirectSetupDeps,
} from "../../src/direct-setup.ts";
import {
  resetCapabilityForTests,
  type UrlSchemeCapability,
  type UrlSchemeCapabilityMode,
} from "../../src/capability.ts";
import { CeremonyStopped, createWizard } from "../../src/wizard.ts";
import { makeTempDir } from "../fixtures/temp-dir.ts";

/** An injected "Enable Things URLs" verdict — never this machine's own. */
function urlStanding(mode: UrlSchemeCapabilityMode): UrlSchemeCapability {
  return {
    mode,
    detail:
      mode === "enabled"
        ? "Things ▸ Settings ▸ General ▸ Enable Things URLs is on"
        : `test standing: ${mode}`,
    remediation:
      mode === "enabled" || mode === "unreadable"
        ? []
        : ["turn on Things ▸ Settings ▸ General ▸ Enable Things URLs, then retry"],
    host: { bundleId: "com.mitchellh.ghostty", name: "Ghostty" },
  };
}

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
      THINGS_API_STATE_DIR: makeTempDir("things-setup"),
      // A scratch config dir, so the ceremony's `ui-enabled` read cannot pick
      // up the developer's own stored config and change what the closing says.
      THINGS_API_CONFIG_DIR: makeTempDir("things-setup-cfg"),
      THINGS_API_HELPERS: "false",
    },
    // Strict mode unless a cell asks otherwise: no TTY gate, no explainers.
    wizard: createWizard({ interactive: false }),
    progress: (line) => lines.push(line),
    openUrl: () => {},
    openShortcut: () => {},
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
    // Leg (d) is injected by default so the base ceremony never reads this
    // developer's own Things preferences; the leg-(d) cells override it.
    urlSchemeStanding: () => urlStanding("enabled"),
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
  it("counts the dialogs BEFORE raising any of them, and names them flatly", () => {
    const lines = progressOf(ceremony());
    const banner = lines.find((l) => l.startsWith("about to raise"));
    expect(banner).toBeDefined();
    expect(banner).toContain("about to raise 3 dialogs");
    // The DEFAULT path's dialogs, named without nesting: the session data
    // dialog, app control, and the install sheets.
    expect(banner).toContain("data access for Ghostty");
    expect(banner).toContain("app control of Things");
    expect(banner).toContain("Someone must be at the screen.");
  });

  it("counts two when the shortcuts are already installed", () => {
    const lines = progressOf(
      ceremony({
        shortcutProxies: () => ({ present: ["x"], missing: [], detail: "all installed" }),
      }),
    );
    const banner = lines.find((l) => l.startsWith("about to raise"));
    expect(banner).toContain("about to raise 2 dialogs");
    expect(banner).toContain("data access for Ghostty and app control of Things");
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

/** A wizard that answers the read-leg choice with `key`, recording what it saw. */
function chooser(key: string): {
  offered: string[];
  explained: string[];
  wizard: NonNullable<DirectSetupDeps["wizard"]>;
} {
  const offered: string[] = [];
  const explained: string[] = [];
  return {
    offered,
    explained,
    wizard: {
      interactive: true,
      explain: (lines: string[]) => explained.push(lines.join(" ")),
      ask: (_question: string, fallback: boolean) => fallback,
      choose: (lines: string[]) => {
        offered.push(lines.join("\n"));
        return key;
      },
    },
  };
}

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

  it("a settled leg is never offered the choice", () => {
    const { offered, wizard } = chooser("");
    directSetup(ceremony({ wizard, fdaProbe: () => {} }));
    expect(offered).toEqual([]);
  });

  it("offers exactly two ways, with the session grant on Enter", () => {
    const { offered, wizard } = chooser("");
    directSetup(ceremony({ wizard, openContainer: () => {} }));
    expect(offered).toHaveLength(1);
    const copy = offered[0] ?? "";
    expect(copy).toContain("Next: read access to your Things data — two ways:");
    expect(copy).toContain("Enter  allow while Ghostty runs");
    // APDP1: one Allow covers every process under the host app, and the copy
    // has to say so — the reach is the whole value of this tier.
    expect(copy).toContain("every command under");
    expect(copy).toContain("any tab, window, or agent it spawns");
    expect(copy).toContain("until Ghostty quits");
    expect(copy).toContain("f      Full Disk Access");
    expect(copy).toContain("Ghostty must quit and reopen");
    // No tmux here, so no tmux caveat.
    expect(copy).not.toContain("tmux");
  });

  it("names the tmux server's app when TMUX says the shell is inside one", () => {
    const { offered, wizard } = chooser("");
    const base = ceremony({ wizard, openContainer: () => {} });
    directSetup({ ...base, env: { ...base.env, TMUX: "/private/tmp/tmux-501/default,123,0" } });
    const copy = offered[0] ?? "";
    // Responsibility is fixed at spawn and survives re-parenting, so inside
    // tmux the grant belongs to the app that started the server.
    expect(copy).toContain("inside tmux the grant belongs to the app that started the tmux server");
    expect(copy).toContain("not the window you are attached from");
  });

  it("Enter provokes the session dialog now, and witnesses the grant it lands", () => {
    const { wizard } = chooser("");
    let opens = 0;
    const deps = ceremony({ wizard, openContainer: () => (opens += 1) });
    const result = directSetup(deps);
    const step = result.steps.find((s) => s.leg === "read-access");
    expect(opens, "the one deliberate container open").toBe(1);
    expect(step?.state).toBe("granted");
    // The marker is what makes the grant usable by the next invocation.
    expect(existsSync(join(deps.env?.["THINGS_API_STATE_DIR"] ?? "", "session-grant.json"))).toBe(
      true,
    );
    // The copy must be honest about how long it lasts — and state the reach it
    // actually has while it does (APDP1: the whole host-app instance).
    expect(step?.detail).toContain("until Ghostty quits");
    expect(step?.detail).toContain("every command running under Ghostty");
  });

  it("`f` deep-links Settings, waits for NOTHING, and goes pending on the relaunch", () => {
    const { wizard } = chooser("f");
    const opened: string[] = [];
    const result = directSetup(
      ceremony({
        wizard,
        openUrl: (url) => opened.push(url),
        // Choosing Full Disk Access must not provoke the app-data modal too.
        openContainer: forbidden("open the container"),
      }),
    );
    const step = result.steps.find((s) => s.leg === "read-access");
    expect(opened.some((u) => u.includes("Privacy_AllFiles"))).toBe(true);
    expect(step?.state).toBe("pending");
    expect(step?.detail).toContain("takes effect after Ghostty relaunches");
    expect(step?.detail).toContain("quit and reopen Ghostty");
  });

  it("`f` prints the three steps, and says the rest of the setup continues", () => {
    const { wizard } = chooser("f");
    const lines = progressOf(ceremony({ wizard, openContainer: forbidden("open the container") }));
    const read = lines.filter((l) => l.startsWith("read access:"));
    expect(read[0]).toContain("Privacy & Security ▸ Full Disk Access");
    expect(read[1]).toContain('"Quit & Reopen"');
    expect(read[2]).toContain("run `things setup` again");
    expect(read.join("\n")).toContain("the rest of the setup continues now");
    // No poll: the FDA probe is never re-read after the deep link, because a
    // running process cannot see the switch flip.
    expect(read.join("\n")).not.toMatch(/waiting|watch/i);
  });

  it("`f` still runs the remaining legs — those grants land in THIS session", () => {
    const { wizard } = chooser("f");
    let sent = 0;
    const sheets: string[] = [];
    const result = directSetup(
      ceremony({
        wizard,
        openContainer: forbidden("open the container"),
        sendAutomationProbe: () => (sent += 1),
        openShortcut: (f) => sheets.push(f),
      }),
    );
    expect(sent, "app control is still asked for").toBe(1);
    expect(sheets.length, "the install sheets still open").toBeGreaterThan(0);
    expect(result.steps.map((s) => s.leg)).toEqual([
      "read-access",
      "app-control",
      "shortcuts",
      "url-scheme",
    ]);
  });

  it("strict mode provokes the session dialog directly — no choice, no poll", () => {
    let opens = 0;
    const lines: string[] = [];
    // The REAL wizard, told there is no terminal.
    const result = directSetup(
      ceremony({
        wizard: createWizard({ interactive: false, say: (l) => lines.push(l) }),
        openContainer: () => (opens += 1),
      }),
    );
    expect(lines, "strict mode prints no choice").toEqual([]);
    expect(opens).toBe(1);
    expect(result.steps.find((s) => s.leg === "read-access")?.state).toBe("granted");
  });

  it("stays pending — never claims a grant — when the open is refused", () => {
    const result = directSetup(ceremony());
    const step = result.steps.find((s) => s.leg === "read-access");
    expect(step?.state).toBe("pending");
    // One line, naming the Full Disk Access alternative and the helpers.
    expect(step?.detail).toContain("Full Disk Access");
    expect(step?.detail).toContain("things helpers setup");
    expect(step?.detail.split("\n")).toHaveLength(1);
    // APDP1 stage B: a refusal is recorded against the host app INSTANCE, and
    // every later open under it fails silently — only a relaunch is asked again.
    expect(step?.detail).toContain("quit and reopen Ghostty");
  });

  // The provoking open runs in a bounded child (APDP1): the grant belongs to the
  // host app, not to the pid that asked, so the ceremony can give up on it.
  it("hands the seam a deadline — the default, and whatever the caller injects", () => {
    const seen: number[] = [];
    directSetup(ceremony({ openContainer: (ms) => seen.push(ms) }));
    expect(seen).toEqual([60_000]);
    directSetup(ceremony({ containerOpenTimeoutMs: 1234, openContainer: (ms) => seen.push(ms) }));
    expect(seen).toEqual([60_000, 1234]);
  });

  it("an unanswered dialog is reported as still waiting, not as a refusal", () => {
    const lines: string[] = [];
    const deps = ceremony({
      progress: (line) => lines.push(line),
      openContainer: (ms) => {
        throw new ContainerOpenTimedOut(ms);
      },
    });
    const result = directSetup(deps);
    const step = result.steps.find((s) => s.leg === "read-access");
    expect(step?.state).toBe("pending");
    expect(result.denied).toBe(false);
    // APDP1 stage A: the dialog outlives the child that provoked it, and a late
    // Allow still lands the grant — so the copy sends the human back to it.
    expect(step?.detail).toContain("the dialog is still waiting");
    expect(step?.detail).toContain("rerun `things setup`");
    expect(step?.detail.split("\n")).toHaveLength(1);
    expect(lines.some((l) => l.includes("the dialog is still on screen"))).toBe(true);
    // Nothing may be claimed: no marker survives a wait that decided nothing.
    expect(existsSync(join(deps.env?.["THINGS_API_STATE_DIR"] ?? "", "session-grant.json"))).toBe(
      false,
    );
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
    expect(result.steps.map((s) => s.leg)).toEqual([
      "read-access",
      "app-control",
      "shortcuts",
      "url-scheme",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/accessibility/i);
  });
});

/**
 * Leg (d) — Things' own "Enable Things URLs" (URLEN1, #611). The only leg that
 * raises nothing: it is an app setting, not a macOS grant, so there is no
 * dialog to provoke and nothing the ceremony can flip on the human's behalf. It
 * earns its place because the off state is otherwise silent — the app parks
 * every URL command in an alert on its own window rather than running it — and
 * a fresh install, which is exactly who runs this ceremony, has never answered
 * it.
 */
describe("leg (d) — Things' own URL authorization", () => {
  it("on → granted and already satisfied", () => {
    const result = directSetup(ceremony({ urlSchemeStanding: () => urlStanding("enabled") }));
    const leg = result.steps.find((s) => s.leg === "url-scheme");
    expect(leg?.state).toBe("granted");
    expect(leg?.alreadySatisfied).toBe(true);
  });

  it("off → pending, and the progress line names the exact Settings path", () => {
    const deps = ceremony({ urlSchemeStanding: () => urlStanding("disabled") });
    expect(progressOf(deps).join("\n")).toContain(
      "Things ▸ Settings ▸ General ▸ Enable Things URLs",
    );
    expect(
      directSetup(ceremony({ urlSchemeStanding: () => urlStanding("disabled") })).steps.find(
        (s) => s.leg === "url-scheme",
      )?.state,
    ).toBe("pending");
  });

  it("never-asked → pending too: a fresh install is the whole point of the leg", () => {
    const result = directSetup(ceremony({ urlSchemeStanding: () => urlStanding("never-asked") }));
    expect(result.steps.find((s) => s.leg === "url-scheme")?.state).toBe("pending");
    expect(result.pending).toBe(true);
  });

  it("unreadable → skipped: claiming the setting is unset would be a guess", () => {
    const result = directSetup(ceremony({ urlSchemeStanding: () => urlStanding("unreadable") }));
    expect(result.steps.find((s) => s.leg === "url-scheme")?.state).toBe("skipped");
  });

  it("it is NOT counted in the dialog banner — this leg raises nothing", () => {
    // `outstanding` means "dialogs about to appear". A Settings toggle is not
    // one, so a machine whose ONLY gap is this leg must still be told that
    // nothing is going to be raised.
    const settled: Partial<DirectSetupDeps> = {
      fdaProbe: () => {},
      automationAuthValue: () => 2,
      shortcutProxies: () => ({ present: ["x"], missing: [], detail: "all installed" }),
      urlSchemeStanding: () => urlStanding("disabled"),
    };
    const survey = surveySetup(ceremony(settled));
    expect(survey.outstanding).toEqual([]);
    expect(survey.urlScheme.mode).toBe("disabled");
    expect(progressOf(ceremony(settled)).join("\n")).toContain("nothing to raise");
  });

  it("its pending state still carries into the closing line, so a rerun is prompted", () => {
    const result = directSetup(
      ceremony({
        fdaProbe: () => {},
        automationAuthValue: () => 2,
        shortcutProxies: () => ({ present: ["x"], missing: [], detail: "all installed" }),
        urlSchemeStanding: () => urlStanding("never-asked"),
      }),
    );
    expect(result.closing).toContain("still outstanding");
    expect(result.closing).toContain("Things URLs");
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

/**
 * The TTY wizard on the DIRECT ceremony (Article V, mode-aware). Same machinery
 * as the helpers ceremony: one explainer per dialog that is actually coming,
 * a gate the human clears at their own pace, and nothing at all off a TTY.
 */
describe("the TTY wizard", () => {
  it("explains each dialog in the words macOS will use, naming the host app", () => {
    const { explained, offered, wizard } = chooser("");
    directSetup(ceremony({ wizard, openContainer: () => {} }));
    const all = [...offered, ...explained].join("\n");
    expect(all).toContain("Full Disk Access");
    expect(all).toContain('"Ghostty" wants access to control "Things"');
    expect(all).toContain("click Allow");
    expect(all).toContain('click "Add Shortcut"');
    // The host is named, never left as a placeholder.
    expect(all).not.toContain("{host}");
  });

  it("explains only the legs that are actually about to raise something", () => {
    const { explained, offered, wizard } = chooser("");
    directSetup(
      ceremony({
        wizard,
        // Read access and app control are already settled; only shortcuts remain.
        fdaProbe: () => {},
        automationAuthValue: () => 2,
      }),
    );
    expect(offered).toEqual([]);
    expect(explained).toHaveLength(1);
    expect(explained[0]).toContain("the bundled shortcuts");
  });

  it("says nothing off a TTY — strict mode is unchanged", () => {
    // The REAL wizard, told there is no terminal: the ceremony still offers it
    // every leg, and it prints nothing and reads nothing.
    const said: string[] = [];
    let reads = 0;
    directSetup(
      ceremony({
        wizard: createWizard({
          interactive: false,
          say: (line) => said.push(line),
          readLine: () => {
            reads += 1;
            return "";
          },
        }),
      }),
    );
    expect(said).toEqual([]);
    expect(reads).toBe(0);
  });

  it("stops the whole ceremony when the human stops at a gate", () => {
    // Ctrl-D at the read-leg choice: no further leg may run.
    let sent = 0;
    expect(() =>
      directSetup(
        ceremony({
          wizard: createWizard({ interactive: true, say: () => {}, readLine: () => null }),
          sendAutomationProbe: () => (sent += 1),
        }),
      ),
    ).toThrow(CeremonyStopped);
    expect(sent).toBe(0);
  });
});

/**
 * Nested parentheticals were how the banner came to read "…the Full Disk Access
 * switch (or a folder-access dialog), the app-control dialog…". Ceremony copy
 * states one thing per clause; a parenthesis inside a parenthesis is the tell.
 */
function nestedParens(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") {
      depth += 1;
      if (depth > 1) return true;
    } else if (ch === ")") depth = Math.max(0, depth - 1);
  }
  return false;
}

describe("ceremony copy is flat — no nested parentheticals", () => {
  it("holds for every line the default path prints", () => {
    const { explained, offered, wizard } = chooser("");
    const printed: string[] = [];
    directSetup({
      ...ceremony({ wizard, openContainer: () => {} }),
      progress: (line) => printed.push(line),
    });
    for (const line of [...printed, ...offered, ...explained]) {
      expect(nestedParens(line), `nested parens in: ${line}`).toBe(false);
    }
  });

  it("holds for the Full Disk Access branch and for a fully settled machine", () => {
    const { explained, offered, wizard } = chooser("f");
    const printed: string[] = [];
    directSetup({
      ...ceremony({ wizard, openContainer: forbidden("open the container") }),
      progress: (line) => printed.push(line),
    });
    const settled: string[] = [];
    directSetup({
      ...ceremony({
        fdaProbe: () => {},
        automationAuthValue: () => 2,
        shortcutProxies: () => ({ present: ["x"], missing: [], detail: "all installed" }),
      }),
      progress: (line) => settled.push(line),
    });
    for (const line of [...printed, ...offered, ...explained, ...settled]) {
      expect(nestedParens(line), `nested parens in: ${line}`).toBe(false);
    }
  });
});
