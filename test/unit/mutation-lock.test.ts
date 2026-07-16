/**
 * The advisory mutation lockfile (src/write/lock.ts). Guards the atomic steal
 * of a stale (dead-holder) lock: a normal steal succeeds; a live holder is
 * never stolen; the loser of the steal `rename` falls back to waiting; the
 * post-rename re-read restores a lock that turned out to be live; and two
 * concurrent stealers resolve to a single winner with the other backing off
 * (the TOCTOU race an unconditional unlink+recreate would leave open).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireMutationLock, type LockDeps, MutationLockError } from "../../src/write/lock.ts";

const ME = 424242; // this-process pid stand-in (treated as alive)
const OTHER = 525252; // a second live process
const DEAD = 999001; // a holder pid that is not alive

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "things-api-lock-test-"));
  lockPath = join(dir, "mutate.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Real-fs deps with a controllable pid identity + liveness table. */
function deps(pid: number, alive: Set<number>, overrides: Partial<LockDeps> = {}): LockDeps {
  let n = 0;
  return {
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    pidAlive: (p) => alive.has(p),
    pid,
    now: () => "2026-07-16T00:00:00.000Z",
    uniqueSuffix: () => `t${(n++).toString(36)}`,
    ...overrides,
  };
}

function writeHolder(path: string, pid: number): void {
  writeFileSync(path, JSON.stringify({ pid, ts: "2026-07-16T00:00:00.000Z" }), { flag: "w" });
}

function holderPid(path: string): number {
  return (JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid;
}

/** Any leftover `<lock>.steal-*` temp files in the lock directory. */
function stealTemps(): string[] {
  const base = basename(lockPath);
  return readdirSync(dirname(lockPath)).filter((f) => f.startsWith(`${base}.steal-`));
}

const noSleep = () => Promise.resolve();

describe("acquireMutationLock — stale steal", () => {
  it("steals a lock whose holder is dead and installs its own", async () => {
    writeHolder(lockPath, DEAD);

    const lock = await acquireMutationLock(lockPath, {
      waitMs: 1000,
      sleep: noSleep,
      deps: deps(ME, new Set([ME])), // DEAD absent => dead
    });

    expect(holderPid(lockPath)).toBe(ME);
    expect(stealTemps()).toEqual([]);

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("creates the lock outright when no file exists", async () => {
    const lock = await acquireMutationLock(lockPath, {
      waitMs: 1000,
      sleep: noSleep,
      deps: deps(ME, new Set([ME])),
    });
    expect(holderPid(lockPath)).toBe(ME);
    lock.release();
  });

  it("never steals a live holder's lock — waits then errors", async () => {
    writeHolder(lockPath, OTHER);

    await expect(
      acquireMutationLock(lockPath, {
        waitMs: 0, // deadline already passed on first EEXIST
        sleep: noSleep,
        deps: deps(ME, new Set([ME, OTHER])),
      }),
    ).rejects.toBeInstanceOf(MutationLockError);

    // Untouched: the live holder still owns the file, no temp litter.
    expect(holderPid(lockPath)).toBe(OTHER);
    expect(stealTemps()).toEqual([]);
  });

  it("loser of the steal rename falls back to waiting", async () => {
    writeHolder(lockPath, DEAD);

    // Simulate a competing stealer that won the rename first and installed its
    // own live lock: our rename gets ENOENT, and the slot now holds OTHER.
    let firstRename = true;
    const renameLosing: typeof renameSync = (from, to) => {
      if (firstRename) {
        firstRename = false;
        try {
          unlinkSync(from as string);
        } catch {
          // already gone
        }
        writeHolder(lockPath, OTHER); // the winner's fresh live lock
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return renameSync(from, to);
    };

    await expect(
      acquireMutationLock(lockPath, {
        waitMs: 0,
        sleep: noSleep,
        deps: deps(ME, new Set([ME, OTHER]), { renameSync: renameLosing }),
      }),
    ).rejects.toBeInstanceOf(MutationLockError);

    expect(holderPid(lockPath)).toBe(OTHER); // winner's lock intact
    expect(stealTemps()).toEqual([]);
  });

  it("restores a lock that turns out live after the rename (post-rename re-check)", async () => {
    writeHolder(lockPath, DEAD);

    // Between the holder read (DEAD) and the rename, a live lock appears in the
    // slot, so the file we move is actually OTHER's live lock.
    let armed = true;
    const onBeforeSteal = () => {
      if (!armed) return;
      armed = false;
      unlinkSync(lockPath);
      writeHolder(lockPath, OTHER);
    };

    await expect(
      acquireMutationLock(lockPath, {
        waitMs: 0,
        sleep: noSleep,
        deps: deps(ME, new Set([ME, OTHER]), { onBeforeSteal }),
      }),
    ).rejects.toBeInstanceOf(MutationLockError);

    // The live lock was put back, not stolen; no temp litter.
    expect(holderPid(lockPath)).toBe(OTHER);
    expect(stealTemps()).toEqual([]);
  });

  it("two concurrent stealers: exactly one wins, the other backs off", async () => {
    writeHolder(lockPath, DEAD);

    const alive = new Set([ME, OTHER]);
    let p2Result: Promise<{ release(): void }> | null = null;

    // P1 pauses just before its steal rename to let P2 run to completion. P2
    // (no barrier) wins the rename, finds DEAD, and installs its own lock. P1
    // then renames P2's *live* lock, detects it via the re-check, restores it,
    // and backs off — the race resolves to a single holder.
    const onBeforeSteal = async (): Promise<void> => {
      if (p2Result) return;
      p2Result = acquireMutationLock(lockPath, {
        waitMs: 1000,
        sleep: noSleep,
        deps: deps(OTHER, alive),
      });
      await p2Result; // P2 fully acquires before P1 resumes its steal
    };

    const p1 = acquireMutationLock(lockPath, {
      waitMs: 0,
      sleep: noSleep,
      deps: deps(ME, alive, { onBeforeSteal }),
    });

    await expect(p1).rejects.toBeInstanceOf(MutationLockError);

    const p2Lock = await p2Result!;
    expect(holderPid(lockPath)).toBe(OTHER); // P2 is the sole holder
    expect(stealTemps()).toEqual([]);

    p2Lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});
