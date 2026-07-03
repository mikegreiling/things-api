// Host-side process plumbing: tart + password-only SSH to lab guests.
// Mirrors lab/scripts/env.sh (password-only auth: a loaded ssh-agent can
// exhaust the server's auth attempts with key offers before the password
// is tried — "Too many authentication failures").

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export const TART_HOME = process.env["TART_HOME"] ?? "/Volumes/Workspace/tart";
export const SSH_USER = "admin";
const SSH_PASS = "admin";

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "PreferredAuthentications=password",
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "IdentitiesOnly=yes",
];

const ENV = { ...process.env, TART_HOME };

export class ShellError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "ShellError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing output. Throws on non-zero unless allowFailure. */
export function run(argv: string[], opts?: { allowFailure?: boolean }): RunResult {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) throw new Error("empty argv");
  const r = spawnSync(cmd, rest, { encoding: "utf8", env: ENV, maxBuffer: 64 * 1024 * 1024 });
  const result = { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (r.error) throw new ShellError(`${cmd}: ${r.error.message}`, null, "");
  if (r.status !== 0 && opts?.allowFailure !== true) {
    throw new ShellError(
      `${argv.join(" ")} exited ${r.status}: ${result.stderr.trim()}`,
      r.status,
      result.stderr,
    );
  }
  return result;
}

/** Run with output streamed to the console (long-running guest suites). */
export function runStreaming(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) throw new Error("empty argv");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, rest, { stdio: ["ignore", "inherit", "inherit"], env: ENV });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Spawn fully detached (tart run keeps the VM alive until stopped).
 * Output goes to logPath — a silently-dying boot must leave evidence.
 */
export function spawnDetached(argv: string[], logPath: string): void {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) throw new Error("empty argv");
  const fd = openSync(logPath, "a");
  const child = spawn(cmd, rest, { detached: true, stdio: ["ignore", fd, fd], env: ENV });
  child.unref();
  closeSync(fd);
}

function sshArgv(ip: string, command: string): string[] {
  return [
    "sshpass",
    "-p",
    SSH_PASS,
    "ssh",
    ...SSH_OPTS,
    "-o",
    "ConnectTimeout=10",
    `${SSH_USER}@${ip}`,
    command,
  ];
}

/**
 * ssh exits 255 for its own transport/auth errors (remote commands pass their
 * exit codes through). Fresh clones show transient auth flaps in the first
 * seconds after boot (opendirectoryd still warming up) — observed once as
 * "Permission denied (publickey,password,keyboard-interactive)" on the 6th
 * connection while identical calls before and after succeeded. Retry those.
 */
function runWithSshRetry(argv: string[], opts?: { allowFailure?: boolean }): RunResult {
  let last: RunResult = { exitCode: 255, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = run(argv, { allowFailure: true });
    if (last.exitCode !== 255) break;
    if (attempt < 3) spawnSync("sleep", ["2"]);
  }
  if (last.exitCode !== 0 && opts?.allowFailure !== true) {
    throw new ShellError(
      `${argv.join(" ")} exited ${last.exitCode}: ${last.stderr.trim()}`,
      last.exitCode,
      last.stderr,
    );
  }
  return last;
}

export function ssh(ip: string, command: string, opts?: { allowFailure?: boolean }): RunResult {
  return runWithSshRetry(sshArgv(ip, command), opts);
}

export function sshStreaming(ip: string, command: string): Promise<number> {
  return runStreaming(sshArgv(ip, command));
}

/** scp between host and guest; src/dst use scp syntax (guest side prefixed by caller). */
export function scp(args: string[]): void {
  runWithSshRetry(["sshpass", "-p", SSH_PASS, "scp", ...SSH_OPTS, "-q", ...args]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${message}`);
}
