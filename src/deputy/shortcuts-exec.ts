/**
 * The Apple Shortcuts execution seam — the `shortcuts` CLI twin of osa.ts.
 * Both call sites (the shortcuts write vector's `run`, availability's `list`)
 * route through the deputy when it is active, so every app-automation surface
 * shares the deputy's one stable identity; direct mode is byte-identical to
 * the pre-deputy behavior. The deputy only accepts this library's bundled
 * `things-proxy-*` shortcut names — it is a paired tool, not a general
 * shortcut runner.
 */
import { execFile, execFileSync } from "node:child_process";

import { type DeputyOsaResult } from "./protocol.ts";
import { deputyAsyncRequest, deputyRouting, deputySyncRequest } from "./routing.ts";

/** Deputy-side kill fires at timeoutMs; the client deadline adds grace so the deputy's honest answer wins. */
const CLIENT_GRACE_MS = 5000;

export interface ShortcutsRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** `shortcuts run <name> --input-path … --output-path …` (the write vector's shape). */
export async function shortcutsRunExec(
  name: string,
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<ShortcutsRunResult> {
  if (deputyRouting().active) {
    const res = (await deputyAsyncRequest(
      { verb: "shortcuts", op: "run", name, inputPath, outputPath, timeoutMs },
      timeoutMs + CLIENT_GRACE_MS,
    )) as unknown as DeputyOsaResult;
    return {
      exitCode: res.timedOut === true && res.exitCode === 0 ? 1 : res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      ...(res.timedOut === true && { timedOut: true }),
    };
  }
  return new Promise((resolve) => {
    execFile(
      "shortcuts",
      ["run", name, "--input-path", inputPath, "--output-path", outputPath],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        // A deadline kill (err.killed) is the signature of an unanswered
        // first-run consent dialog — surfaced distinctly for attribution.
        const timedOut = err !== null && (err as { killed?: boolean }).killed === true;
        resolve({
          exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1),
          stdout: String(stdout),
          stderr: String(stderr),
          ...(timedOut && { timedOut: true }),
        });
      },
    );
  });
}

/** `shortcuts list` (availability's proxy census). Returns stdout; throws on failure. */
export function shortcutsListSync(timeoutMs = 10_000): string {
  if (!deputyRouting().active) {
    return execFileSync("shortcuts", ["list"], { encoding: "utf8", timeout: timeoutMs });
  }
  const res = deputySyncRequest(
    { verb: "shortcuts", op: "list", timeoutMs },
    timeoutMs + CLIENT_GRACE_MS,
  ) as unknown as DeputyOsaResult;
  if (res.exitCode === 0 && res.timedOut !== true) return res.stdout;
  throw new Error(`Command failed: shortcuts list\n${res.stderr}`);
}
