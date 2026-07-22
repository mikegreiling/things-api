/**
 * The passive skill-drift notice (docs/design/skill-distribution.md § ratchet):
 * the minor-behind comparison, the canonical-first location scan, and the
 * gating — kill switch, JSON purity, mcp/install-skill exemption, once-per-
 * process, and silence on absence/error. Plus the publish-time stamp transform.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeSkillDriftNote,
  maybeEmitSkillDriftNote,
  resetSkillDriftCheck,
} from "../../src/cli/skill-check.ts";
import {
  isMinorBehind,
  parseSkillVersion,
  skillLocations,
  stampSkillVersion,
} from "../../src/cli/skill.ts";

let home: string | null = null;
beforeEach(() => resetSkillDriftCheck());
afterEach(() => {
  if (home !== null) rmSync(home, { recursive: true, force: true });
  home = null;
});

/** Write a SKILL.md carrying `version` into location index `idx` under HOME. */
function installStamp(h: string, idx: number, version: string): void {
  const dir = skillLocations(h)[idx]!.dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: things-cli\nversion: ${version}\n---\nbody\n`);
}

function newHome(): string {
  home = mkdtempSync(join(tmpdir(), "things-api-drift-home-"));
  return home;
}

describe("isMinorBehind", () => {
  it("flags minor-or-more behind, ignores patch drift and non-semver", () => {
    expect(isMinorBehind("0.10.0", "0.11.0")).toBe(true); // minor behind
    expect(isMinorBehind("0.10.5", "0.11.0")).toBe(true);
    expect(isMinorBehind("1.0.0", "2.0.0")).toBe(true); // major behind
    expect(isMinorBehind("0.11.0", "0.11.5")).toBe(false); // patch only
    expect(isMinorBehind("0.11.0", "0.11.0")).toBe(false); // equal
    expect(isMinorBehind("0.12.0", "0.11.0")).toBe(false); // ahead
    expect(isMinorBehind("0.0.0", "0.0.0-dev")).toBe(false); // dev build never nags
    expect(isMinorBehind(null, "0.11.0")).toBe(false);
    expect(isMinorBehind("0.10.0", null)).toBe(false);
  });
});

describe("computeSkillDriftNote", () => {
  it("returns the note when the canonical skill is a minor behind", () => {
    const h = newHome();
    installStamp(h, 0, "0.10.0");
    const note = computeSkillDriftNote("0.11.0", h);
    expect(note).toContain("v0.10.0");
    expect(note).toContain("v0.11.0");
    expect(note).toContain("things install-skill");
  });

  it("stays silent when the canonical skill is current (patch or ahead)", () => {
    const h = newHome();
    installStamp(h, 0, "0.11.3");
    expect(computeSkillDriftNote("0.11.0", h)).toBeNull();
  });

  it("stays silent when no skill is installed anywhere", () => {
    const h = newHome();
    expect(computeSkillDriftNote("0.11.0", h)).toBeNull();
  });

  it("falls through to the agent dir when the canonical root is absent", () => {
    const h = newHome();
    installStamp(h, 1, "0.9.0"); // ~/.claude only
    const note = computeSkillDriftNote("0.11.0", h);
    expect(note).toContain("v0.9.0");
  });

  it("canonical decides even when it is current and an agent dir is stale", () => {
    const h = newHome();
    installStamp(h, 0, "0.11.0"); // canonical current
    installStamp(h, 1, "0.9.0"); // agent dir stale — must be ignored
    expect(computeSkillDriftNote("0.11.0", h)).toBeNull();
  });

  it("dev-build bundled version never produces a note", () => {
    const h = newHome();
    installStamp(h, 0, "0.5.0");
    expect(computeSkillDriftNote("0.0.0-dev", h)).toBeNull();
  });
});

/** Run the notice with a fixed bundled version, capturing what it would write. */
function capture(argv: string[], env: NodeJS.ProcessEnv, h: string): string {
  let out = "";
  maybeEmitSkillDriftNote({
    argv,
    env,
    bundledVersion: "0.11.0",
    home: h,
    write: (s) => void (out += s),
  });
  return out;
}

describe("maybeEmitSkillDriftNote gating", () => {
  it("emits one stderr line on a human path with a behind skill", () => {
    const h = newHome();
    installStamp(h, 0, "0.10.0");
    const out = capture(["today"], {}, h);
    expect(out).toContain("installed agent skill v0.10.0 predates bundled v0.11.0");
    expect(out.trimEnd().split("\n")).toHaveLength(1);
  });

  it("JSON purity: never emits when --json is present", () => {
    const h = newHome();
    installStamp(h, 0, "0.10.0");
    expect(capture(["today", "--json"], {}, h)).toBe("");
  });

  it("never emits for the mcp server or install-skill itself", () => {
    const h = newHome();
    installStamp(h, 0, "0.10.0");
    expect(capture(["mcp"], {}, h)).toBe("");
    resetSkillDriftCheck();
    expect(capture(["install-skill"], {}, h)).toBe("");
  });

  it("kill switch silences it", () => {
    const h = newHome();
    installStamp(h, 0, "0.10.0");
    expect(capture(["today"], { THINGS_API_NO_SKILL_CHECK: "1" }, h)).toBe("");
  });

  it("runs at most once per process", () => {
    const h = newHome();
    installStamp(h, 0, "0.10.0");
    expect(capture(["today"], {}, h)).not.toBe(""); // first call emits
    // Second call (no reset) is a no-op even on a fresh human path.
    let out = "";
    maybeEmitSkillDriftNote({
      argv: ["inbox"],
      env: {},
      bundledVersion: "0.11.0",
      home: h,
      write: (s) => void (out += s),
    });
    expect(out).toBe("");
  });

  it("silent when nothing is installed", () => {
    const h = newHome();
    expect(capture(["today"], {}, h)).toBe("");
  });
});

describe("publish-time stamp transform", () => {
  it("rewrites the frontmatter version and round-trips through the parser", () => {
    const src = "---\nname: things-cli\nversion: 0.0.0-dev\n---\n# body\nversion: not-touched\n";
    const stamped = stampSkillVersion(src, "0.11.0");
    expect(parseSkillVersion(stamped)).toBe("0.11.0");
    // Body text past the frontmatter is untouched.
    expect(stamped).toContain("version: not-touched");
    expect(stamped).toContain("# body");
  });

  it("throws on a file with no version slot", () => {
    expect(() => stampSkillVersion("---\nname: x\n---\nbody", "1.0.0")).toThrow();
  });
});
