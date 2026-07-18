/**
 * The CLI sandbox: a just-bash virtual shell whose only escape hatch is the `things`
 * command, routed to `bin/things.js` (real CLI) as a child process under the fenced
 * env. Every other command the agent runs is a just-bash builtin operating on the
 * in-memory VFS — it cannot touch the host filesystem, network, or any real DB.
 *
 * Optional VFS `files` are injected per arm (the skill tree for the skill arm).
 */
import { execFile } from "node:child_process";

import { Bash, defineCommand } from "just-bash";

/** Result of one shell invocation, returned verbatim to the tool layer. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxOptions {
  /** Env fence applied to every `things` child process. */
  fenceEnv: Record<string, string>;
  /** Absolute path to bin/things.js. */
  binPath: string;
  /** Optional VFS files (path → contents), e.g. the mounted skill. */
  files?: Record<string, string>;
  /** Per-command wall timeout for the `things` child (ms). Default 30_000. */
  commandTimeoutMs?: number;
}

export interface Sandbox {
  /** Run one command line through the virtual shell. */
  exec: (line: string) => Promise<ShellResult>;
}

/** Invoke bin/things.js as a child under the fence env; never throws on nonzero exit. */
function runThings(
  binPath: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code === "number") {
          resolve({ stdout, stderr, exitCode: (err as { code: number }).code });
        } else if (err) {
          // Signal kill, spawn failure, timeout: surface as a nonzero exit + message.
          resolve({ stdout, stderr: `${stderr}${err.message}\n`, exitCode: 127 });
        } else {
          resolve({ stdout, stderr, exitCode: 0 });
        }
      },
    );
  });
}

/** Construct a sandbox with the `things` command wired to the fenced CLI binary. */
export function createSandbox(options: SandboxOptions): Sandbox {
  const timeoutMs = options.commandTimeoutMs ?? 30_000;
  const things = defineCommand("things", async (args) => {
    const { stdout, stderr, exitCode } = await runThings(
      options.binPath,
      args,
      options.fenceEnv,
      timeoutMs,
    );
    return { stdout, stderr, exitCode };
  });

  const bashOptions: ConstructorParameters<typeof Bash>[0] = { customCommands: [things] };
  if (options.files !== undefined) bashOptions.files = options.files;
  const bash = new Bash(bashOptions);

  // One sandbox is ONE shell over ONE fixture DB — a real terminal runs command
  // lines strictly one at a time. But an agent may emit several tool calls in a
  // single turn, and the driver dispatches them concurrently; without this gate
  // two `things` children would run at once against the shared DB. For a
  // checklist edit (read the whole list → wholesale rewrite, Things has no
  // item-level surface) that is a lost update: both invocations read the same
  // pre-state, each rewrites from it, and the last writer silently clobbers the
  // other while BOTH report a verified success — the worst failure class, and a
  // bench artifact (a shell never overlaps commands), not a product defect.
  // Serialize every exec through a tail promise so concurrent tool calls queue.
  let tail: Promise<unknown> = Promise.resolve();
  const runSerial = (line: string): Promise<ShellResult> => {
    const result = tail.then(() => bash.exec(line));
    // Keep the chain alive regardless of how this call settles.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then((r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }));
  };

  return { exec: runSerial };
}
