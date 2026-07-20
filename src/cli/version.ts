/**
 * The CLI version string, marked `-dev` when running from a source checkout.
 *
 * `bin/things.js` loads live TS source (`src/cli/main.ts`) in a dev checkout
 * (npm link / `node bin/things.js` in the repo) and the built `dist/cli/main.js`
 * in a published install. So inside these modules `import.meta.url` ends in
 * `.ts` when live source is running and `.js` when the published build is —
 * which is exactly the signal that tells the two apart. Published installs are
 * never affected: the suffix appears only when the running module is TS.
 */
import { PKG_VERSION } from "../index.ts";

/** `${baseVersion}-dev` when running live TS source, else the plain version. */
export function resolveCliVersion(moduleUrl: string, baseVersion: string): string {
  return moduleUrl.endsWith(".ts") ? `${baseVersion}-dev` : baseVersion;
}

/** The version `things --version` and the `--help` footer report. */
export const CLI_VERSION = resolveCliVersion(import.meta.url, PKG_VERSION);
