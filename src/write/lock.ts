/**
 * Advisory mutation lockfile: serializes mutations across concurrent CLI
 * invocations so create-probe verification is never ambiguous (design §4).
 * Stale locks (dead pid) are stolen; live locks are awaited with backoff.
 *
 * The steal is atomic: a stealer `rename`s the stale lockfile to a private
 * temp name (rename succeeds for exactly one racer; every other racer gets
 * ENOENT and falls back to the wait/retry loop), then re-reads the renamed
 * file to confirm the holder is still dead before discarding it. This closes
 * the TOCTOU window an unconditional unlink+recreate would leave open, where
 * two processes could both observe a dead holder and both end up believing
 * they hold the lock.
 *
 * SCOPE (2026-08-23): the lock has two scopes, not one. The base case is
 * PER-LEG — one mutation, acquired and released by the pipeline. A COMPOSITE (a
 * single verb the engine executes as several mutations — the promote verbs run
 * clone → trash → promote) instead holds ONE lock across all of its legs via
 * {@link withMutationLock}, and its legs' own acquisitions become reentrant
 * no-ops. Without that, two concurrent composites interleave at leg boundaries
 * — A's clone, B's clone, A's promote — and no single-writer guarantee survives
 * the whole verb.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { currentInstance, instanceAlive, pidAlive } from "../process-instance.ts";

/** Who holds the lock, since when, and doing what — the lockfile's whole payload. */
export interface LockHolder {
  pid: number;
  /** ISO-8601 instant the holder took the lock. */
  ts: string;
  /**
   * The OPERATION the holder is running (`area.reorder`, `todo.move`, …), when
   * the acquisition named one. A waiting writer's refusal reads far better for
   * naming it — "another operation holds the mutation lock: area.reorder" tells
   * the reader both why the wait is long and whether it is their own doing —
   * and it costs one string in a file that already exists. Absent on a lock
   * taken by a path that named nothing.
   */
  op?: string;
  /**
   * The holder's process START TIME (`ps -o lstart=`), which is what makes a
   * stale lock decidable across a PID REUSE: a recycled pid passes `kill(pid,
   * 0)` and would keep a dead writer's lock alive forever. Paired with the pid
   * it is an identity only the original process satisfies (see
   * {@link instanceAlive}). Null/absent when it could not be read — the pid
   * alone then carries the answer, which is weaker but never fabricated.
   */
  start?: string | null;
}

/**
 * How long a LIVE holder may hold the lock before a refusal is allowed to say
 * the process may be hung (issue #640).
 *
 * The number has to sit above every legitimate hold, because the sentence it
 * unlocks invites the reader to kill the holder — and killing a working drive
 * is a worse outcome than a late diagnosis. The longest legitimate hold is a
 * COMPOSITE with a GUI leg: measured at 3.7s on a golden clone (DRVLAT1), and
 * the `--dangerously-drive-gui` copy already warns a field host can take "over
 * a minute on a large database". Five minutes is an order of magnitude past
 * that, so a holder still standing at five minutes is not slow — it is stuck,
 * or it is a pid whose process died in a way `kill(pid, 0)` cannot see.
 */
export const LOCK_HOLDER_SUSPECT_MS = 5 * 60_000;

export class MutationLockError extends Error {
  /**
   * The holder the wait timed out against, when the lockfile could be read.
   * Null when the file was torn or unreadable — the refusal then says only what
   * it can prove.
   */
  readonly holder: LockHolder | null;

  constructor(message: string, holder: LockHolder | null = null) {
    super(message);
    this.name = "MutationLockError";
    this.holder = holder;
  }
}

type LockPayload = LockHolder;

/** What `rescue status` and the `blocked:lock` refusal both report about a holder. */
export interface LockHolderReport {
  /** The lockfile's payload; null when no lock is held or it could not be parsed. */
  holder: LockHolder | null;
  /** Does a process with that pid still exist? False when there is no holder. */
  alive: boolean;
  /** How long the holder has held it, in ms; null when unknown or unparseable. */
  heldForMs: number | null;
  /**
   * A live holder past {@link LOCK_HOLDER_SUSPECT_MS} — old enough that the
   * copy may say it looks hung. A dead holder is never "suspect": it is simply
   * stale, and the next acquisition steals it without anyone being told.
   */
  suspect: boolean;
}

/** No lock on the file — the shape every reader gets when the slot is empty. */
const NO_HOLDER: LockHolderReport = { holder: null, alive: false, heldForMs: null, suspect: false };

/**
 * Is the recorded holder still running? PID PLUS START TIME, never the pid
 * alone: the kernel recycles pids, so a dead writer's number can belong to an
 * unrelated process and `kill(pid, 0)` would report a stale lock as live
 * forever. `instanceAlive` is conservative in the safe direction — an
 * unrecorded or unreadable start time resolves to "alive", so the only holder
 * ever declared dead is one whose pid is gone or whose start time PROVES a
 * different process is wearing the number.
 */
function holderAlive(
  holder: LockHolder,
  deps: Partial<Pick<LockDeps, "pidAlive" | "processStart">>,
): boolean {
  return instanceAlive(
    { pid: holder.pid, start: holder.start ?? null },
    {
      ...(deps.pidAlive !== undefined && { pidAlive: deps.pidAlive }),
      ...(deps.processStart !== undefined && { processStart: deps.processStart }),
    },
  );
}

/**
 * READ the lockfile without touching it — no steal, no wait, no acquisition.
 * This is the accessor `things rescue status` reports from, and it is
 * deliberately incapable of changing anything: a diagnostic that can release
 * another process's lock is a diagnostic nobody can run safely.
 *
 * An absent file, a torn write and an unparseable payload all read as "no
 * holder we can name", never as "no lock" — the caller states what it proved.
 */
export function readLockHolder(
  path: string,
  deps: Partial<Pick<LockDeps, "readFileSync" | "pidAlive" | "processStart">> & {
    now?: () => number;
  } = {},
): LockHolderReport {
  const read = deps.readFileSync ?? readFileSync;
  let raw: string;
  try {
    raw = read(path, "utf8") as string;
  } catch {
    return NO_HOLDER; // no lockfile — nothing is holding it
  }
  let holder: LockHolder;
  try {
    holder = JSON.parse(raw) as LockHolder;
  } catch {
    return NO_HOLDER; // torn write — the next acquisition treats it as stale
  }
  if (typeof holder.pid !== "number" || typeof holder.ts !== "string") return NO_HOLDER;
  const alive = holderAlive(holder, deps);
  const takenAt = Date.parse(holder.ts);
  const heldForMs = Number.isFinite(takenAt)
    ? Math.max(0, (deps.now ?? Date.now)() - takenAt)
    : null;
  return {
    holder,
    alive,
    heldForMs,
    suspect: alive && heldForMs !== null && heldForMs >= LOCK_HOLDER_SUSPECT_MS,
  };
}

/** "4m 12s" / "1h 3m" / "8s" — a held-since age a person reads at a glance. */
export function formatHeldFor(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/**
 * The `blocked:lock` refusal's sentences (issue #640).
 *
 * The old copy was *"another mutation is in progress (pid N since T); waited
 * 30000ms"* + *"wait for the concurrent mutation to finish and retry"*. It is
 * true and it is useless in the one case that actually happens: the holder is a
 * process that died without releasing — a killed client, a harness timeout —
 * and no amount of waiting will ever clear it. The pid and the timestamp were
 * already in the payload; all that was missing was the arithmetic and the
 * consequence.
 *
 * So the refusal now says how LONG it has been held, whether that process is
 * still alive, and — only past {@link LOCK_HOLDER_SUSPECT_MS}, only for a holder
 * that is still alive — that killing it releases the lock. The threshold matters
 * in both directions: below it the sentence would invite the reader to kill a
 * drive that is merely working, and it is deliberately far above any measured
 * legitimate hold.
 *
 * Aliveness is measured HERE, at refusal time, not at throw time — the holder
 * may have died during the wait, and "it is gone, retry" is a different and
 * better answer than "wait for it".
 */
export function describeLockRefusal(
  err: MutationLockError,
  deps: {
    pidAlive?: (pid: number) => boolean;
    processStart?: (pid: number) => string | null;
    now?: () => number;
  } = {},
): { detail: string; remediation: string } {
  const holder = err.holder;
  const base = "wait for the concurrent mutation to finish and retry";
  if (holder === null) return { detail: err.message, remediation: base };

  const alive = holderAlive(holder, deps);
  const takenAt = Date.parse(holder.ts);
  const heldForMs = Number.isFinite(takenAt)
    ? Math.max(0, (deps.now ?? Date.now)() - takenAt)
    : null;
  const age = heldForMs === null ? "" : `, held for ${formatHeldFor(heldForMs)}`;

  if (!alive) {
    return {
      detail: `${err.message}${age} — that process is no longer running, so the lock is stale`,
      remediation: "run the command again; the next attempt takes the lock",
    };
  }
  const suspect = heldForMs !== null && heldForMs >= LOCK_HOLDER_SUSPECT_MS;
  return {
    detail: `${err.message}${age} — pid ${holder.pid} is still running`,
    remediation: suspect
      ? `${base}. It has held the lock for ${formatHeldFor(heldForMs)}, which is far longer ` +
        `than any change takes: that process may be hung, and killing it (\`kill ${holder.pid}\`) ` +
        "releases the lock. `things rescue status` shows what it is waiting on"
      : base,
  };
}

export interface MutationLock {
  release(): void;
}

// ------------------------------------------------------- release on every exit
//
// A lock is released by the `finally` of whoever took it — except when the
// process never reaches that `finally`. The CLI's interrupt guard answers a
// SIGTERM/SIGINT mid-write by writing its honest "outcome uncertain" line and
// calling `process.exit`, which runs NO pending `finally` blocks: the lockfile
// outlived the writer, and the next writer paid a full 30s wait before the
// stale-steal cleared it. (SIGKILL is uncatchable and always ends there; the
// steal is what covers it, which is why holder liveness is an IDENTITY rather
// than a bare pid.)
//
// So every live acquisition registers itself, and an `exit` listener — armed
// lazily on the first acquisition, never at import — drops whatever is still
// held. `process.exit` fires it, a normal return fires it, and the listener is
// otherwise inert. It is a backstop, not the release path: ordinary code still
// releases in its own `finally`, and a released lock is off the registry.

interface HeldLock {
  path: string;
  payload: LockPayload;
  deps: LockDeps;
}

const heldLocks = new Set<HeldLock>();
let exitHookArmed = false;

function registerHeld(entry: HeldLock): void {
  heldLocks.add(entry);
  if (exitHookArmed) return;
  exitHookArmed = true;
  // An `exit` listener never keeps the event loop alive, and it is the only
  // hook that runs under `process.exit` as well as a normal return.
  process.on("exit", () => {
    // Deleting the CURRENT entry mid-iteration is well-defined for a Set, and
    // releaseHeld deletes exactly that one — no copy needed.
    for (const held of heldLocks) releaseHeld(held);
  });
}

/**
 * Drop one held lock, but ONLY if the file still carries our own payload.
 *
 * The check is not defensive tidiness. A release that removes the file
 * unconditionally can take out a lock somebody ELSE has since created — our own
 * hold having been stolen as stale, or a double release racing the next
 * writer's acquisition — and the victim then runs unserialized while believing
 * it is protected. Matching the payload first makes a mistaken release a no-op
 * instead of a silent unlock.
 */
function releaseHeld(entry: HeldLock): void {
  heldLocks.delete(entry);
  const { deps, path } = entry;
  try {
    const raw = deps.readFileSync(path, "utf8") as string;
    const current = JSON.parse(raw) as LockPayload;
    if (current.pid !== entry.payload.pid || current.ts !== entry.payload.ts) return; // not ours
  } catch {
    // Absent or torn: nothing of ours to remove.
    return;
  }
  try {
    deps.unlinkSync(path);
  } catch {
    // already gone — fine
  }
}

/**
 * The composite hold, carried on the ASYNC CONTEXT rather than threaded through
 * every call site. `AsyncLocalStorage` is what makes the reentrancy correctly
 * COMPOSITE-scoped instead of process-scoped: a leg reached from inside a
 * composite inherits the store and recognizes the hold, while a genuinely
 * concurrent composite in the same process (two parallel MCP tool calls) runs in
 * its OWN context, sees no store, and is excluded exactly as a second process
 * would be. A process-wide "we hold it" flag would have let those two interleave
 * silently — the very thing this scoping exists to stop.
 */
const compositeHold = new AsyncLocalStorage<{ path: string }>();

/** True when an enclosing composite already holds `path` on this async context. */
export function mutationLockHeld(path: string): boolean {
  return compositeHold.getStore()?.path === path;
}

/**
 * Run `body` holding ONE mutation lock for its whole duration — the COMPOSITE
 * scope. Every {@link acquireMutationLock} reached from inside (each leg, and
 * any nested composite) is a reentrant no-op, so the composite serializes
 * against other writers as a WHOLE rather than leg by leg.
 *
 * Already inside a hold on the same path (a composite invoked as another
 * composite's leg): `body` runs directly on the enclosing hold — never a second
 * acquisition, which would deadlock against its own holder.
 *
 * Throws {@link MutationLockError} if the lock cannot be taken, exactly as the
 * per-leg acquisition does; the caller shapes that into its own refusal.
 */
export async function withMutationLock<T>(
  path: string,
  body: () => Promise<T>,
  options: AcquireMutationLockOptions = {},
): Promise<T> {
  if (mutationLockHeld(path)) return body();
  const lock = await acquireMutationLock(path, options);
  try {
    return await compositeHold.run({ path }, body);
  } finally {
    lock.release();
  }
}

/**
 * Injectable filesystem + environment seam. Production uses the real node:fs
 * calls; unit tests substitute this to drive the concurrent steal paths
 * deterministically. Not part of the public contract — callers pass only the
 * documented options below.
 * @internal
 */
export interface LockDeps {
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  pidAlive: (pid: number) => boolean;
  /** A pid's start time — the reuse-proof half of holder liveness. */
  processStart?: (pid: number) => string | null;
  /** THIS process's start time, stamped into the lockfile it writes. */
  selfStart?: () => string | null;
  pid: number;
  now: () => string;
  uniqueSuffix: () => string;
  /** Test-only barrier, awaited after a dead holder is observed and before
   * the steal `rename`. Inert (absent) in production. */
  onBeforeSteal?: () => Promise<void> | void;
}

let stealCounter = 0;

function realDeps(): LockDeps {
  return {
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    pidAlive,
    // Memoized in process-instance.ts: our own start time cannot change, so
    // every acquisition after the first costs nothing.
    selfStart: () => currentInstance().start,
    pid: process.pid,
    now: () => new Date().toISOString(),
    uniqueSuffix: () =>
      `${Date.now().toString(36)}-${(stealCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

export interface AcquireMutationLockOptions {
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The operation this acquisition is for, recorded in the lockfile so a
   * waiting writer's refusal can NAME what it is waiting on. Cosmetic to the
   * holder, load-bearing to the reader of the refusal.
   */
  op?: string;
  /** @internal test seam — see {@link LockDeps}. */
  deps?: LockDeps;
}

export async function acquireMutationLock(
  path: string,
  options: AcquireMutationLockOptions = {},
): Promise<MutationLock> {
  // REENTRANT under a composite hold (see withMutationLock): the enclosing
  // composite already owns this lockfile, so a leg neither re-takes it (it would
  // wait out the timeout against its own holder) nor releases it (the remaining
  // legs still need it). The composite's own release is the only one.
  if (mutationLockHeld(path)) return { release() {} };
  const waitMs = options.waitMs ?? 30_000;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deps = options.deps ?? realDeps();
  const deadline = Date.now() + waitMs;
  deps.mkdirSync(dirname(path), { recursive: true });

  for (;;) {
    try {
      const payload: LockPayload = {
        pid: deps.pid,
        ts: deps.now(),
        ...(options.op !== undefined && { op: options.op }),
        ...(deps.selfStart !== undefined && { start: deps.selfStart() }),
      };
      deps.writeFileSync(path, JSON.stringify(payload), { flag: "wx" });
      const entry: HeldLock = { path, payload, deps };
      registerHeld(entry);
      return {
        release() {
          releaseHeld(entry);
        },
      };
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
      let holder: LockPayload | null = null;
      try {
        holder = JSON.parse(deps.readFileSync(path, "utf8") as string) as LockPayload;
      } catch {
        holder = null; // torn write — treat as stale
      }
      if (holder === null || !holderAlive(holder, deps)) {
        await stealStale(path, deps);
        // Whatever the steal outcome, re-loop: an empty slot lets us create a
        // fresh lock via `wx`; a slot re-taken by another process sends us
        // back through the holder check (and, for a live holder, the wait).
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MutationLockError(
          `another operation holds the mutation lock: ${holder.op ?? "a change"} ` +
            `(pid ${holder.pid}), since ${holder.ts}; waited ${waitMs}ms for ${path}`,
          holder,
        );
      }
      // lock-acquisition retries are inherently sequential polling against the same lockfile
      await sleep(150);
    }
  }
}

/**
 * Atomically claim and discard a lockfile whose holder appears dead. Exactly
 * one concurrent stealer wins the `rename`; the rest get ENOENT and return to
 * retry. After winning, the renamed file is re-read: if a live lock had been
 * installed at `path` in the meantime (so the file we just moved is actually
 * live), it is restored to `path` — via `wx`, so a lock re-created by a third
 * process is never clobbered — and we back off instead of stealing it.
 */
async function stealStale(path: string, deps: LockDeps): Promise<void> {
  const temp = `${path}.steal-${deps.pid}-${deps.uniqueSuffix()}`;
  if (deps.onBeforeSteal) await deps.onBeforeSteal();
  try {
    deps.renameSync(path, temp);
  } catch (err) {
    if (errCode(err) === "ENOENT") return; // lost the rename race — retry
    throw err;
  }
  // We won the rename and now own `temp`. Confirm the holder is still dead.
  let stolen: LockPayload | null = null;
  try {
    stolen = JSON.parse(deps.readFileSync(temp, "utf8") as string) as LockPayload;
  } catch {
    stolen = null; // torn write — genuinely stale
  }
  if (stolen !== null && holderAlive(stolen, deps)) {
    // A live lock slipped in between our read and our rename: this file is not
    // stale after all. Put it back for its holder (only if the slot is free)
    // and back off.
    try {
      deps.writeFileSync(path, JSON.stringify(stolen), { flag: "wx" });
    } catch {
      // slot already re-taken — leave the newcomer's lock intact
    }
    tryUnlink(deps, temp);
    return;
  }
  // Confirmed stale — drop it so the next loop turn can create a fresh lock.
  tryUnlink(deps, temp);
}

function tryUnlink(deps: LockDeps, path: string): void {
  try {
    deps.unlinkSync(path);
  } catch {
    // already gone — fine
  }
}
