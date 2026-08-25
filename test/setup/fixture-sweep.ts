/**
 * Suite-wide cleanup for the throwaway fixture databases.
 *
 * `buildFixtureDb` is called from ~90 test files and ~630 sites, most of which
 * never close their handle, let alone delete the file. Rather than ask every
 * site to remember, the builder registers each path and this setup file sweeps
 * the registry — so a new call site is clean by default.
 *
 * `afterAll` (per test FILE, since setup files run once per file) rather than
 * `afterEach`: fixtures built in a `beforeAll` or at module scope stay alive for
 * the whole file. Peak residue is therefore one file's worth of fixtures.
 */
import { afterAll } from "vitest";

import { sweepFixtureDbs } from "../fixtures/build-db.ts";

afterAll(() => {
  sweepFixtureDbs();
});
