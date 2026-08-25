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

import { sweepFixtureDbs } from "../fixtures/build-db.ts";
import { sweepTempDirs } from "../fixtures/temp-dir.ts";

afterAll(() => {
  sweepFixtureDbs();
  sweepTempDirs();
});
