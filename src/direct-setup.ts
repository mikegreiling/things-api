/**
 * `things setup` — the DIRECT-path onboarding ceremony
 * (docs/design/permissions-doctrine.md, Article V).
 *
 * One of exactly two places in the package allowed to put a macOS consent
 * dialog on screen (the other is `things helpers setup`). Everywhere else
 * detects capability prompt-free and refuses; here we deliberately raise what
 * has to be raised, while a human is sitting at the machine, and report where
 * each grant landed.
 *
 * The legs, in order:
 *
 *  a. READ ACCESS. Full Disk Access for the host app is the durable answer and
 *     the one this leg guides toward: it survives quits, reboots and updates.
 *     When it is absent the ceremony offers the sub-FDA alternative — one
 *     deliberate container open, which raises the "would like to access data
 *     from other apps" modal — and, if that open then succeeds, witnesses the
 *     grant (./session-grant.ts). That grant lasts only as long as the host app
 *     stays open, and the copy says so rather than implying otherwise.
 *  b. APP CONTROL. When macOS has no Automation record for the host app, the
 *     only way to mint one is to send a real Apple Event, which is what raises
 *     the dialog. Inside a ceremony that is exactly right. A recorded refusal
 *     is NOT re-asked (macOS will not show it again); the copy names both the
 *     Settings toggle and the `tccutil` re-arm and leaves the choice to the human.
 *  c. SHORTCUTS. The bundled proxies that carry the operations no other surface
 *     can perform. An install sheet per missing shortcut; no macOS consent.
 *
 * There is deliberately NO Accessibility leg: GUI-driving is helpers-only
 * (Article IV), so when `ui.enabled` is set this ceremony says so and points at
 * `things helpers setup --gui` rather than raising an AX prompt against the
 * terminal.
 *
 * Every leg is IDEMPOTENT and RESUMABLE: an already-satisfied leg is detected
 * prompt-free and skipped, so a rerun on a settled machine raises nothing and
 * reports all-green. A leg left outstanding exits nonzero naming what remains.
 *
 * Mode-aware (Article V): off a TTY this is STRICT mode — an upfront banner
 * counting the dialogs, bounded waits, and an unanswered leg failing the run.
 * At a TTY the same legs run as a guided WIZARD: each dialog is explained in
 * the words macOS will use before it is raised, and the ceremony waits for the
 * human between legs (./wizard.ts). TTY-ness is the only signal, and it is read
 * inside this ceremony only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fdaGranted,
  hostApp,
  hostDisplayName,
  readCapability,
  writeCapability,
  type CapabilityDeps,
  type ReadCapability,
} from "./capability.ts";
import { loadConfig } from "./config.ts";
import { locateThingsDb } from "./db/locate.ts";
import { clearSessionGrant, witnessSessionGrant } from "./session-grant.ts";
import { createWizard, type Wizard } from "./wizard.ts";
import { readShortcutProxies, type ShortcutsState } from "./write/availability.ts";

/** Deep link to the Full Disk Access pane. */
const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
/** Deep link to the Automation pane. */
const AUTOMATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

/** Package root — one level above src/ AND dist/, so both layouts resolve. */
const SHORTCUTS_DIR = fileURLToPath(new URL("../shortcuts", import.meta.url));

const FDA_WAIT_MS = 120_000;
const FDA_POLL_MS = 1000;
const AUTOMATION_TIMEOUT_MS = 60_000;

export type SetupLeg = "read-access" | "app-control" | "shortcuts";

/**
 * Where a leg stands. `pending` is a HUMAN-pace outcome (a toggle not yet
 * flipped, a sheet not yet clicked) and resumes on a rerun; `denied` means
 * macOS or the user refused and only the human can undo it.
 */
export type SetupState = "granted" | "denied" | "pending" | "skipped";

export interface SetupStep {
  leg: SetupLeg;
  label: string;
  state: SetupState;
  /** True when the leg was already satisfied, detected without raising anything. */
  alreadySatisfied: boolean;
  detail: string;
}

export interface DirectSetupResult {
  /** The host app every direct grant in this run attaches to. */
  host: { bundleId: string | null; name: string };
  steps: SetupStep[];
  /** The legs that were going to put something on screen, surveyed BEFORE the first ran. */
  outstanding: SetupLeg[];
  denied: boolean;
  pending: boolean;
  /** The single closing line printed under the report. */
  closing: string;
}

export interface DirectSetupDeps extends CapabilityDeps {
  progress?: (line: string) => void;
  /**
   * The Article V wizard (./wizard.ts). At a TTY it explains each dialog before
   * the leg raises it and waits for the human; off a TTY every method is inert
   * and this ceremony behaves exactly as strict mode always has.
   */
  wizard?: Wizard;
  openUrl?: (url: string) => void;
  /** Send the real Apple Event that mints an Automation grant. Throws on failure. */
  sendAutomationProbe?: (timeoutMs: number) => void;
  /** Open the container database once, deliberately, to provoke the app-data modal. */
  openContainer?: () => void;
  /** Open one shortcut's install sheet. */
  openShortcut?: (file: string) => void;
  /** The installed proxy-shortcut census (availability.ts). */
  shortcutProxies?: () => ShortcutsState;
  sleep?: (ms: number) => void;
  /** Millisecond clock for the bounded waits (distinct from the marker's wall clock). */
  elapsed?: () => number;
  fdaWaitMs?: number;
  fdaPollMs?: number;
  automationTimeoutMs?: number;
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function openUrlBestEffort(url: string): void {
  try {
    execFileSync("open", [url], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // The deep link is a convenience; the written path works without it.
  }
}

/**
 * The container open the ceremony performs on purpose. This is the ONE place
 * in the package permitted to do it blind — everywhere else the doctrine's
 * Article I corollary forbids it, because the open is what raises the modal.
 */
function openContainerDefault(): void {
  const fd = openSync(locateThingsDb().path, "r");
  closeSync(fd);
}

function sendAutomationProbeDefault(timeoutMs: number): void {
  // `count of areas` dispatches a REAL Apple event. Properties like `version`
  // are answered locally from the target's bundle, mint no grant, and still
  // exit 0 — a false positive that has shipped here before (see the helpers'
  // automationLeg). Never weaken this script.
  execFileSync("osascript", ["-e", 'tell application "Things3" to count of areas'], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: timeoutMs,
  });
}

// ── Leg (a): read access ─────────────────────────────────────────────────────

function readAccessLeg(capability: ReadCapability, deps: DirectSetupDeps): SetupStep {
  const base = { leg: "read-access" as const, label: "read access" };
  const progress = deps.progress ?? (() => {});
  const hostName = hostDisplayName(deps);
  if (capability.mode === "helpers") {
    progress("read access: already served by the helpers");
    return {
      ...base,
      state: "granted",
      alreadySatisfied: true,
      detail: "the helpers' reader holds the read grant",
    };
  }
  if (capability.mode === "direct-fda") {
    progress("read access: already granted (Full Disk Access)");
    return { ...base, state: "granted", alreadySatisfied: true, detail: capability.detail };
  }
  if (capability.mode === "session-grant") {
    progress("read access: already granted for as long as this app stays open");
    return { ...base, state: "granted", alreadySatisfied: true, detail: capability.detail };
  }
  // Nothing on record. Guide to the durable grant first, and poll for it.
  progress(
    `read access: turn on ${hostName} under System Settings ▸ Privacy & Security ▸ Full Disk Access`,
  );
  (deps.openUrl ?? openUrlBestEffort)(FDA_SETTINGS_URL);
  progress("read access: waiting for the switch — Ctrl-C and rerun anytime");
  const sleep = deps.sleep ?? syncSleep;
  const elapsed = deps.elapsed ?? Date.now;
  const deadline = elapsed() + (deps.fdaWaitMs ?? FDA_WAIT_MS);
  while (elapsed() < deadline) {
    sleep(deps.fdaPollMs ?? FDA_POLL_MS);
    if (fdaGranted(deps).granted) {
      progress("read access: granted (Full Disk Access)");
      return {
        ...base,
        state: "granted",
        alreadySatisfied: false,
        detail: `Full Disk Access is held by ${hostName}`,
      };
    }
  }
  // The sub-FDA alternative: provoke the app-data modal on purpose, and record
  // the grant only if the open actually then succeeded.
  progress(
    "read access: Full Disk Access was not granted — asking for folder access instead " +
      '(answer "Allow" if a dialog appears)',
  );
  const host = hostApp(deps);
  try {
    (deps.openContainer ?? openContainerDefault)();
  } catch (err) {
    clearSessionGrant(deps.env ?? process.env);
    const why = err instanceof Error ? err.message : String(err);
    progress(`read access: still no access (${why})`);
    return {
      ...base,
      state: "pending",
      alreadySatisfied: false,
      detail:
        `no read access yet — grant Full Disk Access to ${hostName} under System Settings ▸ ` +
        "Privacy & Security ▸ Full Disk Access and rerun, or run `things helpers setup` " +
        "to let a helper hold the grant instead",
    };
  }
  const witnessed = witnessSessionGrant(host.bundleId ?? "", deps);
  if (witnessed === null) {
    return {
      ...base,
      state: "pending",
      alreadySatisfied: false,
      detail:
        "the folder opened, but this process has no host application whose lifetime the " +
        "grant could be tied to — grant Full Disk Access, or run `things helpers setup`",
    };
  }
  progress("read access: granted for as long as this app stays open");
  return {
    ...base,
    state: "granted",
    alreadySatisfied: false,
    detail:
      `${hostName} may read the Things data folder until it quits. Full Disk Access ` +
      "(System Settings ▸ Privacy & Security) makes it permanent; `things helpers setup` " +
      "moves it onto a helper that keeps it across restarts",
  };
}

// ── Leg (b): app control ─────────────────────────────────────────────────────

function appControlLeg(deps: DirectSetupDeps): SetupStep {
  const base = { leg: "app-control" as const, label: "app control" };
  const progress = deps.progress ?? (() => {});
  const capability = writeCapability(deps);
  const hostName = hostDisplayName(deps);
  if (capability.mode === "deputy") {
    progress("app control: already held by the helpers");
    return {
      ...base,
      state: "granted",
      alreadySatisfied: true,
      detail: "the deputy holds app control for Things",
    };
  }
  if (capability.mode === "direct-granted") {
    progress("app control: already granted");
    return { ...base, state: "granted", alreadySatisfied: true, detail: capability.detail };
  }
  if (capability.mode === "direct-denied") {
    // macOS will not show this dialog again — re-asking is not an option, so
    // the leg reports the two things a human can actually do.
    progress("app control: refused earlier — macOS will not ask again");
    return {
      ...base,
      state: "denied",
      alreadySatisfied: false,
      detail: capability.remediation.join("; "),
    };
  }
  progress("app control: asking now — answer the dialog if one appears");
  try {
    (deps.sendAutomationProbe ?? sendAutomationProbeDefault)(
      deps.automationTimeoutMs ?? AUTOMATION_TIMEOUT_MS,
    );
  } catch (err) {
    const e = err as { stderr?: unknown; killed?: boolean };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf8")
          : err instanceof Error
            ? err.message
            : String(err);
    if (/-1743/.test(stderr)) {
      progress("app control: refused");
      (deps.openUrl ?? openUrlBestEffort)(AUTOMATION_SETTINGS_URL);
      return {
        ...base,
        state: "denied",
        alreadySatisfied: false,
        detail:
          `turn on Things3 for ${hostName} under System Settings ▸ Privacy & Security ▸ ` +
          `Automation, or re-arm the request with \`tccutil reset AppleEvents ${
            hostApp(deps).bundleId ?? "<host app>"
          }\`, then rerun`,
      };
    }
    if (e.killed === true || /-1712|event timed out/i.test(stderr)) {
      progress("app control: still waiting on the dialog");
      return {
        ...base,
        state: "pending",
        alreadySatisfied: false,
        detail: "the dialog was not answered — answer it and rerun",
      };
    }
    progress(`app control: no grant yet (${stderr.trim().split("\n")[0] ?? "unknown error"})`);
    return {
      ...base,
      state: "pending",
      alreadySatisfied: false,
      detail: stderr.trim().split("\n")[0] ?? "the request did not complete",
    };
  }
  // A zero exit is not believed on its own: re-read what macOS actually records.
  const after = writeCapability(deps);
  if (after.mode === "direct-granted" || after.mode === "deputy") {
    progress("app control: granted");
    return { ...base, state: "granted", alreadySatisfied: false, detail: "granted" };
  }
  progress("app control: the request ran but macOS records no grant yet");
  return {
    ...base,
    state: "pending",
    alreadySatisfied: false,
    detail: `${after.detail} — rerun, or turn Things3 on for ${hostName} under System Settings ▸ Privacy & Security ▸ Automation`,
  };
}

// ── Leg (c): shortcuts ───────────────────────────────────────────────────────

function shortcutsLeg(deps: DirectSetupDeps): SetupStep {
  const base = { leg: "shortcuts" as const, label: "shortcuts" };
  const progress = deps.progress ?? (() => {});
  const state = (deps.shortcutProxies ?? readShortcutProxies)();
  if (state.missing.length === 0) {
    progress("shortcuts: all installed");
    return {
      ...base,
      state: "granted",
      alreadySatisfied: true,
      detail: `${state.present.length} installed`,
    };
  }
  const opened: string[] = [];
  const failures: string[] = [];
  for (const name of state.missing) {
    const file = join(SHORTCUTS_DIR, `${name}.shortcut`);
    if (!existsSync(file)) {
      failures.push(`${name} (file missing from the package)`);
      continue;
    }
    try {
      (deps.openShortcut ?? ((f: string) => execFileSync("open", [f], { timeout: 10_000 })))(file);
      opened.push(name);
    } catch {
      failures.push(name);
    }
  }
  if (opened.length > 0) {
    progress(
      `shortcuts: opened ${opened.length} install sheet${opened.length === 1 ? "" : "s"} — ` +
        'click "Add Shortcut" on each, then "Always Allow" the first time each one runs',
    );
  }
  if (failures.length > 0) progress(`shortcuts: could not open ${failures.join(", ")}`);
  return {
    ...base,
    state: "pending",
    alreadySatisfied: false,
    detail:
      opened.length > 0
        ? `${opened.length} install sheet${opened.length === 1 ? "" : "s"} opened — click “Add Shortcut” on each, then rerun`
        : `could not open: ${failures.join(", ")}`,
  };
}

// ── The ceremony ─────────────────────────────────────────────────────────────

/** What each leg puts on screen, for the upfront banner. */
const PROMPT_LABELS: Record<SetupLeg, string> = {
  "read-access": "the Full Disk Access switch (or a folder-access dialog)",
  "app-control": "the app-control dialog for Things",
  shortcuts: "one install sheet per missing shortcut",
};

/**
 * What the human is about to see, in the words macOS will actually use — the
 * wizard prints these one leg ahead of the dialog (Article V, mode-aware). In
 * strict mode they are never printed; the upfront banner's count stands alone.
 * `{host}` is filled with the detected host app's display name.
 */
const PROMPT_EXPLAINERS: Record<SetupLeg, string[]> = {
  "read-access": [
    "Next: read access to your Things data.",
    "  System Settings opens at Privacy & Security ▸ Full Disk Access — turn on {host} in",
    "  that list. It is a switch you flip, not a dialog you answer, so setup waits and",
    "  watches for it.",
    '  If you would rather not, wait it out: a dialog then asks whether {host} "would like to',
    '  access data from other apps" — click Allow, and the access lasts until {host} quits.',
  ],
  "app-control": [
    "Next: permission to control the Things app.",
    '  A macOS dialog will appear: "{host}" wants access to control "Things" — click Allow.',
    "  Things opens if it was closed; that is expected.",
  ],
  shortcuts: [
    "Next: the bundled shortcuts.",
    '  One Shortcuts install sheet opens per missing shortcut — click "Add Shortcut" on each.',
    '  The first time each one runs, Shortcuts asks once more; choose "Always Allow".',
  ],
};

function closingLine(steps: SetupStep[], uiEnabled: boolean): string {
  const denied = steps.filter((s) => s.state === "denied");
  const pending = steps.filter((s) => s.state === "pending");
  const guiHint = uiEnabled
    ? " Some features drive the Things window; that needs the helpers — `things helpers setup --gui`."
    : "";
  if (denied.length > 0) {
    return (
      `${denied.map((s) => s.label).join(", ")} ${denied.length === 1 ? "was" : "were"} refused — ` +
      `macOS will not ask again, so the remedy above has to be done by hand.${guiHint}`
    );
  }
  if (pending.length > 0) {
    return `still outstanding: ${pending.map((s) => s.label).join(", ")}. Finish those and rerun \`things setup\` — it resumes exactly here.${guiHint}`;
  }
  return `Everything this machine needs is in place.${guiHint}`;
}

export interface SetupSurvey {
  host: { bundleId: string | null; name: string };
  read: ReadCapability;
  write: ReturnType<typeof writeCapability>;
  shortcutsMissing: string[];
  /** The legs that WOULD put something on screen. Empty means a rerun asks nothing. */
  outstanding: SetupLeg[];
}

/**
 * What the ceremony would do, established entirely prompt-free. This is the
 * idempotence check (Article V): it is what lets a rerun skip settled legs, and
 * it is what `--dry-run` reports. Raises nothing, ever.
 */
export function surveySetup(deps: DirectSetupDeps = {}): SetupSurvey {
  const host = hostApp(deps);
  const read = readCapability({}, deps);
  const write = writeCapability(deps);
  const shortcuts = (deps.shortcutProxies ?? readShortcutProxies)();
  const outstanding: SetupLeg[] = [];
  if (read.mode !== "direct-fda" && read.mode !== "session-grant" && read.mode !== "helpers") {
    outstanding.push("read-access");
  }
  // A recorded refusal raises nothing (the dialog is spent), so it is not counted.
  if (write.mode === "direct-unknown") outstanding.push("app-control");
  if (shortcuts.missing.length > 0) outstanding.push("shortcuts");
  return {
    host: { bundleId: host.bundleId, name: hostDisplayName(deps) },
    read,
    write,
    shortcutsMissing: [...shortcuts.missing],
    outstanding,
  };
}

/**
 * Run the direct-path ceremony. Strict mode: the banner counts what is about
 * to appear, waits are bounded, and an unanswered leg leaves the run nonzero.
 */
export function directSetup(deps: DirectSetupDeps = {}): DirectSetupResult {
  const progress = deps.progress ?? ((line: string) => process.stdout.write(`${line}\n`));
  const withProgress: DirectSetupDeps = { ...deps, progress };
  const env = deps.env ?? process.env;
  const host = hostApp(withProgress);
  const hostName = hostDisplayName(withProgress);

  // Survey prompt-free BEFORE raising anything, so whoever started this knows
  // whether they must stay at the screen (Article V).
  const survey = surveySetup(withProgress);
  const readBefore = survey.read;
  const outstanding = survey.outstanding;

  progress(
    `setting up direct access for ${hostName}${host.bundleId !== null ? ` (${host.bundleId})` : ""}`,
  );
  progress(
    outstanding.length === 0
      ? "nothing to raise — every permission this machine needs is already on record"
      : `about to raise ${outstanding.length} dialog${outstanding.length === 1 ? "" : "s"} ` +
          `(${outstanding.map((leg) => PROMPT_LABELS[leg]).join(", ")}) — someone must be at the screen to answer them`,
  );

  const wizard = deps.wizard ?? createWizard();
  const willRaise = new Set(outstanding);
  /** Explain a leg's dialog and let the human pace it — wizard mode only. */
  const brief = (leg: SetupLeg): void => {
    if (willRaise.has(leg)) {
      wizard.explain(PROMPT_EXPLAINERS[leg].map((line) => line.replaceAll("{host}", hostName)));
    }
  };
  brief("read-access");
  const readStep = readAccessLeg(readBefore, withProgress);
  brief("app-control");
  const appControlStep = appControlLeg(withProgress);
  brief("shortcuts");
  const steps: SetupStep[] = [readStep, appControlStep, shortcutsLeg(withProgress)];
  const uiEnabled = loadConfig(env).ui.enabled;
  if (uiEnabled) {
    progress(
      "note: GUI-driving is enabled in config, and it is granted only to the helpers — " +
        "run `things helpers setup --gui` to onboard it",
    );
  }
  return {
    host: { bundleId: host.bundleId, name: hostName },
    steps,
    outstanding,
    denied: steps.some((s) => s.state === "denied"),
    pending: steps.some((s) => s.state === "pending"),
    closing: closingLine(steps, uiEnabled),
  };
}
