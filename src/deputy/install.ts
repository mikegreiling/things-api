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

import type { HelpersMode } from "../config.ts";
import { THINGS_GROUP_CONTAINER } from "../db/locate.ts";
import { DeputySyncBridge } from "./bridge.ts";
import {
  DEPUTY_LAUNCHD_LABEL,
  HELPERS_BUNDLE_ID,
  READER_LAUNCHD_LABEL,
  DEPUTY_PROTOCOL_VERSION,
  type DeputyHello,
  type ReaderHello,
  deputyInstalledBinaryPath,
  deputySocketPath,
  deputyStateDir,
  deputyTokenPath,
  helpersInstallDir,
  helpersInstalledBundlePath,
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
      "the bundle was built without things-reader (no Apple-issued signing identity?) — file reads run direct. Build with an Apple-chain identity, reinstall, then run `things helpers grant`.",
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

export interface HelpersUninstallResult {
  removed: string[];
}

/** Stop both halves and remove LaunchAgents + the installed bundle (state — tokens, logs, the reader's grant — is kept). */
export function uninstallHelpers(env: NodeJS.ProcessEnv = process.env): HelpersUninstallResult {
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
  return { removed };
}

/** Restart the launchd-managed helpers (picks up a rebuilt installed bundle). */
export function restartHelpers(): void {
  const res = launchctl(["kickstart", "-k", launchTarget()]);
  if (!res.ok) {
    throw new Error(
      `launchctl kickstart failed (${res.output.trim() || "unknown"}) — are the helpers installed? Run: things helpers install`,
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
      detail: "things-reader is not installed — run `things helpers install` first",
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
              "the grant landed, but the Things database was not found inside the granted folder — rerun `things helpers grant` and grant the Things data folder",
          };
        }
        detail = "the panel closed but no grant landed (canceled?) — rerun `things helpers grant`";
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
        detail = granted ? "running, granted" : "running, NOT granted (things helpers grant)";
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
