/**
 * Vector registry. Order is selection priority among equally disruptive,
 * equally validated candidates. Injectable for tests (FakeVector) and for
 * the lab, which runs the identical pipeline against probe vectors.
 */
import { createAppleScriptVector } from "./applescript.ts";
import type { WriteVector } from "./types.ts";
import { createUrlSchemeVector } from "./url-scheme.ts";

export function defaultVectors(): WriteVector[] {
  return [createUrlSchemeVector(), createAppleScriptVector()];
}
