/**
 * Vector registry. Order is selection priority among equally disruptive,
 * equally validated candidates. Injectable for tests (FakeVector) and for
 * the lab, which runs the identical pipeline against probe vectors.
 */
import { resolve } from "node:path";

import { loadConfig, type ThingsApiConfig } from "../../config.ts";
import { createAppleScriptVector } from "./applescript.ts";
import { createShortcutsVector } from "./shortcuts.ts";
import { createSimulatorVector, dbCarriesBenchMarker, simulatorFenceReason } from "./simulator.ts";
import type { WriteVector } from "./types.ts";
import type { UiDriveAux } from "./ui-drag.ts";
import { createUiVector } from "./ui.ts";
import { createUrlSchemeVector } from "./url-scheme.ts";

/**
 * The default vector set. The ui (Accessibility GUI) vector's per-op support
 * reflects `config.ui.enabled`: unset/false makes it report its GUI-only ops
 * unsupported (with a remediation naming the config key + setup doc), so they
 * are never dispatched. `config` is read from disk when not supplied (the
 * `things capabilities` surface has no client). `uiAux` carries the database
 * seam the sidebar drag driver asserts between hops — the client wires it;
 * surfaces that never execute (capabilities) omit it. `resolvedDbPath` is the
 * database path the client actually opened (from openThings's resolution); it
 * anchors the simulator fence's equality check so the applier and the pipeline's
 * verifier can never split-brain across two different databases.
 */
export function defaultVectors(
  config: ThingsApiConfig = loadConfig(),
  uiAux: UiDriveAux = {},
  resolvedDbPath?: string,
): WriteVector[] {
  // Bench harness (Phase 0): THINGS_SIM_WRITES=1 REQUESTS simulated writes. When
  // it is unset (the ordinary path) the real transports are returned unchanged.
  // When it IS set, the simulator's fence MUST hold — THINGS_DB names a fenced
  // bench fixture (marker present, not the production container) AND equals the
  // database the client opened. If any part is unsatisfied we FAIL CLOSED with a
  // clear error rather than silently falling through to the real transports:
  // in this mode no url-scheme/applescript/shortcuts/ui path may reach a real app.
  if (process.env["THINGS_SIM_WRITES"] === "1") {
    const thingsDb = process.env["THINGS_DB"];
    if (thingsDb === undefined || thingsDb.trim() === "") {
      throw new Error(`${FENCE_UNSATISFIED}THINGS_DB is not set`);
    }
    // dbPath equality: the client-opened DB must be the fenced DB (normalized),
    // else the applier would write one database while the verifier reads another.
    if (resolvedDbPath !== undefined && resolve(resolvedDbPath) !== resolve(thingsDb)) {
      throw new Error(
        `${FENCE_UNSATISFIED}the database the client opened (${resolvedDbPath}) does not equal ` +
          `THINGS_DB (${thingsDb})`,
      );
    }
    const reason = simulatorFenceReason(thingsDb);
    if (reason !== null) {
      throw new Error(`${FENCE_UNSATISFIED}${reason}`);
    }
    return [createSimulatorVector(thingsDb)];
  }
  // Marker fail-closed (2026-07-17 incident): a database carrying the
  // benchFixture marker is a synthetic bench fixture BY CONSTRUCTION, and the
  // only legitimate way to write "against" one is the simulator. Reaching this
  // point with a marked DB means the env fence is absent/incomplete (the exact
  // shape of the escape that fired real url-scheme adds at a live app while
  // verification read the fixture) — refuse rather than return real transports.
  const envDb = process.env["THINGS_DB"];
  const markedPath = [resolvedDbPath, envDb]
    .filter((p): p is string => p !== undefined && p.trim() !== "")
    .find((p) => dbCarriesBenchMarker(p));
  if (markedPath !== undefined) {
    throw new Error(
      `the database in use (${markedPath}) is a bench fixture (Meta.benchFixture marker) but ` +
        "the simulator fence is not active — refusing to dispatch real write transports " +
        "against a live app on behalf of a synthetic fixture. Set the full fence env " +
        "(THINGS_SIM_WRITES=1, THINGS_DB, scratch THINGS_API_STATE_DIR/THINGS_API_CONFIG_DIR) " +
        "or use an unmarked DB.",
    );
  }
  return [
    createUrlSchemeVector(),
    createAppleScriptVector(),
    createShortcutsVector(),
    createUiVector(config, undefined, uiAux),
  ];
}

const FENCE_UNSATISFIED = "simulated writes requested but the fence is unsatisfied: ";
