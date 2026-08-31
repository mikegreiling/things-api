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
  directContainerAccessAllowed,
  hostApp,
  readAllowed,
  readCapability,
  ReadCapabilityError,
  resetCapabilityForTests,
  uiAllowed,
  uiCapability,
  UI_DIRECT_ESCAPE_ENV,
  writeAllowed,
  writeCapability,
  WRITE_DIRECT_ESCAPE_ENV,
  type CapabilityDeps,
} from "../../src/capability.ts";
import type { TargetWake } from "../../src/deputy/wake.ts";

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

/** A wake that came back with `standing`, shaped like the real primitive's answer. */
const woken =
  (standing: string | undefined): (() => TargetWake) =>
  () =>
    ({ standing, detail: "started on demand" }) as TargetWake;

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

/** A bare verdict of one mode — every other field is irrelevant to the predicate. */
function verdictOfMode(mode: string) {
  return { mode, detail: "", remediation: [], host: { bundleId: null, name: "x" } } as never;
}

describe("directContainerAccessAllowed — whose syscall is it, anyway (#664)", () => {
  it("admits only the standings that cover THIS process's own file syscalls", () => {
    expect(directContainerAccessAllowed(verdictOfMode("direct-fda"))).toBe(true);
    expect(directContainerAccessAllowed(verdictOfMode("session-grant"))).toBe(true);
    expect(directContainerAccessAllowed(verdictOfMode("explicit-db"))).toBe(true);
  });

  it("REFUSES `helpers` — the reader holds the grant, and the reader is not us", () => {
    // The whole bug class of #664 in one assertion. `readAllowed` says yes here
    // and is right to: a read IS authorized, through the reader's bookmark. But
    // a `stat` or an `open` issued by THIS process still crosses into another
    // app's container on its own lineage, and on a host app without Full Disk
    // Access that is a modal — with the syscall parked behind it.
    const helpers = verdictOfMode("helpers");
    expect(readAllowed(helpers)).toBe(true);
    expect(directContainerAccessAllowed(helpers)).toBe(false);
  });

  it("refuses the two standings that authorize nothing at all", () => {
    expect(directContainerAccessAllowed(verdictOfMode("none"))).toBe(false);
    expect(directContainerAccessAllowed(verdictOfMode("helpers-unavailable"))).toBe(false);
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
    // The copy must not imply durability — the grant dies with the app — and it
    // must state the reach the grant really has (APDP1: every process under the
    // host app instance, not just this one command).
    expect(cap.detail).toContain("until Ghostty quits");
    expect(cap.detail).toContain("every command running under Ghostty");
  });

  it("refusing names the host app and offers BOTH provenances", () => {
    const cap = readCapability({}, bareMachine());
    expect(cap.mode).toBe("none");
    expect(cap.detail).toContain("Ghostty");
    const remediation = cap.remediation.join(" | ");
    expect(remediation).toContain("things helpers setup");
    expect(remediation).toContain("Full Disk Access");
    expect(remediation).toContain("things setup");
    // APDP1 stage B: a refusal is silent for the rest of that app's run, so the
    // relaunch is named — hedged, because a refusal and "never asked" look the
    // same from here and the copy may not accuse the user of either.
    expect(remediation).toContain("quit and reopen Ghostty");
    expect(remediation).toContain("if that dialog was already refused");
    expect(remediation).not.toMatch(/you (denied|refused)/i);
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
      {},
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
    const cap = writeCapability({}, bareMachine({ automationAuthValue: () => 2 }));
    expect(cap.mode).toBe("direct-granted");
    expect(cap.detail).toContain("com.mitchellh.ghostty");
  });

  it("auth_value 0 is a refusal macOS will not re-ask — copy names the toggle AND the re-arm", () => {
    const cap = writeCapability({}, bareMachine({ automationAuthValue: () => 0 }));
    expect(cap.mode).toBe("direct-denied");
    const remediation = cap.remediation.join(" | ");
    expect(remediation).toContain("System Settings");
    expect(remediation).toContain("tccutil reset AppleEvents com.mitchellh.ghostty");
  });

  it("no row at all is 'unknown' and points at the ceremony — never at a retry", () => {
    const cap = writeCapability({}, bareMachine({ automationAuthValue: () => null }));
    expect(cap.mode).toBe("direct-unknown");
    expect(cap.remediation.join(" ")).toContain("things setup");
  });

  it("a process with no application identity cannot hold a direct grant at all", () => {
    const cap = writeCapability({}, bareMachine({ env: {} }));
    expect(cap.mode).toBe("direct-unknown");
    expect(cap.detail).toContain("does not descend from an application bundle");
    expect(cap.remediation.join(" ")).toContain("things helpers setup");
  });

  /**
   * The lab's write-vector escape (docs/lab/harness.md §The lab escapes). A
   * guest shell has no bundle id, so the verdict there is UNKNOWABLE rather
   * than absent — the escape says which, and it may say it nowhere else.
   */
  describe("the lab's write-vector escape", () => {
    const escape = { [WRITE_DIRECT_ESCAPE_ENV]: "1" };

    it("resolves the bundle-id-less unknown, and needs no deputy", () => {
      const cap = writeCapability(
        {},
        bareMachine({ env: escape, deputyAutomation: () => undefined }),
      );
      expect(cap.mode).toBe("direct-escape");
      expect(writeAllowed(cap)).toBe(true);
      expect(cap.detail).toContain(WRITE_DIRECT_ESCAPE_ENV);
      expect(cap.remediation).toEqual([]);
    });

    it("is not consulted at all when the host HAS an identity", () => {
      // The bound that keeps it out of a real user's way: a host with a bundle
      // id is answered from its TCC row, escape or no escape — so the escape
      // can never mask a recorded refusal or invent a grant.
      const denied = writeCapability(
        {},
        bareMachine({
          env: { ...escape, __CFBundleIdentifier: "com.mitchellh.ghostty" },
          automationAuthValue: () => 0,
        }),
      );
      expect(denied.mode).toBe("direct-denied");
      expect(writeAllowed(denied)).toBe(false);
      const unknown = writeCapability(
        {},
        bareMachine({
          env: { ...escape, __CFBundleIdentifier: "com.mitchellh.ghostty" },
          automationAuthValue: () => null,
        }),
      );
      expect(unknown.mode).toBe("direct-unknown");
      expect(writeAllowed(unknown)).toBe(false);
    });

    it("answers to the literal 1 and to nothing else", () => {
      for (const value of ["", "0", "true", "yes"]) {
        expect(
          writeCapability({}, bareMachine({ env: { [WRITE_DIRECT_ESCAPE_ENV]: value } })).mode,
        ).toBe("direct-unknown");
      }
    });

    it("does not cross vectors — the ui escape leaves the write verdict alone", () => {
      const cap = writeCapability({}, bareMachine({ env: { [UI_DIRECT_ESCAPE_ENV]: "1" } }));
      expect(cap.mode).toBe("direct-unknown");
    });

    it("an onboarded deputy still wins, so the escape cannot downgrade provenance", () => {
      const cap = writeCapability(
        {},
        bareMachine({ env: escape, deputyAutomation: () => "granted" }),
      );
      expect(cap.mode).toBe("deputy");
    });
  });

  /**
   * LIVENESS IS NOT AUTHORIZATION, on the write vector's own target (#617).
   * `not-running` is the deputy's ask-false determination having no answer for
   * a CLOSED Things — a fact about the app's process. The matrix below is the
   * whole ruling: a survey reports it and starts nothing; a dispatch starts the
   * app and re-reads; and in neither case may a standing deputy fall through to
   * the direct host branch.
   */
  describe("a dormant Things", () => {
    /** The handshake of a helpers machine whose owner has closed the app. */
    function dormant(over: Partial<CapabilityDeps> = {}): CapabilityDeps {
      return bareMachine({ deputyAutomation: () => "not-running", ...over });
    }

    it("a SURVEY reports the liveness state and starts nothing", () => {
      let woke = 0;
      const cap = writeCapability(
        {},
        dormant({
          wakeThings: () => {
            woke += 1;
            return { standing: "granted", detail: "started on demand" };
          },
        }),
      );
      expect(woke).toBe(0);
      expect(cap.mode).toBe("deputy-target-dormant");
      expect(writeAllowed(cap)).toBe(false);
    });

    it("the survey's copy is about the app being closed — never a permission", () => {
      const cap = writeCapability({}, dormant());
      expect(cap.detail).toContain("Things is not running");
      expect(cap.detail).not.toMatch(/denied|refus|never asked/i);
      const next = cap.remediation.join(" ");
      expect(next).toContain("open Things");
      expect(next).not.toContain("things setup");
      expect(next).not.toContain("things helpers setup");
      expect(next).not.toContain("System Settings");
    });

    it("a DISPATCH wakes the app, and a held grant then routes through the deputy", () => {
      let woke = 0;
      const cap = writeCapability(
        { purpose: "dispatch" },
        dormant({
          wakeThings: () => {
            woke += 1;
            return { standing: "granted", detail: "started on demand" };
          },
        }),
      );
      expect(woke).toBe(1);
      expect(cap.mode).toBe("deputy");
      expect(writeAllowed(cap)).toBe(true);
    });

    it("hands the woken standing to routing, whose own gate deferred on it", () => {
      const settled: (string | undefined)[] = [];
      writeCapability(
        { purpose: "dispatch" },
        dormant({ wakeThings: woken("granted"), settleDeputyAutomation: (s) => settled.push(s) }),
      );
      expect(settled).toEqual(["granted"]);
    });

    it("a woken REFUSAL is a real grant fact, so the host's own record decides", () => {
      const cap = writeCapability(
        { purpose: "dispatch" },
        dormant({ wakeThings: woken("denied"), automationAuthValue: () => 2 }),
      );
      expect(cap.mode).toBe("direct-granted");
    });

    it("a woken never-asked is a real grant fact too", () => {
      const cap = writeCapability(
        { purpose: "dispatch" },
        dormant({ wakeThings: woken("unknown"), automationAuthValue: () => null }),
      );
      expect(cap.mode).toBe("direct-unknown");
    });

    it("refuses on LIVENESS when the wake does not take — the gate never sees a grant word", () => {
      const cap = writeCapability(
        { purpose: "dispatch" },
        dormant({
          wakeThings: () => ({
            standing: "not-running",
            detail: "it did not come up within 10s of being started",
          }),
        }),
      );
      expect(cap.mode).toBe("deputy-target-dormant");
      expect(writeAllowed(cap)).toBe(false);
      expect(cap.detail).toContain("did not come up within 10s");
      expect(cap.detail).not.toMatch(/permission|grant is|denied/i);
    });

    it("refuses on LIVENESS when the deputy goes silent during the wake", () => {
      const cap = writeCapability(
        { purpose: "dispatch" },
        dormant({ wakeThings: woken(undefined) }),
      );
      expect(cap.mode).toBe("deputy-target-dormant");
    });

    /**
     * THE NO-SILENT-DIRECT-FALLBACK RULE. Both directions of the #617 bug: a
     * host holding its own historical grant must not be engaged directly while
     * the helpers stand (the routing doctrine forbids it), and a host with no
     * record must not be told to run `things setup` for a grant the helpers
     * already hold.
     */
    it("never falls through to the direct host path while the deputy is standing", () => {
      for (const authValue of [2, 0, null]) {
        const cap = writeCapability({}, dormant({ automationAuthValue: () => authValue }));
        expect(cap.mode).toBe("deputy-target-dormant");
      }
    });

    it("leaves a machine with no deputy on exactly the logic it had before", () => {
      // Helpers disabled or absent: the handshake carries no value at all, so
      // nothing here is reached and the host's TCC row answers as it always has.
      let woke = 0;
      const cap = writeCapability(
        { purpose: "dispatch" },
        bareMachine({
          deputyAutomation: () => undefined,
          automationAuthValue: () => 2,
          wakeThings: () => {
            woke += 1;
            return { standing: "granted", detail: "started on demand" };
          },
        }),
      );
      expect(woke).toBe(0);
      expect(cap.mode).toBe("direct-granted");
    });

    it("never wakes a target that is already up", () => {
      let woke = 0;
      const cap = writeCapability(
        { purpose: "dispatch" },
        bareMachine({
          deputyAutomation: () => "granted",
          wakeThings: () => {
            woke += 1;
            return { standing: "granted", detail: "started on demand" };
          },
        }),
      );
      expect(woke).toBe(0);
      expect(cap.mode).toBe("deputy");
    });
  });
});

// ── fixture helper ───────────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../fixtures/temp-dir.ts";

/** A state dir holding a marker for pid 4242 of Ghostty. */
function sessionFixture(): string {
  const dir = makeTempDir("things-session");
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

  /**
   * LIVENESS IS NOT AUTHORIZATION (issue #610). macOS reaps System Events when
   * it has been idle, and the ask-false determination has no answer for a
   * target that is down — so `not-running` is a fact about the process. The
   * verdict starts it and re-reads the determination before it decides
   * anything, and a wake that does not take refuses on LIVENESS, never by
   * sending a fully onboarded machine back through onboarding.
   */
  describe("a dormant System Events", () => {
    const dormant = { axTrusted: true, systemEvents: "not-running" };

    it("is woken, and a held grant then reads as granted", () => {
      let woke = 0;
      const verdict = uiCapability(
        guiDeps({
          deputyGuiStanding: () => dormant,
          wakeSystemEvents: () => {
            woke += 1;
            return { standing: "granted", detail: "started on demand" };
          },
        }),
      );
      expect(woke).toBe(1);
      expect(verdict.mode).toBe("helpers");
      expect(uiAllowed(verdict)).toBe(true);
    });

    it("refuses as a MISSING GRANT when the woken target reports a refusal", () => {
      const verdict = uiCapability(
        guiDeps({
          deputyGuiStanding: () => dormant,
          wakeSystemEvents: () => ({ standing: "denied", detail: "started on demand" }),
        }),
      );
      expect(verdict.mode).toBe("tier-incomplete");
      expect(verdict.detail).toContain("automation → System Events (denied)");
      expect(verdict.remediation.join(" ")).toContain("things helpers setup --gui");
    });

    it("refuses as a MISSING GRANT when the woken target was never asked", () => {
      const verdict = uiCapability(
        guiDeps({
          deputyGuiStanding: () => dormant,
          wakeSystemEvents: () => ({ standing: "unknown", detail: "started on demand" }),
        }),
      );
      expect(verdict.mode).toBe("tier-incomplete");
      expect(verdict.detail).toContain("automation → System Events (unknown)");
    });

    it("refuses on LIVENESS when the wake does not take — no onboarding, no permission talk", () => {
      const verdict = uiCapability(
        guiDeps({
          deputyGuiStanding: () => dormant,
          wakeSystemEvents: () => ({
            standing: "not-running",
            detail: "it did not come up within 5s of being started",
          }),
        }),
      );
      expect(verdict.mode).toBe("target-unreachable");
      expect(uiAllowed(verdict)).toBe(false);
      expect(verdict.detail).toContain("System Events is not running");
      expect(verdict.detail).not.toMatch(/permission|grant|denied/i);
      const next = verdict.remediation.join(" ");
      expect(next).toContain("System Events");
      expect(next).not.toContain("things helpers setup");
    });

    it("refuses on LIVENESS when the deputy goes silent during the wake", () => {
      const verdict = uiCapability(
        guiDeps({
          deputyGuiStanding: () => dormant,
          wakeSystemEvents: () => ({ standing: undefined, detail: "it did not come up within 5s" }),
        }),
      );
      expect(verdict.mode).toBe("target-unreachable");
    });

    it("is left alone when the target is already up — a live target needs no launch", () => {
      let woke = 0;
      const verdict = uiCapability(
        guiDeps({
          wakeSystemEvents: () => {
            woke += 1;
            return { standing: "granted", detail: "started on demand" };
          },
        }),
      );
      expect(woke).toBe(0);
      expect(verdict.mode).toBe("helpers");
    });
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
