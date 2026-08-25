/**
 * Throwaway temp DIRECTORIES for tests — state dirs, config dirs, audit dirs,
 * sandbox roots — swept by the same setup file that sweeps fixture databases
 * (`test/setup/fixture-sweep.ts`).
 *
 * This is the sibling of the fixture-db leak: ~22 call sites did
 * `mkdtempSync(join(tmpdir(), "<prefix>-"))` and never removed the directory, so
 * one suite run abandoned 539 of them. Rather than ask every site to remember an
 * `afterAll`, the maker registers the path and the sweep deletes it — a new call
 * site is clean by default.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest isolates the module graph per test file, so the registry would
 * otherwise be per-file while the WORKER PROCESS outlives it — the exit backstop
 * below has to see every file's paths, hence the process-global home.
 */
const REGISTRY_KEY = Symbol.for("things-api.test.temp-dirs");
const registry: Set<string> = ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] ??=
  new Set<string>()) as Set<string>;

const EXIT_HOOK_KEY = Symbol.for("things-api.test.temp-dir-exit-hook");
if ((globalThis as Record<symbol, unknown>)[EXIT_HOOK_KEY] === undefined) {
  (globalThis as Record<symbol, unknown>)[EXIT_HOOK_KEY] = true;
  // Backstop only: the per-file afterAll sweep does the real work. This catches
  // processes that never reach it — a crashed vitest worker, say.
  process.on("exit", () => sweepTempDirs());
}

/**
 * Make a registered throwaway directory. `prefix` is the bare name — the
 * separator and the random suffix are appended, so `makeTempDir("sim-state")`
 * yields `<tmpdir>/sim-state-XXXXXX`.
 *
 * Lifetime is the whole test FILE (the sweep runs in `afterAll`), which is what
 * the sites that set `THINGS_API_STATE_DIR` once at module scope need.
 */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  registry.add(dir);
  return dir;
}

/** Delete one registered directory and forget it. A path already gone is a no-op. */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  registry.delete(dir);
}

/**
 * Delete every directory made by this process so far. Safe to call repeatedly —
 * `removeTempDir` deletes the entry it is visiting, which Set iteration defines
 * as fine, and a path already gone is a no-op.
 */
export function sweepTempDirs(): void {
  for (const dir of registry) removeTempDir(dir);
}
