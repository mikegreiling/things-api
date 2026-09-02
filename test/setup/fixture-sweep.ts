/**
 * Suite-wide cleanup for the throwaway fixture databases and temp directories.
 *
 * `buildFixtureDb` is called from ~90 test files and ~630 sites, most of which
 * never close their handle, let alone delete the file. `makeTempDir` covers the
 * sibling class — the state/config/audit directories. Rather than ask every site
 * to remember, both register what they hand out and this setup file sweeps the
 * registries — so a new call site is clean by default.
 *
 * `afterAll` (per test FILE, since setup files run once per file) rather than
 * `afterEach`: fixtures and directories built in a `beforeAll` or at module scope
 * stay alive for the whole file. Peak residue is therefore one file's worth.
 */
import { afterAll } from "vitest";

import { setInstalledThingsVersion } from "../../src/write/vectors/ui-shape.ts";
import { sweepFixtureDbs } from "../fixtures/build-db.ts";
import { sweepTempDirs } from "../fixtures/temp-dir.ts";

/**
 * PIN the app version the Repeat dialog's shape manifest keys on (RDLAT2).
 *
 * Without this the module would shell out to `defaults read` and report whatever
 * the machine running the suite has installed — so the manifest's fast path
 * would be armed on the maintainer's Mac and disarmed on a CI runner with no
 * Things, and every cell that asserts either behavior would be a coin flip.
 * Cells that exercise the unrecognized-build path pin their own version.
 */
setInstalledThingsVersion("3.23");

afterAll(() => {
  sweepFixtureDbs();
  sweepTempDirs();
});
