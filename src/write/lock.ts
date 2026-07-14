/**
 * Advisory mutation lockfile: serializes mutations across concurrent CLI
 * invocations so create-probe verification is never ambiguous (design §4).
 * Stale locks (dead pid) are stolen; live locks are awaited with backoff.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface MutationLock {
  release(): void;
}

export async function acquireMutationLock(
  path: string,
  options: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MutationLock> {
  const waitMs = options.waitMs ?? 30_000;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(path), { recursive: true });

  for (;;) {
    try {
      const payload: LockPayload = { pid: process.pid, ts: new Date().toISOString() };
      writeFileSync(path, JSON.stringify(payload), { flag: "wx" });
      return {
        release() {
          try {
            unlinkSync(path);
          } catch {
            // already gone — fine
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: LockPayload | null = null;
      try {
        holder = JSON.parse(readFileSync(path, "utf8")) as LockPayload;
      } catch {
        holder = null; // torn write — treat as stale
      }
      if (holder === null || !pidAlive(holder.pid)) {
        try {
          unlinkSync(path); // stale: holder is dead
        } catch {
          // raced another steal — loop and retry
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MutationLockError(
          `another mutation is in progress (pid ${holder.pid} since ${holder.ts}); ` +
            `waited ${waitMs}ms for ${path}`,
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- lock-acquisition retries are inherently sequential polling against the same lockfile
      await sleep(150);
    }
  }
}
