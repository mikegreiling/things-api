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

  return {
    exec: async (line: string): Promise<ShellResult> => {
      const result = await bash.exec(line);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}
