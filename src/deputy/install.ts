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
  DEPUTY_PROTOCOL_VERSION,
  type DeputyHello,
  deputySocketPath,
  deputyStateDir,
  deputyTokenPath,
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
  return { binaryPath: target, plistPath, stateDir, signing, warnings };
}

export interface DeputyUninstallResult {
  removed: string[];
}

/** Stop the deputy and remove its LaunchAgent + installed binary (state dir — token, logs — is kept). */
export function uninstallDeputy(env: NodeJS.ProcessEnv = process.env): DeputyUninstallResult {
  const removed: string[] = [];
  launchctl(["bootout", launchTarget()]);
  const plistPath = deputyPlistPath();
  if (existsSync(plistPath)) {
    rmSync(plistPath);
    removed.push(plistPath);
  }
  const binary = deputyInstalledBinaryPath(env);
  if (existsSync(binary)) {
    rmSync(binary);
    removed.push(binary);
  }
  return { removed };
}

/** Restart the launchd-managed deputy (picks up a rebuilt installed binary). */
export function restartDeputy(): void {
  const res = launchctl(["kickstart", "-k", launchTarget()]);
  if (!res.ok) {
    throw new Error(
      `launchctl kickstart failed (${res.output.trim() || "unknown"}) — is the deputy installed? Run: things deputy install`,
    );
  }
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
    detail: hello !== null ? "running" : detail,
  };
}
