/**
 * PROCESS INSTANCE IDENTITY — a pid paired with its start time, which is what
 * makes "is that process still alive?" answerable across a pid reuse.
 *
 * A bare pid is not an identity: the kernel recycles pids, so a dead writer's
 * number can belong to an unrelated process minutes later and `kill(pid, 0)`
 * would report the writer as alive. Pairing the pid with `ps -o lstart=` — a
 * value the reusing process cannot reproduce, because it is the moment the
 * kernel started IT — turns the pair into an identity that only the original
 * process satisfies.
 *
 * This is the same instance-key shape `session-grant.ts` uses to decide whether
 * the app instance a grant was minted for is still the one running; both callers
 * share this module so the liveness rule is stated once.
 */
import { execFileSync } from "node:child_process";

/** The process that owns an in-flight piece of work, as an identity (not just a pid). */
export interface ProcessInstance {
  pid: number;
  /**
   * The pid's start time (`ps -o lstart=`), stable for that process's whole
   * life. Null when it could not be read — the pid alone then carries the
   * answer, which is weaker but never fabricated.
   */
  start: string | null;
}

/**
 * Does a process with this pid exist right now? (Signal 0 tests existence only.)
 *
 * Non-positive pids are rejected BEFORE the syscall, and that guard is
 * load-bearing rather than defensive tidiness: in `kill(2)`, pid 0 means "every
 * process in the caller's group" and a negative pid means "the group" — both
 * succeed, so a zero or negative holder would report itself alive forever and
 * wedge its idempotency key. A holder is always a real process or it is nothing.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid's start time, or null when the pid is gone / `ps` could not answer. */
export function processStart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    // A dead pid exits nonzero — the instance is gone, which is an answer.
    return null;
  }
}

/** This process, as the identity to record on a piece of work it is starting. */
export function currentInstance(): ProcessInstance {
  return { pid: process.pid, start: processStart(process.pid) };
}

/** Seams so tests never shell out. */
export interface InstanceLivenessDeps {
  pidAlive?: (pid: number) => boolean;
  processStart?: (pid: number) => string | null;
}

/**
 * Is the RECORDED instance still running?
 *
 * Deliberately CONSERVATIVE: this answers a question whose wrong answer is
 * expensive in one direction only. Reporting a dead writer as alive costs a
 * caller one more poll; reporting a LIVE writer as dead invites a second
 * execution of a mutation that is still in flight. So every ambiguity — a start
 * time that was never recorded, a `ps` that would not answer now — resolves to
 * "alive". Only a pid that is gone, or one whose start time PROVES it is a
 * different process wearing the same number, is reported dead.
 */
export function instanceAlive(instance: ProcessInstance, deps: InstanceLivenessDeps = {}): boolean {
  const alive = deps.pidAlive ?? pidAlive;
  const start = deps.processStart ?? processStart;
  if (!alive(instance.pid)) return false;
  // The pid exists. Without both start times we cannot rule out reuse, so we
  // do not: the conservative answer is that this is still our process.
  if (instance.start === null) return true;
  const current = start(instance.pid);
  if (current === null) return true;
  return current === instance.start;
}
