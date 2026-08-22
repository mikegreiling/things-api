/**
 * things-deputy lifecycle: install/uninstall the launchd LaunchAgent, restart
 * it, and report status. launchd owns the deputy process end-to-end (RunAtLoad
 * + KeepAlive) — there is never a detached or self-daemonized process, and a
 * crashed deputy relaunches with its identity (and therefore its macOS
 * permission grants) intact.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DeputySyncBridge } from "./bridge.ts";
import {
  DEPUTY_LAUNCHD_LABEL,
  READER_LAUNCHD_LABEL,
  DEPUTY_PROTOCOL_VERSION,
  type DeputyHello,
  deputySocketPath,
  deputyStateDir,
  deputyTokenPath,
  readerSocketPath,
  readerTokenPath,
} from "./protocol.ts";

export function deputyPlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${DEPUTY_LAUNCHD_LABEL}.plist`);
}

/** Where `deputy install` places the running copy of the binary. */
export function deputyInstalledBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(deputyStateDir(env), "bin", "things-deputy");
}

/** The build output of scripts/build-deputy.sh in this package checkout. */
export function deputyDefaultBuildPath(): string {
  return fileURLToPath(new URL("../../deputy/build/things-deputy", import.meta.url));
}

export function readerPlistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${READER_LAUNCHD_LABEL}.plist`);
}

/** Where `deputy install` places the reader bundle. */
export function readerInstalledAppPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(deputyStateDir(env), "bin", "things-reader.app");
}

export function readerDefaultBuildPath(): string {
  return fileURLToPath(new URL("../../deputy/build/things-reader.app", import.meta.url));
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
    const output = execFileSync("launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
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

export interface DeputyInstallResult {
  binaryPath: string;
  plistPath: string;
  stateDir: string;
  signing: DeputySigning;
  readerInstalled: boolean;
  warnings: string[];
}

/**
 * Install (or reinstall) the deputy: copy the built binary to its stable
 * path, write the LaunchAgent plist, and (re)bootstrap it under launchd.
 */
export function installDeputy(
  options: { binaryPath?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): DeputyInstallResult {
  const source = options.binaryPath ?? deputyDefaultBuildPath();
  if (!existsSync(source)) {
    throw new Error(
      `deputy binary not found at ${source} — build it first: bash scripts/build-deputy.sh`,
    );
  }
  const target = deputyInstalledBinaryPath(env);
  const stateDir = deputyStateDir(env);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

  // Stop a running deputy before overwriting its binary (ignore "not loaded").
  launchctl(["bootout", launchTarget()]);
  // Unlink FIRST: the kernel caches code-signature state per vnode, so
  // copying over an inode that has ever been executed makes every future exec
  // die with SIGKILL "Taskgated Invalid Signature" — even though the new
  // bytes' signature verifies clean on disk (observed live 2026-08-21, a
  // launchd 10s crash-respawn loop). A fresh inode resets the cache.
  rmSync(target, { force: true });
  copyFileSync(source, target);
  chmodSync(target, 0o755);

  const plistPath = deputyPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderPlist(target, stateDir));

  const boot = launchctl(["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath]);
  const warnings: string[] = [];
  if (!boot.ok) {
    warnings.push(`launchctl bootstrap failed: ${boot.output.trim()}`);
  }
  const signing = deputySigningInfo(target);
  if (signing.state !== "signed") {
    warnings.push(
      `binary is ${signing.state} — macOS permission grants will NOT survive rebuilds. ` +
        `Mint the persistent certificate once (scripts/deputy-cert-setup.sh), rebuild, reinstall.`,
    );
  }

  // The sandboxed reader (SANDBOX1): installed alongside when the build
  // produced it (a real signing chain is mandatory for sandboxed code, so an
  // unsigned host's build skips the bundle — and so do we, with a warning).
  const readerSource = options.binaryPath !== undefined ? null : readerDefaultBuildPath();
  let readerInstalled = false;
  if (readerSource !== null && existsSync(readerSource)) {
    const readerTarget = readerInstalledAppPath(env);
    launchctl(["bootout", readerLaunchTarget()]);
    // Fresh inodes for the whole bundle — the kernel CS cache is per-vnode.
    rmSync(readerTarget, { recursive: true, force: true });
    cpSync(readerSource, readerTarget, { recursive: true });
    const readerPlist = readerPlistPath();
    writeFileSync(readerPlist, renderReaderPlist(readerTarget));
    const readerBoot = launchctl(["bootstrap", `gui/${process.getuid?.() ?? 501}`, readerPlist]);
    if (!readerBoot.ok)
      warnings.push(`reader launchctl bootstrap failed: ${readerBoot.output.trim()}`);
    readerInstalled = true;
  } else if (readerSource !== null) {
    warnings.push(
      "things-reader.app was not built (no signing identity?) — file reads will ride the deputy's per-process consent instead of the durable scoped grant. Build with an Apple-chain identity, reinstall, then run `things deputy grant`.",
    );
  }
  return { binaryPath: target, plistPath, stateDir, signing, readerInstalled, warnings };
}

export interface DeputyUninstallResult {
  removed: string[];
}

/** Stop both halves and remove LaunchAgents + installed binaries (state — tokens, logs, the reader's grant — is kept). */
export function uninstallDeputy(env: NodeJS.ProcessEnv = process.env): DeputyUninstallResult {
  const removed: string[] = [];
  launchctl(["bootout", launchTarget()]);
  launchctl(["bootout", readerLaunchTarget()]);
  for (const path of [deputyPlistPath(), readerPlistPath()]) {
    if (existsSync(path)) {
      rmSync(path);
      removed.push(path);
    }
  }
  const binary = deputyInstalledBinaryPath(env);
  if (existsSync(binary)) {
    rmSync(binary);
    removed.push(binary);
  }
  const readerApp = readerInstalledAppPath(env);
  if (existsSync(readerApp)) {
    rmSync(readerApp, { recursive: true });
    removed.push(readerApp);
  }
  return { removed };
}

/** Restart the launchd-managed helpers (picks up rebuilt installed binaries). */
export function restartDeputy(): void {
  const res = launchctl(["kickstart", "-k", launchTarget()]);
  if (!res.ok) {
    throw new Error(
      `launchctl kickstart failed (${res.output.trim() || "unknown"}) — is the deputy installed? Run: things deputy install`,
    );
  }
  // Reader restart is best-effort: it may legitimately not be installed.
  launchctl(["kickstart", "-k", readerLaunchTarget()]);
}

/**
 * The one-time grant ceremony: open the reader in `--grant` mode (the panel
 * must be presented by the SANDBOXED process — that is what makes the grant
 * durable) and wait for the bookmark to land, confirmed via the reader's
 * handshake. Interactive by design; returns when granted or on timeout.
 */
export function grantReader(env: NodeJS.ProcessEnv = process.env): {
  granted: boolean;
  detail: string;
} {
  const appPath = readerInstalledAppPath(env);
  if (!existsSync(appPath)) {
    return {
      granted: false,
      detail: "things-reader.app is not installed — run `things deputy install` first",
    };
  }
  const startDir = join(homedir(), "Library/Group Containers");
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
  let detail = "the reader is not running — `things deputy status`";
  while (Date.now() < deadline) {
    if (existsSync(socketPath) && existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, "utf8").trim();
      const bridge = new DeputySyncBridge(socketPath);
      try {
        const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
        if (res["ok"] === true && (res as { granted?: boolean }).granted === true) {
          bridge.close();
          return { granted: true, detail: "granted" };
        }
        detail = "the panel closed but no grant landed (canceled?) — rerun `things deputy grant`";
      } catch {
        detail = "the reader socket is not answering — `things deputy status`";
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

export interface ReaderStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  granted: boolean;
  socketPath: string;
  signing: DeputySigning | null;
  detail: string;
}

export interface DeputyStatus {
  enabled: boolean;
  plistInstalled: boolean;
  binaryInstalled: boolean;
  loaded: boolean;
  running: boolean;
  socketPath: string;
  hello: DeputyHello | null;
  signing: DeputySigning | null;
  reader: ReaderStatus;
  detail: string;
}

/**
 * Prompt-free status: launchd load state, a live handshake when the socket
 * answers, and the installed binary's signing facts. Works with routing
 * disabled — inspect first, enable after.
 */
export function deputyStatus(enabled: boolean, env: NodeJS.ProcessEnv = process.env): DeputyStatus {
  const plistInstalled = existsSync(deputyPlistPath());
  const binaryPath = deputyInstalledBinaryPath(env);
  const binaryInstalled = existsSync(binaryPath);
  const loaded = launchctl(["print", launchTarget()]).ok;
  const socketPath = deputySocketPath(env);
  let hello: DeputyHello | null = null;
  let detail = "";
  if (existsSync(socketPath) && existsSync(deputyTokenPath(env))) {
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
    enabled,
    plistInstalled,
    binaryInstalled,
    loaded,
    running: hello !== null,
    socketPath,
    hello,
    signing: binaryInstalled ? deputySigningInfo(binaryPath) : null,
    reader: readerStatus(env),
    detail: hello !== null ? "running" : detail,
  };
}

function readerStatus(env: NodeJS.ProcessEnv): ReaderStatus {
  const appPath = readerInstalledAppPath(env);
  const installed = existsSync(appPath);
  const loaded = launchctl(["print", readerLaunchTarget()]).ok;
  const socketPath = readerSocketPath(env);
  const tokenPath = readerTokenPath(env);
  let running = false;
  let granted = false;
  let detail = "not running (no socket)";
  if (existsSync(socketPath) && existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    const bridge = new DeputySyncBridge(socketPath);
    try {
      const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
      if (res["ok"] === true) {
        running = true;
        granted = (res as { granted?: boolean }).granted === true;
        detail = granted ? "running, granted" : "running, NOT granted (things deputy grant)";
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
    loaded,
    running,
    granted,
    socketPath,
    signing: installed ? deputySigningInfo(readerExecPath(appPath)) : null,
    detail,
  };
}
