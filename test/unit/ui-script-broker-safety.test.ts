/**
 * NO ACTING SCRIPT MAY CONTAIN A PHRASE THE DEPUTY'S BROKER REFUSES (#695).
 *
 * The failure this suite exists for shipped in 0.20.7 and was invisible to every
 * other guard. The AX settle sidecar (VOPAT2, #676) talks to its socket through
 * `do shell script … | nc -U`, and the deputy's broker LINTS every script it is
 * handed and refuses any that shells out (`scriptGuard`, deputy/src/server.swift
 * — correct, and staying). So `todo add-repeating --dangerously-drive-gui` died
 * in two seconds on every helpers-routed Mac with
 *
 *   script rejected: contains "do shell script" — the deputy only brokers
 *   GUI/AppleEvent scripts, never shell execution
 *
 * while every lab certification stayed green: the goldens have no helpers
 * installed, so they run scripts DIRECT. The certified arm was the only arm, and
 * "which host class executes this script" was a dimension nothing tested.
 *
 * Two halves, both needed:
 *
 *  1. THE DECISION. On a host that expects the deputy, the sidecar must stand
 *     down — before its spawn hop is ever generated — and say so by name.
 *  2. THE OUTPUT. The whole script catalog, rendered in the settle shape that
 *     decision produces, must be free of the broker's banned phrases. The
 *     catalog is shared with the osacompile suite (helpers/ui-script-catalog.ts)
 *     so a script cannot be known to one guard and not the other.
 *
 * The banned list itself lives in ONE place per language and is pinned across
 * the seam by a drift test (test/unit/deputy-protocol.test.ts): two lists that
 * can disagree are how this class shipped.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEPUTY_BANNED_SCRIPT_PHRASES } from "../../src/deputy/protocol.ts";
import { resetDeputyRoutingForTests } from "../../src/deputy/routing.ts";
import {
  observerTransport,
  resetObserverAvailability,
  settleInjectorFor,
  startObserver,
} from "../../src/write/vectors/ui-observer.ts";
import { everyUiScript, OBSERVED_SHAPE, POLLING_SHAPE } from "./helpers/ui-script-catalog.ts";

/**
 * A host that routes its automation through the helpers. `helpers-enabled true`
 * is the strongest form of the configuration — an explicit instruction to route
 * — and needs no installed bundle to assert, so the decision is testable on any
 * host, CI runners included.
 *
 * The state dir is a fresh temp directory on purpose: the routed decision reads
 * the deputy handshake (DEPOBS1 needs the capability list), and a suite must ask
 * that question of an EMPTY machine rather than of whatever helper the developer
 * running it happens to have installed.
 */
const ROUTED_HOST = {
  THINGS_API_HELPERS: "true",
  THINGS_API_STATE_DIR: mkdtempSync(join(tmpdir(), "brokersafe-")),
} as NodeJS.ProcessEnv;

/** A host with the helpers switched off: the direct-execution majority. */
const DIRECT_HOST = { THINGS_API_HELPERS: "false" } as NodeJS.ProcessEnv;

function bannedPhrasesIn(script: string): string[] {
  const lowered = script.toLowerCase();
  return DEPUTY_BANNED_SCRIPT_PHRASES.filter((phrase) => lowered.includes(phrase));
}

describe("the sidecar stands down where the broker would refuse it", () => {
  it("answers a routed host from ROUTING, ahead of any tool probe", async () => {
    resetObserverAvailability();
    resetDeputyRoutingForTests();
    const choice = await observerTransport(ROUTED_HOST);
    // Nothing is installed in a unit run, so the routed branch resolves to no
    // observer — and says so in routing's words, never python's. The transport
    // that a routed host CAN have (helpers 1.4.0 hosting the ledger, DEPOBS1)
    // is certified against the real broker in test/deputy/broker-integration.
    expect(choice.transport).toBe("none");
    expect(choice.why).toContain("deputy-routed");
  });

  it("never generates the spawn hop there — the runner is not called at all", async () => {
    resetObserverAvailability();
    resetDeputyRoutingForTests();
    const spawned: string[] = [];
    const session = await startObserver(async (command) => {
      spawned.push(command.script);
      return { ok: true, stdout: "", stderr: "" };
    }, ROUTED_HOST);
    expect(session).toBeNull();
    expect(spawned).toEqual([]);
  });

  it("leaves a direct-execution host to decide on its own tools", async () => {
    resetObserverAvailability();
    resetDeputyRoutingForTests();
    // Not asserting sidecar/true: whether python3 and the Command Line Tools
    // are present is the host's business (Linux CI has neither). What must be
    // true is that routing is not the thing standing in the way.
    const choice = await observerTransport(DIRECT_HOST);
    expect(choice.why).not.toContain("deputy-routed");
  });
});

describe("every acting script a routed host generates is brokerable", () => {
  it("renders the whole catalog clean of the deputy's banned phrases", () => {
    // POLLING_SHAPE is what a routed host produces — with OR without an
    // observer. A null session makes `settleInjectorFor` inert; so does a
    // DEPUTY-hosted one (DEPOBS1), because the in-script client is the half
    // that shells out and the routed transport deliberately does not carry it.
    // Either way every script comes out byte-identical to the pre-VOPAT2
    // version (certified in ui-observer.test.ts).
    const scripts = everyUiScript([POLLING_SHAPE]);
    expect(scripts.length).toBeGreaterThan(30);
    const offenders = scripts
      .map((s) => ({ label: s.label, banned: bannedPhrasesIn(s.script) }))
      .filter((r) => r.banned.length > 0)
      .map((r) => `${r.label} — contains ${r.banned.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("a deputy-hosted session still generates the polling scripts", () => {
    // The DEPOBS1 half-measure, asserted rather than assumed: node gets its
    // settles over the deputy socket, and the SCRIPTS stay the brokerable ones.
    const routed = settleInjectorFor({
      transport: "deputy",
      token: "0123456789abcdef0123456789abcdef",
      registered: "16/16",
      pid: 4242,
    });
    expect(routed.live).toBe(false);
    const scripts = everyUiScript([{ tag: "deputy-hosted", obs: routed }]);
    expect(scripts.length).toBeGreaterThan(30);
    expect(scripts.filter((s) => bannedPhrasesIn(s.script).length > 0)).toEqual([]);
  });

  it("has teeth: the observed shape IS what the broker refuses", () => {
    // The negative control, and the whole regression in one assertion. If this
    // ever goes green the guard above has stopped meaning anything — either the
    // catalog emptied, or the sidecar stopped shelling out (in which case delete
    // this test and let the observer route).
    const offenders = everyUiScript([OBSERVED_SHAPE]).filter(
      (s) => bannedPhrasesIn(s.script).length > 0,
    );
    expect(offenders.length).toBeGreaterThan(0);
    expect(bannedPhrasesIn(offenders[0]!.script)).toContain("do shell script");
  });
});
