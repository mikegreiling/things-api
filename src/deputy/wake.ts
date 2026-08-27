/**
 * Waking a dormant Automation target — the LIVENESS half of the GUI preflight.
 *
 * System Events is an on-demand macOS agent: the system starts it when
 * something needs it and reaps it once it has been idle a while. The durable
 * Automation grant does not expire with the process, but
 * `AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false)` cannot answer
 * for a target that is down — it returns procNotFound, which the deputy reports
 * as `not-running` (deputy/src/tcc.swift). That value is a fact about the
 * PROCESS, never a verdict on the grant, and reading it as one is what made a
 * fully onboarded machine get steered back through onboarding (#610).
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
 *     (docs/design/permissions-doctrine.md, Article I).
 *
 * The wait is closed-loop: the determination is re-asked until it stops saying
 * `not-running`, bounded, with no fixed sleep standing in for the answer. When
 * the target never comes up the caller gets a LIVENESS verdict to refuse on —
 * never a permission one.
 */
import { execFileSync } from "node:child_process";

import type { AutomationPermission } from "./protocol.ts";
import { deputySyncRequest } from "./routing.ts";

/** The GUI-driving target: the macOS component that reads and presses controls. */
export const SYSTEM_EVENTS_BUNDLE_ID = "com.apple.systemevents";

/** How long the target may take to come up before the wake is called a failure. */
const WAKE_TIMEOUT_MS = 5_000;

/** How often the determination is re-asked while waiting. */
const WAKE_POLL_INTERVAL_MS = 50;

/** How long the launch itself may take before it counts as refused. */
const LAUNCH_TIMEOUT_MS = 10_000;

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

function launchSystemEvents(): void {
  execFileSync("open", ["-g", "-b", SYSTEM_EVENTS_BUNDLE_ID], {
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
function systemEventsStanding(env: NodeJS.ProcessEnv): AutomationPermission | undefined {
  try {
    const res = deputySyncRequest({ verb: "hello" }, 2000, env);
    const automation = res["automation"] as { systemEvents?: AutomationPermission } | undefined;
    return automation?.systemEvents;
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
 * Start System Events if it is asleep, then report where its Automation grant
 * actually stands. Prompt-free by construction — see the module comment for why
 * the launch must precede the determination.
 *
 * Call this only when the deputy has just reported `not-running`: on a live
 * target the determination is already the truth and the launch buys nothing.
 */
export function wakeSystemEvents(
  env: NodeJS.ProcessEnv = process.env,
  deps: WakeDeps = {},
): TargetWake {
  const probe = deps.probe ?? (() => systemEventsStanding(env));
  const sleep = deps.sleep ?? syncSleep;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? WAKE_TIMEOUT_MS;
  const intervalMs = deps.intervalMs ?? WAKE_POLL_INTERVAL_MS;
  try {
    (deps.launch ?? launchSystemEvents)();
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
