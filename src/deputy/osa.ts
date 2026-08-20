/**
 * The single osascript execution seam. Every osascript the library runs —
 * vector dispatch, ui steps, consent probes — flows through one of these two
 * functions, which route to the deputy when it is active and run direct
 * (execFile/execFileSync, byte-identical to the pre-deputy behavior)
 * otherwise. `open`-based primitives (URL scheme, reveal) are consent-free by
 * design and never route.
 */
import { execFile, execFileSync } from "node:child_process";

import { type DeputyOsaResult } from "./protocol.ts";
import { deputyAsyncRequest, deputyRouting, deputySyncRequest } from "./routing.ts";

export type OsaLang = "applescript" | "javascript";

export interface OsaExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Deputy-side kill fires at timeoutMs; the client deadline adds grace so the deputy's honest answer wins. */
const CLIENT_GRACE_MS = 5000;

function osaArgs(script: string, lang: OsaLang): string[] {
  return lang === "javascript" ? ["-l", "JavaScript", "-e", script] : ["-e", script];
}

function fromDeputy(res: Record<string, unknown>): OsaExecResult {
  const r = res as unknown as DeputyOsaResult;
  return {
    exitCode:
      r.timedOut === true || r.signal !== undefined
        ? r.exitCode === 0
          ? 1
          : r.exitCode
        : r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.timedOut === true && { timedOut: true }),
  };
}

/** Async osascript for vector dispatch and ui steps (never blocks the event loop). */
export async function osaExec(
  script: string,
  options: { lang?: OsaLang; timeoutMs: number },
): Promise<OsaExecResult> {
  const lang = options.lang ?? "applescript";
  if (deputyRouting().active) {
    const res = await deputyAsyncRequest(
      { verb: "osascript", script, lang, timeoutMs: options.timeoutMs },
      options.timeoutMs + CLIENT_GRACE_MS,
    );
    return fromDeputy(res);
  }
  return new Promise((resolve) => {
    execFile(
      "osascript",
      osaArgs(script, lang),
      { timeout: options.timeoutMs },
      (err, stdout, stderr) => {
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

/**
 * Sync osascript for the consent probes. Returns stdout on success; throws an
 * execFileSync-SHAPED error otherwise (status/stderr/killed/signal), so the
 * probes' TCC classification regexes (-1743 denied, -1712/kill pending) read
 * identically on both paths. In deputy mode the classification is answered
 * about the DEPUTY's grants — exactly the right question, since it is the
 * deputy that will send every AppleEvent.
 */
export function osaExecSync(script: string, timeoutMs: number): string {
  if (!deputyRouting().active) {
    return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: timeoutMs });
  }
  const res = deputySyncRequest(
    { verb: "osascript", script, lang: "applescript", timeoutMs },
    timeoutMs + CLIENT_GRACE_MS,
  ) as unknown as DeputyOsaResult;
  if (res.exitCode === 0 && res.timedOut !== true && res.signal === undefined) return res.stdout;
  const error = new Error(`Command failed: osascript\n${res.stderr}`) as Error & {
    status: number | null;
    stdout: string;
    stderr: string;
    killed: boolean;
    signal: string | null;
  };
  error.status = res.timedOut === true ? null : res.exitCode;
  error.stdout = res.stdout;
  error.stderr = res.stderr;
  error.killed = res.timedOut === true;
  error.signal = res.timedOut === true || res.signal !== undefined ? "SIGTERM" : null;
  throw error;
}
