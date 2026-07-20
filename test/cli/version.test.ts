/**
 * The `-dev` version marker (src/cli/version.ts). The pure resolver is tested
 * directly against both module-URL shapes: `bin/things.js` loads `.ts` source
 * in a dev checkout and `.js` in a published install, so the URL suffix is the
 * signal. CLI_VERSION itself is not asserted here — the test runner executes TS
 * source, so it always resolves to the dev value in this process.
 */
import { describe, expect, it } from "vitest";

import { resolveCliVersion } from "../../src/cli/version.ts";

describe("resolveCliVersion", () => {
  it("marks a live TS source checkout with -dev", () => {
    expect(resolveCliVersion("file:///repo/src/cli/main.ts", "0.10.0")).toBe("0.10.0-dev");
  });

  it("leaves a published .js install unmarked", () => {
    expect(resolveCliVersion("file:///pkg/dist/cli/main.js", "0.10.0")).toBe("0.10.0");
  });
});
