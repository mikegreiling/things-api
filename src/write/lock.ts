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

import { pidAlive } from "../process-instance.ts";

export class MutationLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationLockError";
  }
}

interface LockPayload {
  pid: number;
  ts: string;
}

export interface MutationLock {
  release(): void;
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
      const payload: LockPayload = { pid: deps.pid, ts: deps.now() };
      deps.writeFileSync(path, JSON.stringify(payload), { flag: "wx" });
      return {
        release() {
          try {
            deps.unlinkSync(path);
          } catch {
            // already gone — fine
          }
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
      if (holder === null || !deps.pidAlive(holder.pid)) {
        await stealStale(path, deps);
        // Whatever the steal outcome, re-loop: an empty slot lets us create a
        // fresh lock via `wx`; a slot re-taken by another process sends us
        // back through the holder check (and, for a live holder, the wait).
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MutationLockError(
          `another mutation is in progress (pid ${holder.pid} since ${holder.ts}); ` +
            `waited ${waitMs}ms for ${path}`,
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
  if (stolen !== null && deps.pidAlive(stolen.pid)) {
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
