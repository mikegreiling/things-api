/**
 * Failure attribution: turn raw transport/verification failure signals into
 * a likely cause plus an actionable hint. macOS consent failures have
 * distinct signatures (AppleEvent -1743 = not permitted; a hang against the
 * transport deadline is the shape of an unanswered consent dialog), and a
 * changed environment tuple makes the permission theories far more likely.
 * Hints are ADVISORY — the verified pipeline result stays the ground truth.
 */
import type { UrlSchemeCapabilityMode } from "../capability.ts";
import { describeEnvironmentChanges, type EnvironmentChange } from "./environment.ts";
import type { VectorId } from "./vectors/types.ts";

export type LikelyCause =
  | "permission-denied"
  | "permission-pending"
  | "feature-disabled"
  | "app-not-running"
  | "app-updated"
  | "app-behavior-change"
  /** A GUI drive could not reach the Things window (locked screen / unresponsive app), #512. */
  | "ui-unreachable"
  /**
   * A modal dialog is standing in Things, which makes the app answer "no such
   * item" for rows that are present and hold its Things Cloud sync (#620,
   * MODALX1). The one cause of `-1728` on a uuid the database shows.
   */
  | "modal-open"
  | "schema-drift"
  | "unknown";

export interface FailureHint {
  likelyCause: LikelyCause;
  hint: string;
}

const DENIED = /-1743|not authori[sz]ed to send apple events/i;
const EVENT_TIMED_OUT = /-1712|event timed out/i;
/**
 * `-1728 Can't get <kind> id "…"` on a row the database shows perfectly present.
 *
 * This has ONE cause worth naming, and it is not a missing item (MODALX1 §2.1,
 * golden-v4 / 3.23): a modal dialog standing anywhere in Things EMPTIES the
 * app's top-level scripting collections — `count to dos` reads 0 — while every
 * by-id read still answers. AppleScript's `delete` re-resolves its object
 * specifier through that emptied list, so it raises -1728 for a to-do it can
 * still `get name of`. Dismiss the dialog and the identical command lands.
 * This is the whole of the #620 "ghost clone".
 */
const CANT_GET_ID = /-1728|can[’']?t get (to do|project|tag|area)( id)?/i;

/**
 * The app macOS attributes an Automation request to — the TERMINAL EMULATOR
 * hosting the process tree, not the CLI binary (live-confirmed 2026-07-12:
 * the consent dialog read "Ghostty.app wants access to control Things.app").
 * TERM_PROGRAM names it when the shell exports one; generic otherwise.
 */
export function automationGrantee(): string {
  const term = process.env["TERM_PROGRAM"];
  return term !== undefined && term !== "" ? `your terminal app (${term})` : "your terminal app";
}

function environmentSuffix(changes: EnvironmentChange[]): string {
  if (changes.length === 0) return "";
  return (
    ` Since the last verified write, ${describeEnvironmentChanges(changes)} — ` +
    "exactly the kind of change that re-triggers macOS consent."
  );
}

/** Classify a failed transport execution (nonzero exit or deadline kill). */
export function classifyTransportFailure(input: {
  vector: VectorId;
  stderr: string;
  timedOut: boolean;
  environmentChanges: EnvironmentChange[];
}): FailureHint | null {
  if (input.vector === "applescript" && DENIED.test(input.stderr)) {
    return {
      likelyCause: "permission-denied",
      hint:
        "macOS Automation permission for this process (or the app hosting it) is missing or " +
        "was declined. Grant it under System Settings > Privacy & Security > Automation, or " +
        "see docs/setup.md for pre-authorizing headless setups." +
        environmentSuffix(input.environmentChanges),
    };
  }
  if (input.vector === "applescript" && CANT_GET_ID.test(input.stderr)) {
    return {
      likelyCause: "modal-open",
      hint:
        "Things answered that it cannot find that item — which is what it says about an item " +
        "that IS there whenever a dialog is open somewhere in the app: while one stands, Things " +
        "reports its own lists as empty to scripted callers, so a change addressed by id cannot " +
        "resolve. It also stops sending changes to Things Cloud until the dialog is dismissed. " +
        "Run `things ui-state` to see what is open, dismiss it (click Cancel, or press Escape " +
        "with Things in front), then run the same command again — nothing was changed." +
        environmentSuffix(input.environmentChanges),
    };
  }
  if (input.vector === "shortcuts" && input.timedOut) {
    return {
      likelyCause: "permission-pending",
      hint:
        "the shortcut did not return in time — the first run of a Things proxy shortcut " +
        "shows a one-time macOS consent prompt. Run the shortcut once interactively and " +
        "choose Always Allow, then retry (headless after that)." +
        environmentSuffix(input.environmentChanges),
    };
  }
  if (input.timedOut || EVENT_TIMED_OUT.test(input.stderr)) {
    return {
      likelyCause: "permission-pending",
      hint:
        "the command hung the way an unanswered macOS Automation dialog does (AppleEvent " +
        `-1712). The dialog is addressed to ${automationGrantee()} — not to \`things\` — and ` +
        "it shows on the machine's PHYSICAL screen, so over SSH/remote sessions it is easy " +
        "to miss (oddity 5m: while it waits, object-model AppleScript hangs but URL-scheme " +
        "commands still work). Approve the prompt and retry; if it was dismissed, re-enable " +
        "under System Settings > Privacy & Security > Automation." +
        environmentSuffix(input.environmentChanges),
    };
  }
  return null;
}

/**
 * Classify a verification failure: the command was dispatched and accepted,
 * but the expected change never appeared in the database.
 */
export function classifyVerifyFailure(input: {
  /**
   * `collateral` deliberately gets NO hint: the requested change landed, so none of
   * the permission / feature-off / startup-window theories below apply, and the
   * failure's own sentence already names the field that moved and both values.
   * Attaching a speculative cause there would only invite a retry.
   */
  reason: "timeout" | "mismatch" | "silent-noop" | "collateral";
  vector: VectorId;
  /**
   * Where Things' own "Enable Things URLs" authorization stands (capability.ts),
   * or **null when the vector does not deliver URLs at all** — in which case the
   * theory cannot apply and is not even evaluated.
   *
   * That null is not a convenience. Like the gate, this is keyed on the
   * vector's `dispatchesUrls` DECLARATION rather than on its id, because engine
   * tests substitute fakes under the `url-scheme` id: an id-keyed lookup made
   * the shipped default read the DEVELOPER's own Things preferences, so a
   * pipeline test passed on a workstation whose setting is on and failed in CI,
   * where nothing is readable and every silent no-op was blamed on this.
   *
   * NOT inferred from the auth token either — the token persists in TMSettings
   * while the feature is off (Phase 21b), so a populated token never implies
   * the scheme is enabled.
   *
   * In the shipped pipeline the pre-dispatch gate has already refused
   * `disabled` and `never-asked`, so the value that reaches here is normally
   * `enabled` or `unreadable`. `unreadable` is the case this hint exists for: a
   * host that cannot read the setting cannot be gated on it, so the theory is
   * offered after the fact instead.
   */
  urlScheme: UrlSchemeCapabilityMode | null;
  /**
   * Whether Things was ALREADY running when this write's preflight ran. False
   * means the pipeline had to background-launch it for this write: a residual
   * silent-noop/timeout right after a cold launch is very likely the app's
   * startup window, where the URL handler is registered but a command dispatched
   * too early is accepted-and-dropped (issue #486). Attributed ahead of the
   * generic app-behavior theory so the exact scenario never reads as a mystery.
   */
  appWasRunning: boolean;
  environmentChanges: EnvironmentChange[];
}): FailureHint | null {
  if (
    input.urlScheme !== null &&
    input.urlScheme !== "enabled" &&
    (input.reason === "silent-noop" || input.reason === "timeout")
  ) {
    return {
      likelyCause: "feature-disabled",
      hint:
        "Things may not be authorized to act on URL commands. When 'Enable Things URLs' " +
        "(Things > Settings > General) is off, the app puts a 'Things URL Scheme' alert on its " +
        "own window and holds the command there instead of running it — so a command sent with " +
        "nobody at the machine reads exactly like this. Check that setting on the machine " +
        "running Things: if an alert is waiting, clicking Enable runs the held command, which " +
        "means this write can still land on its own. Verify the item's state before resending.",
    };
  }
  if (!input.appWasRunning && (input.reason === "silent-noop" || input.reason === "timeout")) {
    return {
      likelyCause: "app-not-running",
      hint:
        "Things was not running when this write started, so it was launched first — the command " +
        "then ran during the app's startup window, when a command can be accepted but not yet " +
        "applied. Now that Things is up, retry the same command.",
    };
  }
  const thingsChange = input.environmentChanges.find((c) => c.field === "thingsVersion");
  if (thingsChange !== undefined) {
    return {
      likelyCause: "app-updated",
      hint:
        `Things was updated (${thingsChange.from ?? "unknown"} → ${thingsChange.to ?? "unknown"}) ` +
        "since the last verified write — its behavior for this command may have changed. " +
        "Re-run with dry-run to inspect the plan, and check `things doctor`.",
    };
  }
  if (input.reason === "silent-noop") {
    return {
      likelyCause: "app-behavior-change",
      hint:
        "the app accepted the command and changed nothing. If the parameters look right and " +
        "this repeats, the app's behavior may have changed — capture the dry-run plan and " +
        "report it.",
    };
  }
  return null;
}
