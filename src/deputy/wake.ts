/**
 * Waking a dormant Automation target — LIVENESS before authorization.
 *
 * `AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false)` cannot answer
 * for a target that is not running: it returns procNotFound, which the deputy
 * reports as `not-running` (deputy/src/tcc.swift). That value is a fact about
 * the PROCESS, never a verdict on the grant, and reading it as one is what made
 * a fully onboarded machine get steered back through onboarding (#610 for
 * System Events, #617 for Things itself).
 *
 * Two targets, one mechanism:
 *
 *  - **System Events** is an on-demand macOS agent the system reaps whenever it
 *    has been idle. Its dormancy is the DEFAULT state, not an edge case
 *    (SEWAKE1 measured it down on a freshly booted machine that had done
 *    nothing).
 *  - **Things** is the user's own app, closed whenever they are not using it.
 *
 * The resolution, and why the ORDER is not negotiable:
 *
 *  1. LAUNCH the target first, with a plain background LaunchServices dispatch
 *     (`open -g -b`). An app launch is not a TCC-gated act: it raises no consent
 *     dialog, on any grant state, ever.
 *  2. Only THEN re-read the ask-false determination. Doing it the other way
 *     round — sending the target an Apple event to wake it — auto-launches it
 *     AND raises the consent dialog when no grant is on record, which is exactly
 *     the surprise the permissions doctrine forbids outside the two ceremonies
 *     (docs/design/permissions-doctrine.md, Article I). For Things the order
 *     buys a second thing measured independently: an Apple event to a CLOSED
 *     Things auto-launches it with FOCUS STEAL (tier 2, A40/A41), while
 *     `open -g` keeps the operation at tier 0/1 — so the wake is the pre-launch
 *     the AppleScript vector wants anyway.
 *
 * The wait is closed-loop: the determination is re-asked until it stops saying
 * `not-running`, bounded, with no fixed sleep standing in for the answer. When
 * the target never comes up the caller gets a LIVENESS verdict to refuse on —
 * never a permission one.
 *
 * WHO MAY CALL THIS. A launch is a side effect, so it belongs to callers that
 * are about to DRIVE the target (the write gate before a dispatch, the two
 * setup ceremonies). A survey — `doctor`, the MCP startup bake — must never
 * launch the user's app as a diagnostic side effect; it reports the liveness
 * state instead (src/capability.ts).
 */
import { execFileSync } from "node:child_process";

import type { AutomationPermission } from "./protocol.ts";
import { deputySyncRequest } from "./routing.ts";

/** The GUI-driving target: the macOS component that reads and presses controls. */
export const SYSTEM_EVENTS_BUNDLE_ID = "com.apple.systemevents";

/** The Things application — the AppleScript vector's target. */
export const THINGS_BUNDLE_ID = "com.culturedcode.ThingsMac";

/** How often the determination is re-asked while waiting. */
const WAKE_POLL_INTERVAL_MS = 50;

/** How long the launch itself may take before it counts as refused. */
const LAUNCH_TIMEOUT_MS = 10_000;

/**
 * One Automation target, described the two ways this module needs it: the
 * bundle id LaunchServices starts, and the `automation` field of the deputy's
 * hello that carries its determination.
 */
export interface WakeTarget {
  bundleId: string;
  field: "systemEvents" | "things";
  /** How long the target may take to come up before the wake is a failure. */
  timeoutMs: number;
}

/**
 * System Events comes up in milliseconds — it is a headless agent with nothing
 * to restore (SEWAKE1: `granted` on the FIRST ask after the launch, 10 ms).
 */
export const SYSTEM_EVENTS_TARGET: WakeTarget = {
  bundleId: SYSTEM_EVENTS_BUNDLE_ID,
  field: "systemEvents",
  timeoutMs: 5_000,
};

/**
 * Things is a full document app that opens a window and its database, so it is
 * given a longer bound than the agent. This wait only covers becoming
 * ANSWERABLE to the determination; the pipeline separately waits for the app to
 * be ready to land a write (src/write/pipeline.ts, the #486 startup window).
 */
export const THINGS_TARGET: WakeTarget = {
  bundleId: THINGS_BUNDLE_ID,
  field: "things",
  timeoutMs: 10_000,
};

export interface TargetWake {
  /**
   * The target's Automation standing once it is up. `not-running` (or
   * undefined) means the wake did NOT take — a liveness failure, and the only
   * state a caller may refuse on with liveness copy.
   */
  standing: AutomationPermission | undefined;
  /** One clause of provenance, for the refusal when the wake did not take. */
  detail: string;
}

export interface WakeDeps {
  /** Start the target in the background. Throws when the launch is refused. */
  launch?: () => void;
  /** Re-read the deputy's ask-false determination for the target. */
  probe?: () => AutomationPermission | undefined;
  sleep?: (ms: number) => void;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
}

function launchInBackground(bundleId: string): void {
  execFileSync("open", ["-g", "-b", bundleId], {
    stdio: "ignore",
    timeout: LAUNCH_TIMEOUT_MS,
  });
}

/**
 * A FRESH determination off the deputy, not the handshake the routing layer
 * memoized at activation — the whole point of the re-probe is that the world
 * changed since then. A deputy that stops answering mid-wake reads as
 * undefined, which keeps the loop waiting rather than manufacturing a verdict.
 */
function targetStanding(
  env: NodeJS.ProcessEnv,
  field: WakeTarget["field"],
): AutomationPermission | undefined {
  try {
    const res = deputySyncRequest({ verb: "hello" }, 2000, env);
    const automation = res["automation"] as
      | Partial<Record<WakeTarget["field"], AutomationPermission>>
      | undefined;
    return automation?.[field];
  } catch {
    return undefined;
  }
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True while the target is still down (or the determination is still unread). */
function stillDown(standing: AutomationPermission | undefined): boolean {
  return standing === undefined || standing === "not-running";
}

/**
 * Start a dormant Automation target, then report where its grant actually
 * stands. Prompt-free by construction — see the module comment for why the
 * launch must precede the determination.
 *
 * Call this only when the deputy has just reported `not-running`: on a live
 * target the determination is already the truth and the launch buys nothing.
 */
export function wakeTarget(
  target: WakeTarget,
  env: NodeJS.ProcessEnv = process.env,
  deps: WakeDeps = {},
): TargetWake {
  const probe = deps.probe ?? (() => targetStanding(env, target.field));
  const sleep = deps.sleep ?? syncSleep;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? target.timeoutMs;
  const intervalMs = deps.intervalMs ?? WAKE_POLL_INTERVAL_MS;
  try {
    (deps.launch ?? (() => launchInBackground(target.bundleId)))();
  } catch (err) {
    return {
      standing: "not-running",
      detail: `it could not be started (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const deadline = now() + timeoutMs;
  let standing = probe();
  while (stillDown(standing) && now() < deadline) {
    sleep(intervalMs);
    standing = probe();
  }
  if (stillDown(standing)) {
    return {
      standing,
      detail: `it did not come up within ${Math.round(timeoutMs / 1000)}s of being started`,
    };
  }
  return { standing, detail: "started on demand" };
}

/** Wake the GUI-driving target (#610). */
export function wakeSystemEvents(
  env: NodeJS.ProcessEnv = process.env,
  deps: WakeDeps = {},
): TargetWake {
  return wakeTarget(SYSTEM_EVENTS_TARGET, env, deps);
}

/** Wake the AppleScript vector's target — the user's own Things app (#617). */
export function wakeThings(env: NodeJS.ProcessEnv = process.env, deps: WakeDeps = {}): TargetWake {
  return wakeTarget(THINGS_TARGET, env, deps);
}
