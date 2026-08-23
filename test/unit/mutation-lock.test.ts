/**
 * The advisory mutation lockfile (src/write/lock.ts). Guards the atomic steal
 * of a stale (dead-holder) lock: a normal steal succeeds; a live holder is
 * never stolen; the loser of the steal `rename` falls back to waiting; the
 * post-rename re-read restores a lock that turned out to be live; and two
 * concurrent stealers resolve to a single winner with the other backing off
 * (the TOCTOU race an unconditional unlink+recreate would leave open).
 *
 * Plus the COMPOSITE scope (`withMutationLock`): one lock held across a verb's
 * several mutations, reentrant for its own legs and for a nested composite,
 * while every writer OUTSIDE the hold still meets the ordinary pidfile.
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

import {
  acquireMutationLock,
  type LockDeps,
  MutationLockError,
  withMutationLock,
} from "../../src/write/lock.ts";
import { runComposite } from "../../src/write/pipeline.ts";

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

// COMPOSITE SCOPE: a single verb executed as several mutations holds ONE lock
// end-to-end; its legs' own acquisitions are reentrant no-ops, and the pidfile
// semantics every OTHER writer sees are untouched.
describe("withMutationLock — the composite scope", () => {
  const opts = (pid = ME, alive = new Set([ME])): Parameters<typeof withMutationLock>[2] => ({
    waitMs: 0,
    sleep: noSleep,
    deps: deps(pid, alive),
  });

  it("a leg's acquire inside the hold is a no-op: the file outlives the leg's release", async () => {
    let inside: { held: number; afterLegRelease: boolean } | null = null;

    await withMutationLock(
      lockPath,
      async () => {
        // One leg, as the pipeline runs it: acquire → work → release.
        const leg = await acquireMutationLock(lockPath, opts());
        leg.release();
        // The composite still holds it — the leg neither re-took nor dropped it.
        inside = { held: holderPid(lockPath), afterLegRelease: existsSync(lockPath) };
      },
      opts(),
    );

    expect(inside).toEqual({ held: ME, afterLegRelease: true });
    // The composite's own release is the only one.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("the lockfile is created ONCE and removed ONCE across many legs", async () => {
    const writes: string[] = [];
    const unlinks: string[] = [];
    const spy = deps(ME, new Set([ME]), {
      writeFileSync: (p, data, o) => {
        writes.push(String(p));
        writeFileSync(p as string, data as string, o as never);
      },
      unlinkSync: (p) => {
        unlinks.push(String(p));
        unlinkSync(p as string);
      },
    });

    await withMutationLock(
      lockPath,
      async () => {
        for (let leg = 0; leg < 4; leg++) {
          (await acquireMutationLock(lockPath, { waitMs: 0, sleep: noSleep, deps: spy })).release();
        }
      },
      { waitMs: 0, sleep: noSleep, deps: spy },
    );

    expect(writes.filter((p) => p === lockPath)).toHaveLength(1);
    expect(unlinks.filter((p) => p === lockPath)).toHaveLength(1);
  });

  it("a nested composite runs on the enclosing hold instead of deadlocking on it", async () => {
    let reached = false;
    await withMutationLock(
      lockPath,
      async () => {
        // A composite invoked as another composite's leg (a promote's clone leg).
        // waitMs 0 would refuse instantly if it tried to re-take its own lock.
        await withMutationLock(lockPath, async () => void (reached = true), opts());
        expect(existsSync(lockPath)).toBe(true); // the inner exit did not release it
      },
      opts(),
    );
    expect(reached).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  /**
   * Hold the lock and hand control back to the test, so a rival writer can be
   * launched from OUTSIDE the composite's async context — which is what a second
   * process (or a parallel MCP tool call) actually is. Launching it from inside
   * the body would inherit the hold and prove nothing.
   */
  async function holdOpen(): Promise<{ done: Promise<void>; finish: () => void }> {
    let entered!: () => void;
    let finish!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (finish = r));
    const done = withMutationLock(
      lockPath,
      async () => {
        entered();
        await gate;
      },
      opts(),
    );
    await inside;
    return { done, finish };
  }

  it("EXCLUSION is unchanged: a writer outside the hold is refused, not admitted", async () => {
    const { done, finish } = await holdOpen();

    await expect(
      acquireMutationLock(lockPath, opts(OTHER, new Set([ME, OTHER]))),
    ).rejects.toBeInstanceOf(MutationLockError);
    expect(holderPid(lockPath)).toBe(ME); // untouched by the refused writer

    finish();
    await done;
    expect(existsSync(lockPath)).toBe(false);
  });

  it("two composites racing in ONE process serialize — the second is not let in", async () => {
    const { done, finish } = await holdOpen();
    let bRan = false;

    // B is a genuinely separate composite, so it is excluded exactly as a second
    // process would be — the reentrancy is per-composite, never process-wide.
    await expect(
      withMutationLock(lockPath, async () => void (bRan = true), opts(OTHER, new Set([ME, OTHER]))),
    ).rejects.toBeInstanceOf(MutationLockError);
    expect(bRan).toBe(false);

    finish();
    await done;
  });

  it("runComposite refuses with the pipeline's own blocked/lock shape, running no legs", async () => {
    writeHolder(lockPath, OTHER); // a live foreign writer holds it
    let ranALeg = false;

    const res = await runComposite(
      { lockPath } as unknown as Parameters<typeof runComposite>[0],
      "todo.add-repeating",
      async () => {
        ranALeg = true;
        throw new Error("unreachable");
      },
      opts(ME, new Set([ME, OTHER])),
    );

    expect(res).toMatchObject({ kind: "blocked", reason: "lock", op: "todo.add-repeating" });
    expect(ranALeg).toBe(false); // refused before the first leg — zero mutation
    expect(holderPid(lockPath)).toBe(OTHER);
  });

  it("releases the hold when the composite throws", async () => {
    await expect(
      withMutationLock(
        lockPath,
        async () => {
          throw new Error("leg blew up");
        },
        opts(),
      ),
    ).rejects.toThrow("leg blew up");
    expect(existsSync(lockPath)).toBe(false);
  });
});
