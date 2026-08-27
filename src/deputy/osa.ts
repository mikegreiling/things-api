/**
 * The single osascript execution seam. Every osascript the library runs —
 * vector dispatch, ui steps, consent probes — flows through one of these two
 * functions, which route to the deputy when it is active and run direct
 * (execFile/execFileSync, byte-identical to the pre-deputy behavior)
 * otherwise. `open`-based primitives (URL scheme, reveal) are consent-free by
 * design and never route.
 *
 * NO SILENT HOST FALLBACK (issue #620, permissions doctrine Article I). The
 * "otherwise" above used to be unconditional, and that is a defect with a
 * measured failure mode: when a machine EXPECTS the deputy (installed under
 * `auto`, or `helpers-enabled true`) and routing is not active — the deputy
 * stopped, its handshake failed, its onboarding could not be proven — the
 * osascript quietly ran under the HOST process's identity instead. The host
 * holds a DIFFERENT set of grants, so a drive could get its Accessibility
 * clicks through and then die on the first keystroke with System Events error
 * 1002 ("osascript is not allowed to send keystrokes"), half-way through a
 * dialog, with the app reporting healthy routing. The read side already
 * forbids exactly this (`helpersExpected` + the reader's no-fallback rule);
 * the automation side now matches: a deputy that is expected but not live
 * makes the call REFUSE, naming the helper's health and its remedy.
 *
 * The one legitimate exception is the CONSENT PROBE inside a setup ceremony,
 * whose entire question is "what does THIS identity hold?" — it passes
 * `hostDirect: "permitted"` explicitly. Machines with no deputy installed
 * (`auto`, nothing there) and machines with the helpers switched off keep the
 * direct path byte-identically, as do the lab escapes, which run in clones
 * where nothing is installed.
 */
import { execFile, execFileSync } from "node:child_process";

import { type DeputyOsaResult } from "./protocol.ts";
import { deputyAsyncRequest, deputyExpected, deputyRouting, deputySyncRequest } from "./routing.ts";

export type OsaLang = "applescript" | "javascript";

export interface OsaExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** True when the seam refused rather than running anything (see REFUSAL). */
  refused?: boolean;
}

/**
 * Whether this call may fall back to running osascript under the HOST process
 * when the deputy is expected but not carrying traffic:
 *
 *   - `"refuse"` (default) — every operational call. A different identity
 *     mid-operation is never an acceptable substitute for the one the machine
 *     was set up to use.
 *   - `"permitted"` — the setup ceremony's consent probes ONLY. Their question
 *     is what the calling identity itself holds, so answering it from the host
 *     is the correct behavior, and refusing would blind the very diagnostic
 *     someone runs when the deputy is down.
 */
export type HostDirectPolicy = "refuse" | "permitted";

/** Deputy-side kill fires at timeoutMs; the client deadline adds grace so the deputy's honest answer wins. */
const CLIENT_GRACE_MS = 5000;

/** The exit code a refusal reports — distinct from any osascript status. */
export const OSA_REFUSED_EXIT_CODE = 126;

/**
 * The refusal copy: what is wrong (the deputy is not live/healthy), what will
 * NOT happen instead (a silent identity switch), and the one command that
 * inspects it.
 */
export function osaRoutingRefusalMessage(reason: string | null): string {
  return (
    "the helpers are set up on this Mac but the deputy is not carrying app automation right now " +
    `(${reason ?? "routing is not active"}) — automation needs a live, healthy deputy, and this ` +
    "command will not silently run it under this terminal's own identity instead (a different " +
    "identity holds different macOS permissions, which is how a half-finished drive happens). " +
    "Check the helper's health with `things helpers status`, restart it with " +
    "`things helpers restart` if it has stopped, then run the same command again."
  );
}

/** The error an osaExecSync refusal throws — shaped so stderr-classifying callers still read the message. */
export class OsaRoutingRefusal extends Error {
  readonly status = OSA_REFUSED_EXIT_CODE;
  readonly stdout = "";
  readonly stderr: string;
  readonly killed = false;
  readonly signal = null;
  readonly refused = true;
  constructor(message: string) {
    super(message);
    this.name = "OsaRoutingRefusal";
    this.stderr = message;
  }
}

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

/**
 * Is the host path allowed for this call? Only when the machine does not expect
 * a deputy at all, or the caller is a ceremony probe that explicitly opted in.
 */
function hostPathAllowed(policy: HostDirectPolicy, env: NodeJS.ProcessEnv): boolean {
  return policy === "permitted" || !deputyExpected(env);
}

/** Async osascript for vector dispatch and ui steps (never blocks the event loop). */
export async function osaExec(
  script: string,
  options: { lang?: OsaLang; timeoutMs: number; hostDirect?: HostDirectPolicy },
  env: NodeJS.ProcessEnv = process.env,
): Promise<OsaExecResult> {
  const lang = options.lang ?? "applescript";
  const routing = deputyRouting(env);
  if (routing.active) {
    const res = await deputyAsyncRequest(
      { verb: "osascript", script, lang, timeoutMs: options.timeoutMs },
      options.timeoutMs + CLIENT_GRACE_MS,
    );
    return fromDeputy(res);
  }
  if (!hostPathAllowed(options.hostDirect ?? "refuse", env)) {
    return {
      exitCode: OSA_REFUSED_EXIT_CODE,
      stdout: "",
      stderr: osaRoutingRefusalMessage(routing.reason),
      refused: true,
    };
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
 *
 * Its two callers are ceremony probes and pass `hostDirect: "permitted"`; any
 * future caller inherits the safe default and refuses instead of switching
 * identity mid-flight.
 */
export function osaExecSync(
  script: string,
  timeoutMs: number,
  options: { hostDirect?: HostDirectPolicy } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const routing = deputyRouting(env);
  if (!routing.active) {
    if (!hostPathAllowed(options.hostDirect ?? "refuse", env)) {
      throw new OsaRoutingRefusal(osaRoutingRefusalMessage(routing.reason));
    }
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
