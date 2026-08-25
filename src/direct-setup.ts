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
 *  a. READ ACCESS. An explicit two-way choice, because the two answers differ in
 *     kind rather than in quality. The DEFAULT — a bare Enter — is the session
 *     grant: one deliberate container open, which raises the "would like to
 *     access data from other apps" modal, and if the open then succeeds the
 *     grant is witnessed (./session-grant.ts). It lasts only while the host app
 *     stays open, and the copy says so. Typing `f` takes Full Disk Access
 *     instead: durable, but it hands the whole disk to a general-purpose host
 *     app, so it is offered, never assumed.
 *
 *     The provoking open runs in a BOUNDED CHILD process, because macOS parks
 *     the requesting syscall in the kernel until someone answers the dialog —
 *     an in-process open would park the ceremony itself for as long as the
 *     dialog stands. MEASURED (APDP1, docs/lab/apdp1-grant-pinning.md): the
 *     app-data grant is keyed to the RESPONSIBLE APP INSTANCE, not to the pid
 *     that opened the file, so what a child provokes belongs to the host app
 *     and outlives that child — every later process under the same host app
 *     reads without a dialog. Killing the child at the deadline takes neither
 *     the dialog nor the grant away: a human who answers Allow afterwards still
 *     grants the host app, and the next run witnesses it.
 *
 *     MEASURED: FDA does NOT take effect for a running app. macOS says so in
 *     the Settings sheet itself — "…will not have full disk access until it is
 *     quit", with Later / Quit & Reopen — and the responsible process keeps its
 *     old answer for its whole life, so every child it spawns, including a
 *     rerun of `things` in the same window, still sees no FDA. There is
 *     therefore nothing for this leg to wait for: it deep-links Settings, says
 *     what to flip and that the app must relaunch, leaves the leg PENDING, and
 *     lets the remaining legs run — Automation and the shortcuts land fine in
 *     this session, so the rerun after the relaunch has only this leg left.
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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
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
import { createWizard, withDefaultInterrupts, type Wizard } from "./wizard.ts";
import { readShortcutProxies, type ShortcutsState } from "./write/availability.ts";

/** Deep link to the Full Disk Access pane. */
const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
/** Deep link to the Automation pane. */
const AUTOMATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

/** Package root — one level above src/ AND dist/, so both layouts resolve. */
const SHORTCUTS_DIR = fileURLToPath(new URL("../shortcuts", import.meta.url));

const AUTOMATION_TIMEOUT_MS = 60_000;
/** How long the read leg waits for the app-data dialog before giving up. */
const CONTAINER_OPEN_TIMEOUT_MS = 60_000;

/**
 * The bounded child's whole job: one `open(2)` against the container, then
 * exit. A dynamic import so the same source runs whether node evaluates `-e`
 * as CommonJS or as an ES module; the failure path writes ONLY the errno
 * message, because an unhandled rejection would dump a stack trace whose first
 * line is a node internal rather than the reason.
 */
const CONTAINER_OPEN_CHILD =
  'import("node:fs").then((fs) => fs.closeSync(fs.openSync(process.argv[1], "r")))' +
  ".catch((e) => { process.stderr.write(String((e && e.message) || e)); process.exit(1); });";

/**
 * The deadline passed with the app-data dialog still unanswered. Distinct from
 * a refusal: nothing was decided, the dialog is still on screen, and answering
 * it later still lands the grant on the host app (APDP1 stage A).
 */
export class ContainerOpenTimedOut extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`the app-data dialog was not answered within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "ContainerOpenTimedOut";
    this.timeoutMs = timeoutMs;
  }
}

/** The key that picks Full Disk Access over the session grant at the read leg. */
const FDA_CHOICE_KEY = "f";

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
  /**
   * Open the container database once, deliberately, to provoke the app-data
   * modal, waiting no longer than `timeoutMs` for it to be answered. Throws
   * {@link ContainerOpenTimedOut} at the deadline and any other error when the
   * open itself failed.
   */
  openContainer?: (timeoutMs: number) => void;
  /** How long the read leg waits for the app-data dialog (default 60s). */
  containerOpenTimeoutMs?: number;
  /** Open one shortcut's install sheet. */
  openShortcut?: (file: string) => void;
  /** The installed proxy-shortcut census (availability.ts). */
  shortcutProxies?: () => ShortcutsState;
  automationTimeoutMs?: number;
}

function openUrlBestEffort(url: string): void {
  try {
    execFileSync("open", [url], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // The deep link is a convenience; the written path works without it.
  }
}

/** First line of whatever a failed child wrote to stderr. */
function firstStderrLine(err: unknown): string {
  const e = err as { stderr?: unknown };
  const text =
    typeof e.stderr === "string"
      ? e.stderr
      : Buffer.isBuffer(e.stderr)
        ? e.stderr.toString("utf8")
        : err instanceof Error
          ? err.message
          : String(err);
  return text.trim().split("\n")[0] ?? "";
}

/**
 * The container open the ceremony performs on purpose. This is the ONE place
 * in the package permitted to do it blind — everywhere else the doctrine's
 * Article I corollary forbids it, because the open is what raises the modal.
 *
 * It runs in a CHILD process so the wait has a deadline (see the read-access
 * note at the top of this file): macOS holds the open in the kernel for as long
 * as the dialog stands, and the grant it lands belongs to the host app rather
 * than to the pid that asked, so nothing is lost by giving up on the child.
 */
function openContainerDefault(timeoutMs: number): void {
  const path = locateThingsDb().path;
  try {
    execFileSync(process.execPath, ["-e", CONTAINER_OPEN_CHILD, path], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean; signal?: string | null };
    // spawnSync reports a deadline kill as ETIMEDOUT, as `killed`, or as the
    // kill signal itself, depending on where it noticed — all three mean the
    // dialog outlived the wait.
    if (e.code === "ETIMEDOUT" || e.killed === true || e.signal === "SIGKILL") {
      throw new ContainerOpenTimedOut(timeoutMs);
    }
    throw new Error(firstStderrLine(err) || "the container could not be opened", { cause: err });
  }
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

/**
 * The two ways to read, offered as a choice rather than a ranking. Enter takes
 * the session grant; `f` takes Full Disk Access, which is the wider grant and
 * the one that costs the human a relaunch.
 *
 * The Enter line states what the session grant actually buys, as MEASURED
 * (APDP1): one Allow covers every process under this host app — this window,
 * other tabs and windows, and anything they spawn — until the app quits. Under
 * tmux that app is the one that first started the tmux server rather than
 * whatever window you are attached from, because macOS fixes responsibility at
 * spawn and it survives re-parenting; the caveat is printed only when `TMUX`
 * says so, and nothing is detected to produce it.
 */
function readAccessChoice(hostName: string, env: NodeJS.ProcessEnv): string[] {
  const lines = [
    "Next: read access to your Things data — two ways:",
    `  Enter  allow while ${hostName} runs: one dialog now, then every command under`,
    `         ${hostName} — any tab, window, or agent it spawns — reads without asking,`,
    `         until ${hostName} quits`,
    `  f      Full Disk Access: durable, but grants ${hostName} broad file access —`,
    `         flip it in System Settings, then ${hostName} must quit and reopen`,
  ];
  if ((env["TMUX"] ?? "") !== "") {
    lines.push(
      `  note: inside tmux the grant belongs to the app that started the tmux server, and`,
      `        lasts until THAT app quits — not the window you are attached from`,
    );
  }
  return lines;
}

/**
 * The `f` branch. Nothing here waits: FDA reaches a process only through a
 * relaunch, so the leg hands over the three steps and goes pending. The
 * remaining legs still run — their grants land in THIS session — so the rerun
 * after the relaunch has only this one left.
 */
function fdaBranch(
  base: { leg: "read-access"; label: string },
  hostName: string,
  deps: DirectSetupDeps,
): SetupStep {
  const progress = deps.progress ?? (() => {});
  (deps.openUrl ?? openUrlBestEffort)(FDA_SETTINGS_URL);
  progress(
    `read access: 1. turn on ${hostName} under System Settings ▸ Privacy & Security ▸ Full Disk Access`,
  );
  progress(
    `read access: 2. click "Quit & Reopen" when macOS offers it, or quit ${hostName} yourself`,
  );
  progress("read access: 3. run `things setup` again in the new window to confirm it");
  progress("read access: the rest of the setup continues now — those grants land in this session");
  return {
    ...base,
    state: "pending",
    alreadySatisfied: false,
    detail:
      `Full Disk Access takes effect after ${hostName} relaunches — turn it on, quit and ` +
      `reopen ${hostName}, then rerun \`things setup\``,
  };
}

/**
 * The default branch: provoke the app-data modal on purpose and record the
 * grant only if the open then actually succeeded. The wait is BOUNDED — the
 * open runs in a child process the ceremony can give up on, and giving up
 * costs nothing, because a dialog answered afterwards still grants the host
 * app (APDP1).
 */
function sessionGrantBranch(
  base: { leg: "read-access"; label: string },
  hostName: string,
  deps: DirectSetupDeps,
): SetupStep {
  const progress = deps.progress ?? (() => {});
  progress(
    `read access: asking now — a dialog asks whether ${hostName} may access data from ` +
      "other apps; click Allow",
  );
  const host = hostApp(deps);
  try {
    (deps.openContainer ?? openContainerDefault)(
      deps.containerOpenTimeoutMs ?? CONTAINER_OPEN_TIMEOUT_MS,
    );
  } catch (err) {
    clearSessionGrant(deps.env ?? process.env);
    if (err instanceof ContainerOpenTimedOut) {
      // Nothing was decided and the dialog is still up: say so, because the
      // human's next click still lands the grant on this same host app.
      progress("read access: no answer yet — the dialog is still on screen");
      return {
        ...base,
        state: "pending",
        alreadySatisfied: false,
        detail:
          `the dialog is still waiting — click Allow and rerun \`things setup\` to confirm it, ` +
          "choose Full Disk Access at the read step instead, or run `things helpers setup` to " +
          "let a helper hold the grant",
      };
    }
    const why = err instanceof Error ? err.message : String(err);
    progress(`read access: still no access — ${why}`);
    return {
      ...base,
      state: "pending",
      alreadySatisfied: false,
      // The open failed. Usually that is a Don't Allow — which then stands for
      // the whole run of this app, every later open failing instantly with no
      // second dialog (APDP1 stage B) — but the errno could also be something
      // else entirely, so the copy hedges the cause and states the remedy.
      detail:
        `no read access yet — if the dialog was refused, that answer stands for the rest of ` +
        `this ${hostName} run and macOS will not ask again, so quit and reopen ${hostName} to ` +
        "be asked; or choose Full Disk Access at the read step, or run `things helpers setup` " +
        "to let a helper hold the grant",
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
        "grant could be tied to — choose Full Disk Access instead, or run `things helpers setup`",
    };
  }
  progress(
    `read access: granted — every command under ${hostName}, in any tab or window, reads ` +
      `without asking until ${hostName} quits`,
  );
  return {
    ...base,
    state: "granted",
    alreadySatisfied: false,
    detail:
      `every command running under ${hostName} — any tab, window, or agent it spawns — may ` +
      `read the Things data folder until ${hostName} quits. Full Disk Access makes it ` +
      "permanent; `things helpers setup` moves it onto a helper that keeps it across restarts",
  };
}

function readAccessLeg(
  capability: ReadCapability,
  choice: string,
  deps: DirectSetupDeps,
): SetupStep {
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
    progress(
      `read access: already granted — every command under ${hostName} reads without asking ` +
        `until ${hostName} quits`,
    );
    return { ...base, state: "granted", alreadySatisfied: true, detail: capability.detail };
  }
  // Nothing on record: the human's choice decides which grant this leg gathers.
  return choice === FDA_CHOICE_KEY
    ? fdaBranch(base, hostName, deps)
    : sessionGrantBranch(base, hostName, deps);
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

/**
 * What each leg puts on screen, for the upfront banner. Named flatly, in the
 * order the ceremony raises them — one clause each, no parenthetical asides.
 */
function promptLabel(leg: SetupLeg, hostName: string): string {
  switch (leg) {
    case "read-access":
      return `data access for ${hostName}`;
    case "app-control":
      return "app control of Things";
    case "shortcuts":
      return "one install sheet per missing shortcut";
  }
}

/** "a", "a and b", "a, b, and c" — the banner reads as a sentence. */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * What the human is about to see, in the words macOS will actually use — the
 * wizard prints these one leg ahead of the dialog (Article V, mode-aware). In
 * strict mode they are never printed; the upfront banner's count stands alone.
 * `{host}` is filled with the detected host app's display name. The read leg is
 * absent because it is a CHOICE rather than an announcement — see
 * {@link readAccessChoice}.
 */
const PROMPT_EXPLAINERS: Record<Exclude<SetupLeg, "read-access">, string[]> = {
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
 *
 * Runs under {@link withDefaultInterrupts} for its whole synchronous span, so
 * a Ctrl-C at a gate — or during a leg's bounded wait — actually stops it
 * (./wizard.ts, "Why a ceremony runs with the DEFAULT signal disposition").
 * Throws {@link CeremonyStopped} when the human stops at a gate.
 */
export function directSetup(deps: DirectSetupDeps = {}): DirectSetupResult {
  return withDefaultInterrupts(() => runCeremony(deps));
}

function runCeremony(deps: DirectSetupDeps): DirectSetupResult {
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
      : `about to raise ${outstanding.length} dialog${outstanding.length === 1 ? "" : "s"} — ` +
          `${listPhrase(outstanding.map((leg) => promptLabel(leg, hostName)))}. ` +
          "Someone must be at the screen.",
  );

  const wizard = deps.wizard ?? createWizard();
  const willRaise = new Set(outstanding);
  /** Explain a leg's dialog and let the human pace it — wizard mode only. */
  const brief = (leg: Exclude<SetupLeg, "read-access">): void => {
    if (willRaise.has(leg)) {
      wizard.explain(PROMPT_EXPLAINERS[leg].map((line) => line.replaceAll("{host}", hostName)));
    }
  };
  // The read leg is the one CHOICE in the ceremony: Enter takes the session
  // grant, `f` takes Full Disk Access. Strict mode answers "" without asking,
  // which is the session grant — the only one an absent human can still get.
  const readChoice = willRaise.has("read-access")
    ? wizard.choose(readAccessChoice(hostName, env), [FDA_CHOICE_KEY])
    : "";
  const readStep = readAccessLeg(readBefore, readChoice, withProgress);
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
