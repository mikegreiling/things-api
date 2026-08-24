/**
 * things-helpers lifecycle: install/uninstall the launchd LaunchAgents for
 * both helper halves, restart them, run the reader's grant ceremony, and
 * report status. launchd owns both processes end-to-end (RunAtLoad +
 * KeepAlive) — there is never a detached or self-daemonized process, and a
 * crashed helper relaunches with its identity (and therefore its macOS
 * permission grants) intact.
 *
 * Both halves ship inside ONE bundle (Things API Helper.app): things-deputy
 * (automation, unsandboxed) is the bundle's main executable and the sandboxed
 * things-reader.app nests under Contents/Helpers with its own bundle identity
 * — that identity (com.pixelcog.things-reader) keys the user's security-scoped
 * bookmark grant and must never change.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, saveConfigKey, type HelpersMode } from "../config.ts";
import { THINGS_GROUP_CONTAINER } from "../db/locate.ts";
import { createWizard, withDefaultInterrupts, type Wizard } from "../wizard.ts";
import { EXPECTED_PROXIES } from "../write/availability.ts";
import { DeputySyncBridge } from "./bridge.ts";
import {
  DEPUTY_LAUNCHD_LABEL,
  HELPERS_BUNDLE_ID,
  READER_LAUNCHD_LABEL,
  DEPUTY_PROTOCOL_VERSION,
  type DeputyHello,
  type DeputyOsaResult,
  DeputyRequestError,
  type ReaderHello,
  deputyInstalledBinaryPath,
  deputySocketPath,
  deputyStateDir,
  deputyTokenPath,
  EXPECTED_HELPERS_VERSION,
  helpersInstallDir,
  helpersInstalledBundlePath,
  readerContainerDir,
  readerInstalledAppPath,
  readerSocketPath,
  readerTokenPath,
} from "./protocol.ts";

export function deputyPlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${DEPUTY_LAUNCHD_LABEL}.plist`);
}

export function readerPlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${READER_LAUNCHD_LABEL}.plist`);
}

/**
 * Where an install looks for the bundle when the caller names no path, in
 * preference order: `deputy/prebuilt` — the signed + notarized bundle the
 * release workflow stages into the published tarball, so an npm install needs
 * neither Xcode nor a certificate — then `deputy/build`, the output of
 * scripts/build-helpers.sh in a source checkout.
 */
export function helpersBundleCandidates(): string[] {
  return [
    fileURLToPath(new URL("../../deputy/prebuilt/Things API Helper.app", import.meta.url)),
    fileURLToPath(new URL("../../deputy/build/Things API Helper.app", import.meta.url)),
  ];
}

/**
 * The first candidate bundle that carries a deputy executable; null when none
 * does. Both candidates are READ only — nothing in the `things helpers` path
 * ever writes inside the package directory, so the CLI works from a read-only
 * package root (an npx cache); BUILDING a bundle there is the one operation
 * that needs a writable checkout, and `--bundle <path>` covers a prebuilt one.
 */
export function helpersDefaultBuildPath(): string | null {
  return (
    helpersBundleCandidates().find((path) =>
      existsSync(join(path, "Contents/MacOS/things-deputy")),
    ) ?? null
  );
}

/**
 * The INSTALLED bundle's version, read prompt-free from its Info.plist
 * (CFBundleShortVersionString, stamped from deputy/VERSION at build time).
 * Null when nothing is installed or the plist is unreadable/unstamped. This is
 * the version a passive upgrade notice compares against
 * {@link EXPECTED_HELPERS_VERSION} without needing a running helper.
 */
export function installedHelpersVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const plist = join(helpersInstalledBundlePath(env), "Contents/Info.plist");
  try {
    const xml = readFileSync(plist, "utf8");
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
    const value = match?.[1]?.trim();
    return value !== undefined && value !== "" ? value : null;
  } catch {
    return null;
  }
}

function readerLaunchTarget(): string {
  return `gui/${process.getuid?.() ?? 501}/${READER_LAUNCHD_LABEL}`;
}

function readerExecPath(appPath: string): string {
  return join(appPath, "Contents/MacOS/things-reader");
}

function renderReaderPlist(appPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${READER_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${readerExecPath(appPath)}</string>
    <string>--serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- Background Task Management groups the login item under the helper
       bundle's display name ("Things API Helper") instead of the signing
       certificate's personal name. -->
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${HELPERS_BUNDLE_ID}</string>
  </array>
</dict>
</plist>
`;
}

function launchTarget(): string {
  return `gui/${process.getuid?.() ?? 501}/${DEPUTY_LAUNCHD_LABEL}`;
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  try {
    // stderr must be captured, never inherited: a routine negative probe
    // ("Could not find service … in domain") is a state we REPORT, not noise
    // the child gets to print over our own output.
    //
    // The timeout must clear the helpers' DRAIN bound: `bootout`/`kickstart -k`
    // block until the old process exits, and a helper with a request in flight
    // takes up to HELPERS_DRAIN_TIMEOUT_MS to finish it before exiting.
    const output = execFileSync("launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? "failed") };
  }
}

function renderPlist(binaryPath: string, stateDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DEPUTY_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>--state-dir</string>
    <string>${stateDir}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!-- Interactive: the deputy fronts GUI accessibility work; keep it out of
       background-QoS throttling so drives stay as fast as direct execution. -->
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardErrorPath</key>
  <string>${stateDir}/deputy.stderr.log</string>
  <!-- Background Task Management groups the login item under the helper
       bundle's display name ("Things API Helper") instead of the signing
       certificate's personal name. -->
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${HELPERS_BUNDLE_ID}</string>
  </array>
</dict>
</plist>
`;
}

export interface DeputySigning {
  state: "signed" | "adhoc" | "unsigned" | "unknown";
  authority: string | null;
}

/** codesign facts about a binary (diagnostic output — may name mechanisms). */
export function deputySigningInfo(binaryPath: string): DeputySigning {
  // spawnSync, not execFileSync: codesign prints its details on STDERR while
  // exiting 0, and execFileSync only surfaces stderr on the failure path — the
  // success case must read both streams.
  const res = spawnSync("codesign", ["-dvv", binaryPath], { encoding: "utf8", timeout: 10_000 });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.error !== undefined || out === "") return { state: "unknown", authority: null };
  if (/not signed at all/i.test(out)) return { state: "unsigned", authority: null };
  if (/Signature=adhoc/i.test(out)) return { state: "adhoc", authority: null };
  const authority = /Authority=(.+)/.exec(out)?.[1]?.trim() ?? null;
  return authority !== null
    ? { state: "signed", authority }
    : { state: "unknown", authority: null };
}

export interface HelpersInstallResult {
  bundlePath: string;
  plistPath: string;
  stateDir: string;
  signing: DeputySigning;
  readerInstalled: boolean;
  /** Reader grant state after install: null when the reader is absent or never answered. */
  readerGranted: boolean | null;
  warnings: string[];
}

/** One handshake against the reader's socket; null when it cannot complete. */
function readerHelloProbe(env: NodeJS.ProcessEnv): ReaderHello | null {
  const socketPath = readerSocketPath(env);
  const tokenPath = readerTokenPath(env);
  if (!existsSync(socketPath) || !existsSync(tokenPath)) return null;
  const token = readFileSync(tokenPath, "utf8").trim();
  const bridge = new DeputySyncBridge(socketPath);
  try {
    const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
    return res["ok"] === true ? (res as unknown as ReaderHello) : null;
  } catch {
    return null;
  } finally {
    bridge.close();
  }
}

/**
 * Install (or reinstall) the helpers: copy the built bundle to its stable
 * path, write both LaunchAgent plists, and (re)bootstrap them under launchd.
 */
export function installHelpers(
  options: { bundlePath?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): HelpersInstallResult {
  const source = options.bundlePath ?? helpersDefaultBuildPath();
  if (source === null) {
    throw new Error(
      `helpers bundle not found — looked for ${helpersBundleCandidates().join(" and ")}. ` +
        `Build it first: bash scripts/build-helpers.sh`,
    );
  }
  if (!existsSync(join(source, "Contents/MacOS/things-deputy"))) {
    throw new Error(
      `helpers bundle not found at ${source} — build it first: bash scripts/build-helpers.sh`,
    );
  }
  const readerInBuild = existsSync(join(source, "Contents/Helpers/things-reader.app"));
  const installDir = helpersInstallDir(env);
  const bundlePath = helpersInstalledBundlePath(env);
  const stateDir = deputyStateDir(env);

  // Stop both halves before replacing the bundle (ignore "not loaded"), then
  // recreate the install dir from scratch: install owns bin/ WHOLESALE — a
  // fresh copy every time erases any previous layout without migration logic
  // and resets the kernel's per-vnode code-signature cache.
  launchctl(["bootout", launchTarget()]);
  launchctl(["bootout", readerLaunchTarget()]);
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  cpSync(source, bundlePath, { recursive: true });

  const plistPath = deputyPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderPlist(deputyInstalledBinaryPath(env), stateDir));

  const warnings: string[] = [];
  const boot = launchctl(["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath]);
  if (!boot.ok) {
    warnings.push(`launchctl bootstrap failed: ${boot.output.trim()}`);
  }
  const signing = deputySigningInfo(deputyInstalledBinaryPath(env));
  if (signing.state !== "signed") {
    warnings.push(
      `bundle is ${signing.state} — macOS permission grants will NOT survive rebuilds. ` +
        `Mint the persistent certificate once (scripts/deputy-cert-setup.sh), rebuild, reinstall.`,
    );
  }

  let readerGranted: boolean | null = null;
  if (readerInBuild) {
    const readerPlist = readerPlistPath();
    writeFileSync(readerPlist, renderReaderPlist(readerInstalledAppPath(env)));
    const readerBoot = launchctl(["bootstrap", `gui/${process.getuid?.() ?? 501}`, readerPlist]);
    if (!readerBoot.ok) {
      warnings.push(`reader launchctl bootstrap failed: ${readerBoot.output.trim()}`);
    } else {
      // Report the ACTUAL grant state instead of a "run it if you have not"
      // hedge — the reader knows, so ask it (bounded: it just booted).
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const hello = readerHelloProbe(env);
        if (hello !== null) {
          readerGranted = hello.granted === true;
          break;
        }
        syncSleepMs(250);
      }
    }
  } else {
    warnings.push(
      "the bundle was built without things-reader (no Apple-issued signing identity?) — file reads run direct. Build with an Apple-chain identity, reinstall, then run `things helpers setup`.",
    );
  }
  return {
    bundlePath,
    plistPath,
    stateDir,
    signing,
    readerInstalled: readerInBuild,
    readerGranted,
    warnings,
  };
}

/**
 * The LaunchServices registration tool. `tccutil` addresses grants by BUNDLE
 * IDENTIFIER and resolves that identifier through LaunchServices, so on a
 * machine where the bundle is already gone it refuses with -10814 and the
 * dormant grant rows stay put. Handing LaunchServices the PACKAGED bundle
 * (`lsregister -f -R "<bundle>"`) makes both identities — the helper and the
 * reader nested inside it — resolvable again, after which the resets succeed.
 * Measured on a live host, 2026-08-24.
 */
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface HelpersRevocation {
  /** One row per macOS permission-store reset attempted. */
  tccResets: { target: string; ok: boolean; detail: string }[];
  /**
   * What made the identifiers resolvable for `tccutil`: the bundle this
   * machine had installed, the packaged bundle registered on the spot, or
   * nothing at all (the grants cannot be addressed from here).
   */
  resolvedVia: "installed" | "packaged" | "none";
  /** The packaged bundle handed to LaunchServices, when that path was taken. */
  registeredBundle: string | null;
  /** The one leg no tool can perform — surfaced, never silently skipped. */
  shortcutsNote: string;
}

export interface HelpersUninstallResult {
  /** Files/directories that existed and were removed. */
  removed: string[];
  /** Null unless revocation was asked for. */
  revocation: HelpersRevocation | null;
  warnings: string[];
}

export interface HelpersUninstallOptions {
  /**
   * Also revoke both identities' macOS permission grants and delete their
   * local state (the reader's bookmark container, the deputy's tokens/logs).
   */
  revoke?: boolean;
}

export interface HelpersUninstallDeps {
  /** External tool runner (test seam — a real `tccutil` revokes live grants). */
  runTool?: (bin: string, args: string[]) => { ok: boolean; output: string };
  /** Where a packaged bundle lives for the LaunchServices fallback. */
  packagedBundlePath?: () => string | null;
}

function runToolDefault(bin: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? "failed") };
  }
}

/**
 * Revoke both helper identities' TCC grants (`tccutil reset All` per bundle
 * identity — Automation, Accessibility, and every other class keyed to them).
 *
 * Called BEFORE anything is torn down, because `tccutil` resolves the
 * identifier through LaunchServices and refuses with -10814
 * (kLSApplicationNotFoundErr) once no app on disk carries it. When the
 * installed bundle is already gone, the packaged one is registered first
 * ({@link LSREGISTER}) and left registered — the file legitimately exists, so
 * un-registering it would be a lie about the machine. With no bundle anywhere
 * the resets still run (LaunchServices may hold an older registration) and a
 * -10814 is reported as the honest limit it is.
 */
function revokeGrants(
  env: NodeJS.ProcessEnv,
  deps: HelpersUninstallDeps,
  warnings: string[],
): HelpersRevocation {
  const runTool = deps.runTool ?? runToolDefault;
  const packagedBundlePath = deps.packagedBundlePath ?? helpersDefaultBuildPath;
  let resolvedVia: HelpersRevocation["resolvedVia"] = "installed";
  let registeredBundle: string | null = null;
  if (!existsSync(deputyInstalledBinaryPath(env))) {
    const packaged = packagedBundlePath();
    if (packaged === null) {
      resolvedVia = "none";
    } else {
      const res = runTool(LSREGISTER, ["-f", "-R", packaged]);
      if (res.ok) {
        resolvedVia = "packaged";
        registeredBundle = packaged;
      } else {
        resolvedVia = "none";
        warnings.push(
          `could not register ${packaged} with LaunchServices: ${res.output.trim() || "unknown"}`,
        );
      }
    }
  }
  const tccResets: HelpersRevocation["tccResets"] = [];
  for (const target of [HELPERS_BUNDLE_ID, READER_LAUNCHD_LABEL]) {
    const res = runTool("/usr/bin/tccutil", ["reset", "All", target]);
    const noApp = !res.ok && /No such bundle identifier|-10814/.test(res.output);
    tccResets.push({
      target,
      ok: res.ok || noApp,
      detail: res.ok
        ? res.output.trim() || "reset"
        : noApp
          ? resolvedVia === "none"
            ? "no app carries this identifier and none is packaged here — reinstall the helpers, or clear the grants in System Settings ▸ Privacy & Security"
            : "no app registered under this identifier — nothing to revoke"
          : res.output.trim() || "failed",
    });
    if (!res.ok && !noApp) {
      warnings.push(`tccutil reset All ${target} failed: ${res.output.trim() || "unknown"}`);
    }
  }
  return {
    tccResets,
    resolvedVia,
    registeredBundle,
    shortcutsNote:
      "the bundled things-proxy-* shortcuts cannot be removed by any tool — delete them by hand in Shortcuts.app if a truly fresh machine is wanted (`things setup` re-imports them)",
  };
}

/**
 * Stop both halves and remove their LaunchAgents + the installed bundle.
 *
 * By default the macOS grants and the local state (tokens, logs, the reader's
 * bookmark) are KEPT: the TCC rows are keyed to the two signing identities and
 * simply go dormant, so a later reinstall picks them straight back up with no
 * second ceremony. `revoke` turns this into the ceremony's full inverse —
 * grants revoked first (see {@link revokeGrants}), then the uninstall, then the
 * reader's container and the deputy's state dir deleted (the read grant is a
 * bookmark FILE, not a TCC row, so revoking it means deleting it).
 *
 * Every leg is independent and IDEMPOTENT: an already-uninstalled helper, an
 * empty permission store, and absent directories are all fine — each leg does
 * whatever is still outstanding, so this works from any partial state and a
 * second run is an all-no-op.
 */
export function uninstallHelpers(
  options: HelpersUninstallOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  deps: HelpersUninstallDeps = {},
): HelpersUninstallResult {
  const warnings: string[] = [];
  const revoke = options.revoke === true;
  // Revocation runs while the installed bundle (if any) still resolves.
  const revocation = revoke ? revokeGrants(env, deps, warnings) : null;
  const removed: string[] = [];
  launchctl(["bootout", launchTarget()]);
  launchctl(["bootout", readerLaunchTarget()]);
  for (const path of [deputyPlistPath(), readerPlistPath()]) {
    if (existsSync(path)) {
      rmSync(path);
      removed.push(path);
    }
  }
  const installDir = helpersInstallDir(env);
  if (existsSync(installDir)) {
    rmSync(installDir, { recursive: true });
    removed.push(installDir);
  }
  if (revoke) {
    for (const dir of [readerContainerDir(env), deputyStateDir(env)]) {
      if (existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        } catch (err) {
          warnings.push(
            `could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
  return { removed, revocation, warnings };
}

/** Restart the launchd-managed helpers (picks up a rebuilt installed bundle). */
export function restartHelpers(): void {
  const res = launchctl(["kickstart", "-k", launchTarget()]);
  if (!res.ok) {
    throw new Error(
      `launchctl kickstart failed (${res.output.trim() || "unknown"}) — are the helpers installed? Run: things helpers setup`,
    );
  }
  // Reader restart is best-effort: it may legitimately not be installed.
  launchctl(["kickstart", "-k", readerLaunchTarget()]);
}

/**
 * The one-time grant ceremony: open the reader in `--grant` mode (the panel
 * must be presented by the SANDBOXED process — that is what makes the grant
 * durable) and wait for the bookmark to land, confirmed via the reader's
 * handshake. The panel opens INSIDE the Things data folder when it exists, so
 * accepting is the only click. Interactive by design; returns when granted or
 * on timeout, and verifies the database actually resolves inside the granted
 * scope so a wrong-folder grant reports loudly instead of half-working.
 */
export function grantReader(env: NodeJS.ProcessEnv = process.env): {
  granted: boolean;
  detail: string;
} {
  const appPath = readerInstalledAppPath(env);
  if (!existsSync(appPath)) {
    return {
      granted: false,
      detail: "things-reader is not installed — run `things helpers setup` first",
    };
  }
  const thingsContainer = join(homedir(), THINGS_GROUP_CONTAINER);
  const startDir = existsSync(thingsContainer)
    ? thingsContainer
    : join(homedir(), "Library/Group Containers");
  try {
    execFileSync("open", ["-W", appPath, "--args", "--grant", startDir], {
      stdio: "ignore",
      timeout: 300_000,
    });
  } catch (err) {
    return {
      granted: false,
      detail: `could not open the grant panel: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // The serving reader re-checks its bookmark per request — no restart needed.
  const socketPath = readerSocketPath(env);
  const tokenPath = readerTokenPath(env);
  const deadline = Date.now() + 15_000;
  let detail = "the reader is not running — `things helpers status`";
  while (Date.now() < deadline) {
    if (existsSync(socketPath) && existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, "utf8").trim();
      const bridge = new DeputySyncBridge(socketPath);
      try {
        const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
        if (res["ok"] === true && (res as { granted?: boolean }).granted === true) {
          const locate = bridge.request(
            { v: DEPUTY_PROTOCOL_VERSION, token, verb: "locate" },
            5000,
          );
          bridge.close();
          if (locate["ok"] === true) return { granted: true, detail: "granted" };
          return {
            granted: false,
            detail:
              "the grant landed, but the Things database was not found inside the granted folder — rerun `things helpers setup` and grant the Things data folder",
          };
        }
        detail = "the panel closed but no grant landed (canceled?) — rerun `things helpers setup`";
      } catch {
        detail = "the reader socket is not answering — `things helpers status`";
      } finally {
        bridge.close();
      }
    }
    syncSleepMs(500);
  }
  return { granted: false, detail };
}

function syncSleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// The onboarding ceremony (docs/design/helpers-onboarding.md)
// ---------------------------------------------------------------------------

/** How long a consent dialog may stay unanswered before the leg is left pending. */
const AUTOMATION_PROMPT_TIMEOUT_MS = 120_000;
/** How long the Accessibility toggle is waited for, and how often it is re-read. */
const AX_WAIT_TIMEOUT_MS = 120_000;
const AX_POLL_INTERVAL_MS = 2000;
/** The deputy kills its child at timeoutMs; the client deadline adds grace. */
const CLIENT_GRACE_MS = 5000;
/**
 * How long the ceremony waits for the deputy's socket. `setup` installs first,
 * which boots the launchd jobs out and back in, so the socket is legitimately
 * absent for a moment when the ceremony opens its channel.
 */
const DEPUTY_SOCKET_WAIT_MS = 15_000;

const AX_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export type OnboardLeg =
  | "reader-read-grant"
  | "automation-things"
  | "automation-system-events"
  | "accessibility"
  | "shortcuts";

/**
 * Which TIER a leg belongs to (docs/design/permissions-doctrine.md, Article V).
 * The BASE tier gathers read + write capability, which is what every consumer
 * of this package needs. The GUI tier adds the two grants that let the helpers
 * drive the Things WINDOW — Accessibility and Automation → System Events — and
 * is only gathered when it was asked for, because those two are the widest
 * grants the pair ever holds and most households never need them.
 */
export type OnboardTier = "base" | "gui";

/** Which tier each leg belongs to. */
const LEG_TIER: Record<OnboardLeg, OnboardTier> = {
  "reader-read-grant": "base",
  "automation-things": "base",
  "automation-system-events": "gui",
  accessibility: "gui",
  shortcuts: "base",
};

/**
 * Where a leg stands after the ceremony. `pending` is a HUMAN-pace outcome (a
 * dialog left unanswered, a toggle not yet flipped) and is not a failure —
 * rerunning resumes exactly where it stopped. Only `denied` means macOS (or
 * the user) refused, and only that makes the command exit nonzero.
 */
export type OnboardState = "granted" | "denied" | "pending" | "skipped-not-installed";

export interface OnboardStep {
  leg: OnboardLeg;
  /** The row label in the closing report. */
  label: string;
  /** The tier this leg belongs to — `gui` legs run only when that tier is in. */
  tier: OnboardTier;
  state: OnboardState;
  /** True when the leg was already satisfied, detected without raising anything. */
  alreadyGranted: boolean;
  detail: string;
}

export interface HelpersOnboardResult {
  /** The tier this run gathered: `base`, or `gui` (base plus the GUI legs). */
  tier: OnboardTier;
  /**
   * How the GUI tier came to be included: the `--gui` flag, the `ui-enabled`
   * config key already being on, the wizard's interactive question, or not at
   * all. Reported so the ceremony's own output can say why it did what it did.
   */
  guiRequestedBy: "flag" | "config" | "wizard" | null;
  /** True when this run turned `ui-enabled` on as part of a successful GUI tier. */
  uiEnabledSet: boolean;
  steps: OnboardStep[];
  /**
   * The legs that were going to put something on screen, surveyed prompt-free
   * BEFORE the first one ran. Empty means the ceremony raised nothing.
   */
  outstanding: OnboardLeg[];
  /** Any leg refused. */
  denied: boolean;
  /** Any leg still waiting on a human. */
  pending: boolean;
  /** The single closing line printed under the report. */
  closing: string;
}

/** The deputy transport the ceremony drives (a test seam — see {@link OnboardDeps}). */
export interface OnboardChannel {
  hello(): DeputyHello;
  request(fields: Record<string, unknown>, timeoutMs: number): Record<string, unknown>;
  close(): void;
}

export interface OnboardDeps {
  /** One line per step, as it happens. Default: stdout. */
  progress?: (line: string) => void;
  channel?: OnboardChannel;
  /** Reader state, prompt-free: granted bookmark AND a database inside it. */
  readerProbe?: () => { granted: boolean; locates: boolean } | null;
  /** The reader's panel ceremony (default: {@link grantReader}). */
  grant?: () => { granted: boolean; detail: string };
  /** Best-effort deep link into System Settings. Default: `open <url>`. */
  openUrl?: (url: string) => void;
  sleep?: (ms: number) => void;
  now?: () => number;
  automationTimeoutMs?: number;
  axTimeoutMs?: number;
  axIntervalMs?: number;
  /** How long to wait for the deputy's socket to appear (a just-installed helper is still coming up). */
  deputyWaitMs?: number;
  /**
   * The Article V wizard. Default: built from TTY-ness (../wizard.ts). At a TTY
   * it explains each dialog before the leg raises it and asks the tier question;
   * off a TTY every method is inert and the ceremony behaves exactly as it did
   * before the wizard existed.
   */
  wizard?: Wizard;
  /** Is `ui-enabled` already on? Default: the stored config. */
  uiEnabled?: () => boolean;
  /** Turn `ui-enabled` on after a successful GUI tier. Default: the config file. */
  setUiEnabled?: (value: boolean) => void;
}

/** What `onboardHelpers` is being asked to gather. */
export interface OnboardOptions {
  /** The configured routing mode, for the closing line. */
  mode: HelpersMode;
  /**
   * Gather the GUI tier as well (`things helpers setup --gui`). When omitted,
   * the tier is still included if `ui-enabled` is already on (a machine that
   * has opted into GUI-driving is asking for the grants by definition), or if
   * the wizard's interactive question is answered yes.
   */
  gui?: boolean;
}

/** A live sync bridge to the deputy socket, independent of the routing config. */
function openDeputyChannel(env: NodeJS.ProcessEnv, waitMs: number): OnboardChannel {
  const socketPath = deputySocketPath(env);
  const tokenPath = deputyTokenPath(env);
  const up = (): boolean => existsSync(socketPath) && existsSync(tokenPath);
  const deadline = Date.now() + waitMs;
  while (!up() && Date.now() < deadline) syncSleepMs(250);
  if (!up()) {
    throw new Error(
      `the deputy is not running (no socket at ${socketPath}) — \`things helpers status\` to inspect`,
    );
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  const bridge = new DeputySyncBridge(socketPath);
  const request = (fields: Record<string, unknown>, timeoutMs: number): Record<string, unknown> => {
    const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, ...fields }, timeoutMs);
    if (res["ok"] === true) return res;
    const err = res["error"] as { code?: string; message?: string } | undefined;
    throw new DeputyRequestError(err?.code ?? "internal", err?.message ?? "the deputy refused");
  };
  return {
    hello: () => request({ verb: "hello" }, 5000) as unknown as DeputyHello,
    request,
    close: () => {
      bridge.close();
    },
  };
}

/** Reader handshake + a `locate` inside the granted scope, on one connection. */
function readerProbeDefault(env: NodeJS.ProcessEnv): { granted: boolean; locates: boolean } | null {
  const socketPath = readerSocketPath(env);
  const tokenPath = readerTokenPath(env);
  if (!existsSync(socketPath) || !existsSync(tokenPath)) return null;
  const token = readFileSync(tokenPath, "utf8").trim();
  const bridge = new DeputySyncBridge(socketPath);
  try {
    const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
    if (res["ok"] !== true) return null;
    const granted = (res as { granted?: boolean }).granted === true;
    if (!granted) return { granted: false, locates: false };
    const locate = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "locate" }, 5000);
    return { granted: true, locates: locate["ok"] === true };
  } catch {
    return null;
  } finally {
    bridge.close();
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * Both ways out of a denial, always named together. macOS will not show the
 * Automation dialog again once it has been refused, so the choices are the
 * System Settings switch or re-arming the dialog by clearing the recorded
 * refusal. The ceremony NEVER clears a denial itself — that is the user's call.
 */
function deniedRemediation(settingsName: string): string {
  return (
    `turn on Things API Helper under System Settings ▸ Privacy & Security ▸ Automation ▸ ${settingsName}, ` +
    `or re-arm the dialog with \`tccutil reset AppleEvents ${HELPERS_BUNDLE_ID}\`, then rerun \`things helpers setup\``
  );
}

/**
 * One Automation leg: skipped when the deputy already reports the target
 * granted, otherwise a benign AppleEvent sent THROUGH the deputy — the request
 * blocks while the consent dialog is up, so answering it right there is what
 * completes the leg. The event auto-launches its target, which is intended:
 * macOS has no consent record to hand out while the target is down.
 *
 * The probe script MUST dispatch a real Apple event. A handful of
 * application-object properties (`version`, `name`, `id`, `running`) are
 * answered locally by the AppleScript runtime from the target's bundle —
 * no event leaves the process, so no consent dialog is raised and no grant
 * is minted, while the script still exits 0. That exact false positive
 * shipped in the first ceremony (probe was `version`; the "granted" leg had
 * granted nothing), which is also why a 0 exit alone is no longer believed:
 * the leg re-reads the deputy's own AEDeterminePermission verdict afterwards
 * and only reports what macOS reports. An old deputy whose hello carries no
 * automation fields cannot be re-read — there the 0 exit stands, best effort.
 */
function automationLeg(
  channel: OnboardChannel,
  spec: { leg: OnboardLeg; label: string; script: string; settingsName: string },
  known: string | undefined,
  recheck: () => string | undefined,
  timeoutMs: number,
  progress: (line: string) => void,
): OnboardStep {
  const base = { leg: spec.leg, label: spec.label, tier: LEG_TIER[spec.leg] };
  if (known === "granted") {
    progress(`${spec.label}: already granted`);
    return { ...base, state: "granted", alreadyGranted: true, detail: "already granted" };
  }
  if (known === "denied") {
    progress(`${spec.label}: denied — the dialog cannot be raised again`);
    return {
      ...base,
      state: "denied",
      alreadyGranted: false,
      detail: deniedRemediation(spec.settingsName),
    };
  }
  progress(`${spec.label}: asking now — answer the dialog if one appears`);
  let res: DeputyOsaResult;
  try {
    res = channel.request(
      { verb: "osascript", script: spec.script, lang: "applescript", timeoutMs },
      timeoutMs + CLIENT_GRACE_MS,
    ) as unknown as DeputyOsaResult;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    progress(`${spec.label}: no answer (${why})`);
    return { ...base, state: "pending", alreadyGranted: false, detail: why };
  }
  if (res.timedOut === true) {
    progress(`${spec.label}: still waiting on the dialog`);
    return {
      ...base,
      state: "pending",
      alreadyGranted: false,
      detail: `no answer within ${Math.round(timeoutMs / 1000)}s — answer the dialog, then rerun`,
    };
  }
  if (res.exitCode === 0) {
    const after = recheck();
    if (after === undefined || after === "granted") {
      progress(`${spec.label}: granted`);
      return { ...base, state: "granted", alreadyGranted: false, detail: "granted" };
    }
    progress(`${spec.label}: the probe ran but macOS reports no grant (${after})`);
    return {
      ...base,
      state: "pending",
      alreadyGranted: false,
      detail: `probe succeeded yet AEDeterminePermission reports "${after}" — rerun, or turn on Things API Helper under System Settings ▸ Privacy & Security ▸ Automation ▸ ${spec.settingsName}`,
    };
  }
  if (res.stderr.includes("-1743")) {
    progress(`${spec.label}: denied`);
    return {
      ...base,
      state: "denied",
      alreadyGranted: false,
      detail: deniedRemediation(spec.settingsName),
    };
  }
  const why = firstLine(res.stderr) || `exit ${res.exitCode}`;
  progress(`${spec.label}: no grant yet (${why})`);
  return { ...base, state: "pending", alreadyGranted: false, detail: why };
}

/**
 * The Accessibility leg. Unlike Automation, the grant is not a dialog answer
 * but a switch in System Settings, so the prompt is fire-and-forget and the
 * ceremony polls the deputy's own trust bit until it flips.
 */
function accessibilityLeg(
  channel: OnboardChannel,
  axTrusted: boolean | undefined,
  deps: Required<Pick<OnboardDeps, "progress" | "openUrl" | "sleep" | "now">> & {
    timeoutMs: number;
    intervalMs: number;
  },
): OnboardStep {
  const base = { leg: "accessibility" as const, label: "accessibility", tier: "gui" as const };
  if (axTrusted === true) {
    deps.progress("accessibility: already granted");
    return { ...base, state: "granted", alreadyGranted: true, detail: "already granted" };
  }
  try {
    const res = channel.request({ verb: "prime-ax" }, 10_000);
    if (res["axTrusted"] === true) {
      deps.progress("accessibility: already granted");
      return { ...base, state: "granted", alreadyGranted: true, detail: "already granted" };
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.progress(`accessibility: could not raise the prompt (${why})`);
    return { ...base, state: "pending", alreadyGranted: false, detail: why };
  }
  deps.progress(
    'accessibility: System Settings ▸ Privacy & Security ▸ Accessibility — turn on "Things API Helper"',
  );
  deps.openUrl(AX_SETTINGS_URL);
  deps.progress("accessibility: waiting for the toggle — Ctrl-C and rerun anytime");
  const deadline = deps.now() + deps.timeoutMs;
  while (deps.now() < deadline) {
    deps.sleep(deps.intervalMs);
    try {
      if (channel.hello().axTrusted === true) {
        deps.progress("accessibility: granted");
        return { ...base, state: "granted", alreadyGranted: false, detail: "granted" };
      }
    } catch {
      // A restart mid-wait (or a momentary hiccup) is not an answer — keep
      // asking until the deadline; the state is whatever the last read said.
    }
  }
  deps.progress("accessibility: not toggled yet");
  return {
    ...base,
    state: "pending",
    alreadyGranted: false,
    detail: `still off after ${Math.round(deps.timeoutMs / 1000)}s — turn on "Things API Helper" under System Settings ▸ Privacy & Security ▸ Accessibility, then rerun`,
  };
}

/** The bundled proxy shortcuts, counted through the deputy's `shortcuts list`. */
function shortcutsLeg(channel: OnboardChannel, progress: (line: string) => void): OnboardStep {
  const base = { leg: "shortcuts" as const, label: "shortcuts", tier: "base" as const };
  let installed: Set<string>;
  try {
    const res = channel.request(
      { verb: "shortcuts", op: "list", timeoutMs: 20_000 },
      20_000 + CLIENT_GRACE_MS,
    ) as unknown as DeputyOsaResult;
    if (res.exitCode !== 0 || res.timedOut === true) {
      const why = firstLine(res.stderr) || `exit ${res.exitCode}`;
      progress(`shortcuts: could not list them (${why})`);
      return { ...base, state: "pending", alreadyGranted: false, detail: why };
    }
    installed = new Set(
      res.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    progress(`shortcuts: could not list them (${why})`);
    return { ...base, state: "pending", alreadyGranted: false, detail: why };
  }
  const missing = EXPECTED_PROXIES.filter((name) => !installed.has(name));
  if (missing.length === 0) {
    progress(`shortcuts: all ${EXPECTED_PROXIES.length} installed`);
    return {
      ...base,
      state: "granted",
      alreadyGranted: true,
      detail: `all ${EXPECTED_PROXIES.length} installed`,
    };
  }
  progress(`shortcuts: ${missing.length} missing — run \`things setup\``);
  return {
    ...base,
    state: "skipped-not-installed",
    alreadyGranted: false,
    detail: `missing ${missing.join(", ")} — run \`things setup\` (it opens the import screen for each)`,
  };
}

/**
 * Where the reader's read grant stands, read WITHOUT opening anything: the
 * ceremony surveys this before it raises its first dialog, so the upfront
 * banner can size the sitting honestly.
 */
type ReaderStanding = "granted" | "needs-panel" | "not-installed";

function readerStanding(
  env: NodeJS.ProcessEnv,
  readerProbe: () => { granted: boolean; locates: boolean } | null,
): ReaderStanding {
  if (!existsSync(readerInstalledAppPath(env))) return "not-installed";
  const probe = readerProbe();
  return probe !== null && probe.granted && probe.locates ? "granted" : "needs-panel";
}

/** The reader's durable read grant — skipped when a database already resolves inside it. */
function readerLeg(
  standing: ReaderStanding,
  deps: Required<Pick<OnboardDeps, "progress" | "grant">>,
): OnboardStep {
  const base = {
    leg: "reader-read-grant" as const,
    label: "reader read grant",
    tier: "base" as const,
  };
  if (standing === "not-installed") {
    deps.progress("reader read grant: the reader is not part of the installed bundle");
    return {
      ...base,
      state: "skipped-not-installed",
      alreadyGranted: false,
      detail:
        "the bundle was built without things-reader (no Apple-issued signing identity) — database reads run direct",
    };
  }
  if (standing === "granted") {
    deps.progress("reader read grant: already granted");
    return { ...base, state: "granted", alreadyGranted: true, detail: "already granted" };
  }
  deps.progress("reader read grant: accept the folder panel the reader is opening");
  const result = deps.grant();
  if (result.granted) {
    deps.progress("reader read grant: granted");
    return { ...base, state: "granted", alreadyGranted: false, detail: "granted" };
  }
  deps.progress(`reader read grant: not granted (${result.detail})`);
  return { ...base, state: "pending", alreadyGranted: false, detail: result.detail };
}

/**
 * The hint the BASE tier closes with (Article V, tiered). A machine that never
 * asked for GUI-driving should still learn that the capability exists and what
 * it buys, exactly once, at the moment it has just finished setting up.
 */
const GUI_TIER_HINT =
  "GUI-driving is not set up — some features drive the app window (repeat-rule edits, area " +
  "reorder); run `things helpers setup --gui` to enable.";

function closingLine(steps: OnboardStep[], mode: HelpersMode, tier: OnboardTier): string {
  const denied = steps.filter((s) => s.state === "denied");
  if (denied.length > 0) {
    return (
      `setup did not finish — ${denied.map((s) => s.label).join(" and ")} ${denied.length === 1 ? "is" : "are"} denied. ` +
      `Turn Things API Helper on under System Settings ▸ Privacy & Security ▸ Automation, or re-arm the dialog with ` +
      `\`tccutil reset AppleEvents ${HELPERS_BUNDLE_ID}\`, then rerun \`things helpers setup\`.`
    );
  }
  const pending = steps.filter((s) => s.state === "pending");
  if (pending.length > 0) {
    return (
      `setup did not finish — ${pending.map((s) => s.label).join(", ")} still needs you. ` +
      `Rerun \`things helpers setup\` to resume exactly there; everything already granted is skipped.`
    );
  }
  const shortcutsMissing = steps.some(
    (s) => s.leg === "shortcuts" && s.state === "skipped-not-installed",
  );
  const guiHint = tier === "base" ? ` ${GUI_TIER_HINT}` : "";
  if (mode === "false") {
    return (
      "everything asked for is granted, but routing is off — `things config set helpers-enabled auto` " +
      `to send reads and writes through the helpers.${guiHint}`
    );
  }
  const base = "you're done — writes and reads route through the helpers with no further prompts.";
  const shortcuts = shortcutsMissing
    ? " The bundled shortcuts are still missing; run `things setup` if you want that path too."
    : "";
  return `${base}${shortcuts}${guiHint}`;
}

/** What each leg puts on screen, for the upfront banner. */
const PROMPT_LABELS: Record<OnboardLeg, string> = {
  "reader-read-grant": "the reader's folder panel",
  "automation-things": "app control for Things",
  "automation-system-events": "app control for System Events",
  accessibility: "the Accessibility switch",
  // The census asks the deputy, never the user.
  shortcuts: "",
};

/**
 * What the human is about to see, in the words macOS will actually use. The
 * wizard prints these one leg ahead of the dialog (Article V, mode-aware); in
 * strict mode they are never printed and the upfront banner's count stands
 * alone.
 */
const PROMPT_EXPLAINERS: Record<OnboardLeg, string[]> = {
  "reader-read-grant": [
    "Next: read access to your Things data.",
    "  A file panel opens, already inside the Things data folder — click Grant Access.",
    "  Nothing else in that panel needs changing; do not navigate elsewhere.",
  ],
  "automation-things": [
    "Next: permission for the helper to control Things.",
    '  A macOS dialog will appear: "Things API Helper" wants access to control "Things" —',
    "  click Allow. Things opens if it was closed; that is expected.",
  ],
  "automation-system-events": [
    "Next: permission for the helper to control System Events (the GUI-driving tier).",
    '  A macOS dialog will appear: "Things API Helper" wants access to control',
    '  "System Events" — click Allow. System Events is the macOS component that reads and',
    "  presses the Things window's own controls.",
  ],
  accessibility: [
    "Next: the Accessibility switch (the GUI-driving tier).",
    "  System Settings opens at Privacy & Security ▸ Accessibility — turn on",
    '  "Things API Helper" in that list. This one is a switch you flip, not a dialog you',
    "  answer, so setup waits and watches for it.",
  ],
  shortcuts: [],
};

/**
 * Which legs are about to put something on screen, surveyed prompt-free from
 * the deputy's handshake and the reader's bookmark state. A leg macOS already
 * records as `denied` raises nothing (the dialog is spent), so it is not
 * counted here even though it will be reported as a failure.
 */
function willRaiseAutomationDialog(state: string | undefined): boolean {
  return state !== "granted" && state !== "denied";
}

function outstandingPrompts(
  hello: DeputyHello,
  reader: ReaderStanding,
  tier: OnboardTier,
): OnboardLeg[] {
  const outstanding: OnboardLeg[] = [];
  if (reader === "needs-panel") outstanding.push("reader-read-grant");
  if (willRaiseAutomationDialog(hello.automation?.things)) outstanding.push("automation-things");
  if (tier === "gui") {
    if (willRaiseAutomationDialog(hello.automation?.systemEvents)) {
      outstanding.push("automation-system-events");
    }
    if (hello.axTrusted !== true) outstanding.push("accessibility");
  }
  return outstanding;
}

/** The interactive tier question, asked only when nothing else decided it. */
const GUI_TIER_QUESTION =
  "Some Things features have no programmatic surface and are driven through the app's own " +
  "window (editing repeat rules, reordering areas). Enable GUI-driving permissions?";

/**
 * The full onboarding ceremony behind `things helpers setup`: fire every
 * consent macOS will ever ask for while a human is sitting there, then report
 * where each one landed. Every leg is IDEMPOTENT — an already-granted leg is
 * detected prompt-free (the deputy's own `hello` carries its TCC standing) and
 * skipped — so a rerun on a fully onboarded machine raises nothing and reports
 * all-green. Interactive by design: run it at the machine.
 *
 * Throws when the helpers are not installed or the deputy does not answer;
 * every other outcome is reported per leg. See docs/design/helpers-onboarding.md.
 *
 * Runs under `withDefaultInterrupts` for its whole synchronous span, so Ctrl-C
 * stops it at a gate AND inside the Accessibility wait (../wizard.ts, "Why a
 * ceremony runs with the DEFAULT signal disposition"). Throws `CeremonyStopped`
 * when the human stops at a gate.
 */
export function onboardHelpers(
  options: OnboardOptions,
  env: NodeJS.ProcessEnv = process.env,
  deps: OnboardDeps = {},
): HelpersOnboardResult {
  return withDefaultInterrupts(() => runOnboardCeremony(options, env, deps));
}

function runOnboardCeremony(
  options: OnboardOptions,
  env: NodeJS.ProcessEnv,
  deps: OnboardDeps,
): HelpersOnboardResult {
  const mode = options.mode;
  const progress =
    deps.progress ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const wizard = deps.wizard ?? createWizard();
  if (deps.channel === undefined && !existsSync(deputyInstalledBinaryPath(env))) {
    throw new Error("the helpers are not installed — run `things helpers setup` first");
  }
  // Which tier, decided BEFORE anything is raised so the banner can size the
  // sitting honestly. The flag wins; `ui-enabled` already on implies the tier
  // without it (a machine that opted into GUI-driving is asking for the grants
  // by definition); otherwise a TTY sitting is asked and a strict run is not.
  const uiEnabled = (deps.uiEnabled ?? (() => loadConfig(env).ui.enabled))();
  let guiRequestedBy: HelpersOnboardResult["guiRequestedBy"] = null;
  if (options.gui === true) {
    guiRequestedBy = "flag";
  } else if (uiEnabled) {
    guiRequestedBy = "config";
    progress("ui.enabled is on — including GUI-driving permissions.");
  } else if (wizard.ask(GUI_TIER_QUESTION, false)) {
    guiRequestedBy = "wizard";
  }
  const tier: OnboardTier = guiRequestedBy === null ? "base" : "gui";
  const channel =
    deps.channel ?? openDeputyChannel(env, deps.deputyWaitMs ?? DEPUTY_SOCKET_WAIT_MS);
  const steps: OnboardStep[] = [];
  let outstanding: OnboardLeg[] = [];
  try {
    let hello: DeputyHello;
    try {
      hello = channel.hello();
    } catch (err) {
      throw new Error(
        `the deputy is installed but did not answer (${err instanceof Error ? err.message : String(err)}) — \`things helpers restart\`, then rerun`,
        { cause: err },
      );
    }
    if (hello.deputyVersion !== EXPECTED_HELPERS_VERSION) {
      progress(
        `note: the installed helpers are v${hello.deputyVersion}, this package expects v${EXPECTED_HELPERS_VERSION} — rebuild with \`bash scripts/build-helpers.sh\` and rerun \`things helpers setup\` for the full ceremony`,
      );
    }
    // Size the sitting BEFORE raising anything, so whoever started this knows
    // whether they have to stay at the screen.
    const reader = readerStanding(env, deps.readerProbe ?? (() => readerProbeDefault(env)));
    outstanding = outstandingPrompts(hello, reader, tier);
    progress(
      outstanding.length === 0
        ? "nothing to raise — every permission the helpers need is already on record"
        : `about to raise ${outstanding.length} macOS consent dialog${outstanding.length === 1 ? "" : "s"} — ` +
            `${outstanding.map((leg) => PROMPT_LABELS[leg]).join(", ")}. Someone must be at the screen.`,
    );
    const willRaise = new Set(outstanding);
    /** Explain a leg's dialog and let the human pace it — wizard mode only. */
    const brief = (leg: OnboardLeg): void => {
      if (willRaise.has(leg)) wizard.explain(PROMPT_EXPLAINERS[leg]);
    };
    brief("reader-read-grant");
    steps.push(
      readerLeg(reader, {
        progress,
        grant: deps.grant ?? (() => grantReader(env)),
      }),
    );
    const automationTimeoutMs = deps.automationTimeoutMs ?? AUTOMATION_PROMPT_TIMEOUT_MS;
    // Fresh AEDeterminePermission read for one target, off a new hello.
    const refreshAutomation = (key: "things" | "systemEvents") => (): string | undefined => {
      try {
        return channel.hello().automation?.[key];
      } catch {
        return undefined;
      }
    };
    brief("automation-things");
    steps.push(
      automationLeg(
        channel,
        {
          leg: "automation-things",
          label: "automation → Things",
          // `count of areas` dispatches a REAL Apple event; `version` and its
          // kin are answered locally and would grant nothing (see automationLeg).
          script: 'tell application "Things3" to count of areas',
          settingsName: "Things3",
        },
        hello.automation?.things,
        refreshAutomation("things"),
        automationTimeoutMs,
        progress,
      ),
    );
    // The GUI tier. Skipped entirely under the base tier — Accessibility and
    // System Events are the two widest grants the pair ever holds, so they are
    // gathered only when GUI-driving was actually asked for (Article V).
    if (tier === "gui") {
      brief("automation-system-events");
      steps.push(
        automationLeg(
          channel,
          {
            leg: "automation-system-events",
            label: "automation → System Events",
            script: 'tell application "System Events" to name of first process',
            settingsName: "System Events",
          },
          hello.automation?.systemEvents,
          refreshAutomation("systemEvents"),
          automationTimeoutMs,
          progress,
        ),
      );
      brief("accessibility");
      steps.push(
        accessibilityLeg(channel, hello.axTrusted, {
          progress,
          openUrl: deps.openUrl ?? openUrlBestEffort,
          sleep: deps.sleep ?? syncSleepMs,
          now: deps.now ?? Date.now,
          timeoutMs: deps.axTimeoutMs ?? AX_WAIT_TIMEOUT_MS,
          intervalMs: deps.axIntervalMs ?? AX_POLL_INTERVAL_MS,
        }),
      );
    }
    steps.push(shortcutsLeg(channel, progress));
  } finally {
    channel.close();
  }
  // A GUI tier that actually landed turns the config key on, so the capability
  // the user just granted is the capability the engine will use. Only on full
  // success: switching the key on over a half-granted tier would produce
  // exactly the "enabled but refuses" state Article IV exists to prevent.
  const guiGranted =
    tier === "gui" && steps.every((s) => s.tier !== "gui" || s.state === "granted");
  let uiEnabledSet = false;
  if (guiGranted && !uiEnabled) {
    (deps.setUiEnabled ?? ((value: boolean) => saveConfigKey("uiEnabled", value, env)))(true);
    uiEnabledSet = true;
    progress("GUI-driving turned on in config (`ui-enabled` is now true).");
  }
  return {
    tier,
    guiRequestedBy,
    uiEnabledSet,
    steps,
    outstanding,
    denied: steps.some((s) => s.state === "denied"),
    pending: steps.some((s) => s.state === "pending"),
    closing: closingLine(steps, mode, tier),
  };
}

function openUrlBestEffort(url: string): void {
  try {
    execFileSync("open", [url], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // The deep link is a convenience; the written path works without it.
  }
}

export interface DeputyHalfStatus {
  plistInstalled: boolean;
  loaded: boolean;
  running: boolean;
  socketPath: string;
  /**
   * The socket file exists but no handshake came back (a dead process that
   * left its socket behind, or one wedged mid-request). Distinct from plain
   * "not running": the remedy is `things helpers restart`, not an install.
   */
  hungSocket: boolean;
  hello: DeputyHello | null;
  signing: DeputySigning | null;
  detail: string;
}

export interface ReaderHalfStatus extends DeputyHalfStatus {
  installed: boolean;
  granted: boolean;
}

export interface HelpersStatus {
  /** The configured routing mode (`helpers-enabled`), not what it resolved to. */
  mode: HelpersMode;
  bundleInstalled: boolean;
  /** The installed bundle's version (Info.plist), null when nothing is installed. */
  installedVersion: string | null;
  deputy: DeputyHalfStatus;
  reader: ReaderHalfStatus;
}

/**
 * Prompt-free status for both halves: launchd load state, a live handshake
 * when each socket answers, and the installed bundle's signing facts. Works
 * with routing disabled — inspect first, enable after.
 */
export function helpersStatus(
  mode: HelpersMode,
  env: NodeJS.ProcessEnv = process.env,
): HelpersStatus {
  const binaryPath = deputyInstalledBinaryPath(env);
  const binaryInstalled = existsSync(binaryPath);
  const socketPath = deputySocketPath(env);
  let hello: DeputyHello | null = null;
  let detail = "";
  const socketPresent = existsSync(socketPath) && existsSync(deputyTokenPath(env));
  if (socketPresent) {
    const token = readFileSync(deputyTokenPath(env), "utf8").trim();
    const bridge = new DeputySyncBridge(socketPath);
    try {
      const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
      if (res["ok"] === true) {
        hello = res as unknown as DeputyHello;
      } else {
        detail = `handshake refused: ${JSON.stringify(res["error"])}`;
      }
    } catch (err) {
      detail = `socket present but not answering: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      bridge.close();
    }
  } else {
    detail = "not running (no socket)";
  }
  return {
    mode,
    bundleInstalled: binaryInstalled,
    installedVersion: installedHelpersVersion(env),
    deputy: {
      plistInstalled: existsSync(deputyPlistPath()),
      loaded: launchctl(["print", launchTarget()]).ok,
      running: hello !== null,
      socketPath,
      hungSocket: socketPresent && hello === null,
      hello,
      signing: binaryInstalled ? deputySigningInfo(binaryPath) : null,
      detail: hello !== null ? "running" : detail,
    },
    reader: readerStatus(env),
  };
}

function readerStatus(env: NodeJS.ProcessEnv): ReaderHalfStatus {
  const appPath = readerInstalledAppPath(env);
  const installed = existsSync(appPath);
  const loaded = launchctl(["print", readerLaunchTarget()]).ok;
  const socketPath = readerSocketPath(env);
  const tokenPath = readerTokenPath(env);
  let running = false;
  let granted = false;
  let hello: DeputyHello | null = null;
  let detail = "not running (no socket)";
  const socketPresent = existsSync(socketPath) && existsSync(tokenPath);
  if (socketPresent) {
    const token = readFileSync(tokenPath, "utf8").trim();
    const bridge = new DeputySyncBridge(socketPath);
    try {
      const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
      if (res["ok"] === true) {
        running = true;
        hello = res as unknown as DeputyHello;
        granted = (res as { granted?: boolean }).granted === true;
        detail = granted ? "running, granted" : "running, NOT granted (things helpers setup)";
      } else {
        detail = `handshake refused: ${JSON.stringify(res["error"])}`;
      }
    } catch (err) {
      detail = `socket present but not answering: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      bridge.close();
    }
  }
  return {
    installed,
    plistInstalled: existsSync(readerPlistPath()),
    loaded,
    running,
    granted,
    socketPath,
    hungSocket: socketPresent && !running,
    hello,
    signing: installed ? deputySigningInfo(readerExecPath(appPath)) : null,
    detail,
  };
}
