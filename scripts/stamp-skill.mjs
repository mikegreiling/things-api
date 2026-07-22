#!/usr/bin/env node
/**
 * Publish-time skill stamp. Rewrites `version:` in the bundled SKILL.md
 * frontmatter to the package's version, so the PUBLISHED tarball carries a real
 * stamp while the repo copy stays `0.0.0-dev` (the drift ratchet in
 * docs/design/skill-distribution.md).
 *
 * Wired into `prepublishOnly` (runs on `npm publish` only, after check+build,
 * before pack) and as an explicit release-workflow step — NOT into `build`, so
 * a plain `npm run build` never dirties the working tree. In CI the checkout is
 * ephemeral; a local `npm publish` will leave SKILL.md modified (a visible,
 * intentional publish artifact — restore with `git checkout
 * skills/things-cli/SKILL.md` if you publish by hand).
 *
 * Idempotent: re-stamping an already-stamped file just rewrites the same line.
 * `things install-skill` then copies whatever stamp the bundled SKILL.md carries.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stampSkillVersion } from "../src/cli/skill.ts";

const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const skillPath = fileURLToPath(new URL("../skills/things-cli/SKILL.md", import.meta.url));

try {
  writeFileSync(skillPath, stampSkillVersion(readFileSync(skillPath, "utf8"), version));
  console.log(`stamp-skill: SKILL.md version -> ${version}`);
} catch (err) {
  console.error(`stamp-skill: ${err instanceof Error ? err.message : String(err)} (${skillPath})`);
  process.exit(1);
}
