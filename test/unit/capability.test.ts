/**
 * The prompt-free capability verdicts (docs/design/permissions-doctrine.md,
 * Articles I–III).
 *
 * Every probe is injected. No cell here may touch the host's TCC state, open
 * the real container, or run `lsappinfo` — the whole point of the module is
 * that it can be reasoned about without consent, and the tests hold that line.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  hostApp,
  readAllowed,
  readCapability,
  ReadCapabilityError,
  resetCapabilityForTests,
  uiAllowed,
  uiCapability,
  UI_DIRECT_ESCAPE_ENV,
  writeCapability,
  type CapabilityDeps,
} from "../../src/capability.ts";

/** A machine with nothing: no helpers, no FDA, no witnessed grant. */
function bareMachine(over: Partial<CapabilityDeps> = {}): CapabilityDeps {
  return {
    env: { __CFBundleIdentifier: "com.mitchellh.ghostty", HOME: "/nonexistent" },
    fdaProbe: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    helpersServing: () => false,
    helpersExpected: () => false,
    deputyAutomation: () => undefined,
    automationAuthValue: () => null,
    lookupAppName: () => null,
    hostPid: () => null,
    processStart: () => null,
    bootTime: () => 1000,
    ...over,
  };
}

beforeEach(() => {
  resetCapabilityForTests();
});

describe("host identity", () => {
  it("names a known terminal from its bundle id, without a subprocess", () => {
    const host = hostApp({
      env: { __CFBundleIdentifier: "com.mitchellh.ghostty" },
      lookupAppName: () => {
        throw new Error("must not shell out for a known host");
      },
    });
    expect(host).toEqual({ bundleId: "com.mitchellh.ghostty", name: "Ghostty" });
  });

  it("falls back to TERM_PROGRAM when no bundle id is exported", () => {
    expect(hostApp({ env: { TERM_PROGRAM: "Apple_Terminal" } })).toEqual({
      bundleId: null,
      name: "Terminal",
    });
  });

  it("never guesses: an unidentifiable host is 'this terminal'", () => {
    expect(hostApp({ env: {} })).toEqual({ bundleId: null, name: "this terminal" });
  });
});

describe("readCapability — Article VI takes precedence over everything", () => {
  it("an explicit dbPath bypasses the gate entirely, with no consent vocabulary", () => {
    const cap = readCapability({ dbPath: "/tmp/copy.sqlite" }, bareMachine());
    expect(cap.mode).toBe("explicit-db");
    expect(readAllowed(cap)).toBe(true);
    expect(cap.remediation).toEqual([]);
    expect(cap.detail).not.toMatch(/Full Disk Access|helpers|grant/i);
  });

  it("THINGS_DB is the same bypass", () => {
    const deps = bareMachine();
    const cap = readCapability(
      {},
      { ...deps, env: { ...deps.env, THINGS_DB: "/tmp/other.sqlite" } },
    );
    expect(cap.mode).toBe("explicit-db");
  });

  it("the bypass is decided per CALL, not per machine — it never leaks to the next read", () => {
    const deps = bareMachine();
    expect(readCapability({ dbPath: "/tmp/x.sqlite" }, deps).mode).toBe("explicit-db");
    expect(readCapability({}, deps).mode).toBe("none");
  });
});

describe("readCapability — the helpers are ground truth, not a stored flag", () => {
  it("a serving reader needs no probe: the read itself is the check", () => {
    const cap = readCapability(
      {},
      bareMachine({
        helpersServing: () => true,
        fdaProbe: () => {
          throw new Error("the helpers path must not probe FDA");
        },
      }),
    );
    expect(cap.mode).toBe("helpers");
    expect(readAllowed(cap)).toBe(true);
  });

  it("helpers expected but not serving REFUSES — never a silent fall-through to direct", () => {
    const cap = readCapability(
      {},
      bareMachine({
        helpersExpected: () => true,
        helpersReason: () => "the reader is running but holds no read grant",
        // Even a machine that COULD read directly must not be downgraded.
        fdaProbe: () => undefined,
      }),
    );
    expect(cap.mode).toBe("helpers-unavailable");
    expect(readAllowed(cap)).toBe(false);
    expect(cap.remediation.join(" ")).toContain("things helpers setup");
    expect(cap.detail).toContain("holds no read grant");
  });

  it("a grant-less host is asked the helpers question all the same — nothing gates it", () => {
    // Before helpers 1.3.0 the rendezvous sat in the reader's sandbox
    // container, so on a host with no durable file access the chain had to
    // SKIP "are the helpers expected?" — asking it meant statting another
    // app's container, which is the "access data from other apps" dialog. The
    // rendezvous is ours now, so the question is always safe to ask, and a
    // machine that expects the helpers is refused loudly rather than falling
    // through to a direct verdict it never asked for.
    const cap = readCapability({}, bareMachine({ helpersExpected: () => true }));
    expect(cap.mode).toBe("helpers-unavailable");
    expect(cap.remediation.join(" | ")).toContain("things helpers setup");
  });

  it("a grant-less host with no helpers lands on the ordinary refusal", () => {
    const cap = readCapability({}, bareMachine());
    expect(cap.mode).toBe("none");
    expect(cap.detail).not.toContain("cannot be reached from this host");
    expect(cap.remediation.join(" | ")).toContain("things helpers setup");
  });

  it("helpers absent under auto is an ordinary direct machine, not a fault", () => {
    const cap = readCapability(
      {},
      bareMachine({ helpersExpected: () => false, fdaProbe: () => undefined }),
    );
    expect(cap.mode).toBe("direct-fda");
  });
});

describe("readCapability — the direct tiers", () => {
  it("a successful TCC.db open means Full Disk Access", () => {
    const cap = readCapability({}, bareMachine({ fdaProbe: () => undefined }));
    expect(cap.mode).toBe("direct-fda");
    expect(cap.detail).toContain("Ghostty");
    expect(cap.remediation).toEqual([]);
  });

  it("EPERM is the ordinary silent no — and is not reported as an anomaly", () => {
    const cap = readCapability({}, bareMachine());
    expect(cap.mode).toBe("none");
    expect(cap.detail).not.toContain("EPERM");
  });

  it("an unexpected errno is reported honestly rather than folded into the no", () => {
    const cap = readCapability(
      {},
      bareMachine({
        fdaProbe: () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      }),
    );
    expect(cap.mode).toBe("none");
    expect(cap.detail).toContain("EIO");
  });

  it("a live witnessed session grant is accepted when FDA says no", () => {
    const cap = readCapability(
      {},
      bareMachine({
        env: {
          __CFBundleIdentifier: "com.mitchellh.ghostty",
          THINGS_API_STATE_DIR: sessionFixture(),
        },
        hostPid: () => 4242,
        processStart: () => "Thu Jul 16 00:29:43 2026",
        bootTime: () => 1_784_187_814,
      }),
    );
    expect(cap.mode).toBe("session-grant");
    expect(readAllowed(cap)).toBe(true);
    // The copy must not imply durability — the grant dies with the app.
    expect(cap.detail).toContain("as long as it stays open");
  });

  it("refusing names the host app and offers BOTH provenances", () => {
    const cap = readCapability({}, bareMachine());
    expect(cap.mode).toBe("none");
    expect(cap.detail).toContain("Ghostty");
    const remediation = cap.remediation.join(" | ");
    expect(remediation).toContain("things helpers setup");
    expect(remediation).toContain("Full Disk Access");
    expect(remediation).toContain("things setup");
  });

  it("the verdict is re-derived every call — no cached yes, no cached no", () => {
    let granted = false;
    const deps = bareMachine({
      fdaProbe: () => {
        if (!granted) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    expect(readCapability({}, deps).mode).toBe("none");
    granted = true;
    expect(readCapability({}, deps).mode).toBe("direct-fda");
    granted = false;
    expect(readCapability({}, deps).mode).toBe("none");
  });
});

describe("ReadCapabilityError", () => {
  it("carries the remediation list alongside a human message", () => {
    const cap = readCapability({}, bareMachine());
    const err = new ReadCapabilityError(cap);
    expect(err.name).toBe("ReadCapabilityError");
    expect(err.remediation).toEqual(cap.remediation);
    expect(err.message).toContain("Ghostty");
  });
});

describe("writeCapability", () => {
  it("an onboarded deputy wins, and the host's own record is never consulted", () => {
    const cap = writeCapability(
      bareMachine({
        deputyAutomation: () => "granted",
        automationAuthValue: () => {
          throw new Error("must not read TCC when the deputy is onboarded");
        },
      }),
    );
    expect(cap.mode).toBe("deputy");
  });

  it("auth_value 2 is a grant for the host app", () => {
    const cap = writeCapability(bareMachine({ automationAuthValue: () => 2 }));
    expect(cap.mode).toBe("direct-granted");
    expect(cap.detail).toContain("com.mitchellh.ghostty");
  });

  it("auth_value 0 is a refusal macOS will not re-ask — copy names the toggle AND the re-arm", () => {
    const cap = writeCapability(bareMachine({ automationAuthValue: () => 0 }));
    expect(cap.mode).toBe("direct-denied");
    const remediation = cap.remediation.join(" | ");
    expect(remediation).toContain("System Settings");
    expect(remediation).toContain("tccutil reset AppleEvents com.mitchellh.ghostty");
  });

  it("no row at all is 'unknown' and points at the ceremony — never at a retry", () => {
    const cap = writeCapability(bareMachine({ automationAuthValue: () => null }));
    expect(cap.mode).toBe("direct-unknown");
    expect(cap.remediation.join(" ")).toContain("things setup");
  });

  it("a process with no application identity cannot hold a direct grant at all", () => {
    const cap = writeCapability(bareMachine({ env: {} }));
    expect(cap.mode).toBe("direct-unknown");
    expect(cap.detail).toContain("does not descend from an application bundle");
    expect(cap.remediation.join(" ")).toContain("things helpers setup");
  });
});

// ── fixture helper ───────────────────────────────────────────────────────────

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A state dir holding a marker for pid 4242 of Ghostty. */
function sessionFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "things-session-"));
  writeFileSync(
    join(dir, "session-grant.json"),
    JSON.stringify({
      hostBundleId: "com.mitchellh.ghostty",
      hostPid: 4242,
      hostStart: "Thu Jul 16 00:29:43 2026",
      bootTime: 1_784_187_814,
      witnessedAt: "2026-08-24T12:00:00.000Z",
    }),
  );
  return dir;
}

/**
 * THE UI VERDICT (Article IV). GUI-driving has exactly one supported
 * provenance: the helper pair. Every answer below is prompt-free — a config
 * read plus the deputy's own handshake — and no cell may consult this host.
 */
describe("uiCapability", () => {
  /** A machine with the config on and a deputy answering whatever is asked. */
  function guiDeps(over: Partial<CapabilityDeps> = {}): CapabilityDeps {
    return {
      ...bareMachine(),
      uiEnabled: () => true,
      deputyGuiStanding: () => ({ axTrusted: true, systemEvents: "granted" }),
      ...over,
    };
  }

  it("is off, and says which knob, when ui-enabled is false", () => {
    const verdict = uiCapability(guiDeps({ uiEnabled: () => false }));
    expect(verdict.mode).toBe("config-disabled");
    expect(uiAllowed(verdict)).toBe(false);
    expect(verdict.remediation.join(" ")).toContain("things config set ui-enabled true");
    expect(verdict.remediation.join(" ")).toContain("things helpers setup --gui");
  });

  it("is granted when the deputy holds Accessibility and System Events", () => {
    const verdict = uiCapability(guiDeps());
    expect(verdict.mode).toBe("helpers");
    expect(uiAllowed(verdict)).toBe(true);
    expect(verdict.remediation).toEqual([]);
  });

  it("names the missing halves of a half-granted tier", () => {
    const verdict = uiCapability(
      guiDeps({ deputyGuiStanding: () => ({ axTrusted: false, systemEvents: "unknown" }) }),
    );
    expect(verdict.mode).toBe("tier-incomplete");
    expect(verdict.detail).toContain("Accessibility");
    expect(verdict.detail).toContain("automation → System Events (unknown)");
    expect(verdict.remediation.join(" ")).toContain("things helpers setup --gui");
  });

  it("says the helpers are absent rather than offering direct Accessibility", () => {
    const verdict = uiCapability(guiDeps({ deputyGuiStanding: () => null }));
    expect(verdict.mode).toBe("helpers-missing");
    expect(uiAllowed(verdict)).toBe(false);
    // Article IV: direct AX is unsupported, so no remediation may point at it.
    expect(verdict.remediation.join(" ")).not.toContain("Accessibility");
  });

  it("treats a pre-handshake helper's absent axTrusted as unknown, never as granted", () => {
    const verdict = uiCapability(
      guiDeps({ deputyGuiStanding: () => ({ axTrusted: undefined, systemEvents: "granted" }) }),
    );
    expect(verdict.mode).toBe("tier-incomplete");
    expect(verdict.detail).toContain("rebuild");
  });

  it("honors the lab's documented escape — and only when ui-enabled is also on", () => {
    const escape = { [UI_DIRECT_ESCAPE_ENV]: "1" };
    const granted = uiCapability(
      guiDeps({
        env: escape,
        // The escape must not need a deputy at all: a golden clone has none.
        deputyGuiStanding: () => null,
      }),
    );
    expect(granted.mode).toBe("direct-escape");
    expect(uiAllowed(granted)).toBe(true);
    // It is not a config bypass: `ui-enabled` still gates first.
    const off = uiCapability(guiDeps({ env: escape, uiEnabled: () => false }));
    expect(off.mode).toBe("config-disabled");
  });
});
