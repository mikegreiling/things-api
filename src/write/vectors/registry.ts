/**
 * Vector registry. Order is selection priority among equally disruptive,
 * equally validated candidates. Injectable for tests (FakeVector) and for
 * the lab, which runs the identical pipeline against probe vectors.
 */
import { loadConfig, type ThingsApiConfig } from "../../config.ts";
import { createAppleScriptVector } from "./applescript.ts";
import { createShortcutsVector } from "./shortcuts.ts";
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
 * surfaces that never execute (capabilities) omit it.
 */
export function defaultVectors(
  config: ThingsApiConfig = loadConfig(),
  uiAux: UiDriveAux = {},
): WriteVector[] {
  return [
    createUrlSchemeVector(),
    createAppleScriptVector(),
    createShortcutsVector(),
    createUiVector(config, undefined, uiAux),
  ];
}
