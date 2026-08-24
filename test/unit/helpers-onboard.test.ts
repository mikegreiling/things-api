/**
 * The onboarding ceremony behind `things helpers setup`, driven against a
 * stubbed deputy channel. The properties that matter are behavioral, not
 * cosmetic:
 *
 *  - IDEMPOTENCE — a fully granted machine raises NOTHING. Every already-done
 *    leg is recognized from the deputy's prompt-free handshake and skipped, so
 *    rerunning the ceremony is a safe all-green no-op.
 *  - AN HONEST UPFRONT COUNT — before the first dialog goes up, the ceremony
 *    says how many are coming, sized from the prompt-free state.
 *  - HUMAN PACE, BUT VISIBLE — an unanswered dialog or an unflipped switch is
 *    `pending`, never a crash; the run is still an UNFINISHED setup, which is
 *    what the caller's nonzero exit is built on (test/cli/helpers-cli.test.ts).
 *  - OLD HELPERS — a deputy predating the TCC fields in `hello` must not be
 *    guessed about: absent means unknown, the legs are attempted, and the
 *    version-drift upgrade note is surfaced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type HelpersOnboardResult,
  type OnboardChannel,
  type OnboardDeps,
  type OnboardLeg,
  type OnboardState,
  onboardHelpers,
} from "../../src/index.ts";
import { EXPECTED_HELPERS_VERSION, readerInstalledAppPath } from "../../src/deputy/protocol.ts";

let stateDir: string;
const savedEnv: Record<string, string | undefined> = {};
let progress: string[];
let opened: string[];

/** Every request the stub saw, so "nothing was raised" is assertable. */
let requests: Record<string, unknown>[];

interface StubOptions {
  hello?: Record<string, unknown>;
  /** Per-verb canned answers; a function may vary by call. */
  osascript?: (script: string) => Record<string, unknown>;
  primeAx?: () => Record<string, unknown>;
  shortcutsStdout?: string;
  /** hello answers after the Nth call flip axTrusted to true. */
  axTrustedAfterCalls?: number;
}

const ALL_PROXIES = [
  "things-proxy-find-items",
  "things-proxy-create-heading",
  "things-proxy-edit-title",
  "things-proxy-set-detail",
  "things-proxy-delete-items",
  "things-proxy-delete-items-permanently",
].join("\n");

function stubChannel(options: StubOptions = {}): OnboardChannel {
  let helloCalls = 0;
  return {
    hello() {
      helloCalls += 1;
      const base = {
        protocol: 1,
        deputyVersion: EXPECTED_HELPERS_VERSION,
        pid: 111,
        uptimeMs: 1,
        ...options.hello,
      };
      if (options.axTrustedAfterCalls !== undefined && helloCalls > options.axTrustedAfterCalls) {
        return { ...base, axTrusted: true } as never;
      }
      return base as never;
    },
    request(fields) {
      requests.push(fields);
      switch (fields["verb"]) {
        case "osascript":
          return (
            options.osascript?.(String(fields["script"])) ?? {
              ok: true,
              exitCode: 0,
              stdout: "",
              stderr: "",
            }
          );
        case "prime-ax":
          return options.primeAx?.() ?? { ok: true, axTrusted: false };
        case "shortcuts":
          return {
            ok: true,
            exitCode: 0,
            stdout: options.shortcutsStdout ?? ALL_PROXIES,
            stderr: "",
          };
        default:
          throw new Error(`unexpected verb ${String(fields["verb"])}`);
      }
    },
    close() {},
  };
}

/** Reader installed in the fake bundle, so its leg is exercised rather than skipped. */
function installReader(): void {
  mkdirSync(join(readerInstalledAppPath(process.env), "Contents/MacOS"), { recursive: true });
}

function run(channel: OnboardChannel, deps: Partial<OnboardDeps> = {}): HelpersOnboardResult {
  return onboardHelpers("auto", process.env, {
    channel,
    progress: (line) => progress.push(line),
    openUrl: (url) => opened.push(url),
    sleep: () => {},
    readerProbe: () => ({ granted: true, locates: true }),
    grant: () => ({ granted: true, detail: "granted" }),
    axTimeoutMs: 20,
    axIntervalMs: 5,
    automationTimeoutMs: 1000,
    deputyWaitMs: 0,
    ...deps,
  });
}

function stateOf(result: HelpersOnboardResult, leg: OnboardLeg): OnboardState {
  const step = result.steps.find((s) => s.leg === leg);
  if (step === undefined) throw new Error(`no step for ${leg}`);
  return step.state;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "onboard-"));
  for (const key of ["THINGS_API_STATE_DIR", "THINGS_API_READER_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_READER_DIR"] = join(stateDir, "reader");
  progress = [];
  opened = [];
  requests = [];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("onboarding preflight", () => {
  it("refuses when the helpers are not installed and names the install command", () => {
    expect(() => onboardHelpers("auto", process.env, { progress: () => {} })).toThrow(
      /not installed — run `things helpers setup`/,
    );
  });

  it("refuses when the deputy is installed but does not answer", () => {
    mkdirSync(join(stateDir, "deputy/bin/Things API Helper.app/Contents/MacOS"), {
      recursive: true,
    });
    writeFileSync(
      join(stateDir, "deputy/bin/Things API Helper.app/Contents/MacOS/things-deputy"),
      "#!/bin/sh\n",
    );
    expect(() =>
      onboardHelpers("auto", process.env, { progress: () => {}, deputyWaitMs: 0 }),
    ).toThrow(/not running \(no socket/);
  });
});

describe("an already-onboarded machine", () => {
  it("skips every leg, raises nothing, and reports done", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: {
          axTrusted: true,
          automation: { things: "granted", systemEvents: "granted" },
        },
      }),
    );
    expect(result.steps.every((s) => s.state === "granted")).toBe(true);
    expect(result.denied).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.closing).toContain("you're done");
    // The ONLY request a green rerun may make is the shortcuts census: no
    // osascript, no prime-ax, nothing that could put a dialog on screen.
    expect(requests.map((r) => r["verb"])).toEqual(["shortcuts"]);
    expect(opened).toEqual([]);
    expect(result.steps.filter((s) => s.alreadyGranted)).toHaveLength(result.steps.length);
  });

  it("skips the reader panel when the grant already resolves a database", () => {
    installReader();
    let panelOpened = false;
    run(
      stubChannel({
        hello: { axTrusted: true, automation: { things: "granted", systemEvents: "granted" } },
      }),
      {
        grant: () => {
          panelOpened = true;
          return { granted: true, detail: "granted" };
        },
      },
    );
    expect(panelOpened).toBe(false);
  });
});

describe("the upfront banner", () => {
  it("counts and names every dialog before raising the first one", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: false, automation: { things: "unknown", systemEvents: "granted" } },
      }),
      { readerProbe: () => ({ granted: false, locates: false }) },
    );
    expect(result.outstanding).toEqual(["reader-read-grant", "automation-things", "accessibility"]);
    const banner = progress[0] ?? "";
    expect(banner).toContain("about to raise 3 macOS consent dialogs");
    expect(banner).toContain("the reader's folder panel");
    expect(banner).toContain("app control for Things");
    expect(banner).toContain("the Accessibility switch");
    expect(banner).toContain("someone must be at the screen");
    // It is the FIRST thing said — nothing may go on screen before the warning.
    expect(progress.indexOf(banner)).toBe(0);
  });

  it("says so, singular, when only one dialog is coming", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: true, automation: { things: "unknown", systemEvents: "granted" } },
      }),
    );
    expect(result.outstanding).toEqual(["automation-things"]);
    expect(progress[0]).toContain("about to raise 1 macOS consent dialog (app control for Things)");
  });

  it("does not count a DENIED leg — its dialog is spent and will not reappear", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: true, automation: { things: "denied", systemEvents: "granted" } },
      }),
    );
    expect(result.outstanding).toEqual([]);
    expect(progress[0]).toContain("nothing to raise");
  });

  it("says nothing is coming on a fully onboarded machine", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: true, automation: { things: "granted", systemEvents: "granted" } },
      }),
    );
    expect(result.outstanding).toEqual([]);
    expect(progress[0]).toContain("nothing to raise — every permission the helpers need");
  });
});

describe("automation legs", () => {
  it("sends a benign event per target and records the grant", () => {
    installReader();
    const result = run(stubChannel({ hello: { axTrusted: true } }));
    const scripts = requests.filter((r) => r["verb"] === "osascript").map((r) => r["script"]);
    // Both probes must dispatch a REAL Apple event: `version`/`name`/`id`/
    // `running` are answered locally by the AppleScript runtime — exit 0,
    // no dialog, no grant (the v1.2.0 ceremony shipped that false positive).
    expect(scripts).toEqual([
      'tell application "Things3" to count of areas',
      'tell application "System Events" to name of first process',
    ]);
    expect(stateOf(result, "automation-things")).toBe("granted");
    expect(stateOf(result, "automation-system-events")).toBe("granted");
  });

  it("re-reads AEDeterminePermission after the probe and reports the flip, not the exit code", () => {
    installReader();
    let helloCount = 0;
    const inner = stubChannel({ hello: { axTrusted: true } });
    const channel: OnboardChannel = {
      hello() {
        helloCount += 1;
        const base = inner.hello() as unknown as Record<string, unknown>;
        // Before the probe: unknown. After: granted — the leg must read the flip.
        return {
          ...base,
          automation: { things: helloCount > 1 ? "granted" : "unknown", systemEvents: "granted" },
        } as never;
      },
      request: (fields, timeoutMs) => inner.request(fields, timeoutMs),
      close: () => inner.close(),
    };
    const result = run(channel);
    expect(stateOf(result, "automation-things")).toBe("granted");
    expect(requests.filter((r) => r["verb"] === "osascript")).toHaveLength(1);
  });

  it("marks the leg pending when the probe exits 0 yet macOS still reports no grant", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: true, automation: { things: "unknown", systemEvents: "granted" } },
      }),
    );
    expect(stateOf(result, "automation-things")).toBe("pending");
    const step = result.steps.find((s) => s.leg === "automation-things");
    expect(step?.detail).toContain("AEDeterminePermission");
    expect(result.pending).toBe(true);
  });

  it("reads -1743 as denied and names the Automation remediation", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: true },
        osascript: (script) =>
          script.includes("Things3")
            ? {
                ok: true,
                exitCode: 1,
                stdout: "",
                stderr: "execution error: Not authorized to send Apple events to Things3. (-1743)",
              }
            : { ok: true, exitCode: 0, stdout: "", stderr: "" },
      }),
    );
    expect(stateOf(result, "automation-things")).toBe("denied");
    expect(result.denied).toBe(true);
    const step = result.steps.find((s) => s.leg === "automation-things");
    // BOTH ways out, always named together — the Settings switch and re-arming
    // the dialog. The ceremony never clears a denial itself.
    expect(step?.detail).toContain("Privacy & Security ▸ Automation ▸ Things3");
    expect(step?.detail).toContain("tccutil reset AppleEvents com.pixelcog.things-api-helper");
    expect(result.closing).toContain("System Settings");
    expect(result.closing).toContain("tccutil reset AppleEvents com.pixelcog.things-api-helper");
    expect(result.closing).toContain("setup did not finish");
  });

  it("leaves an unanswered dialog pending, not failed", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: true },
        osascript: () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: true }),
      }),
    );
    expect(stateOf(result, "automation-things")).toBe("pending");
    expect(result.denied).toBe(false);
    expect(result.pending).toBe(true);
    // Human pace, but an UNFINISHED setup: the closing says so, and names
    // where rerunning picks up.
    expect(result.closing).toContain("setup did not finish");
    expect(result.closing).toContain("Rerun `things helpers setup` to resume exactly there");
  });

  it("does not re-ask a target the handshake already reports denied", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: {
          axTrusted: true,
          automation: { things: "denied", systemEvents: "granted" },
        },
      }),
    );
    expect(requests.filter((r) => r["verb"] === "osascript")).toHaveLength(0);
    expect(stateOf(result, "automation-things")).toBe("denied");
  });

  it("asks a target macOS reports as not-running (the event launches it)", () => {
    installReader();
    run(
      stubChannel({
        hello: {
          axTrusted: true,
          automation: { things: "granted", systemEvents: "not-running" },
        },
      }),
    );
    const scripts = requests.filter((r) => r["verb"] === "osascript").map((r) => r["script"]);
    expect(scripts).toEqual(['tell application "System Events" to name of first process']);
  });
});

describe("the accessibility leg", () => {
  it("primes the prompt, opens Settings, and lands granted when the switch flips", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { automation: { things: "granted", systemEvents: "granted" } },
        axTrustedAfterCalls: 1,
      }),
    );
    expect(requests.some((r) => r["verb"] === "prime-ax")).toBe(true);
    expect(opened[0]).toContain("Privacy_Accessibility");
    expect(stateOf(result, "accessibility")).toBe("granted");
  });

  it("times out as pending with a patient instruction, never as a failure", () => {
    installReader();
    const result = run(
      stubChannel({ hello: { automation: { things: "granted", systemEvents: "granted" } } }),
    );
    expect(stateOf(result, "accessibility")).toBe("pending");
    expect(result.denied).toBe(false);
    expect(progress.join("\n")).toContain("Ctrl-C and rerun anytime");
  });
});

describe("the shortcuts leg", () => {
  it("reports the missing proxies and points at setup without running it", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { axTrusted: true, automation: { things: "granted", systemEvents: "granted" } },
        shortcutsStdout: "things-proxy-find-items\nSome Unrelated Shortcut\n",
      }),
    );
    const step = result.steps.find((s) => s.leg === "shortcuts");
    expect(step?.state).toBe("skipped-not-installed");
    expect(step?.detail).toContain("things-proxy-set-detail");
    expect(step?.detail).toContain("things setup");
    // Missing shortcuts are not a denial — the other paths still work.
    expect(result.denied).toBe(false);
    expect(result.closing).toContain("you're done");
    expect(result.closing).toContain("things setup");
  });
});

describe("a reader that is not part of the bundle", () => {
  it("is skipped as not installed rather than counted against the run", () => {
    const result = run(
      stubChannel({
        hello: { axTrusted: true, automation: { things: "granted", systemEvents: "granted" } },
      }),
    );
    const step = result.steps.find((s) => s.leg === "reader-read-grant");
    expect(step?.state).toBe("skipped-not-installed");
    expect(result.denied).toBe(false);
  });
});

describe("helpers older than the ceremony", () => {
  it("treats absent TCC fields as unknown, attempts the legs, and flags the upgrade", () => {
    installReader();
    const result = run(
      stubChannel({
        hello: { deputyVersion: "1.1.0" },
        primeAx: () => {
          throw new Error("unknown verb prime-ax");
        },
      }),
    );
    expect(progress.join("\n")).toContain("this package expects v");
    expect(progress.join("\n")).toContain("things helpers setup");
    // Absent ⇒ unknown ⇒ ask: both automation legs were attempted.
    expect(requests.filter((r) => r["verb"] === "osascript")).toHaveLength(2);
    expect(stateOf(result, "accessibility")).toBe("pending");
    expect(result.denied).toBe(false);
  });
});

describe("routing that is switched off", () => {
  it("closes by naming the config switch instead of claiming everything is wired", () => {
    installReader();
    const result = onboardHelpers("false", process.env, {
      channel: stubChannel({
        hello: { axTrusted: true, automation: { things: "granted", systemEvents: "granted" } },
      }),
      progress: () => {},
      readerProbe: () => ({ granted: true, locates: true }),
      grant: () => ({ granted: true, detail: "granted" }),
      deputyWaitMs: 0,
    });
    expect(result.closing).toContain("helpers-enabled auto");
  });
});
