/**
 * Failure attribution: turn raw transport/verification failure signals into
 * a likely cause plus an actionable hint. macOS consent failures have
 * distinct signatures (AppleEvent -1743 = not permitted; a hang against the
 * transport deadline is the shape of an unanswered consent dialog), and a
 * changed environment tuple makes the permission theories far more likely.
 * Hints are ADVISORY — the verified pipeline result stays the ground truth.
 */
import { describeEnvironmentChanges, type EnvironmentChange } from "./environment.ts";
import type { VectorId } from "./vectors/types.ts";

export type LikelyCause =
  | "permission-denied"
  | "permission-pending"
  | "feature-disabled"
  | "app-updated"
  | "app-behavior-change"
  | "schema-drift"
  | "unknown";

export interface FailureHint {
  likelyCause: LikelyCause;
  hint: string;
}

const DENIED = /-1743|not authori[sz]ed to send apple events/i;
const EVENT_TIMED_OUT = /-1712|event timed out/i;

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
  reason: "timeout" | "mismatch" | "silent-noop";
  vector: VectorId;
  /**
   * The on-disk 'Enable Things URLs' state (availability.ts); null when not
   * determinable. NOT inferred from the auth token — the token persists in
   * TMSettings while the feature is off (Phase 21b), so a populated token
   * never implies the scheme is enabled.
   */
  urlSchemeEnabled: boolean | null;
  environmentChanges: EnvironmentChange[];
}): FailureHint | null {
  if (
    input.vector === "url-scheme" &&
    (input.reason === "silent-noop" || input.reason === "timeout") &&
    input.urlSchemeEnabled === false
  ) {
    return {
      likelyCause: "feature-disabled",
      hint:
        "'Enable Things URLs' is off (Things > Settings > General) — the app holds URL " +
        "commands behind an enable dialog instead of executing them, so the write never " +
        "lands. Turn the setting on and retry.",
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
