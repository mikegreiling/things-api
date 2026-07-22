/**
 * `things install-skill` — fake-HOME integration around the command core with
 * side effects injected, so no test touches the network or a real HOME. Covers
 * the built-in copy fallback, the clean-overwrite re-add semantics (probe-
 * confirmed 2026-07-21), the skills-CLI success path, the simulated bench fence,
 * and --check per-location reporting. Companion unit assertions for the shared
 * version helpers live alongside.
 */
import { afterEach, describe, expect, it } from "vitest";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultCopyInto,
  installSkill,
  type InstallSkillDeps,
} from "../../src/cli/commands/install-skill.ts";
import {
  bundledSkillDir,
  bundledSkillVersion,
  compareSemver,
  installedSkillVersion,
  parseSemver,
  parseSkillVersion,
  skillLocations,
} from "../../src/cli/skill.ts";

let home: string | null = null;
afterEach(() => {
  if (home !== null) rmSync(home, { recursive: true, force: true });
  home = null;
});

function newHome(): string {
  home = mkdtempSync(join(tmpdir(), "things-api-skill-home-"));
  return home;
}

/** Deps that force the built-in copy fallback (skills CLI "unavailable"). */
function fallbackDeps(h: string): InstallSkillDeps {
  return {
    home: h,
    simulated: false,
    runSkillsCli: () => false,
    copyInto: defaultCopyInto,
  };
}

describe("install-skill: built-in copy fallback", () => {
  it("copies the skill into both known roots when the skills CLI is unavailable", () => {
    const h = newHome();
    const { data, exitCode } = installSkill({}, fallbackDeps(h));
    expect(exitCode).toBe(0);
    expect(data.path).toBe("builtin-copy");
    const bundled = bundledSkillVersion();
    for (const loc of skillLocations(h)) {
      const md = join(loc.dir, "SKILL.md");
      expect(existsSync(md), loc.label).toBe(true);
      // References travel too (recursive copy).
      expect(existsSync(join(loc.dir, "references", "contracts.md")), loc.label).toBe(true);
      expect(installedSkillVersion(loc.dir)).toBe(bundled);
    }
    // The report names both destinations as written.
    expect(data.locations.map((r) => r.status)).toEqual(["written", "written"]);
  });

  it("re-add cleanly overwrites: stale content and orphan files are removed", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    // Pre-populate with a stale copy plus an orphan file.
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nversion: 0.0.0-old\n---\nSTALE\n");
    writeFileSync(join(canonical, "ORPHAN.txt"), "leftover");

    installSkill({}, fallbackDeps(h));

    expect(existsSync(join(canonical, "ORPHAN.txt"))).toBe(false);
    const md = readFileSync(join(canonical, "SKILL.md"), "utf8");
    expect(md).not.toContain("STALE");
    expect(installedSkillVersion(canonical)).toBe(bundledSkillVersion());
  });
});

describe("install-skill: skills-CLI success path", () => {
  it("reports the skills-cli path and never falls back", () => {
    const h = newHome();
    let copied = false;
    const { data, exitCode } = installSkill(
      {},
      {
        home: h,
        simulated: false,
        runSkillsCli: () => true,
        copyInto: () => {
          copied = true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(data.path).toBe("skills-cli");
    expect(copied, "must not fall back to a copy when the CLI succeeds").toBe(false);
  });

  it("--project drops the global flag passed to the skills CLI", () => {
    const h = newHome();
    let sawGlobal: boolean | null = null;
    installSkill(
      { project: true },
      {
        home: h,
        simulated: false,
        runSkillsCli: (_dir, global) => {
          sawGlobal = global;
          return true;
        },
        copyInto: () => {},
      },
    );
    expect(sawGlobal).toBe(false);
  });
});

describe("install-skill: bench fence", () => {
  it("simulated run writes nothing", () => {
    const h = newHome();
    let touched = false;
    const { data, exitCode } = installSkill(
      {},
      {
        home: h,
        simulated: true,
        runSkillsCli: () => {
          touched = true;
          return true;
        },
        copyInto: () => {
          touched = true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(data.path).toBe("simulated");
    expect(touched).toBe(false);
    expect(existsSync(skillLocations(h)[0]!.dir)).toBe(false);
  });
});

describe("install-skill: --check reports per location without writing", () => {
  it("absent everywhere → exit 7, nothing written", () => {
    const h = newHome();
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(7);
    expect(data.mode).toBe("check");
    for (const r of data.locations) expect(r.status).toBe("absent");
    // --check must not create anything.
    expect(existsSync(skillLocations(h)[0]!.dir)).toBe(false);
  });

  it("canonical up to date → exit 0", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), `---\nversion: ${bundledSkillVersion()}\n---\n`);
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(0);
    expect(data.locations[0]!.status).toBe("up-to-date");
  });

  it("canonical carries a different (ahead) version → differs, exit 7", () => {
    const h = newHome();
    const canonical = skillLocations(h)[0]!.dir;
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nversion: 99.0.0\n---\n");
    const { data, exitCode } = installSkill({ check: true }, fallbackDeps(h));
    expect(exitCode).toBe(7);
    expect(data.locations[0]!.installedVersion).toBe("99.0.0");
    expect(data.locations[0]!.status).toBe("differs");
  });
});

describe("skill version helpers", () => {
  it("parses the version stamp from frontmatter", () => {
    expect(parseSkillVersion("---\nname: x\nversion: 1.2.3\n---\nbody")).toBe("1.2.3");
    expect(parseSkillVersion('---\nversion: "0.0.0-dev"\n---\n')).toBe("0.0.0-dev");
    expect(parseSkillVersion("no frontmatter")).toBeNull();
    expect(parseSkillVersion("---\nname: x\n---\n")).toBeNull();
  });

  it("the bundled SKILL.md carries a parseable version stamp", () => {
    const v = bundledSkillVersion();
    expect(v).not.toBeNull();
    expect(parseSemver(v)).not.toBeNull();
    expect(existsSync(join(bundledSkillDir(), "SKILL.md"))).toBe(true);
  });

  it("compareSemver orders X.Y.Z (suffix-tolerant), null on non-semver", () => {
    expect(compareSemver("1.0.0", "1.1.0")).toBe(-1); // behind
    expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("0.0.0", "0.0.0-dev")).toBe(0); // suffix ignored
    expect(compareSemver("nope", "1.0.0")).toBeNull();
  });
});
